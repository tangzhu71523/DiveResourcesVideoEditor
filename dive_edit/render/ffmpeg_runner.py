"""ffmpeg renderer.

Builds a single filter_complex from the EDL plus the cover/overlay filter
strings, writes it to a script file (to avoid Windows command-line limits),
and invokes ffmpeg with NVENC.
"""
from __future__ import annotations
import copy
import re
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from ..analyze.edl import EDL, Segment
from ..utils.process_flags import hidden_subprocess_kwargs
from .ass_builder import build_overlay_ass, escape_subtitles_path
from .cover import cover_filter_from_config
from .overlay import overlay_renderer_from_config, small_text_filter_from_config


_JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000
_child_kill_job_last_error = ""


def _attach_child_kill_job(proc: subprocess.Popen) -> object | None:
    """Kill ffmpeg if this Python process exits unexpectedly on Windows."""
    global _child_kill_job_last_error
    _child_kill_job_last_error = ""
    if sys.platform != "win32":
        return None
    try:
        import ctypes
        from ctypes import wintypes
    except Exception:  # noqa: BLE001
        _child_kill_job_last_error = "ctypes unavailable"
        return None

    class JOBOBJECT_BASIC_LIMIT_INFORMATION(ctypes.Structure):
        _fields_ = [
            ("PerProcessUserTimeLimit", ctypes.c_longlong),
            ("PerJobUserTimeLimit", ctypes.c_longlong),
            ("LimitFlags", wintypes.DWORD),
            ("MinimumWorkingSetSize", ctypes.c_size_t),
            ("MaximumWorkingSetSize", ctypes.c_size_t),
            ("ActiveProcessLimit", wintypes.DWORD),
            ("Affinity", ctypes.c_size_t),
            ("PriorityClass", wintypes.DWORD),
            ("SchedulingClass", wintypes.DWORD),
        ]

    class IO_COUNTERS(ctypes.Structure):
        _fields_ = [
            ("ReadOperationCount", ctypes.c_ulonglong),
            ("WriteOperationCount", ctypes.c_ulonglong),
            ("OtherOperationCount", ctypes.c_ulonglong),
            ("ReadTransferCount", ctypes.c_ulonglong),
            ("WriteTransferCount", ctypes.c_ulonglong),
            ("OtherTransferCount", ctypes.c_ulonglong),
        ]

    class JOBOBJECT_EXTENDED_LIMIT_INFORMATION(ctypes.Structure):
        _fields_ = [
            ("BasicLimitInformation", JOBOBJECT_BASIC_LIMIT_INFORMATION),
            ("IoInfo", IO_COUNTERS),
            ("ProcessMemoryLimit", ctypes.c_size_t),
            ("JobMemoryLimit", ctypes.c_size_t),
            ("PeakProcessMemoryUsed", ctypes.c_size_t),
            ("PeakJobMemoryUsed", ctypes.c_size_t),
        ]

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.CreateJobObjectW.argtypes = [wintypes.LPVOID, wintypes.LPCWSTR]
    kernel32.CreateJobObjectW.restype = wintypes.HANDLE
    kernel32.SetInformationJobObject.argtypes = [
        wintypes.HANDLE,
        ctypes.c_int,
        wintypes.LPVOID,
        wintypes.DWORD,
    ]
    kernel32.SetInformationJobObject.restype = wintypes.BOOL
    kernel32.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
    kernel32.AssignProcessToJobObject.restype = wintypes.BOOL
    kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel32.OpenProcess.restype = wintypes.HANDLE
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel32.CloseHandle.restype = wintypes.BOOL

    job = kernel32.CreateJobObjectW(None, None)
    if not job:
        _child_kill_job_last_error = f"CreateJobObjectW failed err={ctypes.get_last_error()}"
        return None
    info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION()
    info.BasicLimitInformation.LimitFlags = _JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    ok = kernel32.SetInformationJobObject(
        job,
        9,  # JobObjectExtendedLimitInformation
        ctypes.byref(info),
        ctypes.sizeof(info),
    )
    if not ok:
        _child_kill_job_last_error = (
            f"SetInformationJobObject failed err={ctypes.get_last_error()}"
        )
        kernel32.CloseHandle(job)
        return None
    process_handle = kernel32.OpenProcess(0x0001 | 0x0100, False, proc.pid)
    if not process_handle:
        _child_kill_job_last_error = f"OpenProcess failed err={ctypes.get_last_error()}"
        kernel32.CloseHandle(job)
        return None
    try:
        if not kernel32.AssignProcessToJobObject(job, process_handle):
            _child_kill_job_last_error = (
                f"AssignProcessToJobObject failed err={ctypes.get_last_error()}"
            )
            kernel32.CloseHandle(job)
            return None
    finally:
        kernel32.CloseHandle(process_handle)
    return job


@dataclass
class RenderResult:
    output_path: Path
    duration_sec: float
    return_code: int
    log_tail: str
    encoder_used: str = ""


# ── Hardware encoder probing ──────────────────────────────────

_nvenc_probe_cache: bool | None = None


def _nvenc_is_functional() -> bool:
    """Return True if h264_nvenc can actually encode on this machine.

    ffmpeg may list nvenc in its static encoder list even when the GPU
    driver is missing/old, so a listing check is not enough. We do a tiny
    1-frame encode to /dev/null and check the return code.
    """
    global _nvenc_probe_cache
    if _nvenc_probe_cache is not None:
        return _nvenc_probe_cache

    try:
        proc = subprocess.run(
            [
                "ffmpeg", "-v", "error", "-nostdin",
                "-f", "lavfi", "-i", "color=c=black:s=320x180:d=0.1",
                "-c:v", "h264_nvenc", "-frames:v", "1",
                "-f", "null", "-",
            ],
            capture_output=True, text=True, timeout=20,
            **hidden_subprocess_kwargs(),
        )
        ok = proc.returncode == 0
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
        ok = False
    _nvenc_probe_cache = ok
    return ok


def _build_encoder_args(encoder_cfg: dict[str, Any]) -> tuple[list[str], list[str], str]:
    """Return (input_prefix_args, output_codec_args, encoder_label).

    Picks NVENC if available and requested, otherwise falls back to
    libx264. Call sites don't need to know which was chosen.
    """
    requested = str(encoder_cfg.get("vcodec", "auto")).lower()

    want_nvenc = requested in ("auto", "h264_nvenc", "nvenc")
    use_nvenc = want_nvenc and _nvenc_is_functional()

    if use_nvenc:
        # Keep NVENC for encoding, but avoid CUDA decode by default.
        # Field videos can contain damaged HEVC frames / timestamp jumps; GPU
        # decode is less forgiving and may stall inside a large filter graph.
        input_args = []
        if bool(encoder_cfg.get("hardware_decode", False)):
            input_args = ["-hwaccel", str(encoder_cfg.get("hwaccel", "cuda"))]
        output_args = [
            "-c:v", "h264_nvenc",
            "-preset", str(encoder_cfg.get("nvenc_preset", "p5")),
            "-rc", str(encoder_cfg.get("nvenc_rc", "vbr")),
            "-cq", str(encoder_cfg.get("nvenc_cq", 23)),
            "-b:v", str(encoder_cfg.get("bitrate", "12M")),
            "-maxrate", str(encoder_cfg.get("maxrate", "20M")),
            "-pix_fmt", "yuv420p",
        ]
        return input_args, output_args, "h264_nvenc"

    # CPU fallback — libx264 for maximum compatibility
    output_args = [
        "-c:v", "libx264",
        "-preset", str(encoder_cfg.get("x264_preset", "veryfast")),
        "-crf", str(encoder_cfg.get("x264_crf", 23)),
        "-pix_fmt", "yuv420p",
    ]
    return [], output_args, "libx264"


def _build_audio_output_args(encoder_cfg: dict[str, Any], output_path: Path) -> list[str]:
    """Return MP4-safe audio args.

    Field DVR files often carry pcm_mulaw audio. MP4 muxing cannot store that
    codec directly, so render outputs that are MP4-like must transcode audio
    to AAC even if a caller accidentally asks for copy.
    """
    suffix = output_path.suffix.lower()
    acodec = str(encoder_cfg.get("acodec", "aac") or "aac").lower()
    if suffix in {".mp4", ".m4v", ".mov"} and acodec in {"copy", "pcm_mulaw", "mulaw"}:
        acodec = "aac"
    args = ["-c:a", acodec]
    if acodec != "copy":
        args += ["-b:a", str(encoder_cfg.get("abitrate", "192k"))]
    return args


def _parse_logo_right_margin(x_expr: str) -> float:
    m = re.fullmatch(r"\s*W\s*-\s*w\s*-\s*([0-9.]+)\s*", x_expr)
    if not m:
        return 8.0
    return float(m.group(1))


def _parse_logo_top(y_expr: str) -> float:
    try:
        return float(y_expr)
    except (TypeError, ValueError):
        return 8.0


def _logo_overlay_filter_values(
    base_xy: tuple[str, str],
    base_height: int,
    logo_overlay: dict[str, Any],
    *,
    target_w: int,
    target_h: int,
) -> tuple[str, str, int]:
    base_right = _parse_logo_right_margin(base_xy[0])
    base_top = _parse_logo_top(base_xy[1])
    try:
        pos_x = float(logo_overlay.get("position_x", 0.0))
    except (TypeError, ValueError):
        pos_x = 0.0
    try:
        pos_y = float(logo_overlay.get("position_y", 0.0))
    except (TypeError, ValueError):
        pos_y = 0.0
    try:
        scale = float(logo_overlay.get("scale", 1.0))
    except (TypeError, ValueError):
        scale = 1.0
    scale = max(0.05, min(10.0, scale))

    right_px = max(0, round((base_right + pos_x) * target_w / 1920.0))
    top_px = max(0, round((base_top + pos_y) * target_h / 1080.0))
    height_px = max(1, round(float(base_height) * scale * target_h / 1080.0))
    return f"W-w-{right_px}", str(top_px), height_px


_SIXTEEN_NINE = 16 / 9


def _classify_ratio(w: int, h: int) -> float:
    """Round near-16:9 to exact 16/9 so PAL/NTSC-ish display ratios cluster."""
    if w <= 0 or h <= 0:
        return _SIXTEEN_NINE
    r = w / h
    return _SIXTEEN_NINE if 1.76 <= r <= 1.79 else r


def _compute_target_dims(input_paths: list[Path]) -> tuple[int, int]:
    """Pick output width × height per user rule:

      - if ANY source is 16:9 → output 16:9 (1920×1080)
      - else all sources same ratio → output that ratio (1080-height baseline)
      - else mixed non-16:9 → use the widest ratio among them (1080 height)
    """
    from ..picker import probe_dimensions
    ratios: list[float] = []
    for p in input_paths:
        w, h = probe_dimensions(p)
        if w > 0 and h > 0:
            ratios.append(_classify_ratio(w, h))
    if not ratios:
        return (1920, 1080)
    has_16_9 = any(abs(r - _SIXTEEN_NINE) < 1e-6 for r in ratios)
    target_ratio = _SIXTEEN_NINE if has_16_9 else max(ratios)
    height = 1080
    width = int(round(height * target_ratio / 2)) * 2  # keep even (yuv420p)
    return (width, height)


def _copy_edl_with_segments(source: EDL, segments: list[Segment]) -> EDL:
    duration = sum(s.duration for s in segments)
    body_duration = sum(s.duration for s in segments if s.label != "INTRO")
    return EDL(
        segments=segments,
        target_duration_sec=duration,
        actual_body_duration_sec=body_duration,
        raw_body_duration_sec=body_duration,
        adaptive_padding_sec=source.adaptive_padding_sec,
    )


def _iter_segment_chunks(
    segments: list[Segment],
    *,
    max_segments: int,
    max_duration_sec: float,
) -> list[list[Segment]]:
    chunks: list[list[Segment]] = []
    cur: list[Segment] = []
    cur_sec = 0.0
    for seg in segments:
        seg_sec = seg.duration
        should_flush = (
            bool(cur)
            and (
                len(cur) >= max_segments
                or (max_duration_sec > 0 and cur_sec + seg_sec > max_duration_sec)
            )
        )
        if should_flush:
            chunks.append(cur)
            cur = []
            cur_sec = 0.0
        cur.append(seg)
        cur_sec += seg_sec
    if cur:
        chunks.append(cur)
    return chunks


def _concat_chunk_outputs(
    *,
    chunks: list[Path],
    output_path: Path,
    log_path: Path | None,
) -> tuple[int, str]:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        "w", encoding="utf-8", suffix=".concat", delete=False
    ) as fp:
        concat_path = Path(fp.name)
        for chunk in chunks:
            escaped = str(chunk).replace("\\", "/").replace("'", "'\\''")
            fp.write(f"file '{escaped}'\n")
    cmd = [
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
        "-f", "concat", "-safe", "0", "-i", str(concat_path),
        "-c", "copy", "-movflags", "+faststart", str(output_path),
    ]
    try:
        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            **hidden_subprocess_kwargs(),
        )
        stderr = proc.stderr or ""
        if log_path is not None:
            with log_path.open("a", encoding="utf-8") as f:
                f.write("\n--- ffmpeg concat chunks ---\n")
                f.write("cmd=" + " ".join(cmd) + "\n")
                f.write(stderr)
        return proc.returncode, stderr[-4000:]
    finally:
        try:
            concat_path.unlink()
        except OSError:
            pass


def _render_chunked(
    *,
    edl: EDL,
    output_path: Path,
    cover_lines: list[str],
    small_lines: list[str],
    config: dict[str, Any],
    log_path: Path | None,
    job_folder: Path | None,
    cover_overlay: dict[str, Any] | None,
    small_overlay: dict[str, Any] | None,
    logo_overlay: dict[str, Any] | None,
    overlay_enabled: bool,
    status_callback: Callable[[str], None] | None,
) -> RenderResult:
    encoder_cfg = config.get("encoder", {})
    max_segments = max(1, int(encoder_cfg.get("chunk_max_segments", 10)))
    max_duration_sec = max(0.0, float(encoder_cfg.get("chunk_max_duration_sec", 600)))
    chunks = _iter_segment_chunks(
        edl.segments,
        max_segments=max_segments,
        max_duration_sec=max_duration_sec,
    )
    duration_sec = sum(s.duration for s in edl.segments)
    target_w, target_h = _compute_target_dims([Path(s.file) for s in edl.segments])
    if status_callback is not None:
        status_callback(
            f"  Chunk render: {len(chunks)} chunks | "
            f"max {max_segments} windows / {max_duration_sec/60:.1f}m"
        )
    if log_path is not None:
        with log_path.open("a", encoding="utf-8") as f:
            f.write("\n--- chunk render start ---\n")
            f.write(f"chunks={len(chunks)}\n")
            f.write(f"target={target_w}x{target_h}\n")

    output_path.parent.mkdir(parents=True, exist_ok=True)
    chunk_outputs: list[Path] = []
    encoder_used = ""
    with tempfile.TemporaryDirectory(prefix="diveedit_chunks_") as td:
        tmp_dir = Path(td)
        for idx, segs in enumerate(chunks, start=1):
            chunk_edl = _copy_edl_with_segments(edl, segs)
            chunk_output = tmp_dir / f"chunk_{idx:04d}.mp4"
            chunk_config = copy.deepcopy(config)
            chunk_encoder = chunk_config.setdefault("encoder", {})
            chunk_encoder["chunk_render"] = False
            chunk_encoder["target_width"] = target_w
            chunk_encoder["target_height"] = target_h
            if status_callback is not None:
                status_callback(
                    f"  Rendering chunk {idx}/{len(chunks)} "
                    f"({len(segs)} windows, {sum(s.duration for s in segs)/60:.1f}m)"
                )
            result = render(
                edl=chunk_edl,
                output_path=chunk_output,
                cover_lines=cover_lines,
                small_lines=small_lines,
                config=chunk_config,
                log_path=log_path,
                job_folder=job_folder,
                cover_overlay=cover_overlay,
                small_overlay=small_overlay,
                logo_overlay=logo_overlay,
                overlay_enabled=overlay_enabled,
                status_callback=status_callback,
            )
            encoder_used = result.encoder_used
            if result.return_code != 0:
                return RenderResult(
                    output_path=output_path,
                    duration_sec=duration_sec,
                    return_code=result.return_code,
                    log_tail=f"chunk {idx}/{len(chunks)} failed\n{result.log_tail}",
                    encoder_used=encoder_used,
                )
            chunk_outputs.append(chunk_output)

        rc, log_tail = _concat_chunk_outputs(
            chunks=chunk_outputs,
            output_path=output_path,
            log_path=log_path,
        )
        return RenderResult(
            output_path=output_path,
            duration_sec=duration_sec,
            return_code=rc,
            log_tail=log_tail,
            encoder_used=encoder_used or "chunked",
        )


def _build_filter_complex(
    *,
    edl: EDL,
    file_to_input: dict[str, int],
    segment_input_indices: list[int] | None,
    logo_input_idx: int,
    cover_filter: str,
    small_text_filter: str,
    logo_x: str,
    logo_y: str,
    logo_height: int,
    target_fps: int,
    target_w: int,
    target_h: int,
    logo_enabled: bool = True,
    ass_path: Path | None = None,
    fonts_dir: Path | None = None,
) -> str:
    """Build ffmpeg filter_complex.

    All EDL segments are processed uniformly — INTRO label and body labels
    share the same trim → scale+pad → optional logo overlay → concat chain.
    Cover vs watermark text switching is fully owned by libass (ASS dialogue
    timings), not by this filter graph.

    logo_enabled=False → 整个 logo overlay 链跳过(用于 overlay_enabled=False
    的"无水印导出")。

    Legacy drawtext mode (ass_path=None):INTRO 段叠 cover_filter,其余叠
    small_text_filter,模拟 libass 的 cover↔watermark 切换。
    """
    segs = edl.segments
    n_segs = len(segs)
    use_ass = ass_path is not None

    n_logo = n_segs if logo_enabled else 0
    parts: list[str] = []

    # ── Logo prep: scale + split into n_logo copies ──
    if n_logo > 0:
        if n_logo == 1:
            parts.append(
                f"[{logo_input_idx}:v]format=rgba,scale=-1:{logo_height}[logo0]"
            )
        else:
            split_outs = "".join(f"[logo{i}]" for i in range(n_logo))
            parts.append(
                f"[{logo_input_idx}:v]format=rgba,scale=-1:{logo_height},split={n_logo}{split_outs}"
            )

    # Normalise every segment to the chosen output canvas before concat —
    # multi-source EDLs may mix aspect ratios and ffmpeg's concat filter
    # requires identical dimensions across inputs.
    norm = (
        f",scale={target_w}:{target_h}:force_original_aspect_ratio=decrease:flags=lanczos"
        f",pad={target_w}:{target_h}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1"
    )

    # ── Each segment: trim → text overlay (legacy only) → optional logo ──
    for i, seg in enumerate(segs):
        input_seeked = segment_input_indices is not None
        src = segment_input_indices[i] if input_seeked else file_to_input[seg.file]
        trim_start = 0.0 if input_seeked else seg.start
        trim_end = seg.duration if input_seeked else seg.end
        v_label = f"[seg{i}v]"
        v_tmp = f"[seg{i}vt]"
        a_label = f"[seg{i}a]"
        if use_ass:
            text_chain = ""
        else:
            text_chain = f",{cover_filter}" if seg.label == "INTRO" else f",{small_text_filter}"
        if logo_enabled:
            parts.append(
                f"[{src}:v]trim=start={trim_start:.3f}:end={trim_end:.3f},"
                f"setpts=PTS-STARTPTS,fps={target_fps}"
                f"{norm}{text_chain}{v_tmp}"
            )
            parts.append(
                f"{v_tmp}[logo{i}]overlay=x={logo_x}:y={logo_y}{v_label}"
            )
        else:
            parts.append(
                f"[{src}:v]trim=start={trim_start:.3f}:end={trim_end:.3f},"
                f"setpts=PTS-STARTPTS,fps={target_fps}"
                f"{norm}{text_chain}{v_label}"
            )
        parts.append(
            f"[{src}:a]atrim=start={trim_start:.3f}:end={trim_end:.3f},"
            f"asetpts=PTS-STARTPTS,aresample=async=1:first_pts=0{a_label}"
        )

    # ── Concat all segments ──
    concat_inputs = "".join(f"[seg{i}v][seg{i}a]" for i in range(n_segs))
    concat_n = n_segs

    if use_ass:
        parts.append(
            f"{concat_inputs}concat=n={concat_n}:v=1:a=1[cat_v][outa]"
        )
        ass_escaped = escape_subtitles_path(ass_path)  # type: ignore[arg-type]
        subs = f"subtitles=filename='{ass_escaped}'"
        if fonts_dir is not None:
            fonts_escaped = escape_subtitles_path(fonts_dir)
            subs += f":fontsdir='{fonts_escaped}'"
        parts.append(f"[cat_v]{subs}[outv]")
    else:
        parts.append(
            f"{concat_inputs}concat=n={concat_n}:v=1:a=1[outv][outa]"
        )

    return ";\n".join(parts)


def render(
    *,
    edl: EDL,
    output_path: Path,
    cover_lines: list[str],
    small_lines: list[str],
    config: dict[str, Any],
    log_path: Path | None = None,
    job_folder: Path | None = None,
    cover_overlay: dict[str, Any] | None = None,
    small_overlay: dict[str, Any] | None = None,
    logo_overlay: dict[str, Any] | None = None,
    overlay_enabled: bool = True,
    status_callback: Callable[[str], None] | None = None,
) -> RenderResult:
    assets_cfg = config.get("assets", {})
    cover_cfg = config.get("cover", {})
    overlay_cfg = config.get("overlay", {})
    encoder_cfg = config.get("encoder", {})

    target_fps = int(config.get("target_fps", 30))

    chunk_enabled = bool(encoder_cfg.get("chunk_render", True))
    chunk_threshold = max(1, int(encoder_cfg.get("chunk_threshold_segments", 12)))
    if chunk_enabled and len(edl.segments) > chunk_threshold:
        return _render_chunked(
            edl=edl,
            output_path=output_path,
            cover_lines=cover_lines,
            small_lines=small_lines,
            config=config,
            log_path=log_path,
            job_folder=job_folder,
            cover_overlay=cover_overlay,
            small_overlay=small_overlay,
            logo_overlay=logo_overlay,
            overlay_enabled=overlay_enabled,
            status_callback=status_callback,
        )

    # Inputs are per segment, not deduped per source. With filter-level
    # trim=start=4000, ffmpeg must decode from the file start before producing
    # the first output frame. Per-segment -ss/-t lets long CCTV sources seek
    # straight to each timeline window.
    inputs: list[str] = []
    input_ranges: list[tuple[float, float] | None] = []
    file_to_input: dict[str, int] = {}
    segment_input_indices: list[int] = []
    for seg in edl.segments:
        idx = len(inputs)
        segment_input_indices.append(idx)
        file_to_input.setdefault(seg.file, idx)
        inputs.append(str(Path(seg.file)))
        input_ranges.append((seg.start, seg.duration))
    if not inputs:
        raise ValueError("render() called with empty EDL.segments")

    # Output canvas — picks the user's "16:9 if mixed, else single ratio, else
    # widest" rule. Computed BEFORE the ASS file is written so libass renders
    # against the same PlayResX/Y the video frames will end up at; otherwise
    # libass auto-rescales and overlay positions drift on non-16:9 outputs.
    forced_w = int(encoder_cfg.get("target_width", 0) or 0)
    forced_h = int(encoder_cfg.get("target_height", 0) or 0)
    if forced_w > 0 and forced_h > 0:
        target_w, target_h = forced_w, forced_h
    else:
        target_w, target_h = _compute_target_dims([Path(p) for p in inputs])

    # Text-overlay mode: default to ASS (WYSIWYG-capable) unless config opts out.
    use_ass = bool(overlay_cfg.get("use_ass", True))
    ass_path: Path | None = None
    fonts_dir: Path | None = None

    if use_ass:
        intro_dur = edl.intro_duration_sec
        body_dur = sum(s.duration for s in edl.body_segments)
        total_dur = intro_dur + body_dur
        # Title shows during all INTRO-labeled segments (cumulative);
        # watermark takes over for the body segments after that. Adjust
        # the INTRO segment's start/end to change title display time.
        ass_text = build_overlay_ass(
            cover_lines=cover_lines,
            small_lines=small_lines,
            intro_duration_sec=intro_dur,
            total_duration_sec=total_dur,
            cover_cfg=cover_cfg,
            overlay_cfg=overlay_cfg,
            assets_cfg=assets_cfg,
            cover_overlay=cover_overlay,
            small_overlay=small_overlay,
            play_res_x=target_w,
            play_res_y=target_h,
        )
        # Drop ASS where the UI can find it (stable hand-off point) —
        # always under <job>/_diveedit/overlay.ass.
        from ..utils.paths import overlay_ass_path as _overlay_ass_path
        if job_folder is not None:
            ass_path = _overlay_ass_path(job_folder)
        else:
            ass_path = _overlay_ass_path(output_path.parent)
        ass_path.parent.mkdir(parents=True, exist_ok=True)
        ass_path.write_text(ass_text, encoding="utf-8")

        font_file = Path(str(assets_cfg.get("font_path", "C:/Windows/Fonts/arialbd.ttf")))
        if font_file.exists():
            fonts_dir = font_file.parent

    # Legacy drawtext strings — only used when use_ass=False. Still computed so
    # the filter builder can drop them in when requested.
    cover_filter = cover_filter_from_config(
        lines=cover_lines,
        start_sec=0.0,
        end_sec=max(0.1, edl.intro_duration_sec),
        assets_cfg=assets_cfg,
        cover_cfg=cover_cfg,
    ) if not use_ass else "null"

    small_text_filter = small_text_filter_from_config(
        small_lines=small_lines,
        assets_cfg=assets_cfg,
        overlay_cfg=overlay_cfg,
    ) if not use_ass else "null"

    overlay_renderer = overlay_renderer_from_config(overlay_cfg)
    logo_x, logo_y, logo_height = _logo_overlay_filter_values(
        overlay_renderer.logo_xy_expr(),
        overlay_renderer.logo_max_height(),
        logo_overlay or {},
        target_w=target_w,
        target_h=target_h,
    )

    # logo_path may be relative in config.yaml (preferred for portability).
    # Resolve against app_root() so the same config works in dev and frozen
    # builds. Absolute paths pass through unchanged.
    from ..utils.paths import app_root
    raw_logo = Path(assets_cfg.get("logo_path", "assets/logo.png"))
    logo_path = str(raw_logo if raw_logo.is_absolute() else (app_root() / raw_logo))
    logo_input_idx = len(inputs)
    inputs.append(logo_path)
    input_ranges.append(None)

    # overlay_enabled=False → 整组 logo overlay 全跳过(connect to user's
    # "导出无水印无 logo" 期望)。cover/small 文本由调用方传空 list 实现。
    fc = _build_filter_complex(
        edl=edl,
        file_to_input=file_to_input,
        segment_input_indices=segment_input_indices,
        logo_input_idx=logo_input_idx,
        cover_filter=cover_filter,
        small_text_filter=small_text_filter,
        logo_x=logo_x,
        logo_y=logo_y,
        logo_height=logo_height,
        target_fps=target_fps,
        target_w=target_w,
        target_h=target_h,
        logo_enabled=overlay_enabled,
        ass_path=ass_path,
        fonts_dir=fonts_dir,
    )

    # Write filter_complex to a script file (Windows command line is ~32KB max)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        "w", encoding="utf-8", suffix=".filter", delete=False
    ) as fp:
        fp.write(fc)
        fc_path = Path(fp.name)

    # Also dump filter to job logs for debugging
    if log_path is not None:
        debug_filter = log_path.parent / "filter_complex.txt"
        debug_filter.write_text(fc, encoding="utf-8")

    input_prefix, video_output_args, encoder_label = _build_encoder_args(encoder_cfg)

    # Total target duration — used to convert ffmpeg's out_time into a percent.
    duration_sec = sum(s.duration for s in edl.segments)

    if status_callback is not None:
        status_callback(
            f"  Render plan: encoder={encoder_label}, "
            f"segments={len(edl.segments)}, inputs={len(inputs) - 1}, "
            f"duration={duration_sec/60:.1f}m, output={output_path}"
        )

    # `-progress pipe:1` makes ffmpeg emit machine-readable key=value lines
    # to stdout (out_time_ms, frame, fps, progress=continue/end) which we
    # parse live in a thread to emit `[render-progress N/100]` once per
    # second. Without this the bar is stuck at 0% until ffmpeg exits.
    cmd: list[str] = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-nostats"]
    for inp, in_range in zip(inputs, input_ranges):
        cmd += ["-fflags", "+genpts+discardcorrupt", "-err_detect", "ignore_err"]
        cmd += input_prefix
        if in_range is not None:
            start_sec, dur_sec = in_range
            cmd += ["-ss", f"{start_sec:.3f}", "-t", f"{dur_sec:.3f}"]
        cmd += ["-i", inp]
    cmd += ["-filter_complex_script", str(fc_path)]
    cmd += ["-map", "[outv]", "-map", "[outa]"]
    cmd += video_output_args
    cmd += _build_audio_output_args(encoder_cfg, output_path)
    cmd += [
        "-movflags", "+faststart",
        "-progress", "pipe:1", "-nostdin",
        str(output_path),
    ]

    if log_path is not None:
        with log_path.open("a", encoding="utf-8") as f:
            f.write("\n--- ffmpeg render start ---\n")
            f.write(f"encoder={encoder_label}\n")
            f.write(f"segments={len(edl.segments)}\n")
            f.write(f"inputs={len(inputs) - 1}\n")
            f.write(f"duration_sec={duration_sec:.3f}\n")
            f.write(f"output={output_path}\n")
            f.write("cmd=" + " ".join(cmd) + "\n")

    import queue as _queue
    import sys as _sys
    import threading as _th
    import time as _time
    stderr_chunks: list[str] = []
    kill_job: object | None = None
    stall_timeout_sec = max(30.0, float(encoder_cfg.get("stall_timeout_sec", 120)))

    def _drain_stderr(p: subprocess.Popen) -> None:
        if p.stderr is None:
            return
        try:
            for raw in p.stderr:
                stderr_chunks.append(raw)
        except Exception:  # noqa: BLE001
            pass

    progress_done = object()
    progress_queue: _queue.Queue[str | object] = _queue.Queue()

    def _drain_stdout(p: subprocess.Popen) -> None:
        if p.stdout is None:
            progress_queue.put(progress_done)
            return
        try:
            for raw in p.stdout:
                progress_queue.put(raw)
        except Exception:  # noqa: BLE001
            pass
        finally:
            progress_queue.put(progress_done)

    def _log_render_event(message: str) -> None:
        if log_path is not None:
            with log_path.open("a", encoding="utf-8") as f:
                f.write(message + "\n")

    try:
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
            **hidden_subprocess_kwargs(),
        )
        kill_job = _attach_child_kill_job(proc)
        if log_path is not None:
            with log_path.open("a", encoding="utf-8") as f:
                state = "attached" if kill_job is not None else "unavailable"
                f.write(f"job_object={state}")
                if _child_kill_job_last_error:
                    f.write(f" ({_child_kill_job_last_error})")
                f.write("\n")
        err_thread = _th.Thread(target=_drain_stderr, args=(proc,), daemon=True)
        err_thread.start()

        out_thread = _th.Thread(target=_drain_stdout, args=(proc,), daemon=True)
        out_thread.start()

        last_pct = -1
        last_progress_at = _time.monotonic()
        last_progress_sec = 0.0
        stdout_closed = proc.stdout is None
        stalled = False
        while True:
            if proc.poll() is not None and stdout_closed:
                break
            try:
                raw_item = progress_queue.get(timeout=1.0)
            except _queue.Empty:
                raw_item = None

            if raw_item is progress_done:
                stdout_closed = True
                continue

            if raw_item is None:
                idle_sec = _time.monotonic() - last_progress_at
                if proc.poll() is None and idle_sec >= stall_timeout_sec:
                    stalled = True
                    message = (
                        "ffmpeg render stalled: "
                        f"no progress for {idle_sec:.0f}s; "
                        f"last={last_progress_sec:.1f}/{duration_sec:.1f}s"
                    )
                    _sys.stdout.write(f"  [render-progress] {message}\n")
                    _sys.stdout.flush()
                    _log_render_event(message)
                    if status_callback is not None:
                        status_callback("  " + message)
                    try:
                        proc.kill()
                    except OSError:
                        pass
                    break
                continue

            line = str(raw_item).rstrip()
            if not line:
                continue
            if line.startswith(("out_time_ms=", "out_time_us=")):
                try:
                    cur_us = int(line.split("=", 1)[1])
                except ValueError:
                    continue
                cur_sec = max(0.0, cur_us / 1_000_000.0)
                if cur_sec > last_progress_sec:
                    last_progress_sec = cur_sec
                    last_progress_at = _time.monotonic()
                if duration_sec > 0:
                    pct = max(0, min(99, int(round(cur_sec / duration_sec * 100))))
                    if pct != last_pct:
                        msg = f"  [render-progress] [{pct}/100] {cur_sec:.1f}/{duration_sec:.1f}s"
                        _sys.stdout.write(msg + "\n")
                        _sys.stdout.flush()
                        _log_render_event(msg.strip())
                        last_pct = pct
            elif line.startswith("progress=end"):
                _sys.stdout.write(f"  [render-progress] [100/100] done\n")
                _sys.stdout.flush()
                _log_render_event("[render-progress] [100/100] done")
                last_progress_at = _time.monotonic()

        if stalled and proc.poll() is None:
            try:
                proc.kill()
            except OSError:
                pass
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            try:
                proc.kill()
            except OSError:
                pass
            proc.wait()
        err_thread.join(timeout=2.0)
        out_thread.join(timeout=2.0)
    finally:
        if "proc" in locals() and proc.poll() is None:
            try:
                proc.kill()
            except OSError:
                pass
        if kill_job is not None and sys.platform == "win32":
            try:
                import ctypes
                ctypes.WinDLL("kernel32", use_last_error=True).CloseHandle(kill_job)
            except Exception:  # noqa: BLE001
                pass
        try:
            fc_path.unlink()
        except OSError:
            pass

    stderr_text = "".join(stderr_chunks)
    log_tail = stderr_text[-4000:]
    if log_path is not None:
        with log_path.open("a", encoding="utf-8") as f:
            f.write("\n--- ffmpeg stderr ---\n")
            f.write(stderr_text)

    return RenderResult(
        output_path=output_path,
        duration_sec=duration_sec,
        return_code=proc.returncode,
        log_tail=log_tail,
        encoder_used=encoder_label,
    )
