"""Post-render markdown report.

Answers the question "what did the tool actually cut / keep, and why?" so
the user can spot-check decisions without scrubbing through the 45-minute
final video. Tables are used throughout because bulleted YAML proved hard
to scan; a table you can eyeball the hull vs surface split per file in
one glance.
"""
from __future__ import annotations
from collections import defaultdict
from pathlib import Path
from typing import Any

from .analyze.audio import IntroSpeechWindow
from .analyze.edl import EDL, Segment
from .analyze.timeline import FileTimeline
from .metadata import JobMeta


def _fmt_time(sec: float) -> str:
    sec = max(0.0, float(sec))
    h = int(sec // 3600)
    m = int((sec % 3600) // 60)
    s = sec - 60 * int(sec // 60)
    if h:
        return f"{h:d}:{m:02d}:{s:05.2f}"
    return f"{m:d}:{s:05.2f}"


def _fmt_range(start: float, end: float) -> str:
    return f"{_fmt_time(start)} -> {_fmt_time(end)}  ({_fmt_time(max(0.0, end-start))})"


def write_report(
    *,
    job_folder: Path,
    output_path: Path,
    meta: JobMeta,
    speech: IntroSpeechWindow,
    body_timelines: list[FileTimeline],
    edl: EDL,
    raw_total_sec: float,
    encoded_duration_sec: float,
    stage_times_sec: dict[str, float],
) -> Path:
    report_path = output_path.with_name(output_path.stem + "_report.md")
    # Clean up any stale YAML report from previous versions.
    legacy_yaml = output_path.with_name(output_path.stem + "_report.yaml")
    if legacy_yaml.exists():
        try:
            legacy_yaml.unlink()
        except OSError:
            pass

    kept_by_file: dict[str, list[Segment]] = defaultdict(list)
    for seg in edl.body_segments:
        kept_by_file[seg.file].append(seg)


    lines: list[str] = []
    lines.append(f"# Dive Edit Report — {meta.job_no} / {meta.vessel}")
    lines.append("")

    # ── Job ──
    lines.append("## Job")
    lines.append("")
    lines.append("| Field | Value |")
    lines.append("|---|---|")
    lines.append(f"| Job No. | {meta.job_no} |")
    lines.append(f"| Vessel | {meta.vessel} |")
    lines.append(f"| Target duration | {meta.target_duration_min} min |")
    lines.append(f"| Intro file | `{meta.intro_file}` |")
    lines.append(f"| Output file | `{output_path.name}` |")
    lines.append(f"| Encoded duration | **{_fmt_time(encoded_duration_sec)}** |")
    lines.append("")

    # ── Timing ──
    if stage_times_sec:
        lines.append("## Pipeline timing")
        lines.append("")
        lines.append("| Stage | Seconds |")
        lines.append("|---|---:|")
        for name, sec in stage_times_sec.items():
            lines.append(f"| {name} | {sec:.1f} |")
        total = sum(stage_times_sec.values())
        lines.append(f"| **total** | **{total:.1f}** |")
        lines.append("")

    # ── Intro speech ──
    lines.append("## Intro speech window (cover overlay duration)")
    lines.append("")
    lines.append("| Field | Value |")
    lines.append("|---|---|")
    lines.append(f"| Start | {_fmt_time(speech.start_sec)} |")
    lines.append(f"| End | {_fmt_time(speech.end_sec)} |")
    lines.append(f"| Duration | **{_fmt_time(speech.duration)}** |")
    lines.append(f"| Detection source | `{speech.source}` |")
    if speech.matched_keywords:
        kws = ", ".join(f"`{k}`" for k in speech.matched_keywords)
        lines.append(f"| Matched keywords ({len(speech.matched_keywords)}) | {kws} |")
    lines.append("")
    if speech.transcript:
        lines.append("Transcript snippet:")
        lines.append("")
        lines.append("> " + speech.transcript.replace("\n", " "))
        lines.append("")

    # Per-file source summary
    lines.append("## Source files")
    lines.append("")
    lines.append("| # | File | Duration |")
    lines.append("|---:|---|---:|")
    for i, tl in enumerate(body_timelines, start=1):
        lines.append(f"| {i} | `{tl.file.name}` | {_fmt_time(tl.duration_sec)} |")
    lines.append("")

    # ── Compression summary ──
    lines.append("## Speech-lock compression")
    lines.append("")
    lines.append("| Stage | Duration |")
    lines.append("|---|---:|")
    lines.append(f"| Raw source total | {_fmt_time(raw_total_sec)} |")
    lines.append(
        f"| After speech-lock selection | **{_fmt_time(edl.actual_body_duration_sec)}** |"
    )
    lines.append(f"| Target | {_fmt_time(edl.target_duration_sec)} |")
    lines.append(f"| Final body segment count | {len(edl.body_segments)} |")
    if raw_total_sec > 0:
        ratio_pct = edl.actual_body_duration_sec / raw_total_sec * 100.0
        lines.append(f"| Compression vs raw | {ratio_pct:.1f}% |")
    lines.append("")

    report_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return report_path
