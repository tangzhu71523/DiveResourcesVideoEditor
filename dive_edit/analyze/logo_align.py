"""Top-right logo y-alignment via OCR.

Abstract: probe an intro / first-segment frame with OneOCR, grab the burned-in
timestamp word's bbox, and emit an ffmpeg `overlay` filter (x, y) expression
pair so the logo's vertical center lines up with the timestamp's vertical
center. Horizontal position is anchored 40px from the right edge per spec
(用户 2026-05-13 要求 logo y 对齐烧录时间中线、距右 40px)。

Returns None on any failure → caller falls back to config.yaml default
`overlay.logo_xy`.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

import cv2  # type: ignore
import numpy as np  # type: ignore

from .ocr_timestamp import _extract_frame_at, _get_oneocr, _parse_time_from_text


def _ocr_timestamp_bbox(crop_img: np.ndarray) -> tuple[int, int, int, int] | None:
    """OneOCR on a crop, return the bounding rect of the first line that
    parses as a datetime / time string. Coords are RELATIVE TO THE CROP.

    Format: (x, y, w, h). None if nothing parses.
    """
    if crop_img is None or crop_img.size == 0:
        return None
    engine = _get_oneocr()
    if engine is None:
        return None
    from PIL import Image
    rgb = cv2.cvtColor(crop_img, cv2.COLOR_BGR2RGB)
    pil = Image.fromarray(rgb)
    try:
        result = engine.recognize_pil(pil)
    except Exception:
        return None
    if not isinstance(result, dict):
        return None
    for line in result.get("lines", []):
        text = line.get("text", "") or ""
        if _parse_time_from_text(text) is None:
            # Some sources OCR the date and time as two adjacent lines;
            # try joining surrounding lines via the engine's full text.
            continue
        rect = line.get("bounding_rect") or line.get("boundingRect") or {}
        x = int(rect.get("x", rect.get("left", 0)) or 0)
        y = int(rect.get("y", rect.get("top", 0)) or 0)
        w = int(rect.get("width", rect.get("w", 0)) or 0)
        h = int(rect.get("height", rect.get("h", 0)) or 0)
        if w > 0 and h > 0:
            return (x, y, w, h)
    # Engine-level fallback: try the full top-level rect if engine returned
    # one (rare) and the joined text parses.
    full_text = result.get("text", "") or ""
    if _parse_time_from_text(full_text) is not None:
        rect = result.get("bounding_rect") or {}
        if rect:
            return (
                int(rect.get("x", 0) or 0),
                int(rect.get("y", 0) or 0),
                int(rect.get("width", 0) or 0),
                int(rect.get("height", 0) or 0),
            )
    return None


def _probe_dims(mp4_path: Path) -> tuple[int, int] | None:
    """ffprobe → (width, height) in raw pixels. None on failure."""
    import json
    import subprocess
    try:
        proc = subprocess.run(
            [
                "ffprobe", "-v", "error",
                "-select_streams", "v:0",
                "-show_entries", "stream=width,height",
                "-of", "json", str(mp4_path),
            ],
            capture_output=True, text=True, check=True,
        )
        data = json.loads(proc.stdout or "{}")
        streams = data.get("streams") or []
        if not streams:
            return None
        w = int(streams[0].get("width", 0) or 0)
        h = int(streams[0].get("height", 0) or 0)
        return (w, h) if w > 0 and h > 0 else None
    except (subprocess.CalledProcessError, ValueError, FileNotFoundError, OSError):
        return None


def compute_logo_xy(
    mp4_path: Path,
    *,
    sample_offsets: tuple[float, ...] = (1.5, 3.0, 6.0),
    crop_baseline: dict[str, int] | None = None,
    right_margin_px: int = 40,
) -> tuple[str, str] | None:
    """Return ffmpeg overlay filter (x_expr, y_expr) so the logo's vertical
    center aligns with the burned-in timestamp's vertical center. None if
    OCR couldn't locate a parseable timestamp on any sample offset.

    x_expr  = f"W-w-{right_margin_px}"   distance from right edge fixed
    y_expr  = f"(H*{ratio:.6f})-h/2"     ratio = ts_center_y / source_h →
                                          libass-style scaling so the same
                                          y center applies across any
                                          target frame height.

    crop_baseline defaults to the OCR module's standard search box
    {x:1200, y:40, w:720, h:60} in 1920×1080 coords. `_extract_frame_at`
    rescales this to the source's actual dims internally.
    """
    if crop_baseline is None:
        crop_baseline = {"x": 1200, "y": 40, "w": 720, "h": 60}

    dims = _probe_dims(mp4_path)
    if dims is None:
        return None
    src_w, src_h = dims
    sx = src_w / 1920.0
    sy = src_h / 1080.0
    crop_y_in_source = int(round(crop_baseline["y"] * sy))

    for off in sample_offsets:
        crop_img = _extract_frame_at(mp4_path, off, crop=crop_baseline)
        if crop_img is None:
            continue
        bbox = _ocr_timestamp_bbox(crop_img)
        if bbox is None:
            continue
        _bx, by, _bw, bh = bbox
        ts_center_y_in_source = crop_y_in_source + by + bh / 2.0
        ratio = max(0.0, min(1.0, ts_center_y_in_source / src_h))
        return (f"W-w-{right_margin_px}", f"(H*{ratio:.6f})-h/2")
    return None


def apply_logo_align(overlay_cfg: dict[str, Any], mp4_path: Path) -> dict[str, Any]:
    """Mutate-and-return: if compute_logo_xy succeeds, replace
    `logo_xy` in a *copied* overlay_cfg so callers can keep the original
    cfg dict untouched. No-op fallback returns the original cfg as-is."""
    xy = compute_logo_xy(mp4_path)
    if xy is None:
        return overlay_cfg
    out = dict(overlay_cfg)
    out["logo_xy"] = [xy[0], xy[1]]
    return out
