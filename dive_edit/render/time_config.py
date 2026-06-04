"""Interface 3: time / duration knobs.

Single source of truth for every time-related decision in the pipeline:
EDL Tier 3 convergence target, cover overlay duration, intro segment trim.

Precedence (lowest → highest): config.yaml defaults → job.yaml → CLI flag.
"""
from __future__ import annotations
from dataclasses import dataclass
from typing import Any


@dataclass
class TimeConfig:
    target_duration_min: int = 60          # asked interactively
    min_duration_min: int = 50             # below this we don't pad
    max_duration_min: int = 70             # above this we force-shrink
    cover_duration_sec: int = 30           # fixed cover overlay duration
    intro_lead_in_sec: int = 10            # silence before first word
    intro_audio_scan_sec: int = 600
    intro_speech_override: tuple[float, float] | None = None  # (start, end), bypass whisper

    @property
    def target_sec(self) -> int:
        return self.target_duration_min * 60

    @property
    def min_sec(self) -> int:
        return self.min_duration_min * 60

    @property
    def max_sec(self) -> int:
        return self.max_duration_min * 60

    @classmethod
    def from_dicts(cls, *, defaults: dict[str, Any], job: dict[str, Any] | None = None) -> "TimeConfig":
        """Merge config.yaml `time:` block with job.yaml overrides."""
        merged: dict[str, Any] = dict(defaults or {})
        if job:
            for k, v in job.items():
                if v is not None:
                    merged[k] = v

        override = merged.get("intro_speech_override")
        if isinstance(override, (list, tuple)) and len(override) == 2:
            override = (float(override[0]), float(override[1]))
        else:
            override = None

        return cls(
            target_duration_min=int(merged.get("target_duration_min", 60)),
            min_duration_min=int(merged.get("min_duration_min", 50)),
            max_duration_min=int(merged.get("max_duration_min", 70)),
            cover_duration_sec=int(merged.get("cover_duration_sec", 30)),
            intro_lead_in_sec=int(merged.get("intro_lead_in_sec", 10)),
            intro_audio_scan_sec=int(merged.get("intro_audio_scan_sec", 600)),
            intro_speech_override=override,
        )
