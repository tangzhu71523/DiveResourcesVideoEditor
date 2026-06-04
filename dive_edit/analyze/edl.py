"""Edit Decision List builder.

Consumes Whisper speech locks to produce a JSON-serializable list of segments
for the renderer.
"""
from __future__ import annotations
import json
import os
import queue
import re
import subprocess
import threading
import time
from collections import Counter
from dataclasses import dataclass, asdict, field
from difflib import SequenceMatcher
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
    lane_file: str | None = None

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
        lane_file=str(raw.get("lane_file") or "") or None,
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
        data = json.loads(path.read_text(encoding="utf-8-sig"))
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


def _canonical_speech_text(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", text.lower()).strip()


def _near_chunk_boundary(t: float, *, chunk_sec: float, tolerance_sec: float) -> bool:
    if chunk_sec <= 0:
        return False
    r = t % chunk_sec
    return r <= tolerance_sec or (chunk_sec - r) <= tolerance_sec


def _segment_text_is_repetitive(text: str) -> bool:
    tokens = _canonical_speech_text(text).split()
    if len(tokens) < 8:
        return False
    counts = Counter(tokens)
    most_common = counts.most_common(1)[0][1]
    return len(counts) <= 3 and (most_common / len(tokens)) >= 0.65


_DEFAULT_HALLUCINATION_BLACKLIST: tuple[str, ...] = (
    "thank you",
    "thank you very much",
    "thanks for watching",
    "welcome",
    "welcome back",
    "please subscribe",
    "subscribe",
    "like and subscribe",
    "see you next time",
    "bye bye",
    "music",
    "applause",
)


_DEFAULT_REPORT_WHITELIST: tuple[str, ...] = (
    "roger",
    "copy",
    "dive resources",
    "dive resource",
    "diver",
    "underwater",
    "inspection",
    "class inspection",
    "lr class inspection",
    "hull",
    "submerged",
    "bow",
    "bulbous bow",
    "side shell",
    "side shell plating",
    "port",
    "port side",
    "starboard",
    "starboard side",
    "startboard side",
    "bilge keel",
    "keel",
    "sea chest",
    "sea chest grating",
    "flat bottom",
    "bottom plating",
    "propeller",
    "rudder",
    "anode",
    "anchor",
    "chain",
    "marine growth",
    "damage",
    "anomaly",
    "anomalies",
    "observed",
    "condition",
    "good condition",
    "paint detachment",
    "client representative",
    "surveyor",
    "master",
    "vessel",
)


_DEFAULT_CONTENT_REFINE_TERMS: tuple[str, ...] = (
    "roger",
    "copy",
    "standby",
    "stop",
    "hold",
    "proceed",
    "view",
    "show",
    "move",
    "come",
    "go",
    "diver",
    "topside",
    "bottom",
    "level",
    "inspect",
    "inspection",
    "hull",
    "side shell",
    "starboard",
    "port",
    "bow",
    "stern",
    "bilge",
    "keel",
    "sea chest",
    "grating",
    "propeller",
    "rudder",
    "anode",
    "plate",
    "plating",
    "condition",
    "damage",
    "corrosion",
    "marine growth",
    "barnacle",
    "clean",
    "cleaning",
    "scrape",
    "scraping",
    "brush",
    "area",
    "growth",
    "plug",
    "plugging",
    "blank",
    "flange",
    "bolt",
    "valve",
    "seal",
    "leak",
    "leaking",
)


def _canonical_phrase_list(raw: Any, default: tuple[str, ...]) -> tuple[str, ...]:
    if raw is None:
        raw = default
    if isinstance(raw, str):
        raw = [raw]
    out: list[str] = []
    for item in raw or []:
        canon = _canonical_speech_text(str(item))
        if canon:
            out.append(canon)
    return tuple(out)


def _contains_canonical_phrase(canon_text: str, phrases: tuple[str, ...]) -> bool:
    padded = f" {canon_text} "
    return any(f" {phrase} " in padded for phrase in phrases)


def _collapse_runs(text: str) -> str:
    return re.sub(r"(.)\1+", r"\1", text)


def _phonetic_key(token: str) -> str:
    token = _canonical_speech_text(token).replace(" ", "")
    if len(token) <= 2:
        return token
    replacements = (
        ("ph", "f"),
        ("ght", "t"),
        ("tion", "shun"),
        ("ch", "sh"),
        ("ck", "k"),
        ("qu", "kw"),
        ("q", "k"),
        ("x", "ks"),
        ("c", "k"),
        ("z", "s"),
        ("v", "f"),
    )
    for src, dst in replacements:
        token = token.replace(src, dst)
    first = token[0]
    tail = re.sub(r"[aeiouy]+", "", token[1:])
    return first + _collapse_runs(tail)


def _pronounce_cfg(raw: Any) -> dict[str, Any]:
    raw = raw if isinstance(raw, dict) else {}
    return {
        "enabled": bool(raw.get("enabled", True)),
        "min_token_len": int(raw.get("min_token_len", 4)),
        "token_ratio": float(raw.get("token_ratio", 0.78)),
        "phonetic_ratio": float(raw.get("phonetic_ratio", 0.72)),
        "max_length_delta": int(raw.get("max_length_delta", 3)),
    }


def _tokens_near_pronounce(a: str, b: str, cfg: dict[str, Any]) -> bool:
    if a == b:
        return True
    if not bool(cfg.get("enabled", True)):
        return False
    min_len = int(cfg.get("min_token_len", 4))
    if min(len(a), len(b)) < min_len:
        return False
    if abs(len(a) - len(b)) > int(cfg.get("max_length_delta", 3)):
        return False
    if SequenceMatcher(None, a, b).ratio() >= float(cfg.get("token_ratio", 0.78)):
        return True
    a_key = _phonetic_key(a)
    b_key = _phonetic_key(b)
    if min(len(a_key), len(b_key)) < 3:
        return False
    return SequenceMatcher(None, a_key, b_key).ratio() >= float(cfg.get("phonetic_ratio", 0.72))


def _contains_pronounce_phrase(
    canon_text: str,
    phrases: tuple[str, ...],
    cfg: dict[str, Any],
) -> bool:
    if not bool(cfg.get("enabled", True)):
        return False
    tokens = canon_text.split()
    if not tokens:
        return False
    for phrase in phrases:
        wanted = phrase.split()
        if not wanted:
            continue
        if len(wanted) == 1:
            if any(_tokens_near_pronounce(token, wanted[0], cfg) for token in tokens):
                return True
            continue
        if len(tokens) < len(wanted):
            continue
        for start in range(0, len(tokens) - len(wanted) + 1):
            window = tokens[start:start + len(wanted)]
            if all(_tokens_near_pronounce(got, want, cfg) for got, want in zip(window, wanted)):
                return True
    return False


def _contains_phrase_signal(
    canon_text: str,
    phrases: tuple[str, ...],
    *,
    pronounce_cfg: dict[str, Any] | None = None,
) -> bool:
    if _contains_canonical_phrase(canon_text, phrases):
        return True
    if pronounce_cfg is None:
        return False
    return _contains_pronounce_phrase(canon_text, phrases, pronounce_cfg)


def _filter_hallucinated_words_for_locks(
    ft: FileTranscript | None,
    fallback_words: list[tuple[float, float, str]],
    cfg: dict[str, Any],
    *,
    logger: "Any | None" = None,
    file_label: str = "",
) -> list[tuple[float, float, str]]:
    """Remove Whisper hallucination segments before speech-lock grouping."""
    if not ft or not ft.words or not ft.segments or not ft.word_seg_idx:
        return fallback_words

    hcfg = cfg.get("hallucination_filter", {}) or {}
    if not bool(hcfg.get("enabled", True)):
        return fallback_words

    low_avg_logprob = float(hcfg.get("low_avg_logprob", -0.55))
    repeated_min = int(hcfg.get("repeated_text_min_count", 8))
    short_max_words = int(hcfg.get("short_segment_max_words", 3))
    short_max_sec = float(hcfg.get("short_segment_max_sec", 3.0))
    chunk_sec = float(hcfg.get("chunk_sec", 30.0))
    chunk_tol = float(hcfg.get("chunk_boundary_tolerance_sec", 1.5))
    blacklist = _canonical_phrase_list(
        hcfg.get("blacklist_phrases"),
        _DEFAULT_HALLUCINATION_BLACKLIST,
    )
    whitelist = _canonical_phrase_list(
        hcfg.get("whitelist_phrases"),
        _DEFAULT_REPORT_WHITELIST,
    )
    pronounce_cfg = _pronounce_cfg(hcfg.get("pronounce_match"))

    seg_text_counts: Counter[str] = Counter()
    for seg in ft.segments:
        canon = _canonical_speech_text(seg.text)
        if not canon:
            continue
        words = canon.split()
        dur = max(0.0, seg.end - seg.start)
        if len(words) <= short_max_words and dur <= short_max_sec:
            seg_text_counts[canon] += 1

    repeated_short = {
        text for text, count in seg_text_counts.items()
        if count >= repeated_min
    }

    drop_seg_idx: set[int] = set()
    drop_reasons: Counter[str] = Counter()
    whitelist_protected = 0
    for seg in ft.segments:
        canon = _canonical_speech_text(seg.text)
        if not canon:
            continue
        words = canon.split()
        dur = max(0.0, seg.end - seg.start)
        is_short = len(words) <= short_max_words and dur <= short_max_sec
        low_conf = seg.avg_logprob <= low_avg_logprob
        at_chunk_edge = (
            _near_chunk_boundary(seg.start, chunk_sec=chunk_sec, tolerance_sec=chunk_tol)
            or _near_chunk_boundary(seg.end, chunk_sec=chunk_sec, tolerance_sec=chunk_tol)
        )
        repeated_chunk_phrase = canon in repeated_short and is_short and (low_conf or at_chunk_edge)
        repeated_loop = _segment_text_is_repetitive(seg.text)
        compression_bad = seg.compression_ratio >= 2.4
        blacklist_hit = _contains_canonical_phrase(canon, blacklist)
        whitelist_hit = _contains_phrase_signal(
            canon,
            whitelist,
            pronounce_cfg=pronounce_cfg,
        )
        if blacklist_hit:
            drop_seg_idx.add(seg.idx)
            drop_reasons["blacklist"] += 1
        elif whitelist_hit and (repeated_chunk_phrase or repeated_loop or compression_bad):
            whitelist_protected += 1
        elif repeated_chunk_phrase or repeated_loop or compression_bad:
            drop_seg_idx.add(seg.idx)
            if repeated_chunk_phrase:
                drop_reasons["repeated_short"] += 1
            elif repeated_loop:
                drop_reasons["repeated_loop"] += 1
            else:
                drop_reasons["compression"] += 1

    if not drop_seg_idx:
        return fallback_words

    filtered = [
        word for i, word in enumerate(ft.words)
        if i >= len(ft.word_seg_idx) or ft.word_seg_idx[i] not in drop_seg_idx
    ]
    if logger is not None:
        reason_text = ", ".join(f"{k}={v}" for k, v in sorted(drop_reasons.items()))
        if whitelist_protected:
            reason_text = (reason_text + ", " if reason_text else "") + f"whitelist_protected={whitelist_protected}"
        logger.info(
            f"  [speech filter] {file_label}: removed "
            f"{len(ft.words) - len(filtered)} hallucinated word(s) "
            f"from {len(drop_seg_idx)} segment(s)"
            + (f" ({reason_text})" if reason_text else "")
        )
    return filtered


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
    padding_sec: float = 2.0,
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


def _frame_is_high_confidence_bad(frame: Any, cfg: dict[str, Any]) -> bool:
    """Return True only for high-confidence black or blown-out frames."""
    try:
        import cv2  # type: ignore
        import numpy as np  # type: ignore
        h, w = frame.shape[:2]
        if h <= 0 or w <= 0:
            return 0.0
        scale = min(1.0, 240.0 / float(max(h, w)))
        if scale < 1.0:
            frame = cv2.resize(frame, (max(1, int(w * scale)), max(1, int(h * scale))))
        hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)
        sat = hsv[:, :, 1]
        val = hsv[:, :, 2]
        total = float(val.size)
        if total <= 0:
            return False
        dark_value_max = float(cfg.get("dark_value_max", 35))
        dark_pixel_ratio = float(cfg.get("dark_pixel_ratio", 0.85))
        bright_value_min = float(cfg.get("bright_value_min", 245))
        bright_low_saturation_max = float(cfg.get("bright_low_saturation_max", 30))
        bright_pixel_ratio = float(cfg.get("bright_pixel_ratio", 0.85))
        dark_ratio = float(np.count_nonzero(val <= dark_value_max)) / total
        bright_flat_ratio = float(
            np.count_nonzero((val >= bright_value_min) & (sat <= bright_low_saturation_max))
        ) / total
        return dark_ratio >= dark_pixel_ratio or bright_flat_ratio >= bright_pixel_ratio
    except Exception:
        return False


def _segment_bad_frame_ratio(
    segment: Segment,
    *,
    sample_frames: int,
    cfg: dict[str, Any],
) -> float | None:
    """Sample a segment and return high-confidence bad-frame ratio; None means unknown."""
    try:
        import cv2  # type: ignore
        cap = cv2.VideoCapture(segment.file)
        if not cap.isOpened():
            return None
        duration = max(0.0, segment.end - segment.start)
        n = max(1, int(sample_frames or 1))
        sampled = 0
        bad = 0
        for i in range(n):
            frac = (i + 1) / (n + 1)
            t = segment.start + duration * frac
            cap.set(cv2.CAP_PROP_POS_MSEC, max(0.0, t) * 1000.0)
            ok, frame = cap.read()
            if not ok or frame is None:
                continue
            sampled += 1
            if _frame_is_high_confidence_bad(frame, cfg):
                bad += 1
        cap.release()
        if sampled <= 0:
            return None
        return bad / float(sampled)
    except Exception:
        return None


def _apply_visual_filter(
    segments: list[Segment],
    cfg: dict[str, Any],
    *,
    logger: "Any | None" = None,
) -> list[Segment]:
    """Optional HSV pruning for high-confidence black or blown-out footage."""
    vcfg = cfg.get("visual_filter", {}) or {}
    if not bool(vcfg.get("enabled", False)):
        return segments

    sample_frames = int(vcfg.get("sample_frames_per_segment", 3))
    bad_threshold = float(vcfg.get("bad_frame_ratio_threshold", 0.67))

    kept: list[Segment] = []
    dropped_visual = 0
    unknown = 0
    for seg in segments:
        bad_ratio = _segment_bad_frame_ratio(seg, sample_frames=sample_frames, cfg=vcfg)
        if bad_ratio is None:
            unknown += 1
            kept.append(seg)
            continue
        if bad_ratio >= bad_threshold:
            dropped_visual += 1
            continue
        kept.append(Segment(
            file=seg.file,
            start=seg.start,
            end=seg.end,
            label=seg.label,
            score=seg.score,
            protected=seg.protected,
        ))

    if logger is not None:
        logger.info(
            f"  [visual filter] kept={len(kept)}/{len(segments)} "
            f"dropped_bad_frame={dropped_visual} unknown={unknown}"
        )
    return kept


def _energy_bursts_from_audio(
    file_path: Path,
    *,
    duration_sec: float,
    noise_db: float,
    min_speech_sec: float,
    logger: "Any | None" = None,
) -> list[tuple[float, float]]:
    """Return non-silent audio ranges from one ffmpeg silencedetect pass."""
    if duration_sec <= 0:
        return []
    duration_ms = max(1.0, duration_sec * 1000.0)
    cmd = [
        "ffmpeg",
        "-hide_banner",
        "-nostdin",
        "-stats_period",
        "5",
        "-progress",
        "pipe:2",
        "-i",
        str(file_path),
        "-af",
        f"silencedetect=noise={noise_db:g}dB:d={min_speech_sec:g}",
        "-f",
        "null",
        "-",
    ]
    if logger is not None:
        logger.info(f"  [audio energy] scanning {file_path.name} ({duration_sec:.0f}s)")
    events: list[tuple[str, float]] = []
    try:
        q: "queue.Queue[str]" = queue.Queue()
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
    except OSError as exc:
        if logger is not None:
            logger.info(f"  [audio energy] {file_path.name}: skipped ({type(exc).__name__})")
        return []
    assert proc.stderr is not None

    def _drain_stderr() -> None:
        try:
            for line in iter(proc.stderr.readline, ""):
                q.put(line.rstrip())
        finally:
            try:
                proc.stderr.close()
            except Exception:
                pass

    threading.Thread(target=_drain_stderr, daemon=True).start()
    started = time.monotonic()
    last_output = started
    last_log = 0.0
    last_percent = -1
    timeout_sec = max(180.0, min(3600.0, duration_sec * 2.0 + 120.0))
    idle_timeout_sec = 90.0
    timed_out = False
    while proc.poll() is None:
        now = time.monotonic()
        if now - started > timeout_sec:
            timed_out = True
            proc.kill()
            break
        if now - last_output > idle_timeout_sec:
            timed_out = True
            proc.kill()
            break
        try:
            raw_line = q.get(timeout=0.5)
        except queue.Empty:
            continue
        last_output = now
        line = raw_line.strip()
        if not line:
            continue
        start = re.search(r"silence_start:\s*([0-9.]+)", line)
        if start:
            events.append(("start", float(start.group(1))))
            continue
        end = re.search(r"silence_end:\s*([0-9.]+)", line)
        if end:
            events.append(("end", float(end.group(1))))
            continue
        done_ms: float | None = None
        if line.startswith("out_time_ms=") or line.startswith("out_time_us="):
            try:
                done_ms = float(line.split("=", 1)[1]) / 1000.0
            except ValueError:
                done_ms = None
        elif line.startswith("out_time="):
            try:
                hh, mm, ss = line.split("=", 1)[1].split(":")
                done_ms = (float(hh) * 3600.0 + float(mm) * 60.0 + float(ss)) * 1000.0
            except ValueError:
                done_ms = None
        if done_ms is not None:
            percent = int(max(0.0, min(100.0, done_ms * 100.0 / duration_ms)))
            if logger is not None and (percent >= last_percent + 10 or now - last_log >= 15.0):
                last_percent = max(last_percent, percent)
                last_log = now
                logger.info(
                    f"  [audio energy] {file_path.name}: {percent}% "
                    f"({done_ms / 1000.0:.0f}/{duration_sec:.0f}s)"
                )
    try:
        rc = proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()
        rc = proc.wait()
        timed_out = True
    while True:
        try:
            raw_line = q.get_nowait()
        except queue.Empty:
            break
        line = raw_line.strip()
        start = re.search(r"silence_start:\s*([0-9.]+)", line)
        if start:
            events.append(("start", float(start.group(1))))
            continue
        end = re.search(r"silence_end:\s*([0-9.]+)", line)
        if end:
            events.append(("end", float(end.group(1))))
    if timed_out:
        if logger is not None:
            logger.info(f"  [audio energy] {file_path.name}: skipped (timeout/no progress)")
        return []
    if rc != 0 and logger is not None:
        logger.info(f"  [audio energy] {file_path.name}: ffmpeg returned {rc}")

    if not events:
        return [(0.0, duration_sec)]

    ranges: list[tuple[float, float]] = []
    cursor = 0.0
    in_silence = False
    for kind, t_raw in sorted(events, key=lambda item: item[1]):
        t = max(0.0, min(duration_sec, t_raw))
        if kind == "start" and not in_silence:
            if t > cursor:
                ranges.append((cursor, t))
            in_silence = True
        elif kind == "end" and in_silence:
            cursor = t
            in_silence = False
    if not in_silence and cursor < duration_sec:
        ranges.append((cursor, duration_sec))
    return [(s, e) for s, e in ranges if e - s >= min_speech_sec]


def _merge_bursts(
    bursts: list[tuple[float, float]],
    *,
    gap_sec: float,
) -> list[tuple[float, float]]:
    merged: list[tuple[float, float]] = []
    for start, end in sorted(bursts):
        if end <= start:
            continue
        if merged and start <= merged[-1][1] + gap_sec:
            merged[-1] = (merged[-1][0], max(merged[-1][1], end))
        else:
            merged.append((start, end))
    return merged


def _add_audio_energy_rescue(
    file_bursts: dict[str, list[tuple[float, float]]],
    body_timelines: list[FileTimeline],
    cfg: dict[str, Any],
    *,
    intro_file_key: str,
    intro_speech_end: float,
    end_cut_until_by_file: dict[str, float],
    logger: "Any | None" = None,
) -> None:
    ecfg = cfg.get("audio_energy", {}) or {}
    if not bool(ecfg.get("enabled", False)):
        return
    noise_db = float(ecfg.get("noise_db", -35.0))
    min_speech_sec = float(ecfg.get("min_speech_sec", 2.0))
    min_gap_sec = float(ecfg.get("merge_gap_sec", 10.0))
    max_extra_ratio = float(ecfg.get("max_extra_ratio", 0.25))
    bridge_gap_sec = float(ecfg.get("bridge_gap_sec", min_gap_sec))
    max_edge_extend_sec = float(ecfg.get("max_edge_extend_sec", 2.0))

    added_total = 0
    skipped_orphan = 0
    bridged_total = 0
    extended_total = 0
    for tl in body_timelines:
        fstr = str(tl.file)
        existing = _merge_bursts(file_bursts.get(fstr, []), gap_sec=0.0)
        energy = _energy_bursts_from_audio(
            tl.file,
            duration_sec=tl.duration_sec,
            noise_db=noise_db,
            min_speech_sec=min_speech_sec,
            logger=logger,
        )
        if not energy:
            continue
        if os.path.normcase(fstr) == intro_file_key:
            energy = [(max(s, intro_speech_end), e) for s, e in energy if e > intro_speech_end]
        end_cap = end_cut_until_by_file.get(fstr)
        if end_cap is not None:
            energy = [(s, min(e, end_cap)) for s, e in energy if s < end_cap]
        energy = [(s, e) for s, e in energy if e - s >= min_speech_sec]
        if not energy:
            continue
        if not existing:
            skipped_orphan += len(energy)
            continue

        max_extra = max(0.0, tl.duration_sec * max_extra_ratio)
        selected: list[tuple[float, float]] = []
        selected_total = 0.0
        for start, end in energy:
            candidates: list[tuple[float, float, str]] = []

            for bs, be in existing:
                if start < be and end > bs:
                    ext_start = max(start, bs - max_edge_extend_sec)
                    ext_end = min(end, be + max_edge_extend_sec)
                    if ext_end > ext_start:
                        candidates.append((ext_start, ext_end, "extend"))

            for (_prev_s, prev_e), (next_s, _next_e) in zip(existing, existing[1:]):
                gap = next_s - prev_e
                if gap <= 0 or gap > bridge_gap_sec:
                    continue
                if start <= prev_e + min_speech_sec and end >= next_s - min_speech_sec:
                    candidates.append((prev_e, next_s, "bridge"))

            if not candidates:
                skipped_orphan += 1
                continue

            for cand_start, cand_end, kind in candidates:
                dur = cand_end - cand_start
                if dur < min_speech_sec:
                    continue
                if selected_total + dur > max_extra:
                    continue
                selected.append((cand_start, cand_end))
                selected_total += dur
                if kind == "bridge":
                    bridged_total += 1
                else:
                    extended_total += 1
        if not selected:
            continue
        file_bursts[fstr] = _merge_bursts([*existing, *selected], gap_sec=min_gap_sec)
        added_total += len(selected)

    if logger is not None and added_total:
        logger.info(
            f"  [audio energy] rescued {added_total} bounded range(s) "
            f"(bridge={bridged_total}, edge={extended_total}, skipped_orphan={skipped_orphan})"
        )


def _segment_total(segments: list[Segment]) -> float:
    return sum(s.duration for s in segments)


def _words_overlapping_segment(
    words: list[tuple[float, float, str]],
    segment: Segment,
    *,
    edge_slop_sec: float = 0.25,
) -> list[tuple[float, float, str]]:
    start = max(0.0, segment.start - edge_slop_sec)
    end = segment.end + edge_slop_sec
    return [
        word for word in words
        if word[1] >= start and word[0] <= end and str(word[2]).strip()
    ]


def _content_refine_score(
    segment: Segment,
    words: list[tuple[float, float, str]],
    terms: tuple[str, ...],
    pronounce_cfg: dict[str, Any] | None = None,
) -> tuple[float, int, int]:
    if not words:
        return 0.0, 0, 0
    canon_words = [
        _canonical_speech_text(str(text))
        for _start, _end, text in words
    ]
    canon_words = [word for word in canon_words if word]
    if not canon_words:
        return 0.0, 0, 0
    canon_text = " ".join(canon_words)
    term_hits = sum(
        1 for term in terms
        if _contains_phrase_signal(canon_text, (term,), pronounce_cfg=pronounce_cfg)
    )
    unique_words = len(set(canon_words))
    word_count = len(canon_words)
    density = word_count / max(1.0, segment.duration)
    score = (
        float(term_hits) * 3.0
        + min(float(unique_words), 8.0) * 0.25
        + min(density, 2.0)
    )
    return score, word_count, term_hits


def _split_by_content_windows(
    segments: list[Segment],
    cfg: dict[str, Any],
    *,
    words_by_file: dict[str, list[tuple[float, float, str]]],
    terms: tuple[str, ...],
    pronounce_cfg: dict[str, Any] | None,
    file_index: dict[str, int],
    logger: "Any | None" = None,
) -> list[Segment]:
    wcfg = cfg.get("window_refine", {}) or {}
    if not bool(wcfg.get("enabled", False)):
        return segments

    min_segment_sec = float(wcfg.get("min_segment_sec", 45.0))
    window_sec = max(1.0, float(wcfg.get("window_sec", 15.0)))
    min_words = int(wcfg.get("min_words", 3))
    min_wps = float(wcfg.get("min_wps", 0.12))
    min_term_hits = int(wcfg.get("min_term_hits", 1))
    merge_gap_sec = float(wcfg.get("merge_gap_sec", 4.0))
    edge_pad_sec = max(0.0, float(wcfg.get("edge_pad_sec", 1.0)))

    out: list[Segment] = []
    split_segments = 0
    dropped_windows = 0
    kept_windows = 0
    dropped_sec = 0.0

    for seg in segments:
        if seg.duration < min_segment_sec:
            out.append(seg)
            continue
        file_key = os.path.normcase(seg.file)
        words = _words_overlapping_segment(
            words_by_file.get(file_key, []),
            seg,
            edge_slop_sec=0.0,
        )
        if not words:
            split_segments += 1
            dropped_windows += int(max(1, round(seg.duration / window_sec)))
            dropped_sec += seg.duration
            continue

        kept_ranges: list[tuple[float, float]] = []
        cursor = seg.start
        while cursor < seg.end:
            block_end = min(seg.end, cursor + window_sec)
            block = Segment(
                file=seg.file,
                start=cursor,
                end=block_end,
                label=seg.label,
                score=seg.score,
                protected=seg.protected,
            )
            block_words = _words_overlapping_segment(
                words,
                block,
                edge_slop_sec=0.0,
            )
            score, word_count, term_hits = _content_refine_score(
                block,
                block_words,
                terms,
                pronounce_cfg,
            )
            density = word_count / max(1.0, block.duration)
            keep = (
                term_hits >= min_term_hits
                or word_count >= min_words
                or density >= min_wps
                or score >= 1.0
            )
            if keep:
                kept_windows += 1
                kept_ranges.append((
                    max(seg.start, cursor - edge_pad_sec),
                    min(seg.end, block_end + edge_pad_sec),
                ))
            else:
                dropped_windows += 1
                dropped_sec += block.duration
            cursor = block_end

        if not kept_ranges:
            split_segments += 1
            continue

        merged = _merge_bursts(kept_ranges, gap_sec=merge_gap_sec)
        if len(merged) != 1 or abs(merged[0][0] - seg.start) > 0.05 or abs(merged[0][1] - seg.end) > 0.05:
            split_segments += 1
        for start, end in merged:
            if end <= start:
                continue
            out.append(Segment(
                file=seg.file,
                start=start,
                end=end,
                label=seg.label,
                score=seg.score,
                protected=seg.protected,
            ))

    normalized = _normalize_segments(out, file_index=file_index)
    if logger is not None and (split_segments or dropped_windows):
        logger.info(
            f"  [window refine] segments={len(segments)}->{len(normalized)} "
            f"split_or_dropped={split_segments} kept_blocks={kept_windows} "
            f"dropped_blocks={dropped_windows} dropped_sec={dropped_sec:.1f}"
        )
    return normalized


def _apply_content_refine(
    segments: list[Segment],
    cfg: dict[str, Any],
    *,
    words_by_file: dict[str, list[tuple[float, float, str]]],
    file_index: dict[str, int],
    logger: "Any | None" = None,
) -> list[Segment]:
    rcfg = cfg.get("content_refine", {}) or {}
    if not bool(rcfg.get("enabled", False)):
        return segments
    if not segments:
        return segments

    terms = _canonical_phrase_list(
        rcfg.get("terms"),
        _DEFAULT_CONTENT_REFINE_TERMS,
    )
    pronounce_cfg = _pronounce_cfg(rcfg.get("pronounce_match"))
    weak_max_words = int(rcfg.get("weak_max_words", 3))
    weak_max_duration = float(rcfg.get("weak_max_duration_sec", 12.0))
    dense_keep_words = int(rcfg.get("dense_keep_words", 8))
    long_keep_sec = float(rcfg.get("long_keep_sec", 45.0))
    dense_keep_min_wps = float(rcfg.get("dense_keep_min_wps", 0.18))
    long_term_min_wps = float(rcfg.get("long_term_min_wps", 0.08))
    long_term_min_hits = int(rcfg.get("long_term_min_hits", 2))
    sparse_long_max_wps = float(rcfg.get("sparse_long_max_wps", 0.08))
    min_score = float(rcfg.get("min_score", 1.25))
    min_keep_ratio = float(rcfg.get("min_keep_ratio", 0.55))
    max_drop_ratio = float(rcfg.get("max_drop_ratio", 0.25))
    bridge_strong_gap = float(rcfg.get("bridge_strong_gap_sec", 12.0))

    segments = _split_by_content_windows(
        segments,
        cfg,
        words_by_file=words_by_file,
        terms=terms,
        pronounce_cfg=pronounce_cfg,
        file_index=file_index,
        logger=logger,
    )

    scored: list[tuple[Segment, float, int, int, bool]] = []
    strong_spans: dict[str, list[tuple[float, float]]] = {}
    for seg in segments:
        file_key = os.path.normcase(seg.file)
        words = _words_overlapping_segment(
            words_by_file.get(file_key, []),
            seg,
        )
        score, word_count, term_hits = _content_refine_score(
            seg,
            words,
            terms,
            pronounce_cfg,
        )
        density = word_count / max(1.0, seg.duration)
        long_segment = seg.duration >= long_keep_sec
        term_strong = (
            term_hits > 0
            and (
                not long_segment
                or density >= long_term_min_wps
                or term_hits >= long_term_min_hits
            )
        )
        dense_strong = word_count >= dense_keep_words and density >= dense_keep_min_wps
        score_strong = score >= min_score and (
            not long_segment
            or density >= sparse_long_max_wps
            or term_hits >= long_term_min_hits
        )
        strong = (
            term_strong
            or score_strong
            or dense_strong
        )
        if strong:
            strong_spans.setdefault(file_key, []).append((seg.start, seg.end))
        scored.append((seg, score, word_count, term_hits, strong))

    source_total = _segment_total(segments)
    min_keep_sec = max(0.0, source_total * min_keep_ratio)
    max_drop_sec = max(0.0, source_total * max_drop_ratio)
    dropped_sec = 0.0
    kept: list[Segment] = []
    dropped = 0
    weak_candidates = 0
    bridged = 0

    for seg, score, word_count, term_hits, strong in scored:
        near_strong = False
        if not strong and bridge_strong_gap > 0:
            spans = strong_spans.get(os.path.normcase(seg.file), [])
            near_strong = any(
                seg.start <= end + bridge_strong_gap
                and seg.end >= start - bridge_strong_gap
                for start, end in spans
            )
        weak = (
            not strong
            and not near_strong
            and term_hits <= 0
            and (
                (word_count <= weak_max_words and seg.duration <= weak_max_duration)
                or (seg.duration >= long_keep_sec and word_count / max(1.0, seg.duration) <= sparse_long_max_wps)
            )
        )
        if weak:
            weak_candidates += 1
        if (
            weak
            and source_total - dropped_sec - seg.duration >= min_keep_sec
            and dropped_sec + seg.duration <= max_drop_sec
        ):
            dropped += 1
            dropped_sec += seg.duration
            continue
        if near_strong and not strong:
            bridged += 1
        kept.append(Segment(
            file=seg.file,
            start=seg.start,
            end=seg.end,
            label=seg.label,
            score=max(seg.score, score),
            protected=seg.protected,
        ))

    if not kept:
        if logger is not None:
            logger.info("  [content refine] fail-open: keeping release candidates")
        return segments

    kept = _normalize_segments(kept, file_index=file_index)
    if logger is not None:
        logger.info(
            f"  [content refine] kept={len(kept)}/{len(segments)} "
            f"dropped={dropped} weak_candidates={weak_candidates} "
            f"bridged={bridged} dropped_sec={dropped_sec:.1f}"
        )
    return kept


def _timeline_source_total(body_timelines: list[FileTimeline]) -> float:
    return sum(max(0.0, tl.duration_sec) for tl in body_timelines)


def _minimum_body_floor_sec(
    body_timelines: list[FileTimeline],
    cfg: dict[str, Any],
) -> float:
    mcfg = cfg.get("minimum_body", {}) or {}
    if not bool(mcfg.get("enabled", False)):
        return 0.0
    source_total = _timeline_source_total(body_timelines)
    if source_total <= 0:
        return 0.0

    ratio = float(mcfg.get("ratio", 0.30))
    long_threshold = float(mcfg.get("long_source_threshold_sec", 90.0 * 60.0))
    long_floor = float(mcfg.get("long_source_floor_sec", 30.0 * 60.0))
    floor = long_floor if source_total > long_threshold else source_total * ratio
    return min(max(0.0, floor), source_total)


def _same_segment_span(a: Segment, b: Segment, *, epsilon_sec: float = 0.05) -> bool:
    return (
        os.path.normcase(a.file) == os.path.normcase(b.file)
        and abs(a.start - b.start) <= epsilon_sec
        and abs(a.end - b.end) <= epsilon_sec
        and a.label == b.label
    )


def _uncovered_intervals(
    start: float,
    end: float,
    covered: list[tuple[float, float]],
) -> list[tuple[float, float]]:
    intervals: list[tuple[float, float]] = []
    cursor = start
    for cs, ce in sorted(covered):
        if ce <= cursor:
            continue
        if cs > cursor:
            intervals.append((cursor, min(cs, end)))
        cursor = max(cursor, ce)
        if cursor >= end:
            break
    if cursor < end:
        intervals.append((cursor, end))
    return [(s, e) for s, e in intervals if e - s > 0.05]


def _apply_minimum_body_floor(
    segments: list[Segment],
    *,
    protected_candidates: list[Segment],
    body_timelines: list[FileTimeline],
    cfg: dict[str, Any],
    file_index: dict[str, int],
    intro_file_key: str,
    intro_speech_end: float,
    end_cut_until_by_file: dict[str, float],
    logger: "Any | None" = None,
) -> list[Segment]:
    floor = _minimum_body_floor_sec(body_timelines, cfg)
    if floor <= 0:
        return segments

    current = _segment_total(segments)
    if current >= floor:
        return segments

    out = list(segments)
    restored = 0
    for cand in sorted(
        protected_candidates,
        key=lambda s: (file_index.get(s.file, 9_999), s.start, s.end),
    ):
        if any(_same_segment_span(existing, cand) for existing in out):
            continue
        out.append(cand)
        restored += 1
        out = _normalize_segments(out, file_index=file_index)
        if _segment_total(out) >= floor:
            break

    filled = 0
    if _segment_total(out) < floor:
        for tl in body_timelines:
            fstr = str(tl.file)
            start = 0.0
            if os.path.normcase(fstr) == intro_file_key:
                start = max(start, intro_speech_end)
            end = max(start, tl.duration_sec)
            end_cap = end_cut_until_by_file.get(fstr)
            if end_cap is not None:
                end = min(end, end_cap)
            if end <= start:
                continue
            covered = [(s.start, s.end) for s in out if os.path.normcase(s.file) == os.path.normcase(fstr)]
            for seg_start, seg_end in _uncovered_intervals(start, end, covered):
                remaining = floor - _segment_total(out)
                if remaining <= 0:
                    break
                take_end = min(seg_end, seg_start + remaining)
                out.append(Segment(
                    file=fstr,
                    start=seg_start,
                    end=take_end,
                    label="HULL",
                    score=0.0,
                    protected=True,
                ))
                filled += 1
                out = _normalize_segments(out, file_index=file_index)
            if _segment_total(out) >= floor:
                break

    if logger is not None:
        logger.info(
            f"  [minimum body] source={_timeline_source_total(body_timelines)/60:.1f}m "
            f"floor={floor/60:.1f}m before={current/60:.1f}m "
            f"after={_segment_total(out)/60:.1f}m "
            f"restored={restored} filled={filled}"
        )
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

    lock_padding = float(speech_lock_cfg.get("padding_sec", 2.0))
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
    filtered_words_by_file: dict[str, list[tuple[float, float, str]]] = {}
    if logger is not None:
        logger.info(f"  [1/6] cut list: scanning speech windows in {len(body_timelines)} file(s)")
    for tl in body_timelines:
        fstr = str(tl.file)
        file_dur_map[fstr] = tl.duration_sec
        if not speech_lock_enabled:
            file_bursts[fstr] = []
            filtered_words_by_file[os.path.normcase(fstr)] = []
            continue
        ft = file_transcripts.get(tl.file)
        words = _filter_hallucinated_words_for_locks(
            ft,
            transcripts.get(tl.file, []),
            speech_lock_cfg,
            logger=logger,
            file_label=tl.file.name,
        )
        filtered_words_by_file[os.path.normcase(fstr)] = words
        file_bursts[fstr] = find_speech_bursts(
            words,
            gap_sec=burst_gap,
            min_burst_sec=min_burst,
        ) if words else []

    # Expand burst boundaries with raw (unfiltered) words.
    raw_transcripts = raw_transcripts or {}
    if logger is not None:
        logger.info("  [2/6] cut list: expanding speech edges")
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

    end_cut_until_by_file = end_cut_until_by_file or {}
    if logger is not None:
        logger.info("  [3/6] cut list: checking audio rescue windows")
    _add_audio_energy_rescue(
        file_bursts,
        body_timelines,
        speech_lock_cfg,
        intro_file_key=intro_file_key,
        intro_speech_end=intro_speech_end,
        end_cut_until_by_file=end_cut_until_by_file,
        logger=logger,
    )

    # ── Step 1b: release padding policy ──
    # Keep the configured padding fixed. Filling the requested duration by
    # inflating silence around speech created long dead gaps in inspection
    # reports, so target length is treated as a cap/goal, not a reason to
    # grow padding beyond the speech-lock setting.
    adaptive_padding = lock_padding

    # ── Step 1c: apply padding to create lock windows ──
    file_locks: dict[str, list[tuple[float, float]]] = {}
    if logger is not None:
        logger.info("  [4/6] cut list: applying padding and locks")
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
    if logger is not None:
        logger.info("  [5/6] cut list: building timeline segments")
    for i, tl in enumerate(body_timelines):
        file_index[str(tl.file)] = i
        locks = file_locks.get(str(tl.file), [])
        all_segments.extend(_build_file_segments_with_locks(
            locks=locks,
            file_path=tl.file,
            file_duration=tl.duration_sec,
        ))

    pre_visual_kept = _normalize_segments(
        [s for s in all_segments if s.protected],
        file_index=file_index,
    )
    if logger is not None:
        logger.info("  [6/6] cut list: filtering and finalizing")
    kept = _apply_visual_filter(
        pre_visual_kept,
        speech_lock_cfg,
        logger=logger,
    )
    kept = _apply_content_refine(
        kept,
        speech_lock_cfg,
        words_by_file=filtered_words_by_file,
        file_index=file_index,
        logger=logger,
    )
    kept = _apply_minimum_body_floor(
        kept,
        protected_candidates=pre_visual_kept,
        body_timelines=body_timelines,
        cfg=speech_lock_cfg,
        file_index=file_index,
        intro_file_key=intro_file_key,
        intro_speech_end=intro_speech_end,
        end_cut_until_by_file=end_cut_until_by_file,
        logger=logger,
    )

    raw_total = sum(s.duration for s in pre_visual_kept)

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
