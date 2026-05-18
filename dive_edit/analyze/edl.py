"""Edit Decision List builder.

Consumes Whisper speech locks to produce a JSON-serializable list of segments
for the renderer.
"""
from __future__ import annotations
import json
import os
from dataclasses import dataclass, asdict, field
from pathlib import Path
from typing import Any

from .audio import FileTranscript

from .timeline import FileTimeline
from ..render.time_config import TimeConfig


@dataclass
class Segment:
    file: str           # absolute or relative path
    start: float        # seconds within source file
    end: float
    label: str
    score: float = 0.0  # higher = more "inspection-like"
    protected: bool = False  # True if this segment overlaps a speech lock

    @property
    def duration(self) -> float:
        return max(0.0, self.end - self.start)


_INTRO_LABEL = "INTRO"


def _segment_from_dict(raw: dict[str, Any], *, fallback_label: str | None = None) -> Segment | None:
    """Convert persisted JSON into a Segment, tolerating older sparse files."""
    try:
        file = str(raw.get("file", ""))
        start = float(raw.get("start", 0.0))
        end = float(raw.get("end", 0.0))
    except (TypeError, ValueError):
        return None
    if not file or end <= start:
        return None
    label = str(raw.get("label") or fallback_label or "HULL")
    try:
        score = float(raw.get("score", 0.0))
    except (TypeError, ValueError):
        score = 0.0
    return Segment(
        file=file,
        start=start,
        end=end,
        label=label,
        score=score,
        protected=bool(raw.get("protected", False)),
    )


def _segments_from_json(data: dict[str, Any]) -> list[Segment]:
    if isinstance(data.get("segments"), list):
        out: list[Segment] = []
        for raw in data.get("segments", []):
            if isinstance(raw, dict):
                seg = _segment_from_dict(raw)
                if seg is not None:
                    out.append(seg)
        return out

    # Legacy schema before the 2026-05-13 intro merge:
    # intro_file + intro_speech_start/end + body_segments.
    out: list[Segment] = []
    intro_file = str(data.get("intro_file") or "")
    try:
        intro_start = float(data.get("intro_speech_start", 0.0))
        intro_end = float(data.get("intro_speech_end", 0.0))
    except (TypeError, ValueError):
        intro_start = intro_end = 0.0
    if intro_file and intro_end > intro_start:
        out.append(Segment(
            file=intro_file,
            start=intro_start,
            end=intro_end,
            label=_INTRO_LABEL,
            score=0.0,
            protected=True,
        ))
    for raw in data.get("body_segments", []) or []:
        if isinstance(raw, dict):
            seg = _segment_from_dict(raw)
            if seg is not None:
                out.append(seg)
    return out


@dataclass
class EDL:
    """Unified segment list.

    INTRO segments come first (cover/title period), then body segments.
    This replaces the old intro_file + intro_speech_* split.
    """
    segments: list[Segment] = field(default_factory=list)
    target_duration_sec: float = 0.0
    actual_body_duration_sec: float = 0.0  # sum of non-INTRO durations
    raw_body_duration_sec: float = 0.0
    adaptive_padding_sec: float = 0.0

    @property
    def intro_segments(self) -> list[Segment]:
        return [s for s in self.segments if s.label == _INTRO_LABEL]

    @property
    def body_segments(self) -> list[Segment]:
        return [s for s in self.segments if s.label != _INTRO_LABEL]

    @property
    def intro_duration_sec(self) -> float:
        return sum(s.duration for s in self.intro_segments)

    @property
    def intro_file(self) -> str:
        """First INTRO segment's file path, or '' if no intro."""
        intros = self.intro_segments
        return intros[0].file if intros else ""

    @property
    def intro_speech_start(self) -> float:
        intros = self.intro_segments
        return intros[0].start if intros else 0.0

    @property
    def intro_speech_end(self) -> float:
        intros = self.intro_segments
        return intros[0].end if intros else 0.0

    def to_json(self) -> dict[str, Any]:
        return {
            "segments": [asdict(s) for s in self.segments],
            "target_duration_sec": self.target_duration_sec,
            "actual_body_duration_sec": self.actual_body_duration_sec,
            "raw_body_duration_sec": self.raw_body_duration_sec,
            "adaptive_padding_sec": self.adaptive_padding_sec,
        }

    def save(self, path: Path) -> None:
        with path.open("w", encoding="utf-8") as f:
            json.dump(self.to_json(), f, indent=2, ensure_ascii=False)

    @classmethod
    def load(cls, path: Path) -> "EDL":
        data = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            raise ValueError("EDL JSON root must be an object")
        edl = cls(
            target_duration_sec=float(data.get("target_duration_sec", 0)),
            actual_body_duration_sec=float(data.get("actual_body_duration_sec", 0)),
            raw_body_duration_sec=float(data.get("raw_body_duration_sec", 0)),
            adaptive_padding_sec=float(data.get("adaptive_padding_sec", 0)),
        )
        edl.segments = _segments_from_json(data)
        return edl


# ── Segment merging from per-second samples ────────────────────

def _overlaps_any_window(
    seg_start: float,
    seg_end: float,
    windows: list[tuple[float, float]],
) -> bool:
    for ws, we in windows:
        if seg_start < we and seg_end > ws:
            return True
    return False


def find_speech_bursts(
    words: list[tuple[float, float, str]],
    *,
    gap_sec: float = 3.0,
    min_burst_sec: float = 0.5,
) -> list[tuple[float, float]]:
    """Group consecutive Whisper words into speech bursts."""
    clean_words = [(ws, we, wt) for ws, we, wt in words if wt.strip()]
    if not clean_words:
        return []

    bursts: list[tuple[float, float]] = []
    cur_start = clean_words[0][0]
    cur_end = clean_words[0][1]
    for ws, we, _wt in clean_words[1:]:
        if ws - cur_end <= gap_sec:
            cur_end = max(cur_end, we)
            continue
        if cur_end - cur_start >= min_burst_sec:
            bursts.append((cur_start, cur_end))
        cur_start = ws
        cur_end = we
    if cur_end - cur_start >= min_burst_sec:
        bursts.append((cur_start, cur_end))
    return bursts


def _calc_dynamic_pad(
    burst_start: float,
    burst_end: float,
    words: list[tuple[float, float, str]],
    word_prob: list[float] | None,
    word_no_speech_prob: list[float] | None,
    *,
    pre_pad_default: float = 5.0,
    pre_pad_max: float = 12.0,
    post_pad_default: float = 3.0,
    post_pad_max: float = 8.0,
    high_risk_no_speech_prob: float = 0.7,
    low_confidence_word_prob: float = 0.4,
    bonus_high_risk: float = 5.0,
    bonus_sentence_break: float = 3.0,
) -> tuple[float, float, str]:
    """Calculate per-burst dynamic pre/post padding.

    Returns (pre_pad, post_pad, reason_tag) based on confidence signals
    of the first and last words in the burst.

    ``word_prob`` and ``word_no_speech_prob`` are parallel lists aligned
    to ``words``.  Either or both may be None / empty — the function
    gracefully falls back to the defaults in that case.
    """
    # Gather words that belong to this burst (by overlap with [burst_start, burst_end])
    burst_words: list[int] = []
    for i, (ws, we, _wt) in enumerate(words):
        if ws >= burst_start - 0.1 and we <= burst_end + 0.1:
            burst_words.append(i)

    pre_pad = pre_pad_default
    post_pad = post_pad_default
    reasons: list[str] = []

    if burst_words:
        first_idx = burst_words[0]
        last_idx = burst_words[-1]
        first_text = words[first_idx][2].strip()
        last_text = words[last_idx][2].strip()

        # ── pre_pad: look at first word ──
        first_nsp = (
            word_no_speech_prob[first_idx]
            if word_no_speech_prob and first_idx < len(word_no_speech_prob)
            else 0.0
        )
        first_prob = (
            word_prob[first_idx]
            if word_prob and first_idx < len(word_prob)
            else 1.0
        )
        if first_nsp > high_risk_no_speech_prob or first_prob < low_confidence_word_prob:
            pre_pad = min(pre_pad + bonus_high_risk, pre_pad_max)
            reasons.append("pre:high_risk")
        # Sentence-break: first word is not capitalized or very short → mid-sentence
        if first_text and not first_text[0].isupper() and len(first_text) > 1:
            pre_pad = min(pre_pad + bonus_sentence_break, pre_pad_max)
            reasons.append("pre:mid_sentence")

        # ── post_pad: look at last word ──
        last_nsp = (
            word_no_speech_prob[last_idx]
            if word_no_speech_prob and last_idx < len(word_no_speech_prob)
            else 0.0
        )
        last_prob = (
            word_prob[last_idx]
            if word_prob and last_idx < len(word_prob)
            else 1.0
        )
        if last_nsp > high_risk_no_speech_prob or last_prob < low_confidence_word_prob:
            post_pad = min(post_pad + bonus_high_risk, post_pad_max)
            reasons.append("post:high_risk")
        # Sentence-break: last word doesn't end with sentence-terminal punctuation
        if last_text and last_text[-1] not in ".!?,":
            post_pad = min(post_pad + bonus_sentence_break, post_pad_max)
            reasons.append("post:mid_sentence")
    else:
        # No words found in burst (e.g. RMS-injected burst) — use defaults
        reasons.append("no_words")

    reason_str = "+".join(reasons) if reasons else "default"
    return (pre_pad, post_pad, reason_str)


def lock_bursts(
    bursts: list[tuple[float, float]],
    *,
    padding_sec: float = 5.0,
    file_duration: float | None = None,
    bridge_gap_sec: float = 0.0,
    # Dynamic padding inputs (all optional — if None, falls back to padding_sec)
    words: list[tuple[float, float, str]] | None = None,
    word_prob: list[float] | None = None,
    word_no_speech_prob: list[float] | None = None,
    dynamic_cfg: dict | None = None,
    logger: "Any | None" = None,
    file_label: str = "",
) -> list[tuple[float, float]]:
    """Pad each burst by ``padding_sec`` on each side and merge overlaps.

    If ``file_duration`` is given, the end of each locked window is
    clamped to it.

    If ``bridge_gap_sec`` > 0, adjacent lock windows separated by a gap
    smaller than this threshold are merged. This eliminates jarring
    micro-jumps between close speech segments while preserving
    intentional scene skips at larger gaps.

    Dynamic padding: when ``dynamic_cfg`` is provided and
    ``dynamic_cfg["enabled"]`` is True, each burst gets an individually
    calculated pre/post padding via ``_calc_dynamic_pad`` instead of the
    fixed ``padding_sec``.  The fixed ``padding_sec`` is used as the
    fallback default for both pre and post.
    """
    if not bursts:
        return []

    use_dynamic = bool(
        dynamic_cfg and dynamic_cfg.get("enabled", False)
        and words is not None
    )

    locked: list[tuple[float, float]] = []
    for s, e in bursts:
        if use_dynamic:
            assert dynamic_cfg is not None
            pre, post, reason = _calc_dynamic_pad(
                s, e,
                words=words or [],  # type: ignore[arg-type]
                word_prob=word_prob,
                word_no_speech_prob=word_no_speech_prob,
                pre_pad_default=float(dynamic_cfg.get("pre_pad_default", padding_sec)),
                pre_pad_max=float(dynamic_cfg.get("pre_pad_max", 12.0)),
                post_pad_default=float(dynamic_cfg.get("post_pad_default", 3.0)),
                post_pad_max=float(dynamic_cfg.get("post_pad_max", 8.0)),
                high_risk_no_speech_prob=float(dynamic_cfg.get("high_risk_no_speech_prob", 0.7)),
                low_confidence_word_prob=float(dynamic_cfg.get("low_confidence_word_prob", 0.4)),
                bonus_high_risk=float(dynamic_cfg.get("bonus_high_risk", 5.0)),
                bonus_sentence_break=float(dynamic_cfg.get("bonus_sentence_break", 3.0)),
            )
            if logger is not None:
                logger.info(
                    f"  [dynamic pad] {file_label}:{s:.1f}~{e:.1f} "
                    f"pre={pre:.1f}s post={post:.1f}s reason={reason}"
                )
        else:
            pre = padding_sec
            post = padding_sec

        ls = max(0.0, s - pre)
        le = e + post
        if file_duration is not None:
            le = min(le, file_duration)
        locked.append((ls, le))

    locked.sort()
    merged: list[tuple[float, float]] = [locked[0]]
    for s, e in locked[1:]:
        prev_s, prev_e = merged[-1]
        if s <= prev_e:
            merged[-1] = (prev_s, max(prev_e, e))
        else:
            merged.append((s, e))
    # Bridge small gaps: merge locks separated by ≤ bridge_gap_sec.
    # A 3s gap between two lock windows means 3s of footage is cut,
    # creating a visible micro-jump. Bridging includes that footage
    # for smooth continuity.
    if bridge_gap_sec > 0 and len(merged) > 1:
        bridged: list[tuple[float, float]] = [merged[0]]
        for s, e in merged[1:]:
            prev_s, prev_e = bridged[-1]
            if s - prev_e <= bridge_gap_sec:
                bridged[-1] = (prev_s, max(prev_e, e))
            else:
                bridged.append((s, e))
        merged = bridged
    return merged


def _find_adaptive_padding(
    file_bursts: dict[str, list[tuple[float, float]]],
    file_durations: dict[str, float],
    target_body_sec: float,
    min_pad: float = 2.0,
    max_pad: float = 30.0,
    bridge_gap_sec: float = 0.0,
) -> float:
    """Binary search for the padding_sec that fills closest to target_body_sec.

    Returns a padding value in [min_pad, max_pad]. If even max_pad can't
    reach the target, returns max_pad (caller accepts the shortfall).
    """
    def _total(pad: float) -> float:
        t = 0.0
        for fstr, bursts in file_bursts.items():
            locks = lock_bursts(
                bursts, padding_sec=pad,
                file_duration=file_durations.get(fstr),
                bridge_gap_sec=bridge_gap_sec,
            )
            t += sum(e - s for s, e in locks)
        return t

    if _total(max_pad) <= target_body_sec:
        return max_pad
    if _total(min_pad) >= target_body_sec:
        return min_pad

    lo, hi = min_pad, max_pad
    for _ in range(30):
        mid = (lo + hi) / 2
        if _total(mid) < target_body_sec:
            lo = mid
        else:
            hi = mid
        if hi - lo < 0.1:
            break
    return round((lo + hi) / 2, 1)


def _build_file_segments_with_locks(
    *,
    locks: list[tuple[float, float]],
    file_path: Path,
    file_duration: float,
) -> list[Segment]:
    """Create one protected body segment per speech-lock window."""
    out: list[Segment] = []
    for lk_start, lk_end in sorted(locks):
        start = max(0.0, lk_start)
        end = min(file_duration, lk_end)
        if end - start <= 0.05:
            continue
        out.append(Segment(
            file=str(file_path),
            start=start,
            end=end,
            label="HULL",
            score=0.0,
            protected=True,
        ))
    return out


def _normalize_segments(
    segments: list[Segment],
    *,
    file_index: dict[str, int] | None = None,
    epsilon_sec: float = 1e-3,
) -> list[Segment]:
    """Merge adjacent equivalent segments after all lock/window math."""
    index = file_index or {}
    ordered = sorted(segments, key=lambda s: (index.get(s.file, 9_999), s.start, s.end))
    merged: list[Segment] = []
    for seg in ordered:
        if seg.end <= seg.start:
            continue
        if merged:
            prev = merged[-1]
            if (
                prev.file == seg.file
                and prev.label == seg.label
                and prev.protected == seg.protected
                and seg.start <= prev.end + epsilon_sec
            ):
                merged[-1] = Segment(
                    file=prev.file,
                    start=prev.start,
                    end=max(prev.end, seg.end),
                    label=prev.label,
                    score=max(prev.score, seg.score),
                    protected=prev.protected,
                )
                continue
        merged.append(seg)
    return merged


# ── Tier 1 + Tier 3 ────────────────────────────────────────────

def build_edl(
    *,
    intro_file: Path,
    intro_speech_start: float,
    intro_speech_end: float,
    body_timelines: list[FileTimeline],
    time_config: TimeConfig,
    transcripts: dict[Path, list[tuple[float, float, str]]] | None = None,
    raw_transcripts: dict[Path, list[tuple[float, float, str]]] | None = None,
    end_cut_until_by_file: dict[str, float] | None = None,
    speech_lock_cfg: dict[str, Any] | None = None,
    file_transcripts: dict[Path, "FileTranscript"] | None = None,
    logger: "Any | None" = None,
) -> EDL:
    """Build the edit decision list.

    Layout (chronological):
      1. Intro cover segment  : intro_file [intro_speech_start, intro_speech_end]
                                 with cover overlay (handled by ffmpeg_runner)
      2. All files (including intro) go through speech-lock: only segments
         with diver narration (± padding) survive.

    When target_duration_min > 0, adaptive padding is computed to fill the
    edit to the requested duration. When target_duration_min = 0, the fixed
    padding_sec from config is used and the output is as long as the speech.
    """
    intro_file_str = str(intro_file)
    # Windows path comparison: file_bursts keys come from str(tl.file) which
    # may differ from intro_file_str in case / separator after Path
    # normalization. Use os.path.normcase to ensure robust matching.
    intro_file_key = os.path.normcase(intro_file_str)
    transcripts = transcripts or {}
    speech_lock_cfg = speech_lock_cfg or {}
    speech_lock_enabled = bool(speech_lock_cfg.get("enabled", True))

    lock_padding = float(speech_lock_cfg.get("padding_sec", 5.0))
    burst_gap = float(speech_lock_cfg.get("burst_silence_gap_sec", 3.0))
    min_burst = float(speech_lock_cfg.get("min_burst_duration_sec", 0.5))
    bridge_gap = float(speech_lock_cfg.get("bridge_gap_sec", lock_padding))

    # Dynamic padding config — None if not enabled or not present
    _dyn_raw = speech_lock_cfg.get("dynamic_padding", {}) or {}
    dynamic_cfg: dict[str, Any] | None = dict(_dyn_raw) if _dyn_raw.get("enabled", False) else None
    if dynamic_cfg is not None:
        # Ensure pre_pad_default aligns with lock_padding as the fallback
        dynamic_cfg.setdefault("pre_pad_default", lock_padding)

    file_transcripts = file_transcripts or {}

    target = float(time_config.target_sec)

    file_bursts: dict[str, list[tuple[float, float]]] = {}
    file_dur_map: dict[str, float] = {}
    for tl in body_timelines:
        fstr = str(tl.file)
        file_dur_map[fstr] = tl.duration_sec
        if not speech_lock_enabled:
            file_bursts[fstr] = []
            continue
        words = transcripts.get(tl.file, [])
        file_bursts[fstr] = find_speech_bursts(
            words,
            gap_sec=burst_gap,
            min_burst_sec=min_burst,
        ) if words else []

    # Expand burst boundaries with raw (unfiltered) words.
    raw_transcripts = raw_transcripts or {}
    for tl in body_timelines:
        fstr = str(tl.file)
        bursts = file_bursts.get(fstr, [])
        raw_words = raw_transcripts.get(tl.file, [])
        if not bursts or not raw_words:
            continue
        expanded: list[tuple[float, float]] = []
        for bs, be in bursts:
            new_s, new_e = bs, be
            for ws, we, _wt in raw_words:
                # Raw word just before burst start, within padding range
                if ws < bs and bs - ws <= lock_padding:
                    new_s = min(new_s, ws)
                # Raw word just after burst end, within padding range
                if we > be and we - be <= lock_padding:
                    new_e = max(new_e, we)
            expanded.append((new_s, new_e))
        file_bursts[fstr] = expanded

    # ── Step 1b: adaptive padding ──
    # When target > 0, compute the padding that fills the edit to
    # the requested duration. Otherwise use the fixed config value.
    cover_dur = max(0.0, intro_speech_end - intro_speech_start)

    if target > 0:
        target_body_sec = max(0.0, target - cover_dur)
        adaptive_padding = _find_adaptive_padding(
            file_bursts, file_dur_map, target_body_sec,
            min_pad=lock_padding, max_pad=30.0,
            bridge_gap_sec=bridge_gap,
        )
    else:
        adaptive_padding = lock_padding

    # ── Step 1c: apply padding to create lock windows ──
    end_cut_until_by_file = end_cut_until_by_file or {}
    file_locks: dict[str, list[tuple[float, float]]] = {}
    for fstr, bursts in file_bursts.items():
        # Prepare per-word confidence arrays for dynamic padding (if enabled).
        dyn_words: list[tuple[float, float, str]] | None = None
        dyn_word_prob: list[float] | None = None
        dyn_word_nsp: list[float] | None = None
        if dynamic_cfg is not None:
            # Prefer raw_transcripts for edge coverage; fall back to filtered words.
            ft_path = next(
                (p for p in file_transcripts if str(p) == fstr), None
            )
            ft = file_transcripts.get(ft_path) if ft_path is not None else None
            if ft is not None:
                dyn_words = ft.words
                dyn_word_prob = ft.word_prob if ft.word_prob else None
                # Build per-word no_speech_prob from segment-level nsp via word_seg_idx
                if ft.segments and ft.word_seg_idx:
                    nsp_by_seg = {s.idx: s.no_speech_prob for s in ft.segments}
                    dyn_word_nsp = [
                        nsp_by_seg.get(ft.word_seg_idx[i], 0.0)
                        for i in range(len(ft.words))
                    ]
            else:
                # Fall back to the filtered word list (no probability info)
                raw_path = next(
                    (p for p in (raw_transcripts or {}) if str(p) == fstr), None
                )
                dyn_words = (raw_transcripts or {}).get(raw_path) if raw_path else None

        locks = lock_bursts(
            bursts, padding_sec=adaptive_padding,
            file_duration=file_dur_map.get(fstr),
            bridge_gap_sec=bridge_gap,
            words=dyn_words,
            word_prob=dyn_word_prob,
            word_no_speech_prob=dyn_word_nsp,
            dynamic_cfg=dynamic_cfg,
            logger=logger,
            file_label=Path(fstr).name,
        )
        # END cut respect: padding must NOT extend past the END boundary.
        # END is a semantic content boundary (formal report ends here);
        # post-END speech is work-assignment chatter that should NOT be
        # protected by padding (per pipeline philosophy).
        end_cap = end_cut_until_by_file.get(fstr)
        if end_cap is not None:
            locks = [(s, min(e, end_cap)) for s, e in locks if s < end_cap]
            locks = [(s, e) for s, e in locks if e > s]
        # For the intro file, exclude the cover range (already a separate segment).
        if os.path.normcase(fstr) == intro_file_key:
            locks = [
                (max(s, intro_speech_end), e)
                for s, e in locks
                if e > intro_speech_end
            ]
            locks = [(s, e) for s, e in locks if e > s]
            if logger is not None:
                logger.info(
                    f"  [intro cover clamp] {Path(fstr).name} locks start >= "
                    f"{intro_speech_end:.1f}s ({len(locks)} segment(s))"
                )
        file_locks[fstr] = locks

    all_segments: list[Segment] = []
    file_index: dict[str, int] = {}
    for i, tl in enumerate(body_timelines):
        file_index[str(tl.file)] = i
        locks = file_locks.get(str(tl.file), [])
        all_segments.extend(_build_file_segments_with_locks(
            locks=locks,
            file_path=tl.file,
            file_duration=tl.duration_sec,
        ))

    kept = _normalize_segments(
        [s for s in all_segments if s.protected],
        file_index=file_index,
    )

    raw_total = sum(s.duration for s in kept)

    kept.sort(key=lambda s: (file_index.get(s.file, 9_999), s.start))

    actual_total = sum(s.duration for s in kept)

    # Intro segment becomes segments[0]; the remaining segments are body.
    intro_seg = Segment(
        file=str(intro_file),
        start=float(intro_speech_start),
        end=float(intro_speech_end),
        label="INTRO",
        score=0.0,
        protected=True,
    )
    return EDL(
        segments=[intro_seg, *kept],
        target_duration_sec=target,
        actual_body_duration_sec=actual_total,
        raw_body_duration_sec=raw_total,
        adaptive_padding_sec=adaptive_padding,
    )
