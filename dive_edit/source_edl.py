"""Source-side manual EDL support.

This file is the backend foundation for a future material-library UI:
users can save ranges from source videos, and the pipeline will analyze
only those ranges instead of scanning entire files.
"""
from __future__ import annotations

import json
import hashlib
import queue
import subprocess
import threading
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from .picker import probe_duration_sec
from .utils.process_flags import ffmpeg_executable, hidden_subprocess_kwargs


_nvenc_probe_cache: bool | None = None


@dataclass(frozen=True)
class SourceEDLSegment:
    file: str
    start: float
    end: float
    label: str = "SOURCE"
    enabled: bool = True
    group_id: str = ""

    @property
    def duration(self) -> float:
        return max(0.0, self.end - self.start)


@dataclass(frozen=True)
class SourceClip:
    clip_path: Path
    source_path: Path
    source_start: float
    source_end: float
    label: str = "SOURCE"


def _segment_from_dict(raw: dict[str, Any]) -> SourceEDLSegment | None:
    try:
        file = str(raw.get("file", "")).strip()
        start = float(raw.get("start", 0.0))
        end = float(raw.get("end", 0.0))
    except (TypeError, ValueError):
        return None
    if not file or end <= start:
        return None
    label = str(raw.get("label") or "SOURCE")
    enabled = raw.get("enabled", True)
    group_id = str(raw.get("group_id") or "").strip()
    return SourceEDLSegment(
        file=file,
        start=max(0.0, start),
        end=end,
        label=label,
        enabled=bool(enabled),
        group_id=group_id,
    )


def load_source_edl(path: Path) -> list[SourceEDLSegment]:
    if not path.exists():
        return []
    data = json.loads(path.read_text(encoding="utf-8-sig"))
    if not isinstance(data, dict):
        raise ValueError("source EDL JSON root must be an object")
    segments: list[SourceEDLSegment] = []
    for raw in data.get("segments", []) or []:
        if isinstance(raw, dict):
            seg = _segment_from_dict(raw)
            if seg is not None:
                segments.append(seg)
    return segments


def save_source_edl(path: Path, segments: list[SourceEDLSegment]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {"segments": [asdict(seg) for seg in segments]}
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")


def resolve_source_segments(
    job_folder: Path,
    segments: list[SourceEDLSegment],
    *,
    allowed_names: set[str] | None = None,
) -> list[tuple[Path, SourceEDLSegment]]:
    try:
        job_root = job_folder.resolve()
    except OSError:
        job_root = job_folder
    videos_by_name = {p.name.lower(): p for p in job_folder.iterdir() if p.is_file()}
    resolved: list[tuple[Path, SourceEDLSegment]] = []
    for seg in segments:
        if not seg.enabled:
            continue
        source = Path(seg.file)
        if not source.is_absolute():
            source = videos_by_name.get(seg.file.lower(), job_folder / seg.file)
        try:
            source = source.expanduser().resolve()
        except OSError:
            continue
        if not source.exists() or not source.is_file():
            continue
        try:
            source.relative_to(job_root)
        except ValueError:
            continue
        if allowed_names is not None and source.name not in allowed_names:
            continue
        duration = probe_duration_sec(source)
        if duration <= 0:
            continue
        start = max(0.0, min(seg.start, duration))
        end = max(start, min(seg.end, duration))
        if end <= start:
            continue
        resolved.append((source, SourceEDLSegment(
            file=str(source),
            start=start,
            end=end,
            label=seg.label,
            enabled=seg.enabled,
            group_id=seg.group_id,
        )))
    return resolved


def _log(logger: Any | None, level: str, message: str) -> None:
    if logger is None:
        return
    fn = getattr(logger, level, None)
    if callable(fn):
        fn(message)


def _nvenc_is_functional() -> bool:
    global _nvenc_probe_cache
    if _nvenc_probe_cache is not None:
        return _nvenc_probe_cache
    try:
        proc = subprocess.run(
            [
                ffmpeg_executable(), "-v", "error", "-nostdin",
                "-f", "lavfi", "-i", "color=c=black:s=320x180:d=0.1",
                "-c:v", "h264_nvenc", "-frames:v", "1",
                "-f", "null", "-",
            ],
            capture_output=True,
            text=True,
            timeout=20,
            **hidden_subprocess_kwargs(),
        )
        _nvenc_probe_cache = proc.returncode == 0
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
        _nvenc_probe_cache = False
    return bool(_nvenc_probe_cache)


def _clip_cache_key(src: Path, start: float, end: float) -> str:
    try:
        st = src.stat()
        source_id = f"{src.resolve()}|{st.st_size}|{st.st_mtime_ns}"
    except OSError:
        source_id = str(src)
    raw = f"v3|{source_id}|{start:.3f}|{end:.3f}|mp4"
    return hashlib.sha1(raw.encode("utf-8", errors="replace")).hexdigest()[:20]


def _cache_is_valid(path: Path, duration: float) -> bool:
    if not path.exists() or not path.is_file():
        return False
    try:
        if path.stat().st_size <= 0:
            return False
    except OSError:
        return False
    actual = probe_duration_sec(path)
    return actual > 0 and actual >= max(0.1, duration - 1.0)


def _drain_pipe(pipe: Any, out: "queue.Queue[tuple[str, str]]", kind: str) -> None:
    try:
        for line in iter(pipe.readline, ""):
            out.put((kind, line.rstrip()))
    finally:
        try:
            pipe.close()
        except Exception:
            pass


def _run_ffmpeg_progress(
    cmd: list[str],
    *,
    dst: Path,
    duration: float,
    logger: Any | None,
    label: str,
    timeout_sec: float,
    idle_timeout_sec: float = 120.0,
) -> None:
    q: "queue.Queue[tuple[str, str]]" = queue.Queue()
    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
        **hidden_subprocess_kwargs(),
    )
    assert proc.stdout is not None
    assert proc.stderr is not None
    threading.Thread(target=_drain_pipe, args=(proc.stdout, q, "stdout"), daemon=True).start()
    threading.Thread(target=_drain_pipe, args=(proc.stderr, q, "stderr"), daemon=True).start()

    started = time.monotonic()
    last_output = started
    last_log = 0.0
    last_percent = -1
    stderr_tail: list[str] = []
    duration_ms = max(1.0, duration * 1000.0)

    while True:
        now = time.monotonic()
        if proc.poll() is not None:
            break
        if now - started > timeout_sec:
            proc.kill()
            raise subprocess.TimeoutExpired(cmd, timeout_sec)
        if now - last_output > idle_timeout_sec:
            proc.kill()
            raise TimeoutError(
                f"ffmpeg no progress for {idle_timeout_sec:.0f}s while preparing {dst.name}"
            )
        try:
            kind, line = q.get(timeout=0.5)
        except queue.Empty:
            continue
        if not line:
            continue
        last_output = now
        if kind == "stderr":
            stderr_tail.append(line)
            stderr_tail = stderr_tail[-8:]
            continue
        done_ms: float | None = None
        if line.startswith("out_time_ms=") or line.startswith("out_time_us="):
            try:
                done_ms = float(line.split("=", 1)[1]) / 1000.0
            except ValueError:
                continue
        elif line.startswith("out_time="):
            try:
                hh, mm, ss = line.split("=", 1)[1].split(":")
                done_ms = (float(hh) * 3600.0 + float(mm) * 60.0 + float(ss)) * 1000.0
            except ValueError:
                continue
        if done_ms is not None:
            percent = int(max(0.0, min(100.0, done_ms * 100.0 / duration_ms)))
            if percent >= last_percent + 5 or now - last_log >= 8.0:
                last_percent = max(last_percent, percent)
                last_log = now
                _log(
                    logger,
                    "info",
                    f"  [source windows] {label}: {percent}% "
                    f"({done_ms / 1000.0:.0f}/{duration:.0f}s)",
                )

    # Drain queued tail after process exit.
    while True:
        try:
            kind, line = q.get_nowait()
        except queue.Empty:
            break
        if kind == "stderr" and line:
            stderr_tail.append(line)
            stderr_tail = stderr_tail[-8:]

    if proc.returncode != 0:
        err = "\n".join(stderr_tail)
        raise subprocess.CalledProcessError(proc.returncode or 1, cmd, stderr=err)


def _cut_clip(
    src: Path,
    dst: Path,
    start: float,
    end: float,
    *,
    logger: Any | None = None,
    label: str = "",
) -> None:
    duration = max(0.01, end - start)
    if _cache_is_valid(dst, duration):
        _log(logger, "info", f"  [source windows] cache hit: {label or dst.name}")
        return

    cmd = [
        ffmpeg_executable(), "-y", "-hide_banner", "-loglevel", "error",
        "-nostdin", "-stats_period", "1", "-progress", "pipe:1",
        "-ss", f"{start:.3f}", "-i", str(src),
        "-t", f"{duration:.3f}",
        "-map", "0:v:0?", "-map", "0:a:0?",
        "-c", "copy",
        "-avoid_negative_ts", "make_zero",
        str(dst),
    ]
    try:
        _run_ffmpeg_progress(
            cmd,
            dst=dst,
            duration=duration,
            logger=logger,
            label=f"{label} copy",
            timeout_sec=max(90.0, min(900.0, duration + 90.0)),
            idle_timeout_sec=90.0,
        )
        return
    except (subprocess.CalledProcessError, OSError, TimeoutError, subprocess.TimeoutExpired) as exc:
        _log(
            logger,
            "warn",
            f"  [source windows] fast cut failed for {dst.name}; "
            f"transcoding fallback ({type(exc).__name__})",
        )
        try:
            if dst.exists():
                dst.unlink()
        except OSError:
            pass

    use_nvenc = _nvenc_is_functional()
    video_args = (
        [
            "-c:v", "h264_nvenc",
            "-preset", "p4",
            "-rc", "vbr",
            "-cq", "23",
            "-b:v", "12M",
            "-maxrate", "20M",
        ]
        if use_nvenc
        else ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20"]
    )
    fallback = [
        ffmpeg_executable(), "-y", "-hide_banner", "-loglevel", "error",
        "-nostdin", "-stats_period", "1", "-progress", "pipe:1",
        "-ss", f"{start:.3f}", "-i", str(src),
        "-t", f"{duration:.3f}",
        "-map", "0:v:0?", "-map", "0:a:0?",
        *video_args,
        "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
        "-movflags", "+faststart",
        str(dst),
    ]
    encoder_label = "h264_nvenc" if use_nvenc else "libx264"
    try:
        _run_ffmpeg_progress(
            fallback,
            dst=dst,
            duration=duration,
            logger=logger,
            label=f"{label} {encoder_label}",
            timeout_sec=max(240.0, min(3600.0, duration * (2.0 if use_nvenc else 4.0) + 120.0)),
            idle_timeout_sec=120.0,
        )
    except subprocess.CalledProcessError:
        if not use_nvenc:
            raise
        try:
            if dst.exists():
                dst.unlink()
        except OSError:
            pass
        _log(
            logger,
            "warn",
            f"  [source windows] NVENC fallback failed for {dst.name}; retrying libx264",
        )
        cpu_fallback = [
            ffmpeg_executable(), "-y", "-hide_banner", "-loglevel", "error",
            "-nostdin", "-stats_period", "1", "-progress", "pipe:1",
            "-ss", f"{start:.3f}", "-i", str(src),
            "-t", f"{duration:.3f}",
            "-map", "0:v:0?", "-map", "0:a:0?",
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
            "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
            "-movflags", "+faststart",
            str(dst),
        ]
        _run_ffmpeg_progress(
            cpu_fallback,
            dst=dst,
            duration=duration,
            logger=logger,
            label=f"{label} libx264",
            timeout_sec=max(240.0, min(3600.0, duration * 4.0 + 120.0)),
            idle_timeout_sec=120.0,
        )


def stage_source_clips(
    *,
    job_folder: Path,
    resolved_segments: list[tuple[Path, SourceEDLSegment]],
    logger: Any | None = None,
) -> list[SourceClip]:
    cache_dir = job_folder / "_diveedit" / "source_window_cache"
    cache_dir.mkdir(parents=True, exist_ok=True)

    clips: list[SourceClip] = []
    total = len(resolved_segments)
    _log(logger, "info", f"  [source windows] preparing {total} manual window clip(s)")
    for idx, (source, seg) in enumerate(resolved_segments, 1):
        duration = probe_duration_sec(source)
        if seg.start <= 0.05 and duration > 0 and seg.end >= duration - 0.05:
            _log(
                logger,
                "info",
                f"  [source windows] [{idx}/{total}] using full source {source.name}",
            )
            clips.append(SourceClip(
                clip_path=source,
                source_path=source,
                source_start=0.0,
                source_end=duration,
                label=seg.label,
            ))
            continue
        cache_name = f"{_clip_cache_key(source, seg.start, seg.end)}{source.suffix.lower() or '.mp4'}"
        dst = cache_dir / cache_name
        display_name = f"{idx:03d}{source.suffix.lower() or '.mp4'}"
        clip_label = (
            f"[{idx}/{total}] {source.name} "
            f"{seg.start:.1f}s-{seg.end:.1f}s -> {display_name}"
        )
        _log(logger, "info", f"  [source windows] {clip_label}")
        _cut_clip(source, dst, seg.start, seg.end, logger=logger, label=clip_label)
        clips.append(SourceClip(
            clip_path=dst,
            source_path=source,
            source_start=seg.start,
            source_end=seg.end,
            label=seg.label,
        ))
    return clips


def remap_edl_to_sources(edl: Any, clips: list[SourceClip]) -> None:
    clip_map = {str(c.clip_path): c for c in clips}
    clip_map.update({c.clip_path.name: c for c in clips})
    for seg in getattr(edl, "segments", []):
        clip = clip_map.get(str(seg.file)) or clip_map.get(Path(str(seg.file)).name)
        if clip is None:
            continue
        start = clip.source_start + float(seg.start)
        end = clip.source_start + float(seg.end)
        seg.file = str(clip.source_path)
        seg.start = max(clip.source_start, start)
        seg.end = min(clip.source_end, end)
