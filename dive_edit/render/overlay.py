"""Interface 2: body-segment overlay renderer.

Builds the ffmpeg filter chain that adds the small top-left subtitle text
and the top-right logo to every body segment. Returns:

  - A drawtext-only filter that takes a video stream and outputs a stream
    with small text drawn (no logo).
  - The logo overlay must be applied separately because the logo is a
    separate ffmpeg input stream — see ffmpeg_runner for how it's wired in.
"""
from __future__ import annotations
from dataclasses import dataclass
from typing import Any, Protocol

from .cover import escape_drawtext, normalize_font_path


class OverlayRenderer(Protocol):
    def build_text_filter(
        self,
        *,
        small_lines: list[str],
        font_path: str,
        font_size: int,
        line_spacing: int,
        x: int,
        y: int,
        font_color: str,
        border_color: str,
        border_width: int,
    ) -> str:
        ...

    def logo_xy_expr(self) -> tuple[str, str]:
        ...

    def logo_max_height(self) -> int:
        ...


@dataclass
class DefaultOverlayRenderer:
    """Top-left multi-line text + top-right logo (logo wired by runner)."""

    logo_xy_x: str = "W-w-8"
    logo_xy_y: str = "8"
    logo_height: int = 56

    def build_text_filter(
        self,
        *,
        small_lines: list[str],
        font_path: str,
        font_size: int,
        line_spacing: int,
        x: int,
        y: int,
        font_color: str = "white",
        border_color: str = "black",
        border_width: int = 1,
    ) -> str:
        if not small_lines:
            return "null"
        font = normalize_font_path(font_path)
        line_h = font_size + line_spacing

        chains: list[str] = []
        for i, raw in enumerate(small_lines):
            text = escape_drawtext(raw)
            chain = (
                f"drawtext=fontfile='{font}'"
                f":text='{text}'"
                f":fontcolor={font_color}"
                f":fontsize={font_size}"
                f":borderw={border_width}"
                f":bordercolor={border_color}"
                f":x={x}"
                f":y={y + i*line_h}"
            )
            chains.append(chain)
        return ",".join(chains)

    def logo_xy_expr(self) -> tuple[str, str]:
        return (self.logo_xy_x, self.logo_xy_y)

    def logo_max_height(self) -> int:
        return self.logo_height


def overlay_renderer_from_config(overlay_cfg: dict[str, Any]) -> DefaultOverlayRenderer:
    xy = overlay_cfg.get("logo_xy", ["W-w-8", 8])
    return DefaultOverlayRenderer(
        logo_xy_x=str(xy[0]),
        logo_xy_y=str(xy[1]),
        logo_height=int(overlay_cfg.get("logo_max_height", 56)),
    )


def small_text_filter_from_config(
    *,
    small_lines: list[str],
    assets_cfg: dict[str, Any],
    overlay_cfg: dict[str, Any],
) -> str:
    xy = overlay_cfg.get("small_xy", [12, 12])
    return DefaultOverlayRenderer().build_text_filter(
        small_lines=small_lines,
        font_path=str(assets_cfg.get("font_path", "C:/Windows/Fonts/arialbd.ttf")),
        font_size=int(overlay_cfg.get("small_font_size", 16)),
        line_spacing=int(overlay_cfg.get("small_line_spacing", 4)),
        x=int(xy[0]),
        y=int(xy[1]),
        font_color=str(overlay_cfg.get("small_font_color", "white")),
        border_color=str(overlay_cfg.get("small_border_color", "black")),
        border_width=int(overlay_cfg.get("small_border_width", 1)),
    )
