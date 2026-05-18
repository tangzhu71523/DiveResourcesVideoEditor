"""ffmpeg renderer.

Builds a single filter_complex from the EDL plus the cover/overlay filter
strings, writes it to a script file (to avoid Windows command-line limits),
and invokes ffmpeg with NVENC.
"""
from __future__ import annotations
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ..analyze.edl import EDL, Segment
from .ass_builder import build_overlay_ass, escape_subtitles_path
from .cover import cover_filter_from_config
from .overlay import overlay_renderer_from_config, small_text_filter_from_config


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


def _build_filter_complex(
    *,
    edl: EDL,
    file_to_input: dict[str, int],
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
        src = file_to_input[seg.file]
        v_label = f"[seg{i}v]"
        v_tmp = f"[seg{i}vt]"
        a_label = f"[seg{i}a]"
        if use_ass:
            text_chain = ""
        else:
            text_chain = f",{cover_filter}" if seg.label == "INTRO" else f",{small_text_filter}"
        if logo_enabled:
            parts.append(
                f"[{src}:v]trim=start={seg.start:.3f}:end={seg.end:.3f},"
                f"setpts=PTS-STARTPTS,fps={target_fps}"
                f"{norm}{text_chain}{v_tmp}"
            )
            parts.append(
                f"{v_tmp}[logo{i}]overlay=x={logo_x}:y={logo_y}{v_label}"
            )
        else:
            parts.append(
                f"[{src}:v]trim=start={seg.start:.3f}:end={seg.end:.3f},"
                f"setpts=PTS-STARTPTS,fps={target_fps}"
                f"{norm}{text_chain}{v_label}"
            )
        parts.append(
            f"[{src}:a]atrim=start={seg.start:.3f}:end={seg.end:.3f},"
            f"asetpts=PTS-STARTPTS{a_label}"
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
    overlay_enabled: bool = True,
) -> RenderResult:
    assets_cfg = config.get("assets", {})
    cover_cfg = config.get("cover", {})
    overlay_cfg = config.get("overlay", {})
    encoder_cfg = config.get("encoder", {})

    target_fps = int(config.get("target_fps", 30))

    # ── Inputs: deduped sources (any label) appear once, logo last ──
    # 不分 intro / body,所有 segments 一视同仁。intro 段就是 label=INTRO
    # 的 segment(可能 0 个,也可能多个,UI 让用户随意删/加)。
    inputs: list[str] = []
    file_to_input: dict[str, int] = {}
    for seg in edl.segments:
        if seg.file not in file_to_input:
            file_to_input[seg.file] = len(inputs)
            inputs.append(str(Path(seg.file)))
    if not inputs:
        raise ValueError("render() called with empty EDL.segments")

    # Output canvas — picks the user's "16:9 if mixed, else single ratio, else
    # widest" rule. Computed BEFORE the ASS file is written so libass renders
    # against the same PlayResX/Y the video frames will end up at; otherwise
    # libass auto-rescales and overlay positions drift on non-16:9 outputs.
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
    logo_x, logo_y = overlay_renderer.logo_xy_expr()
    logo_height = overlay_renderer.logo_max_height()

    # logo_path may be relative in config.yaml (preferred for portability).
    # Resolve against app_root() so the same config works in dev and frozen
    # builds. Absolute paths pass through unchanged.
    from ..utils.paths import app_root
    raw_logo = Path(assets_cfg.get("logo_path", "assets/logo.png"))
    logo_path = str(raw_logo if raw_logo.is_absolute() else (app_root() / raw_logo))
    logo_input_idx = len(inputs)
    inputs.append(logo_path)

    # overlay_enabled=False → 整组 logo overlay 全跳过(connect to user's
    # "导出无水印无 logo" 期望)。cover/small 文本由调用方传空 list 实现。
    fc = _build_filter_complex(
        edl=edl,
        file_to_input=file_to_input,
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

    # `-progress pipe:1` makes ffmpeg emit machine-readable key=value lines
    # to stdout (out_time_ms, frame, fps, progress=continue/end) which we
    # parse live in a thread to emit `[render-progress N/100]` once per
    # second. Without this the bar is stuck at 0% until ffmpeg exits.
    cmd: list[str] = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-nostats"]
    cmd += input_prefix
    for inp in inputs:
        cmd += ["-i", inp]
    cmd += ["-filter_complex_script", str(fc_path)]
    cmd += ["-map", "[outv]", "-map", "[outa]"]
    cmd += video_output_args
    cmd += [
        "-c:a", str(encoder_cfg.get("acodec", "aac")),
        "-b:a", str(encoder_cfg.get("abitrate", "192k")),
        "-movflags", "+faststart",
        "-progress", "pipe:1", "-nostdin",
        str(output_path),
    ]

    import threading as _th
    import sys as _sys
    stderr_chunks: list[str] = []

    def _drain_stderr(p: subprocess.Popen) -> None:
        if p.stderr is None:
            return
        try:
            for raw in p.stderr:
                stderr_chunks.append(raw)
        except Exception:  # noqa: BLE001
            pass

    try:
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
        )
        err_thread = _th.Thread(target=_drain_stderr, args=(proc,), daemon=True)
        err_thread.start()

        last_pct = -1
        if proc.stdout is not None and duration_sec > 0:
            for raw in proc.stdout:
                line = raw.rstrip()
                if not line:
                    continue
                if line.startswith("out_time_ms="):
                    try:
                        cur_us = int(line.split("=", 1)[1])
                    except ValueError:
                        continue
                    cur_sec = max(0.0, cur_us / 1_000_000.0)
                    pct = max(0, min(99, int(round(cur_sec / duration_sec * 100))))
                    if pct != last_pct:
                        _sys.stdout.write(f"  [render-progress] [{pct}/100] {cur_sec:.1f}/{duration_sec:.1f}s\n")
                        _sys.stdout.flush()
                        last_pct = pct
                elif line.startswith("progress=end"):
                    _sys.stdout.write(f"  [render-progress] [100/100] done\n")
                    _sys.stdout.flush()

        proc.wait()
        err_thread.join(timeout=2.0)
    finally:
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
