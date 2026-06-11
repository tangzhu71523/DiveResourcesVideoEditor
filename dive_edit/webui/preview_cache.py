"""Preview cache - transcode raw videos to browser-native H.264 MP4.

Design:
  - Cache files in ``<job_folder>/_diveedit/preview_cache/<sha16>-<profile>.mp4``.
    The job folder owns all runtime output so cache cleanup is predictable.
  - Serialized priority worker: one ffmpeg at a time, no CPU storm.
  - ``.tmp.mp4`` while writing, atomic rename on success.
  - Fixed 360p profile: built only on demand after sustained preview so import
    and pure pipeline runs do not spend resources on videos the user never opens.
"""
from __future__ import annotations

import ctypes
import hashlib
import subprocess
import threading
import time
from pathlib import Path
from queue import PriorityQueue
from typing import Optional

from ..utils.process_flags import ffmpeg_executable, ffprobe_executable

_CACHE_SUBDIR = "_diveedit/preview_cache"
_CACHE_VERSION = 4

_queue: "PriorityQueue[tuple[int, int, str]]" = PriorityQueue()
_queued: dict[str, int] = {}
_transcoding: set[str] = set()
_progress: dict[str, dict] = {}
_lock = threading.Lock()
_worker_started = False
_worker_lock = threading.Lock()
_nvenc_cached: Optional[bool] = None
_sequence = 0


class _MemoryStatus(ctypes.Structure):
    _fields_ = [
        ("dwLength", ctypes.c_ulong),
        ("dwMemoryLoad", ctypes.c_ulong),
        ("ullTotalPhys", ctypes.c_ulonglong),
        ("ullAvailPhys", ctypes.c_ulonglong),
        ("ullTotalPageFile", ctypes.c_ulonglong),
        ("ullAvailPageFile", ctypes.c_ulonglong),
        ("ullTotalVirtual", ctypes.c_ulonglong),
        ("ullAvailVirtual", ctypes.c_ulonglong),
        ("ullAvailExtendedVirtual", ctypes.c_ulonglong),
    ]


def _normalise_src(src: str) -> str:
    return str(Path(src).resolve())


def _memory_gb() -> tuple[float, float, int]:
    status = _MemoryStatus()
    status.dwLength = ctypes.sizeof(status)
    try:
        ok = ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status))  # type: ignore[attr-defined]
    except Exception:  # noqa: BLE001
        ok = False
    if not ok:
        return 8.0, 8.0, 0
    gb = 1024.0 ** 3
    return status.ullTotalPhys / gb, status.ullAvailPhys / gb, int(status.dwMemoryLoad)


def _has_nvenc() -> bool:
    global _nvenc_cached
    if _nvenc_cached is not None:
        return _nvenc_cached
    try:
        r = subprocess.run(
            [ffmpeg_executable(), "-hide_banner", "-encoders"],
            capture_output=True,
            timeout=5,
            text=True,
        )
        _nvenc_cached = "h264_nvenc" in r.stdout
    except Exception:  # noqa: BLE001
        _nvenc_cached = False
    return _nvenc_cached


def _proxy_profile() -> dict:
    total_gb, available_gb, load_pct = _memory_gb()
    has_nvenc = _has_nvenc()
    name = "fixed-360p"
    height = 360
    video_bitrate = "850k"
    audio_bitrate = "128k"
    preset = "fast" if has_nvenc else "veryfast"
    codec = "h264_nvenc" if has_nvenc else "libx264"
    return {
        "version": _CACHE_VERSION,
        "name": name,
        "height": height,
        "video_bitrate": video_bitrate,
        "audio_bitrate": audio_bitrate,
        "preset": preset,
        "codec": codec,
        "memory_total_gb": round(total_gb, 1),
        "memory_available_gb": round(available_gb, 1),
        "memory_load_pct": load_pct,
        "nvenc": has_nvenc,
        "priority_mode": "idle",
        "threads": 1,
    }


def cache_path(src: str, profile: Optional[dict] = None) -> Path:
    """Resolve the current profile cache file for ``src``."""
    src_path = Path(src).resolve()
    abs_src = str(src_path)
    if profile is None:
        profile = _proxy_profile()
    key_src = f"{_CACHE_VERSION}|{profile['name']}|{profile['height']}|{abs_src}"
    key = hashlib.sha1(key_src.encode("utf-8")).hexdigest()[:16]
    cache_dir = src_path.parent / _CACHE_SUBDIR
    cache_dir.mkdir(exist_ok=True, parents=True)
    return cache_dir / f"{key}-{profile['name']}.mp4"


def cache_status(src: str) -> dict:
    src_key = _normalise_src(src)
    profile = _proxy_profile()
    p = cache_path(src_key, profile)
    with _lock:
        transcoding = src_key in _transcoding
        queued_priority = _queued.get(src_key)
        progress_doc = dict(_progress.get(src_key, {}))
    ready = p.exists() and not transcoding
    progress = float(progress_doc.get("progress", 0.0) or 0.0)
    if ready:
        progress = 1.0
    elif queued_priority is not None and not transcoding:
        progress = 0.0
    progress = max(0.0, min(1.0, progress))
    return {
        "ready": ready,
        "transcoding": transcoding,
        "queued": queued_priority is not None,
        "priority": queued_priority,
        "size_bytes": p.stat().st_size if p.exists() else 0,
        "profile": profile,
        "progress": progress,
        "progress_percent": int(round(progress * 100)),
        "stage": progress_doc.get("stage") or ("ready" if ready else "queued" if queued_priority is not None else "idle"),
        "error": progress_doc.get("error"),
    }


def ensure_cache(src: str, priority: int = 50) -> None:
    """Queue ``src`` for transcoding if not already cached or in flight."""
    global _sequence
    src_key = _normalise_src(src)
    priority = max(0, min(100, int(priority)))
    profile = _proxy_profile()
    p = cache_path(src_key, profile)
    if p.exists():
        return
    with _lock:
        if src_key in _transcoding:
            return
        existing_priority = _queued.get(src_key)
        if existing_priority is not None and existing_priority <= priority:
            return
        _sequence += 1
        _queued[src_key] = priority
        _progress[src_key] = {"progress": 0.0, "stage": "queued", "error": None}
        sequence = _sequence
    _queue.put((priority, sequence, src_key))
    _start_worker()


def _start_worker() -> None:
    global _worker_started
    with _worker_lock:
        if _worker_started:
            return
        _worker_started = True
    threading.Thread(target=_worker_loop, daemon=True, name="preview-cache-worker").start()


def _worker_loop() -> None:
    while True:
        priority, _sequence_id, src = _queue.get()
        with _lock:
            if _queued.get(src) != priority or src in _transcoding:
                continue
            _queued.pop(src, None)
            _transcoding.add(src)
            _progress[src] = {"progress": 0.0, "stage": "transcoding", "error": None}
        try:
            _wait_for_idle_slot(src)
            _transcode(src)
        except Exception:  # noqa: BLE001
            pass
        finally:
            with _lock:
                _transcoding.discard(src)


def _wait_for_idle_slot(src: str) -> None:
    """Avoid starting proxy transcoding while the machine is already memory tight."""
    for _ in range(6):
        _total_gb, available_gb, load_pct = _memory_gb()
        if available_gb >= 1.5 and load_pct < 88:
            _set_progress(src, 0.0, "transcoding", None)
            return
        _set_progress(src, 0.0, "waiting", "waiting for free memory")
        time.sleep(5.0)


def _probe_duration_sec(src: str) -> float:
    try:
        r = subprocess.run(
            [
                ffprobe_executable(),
                "-v", "error",
                "-show_entries", "format=duration",
                "-of", "default=noprint_wrappers=1:nokey=1",
                src,
            ],
            capture_output=True,
            timeout=10,
            text=True,
        )
        if r.returncode != 0:
            return 0.0
        value = float((r.stdout or "").strip())
        return value if value > 0 else 0.0
    except Exception:  # noqa: BLE001
        return 0.0


def _set_progress(src: str, progress: float, stage: str = "transcoding", error: Optional[str] = None) -> None:
    with _lock:
        _progress[src] = {
            "progress": max(0.0, min(1.0, progress)),
            "stage": stage,
            "error": error,
        }


def _ffmpeg_creation_flags() -> int:
    flags = 0
    for name in ("CREATE_NO_WINDOW", "IDLE_PRIORITY_CLASS"):
        flags |= int(getattr(subprocess, name, 0))
    return flags


def _transcode(src: str) -> None:
    profile = _proxy_profile()
    dst = cache_path(src, profile)
    tmp = dst.with_suffix(".tmp.mp4")
    duration = _probe_duration_sec(src)
    if tmp.exists():
        try:
            tmp.unlink()
        except Exception:  # noqa: BLE001
            pass
    candidates: list[tuple[str, str, str, str, int]] = []
    if profile["codec"] == "h264_nvenc":
        candidates.append((
            "h264_nvenc",
            profile["preset"],
            profile["video_bitrate"],
            profile["audio_bitrate"],
            profile["height"],
        ))
    candidates.append(("libx264", "veryfast", profile["video_bitrate"], profile["audio_bitrate"], profile["height"]))
    for vcodec, preset, video_bitrate, audio_bitrate, height in candidates:
        _set_progress(src, 0.0, "transcoding", None)
        bufsize_k = str(int(video_bitrate.rstrip("k")) * 2) + "k"
        cmd = [
            ffmpeg_executable(), "-y",
            "-i", src,
            "-vf", f"scale=-2:{height}",
            "-filter_threads", "1",
            "-filter_complex_threads", "1",
            "-c:v", vcodec,
            "-preset", preset,
            "-b:v", video_bitrate,
            "-maxrate", video_bitrate,
            "-bufsize", bufsize_k,
            "-threads", "1",
            "-c:a", "aac", "-b:a", audio_bitrate,
            "-movflags", "+faststart",
            "-progress", "pipe:1",
            "-nostats",
            str(tmp),
        ]
        try:
            proc = subprocess.Popen(  # noqa: S603
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                text=True,
                bufsize=1,
                creationflags=_ffmpeg_creation_flags(),
            )
            assert proc.stdout is not None
            for line in proc.stdout:
                line = line.strip()
                if not line:
                    continue
                if line.startswith("out_time_ms=") and duration > 0:
                    try:
                        out_time = int(line.split("=", 1)[1]) / 1_000_000.0
                        _set_progress(src, min(0.99, out_time / duration))
                    except ValueError:
                        pass
                elif line == "progress=end":
                    _set_progress(src, 1.0, "finalizing")
            return_code = proc.wait()
        except Exception:  # noqa: BLE001
            _set_progress(src, 0.0, "failed", f"{vcodec} failed to start")
            continue
        if return_code == 0 and tmp.exists() and tmp.stat().st_size > 0:
            tmp.replace(dst)
            _set_progress(src, 1.0, "ready")
            return
        _set_progress(src, 0.0, "failed", f"{vcodec} failed")
    if tmp.exists():
        try:
            tmp.unlink()
        except Exception:  # noqa: BLE001
            pass
