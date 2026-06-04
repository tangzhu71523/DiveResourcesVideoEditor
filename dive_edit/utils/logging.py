"""Structured logger for the pipeline.

Writes to <job>/_logs/run.log and stdout simultaneously. Every line
carries an absolute timestamp so post-mortem timing analysis works
even across subprocess boundaries.

Format: HH:MM:SS.mmm [LEVEL] message
"""
from __future__ import annotations
import sys
import time
from pathlib import Path
from typing import TextIO


def _ts() -> str:
    """Local time with millisecond precision."""
    t = time.time()
    return time.strftime("%H:%M:%S", time.localtime(t)) + f".{int((t % 1) * 1000):03d}"


class JobLogger:
    def __init__(self, log_file: Path | None = None) -> None:
        self._fp: TextIO | None = None
        if log_file is not None:
            log_file.parent.mkdir(parents=True, exist_ok=True)
            self._fp = log_file.open("a", encoding="utf-8")
            self._write_line(
                "\n========== run @ "
                + time.strftime("%Y-%m-%d %H:%M:%S")
                + " =========="
            )

    def _write_line(self, line: str) -> None:
        print(line, flush=True)
        if self._fp is not None:
            self._fp.write(line + "\n")
            self._fp.flush()

    def info(self, msg: str) -> None:
        self._write_line(f"{_ts()} [INFO ] {msg}")

    def step(self, n: int, total: int, msg: str) -> None:
        # Format kept compatible with runner.py _STEP_RE — the literal
        # "Step N/M:" substring is what the WS parser keys on to fire
        # stage-transition events to the frontend progress bar.
        self._write_line(f"{_ts()} [STEP ] Step {n}/{total}: {msg}")

    def warn(self, msg: str) -> None:
        self._write_line(f"{_ts()} [WARN ] {msg}")

    def error(self, msg: str) -> None:
        self._write_line(f"{_ts()} [ERROR] {msg}")

    def debug(self, msg: str) -> None:
        """Free-form structured-data dump for evidence/debug purposes.

        Use to record raw inputs/outputs of significant calls (subprocess
        argv, manifest content, returncode, env subsets, exception text)
        so a copy of the log is enough to reconstruct what happened
        without rerunning the pipeline.
        """
        self._write_line(f"{_ts()} [DEBUG] {msg}")

    def kv(self, prefix: str, **kwargs) -> None:
        """Single-line key=value record. Long values are truncated to 200
        chars with a '...' marker — full value still goes through repr()
        so quoting is preserved for grep-ability.
        """
        parts = []
        for k, v in kwargs.items():
            r = repr(v)
            if len(r) > 200:
                r = r[:200] + "...<truncated>"
            parts.append(f"{k}={r}")
        self._write_line(f"{_ts()} [DEBUG] {prefix} " + " ".join(parts))

    def close(self) -> None:
        if self._fp is not None:
            self._fp.close()
            self._fp = None
