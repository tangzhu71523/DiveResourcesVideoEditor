"""OCR timestamp extraction from burned-in video overlay.

Extracts the timestamp from the known monitor region (top-right corner)
of the first and last keyframe of each file. Used for:
  1. File ordering validation (sort by actual recorded time)
  2. EDL monotonicity check (output timestamps never go backward)
"""
from __future__ import annotations
import calendar
import os
import re
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

import cv2
import numpy as np

from ..utils.process_flags import ffmpeg_executable, hidden_subprocess_kwargs


@dataclass
class FileTimestamp:
    file: Path
    first_frame_text: str       # raw OCR text from first frame
    last_frame_text: str        # raw OCR text from last frame
    first_time: datetime | None  # parsed timestamp
    last_time: datetime | None
    confidence: float = 0.0


# Lazy-loaded PaddleOCR singleton
_ocr_instance = None


def _register_cuda_dll_dirs() -> None:
    """Add pip-installed NVIDIA runtime DLL directories to Windows DLL search.

    PaddleOCR GPU 依赖 cudnn64_8.dll 等 DLL。它们随 nvidia-cudnn-cu11 等 pip
    包被装到 site-packages/nvidia/*/bin/ 下但不在 PATH 里。
    双保险：
      1. os.add_dll_directory 注册搜索路径（Windows 10+ API）
      2. 修改 os.environ["PATH"] — paddle 内部 C++ LoadLibrary 会读 PATH
    """
    if sys.platform != "win32":
        return
    try:
        import nvidia  # type: ignore
    except ImportError:
        return
    nvidia_root = Path(nvidia.__file__).parent
    bin_dirs: list[str] = []
    for sub in ("cudnn", "cuda_runtime", "cublas", "cufft", "curand",
                "cusolver", "cusparse", "nvjitlink", "cuda_nvrtc"):
        bin_dir = nvidia_root / sub / "bin"
        if bin_dir.exists():
            bin_dirs.append(str(bin_dir))
    if not bin_dirs:
        return
    # 1. add_dll_directory (Windows 10+, process-scoped)
    if hasattr(os, "add_dll_directory"):
        for d in bin_dirs:
            try:
                os.add_dll_directory(d)
            except OSError:
                pass
    # 2. Prepend to PATH so subprocess and C++ LoadLibrary can find them
    cur_path = os.environ.get("PATH", "")
    new_path = os.pathsep.join(bin_dirs + [cur_path])
    os.environ["PATH"] = new_path


# Register CUDA DLL paths at import time if GPU OCR is requested — must happen
# BEFORE paddle C++ layer tries to load any CUDA-dependent library.
if os.environ.get("PADDLE_USE_GPU", "0") == "1":
    _register_cuda_dll_dirs()


def _get_ocr():
    global _ocr_instance
    if _ocr_instance is None:
        from paddleocr import PaddleOCR
        use_gpu = os.environ.get("PADDLE_USE_GPU", "0") == "1"
        _ocr_instance = PaddleOCR(
            use_angle_cls=False,
            lang="en",
            show_log=False,
            use_gpu=use_gpu,
        )
    return _ocr_instance


def _extract_frame_at(
    mp4_path: Path,
    time_sec: float,
    crop: dict[str, int] | None = None,
) -> np.ndarray | None:
    """Extract a single frame at the given time, optionally crop."""
    with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as f:
        tmp = Path(f.name)
    try:
        cmd = [
            ffmpeg_executable(), "-v", "error", "-y",
            "-ss", f"{time_sec:.3f}",
            "-i", str(mp4_path),
            "-frames:v", "1",
            "-pix_fmt", "rgb24",
            str(tmp),
        ]
        proc = subprocess.run(cmd, capture_output=True, check=False, **hidden_subprocess_kwargs())
        if proc.returncode != 0 or not tmp.exists():
            return None
        img = cv2.imread(str(tmp))
        if img is None:
            return None
        if crop:
            # Resolution-adaptive crop: treat crop coords as being relative
            # to a 1920x1080 reference and scale to actual frame size.
            # This handles downscaled videos (e.g. employee edits at 720p).
            h_img, w_img = img.shape[:2]
            sx = w_img / 1920.0
            sy = h_img / 1080.0
            x = int(round(crop["x"] * sx))
            y = int(round(crop["y"] * sy))
            w = int(round(crop["w"] * sx))
            h = int(round(crop["h"] * sy))
            # Clamp to image bounds
            x = max(0, min(x, w_img - 1))
            y = max(0, min(y, h_img - 1))
            w = max(1, min(w, w_img - x))
            h = max(1, min(h, h_img - y))
            img = img[y : y + h, x : x + w]
        return img
    finally:
        try:
            tmp.unlink()
        except OSError:
            pass


_FILENAME_TIMESTAMP_RE = re.compile(
    r"(?<!\d)(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?!\d)"
)


def parse_timestamp_from_filename(filename: str) -> datetime | None:
    """Extract datetime from camera-generated filename.

    Standard format: ``NN_NN_R_YYYYMMDDHHMMSS.ext``
    e.g. ``12_01_R_20260402103000.avi`` → 2026-04-02 10:30:00
    """
    m = _FILENAME_TIMESTAMP_RE.search(filename)
    if not m:
        return None
    try:
        y, mo, d, h, mi, s = (int(g) for g in m.groups())
        if not (2000 <= y <= 2100 and 1 <= mo <= 12 and 1 <= d <= 31
                and 0 <= h <= 23 and 0 <= mi <= 59 and 0 <= s <= 59):
            return None
        return datetime(y, mo, d, h, mi, s)
    except (ValueError, OverflowError):
        return None


_DATETIME_YMD_PATTERN = re.compile(
    r"(?<!\d)(\d{4})[:./-](\d{1,2})[:./-](\d{1,2})\s+"
    r"(\d{1,2})[:./-](\d{2})[:./-](\d{2})(?!\d)"
)
_DATETIME_DMY_MDY_PATTERN = re.compile(
    r"(?<!\d)(\d{1,2})[:./-](\d{1,2})[:./-](\d{4})"
    r"(?:\s*[-/]?\s*[A-Za-z0-9]{3,9})?\s*"
    r"(\d{1,2})[:./-](\d{2})[:./-](\d{2})(?!\d)"
)
_TIME_ONLY_PATTERN = re.compile(
    r"(?<![\d:/.-])(\d{1,2})[:./-](\d{2})[:./-](\d{2})(?![\d:/.-])"
)

# Reasonable year bounds for DVR timestamps. datetime() itself accepts
# years 1–9999, so we must reject OCR misreads like "7026" (→ year 7026)
# or "1026" (2→1 digit error) here. Using a wide band gives ±5 years of
# buffer against legitimate old footage being re-processed.
_MIN_VALID_YEAR = 2020
_MAX_VALID_YEAR = 2035

_WEEKDAY_BY_TOKEN = {
    name.lower()[:3]: idx for idx, name in enumerate(calendar.day_abbr)
}
_WEEKDAY_BY_TOKEN.update({
    name.lower()[:3]: idx for idx, name in enumerate(calendar.day_name)
})


def _weekday_token(text: str) -> str | None:
    for raw in re.findall(r"[A-Za-z]{3,9}", text):
        token = raw.lower()[:3]
        if token in _WEEKDAY_BY_TOKEN:
            return token
    return None


def _parse_dmy_mdy_match(text: str) -> datetime | None:
    m = _DATETIME_DMY_MDY_PATTERN.search(text)
    if not m:
        return None

    candidates: list[datetime] = []
    try:
        mo, d, y = int(m.group(1)), int(m.group(2)), int(m.group(3))
        h, mi, s = int(m.group(4)), int(m.group(5)), int(m.group(6))
        if _MIN_VALID_YEAR <= y <= _MAX_VALID_YEAR:
            candidates.append(datetime(y, mo, d, h, mi, s))
    except (ValueError, OverflowError):
        pass
    try:
        d, mo, y = int(m.group(1)), int(m.group(2)), int(m.group(3))
        h, mi, s = int(m.group(4)), int(m.group(5)), int(m.group(6))
        if _MIN_VALID_YEAR <= y <= _MAX_VALID_YEAR:
            candidate = datetime(y, mo, d, h, mi, s)
            if candidate not in candidates:
                candidates.append(candidate)
    except (ValueError, OverflowError):
        pass

    if not candidates:
        return None
    weekday = _weekday_token(m.group(0))
    if weekday is not None:
        matches = [
            candidate for candidate in candidates
            if candidate.weekday() == _WEEKDAY_BY_TOKEN[weekday]
        ]
        if len(matches) == 1:
            return matches[0]
        return None
    return candidates[0]


def _parse_time_from_text(text: str) -> datetime | None:
    """Try to extract datetime from OCR text.

    Handles formats like '2026-04-02 12:41:44' or just '12:41:44'.
    Rejects years outside [_MIN_VALID_YEAR, _MAX_VALID_YEAR] — OCR single-digit
    misreads on the year field are otherwise undetectable by the datetime
    constructor alone (which accepts any year 1–9999).
    """
    # Try full datetime first
    m = _DATETIME_YMD_PATTERN.search(text)
    if m:
        try:
            y, mo, d = int(m.group(1)), int(m.group(2)), int(m.group(3))
            h, mi, s = int(m.group(4)), int(m.group(5)), int(m.group(6))
            if not (_MIN_VALID_YEAR <= y <= _MAX_VALID_YEAR):
                return None
            return datetime(y, mo, d, h, mi, s)
        except (ValueError, OverflowError):
            pass
    parsed = _parse_dmy_mdy_match(text)
    if parsed is not None:
        return parsed
    if _DATETIME_DMY_MDY_PATTERN.search(text):
        return None
    # Fall back to time only
    m = _TIME_ONLY_PATTERN.search(text)
    if m:
        try:
            h, mi, s = int(m.group(1)), int(m.group(2)), int(m.group(3))
            if 0 <= h <= 23 and 0 <= mi <= 59 and 0 <= s <= 59:
                return datetime(2000, 1, 1, h, mi, s)
        except (ValueError, OverflowError):
            pass
    return None


# ── OneOCR wrapper (Microsoft's OCR from Photos app) ──────────────
# Lazy-loaded singleton. Only imported if first use triggers it.
_oneocr_engine = None


def _get_oneocr():
    """Lazy-load OneOCR engine. Returns None if not available."""
    global _oneocr_engine
    if _oneocr_engine is not None:
        return _oneocr_engine
    try:
        import oneocr
        _oneocr_engine = oneocr.OcrEngine()
    except Exception:
        _oneocr_engine = None
    return _oneocr_engine


def _ocr_region_oneocr(img: np.ndarray) -> tuple[str, float]:
    """Run OneOCR on a cropped timestamp region.

    No preprocessing — OneOCR handles varied backgrounds robustly. Crop
    height must be at least ~160px for Windows OCR minimum; caller should
    pass a TALL crop, not the 720×60 Paddle default.

    Returns (concatenated_text, avg_word_confidence) on success, ("", 0.0) on
    failure or if oneocr not installed.
    """
    if img is None or img.size == 0:
        return ("", 0.0)
    engine = _get_oneocr()
    if engine is None:
        return ("", 0.0)
    from PIL import Image
    rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
    pil = Image.fromarray(rgb)
    try:
        result = engine.recognize_pil(pil)
    except Exception:
        return ("", 0.0)
    if not isinstance(result, dict):
        return ("", 0.0)
    text = result.get("text", "").strip()
    # Average per-word confidence (OneOCR returns per-word confidence)
    confs: list[float] = []
    for line in result.get("lines", []):
        for w in line.get("words", []):
            c = w.get("confidence")
            if c is not None:
                confs.append(float(c))
    avg_conf = sum(confs) / len(confs) if confs else 0.0
    return (text, avg_conf)


def _ocr_region(img: np.ndarray) -> tuple[str, float]:
    """Primary: OneOCR (Microsoft Photos engine). Fallback: PaddleOCR.

    OneOCR hits 100% parse rate on typical DVR timestamps (verified 2026-04-16
    on HALO 6 / SAKIZAYA / guoyuan20 — 10k+ frames, 0 failures). It needs a
    crop at least ~160px tall; smaller crops return empty and trigger Paddle
    fallback. Paddle fallback exists for (a) deployment on machines without
    Photos app, (b) legacy code paths passing small crops.
    """
    if img is None or img.size == 0:
        return ("", 0.0)

    # Primary: OneOCR
    text, conf = _ocr_region_oneocr(img)
    if _parse_time_from_text(text) is not None:
        return (text, conf)

    # Fallback: PaddleOCR with full preprocessing (CLAHE + multi-threshold)
    return _ocr_region_paddle(img)


def _ocr_region_paddle(img: np.ndarray) -> tuple[str, float]:
    """PaddleOCR fallback: BGR 3× upscale, single OCR call.

    Retained as safety net for:
      1. Machines without Microsoft Photos app (no oneocr.dll)
      2. Crops too small for OneOCR (<160px tall)
      3. Emergency fallback if OneOCR model fails

    Frozen exe excludes paddleocr (build/dive_edit.spec) and dev envs may
    have a broken paddleocr install (imgaug→numpy>=2.0 ABI break). Both
    cases must degrade to ("", 0.0) instead of propagating, otherwise the
    OCR loop in main.py raises and the pipeline subprocess crashes after
    emitting a stage error, which looks like a hang.
    """
    if img is None or img.size == 0:
        return ("", 0.0)
    try:
        ocr = _get_ocr()
        scaled = cv2.resize(img, None, fx=3, fy=3, interpolation=cv2.INTER_CUBIC)
        result = ocr.ocr(scaled, cls=False)
    except (ImportError, AttributeError, OSError, RuntimeError):
        return ("", 0.0)
    if not result or not result[0]:
        return ("", 0.0)
    texts = [line[1][0] for line in result[0]]
    confs = [line[1][1] for line in result[0]]
    text = " ".join(texts).strip()
    conf = sum(confs) / len(confs) if confs else 0.0
    return (text, conf)


def _ocr_sample_points(
    mp4_path: Path,
    offsets: list[float],
    timestamp_crop: dict[str, int],
) -> list[tuple[float, datetime, str, float]]:
    """OCR at multiple offsets, return list of (offset, parsed_time, text, conf).

    Only includes offsets where parsing succeeded.
    """
    samples: list[tuple[float, datetime, str, float]] = []
    for offset in offsets:
        img = _extract_frame_at(mp4_path, offset, crop=timestamp_crop)
        text, conf = _ocr_region(img)
        parsed = _parse_time_from_text(text)
        if parsed is not None:
            samples.append((offset, parsed, text, conf))
    return samples


def _find_consistent_samples(
    samples: list[tuple[float, datetime, str, float]],
    tolerance_sec: float = 3.0,
) -> list[tuple[float, datetime, str, float]]:
    """Find the largest subset where time differences match offset differences.

    For each pair (i, j): expected (time_j - time_i) ≈ (offset_j - offset_i).
    Returns the largest consistent subset (OCR errors get dropped as outliers).
    """
    if len(samples) < 2:
        return samples

    best_subset: list[tuple[float, datetime, str, float]] = [samples[0]]
    for i in range(len(samples)):
        subset = [samples[i]]
        anchor_off, anchor_time = samples[i][0], samples[i][1]
        for j in range(len(samples)):
            if i == j:
                continue
            off_j, time_j = samples[j][0], samples[j][1]
            expected = off_j - anchor_off
            actual = (time_j - anchor_time).total_seconds()
            if abs(actual - expected) <= tolerance_sec:
                subset.append(samples[j])
        if len(subset) > len(best_subset):
            best_subset = subset
    return best_subset


def _start_time_from_samples(
    consistent: list[tuple[float, datetime, str, float]],
) -> datetime | None:
    """Given consistent (offset, time) samples, compute file start time.

    Each sample implies: start = time - offset. Take the median.
    """
    if not consistent:
        return None
    candidates = [t - timedelta(seconds=o) for o, t, _, _ in consistent]
    candidates.sort()
    return candidates[len(candidates) // 2]


def extract_file_timestamps(
    mp4_path: Path,
    duration_sec: float,
    timestamp_crop: dict[str, int] | None = None,
) -> FileTimestamp:
    """Extract DVR timestamps from only the first and last frame regions."""
    if timestamp_crop is None:
        timestamp_crop = {"x": 1200, "y": 40, "w": 720, "h": 60}

    # File ordering only needs the DVR time flow at the file boundaries.
    # Probe forward/backward in 5s steps so black frames or bad glare at
    # the exact boundary do not make ordering fall back too early.
    max_probe = min(duration_sec, 30.0)
    head_offsets = [0.5 + step for step in range(0, int(max_probe), 5)]
    tail_offsets = [duration_sec - 1.0 - step for step in range(0, int(max_probe), 5)]
    raw_offsets = [*head_offsets, *tail_offsets]
    offsets = sorted(set(
        o for o in raw_offsets if 0 <= o < duration_sec
    ))

    samples = _ocr_sample_points(mp4_path, offsets, timestamp_crop)

    if not samples:
        return FileTimestamp(
            file=mp4_path,
            first_frame_text="",
            last_frame_text="",
            first_time=None,
            last_time=None,
            confidence=0.0,
        )

    _HAS_DATE = lambda t: t.year > 2000
    date_anchor = next((t for _, t, _, _ in samples if _HAS_DATE(t)), None)
    if date_anchor is not None:
        fixed: list[tuple[float, datetime, str, float]] = []
        for off, t, txt, conf in samples:
            if not _HAS_DATE(t):
                t = t.replace(
                    year=date_anchor.year,
                    month=date_anchor.month,
                    day=date_anchor.day,
                )
            fixed.append((off, t, txt, conf))
        samples = fixed

    first_time = _start_time_from_samples(samples)
    last_time = (
        first_time + timedelta(seconds=duration_sec)
        if first_time is not None else None
    )

    first_sample = min(samples, key=lambda s: s[0]) if samples else None
    last_sample = max(samples, key=lambda s: s[0]) if samples else None
    first_text = first_sample[2] if first_sample else ""
    first_conf = first_sample[3] if first_sample else 0.0
    last_text = last_sample[2] if last_sample else ""
    last_conf = last_sample[3] if last_sample else 0.0

    avg_conf = (first_conf + last_conf) / 2 if (first_conf + last_conf) > 0 else 0.0

    return FileTimestamp(
        file=mp4_path,
        first_frame_text=first_text,
        last_frame_text=last_text,
        first_time=first_time,
        last_time=last_time,
        confidence=avg_conf,
    )


def check_monotonicity(
    timestamps: list[FileTimestamp],
    intro_file: Path | None = None,
) -> list[tuple[FileTimestamp, FileTimestamp, str]]:
    """Check that file timestamps are monotonically increasing.

    The intro file is excluded from the check — it is always placed
    first in the output regardless of recording time.

    Returns list of (file_a, file_b, reason) for violations.
    """
    violations: list[tuple[FileTimestamp, FileTimestamp, str]] = []
    sorted_ts = [
        t for t in timestamps
        if t.first_time is not None and (intro_file is None or t.file != intro_file)
    ]
    for i in range(len(sorted_ts) - 1):
        a, b = sorted_ts[i], sorted_ts[i + 1]
        if a.last_time and b.first_time:
            # Skip comparison if one has a real date and the other doesn't
            a_has_date = a.last_time.year > 2000
            b_has_date = b.first_time.year > 2000
            if a_has_date != b_has_date:
                continue
            # Burned-in DVR timestamps are second-resolution and adjacent
            # files can legitimately share the same boundary second. Treat
            # only a real backward jump beyond one second as a regression.
            delta_sec = (b.first_time - a.last_time).total_seconds()
            if delta_sec < -1.0:
                fmt = "%Y-%m-%d %H:%M:%S" if a.last_time.year > 2000 else "%H:%M:%S"
                violations.append((
                    a, b,
                    f"{a.file.name} ends at {a.last_time.strftime(fmt)} "
                    f"but {b.file.name} starts at {b.first_time.strftime(fmt)}"
                ))
    return violations
