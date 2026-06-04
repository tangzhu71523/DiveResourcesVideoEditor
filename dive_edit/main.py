"""Dive Video Auto-Editor CLI entry point.

Pipeline order:
  0. Resolve job folder + gather metadata (cover/small text + target)
  1. Batch Whisper transcribe selected videos once
  2. Auto-detect intro file from cover keywords in transcripts
  3. OCR timestamp sanity check on intro/body files
  4. Build EDL with speech-lock protection around narration bursts
  5. Render with ffmpeg using NVENC or libx264
"""
from __future__ import annotations
import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

# CRITICAL: force UTF-8 on stdout/stderr BEFORE any print/import that might emit
# non-ASCII. On Chinese Windows, default encoding is cp936/gbk which cannot encode
# characters like -> (U+2192), [OK] (U+2713), etc. A single unlucky print() then
# raises UnicodeEncodeError, which aborts the process with no visible traceback.
if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

import yaml

from . import metadata
from .picker import pick_job_folder, pick_intro_file, list_with_durations, probe_duration_sec
from .metadata import JobMeta
from .utils.paths import build_output_name, ensure_job_subdirs, list_mp4s
from .utils.logging import JobLogger
from .utils.perf_monitor import PipelinePerfMonitor
from .render.time_config import TimeConfig
from .analyze.audio import (
    locate_intro_speech_from_words,
    auto_detect_intro_file_from_transcripts,
    transcribe_files_batch,
    derive_initial_prompt,
    detect_end_report_boundary,
    FileTranscript,
    IntroSpeechWindow,
    DEFAULT_AUDIO_FILTER_CHAIN,
)
from .analyze.edl import build_edl, EDL
from .analyze.timeline import FileTimeline
from .analyze.ocr_timestamp import extract_file_timestamps, check_monotonicity, parse_timestamp_from_filename
from .source_edl import (
    SourceEDLSegment,
    load_source_edl,
    remap_edl_to_sources,
    resolve_source_segments,
    stage_source_clips,
)
from .render.ffmpeg_runner import render


PROJECT_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_CONFIG_PATH = PROJECT_ROOT / "config.yaml"


def _load_manual_intro_window(edl_path: Path, logger: JobLogger) -> tuple[str, float, float] | None:
    if not edl_path.exists():
        return None
    try:
        edl = EDL.load(edl_path)
    except (OSError, json.JSONDecodeError, TypeError, ValueError) as exc:
        logger.warn(f"  Timeline title window ignored: cannot load EDL ({type(exc).__name__}: {exc})")
        return None
    intros = edl.intro_segments
    if not intros:
        return None
    intro = intros[0]
    start = max(0.0, float(intro.start))
    end = max(start, float(intro.end))
    if not intro.file or end <= start:
        return None
    return intro.file, start, end


def _same_video_ref(a: str | Path, b: str | Path) -> bool:
    ap = Path(str(a))
    bp = Path(str(b))
    if ap.name.lower() == bp.name.lower():
        return True
    try:
        return ap.expanduser().resolve() == bp.expanduser().resolve()
    except OSError:
        return False


def _source_segments_cover_intro(
    segments: list[SourceEDLSegment],
    manual_intro: tuple[str, float, float],
) -> bool:
    intro_file, intro_start, intro_end = manual_intro
    for seg in segments:
        if not seg.enabled or not _same_video_ref(seg.file, intro_file):
            continue
        if seg.start <= intro_start + 0.05 and seg.end >= intro_end - 0.05:
            return True
    return False


def _resolve_manual_intro_override(
    manual_intro: tuple[str, float, float] | None,
    *,
    job_folder: Path,
    analyze_targets: list[Path],
    staged_by_original_name: dict[str, Path],
    source_clips: list[Any],
) -> tuple[Path, float, float] | None:
    if manual_intro is None:
        return None
    intro_file, intro_start, intro_end = manual_intro
    if source_clips:
        matches = []
        for clip in source_clips:
            if not _same_video_ref(clip.source_path, intro_file):
                continue
            if clip.source_start <= intro_start + 0.05 and clip.source_end >= intro_end - 0.05:
                matches.append(clip)
        if matches:
            matches.sort(key=lambda c: (0 if c.label == "INTRO" else 1, c.source_end - c.source_start))
            clip = matches[0]
            start = max(0.0, intro_start - clip.source_start)
            end = max(start, intro_end - clip.source_start)
            return clip.clip_path, start, end
        return None

    intro_name = Path(intro_file).name.lower()
    candidate = staged_by_original_name.get(intro_name)
    if candidate is None:
        for target in analyze_targets:
            if _same_video_ref(target, intro_file):
                candidate = target
                break
    if candidate is None:
        raw = Path(intro_file)
        if not raw.is_absolute():
            raw = job_folder / intro_file
        if raw.exists():
            candidate = raw
    if candidate is None or candidate not in analyze_targets:
        return None
    return candidate, intro_start, intro_end


def load_config(path: Path = DEFAULT_CONFIG_PATH) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as f:
        return yaml.safe_load(f) or {}


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(prog="dive_edit", description="Dive Video Auto-Editor")
    p.add_argument("--job", type=Path, help="Job folder (skip the tkinter dialog)")
    p.add_argument("--reset", action="store_true",
                   help="Ignore existing job.yaml, re-run all interactive prompts")
    p.add_argument("--config", type=Path, default=DEFAULT_CONFIG_PATH,
                   help="Path to config.yaml")
    p.add_argument("--render-only", action="store_true",
                   help="Skip analysis, reuse _edl.json (manual edits supported)")
    p.add_argument("--skip-render", action="store_true",
                   help="Run steps 1-4 (analysis + EDL) only; do not render video")
    p.add_argument("--output-path", type=Path, default=None,
                   help="Output directory for the rendered file "
                        "(used with --render-only; defaults to job/output/)")
    p.add_argument("--workers", type=int, default=1,
                   help="[dev] Whisper parallel worker count (default 1; do not change in production)")
    p.add_argument("--whisper-model", type=str, default=None,
                   help="[dev] override config whisper.model (e.g. medium / small.en)")
    p.add_argument("--vad", choices=["on", "off"], default=None,
                   help="[dev] override VAD switch, default off")
    p.add_argument("--no-render", action="store_true",
                   help="[dev] skip ffmpeg render, stop at EDL stage (for A/B benchmark)")
    p.add_argument("--target-duration", type=float, default=None,
                   help="[dev] override job.yaml target_duration_min")
    p.add_argument("--padding-end-cap", choices=["on", "off"], default="on",
                   help="[dev] whether segment tails cap at END+5s; default on (fixes padding-past-END bug)")
    ns = p.parse_args()
    if ns.skip_render and ns.render_only:
        p.error("--skip-render  is mutually exclusive with --render-only")
    return ns


def banner(msg: str) -> None:
    bar = "=" * 50
    print(bar)
    print(f"  {msg}")
    print(bar)


def resolve_job_folder(args: argparse.Namespace) -> Path | None:
    if args.job:
        return Path(args.job).expanduser().resolve()
    print("\n[Select Job folder]")
    folder = pick_job_folder()
    if folder is None:
        print("Cancelled.")
        return None
    print(f"> Selected: {folder}")
    return folder


def gather_metadata(
    job_folder: Path,
    args: argparse.Namespace,
    config: dict[str, Any],
) -> JobMeta | None:
    """Collect user-supplied text/target. Intro auto-detect happens in the pipeline."""
    existing = metadata.load(job_folder)

    if existing and not args.reset:
        print(f"\n[Reusing job.yaml]  job_no={existing.job_no}  vessel={existing.vessel}")
        print(f"  intro_file={existing.intro_file or '(auto)'}")
        print(f"  target_duration_min={existing.target_duration_min}")
        return existing

    meta = metadata.prompt_three(existing=existing)
    return meta


def run_pipeline(
    *,
    job_folder: Path,
    meta: JobMeta,
    config: dict[str, Any],
    logger: JobLogger,
    args: argparse.Namespace,
) -> int:
    # Resolve explicit output directory (--output-path flag, may be None).
    explicit_output_dir: Path | None = None
    if getattr(args, "output_path", None) is not None:
        explicit_output_dir = Path(args.output_path).expanduser().resolve()
    paths = ensure_job_subdirs(job_folder)
    if explicit_output_dir is not None:
        try:
            explicit_output_dir.mkdir(parents=True, exist_ok=True)
        except OSError as e:
            logger.error(f"Cannot prepare export folder: {explicit_output_dir} ({e})")
            return 5
        paths["output"] = explicit_output_dir
    # All app artifacts live under <job>/_diveedit/; see utils/paths.py.
    from .utils.paths import edl_path as _edl_path, transcripts_dir
    edl_path = _edl_path(job_folder)
    transcript_cache_dir = transcripts_dir(job_folder)
    ts_crop_cfg = config.get("overlay", {}).get("monitor_avoid", {}).get(
        "timestamp_top_right", {"x": 1200, "y": 40, "w": 720, "h": 60}
    )

    stage_times: dict[str, float] = {}
    speech: IntroSpeechWindow | None = None

    # -- [init] dump: raw input state for the pipeline run --
    # Evidence-grade record of everything the pipeline saw at startup.
    # Anyone reading the log later can reconstruct the device-decision
    # outcome without rerunning anything.
    logger.kv("[init] runtime",
              frozen=getattr(sys, "frozen", False),
              executable=sys.executable,
              cwd=str(Path.cwd()),
              meipass=getattr(sys, "_MEIPASS", None),
              argv=sys.argv)
    logger.kv("[init] env",
              DIVE_CUDA_STATUS=os.environ.get("DIVE_CUDA_STATUS"),
              DIVE_FORCE_CPU=os.environ.get("DIVE_FORCE_CPU"),
              PYTHONUTF8=os.environ.get("PYTHONUTF8"),
              PYTHONIOENCODING=os.environ.get("PYTHONIOENCODING"),
              PATH_head=os.environ.get("PATH", "")[:300])
    logger.kv("[init] args",
              job=str(getattr(args, "job", None)),
              workers=getattr(args, "workers", None),
              whisper_model=getattr(args, "whisper_model", None),
              vad=getattr(args, "vad", None),
              render_only=getattr(args, "render_only", False),
              skip_render=getattr(args, "skip_render", False),
              output_path=str(getattr(args, "output_path", None)))
    logger.kv("[init] meta",
              job_no=meta.job_no,
              vessel=meta.vessel,
              intro_file=meta.intro_file or "(auto)",
              cover_lines_count=len(meta.cover_lines),
              small_lines_count=len(meta.small_lines),
              target_min=meta.target_duration_min,
              body_files_count=len(meta.body_files))
    body_timelines: list[FileTimeline] = []
    full_transcripts: dict[Path, FileTranscript] = {}
    word_only: dict[Path, list[tuple[float, float, str]]] = {}
    source_clips = []
    manual_intro_window: tuple[str, float, float] | None = None
    manual_intro_override: tuple[Path, float, float] | None = None

    # Build TimeConfig (config defaults + job override)
    target_min = meta.target_duration_min
    if getattr(args, "target_duration", None) is not None:
        target_min = float(args.target_duration)
        logger.info(f"  [dev override] target_duration_min={target_min}")
    time_cfg = TimeConfig.from_dicts(
        defaults=config.get("time", {}),
        job={
            "target_duration_min": target_min,
            "intro_speech_override": list(meta.intro_speech_override) if meta.intro_speech_override else None,
        },
    )
    manual_intro_window = _load_manual_intro_window(edl_path, logger)
    if manual_intro_window is not None:
        intro_file, intro_start, intro_end = manual_intro_window
        logger.info(
            "  Timeline title window found: "
            f"{Path(intro_file).name} {intro_start:.1f}s-{intro_end:.1f}s"
        )

    # -- Short-circuit: --render-only reuses existing EDL --
    if args.render_only and edl_path.exists():
        logger.info("--render-only: skipping analysis stages, loading existing _edl.json")
        try:
            edl = EDL.load(edl_path)
        except (OSError, json.JSONDecodeError, TypeError, ValueError) as exc:
            logger.error(f"Cannot load EDL for render-only export: {type(exc).__name__}: {exc}")
            return 5
        speech = IntroSpeechWindow(
            start_sec=edl.intro_speech_start,
            end_sec=edl.intro_speech_end,
            source="edl_reuse",
        )
        intro_path = Path(edl.intro_file)
        output_path = paths["output"] / build_output_name(meta.job_no, meta.vessel)
    else:
        # -- Resolve candidate file list --
        all_videos = list_mp4s(job_folder)
        if not all_videos:
            logger.error("No video files found in job folder (mp4/avi/mov/mkv/...)")
            return 3
        if meta.body_files:
            allowed = set(meta.body_files)
            # body_files filter is the user's explicit "process these
            # files only" checkbox state from the UI. Honour it at the
            # ANALYSIS layer too; previously we analyzed every video
            # in the folder and only filtered at body-EDL time, which
            # leaked unselected files (e.g. a previous render's output
            # mp4) into intro detection and let them outscore the real
            # body sources.
            analyze_targets = [v for v in all_videos if v.name in allowed]
            if not analyze_targets:
                logger.error(
                    "body_files filter excluded every video; none of the"
                    f" selected names {sorted(allowed)} match files on disk:"
                    f" {[v.name for v in all_videos]}"
                )
                return 3
        else:
            analyze_targets = all_videos
        selected_source_names = {p.name for p in analyze_targets} if meta.body_files else None
        if manual_intro_window is not None and selected_source_names is not None:
            intro_file, _intro_start, _intro_end = manual_intro_window
            if Path(intro_file).name not in selected_source_names:
                logger.warn(
                    "  Timeline title window ignored: its source video is not selected for this run: "
                    f"{Path(intro_file).name}"
                )
                manual_intro_window = None
        from .utils.paths import source_edl_path as _source_edl_path
        source_segments = load_source_edl(_source_edl_path(job_folder))
        enabled_source_segments = [seg for seg in source_segments if seg.enabled]
        if enabled_source_segments:
            resolved_source_segments = resolve_source_segments(
                job_folder,
                enabled_source_segments,
                allowed_names=selected_source_names,
            )
            if manual_intro_window is not None and not _source_segments_cover_intro(enabled_source_segments, manual_intro_window):
                intro_file, intro_start, intro_end = manual_intro_window
                resolved_manual_intro = resolve_source_segments(
                    job_folder,
                    [SourceEDLSegment(
                        file=intro_file,
                        start=intro_start,
                        end=intro_end,
                        label="INTRO",
                        enabled=True,
                        group_id="_manual_intro",
                    )],
                    allowed_names=selected_source_names,
                )
                if resolved_manual_intro:
                    resolved_source_segments = [*resolved_source_segments, *resolved_manual_intro]
                    logger.info(
                        "  Timeline title window is outside selected source windows; "
                        f"adding manual intro clip for analysis: {Path(intro_file).name} "
                        f"{intro_start:.1f}s-{intro_end:.1f}s"
                    )
            if resolved_source_segments:
                try:
                    source_clips = stage_source_clips(
                        job_folder=job_folder,
                        resolved_segments=resolved_source_segments,
                        logger=logger,
                    )
                except (OSError, subprocess.CalledProcessError, subprocess.TimeoutExpired, TimeoutError) as exc:
                    logger.error(f"source window clip preparation failed: {type(exc).__name__}: {exc}")
                    return 5
                manual_source_names = {source.name.lower() for source, _seg in resolved_source_segments}
                analyze_targets = [
                    target for target in analyze_targets
                    if target.name.lower() not in manual_source_names
                ]
                analyze_targets = [*analyze_targets, *[clip.clip_path for clip in source_clips]]
                original_by_staged = {clip.clip_path: clip.source_path for clip in source_clips}
                staged_by_original_name: dict[str, Path] = {}
                for clip in source_clips:
                    staged_by_original_name.setdefault(clip.source_path.name.lower(), clip.clip_path)
                logger.info(
                    f"  Source windows: replacing {len(manual_source_names)} selected source file(s) "
                    f"with {len(source_clips)} manual window clip(s)"
                )
            else:
                original_by_staged = {}
                staged_by_original_name = {p.name.lower(): p for p in analyze_targets}
        else:
            original_by_staged = {}
            staged_by_original_name = {p.name.lower(): p for p in analyze_targets}
            if manual_intro_window is not None:
                intro_file, intro_start, intro_end = manual_intro_window
                intro_already_selected = any(_same_video_ref(target, intro_file) for target in analyze_targets)
                if not intro_already_selected:
                    resolved_manual_intro = resolve_source_segments(
                        job_folder,
                        [SourceEDLSegment(
                            file=intro_file,
                            start=intro_start,
                            end=intro_end,
                            label="INTRO",
                            enabled=True,
                            group_id="_manual_intro",
                        )],
                        allowed_names=selected_source_names,
                    )
                    if resolved_manual_intro:
                        try:
                            manual_intro_clips = stage_source_clips(
                                job_folder=job_folder,
                                resolved_segments=resolved_manual_intro,
                                logger=logger,
                            )
                        except (OSError, subprocess.CalledProcessError, subprocess.TimeoutExpired, TimeoutError) as exc:
                            logger.error(f"manual intro clip preparation failed: {type(exc).__name__}: {exc}")
                            return 5
                        source_clips = [*source_clips, *manual_intro_clips]
                        analyze_targets = [*analyze_targets, *[clip.clip_path for clip in manual_intro_clips]]
                        for clip in manual_intro_clips:
                            original_by_staged[clip.clip_path] = clip.source_path
                            staged_by_original_name.setdefault(clip.source_path.name.lower(), clip.clip_path)
                        logger.info(
                            "  Timeline title window is outside selected files; "
                            f"adding manual intro clip for analysis: {Path(intro_file).name} "
                            f"{intro_start:.1f}s-{intro_end:.1f}s"
                        )
        source_start_by_staged: dict[Path, float] = {
            clip.clip_path: float(clip.source_start) for clip in source_clips
        }
        manual_intro_override = _resolve_manual_intro_override(
            manual_intro_window,
            job_folder=job_folder,
            analyze_targets=analyze_targets,
            staged_by_original_name=staged_by_original_name,
            source_clips=source_clips,
        )
        body_whitelist: set[str] | None = {p.name for p in analyze_targets} if meta.body_files else None

        # -- Step 1: batch transcribe (cached files skipped instantly) --
        logger.step(1, 5, f"Batch-transcribe {len(analyze_targets)} file(s) with Whisper")
        initial_prompt = derive_initial_prompt(meta.cover_lines)
        if initial_prompt:
            logger.info(f"  initial_prompt: {initial_prompt[:120]}...")
        # Apply CLI overrides (dev A/B testing).
        whisper_cfg = dict(config.get("whisper", {}))
        if not getattr(args, "vad", None):
            whisper_cfg["vad"] = "off"
        logger.info("  Quality filters: VAD off; hallucination dictionary and HSV bad-frame gates use config defaults")
        if getattr(args, "whisper_model", None):
            whisper_cfg["model"] = args.whisper_model
            logger.info(f"  [dev override] whisper.model={args.whisper_model}")
        elif os.environ.get("DIVE_FORCE_CPU") == "1":
            whisper_cfg["model"] = "medium"
            logger.info("  [auto] CPU mode: whisper.model=medium")
        if getattr(args, "vad", None):
            whisper_cfg["vad"] = args.vad  # "on" / "off"
            logger.info(f"  [dev override] whisper.vad={args.vad}")
        t0 = time.time()
        full_transcripts = transcribe_files_batch(
            analyze_targets,
            cache_dir=transcript_cache_dir,
            whisper_cfg=whisper_cfg,
            max_scan_sec=0,
            preprocess=False,
            filter_chain=DEFAULT_AUDIO_FILTER_CHAIN,
            initial_prompt=initial_prompt,
            n_workers=max(1, int(getattr(args, "workers", 1) or 1)),
            logger=logger,
        )
        stage_times["whisper"] = time.time() - t0
        raw_total_words = sum(len(t.words) for t in full_transcripts.values())
        logger.info(
            f"  Step 1 total: {stage_times['whisper']:.1f}s, {raw_total_words} raw words"
        )
        failed_transcripts = [
            (p, t.failure_reason or "unknown failure")
            for p, t in full_transcripts.items()
            if getattr(t, "transcription_failed", False)
        ]
        if failed_transcripts:
            logger.error("  Transcript generation failed for required input file(s):")
            for p, reason in failed_transcripts[:8]:
                logger.error(f"    - {p.name}: {reason}")
            if len(failed_transcripts) > 8:
                logger.error(f"    - ... and {len(failed_transcripts) - 8} more")
            logger.error(
                "  Pipeline stopped. Intro detection cannot safely treat missing "
                "transcripts as zero keyword matches."
            )
            return 5

        # Raw Whisper words. The audio filter chain was removed after it
        # reduced accuracy; word_only and word_raw now intentionally match.
        word_only = {p: t.words for p, t in full_transcripts.items()}
        word_raw = dict(word_only)

        # -- Step 2: find intro + determine body files --
        logger.step(2, 5, "Detect intro file and determine body range")
        intro_path: Path | None = None

        if manual_intro_override is not None:
            intro_path = manual_intro_override[0]
            logger.info(
                "  Using timeline title window; auto intro detection skipped: "
                f"{intro_path.name} {manual_intro_override[1]:.1f}s-{manual_intro_override[2]:.1f}s"
            )
        elif meta.intro_file:
            candidate = staged_by_original_name.get(meta.intro_file.lower(), job_folder / meta.intro_file)
            if candidate.exists() and (not source_clips or candidate in analyze_targets):
                intro_path = candidate
                logger.info(f"  Using intro from job.yaml: {candidate.name}")
            else:
                logger.warn(
                    f"  job.yaml  intro_file from job.yaml={meta.intro_file!r}  does not exist, "
                    f" switching to auto-detect."
                )

        if intro_path is None:
            detection = auto_detect_intro_file_from_transcripts(
                analyze_targets,
                word_only,
                cover_lines=meta.cover_lines,
                min_score=int(config.get("intro_detect", {}).get("min_score", 2)),
                logger=logger,
            )
            if detection is None:
                # auto_detect returns None when:
                #   (a) candidates list is empty; already caught above, won't reach here
                #   (b) cover_lines is empty; already caught in main() before pipeline
                #   (c) cover_lines produces zero keywords (e.g. all short words / symbols)
                # Case (c) is the likely cause when user fills cover text with
                # words too short or generic to extract keywords from.
                logger.error(
                    "  Cannot auto-detect intro file."
                    " Likely cause: cover text too short or only common words; no useful keywords."
                    " Fix: manually pick intro in the UI, or include specific words in cover text such as"
                    " (format example: JOB NO: DD26041550 / VESSEL NAME: GUO YUAN 20)."
                )
                return 4
            intro_path = detection.file
            min_score = int(config.get("intro_detect", {}).get("min_score", 2))
            if detection.score < min_score:
                # SOFT FALLBACK was used; flag prominently for human review.
                logger.warn(
                    f"  [INTRO WARN] soft-fallback selected: {intro_path.name} "
                    f"(score={detection.score} < min_score={min_score})"
                )
                logger.warn(
                    f"  [INTRO WARN] Please verify manually; on mistake set intro_file in job.yaml then --reset."
                )
            else:
                logger.info(
                    f"  Selected intro: {intro_path.name} "
                    f"({detection.score} keywords matched: {', '.join(detection.matched_keywords)})"
                )
            meta.intro_file = original_by_staged.get(intro_path, intro_path).name
            metadata.save(job_folder, meta)

        # Body = files AFTER intro by timestamp.
        # Two trusted sources (both survive user rename):
        #   1. Filename timestamp (real recording time, when present).
        #   2. File mtime (preserved through rename/copy).
        # OCR not used here (too fragile; see 12.avi systematic misread).
        #
        # For renamed files without filename timestamp, we project mtime
        # to recording time by LOCAL NEIGHBOR interpolation (not global
        # offset); preserves position ordering even if mtime offset varies.
        from datetime import datetime as _dt, timedelta as _td
        import os as _os
        logger.info("  Resolving body range (filename-order primary, mtime neighbor-interp fallback)")

        file_first_times: dict[Path, Any] = {}
        mtime_map: dict[Path, _dt] = {}
        anchored: list[tuple[_dt, _dt]] = []  # (mtime, filename_time) pairs
        missing: list[Path] = []
        timestamp_probe_cache: dict[Path, Any] = {}
        for f in analyze_targets:
            probe = original_by_staged.get(f, f)
            try:
                mt = _dt.fromtimestamp(_os.path.getmtime(probe))
                mtime_map[f] = mt
            except OSError:
                mt = None
            ts = parse_timestamp_from_filename(probe.name)
            if ts is not None:
                file_first_times[f] = ts
                if mt is not None:
                    anchored.append((mt, ts))
            else:
                missing.append(f)

        if missing:
            unresolved: list[Path] = []
            logger.info(f"  OCR resolving timestamps for {len(missing)} file(s) without filename time")
            for f in missing:
                probe = original_by_staged.get(f, f)
                try:
                    if probe in timestamp_probe_cache:
                        fts = timestamp_probe_cache[probe]
                    else:
                        dur = probe_duration_sec(probe)
                        fts = extract_file_timestamps(probe, dur, timestamp_crop=ts_crop_cfg) if dur > 0 else None
                        timestamp_probe_cache[probe] = fts
                except Exception as exc:  # noqa: BLE001
                    logger.warn(f"  [OCR anchor] {probe.name}: failed ({exc})")
                    fts = None
                if fts is not None and fts.first_time is not None:
                    file_first_times[f] = fts.first_time
                    fmt = "%Y-%m-%d %H:%M:%S" if fts.first_time.year > 2000 else "%H:%M:%S"
                    logger.info(
                        f"  [OCR anchor] {probe.name}: {fts.first_time.strftime(fmt)} "
                        f"(conf={fts.confidence:.0%})"
                    )
                else:
                    unresolved.append(f)
            missing = unresolved

        # For each missing file, find its two nearest neighbors by mtime
        # among anchored files, then linearly interpolate its recording time.
        # This preserves relative ordering even if global mtime offset varies.
        if missing and anchored:
            anchored.sort(key=lambda x: x[0])
            for f in missing:
                if f not in mtime_map:
                    continue
                mt = mtime_map[f]
                # Find neighbors
                before = None
                after = None
                for a_mt, a_ts in anchored:
                    if a_mt <= mt:
                        before = (a_mt, a_ts)
                    elif after is None:
                        after = (a_mt, a_ts)
                        break
                if before is not None and after is not None:
                    # Interpolate linearly between two neighbors
                    span_mt = (after[0] - before[0]).total_seconds()
                    span_ts = (after[1] - before[1]).total_seconds()
                    if span_mt > 0:
                        frac = (mt - before[0]).total_seconds() / span_mt
                        est = before[1] + _td(seconds=frac * span_ts)
                    else:
                        est = before[1]
                elif before is not None:
                    # Only earlier anchor; project forward by offset.
                    est = mt - (before[0] - before[1])
                elif after is not None:
                    # Only later anchor; project backward by offset.
                    est = mt - (after[0] - after[1])
                else:
                    est = mt
                file_first_times[f] = est
            logger.info(
                f"  mtime neighbor interp for {len(missing)}  file(s) "
                f"({len(anchored)} anchor point(s))"
            )
        elif missing:
            for f in missing:
                if f in mtime_map:
                    file_first_times[f] = mtime_map[f]
            logger.info(f"  Using pure mtime for {len(missing)} file(s) (no filename baseline)")

        original_order = {f: i for i, f in enumerate(analyze_targets)}
        ordered_targets = sorted(
            analyze_targets,
            key=lambda f: (
                file_first_times.get(f) is None,
                file_first_times.get(f) or _dt.max,
                source_start_by_staged.get(f, 0.0),
                original_order.get(f, 0),
            ),
        )
        if ordered_targets != analyze_targets:
            logger.info(
                "  [OCR order] reordered inputs: "
                + " -> ".join(original_by_staged.get(f, f).name for f in ordered_targets)
            )

        if source_clips and manual_intro_override is not None:
            body_files = [f for f in ordered_targets if f != intro_path]
            logger.info(
                "  Source EDL + timeline title: body = "
                f"{len(body_files)} manual range clip(s)"
            )
        else:
            intro_time = file_first_times.get(intro_path)
            if intro_time is not None:
                body_files = [
                    f for f in ordered_targets
                    if f != intro_path
                    and file_first_times.get(f) is not None
                    and file_first_times[f] >= intro_time
                ]
                logger.info(
                    f"  intro {intro_path.name} @ {intro_time.strftime('%H:%M:%S')}, "
                    f"body = {len(body_files)} file(s) (timestamps >= intro)"
                )
            else:
                intro_idx = next(
                    (i for i, f in enumerate(ordered_targets) if f == intro_path),
                    -1,
                )
                body_files = [
                    f for i, f in enumerate(ordered_targets)
                    if i > intro_idx and f != intro_path
                ]
                logger.info(f"  Timestamps unknown - falling back to filename order: body = {len(body_files)} file(s)")
        if body_whitelist is not None:
            before = len(body_files)
            body_files = [p for p in body_files if p.name in body_whitelist]
            logger.info(
                f"  body_files filter applied: {len(body_files)}/{before} file(s)"
            )

        if not body_files and intro_path is None:
            logger.error("No body files available.")
            return 3

        # -- End-of-report boundary detection (low-weight safety net) --
        # Scan body files in reverse order for the LAST end-report cluster.
        # Safety: if the resulting body would be shorter than MIN_BODY_MIN
        # minutes of source material, abort the END cut (likely false
        # positive; real dive reports produce non-trivial content).
        MIN_BODY_MIN = 20.0  # below this, assume END was misdetected

        end_cut_file: Path | None = None
        end_cut_time: float | None = None
        for f in reversed(body_files):
            # Use word_raw (lightly filtered) for END detection so that
            # aggressive hallucination filter doesn't strip legitimate
            # END phrases (observed on SAKIZAYA file 6 where "bring the
            # propeller" was being filtered out).
            words = word_raw.get(f, []) or word_only.get(f, [])
            boundary = detect_end_report_boundary(words)
            if boundary is not None:
                end_cut_file = f
                end_cut_time = boundary
                break

        if end_cut_file is not None:
            cut_idx = body_files.index(end_cut_file)
            is_last_body = (cut_idx == len(body_files) - 1)

            # Only apply safety threshold when END would DROP subsequent
            # files. If END is in the last body file, nothing is dropped
            # only intra-file tail truncation, which is always safe.
            if not is_last_body:
                retained = body_files[: cut_idx + 1]
                est_sec = 0.0
                for f in retained:
                    dur = probe_duration_sec(f)
                    if f == end_cut_file:
                        est_sec += min(dur, end_cut_time + 5.0)
                    else:
                        est_sec += dur
                est_min = est_sec / 60.0
                if est_min < MIN_BODY_MIN:
                    logger.info(
                        f"  [END detect] candidate {end_cut_file.name} @ {end_cut_time:.0f}s "
                        f"is too early; estimated body {est_min:.1f} min < {MIN_BODY_MIN:.0f} min. "
                        f"Treating it as a false positive and keeping the full body."
                    )
                    end_cut_file = None
                    end_cut_time = None

        if end_cut_file is not None:
            cut_idx = body_files.index(end_cut_file)
            dropped = body_files[cut_idx + 1:]
            body_files = body_files[: cut_idx + 1]
            keep_until = end_cut_time + 5.0
            for target_dict in (word_only, word_raw):
                if end_cut_file in target_dict:
                    target_dict[end_cut_file] = [
                        w for w in target_dict[end_cut_file] if w[0] <= keep_until
                    ]
            logger.info(
                f"  [END detect] {end_cut_file.name} @ {end_cut_time:.0f}s - "
                f"dropped {len(dropped)} following file(s) plus this file tail"
            )
        else:
            logger.info("  [END detect] no trim triggered, keeping full body")

        # Step 3: source metadata + OCR timestamp sanity check.
        relevant_files = [intro_path] + body_files
        logger.step(3, 5, f"OCR timestamp check {len(relevant_files)} video(s)")
        body_timelines = [
            FileTimeline(file=f, fps=0.0, duration_sec=probe_duration_sec(f))
            for f in relevant_files
        ]

        # OCR timestamps
        t0 = time.time()
        file_timestamps = []
        for tl in body_timelines:
            fts = extract_file_timestamps(
                Path(tl.file), tl.duration_sec,
                timestamp_crop=ts_crop_cfg,
            )
            file_timestamps.append(fts)
            if fts.first_time:
                fmt = "%H:%M:%S" if fts.first_time.year <= 2000 else "%Y-%m-%d %H:%M:%S"
                t1 = fts.first_time.strftime(fmt)
                t2 = fts.last_time.strftime(fmt) if fts.last_time else "?"
                logger.info(
                    f"  [OCR] {Path(tl.file).name}: {t1} -> {t2}"
                    f"  (conf={fts.confidence:.0%})"
                )
        stage_times["ocr"] = time.time() - t0

        known_intro = intro_path
        violations = check_monotonicity(file_timestamps, intro_file=known_intro)
        if violations:
            for a, b, reason in violations:
                logger.info(f"  [OCR WARN] timestamp regression: {reason}")
        else:
            n_parsed = sum(1 for t in file_timestamps if t.first_time)
            logger.info(
                f"  [OCR] parsed timestamps for {n_parsed}/{len(file_timestamps)} file(s); "
                f"monotonicity check passed ({stage_times['ocr']:.1f}s)"
            )

        # -- Step 4: compute cover window from intro transcripts --
        intro_words = word_only.get(intro_path, [])
        if manual_intro_override is not None and intro_path == manual_intro_override[0]:
            _manual_intro_path, manual_start, manual_end = manual_intro_override
            speech = IntroSpeechWindow(
                start_sec=manual_start,
                end_sec=manual_end,
                source="manual_timeline_title",
                speech_start_sec=manual_start,
                transcript=" ".join(
                    text for ws, we, text in intro_words
                    if we >= manual_start and ws <= manual_end
                )[:240],
            )
        else:
            speech = locate_intro_speech_from_words(
                intro_words,
                cover_duration_sec=time_cfg.cover_duration_sec,
                lead_in_sec=time_cfg.intro_lead_in_sec,
                max_scan_sec=time_cfg.intro_audio_scan_sec,
                override=time_cfg.intro_speech_override,
                cover_lines=meta.cover_lines,
            )
        logger.info(
            f"  Cover window: {speech.start_sec:.1f}s -> {speech.end_sec:.1f}s "
            f"(duration={speech.duration:.1f}s, source={speech.source})"
        )
        logger.info(
            f"  First spoken word: {speech.speech_start_sec:.2f}s "
            f"(lead-in: {time_cfg.intro_lead_in_sec}s)"
        )
        if speech.transcript:
            logger.info(f"  cover-window transcript: {speech.transcript}")

        # -- Step 5: EDL with speech locks --
        logger.step(4, 5, "Generate EDL (with speech lock)")
        t0 = time.time()
        edl_body_timelines = [
            tl for tl in body_timelines
            if Path(tl.file) == intro_path or Path(tl.file) in body_files
        ]
        # Per-file END cut hard cap: prevents adaptive padding from extending
        # past the END boundary (which would re-include the work-assignment
        # chatter that END was specifically designed to exclude).
        end_cut_until_map: dict[str, float] = {}
        end_padding_cap_on = (getattr(args, "padding_end_cap", "on") == "on")
        if end_cut_file is not None and end_cut_time is not None and end_padding_cap_on:
            end_cut_until_map[str(end_cut_file)] = end_cut_time + 5.0
            logger.info(
                f"  [padding cap] {end_cut_file.name} segment tail cap = {end_cut_time + 5.0:.0f}s"
            )
        speech_lock_cfg = dict(config.get("speech_lock", {}) or {})
        edl = build_edl(
            intro_file=intro_path,
            intro_speech_start=speech.start_sec,
            intro_speech_end=speech.end_sec,
            body_timelines=edl_body_timelines,
            time_config=time_cfg,
            transcripts=word_only,
            raw_transcripts=word_raw,
            end_cut_until_by_file=end_cut_until_map,
            speech_lock_cfg=speech_lock_cfg,
            file_transcripts=full_transcripts,
            logger=logger,
        )
        if source_clips:
            remap_edl_to_sources(edl, source_clips)
            logger.info("  Source EDL: final EDL remapped back to original source files")
        stage_times["edl"] = time.time() - t0
        n_protected = sum(1 for s in edl.body_segments if s.protected)
        logger.info(
            f"  raw_body={edl.raw_body_duration_sec/60:.1f}m  "
            f"final_body={edl.actual_body_duration_sec/60:.1f}m  "
            f"target={edl.target_duration_sec/60:.0f}m  "
            f"padding={edl.adaptive_padding_sec:.1f}s  "
            f"segs={len(edl.body_segments)} ({n_protected} protected)"
        )
        edl.save(edl_path)
        logger.info(f"  EDL saved to {edl_path}")

        # Baseline = pipeline output frozen as a read-only deepest-undo target.
        # User-side edits never touch this file; UI's super-undo can always
        # walk back here even after history.json is wiped or corrupted.
        # Wiping history.json on every pipeline finish prevents the old undo
        # chain from resurrecting outdated segments after a re-run.
        from .utils.paths import edl_baseline_path as _ebp, edl_history_path as _ehp
        try:
            _ebp(job_folder).write_text(edl_path.read_text(encoding="utf-8"), encoding="utf-8")
            try:
                _ehp(job_folder).unlink()
            except FileNotFoundError:
                pass
        except OSError as e:
            logger.info(f"  [warn] baseline/history write skipped: {e}")

        output_path = paths["output"] / build_output_name(meta.job_no, meta.vessel)

    # -- Step 4: Render --
    if getattr(args, "no_render", False) or getattr(args, "skip_render", False):
        flag = "--no-render" if getattr(args, "no_render", False) else "--skip-render"
        logger.info(f"{flag}: skipping ffmpeg render")
        logger.info(
            f"  [A/B metrics] raw_body={edl.raw_body_duration_sec/60:.2f}m  "
            f"final_body={edl.actual_body_duration_sec/60:.2f}m  "
            f"segs={len(edl.body_segments)}"
        )
        return 0
    logger.step(5, 5, "ffmpeg render (auto NVENC/libx264)")
    t0 = time.time()
    # overlay_enabled=False skips title, watermark, and logo overlays.
    overlay_on = bool(getattr(meta, "overlay_enabled", True))
    result = render(
        edl=edl,
        output_path=output_path,
        cover_lines=meta.cover_lines if overlay_on else [],
        small_lines=meta.small_lines if overlay_on else [],
        config=config,
        log_path=paths["logs"] / "ffmpeg.log",
        job_folder=job_folder,
        cover_overlay=meta.cover_overlay.to_dict() if meta.cover_overlay else None,
        small_overlay=meta.small_overlay.to_dict() if meta.small_overlay else None,
        logo_overlay=meta.logo_overlay.to_dict() if meta.logo_overlay else None,
        overlay_enabled=overlay_on,
        status_callback=logger.info,
    )
    stage_times["render"] = time.time() - t0
    if result.return_code != 0:
        logger.error(f"ffmpeg failed (rc={result.return_code})")
        logger.error(result.log_tail)
        return result.return_code
    logger.info(
        f"  Render complete (encoder={result.encoder_used}, "
        f"time={stage_times['render']:.1f}s, "
        f"output duration ~ {result.duration_sec/60:.1f}m)"
    )
    logger.info(f"  Output: {output_path}")

    # Post-run *_report.md generation removed; the rendered video and
    # the EDL on disk together are the deliverables; the markdown
    # report was internal-only and the user no longer needs it.
    return 0


def main() -> int:
    args = parse_args()
    config = load_config(args.config)

    banner("Dive Video Auto-Editor")

    job_folder = resolve_job_folder(args)
    if job_folder is None or not job_folder.exists():
        return 1

    meta = gather_metadata(job_folder, args, config)
    if meta is None:
        return 1
    overlay_on = bool(getattr(meta, "overlay_enabled", True))
    if overlay_on and not args.skip_render and not meta.cover_lines:
        print("Warning: cover_lines is empty, cannot render.")
        return 1

    # Self-heal: UI saves job.yaml with cover_lines only; auto-derive
    # small_lines / job_no / vessel from cover_lines when missing.
    changed = False
    if not meta.small_lines:
        meta.small_lines = metadata.derive_small_lines(meta.cover_lines)
        print(f"  [auto-generated] small_lines ({len(meta.small_lines)}  line(s))")
        changed = True
    if not meta.job_no:
        extracted = metadata.extract_job_no(meta.cover_lines)
        if extracted:
            meta.job_no = extracted
            print(f"  [auto-extracted] job_no = {meta.job_no}")
            changed = True
    if not meta.vessel:
        extracted = metadata.extract_vessel(meta.cover_lines)
        if extracted:
            meta.vessel = extracted
            print(f"  [auto-extracted] vessel = {meta.vessel}")
            changed = True
    if changed:
        metadata.save(job_folder, meta)
    # intro_file can be empty; the pipeline will auto-detect it after transcription.

    paths = ensure_job_subdirs(job_folder)
    logger = JobLogger(log_file=paths["logs"] / "run.log")
    perf_monitor = PipelinePerfMonitor(paths["logs"] / "perf.jsonl")
    try:
        perf_monitor.start()
        banner("Starting...")
        rc = run_pipeline(
            job_folder=job_folder, meta=meta,
            config=config, logger=logger, args=args,
        )
        if rc == 0:
            print()
            banner("Done")
        return rc
    finally:
        perf = perf_monitor.stop()
        logger.info(
            "Performance: "
            f"peak RAM {perf['peak_rss_mb']}MB | "
            f"min free RAM {perf['min_available_ram_mb']}MB | "
            f"CPU avg {perf['avg_process_cpu_percent']}% "
            f"(system {perf['avg_system_cpu_percent']}%) | "
            f"GPU VRAM peak {perf['peak_gpu_vram_mb']}MB | "
            f"samples {perf['samples']}"
        )
        logger.close()


if __name__ == "__main__":
    import traceback
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("\n\nCancelled.")
        sys.exit(130)
    except Exception:
        print("\n\n" + "=" * 50)
        print("Unhandled exception:")
        print("=" * 50)
        traceback.print_exc()
        print("=" * 50)
        # Only pause for keypress when run from a real terminal. Under the
        # webui runner this is a piped subprocess (stdin=DEVNULL or inherited
        # NUL) and input() either EOFs or blocks on some Windows configurations,
        # blocks indefinitely, making the failure look like a hang instead of
        # an error.
        if sys.stdin and sys.stdin.isatty():
            try:
                input("\nPress Enter to close this window...")
            except EOFError:
                pass
        sys.exit(2)
