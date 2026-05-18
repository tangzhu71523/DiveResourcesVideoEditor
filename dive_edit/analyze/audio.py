"""Whisper-based intro speech timing.

The human has already picked which mp4 file is the intro. Whisper's only job
here is to find when the diver starts and stops talking inside that one file.
The cover overlay only displays during this [start, end] window.

Whisper runs in batched isolated subprocesses because ctranslate2 and
OpenCV's CUDA initializations can collide in the same process, crashing
silently at the C++ level with no Python traceback.
"""
from __future__ import annotations
import json
import os
import re
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class SegmentMeta:
    """Per-segment metadata returned by faster-whisper."""
    idx: int
    start: float
    end: float
    text: str
    no_speech_prob: float
    avg_logprob: float
    compression_ratio: float


@dataclass
class FileTranscript:
    """All the Whisper data we keep for one source file.

    ``words`` retains the 3-tuple shape used by legacy consumers
    (find_speech_bursts, locate_intro_speech_from_words, etc.).
    ``segments`` and ``word_seg_idx`` are the extras needed by the
    hallucination filter; they can be ignored by callers that only
    want text.
    """
    words: list[tuple[float, float, str]] = field(default_factory=list)
    segments: list[SegmentMeta] = field(default_factory=list)
    word_seg_idx: list[int] = field(default_factory=list)
    word_prob: list[float] = field(default_factory=list)
    transcription_failed: bool = False
    failure_reason: str = ""

    @property
    def is_empty(self) -> bool:
        return not self.words


@dataclass
class IntroSpeechWindow:
    """Describes the intro cover overlay window in the intro file.

    Legacy name kept for compatibility. Semantically it is now the
    [cover_start, cover_end] range where the cover title overlay is
    visible. The cover is a fixed duration (from TimeConfig), centred
    on the diver's first spoken word with a configurable lead-in.
    """
    start_sec: float            # cover overlay begins at this intro-file timestamp
    end_sec: float              # cover overlay ends here (fixed duration later)
    source: str                 # "whisper_first_word" | "override" | "fallback"
    speech_start_sec: float = 0.0   # raw whisper first-word time, for reporting
    matched_keywords: tuple[str, ...] = ()
    transcript: str = ""

    @property
    def duration(self) -> float:
        return max(0.0, self.end_sec - self.start_sec)


DEFAULT_AUDIO_FILTER_CHAIN = (
    "highpass=f=80,"
    "dynaudnorm=f=500:g=15:p=0.6,"
    "loudnorm=I=-16:LRA=11:TP=-1.5"
)

# Universal dive-comms vocabulary — added to every initial_prompt so
# Whisper knows the radio chatter vocabulary and common hull-inspection
# terminology. Adjust if the fleet uses different conventions.
_UNIVERSAL_DIVE_TERMS = (
    "Topside diver. Roger. Copy that. "
    "Hull. Port side. Starboard side. Bow. Stern. Bottom plate. "
    "Marine growth. Barnacles. Bollard. Sea chest. Anode. "
    "Propeller. Rudder unit. Leading edge. Trailing edge."
)


def derive_initial_prompt(cover_lines: list[str]) -> str:
    """Build a Whisper initial_prompt from the user-supplied cover text.

    Extracts the job scope, vessel name, inspector and location and
    concatenates them with a fixed set of dive-comms terms. The result
    primes Whisper's decoder toward the likely vocabulary of the
    recording WITHOUT being job-specific — non-dive terms are absent.
    """
    scope = ""
    vessel = ""
    inspector = ""
    location = ""
    for line in cover_lines or []:
        m = re.search(r"JOB\s*SCOPE\s*[:#]\s*(.+)", line, re.IGNORECASE)
        if m and not scope:
            scope = m.group(1).strip()
            continue
        m = re.search(r"VESSEL\s*NAME\s*[:#]\s*(.+)", line, re.IGNORECASE)
        if m and not vessel:
            vessel = m.group(1).strip()
            continue
        m = re.search(r"INSPECTOR\s*DIVER\s*[:#]\s*(.+)", line, re.IGNORECASE)
        if m and not inspector:
            inspector = m.group(1).strip()
            continue
        m = re.search(r"LOCATION\s*[:#]\s*(.+)", line, re.IGNORECASE)
        if m and not location:
            location = m.group(1).strip()
            continue

    parts: list[str] = []
    if scope:
        parts.append(scope.title())
    if vessel:
        parts.append(f"Vessel {vessel}")
    if inspector:
        parts.append(f"Inspector {inspector}")
    if location:
        parts.append(f"Location {location}")
    prefix = ". ".join(parts)
    if prefix:
        prefix += ". "
    return prefix + _UNIVERSAL_DIVE_TERMS
# Physical rationale:
#   * highpass=80     — cuts sub-80Hz rumble (bubble thump, water body
#                       resonance) without touching voice (200-3000Hz).
#   * dynaudnorm      — segment-wise gain normalisation so near+far
#                       comms bursts all land in whisper's sweet spot;
#                       works better than compression for radio speech.
#   * loudnorm        — final EBU-R128 integrated loudness to -16 LUFS,
#                       which is Whisper's most reliable input level.
# We deliberately do NOT apply noise gating, bandpass, or spectral
# subtraction — the background IS the medium for underwater comms, and
# removing it erases the voice along with it.


def _extract_audio(
    intro_mp4: Path,
    max_sec: int,
    dst_wav: Path,
    *,
    preprocess: bool = False,
    filter_chain: str = DEFAULT_AUDIO_FILTER_CHAIN,
) -> None:
    """Extract mono 16kHz wav for whisper.

    ``max_sec <= 0`` means extract the FULL file (no cap). Otherwise
    the output is capped at ``max_sec`` seconds — only used for the
    intro-detection probe, NOT for body-content transcription.

    If ``preprocess`` is True, applies the DEFAULT_AUDIO_FILTER_CHAIN to
    clean up underwater comms audio before whisper sees it.
    """
    cmd = [
        "ffmpeg", "-y", "-loglevel", "error",
        "-i", str(intro_mp4),
    ]
    if max_sec and max_sec > 0:
        cmd += ["-t", str(max_sec)]
    cmd += ["-vn", "-ac", "1", "-ar", "16000"]
    if preprocess and filter_chain:
        cmd += ["-af", filter_chain]
    cmd += [str(dst_wav)]
    subprocess.run(cmd, check=True)


# ── cover_lines keyword matching ───────────────────────────────

_STOPWORDS = {"the", "and", "for", "of", "in", "to", "at", "on", "a", "an", "is", "of", "no"}


def _extract_keywords(cover_lines: list[str]) -> list[str]:
    """Turn cover text into a list of lowercase alphanumeric keywords.

    Drops stopwords and tokens shorter than 3 characters. Keeps numeric
    tokens like `DD26041550` or `2026` because they're often precisely
    what the diver reads aloud.
    """
    out: list[str] = []
    for line in cover_lines:
        for raw in re.split(r"[\s:/]+", line):
            clean = re.sub(r"[^A-Za-z0-9]", "", raw).lower()
            if len(clean) < 3:
                continue
            if clean in _STOPWORDS:
                continue
            out.append(clean)
    # dedupe preserving order
    seen: set[str] = set()
    deduped: list[str] = []
    for k in out:
        if k not in seen:
            seen.add(k)
            deduped.append(k)
    return deduped


_COMPANY_NOISE = {
    # Words that appear in company names but are too common in dive
    # inspection speech to be useful as intro signals.
    "dive", "diver", "divers", "diving",
    "marine", "maritime", "offshore", "subsea",
    "inspection", "survey", "services", "service",
    "engineering", "international", "global",
    # Malaysian company suffixes (appear in every local company name)
    "sdn", "bhd",
}


def _extract_company_keywords(cover_lines: list[str]) -> set[str]:
    """Identify keywords from the company name line in cover_lines.

    Company name lines have no label prefix (no 'KEY:' format).
    e.g. 'DIVE RESOURCES SDN BHD' vs 'VESSEL NAME: MT SA HORIZON'.
    These keywords are rare in normal speech and strongly indicate
    the intro report when spoken.

    Words common in dive inspection contexts (e.g. 'dive', 'marine')
    are excluded — only truly distinctive company name tokens survive.
    """
    company_kws: set[str] = set()
    for line in cover_lines:
        stripped = line.strip()
        if not stripped:
            continue
        # Lines with a colon before the value are labeled fields
        if re.match(r"^[A-Z\s]+:", stripped):
            continue
        # This is a standalone line (likely company name)
        for raw in re.split(r"[\s:/]+", stripped):
            clean = re.sub(r"[^A-Za-z0-9]", "", raw).lower()
            if len(clean) < 3 or clean in _STOPWORDS:
                continue
            if clean in _COMPANY_NOISE:
                continue
            company_kws.add(clean)
    return company_kws


def _normalize_word(text: str) -> str:
    return re.sub(r"[^a-z0-9]", "", text.lower())


def _word_matches_keyword(word: str, keyword: str) -> bool:
    """Loose match: exact, substring, or prefix (length >= 4)."""
    if not word or not keyword:
        return False
    if word == keyword:
        return True
    if len(keyword) >= 4 and keyword in word:
        return True
    if len(word) >= 4 and word in keyword:
        return True
    return False



def locate_intro_speech_from_words(
    words: list[tuple[float, float, str]],
    *,
    cover_duration_sec: float,
    lead_in_sec: float,
    max_scan_sec: int = 600,
    override: tuple[float, float] | None = None,
    cover_lines: list[str] | None = None,
) -> IntroSpeechWindow:
    """Given pre-computed Whisper words for the intro file, compute the
    cover overlay window.

    v16 semantics: caller is responsible for running Whisper (likely
    via `transcribe_files_batch`) and passes the word list in. Cover
    is a fixed duration around the first spoken word.

    Note: this function does not apply visual masking. The diver's
    initial report might happen above water before descent, so we find
    the first word regardless of visual classification (plan A).
    """
    if override is not None:
        return IntroSpeechWindow(
            start_sec=float(override[0]),
            end_sec=float(override[1]),
            source="override",
        )

    # Prefer finding the real report via keyword cluster (skips deck
    # equipment testing chatter that comes before the formal report).
    speech_start: float | None = None
    if cover_lines:
        keywords = _extract_keywords(cover_lines)
        if keywords:
            hits: list[tuple[float, str]] = []
            for ws, we, wt in words:
                if ws > max_scan_sec:
                    break
                nw = _normalize_word(wt)
                if not nw:
                    continue
                for kw in keywords:
                    if _word_matches_keyword(nw, kw):
                        hits.append((ws, kw))
                        break
            # Find first cluster of ≥2 distinct keywords within 15s gap
            if len(hits) >= 2:
                for i in range(len(hits) - 1):
                    cluster_kws = {hits[i][1]}
                    cluster_start = hits[i][0]
                    last_end = hits[i][0]
                    for j in range(i + 1, len(hits)):
                        if hits[j][0] - last_end > 15.0:
                            break
                        cluster_kws.add(hits[j][1])
                        last_end = hits[j][0]
                    if len(cluster_kws) >= 2:
                        speech_start = cluster_start
                        break

    # Fallback: first spoken word (legacy behaviour)
    if speech_start is None:
        for ws, we, wt in words:
            if we - ws < 0.15:
                continue
            if not wt.strip():
                continue
            if ws > max_scan_sec:
                break
            speech_start = ws
            break

    if speech_start is None:
        return IntroSpeechWindow(
            start_sec=0.0,
            end_sec=float(cover_duration_sec),
            source="fallback",
            speech_start_sec=0.0,
        )

    cover_start = max(0.0, speech_start - float(lead_in_sec))
    cover_end = cover_start + float(cover_duration_sec)

    snippet_words = [
        wt.strip() for ws, we, wt in words
        if cover_start <= ws <= cover_end and wt.strip()
    ]
    snippet = " ".join(snippet_words).strip()
    if len(snippet) > 400:
        snippet = snippet[:400] + "..."

    matched_kws: tuple[str, ...] = ()
    if cover_lines:
        keywords = _extract_keywords(cover_lines)
        hit: set[str] = set()
        for ws, we, wt in words:
            if not (cover_start <= ws <= cover_end):
                continue
            nw = _normalize_word(wt)
            for kw in keywords:
                if _word_matches_keyword(nw, kw):
                    hit.add(kw)
                    break
        matched_kws = tuple(sorted(hit))

    return IntroSpeechWindow(
        start_sec=cover_start,
        end_sec=cover_end,
        source="whisper_first_word",
        speech_start_sec=speech_start,
        matched_keywords=matched_kws,
        transcript=snippet,
    )


# ── Batch transcription with cache ────────────────────────────

# v3: stores per-segment metadata (no_speech_prob, avg_logprob,
# compression_ratio) and per-word (seg_idx, probability) so the
# hallucination filter can look them up later. v2 caches are
# automatically invalidated and retranscribed.
_CACHE_VERSION = 3


def _cache_path_for(mp4_path: Path, cache_dir: Path) -> Path:
    return cache_dir / f"{mp4_path.stem}.words.json"


def _empty_transcript(*, failed: bool = False, reason: str = "") -> FileTranscript:
    return FileTranscript(transcription_failed=failed, failure_reason=reason)


def _parse_worker_payload(raw: Any) -> FileTranscript:
    """Parse the v21 whisper_batch_worker output schema.

    The worker writes
        {"words": [[s, e, text, seg_idx, prob], ...], "segments": [...]}
    Earlier versions (v20 and older) wrote a plain array of
    [s, e, text] triples — we handle that for forward compat during
    the transition but treat it as metadata-less (empty segments).
    """
    if isinstance(raw, list):
        words: list[tuple[float, float, str]] = []
        for row in raw:
            if len(row) >= 3:
                words.append((float(row[0]), float(row[1]), str(row[2])))
        return FileTranscript(
            words=words,
            segments=[],
            word_seg_idx=[0] * len(words),
            word_prob=[1.0] * len(words),
        )
    if not isinstance(raw, dict):
        return _empty_transcript()

    raw_words = raw.get("words") or []
    raw_segments = raw.get("segments") or []

    segments: list[SegmentMeta] = []
    for s in raw_segments:
        try:
            segments.append(SegmentMeta(
                idx=int(s.get("idx", len(segments))),
                start=float(s.get("start", 0.0)),
                end=float(s.get("end", 0.0)),
                text=str(s.get("text", "")),
                no_speech_prob=float(s.get("no_speech_prob", 0.0)),
                avg_logprob=float(s.get("avg_logprob", 0.0)),
                compression_ratio=float(s.get("compression_ratio", 0.0)),
            ))
        except (TypeError, ValueError):
            continue

    words: list[tuple[float, float, str]] = []
    word_seg_idx: list[int] = []
    word_prob: list[float] = []
    for row in raw_words:
        if not row or len(row) < 3:
            continue
        try:
            start = float(row[0])
            end = float(row[1])
            text = str(row[2])
        except (TypeError, ValueError):
            continue
        seg_idx = int(row[3]) if len(row) > 3 else 0
        prob = float(row[4]) if len(row) > 4 else 1.0
        words.append((start, end, text))
        word_seg_idx.append(seg_idx)
        word_prob.append(prob)

    return FileTranscript(
        words=words,
        segments=segments,
        word_seg_idx=word_seg_idx,
        word_prob=word_prob,
    )


def _load_cached_transcript(
    mp4_path: Path,
    cache_dir: Path,
    *,
    expected_model: str,
    expected_preprocess: bool,
    expected_extras: dict[str, Any] | None = None,
) -> FileTranscript | None:
    """Return cached FileTranscript if still fresh, else None.

    Cache invalidates when: source mtime changes, source size changes,
    model changes, preprocessing flag changes, or any extras key
    differs (e.g. initial_prompt, language).
    """
    cache_path = _cache_path_for(mp4_path, cache_dir)
    if not cache_path.exists():
        return None
    try:
        data = json.loads(cache_path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None
    if not isinstance(data, dict):
        return None
    if data.get("version") != _CACHE_VERSION:
        return None
    if data.get("model") != expected_model:
        return None
    if bool(data.get("preprocessed")) != expected_preprocess:
        return None
    if expected_extras is not None:
        cached_extras = data.get("extras", {})
        if cached_extras != expected_extras:
            return None
    try:
        st = mp4_path.stat()
    except OSError:
        return None
    if abs(data.get("source_mtime", 0.0) - st.st_mtime) > 1.0:
        return None
    if data.get("source_size", -1) != st.st_size:
        return None

    payload = data.get("payload")
    if payload is None:
        return None
    return _parse_worker_payload(payload)


def _save_cached_transcript(
    mp4_path: Path,
    cache_dir: Path,
    transcript: FileTranscript,
    *,
    model: str,
    preprocessed: bool,
    extras: dict[str, Any] | None = None,
) -> None:
    cache_dir.mkdir(parents=True, exist_ok=True)
    try:
        st = mp4_path.stat()
    except OSError:
        return
    serialized_words: list[list[Any]] = []
    for (ws, we, wt), seg_idx, prob in zip(
        transcript.words, transcript.word_seg_idx, transcript.word_prob
    ):
        serialized_words.append([float(ws), float(we), str(wt), int(seg_idx), float(prob)])

    serialized_segments = [
        {
            "idx": s.idx,
            "start": s.start,
            "end": s.end,
            "text": s.text,
            "no_speech_prob": s.no_speech_prob,
            "avg_logprob": s.avg_logprob,
            "compression_ratio": s.compression_ratio,
        }
        for s in transcript.segments
    ]

    payload = {
        "version": _CACHE_VERSION,
        "model": model,
        "preprocessed": preprocessed,
        "extras": extras or {},
        "source_mtime": st.st_mtime,
        "source_size": st.st_size,
        "payload": {
            "words": serialized_words,
            "segments": serialized_segments,
        },
    }
    tmp = _cache_path_for(mp4_path, cache_dir).with_suffix(".json.tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, _cache_path_for(mp4_path, cache_dir))


def _split_manifest_balanced(
    manifest: list[dict[str, str]],
    n_workers: int,
) -> list[list[dict[str, str]]]:
    """Greedy bin-pack manifest entries by wav file size into N near-equal bins.

    File size proxies for transcription cost (same codec/SR across this app).
    """
    if n_workers <= 1 or len(manifest) <= 1:
        return [manifest]
    sized = []
    for entry in manifest:
        try:
            sz = Path(entry["input"]).stat().st_size
        except OSError:
            sz = 0
        sized.append((sz, entry))
    sized.sort(key=lambda x: x[0], reverse=True)
    bins: list[list[dict[str, str]]] = [[] for _ in range(n_workers)]
    bin_load = [0] * n_workers
    for sz, entry in sized:
        i = bin_load.index(min(bin_load))
        bins[i].append(entry)
        bin_load[i] += sz
    return [b for b in bins if b]


def transcribe_files_batch(
    mp4_paths: list[Path],
    cache_dir: Path,
    whisper_cfg: dict[str, Any],
    *,
    max_scan_sec: int = 0,  # 0 = no cap, transcribe FULL file
    preprocess: bool = True,
    filter_chain: str = DEFAULT_AUDIO_FILTER_CHAIN,
    initial_prompt: str = "",
    n_workers: int = 1,
    logger=None,
) -> dict[Path, FileTranscript]:
    """Transcribe every file in ``mp4_paths`` with one batched subprocess.

    - Cached transcripts are loaded up front and skipped.
    - Audio is preprocessed with the default filter chain (see
      DEFAULT_AUDIO_FILTER_CHAIN) to help Whisper see through comms noise.
    - All un-cached files run inside a single Whisper subprocess to
      amortise CUDA / model load cost.
    - Results are cached under ``cache_dir`` keyed by source mtime+size.
    - ``initial_prompt`` is passed to faster_whisper's decoder to prime
      it toward dive-report vocabulary.

    Returns a dict of Path → FileTranscript. Callers that only need
    the word list can use ``result[p].words``.
    """
    model_name = str(whisper_cfg.get("model", "medium"))
    requested_device = str(whisper_cfg.get("device", "auto"))
    compute_gpu = str(whisper_cfg.get("compute_type_gpu", "int8_float16"))
    compute_cpu = str(whisper_cfg.get("compute_type_cpu", "int8"))
    language = str(whisper_cfg.get("language", "en"))

    # Frozen + no system CUDA → force CPU. Without this, ctranslate2's
    # delay-loaded cudart import crashes the whisper worker subprocess
    # with rc=0xC0000409 before Python's fallback path can run.
    # DIVE_FORCE_CPU is set by app.py at startup via ctypes WinDLL probe.
    if os.environ.get("DIVE_FORCE_CPU") == "1" and requested_device != "cpu":
        requested_device = "cpu"

    # Hard worker cap on CPU. Each whisper subprocess loads ~3GB of
    # weights AND saturates every CPU core; running >1 back-to-back
    # makes the host unresponsive in seconds. Caller may have asked
    # for N (frontend stepper or auto detect), but on CPU we always
    # collapse to 1. Server.py also clamps here as defense-in-depth.
    if requested_device == "cpu" and (n_workers or 1) > 1:
        n_workers = 1

    results: dict[Path, FileTranscript] = {}
    to_transcribe: list[Path] = []

    # Cache key includes initial_prompt / VAD — both affect decoding.
    cache_extra = {
        "initial_prompt": initial_prompt or "",
        "vad": "on" if str(whisper_cfg.get("vad", "off")).lower() in ("on", "true", "1", "yes") else "off",
    }

    for p in mp4_paths:
        cached = _load_cached_transcript(
            p, cache_dir,
            expected_model=model_name,
            expected_preprocess=preprocess,
            expected_extras=cache_extra,
        )
        if cached is not None:
            if logger:
                logger.info(
                    f"  [cache hit] {p.name} "
                    f"({len(cached.words)} words, {len(cached.segments)} segments)"
                )
            results[p] = cached
        else:
            to_transcribe.append(p)

    if not to_transcribe:
        return results

    with tempfile.TemporaryDirectory() as td:
        td_path = Path(td)
        manifest: list[dict[str, str]] = []
        tmp_out_paths: dict[Path, Path] = {}

        for p in to_transcribe:
            if logger:
                logger.info(f"  [extract audio] {p.name}")
            wav = td_path / f"{p.stem}.wav"
            try:
                _extract_audio(
                    p, max_scan_sec, wav,
                    preprocess=preprocess,
                    filter_chain=filter_chain,
                )
            except subprocess.CalledProcessError as e:
                if logger:
                    logger.warn(f"  audio extract failed for {p.name}: {e}")
                results[p] = _empty_transcript(failed=True, reason="audio extract failed")
                continue
            out_json = td_path / f"{p.stem}.words.json"
            tmp_out_paths[p] = out_json
            manifest.append({"input": str(wav), "output": str(out_json)})

        if not manifest:
            return results

        prompt_path = td_path / "prompt.txt"
        prompt_path.write_text(initial_prompt or "", encoding="utf-8")

        env = dict(os.environ)
        env["PYTHONUTF8"] = "1"
        env["PYTHONIOENCODING"] = "utf-8"
        env["PYTHONUNBUFFERED"] = "1"

        # Decide actual worker count: never more than file count, never < 1
        actual_workers = max(1, min(int(n_workers or 1), len(manifest)))
        shards = _split_manifest_balanced(manifest, actual_workers)
        actual_workers = len(shards)  # may shrink if files were too few

        if logger:
            logger.kv("[whisper-batch] config",
                      n_files=len(manifest),
                      n_workers=actual_workers,
                      model=model_name,
                      requested_device=requested_device,
                      compute_gpu=compute_gpu,
                      compute_cpu=compute_cpu,
                      language=language,
                      preprocess=preprocess,
                      cuda_status=os.environ.get("DIVE_CUDA_STATUS"),
                      force_cpu=os.environ.get("DIVE_FORCE_CPU"))

        vad_arg = "on" if str(whisper_cfg.get("vad", "off")).lower() in ("on", "true", "1", "yes") else "off"

        def _build_cmd(manifest_file: Path) -> list[str]:
            args_tail = [
                str(manifest_file),
                model_name,
                requested_device,
                compute_gpu,
                compute_cpu,
                language,
                str(prompt_path),
                vad_arg,
            ]
            # Frozen exe re-invokes itself with --whisper-batch sentinel that
            # the desktop entrypoint dispatches to whisper_batch_worker.main().
            if getattr(sys, "frozen", False):
                return [sys.executable, "--whisper-batch", *args_tail]
            return [
                sys.executable,
                "-u", "-X", "utf8",
                "-m", "dive_edit.analyze.whisper_batch_worker",
                *args_tail,
            ]

        t0 = time.time()
        # Always use Popen + live stderr streaming, even for workers=1.
        # subprocess.run() with capture_output buffers everything until
        # the subprocess exits, so progress emissions never reach the
        # parent until the work is already done — frontend bar jumps
        # 0→100 instantly. The Popen path threads each worker's stderr
        # and emits aggregated [whisper-progress N/100] lines once a
        # second, regardless of worker count.
        if True:
            # Spawn N subprocesses in parallel. Stagger by 2s to avoid
            # ctranslate2 + CUDA initialization racing on the same context.
            procs: list[tuple[int, subprocess.Popen]] = []
            for idx, shard in enumerate(shards):
                m_path = td_path / f"manifest_{idx}.json"
                m_path.write_text(json.dumps(shard), encoding="utf-8")
                if idx > 0:
                    time.sleep(2.0)
                cmd = _build_cmd(m_path)
                p = subprocess.Popen(
                    cmd,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                    env=env,
                )
                if logger:
                    logger.kv(f"[w{idx+1}] spawn",
                              pid=p.pid,
                              shard_size=len(shard),
                              shard_files=[Path(e["input"]).name for e in shard],
                              manifest_path=str(m_path),
                              cmd=cmd)
                procs.append((idx, p))

            # Thread-stream every worker's stderr live so we can:
            #   1) capture the structured records into the log as they
            #      land (instead of waiting for communicate()),
            #   2) parse the new file_total / segment_progress lines
            #      and aggregate across workers into one percent,
            #   3) emit "[whisper N/100]" to the main pipeline stdout
            #      once a second so the frontend's _PROGRESS_RE picks
            #      it up and the bar advances continuously instead of
            #      jumping 25%/50%/75%/100% at worker exits.
            import threading as _th
            import re as _re

            stderr_lock = _th.Lock()
            stderr_lines: list[tuple[int, str]] = []
            file_total_sec: dict[str, float] = {}      # wav path → total sec
            file_done_sec: dict[str, float] = {}       # wav path → processed sec
            done_evt = _th.Event()

            _RE_FILE_TOTAL = _re.compile(
                r"file_total wav='([^']+)' t_done=[\d.]+ t_total=([\d.]+)"
            )
            _RE_SEG_PROG = _re.compile(
                r"segment_progress wav='([^']+)' t_done=([\d.]+) t_total=([\d.]+)"
            )

            def _stream(idx: int, p: subprocess.Popen) -> None:
                try:
                    if p.stderr is None:
                        return
                    for raw in p.stderr:
                        line = raw.rstrip()
                        if not line:
                            continue
                        with stderr_lock:
                            stderr_lines.append((idx, line))
                        m = _RE_FILE_TOTAL.search(line)
                        if m:
                            wav_name = m.group(1)
                            file_total_sec[wav_name] = float(m.group(2))
                            file_done_sec.setdefault(wav_name, 0.0)
                            continue
                        m = _RE_SEG_PROG.search(line)
                        if m:
                            wav_name = m.group(1)
                            file_done_sec[wav_name] = float(m.group(2))
                            file_total_sec.setdefault(wav_name, float(m.group(3)))
                except Exception:  # noqa: BLE001
                    pass

            stream_threads = [
                _th.Thread(target=_stream, args=(idx, p), daemon=True, name=f"w{idx+1}-stream")
                for idx, p in procs
            ]
            for th in stream_threads:
                th.start()

            def _aggregate_emit() -> None:
                # Emit one [whisper N/100] line per second so the
                # frontend has continuous progress to render. Stops
                # once done_evt is set.
                last_pct = -1
                while not done_evt.is_set():
                    total = sum(file_total_sec.values())
                    done = sum(file_done_sec.values())
                    if total > 0:
                        pct = max(0, min(99, int(round(done / total * 100))))
                        if pct != last_pct and logger:
                            logger.info(f"  [whisper-progress] [{pct}/100] {done:.0f}/{total:.0f}s audio")
                            last_pct = pct
                    if done_evt.wait(1.0):
                        break

            agg_thread = _th.Thread(target=_aggregate_emit, daemon=True, name="whisper-agg")
            agg_thread.start()

            for idx, p in procs:
                p.wait()
            done_evt.set()
            for th in stream_threads:
                th.join(timeout=2.0)
            agg_thread.join(timeout=2.0)

            # Now drain everything we captured, in arrival order.
            for idx, line in stderr_lines:
                if logger:
                    logger.debug(f"[w{idx+1}] stderr: {line}")
                else:
                    sys.stderr.write(f"  [w{idx+1}] {line}\n")
            if stderr_lines:
                sys.stderr.flush()

            for idx, p in procs:
                rc = p.returncode
                rc_hex = f"0x{rc & 0xFFFFFFFF:08X}" if rc is not None else "None"
                if logger:
                    status = "ok" if rc == 0 else f"FAIL rc={rc_hex}"
                    logger.info(f"  worker {idx+1} exited {status}")
                    logger.kv(f"[w{idx+1}] exit", pid=p.pid, rc=rc, rc_hex=rc_hex)
                # Sidecar drained as before.
                sidecar = Path(td_path) / f"worker_{p.pid}.log"
                if sidecar.exists():
                    try:
                        for line in sidecar.read_text(encoding="utf-8").splitlines():
                            if logger:
                                logger.debug(f"[w{idx+1}] sidecar: {line}")
                        sidecar.unlink()
                    except OSError:
                        pass

            if logger:
                # Final aggregate tick at 100 so the frontend bar lands
                # cleanly before the stage transitions to intro.
                logger.info(f"  [whisper-progress] [100/100] all workers done")
                logger.kv("[whisper-batch] all_done",
                          total_s=round(time.time() - t0, 2),
                          n_workers=actual_workers,
                          n_files=len(manifest))

        # Read every produced words JSON regardless of rc — ctranslate2
        # can crash at teardown after writing all results successfully.
        for p in to_transcribe:
            if p in results:
                continue
            out = tmp_out_paths.get(p)
            if out is None or not out.exists():
                results[p] = _empty_transcript(failed=True, reason="worker output missing")
                continue
            try:
                raw = json.loads(out.read_text(encoding="utf-8"))
            except (json.JSONDecodeError, OSError):
                raw = None
            transcript = _parse_worker_payload(raw) if raw is not None else _empty_transcript()
            results[p] = transcript
            _save_cached_transcript(
                p, cache_dir, transcript,
                model=model_name,
                preprocessed=preprocess,
                extras=cache_extra,
            )

    return results


# ── Hallucination filter ──────────────────────────────────────

# End-of-report phrase markers — two categories:
#   A) "formal conclusion" phrases (HALO 6, SA HORIZON pattern)
#   B) "work assignment" phrases (SAKIZAYA pattern: report transitions
#      into polishing/task dispatch, signalling report is over)
# Trigger when ≥2 different phrases appear within 30s.
# (A) Formal closing phrases can appear mid-report, so they need guards.
_END_PHRASES_FORMAL: tuple[str, ...] = (
    "thank you very much",
    "good job",
    "all vessel",
    "all cleaned",
    "cleaned from forward",
    "port and starboard",
    "complete for your inspection",
    "inspection complete",
    "inspection today",
    "ready to level",
    "ready to ascend",
    "no other request",
    "any other request",
    "level the bottom",
    "bottom all cleaned",
)

# (B) Work-assignment phrases are strong end-of-report signals.
_END_PHRASES_ASSIGNMENT: tuple[str, ...] = (
    "start from",
    "you can wait",
    "wait for the photography",
    "wait for photography",
    "proceed to the propeller",
    "proceed to the anode",
    "proceed to the rudder",
    "proceed for second",
    "proceed for third",
    "bring the propeller",
    "start polishing",
    "start cleaning",
    "red guard first",
)

_END_REPORT_PHRASES: tuple[str, ...] = _END_PHRASES_FORMAL + _END_PHRASES_ASSIGNMENT


def detect_end_report_boundary(
    words: list[tuple[float, float, str]],
    *,
    min_phrases: int = 3,
    window_sec: float = 30.0,
) -> float | None:
    """Detect the time at which the diver's end-of-job report concludes.

    Looks for the LAST cluster where ≥ ``min_phrases`` distinct end-report
    phrases appear within ``window_sec``. Returns the end time of that
    cluster. Anything beyond this is assumed to be hallucination or
    irrelevant chatter.

    Returns None if no confident end report is detected (fallback: keep
    all words — current behaviour).
    """
    if not words:
        return None
    # Walk all words building phrase-match positions
    text_concat = ""
    word_end_positions: list[tuple[int, float]] = []  # (char_idx_end, word_end_time)
    for ws, we, wt in words:
        text_concat += (" " if text_concat else "") + wt.strip()
        word_end_positions.append((len(text_concat), we))

    lower = text_concat.lower()
    # Find all phrase occurrences (char position, phrase)
    hits: list[tuple[float, str]] = []
    for phrase in _END_REPORT_PHRASES:
        start = 0
        while True:
            idx = lower.find(phrase, start)
            if idx < 0:
                break
            # Map char idx to word time
            char_end = idx + len(phrase)
            time_of_hit = None
            for cpos, wt in word_end_positions:
                if cpos >= char_end:
                    time_of_hit = wt
                    break
            if time_of_hit is not None:
                hits.append((time_of_hit, phrase))
            start = idx + len(phrase)

    if len(hits) < min_phrases:
        return None

    hits.sort()
    # Find LAST cluster meeting threshold
    for i in range(len(hits) - 1, -1, -1):
        cluster_phrases = {hits[i][1]}
        cluster_end = hits[i][0]
        for j in range(i - 1, -1, -1):
            if hits[i][0] - hits[j][0] > window_sec:
                break
            cluster_phrases.add(hits[j][1])
        if len(cluster_phrases) >= min_phrases:
            return cluster_end
    return None


# ── Auto-detect intro file ────────────────────────────────────

@dataclass
class IntroDetectionResult:
    file: Path
    score: int                 # number of distinct cover keywords hit
    matched_keywords: tuple[str, ...]
    all_scores: list[tuple[Path, int]]  # for reporting all candidates



def _intro_fallback_smart_bursts(
    candidates: list[Path],
    transcripts: dict[Path, list[tuple[float, float, str]]],
    cover_lines: list[str],
    *,
    min_burst_sec: float = 10.0,
    min_body_sec: float = 20.0,
    burst_gap_sec: float = 2.0,
    logger=None,
) -> tuple[Path, int] | None:
    """Smart intro fallback: backtrack from END to find INTRO.

    Empirical observation (2026-04-16, verified on 4 jobs):
    END phrases appear in LATER files (operation wrap-up), INTRO file is BEFORE.
    Intro is the diver's verbal report; end is task-dispatch chatter after.

    Algorithm (corrected from the observed END-to-INTRO ordering):

      1. Find LATEST file containing ≥1 end_phrase. Call it E.
      2. Among files BEFORE E (in candidate order):
         - Filter to those with continuous burst ≥ min_body_sec (20s).
         - Score by cover_kw matches in burst (if cover provides any signal).
         - If no cover hit anywhere, pick file with LONGEST qualifying burst.
      3. Pipeline doesn't crash: if no E found, fallback to longest-burst file.

    Returns (file, score) or None if no candidate qualifies.
    """
    cover_kw = _extract_keywords(cover_lines)

    # ── Step 1: Find LATEST file containing end_phrase markers ──
    end_file_idx = -1  # -1 means no END found
    for i, f in enumerate(candidates):
        words = transcripts.get(f, [])
        if not words:
            continue
        full_text = " ".join(_normalize_word(w[2]) for w in words if w[2])
        # Quick scan for end_phrase substrings
        for phrase in _END_REPORT_PHRASES:
            if phrase in full_text:
                end_file_idx = max(end_file_idx, i)
                break

    if logger:
        if end_file_idx >= 0:
            logger.info(
                f"  [smart fallback] END anchor: {candidates[end_file_idx].name} "
                f"(index {end_file_idx}). intro must precede it."
            )
        else:
            logger.info(f"  [smart fallback] no end phrases detected, all candidates included")

    # ── Step 2: Restrict candidates to files BEFORE the END anchor ──
    if end_file_idx >= 0:
        intro_candidates = candidates[:end_file_idx]  # exclude E itself
    else:
        intro_candidates = list(candidates)
    if not intro_candidates:
        if logger:
            logger.info(f"  [smart fallback] no candidates before END, fallback to all")
        intro_candidates = list(candidates)

    # ── Step 3: For each candidate, find longest burst ≥ min_body_sec ──
    # Score by cover_kw if any; otherwise rank by burst duration.
    file_results: list[tuple[Path, int, float]] = []  # (file, cover_hits, longest_burst_dur)
    for f in intro_candidates:
        words = transcripts.get(f, [])
        if len(words) < 2:
            continue
        bursts: list[tuple[float, float]] = []
        burst_start = words[0][0]
        prev_end = words[0][1]
        for ws, we, _ in words[1:]:
            if ws - prev_end > burst_gap_sec:
                if prev_end - burst_start >= min_burst_sec:
                    bursts.append((burst_start, prev_end))
                burst_start = ws
            prev_end = we
        if prev_end - burst_start >= min_burst_sec:
            bursts.append((burst_start, prev_end))

        qualifying = [(bs, be) for bs, be in bursts if be - bs >= min_body_sec]
        if not qualifying:
            continue

        # Find the file's best burst by cover_hits, tied by duration
        best_cover = 0
        best_dur = 0.0
        for bs, be in qualifying:
            burst_words = [w for w in words if bs <= w[0] <= be]
            cover_hits = 0
            for _ws, _we, wt in burst_words:
                nw = _normalize_word(wt)
                if nw and any(_word_matches_keyword(nw, kw) for kw in cover_kw):
                    cover_hits += 1
            dur = be - bs
            if cover_hits > best_cover or (cover_hits == best_cover and dur > best_dur):
                best_cover = cover_hits
                best_dur = dur

        file_results.append((f, best_cover, best_dur))
        if logger:
            logger.info(
                f"  [smart fallback] {f.name}: "
                f"cover_hits={best_cover}, longest_qualifying_burst={best_dur:.0f}s"
            )

    if not file_results:
        return None

    # ── Step 4: Pick best ──
    # Priority:
    #   1. Highest cover_hits (positive intro signal)
    #   2. Longest burst (most report-like structure)
    #   3. Earliest file (per user's design)
    # Tie-break: earliest file, because valid body footage must continue
    # forward from the intro timestamp.
    file_order = {f: i for i, f in enumerate(candidates)}
    file_results.sort(key=lambda x: (-x[1], -x[2], file_order.get(x[0], 0)))
    picked = file_results[0]
    # Score = cover_hits (consistent with primary detection's score concept)
    return (picked[0], picked[1])


def auto_detect_intro_file_from_transcripts(
    candidates: list[Path],
    transcripts: dict[Path, list[tuple[float, float, str]]],
    cover_lines: list[str],
    *,
    min_score: int = 3,
    logger=None,
) -> IntroDetectionResult | None:
    """Pick the best intro file by cover keyword matching.

    Cascade strategy:
      1. Try strict threshold: score >= min_score (default 3, was 2)
      2. If no file qualifies, relax to score >= 2
      3. If still no, relax to score >= 1
      4. If still no, fall through to END-anchored fallback
      5. Last-resort: pick last file (pipeline never crashes)

    Cover_lines is treated as the absolute anchor — all matching is against
    user-supplied title text. Reasoning: cover content is what the diver said
    verbally, so it's the most reliable intro signal.

    Among files meeting threshold, the earliest file wins. This matches the
    burned-in timestamp invariant: once the report starts, following files must
    move forward in time. Later high scores are often Whisper hallucinations.
    Company name keywords get 3x weight (rare in normal speech).
    """
    if not candidates or not cover_lines:
        return None

    keywords = _extract_keywords(cover_lines)
    if not keywords:
        return None

    # Company name keywords are rare in normal speech — weight them 3x.
    company_kws = _extract_company_keywords(cover_lines)

    results: list[tuple[Path, int, set[str]]] = []
    total = len(candidates)
    for i, mp4 in enumerate(candidates, 1):
        words = transcripts.get(mp4, [])
        hit: set[str] = set()
        for ws, we, wt in words:
            nw = _normalize_word(wt)
            if not nw:
                continue
            for kw in keywords:
                if _word_matches_keyword(nw, kw):
                    hit.add(kw)
                    break
        # Weighted score: company keywords count 3x
        score = sum(3 if kw in company_kws else 1 for kw in hit)
        results.append((mp4, score, hit))
        if logger:
            company_hits = hit & company_kws
            extra = f" (company: {sorted(company_hits)})" if company_hits else ""
            # [i/total] prefix lets the WS runner parse this as stage progress
            # so the UI bar advances per file instead of jumping at the end.
            logger.info(f"  [{i}/{total}] {mp4.name}: score={score} keywords={sorted(hit)}{extra}")

    # Cascade thresholds: strict → relaxed → very-relaxed
    # Tie-break: EARLIEST file (greedy/maximal inclusion philosophy —
    # earlier intro → larger body range → more content preserved).
    file_order = {f: i for i, f in enumerate(candidates)}
    for try_threshold in (min_score, 2, 1):
        qualifying = [(f, s, kws) for f, s, kws in results if s >= try_threshold]
        if qualifying:
            qualifying.sort(key=lambda x: (file_order.get(x[0], 0), -x[1]))
            picked = qualifying[0]
            highest = max(qualifying, key=lambda x: (x[1], -file_order.get(x[0], 0)))
            if logger and try_threshold < min_score:
                logger.warn(
                    f"  ⚠️ INTRO threshold relaxed to {try_threshold} to match: "
                    f"{picked[0].name} (score={picked[1]})"
                )
            if logger and highest[0] != picked[0]:
                logger.warn(
                    f"  INTRO picked earliest qualifying file {picked[0].name} "
                    f"(score={picked[1]}); later higher score {highest[0].name} "
                    f"(score={highest[1]}) treated as lower trust."
                )
            return IntroDetectionResult(
                file=picked[0],
                score=picked[1],
                matched_keywords=tuple(sorted(picked[2])),
                all_scores=[(p, s) for p, s, _ in results],
            )

    # All threshold tiers failed
    qualifying = []  # placeholder for original code below
    if not qualifying:
        # ── FALLBACK 1: Smart cross-validation ──
        # Use both cover dict + end-report dict to find report-style speech bursts.
        # Hard constraint: burst ≥ min_body_sec (20s) — short bursts are noise.
        smart = _intro_fallback_smart_bursts(
            candidates, transcripts, cover_lines, logger=logger
        )
        if smart is not None:
            f, score = smart
            if logger:
                logger.warn(
                    f"  ⚠️ INTRO smart fallback (cross-dict cover+end + speech >=10s + body >=20s hard constraint): "
                    f"{f.name} (merged score={score})"
                )
                logger.warn(
                    f"  Please verify manually; on mistake set intro_file in job.yaml then --reset."
                )
            return IntroDetectionResult(
                file=f, score=score, matched_keywords=tuple(),
                all_scores=[(p, s) for p, s, _ in results],
            )

        # ── FALLBACK 2: Last-file ultimate safety net ──
        # Smart fallback found nothing (no qualifying speech bursts in any file).
        # Pick the last file as last resort. Pipeline never crashes.
        if logger:
            logger.warn(
                f"  ⚠️ smart fallback empty (no >=20s continuous speech + keyword hit). "
                f"Final fallback: selected the last file {candidates[-1].name}"
            )
            logger.warn(
                f"  ⚠️ This is a last-resort fallback; manual verification strongly recommended."
            )
        file_order = {f: i for i, f in enumerate(candidates)}
        results_sorted = sorted(results, key=lambda x: (-x[1], -file_order.get(x[0], 0)))
        picked = results_sorted[0]
        return IntroDetectionResult(
            file=picked[0],
            score=picked[1],
            matched_keywords=tuple(sorted(picked[2])),
            all_scores=[(p, s) for p, s, _ in results],
        )

    # Sort by score descending, then by file index descending (prefer later).
    file_order = {f: i for i, f in enumerate(candidates)}
    qualifying.sort(key=lambda x: (-x[1], -file_order.get(x[0], 0)))
    picked = qualifying[0]

    return IntroDetectionResult(
        file=picked[0],
        score=picked[1],
        matched_keywords=tuple(sorted(picked[2])),
        all_scores=[(p, s) for p, s, _ in results],
    )
