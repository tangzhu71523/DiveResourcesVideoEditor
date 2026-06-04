"""Lightweight source-file timeline metadata used by EDL generation."""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path


@dataclass
class FileTimeline:
    file: Path
    fps: float
    duration_sec: float
