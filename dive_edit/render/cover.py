"""Interface 1: cover renderer.

Builds the ffmpeg drawtext filter chain for the big multi-line cover that
overlays the intro segment while the diver is speaking.
"""
from __future__ import annotations
from dataclasses import dataclass
from typing import Any, Protocol


def escape_drawtext(s: str) -> str:
    """Escape user text for ffmpeg drawtext `text=` parameter.

    drawtext consumes filtergraph syntax — colons, commas, single-quotes,
    backslashes and percents all need escaping.
    """
    out = s.replace("\\", "\\\\")
    out = out.replace("%", "\\%")
    out = out.replace(":", "\\:")
    out = out.replace("'", "\u2019")  # easier than escaping in ffmpeg expression
    out = out.replace(",", "\\,")
    return out


def normalize_font_path(path: str) -> str:
    """Prepare a font path for an ffmpeg drawtext `fontfile=` value.

    ffmpeg filter_complex_script parses `:` as option separator with no shell
    quoting protection, so a Windows drive letter like `C:/` must have the
    colon backslash-escaped. Forward slashes also work better than backslashes.
    """
    return path.replace("\\", "/").replace(":", r"\:")


class CoverRenderer(Protocol):
    def build_filter(
        self,
        *,
        lines: list[str],
        start_sec: float,
        end_sec: float,
        font_path: str,
        font_size: int,
        line_spacing: int,
        font_color: str,
        border_color: str,
        border_width: int,
    ) -> str:
        ...


@dataclass
class DefaultCoverRenderer:
    """7-line centered white-with-black-stroke cover, matching screenshot 1."""

    def build_filter(
        self,
        *,
        lines: list[str],
        start_sec: float,
        end_sec: float,
        font_path: str,
        font_size: int,
        line_spacing: int,
        font_color: str = "white",
        border_color: str = "black",
        border_width: int = 3,
    ) -> str:
        if not lines:
            return "null"

        n = len(lines)
        line_h = font_size + line_spacing
        # Top of first line: centered as a block
        # y of line i = (h - n*line_h)/2 + i*line_h
        font = normalize_font_path(font_path)
        enable = f"between(t,{start_sec:.3f},{end_sec:.3f})"

        chains: list[str] = []
        for i, raw in enumerate(lines):
            text = escape_drawtext(raw)
            y_expr = f"(h-{n*line_h})/2+{i*line_h}"
            chain = (
                f"drawtext=fontfile='{font}'"
                f":text='{text}'"
                f":fontcolor={font_color}"
                f":fontsize={font_size}"
                f":borderw={border_width}"
                f":bordercolor={border_color}"
                f":x=(w-text_w)/2"
                f":y={y_expr}"
                f":enable='{enable}'"
            )
            chains.append(chain)
        return ",".join(chains)


def cover_filter_from_config(
    *,
    lines: list[str],
    start_sec: float,
    end_sec: float,
    assets_cfg: dict[str, Any],
    cover_cfg: dict[str, Any],
    frame_h: int = 1080,
    reserved_top_h: int = 80,     # timestamp area top-right
    reserved_bottom_h: int = 60,  # cam01 label bottom-left
    logger=None,
) -> str:
    """Convenience: build cover filter using global config dicts.

    Auto-shrinks line_spacing when the title block would overlap the
    burned-in timestamp (top) or camera label (bottom) due to many
    cover_lines (e.g. 11-line SAKIZAYA cover at font_size=72).
    """
    font_size = int(cover_cfg.get("font_size", 36))
    line_spacing = int(cover_cfg.get("line_spacing", 14))

    n = len(lines)
    if n > 0:
        available_h = frame_h - reserved_top_h - reserved_bottom_h
        max_line_h = available_h // n
        needed_line_h = font_size + line_spacing
        if needed_line_h > max_line_h:
            new_spacing = max(0, max_line_h - font_size)
            if logger:
                logger.info(
                    f"  [cover] {n} lines exceed available height; line_spacing "
                    f"{line_spacing}->{new_spacing}"
                )
            line_spacing = new_spacing

    return DefaultCoverRenderer().build_filter(
        lines=lines,
        start_sec=start_sec,
        end_sec=end_sec,
        font_path=str(assets_cfg.get("font_path", "C:/Windows/Fonts/arialbd.ttf")),
        font_size=font_size,
        line_spacing=line_spacing,
        font_color=str(cover_cfg.get("font_color", "white")),
        border_color=str(cover_cfg.get("border_color", "black")),
        border_width=int(cover_cfg.get("border_width", 3)),
    )
