"""Generate an ASS subtitle file so cover + small text can be rendered via
libass (ffmpeg `subtitles=` filter) instead of burning via drawtext.

WYSIWYG benefit: the same ASS can be previewed by libass.js in the browser
and later baked into the final video by ffmpeg — pixel-identical results.
"""
from __future__ import annotations
from pathlib import Path
from typing import Any


# ── Colour helpers ────────────────────────────────────────────

_NAMED_COLORS: dict[str, str] = {
    "white":   "FFFFFF",
    "black":   "000000",
    "red":     "FF0000",
    "green":   "00FF00",
    "blue":    "0000FF",
    "yellow":  "FFFF00",
    "cyan":    "00FFFF",
    "magenta": "FF00FF",
    "gray":    "808080",
    "grey":    "808080",
}


def color_to_ass(c: str) -> str:
    """Convert a colour string (named or '#RRGGBB') to ASS '&H00BBGGRR' format.

    ASS colour is AABBGGRR in hex, where AA=alpha (00 = opaque). Most
    configs use simple names like "white"/"black" — we normalise those too.
    """
    raw = c.strip()
    if raw.startswith("#") and len(raw) == 7:
        rr, gg, bb = raw[1:3], raw[3:5], raw[5:7]
    else:
        hex6 = _NAMED_COLORS.get(raw.lower(), "FFFFFF")
        rr, gg, bb = hex6[0:2], hex6[2:4], hex6[4:6]
    return f"&H00{bb.upper()}{gg.upper()}{rr.upper()}"


def ass_time(sec: float) -> str:
    """Format seconds as ASS `H:MM:SS.cs` (centiseconds)."""
    sec = max(0.0, sec)
    h = int(sec // 3600)
    m = int((sec % 3600) // 60)
    s = sec - h * 3600 - m * 60
    return f"{h}:{m:02d}:{s:05.2f}"


def _escape_ass_text(s: str) -> str:
    """Escape a single line for ASS Dialogue text.

    Newlines become the ASS hard-break `\\N`. `{` is reserved for override
    blocks so we escape it; backslashes in user text are uncommon but safe
    to leave alone — ASS ignores unknown `\\X` sequences.
    """
    out = s.replace("{", "\\{").replace("}", "\\}")
    # Callers pass individual logical lines; we still protect embedded LFs
    # so multi-line items from a textarea survive.
    out = out.replace("\r\n", "\n").replace("\n", "\\N")
    return out


def font_name_from_path(font_path: str) -> tuple[str, int, int]:
    """Infer (fontname, bold, italic) from a Windows font file path.

    `arialbd.ttf` → ("Arial", -1, 0) ; `arial.ttf` → ("Arial", 0, 0).
    Conservative: unknown paths fall back to ("Arial", -1, 0).
    ASS booleans: -1 = true, 0 = false.
    """
    name = Path(font_path).stem.lower()
    if "bd" in name or "bold" in name:
        family = name.replace("bd", "").replace("bold", "").strip("_- ")
        return (family.capitalize() or "Arial", -1, 0)
    return (name.capitalize() or "Arial", 0, 0)


# ── Main builder ──────────────────────────────────────────────


def build_overlay_ass(
    *,
    cover_lines: list[str],
    small_lines: list[str],
    intro_duration_sec: float,
    total_duration_sec: float,
    cover_cfg: dict[str, Any],
    overlay_cfg: dict[str, Any],
    assets_cfg: dict[str, Any],
    cover_overlay: dict[str, Any] | None = None,
    small_overlay: dict[str, Any] | None = None,
    play_res_x: int = 1920,
    play_res_y: int = 1080,
    reserved_top_h: int = 80,
    reserved_bottom_h: int = 60,
) -> str:
    """Return the full text of an ASS file covering the whole rendered output.

    Timeline:
      - 0..intro_duration_sec: show `cover_lines` (centered, big).
      - intro_duration_sec..total_duration_sec: show `small_lines` (top-left).

    cover_overlay / small_overlay (per-job tweaks from the UI) override the
    config defaults for font_size / line_spacing / letter_spacing / position.
    Position is interpreted as a pixel offset from the element's natural
    anchor (cover = canvas center, small = top-left + cfg.small_xy).
    """
    font_path = str(assets_cfg.get("font_path", "C:/Windows/Fonts/arialbd.ttf"))
    fontname, bold, italic = font_name_from_path(font_path)

    co = cover_overlay or {}
    so = small_overlay or {}

    # ── Baseline → target scaling ────────────────────────────────────
    # frontend 把 position_x/y / font_size / line_spacing / letter_spacing 都
    # 按 1920×1080 baseline 存(preview cqw/cqh 也基于此 baseline)。export 走
    # `_compute_target_dims` 选出来的 target_w×target_h 可能 ≠ 1920×1080
    # (4:3 anamorphic / 21:9 等)。这里把 baseline 数值统一乘 bx/by 缩放到
    # target,让 libass 输出帧里的视觉位置 / 字号比例跟 preview 完全一致。
    # 用户 2026-05-13 要求"PreviewBox 动态边界,overlay 坐标随视频边界变化"。
    bx = play_res_x / 1920.0
    by = play_res_y / 1080.0
    cw = float(co.get("whole_scale", 1.0))
    cover_font_size = int(round(float(co.get("font_size", cover_cfg.get("font_size", 72))) * cw * by))
    cover_line_spacing = int(round(float(co.get("line_spacing", cover_cfg.get("line_spacing", 22))) * cw * by))
    cover_letter_spacing = int(round(float(co.get("letter_spacing", 0)) * cw * by))
    cover_pos_x = float(co.get("position_x", 0.0)) * bx
    cover_pos_y = float(co.get("position_y", 0.0)) * by
    cover_box_width_pct = max(20.0, min(100.0, float(co.get("box_width", 98.0))))
    cover_box_width_px = int(round(cover_box_width_pct / 100.0 * play_res_x))
    cover_margin_lr = max(0, (play_res_x - cover_box_width_px) // 2)
    cover_scale_x = 100
    cover_scale_y = 100
    cover_border = int(round(int(cover_cfg.get("border_width", 6)) * by))
    cover_font_color = color_to_ass(str(cover_cfg.get("font_color", "white")))
    cover_outline_color = color_to_ass(str(cover_cfg.get("border_color", "black")))

    # Auto-shrink cover so 11+ lines don't render with overlapping text.
    # libass uses the FONT'S natural line metric (~1.25× font_size for
    # Arial), NOT just font_size, for line height — so the previous
    # shrink that assumed line height = font_size+line_spacing was off
    # by 25% and produced visible overlap on dense covers.
    LINE_METRIC = 1.25
    reserved_top_scaled = int(round(reserved_top_h * by))
    reserved_bottom_scaled = int(round(reserved_bottom_h * by))
    n = len(cover_lines)
    if n > 0:
        available_h = play_res_y - reserved_top_scaled - reserved_bottom_scaled
        max_line_h = available_h // n
        # \fs override budget so that fs × LINE_METRIC ≤ max_line_h
        fs_budget = int(max_line_h / LINE_METRIC)
        needed_fs = cover_font_size + cover_line_spacing
        if needed_fs > fs_budget:
            # Try shrinking line_spacing first so font_size stays intent.
            if cover_font_size <= fs_budget:
                cover_line_spacing = max(0, fs_budget - cover_font_size)
            else:
                # Even bare font exceeds budget → shrink font, drop line_spacing.
                cover_font_size = max(int(round(20 * by)), fs_budget)
                cover_line_spacing = 0

    sw = float(so.get("whole_scale", 1.0))
    small_font_size = int(round(float(so.get("font_size", overlay_cfg.get("small_font_size", 32))) * sw * by))
    small_letter_spacing = int(round(float(so.get("letter_spacing", 0)) * sw * by))
    small_pos_x_delta = float(so.get("position_x", 0.0)) * bx
    small_pos_y_delta = float(so.get("position_y", 0.0)) * by
    small_box_width_pct = max(20.0, min(100.0, float(so.get("box_width", 50.0))))
    small_box_width_px = int(round(small_box_width_pct / 100.0 * play_res_x))
    small_scale_x = 100
    small_scale_y = 100
    small_border = int(round(int(overlay_cfg.get("small_border_width", 3)) * by))
    small_font_color = color_to_ass(str(overlay_cfg.get("small_font_color", "white")))
    small_outline_color = color_to_ass(str(overlay_cfg.get("small_border_color", "black")))
    small_xy = overlay_cfg.get("small_xy", [12, 12])
    small_anchor_x = int(round(int(small_xy[0]) * bx))
    small_anchor_y = int(round(int(small_xy[1]) * by))

    # Final \pos(x,y) targets — cover_pos_*/small_pos_*_delta 已乘 bx/by 缩放,
    # 这里只做 baseline anchor + 偏移叠加。
    cover_pos_final_x = play_res_x // 2 + int(cover_pos_x)
    cover_pos_final_y = play_res_y // 2 + int(cover_pos_y)
    small_pos_final_x = small_anchor_x + int(small_pos_x_delta)
    small_pos_final_y = small_anchor_y + int(small_pos_y_delta)

    # Letter-spacing now drives the ASS Spacing field directly (see Style
    # block below) — no \h padding hack needed. Just escape each line.

    # Pre-wrap each input line to box width. Manual wrap (textwrap) gives
    # deterministic results regardless of how libass handles MarginL/R when
    # \pos is used. avg_char = font * 0.55 is a rough Arial Bold proportion.
    import textwrap

    def _wrap_to_box(lines: list[str], box_px: int, font_px: int) -> list[str]:
        if box_px >= play_res_x - 20:
            return [l for l in lines if l is not None]
        avg_char = max(6, font_px * 0.55)
        max_chars = max(6, int(box_px / avg_char))
        out: list[str] = []
        for ln in lines:
            if ln is None:
                continue
            if not ln.strip():
                out.append(ln)
                continue
            parts = textwrap.wrap(ln, width=max_chars, break_long_words=True)
            out.extend(parts if parts else [ln])
        return out

    cover_lines_wrapped = _wrap_to_box(list(cover_lines), cover_box_width_px, cover_font_size)
    small_lines_wrapped = _wrap_to_box(list(small_lines), small_box_width_px, small_font_size)

    # Re-run auto-shrink on the *post-wrap* line count so dense narrow boxes
    # still fit vertically.
    n_after = len(cover_lines_wrapped)
    if n_after > 0 and n_after != n:
        available_h = play_res_y - reserved_top_scaled - reserved_bottom_scaled
        max_line_h = available_h // n_after
        fs_budget = int(max_line_h / LINE_METRIC)
        needed_fs = cover_font_size + cover_line_spacing
        if needed_fs > fs_budget:
            if cover_font_size <= fs_budget:
                cover_line_spacing = max(0, fs_budget - cover_font_size)
            else:
                cover_font_size = max(int(round(20 * by)), fs_budget)
                cover_line_spacing = 0

    cover_text = "\\N".join(_escape_ass_text(l) for l in cover_lines_wrapped)
    small_text = "\\N".join(_escape_ass_text(l) for l in small_lines_wrapped)

    # Header
    hdr = [
        "[Script Info]",
        "ScriptType: v4.00+",
        f"PlayResX: {play_res_x}",
        f"PlayResY: {play_res_y}",
        "WrapStyle: 0",
        "ScaledBorderAndShadow: yes",
        "YCbCr Matrix: TV.709",
        "",
    ]

    # Styles. Alignment: 5 = center middle, 7 = top left (numpad layout).
    # ASS Spacing field = extra letter-spacing in pixels.
    styles = [
        "[V4+ Styles]",
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, "
        "OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, "
        "ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, "
        "Alignment, MarginL, MarginR, MarginV, Encoding",
        # Cover: bigger + thicker outline; centered by Alignment=5, position
        # set per-dialogue via \pos override. Spacing field = letter_spacing.
        (
            f"Style: Cover,{fontname},{cover_font_size},{cover_font_color},"
            f"{cover_font_color},{cover_outline_color},{cover_outline_color},"
            f"{bold},{italic},0,0,{cover_scale_x},{cover_scale_y},"
            f"{cover_letter_spacing},0,1,"
            f"{cover_border},0,5,10,10,10,1"
        ),
        # Small: top-left anchor (Alignment=7), position set per-dialogue
        # via \pos override. Spacing field = letter_spacing.
        (
            f"Style: Small,{fontname},{small_font_size},{small_font_color},"
            f"{small_font_color},{small_outline_color},{small_outline_color},"
            f"{bold},{italic},0,0,{small_scale_x},{small_scale_y},"
            f"{small_letter_spacing},0,1,"
            f"{small_border},0,7,10,10,10,1"
        ),
        "",
    ]

    # Events. Line-height inside the Cover block is controlled by fontsize only in
    # libass (it has no line_spacing field). We emulate the old visual by bumping
    # fontsize to include the intended extra pixels per line.
    events: list[str] = [
        "[Events]",
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ]

    if cover_text and intro_duration_sec > 0:
        events.append(
            f"Dialogue: 0,{ass_time(0.0)},{ass_time(intro_duration_sec)},"
            f"Cover,,0,0,0,,"
            f"{{\\pos({cover_pos_final_x},{cover_pos_final_y})"
            f"\\fs{cover_font_size + cover_line_spacing}}}{cover_text}"
        )

    if small_text and total_duration_sec > intro_duration_sec:
        events.append(
            f"Dialogue: 0,{ass_time(intro_duration_sec)},{ass_time(total_duration_sec)},"
            f"Small,,0,0,0,,"
            f"{{\\pos({small_pos_final_x},{small_pos_final_y})}}{small_text}"
        )

    return "\n".join(hdr + styles + events) + "\n"


# ── Path escaping for ffmpeg subtitles= filter ────────────────


def escape_subtitles_path(path: Path | str) -> str:
    """Escape a Windows path for embedding in the `subtitles=filename=...` arg.

    ffmpeg filtergraph: colons are option separators, so `C:/foo` must become
    `C\\:/foo`. Backslashes are also used as escapes — normalise to forward
    slashes first. Single quotes must be escaped because we wrap the value in
    single quotes.
    """
    s = str(path).replace("\\", "/")
    # Inside single quotes the only special char we must escape is ':' (for
    # filter option parsing) and "'" itself.
    s = s.replace(":", "\\:").replace("'", r"\'")
    return s
