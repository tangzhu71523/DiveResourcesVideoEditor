"""Background pipeline runner that the webui exposes as /api/run and WS /ws/logs.

One global RunManager holds active jobs. Each job is a subprocess of
`python -m dive_edit.main --job <folder>`; stdout lines are parsed into
structured StageEvent / LogEvent messages and fan-out to WebSocket
subscribers via an asyncio.Queue.

Restart-safe: jobs are NOT persisted across server restarts. If the web
server crashes mid-run, the subprocess keeps running (detached) but the
UI loses live progress; user can still read _logs/run.log after the fact.
"""
from __future__ import annotations

import asyncio
import os
import re
import subprocess
import sys
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


# ── Output-line parsing (JobLogger format, see dive_edit/utils/logging.py) ──

# Stage transition. Logger now prepends "HH:MM:SS.mmm [STEP ] " to step
# lines, so the regex looks for the "Step N/M:" substring anywhere on
# the line rather than anchoring to start-of-line.
_STEP_RE = re.compile(r"Step\s+(\d+)\s*/\s*(\d+)\s*:\s*(.+)$")

# Per-file progress — main pipeline emits "[i/N] <action> <filename>",
# and audio.py emits "[i/N] worker started/done" for parallel workers.
_PROGRESS_RE = re.compile(r"\[(\d+)\s*/\s*(\d+)\]")

# Map pipeline step index → frontend PipelineStage identifier.
_STEP_TO_STAGE = {
    1: "whisper",
    2: "intro",
    3: "ocr",
    4: "edl",
    5: "render",
}


@dataclass
class Event:
    """Wire-level event shape — matches the WS payload the frontend expects."""
    type: str                   # "log" | "stage" | "done" | "error"
    data: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {"type": self.type, **self.data}


@dataclass
class RunJob:
    job_id: str
    folder: Path
    proc: subprocess.Popen[str]
    queue: asyncio.Queue[Event]
    loop: asyncio.AbstractEventLoop
    started_at: float
    # Final outcome (set when process exits):
    exit_code: int | None = None
    ended_at: float | None = None
    # Tracked per-stage state so we can fire "done" events when stage N+1 starts.
    current_stage: str | None = None
    current_stage_step: int = 0


def _windows_creationflags() -> int:
    if os.name != "nt":
        return 0
    flags = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
    flags |= getattr(subprocess, "CREATE_NO_WINDOW", 0)
    return flags


def _kill_process_tree(proc: subprocess.Popen[str]) -> bool:
    if proc.poll() is not None:
        return True
    killed = False
    if os.name == "nt":
        flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        try:
            result = subprocess.run(
                ["taskkill", "/PID", str(proc.pid), "/T", "/F"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                creationflags=flags,
                check=False,
            )
            killed = result.returncode == 0 or proc.poll() is not None
        except OSError:
            pass
    if not killed:
        try:
            import psutil  # type: ignore

            root = psutil.Process(proc.pid)
            children = root.children(recursive=True)
            for child in children:
                try:
                    child.kill()
                except psutil.Error:
                    pass
            try:
                root.kill()
            except psutil.Error:
                pass
            psutil.wait_procs([root, *children], timeout=3)
            killed = proc.poll() is not None or not psutil.pid_exists(proc.pid)
        except Exception:
            pass
    if killed:
        return True
    try:
        proc.kill()
        return True
    except OSError:
        return False


def _force_kill_if_alive(proc: subprocess.Popen[str]) -> None:
    if proc.poll() is not None:
        return
    if os.name == "nt":
        _kill_process_tree(proc)
        return
    try:
        proc.kill()
    except OSError:
        pass


def _parse_line(line: str, current_step: int) -> tuple[Event | None, int]:
    """Inspect a raw stdout line and return a structured event if it's
    meaningful, plus the updated current_step counter.

    Returning None means "just a log line, no state change".
    """
    # Stage transition — highest priority. Must use .search() not .match()
    # because the JobLogger now prepends "HH:MM:SS.mmm [STEP ]" before the
    # "Step N/M:" substring; .match() anchors at line start regardless of
    # any regex internals, so it never matched the new format and stage
    # transitions never fired.
    m_step = _STEP_RE.search(line)
    if m_step:
        step = int(m_step.group(1))
        stage = _STEP_TO_STAGE.get(step)
        if stage is not None:
            return (
                Event("stage", {"stage": stage, "status": "running"}),
                step,
            )

    # Per-file progress inside an existing stage.
    if current_step:
        stage = _STEP_TO_STAGE.get(current_step)
        if stage is None:
            return (None, current_step)
        m_prog = _PROGRESS_RE.search(line)
        if m_prog:
            cur = int(m_prog.group(1))
            tot = int(m_prog.group(2))
            return (
                Event("stage", {
                    "stage": stage,
                    "status": "running",
                    "current": cur,
                    "total": tot,
                }),
                current_step,
            )

    return (None, current_step)


# ── Manager ────────────────────────────────────────────────────────────

class RunManager:
    """Owns all active jobs. Not thread-safe for write; only the main
    FastAPI event loop mutates `jobs`.
    """

    def __init__(self) -> None:
        self.jobs: dict[str, RunJob] = {}

    def start(self, folder: Path, extra_args: list[str] | None = None, loop: asyncio.AbstractEventLoop | None = None) -> str:
        if not folder.exists():
            raise FileNotFoundError(folder)

        job_id = uuid.uuid4().hex[:8]

        env = {**os.environ, "PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1"}
        # Dev: spawn `python -m dive_edit.main`. Frozen: re-invoke our own
        # exe with a sentinel first arg the desktop entrypoint dispatches
        # to dive_edit.main.main(). PyInstaller has no `python -m`.
        if getattr(sys, "frozen", False):
            cmd = [sys.executable, "--pipeline", "--job", str(folder)]
            cwd = str(Path(sys.executable).resolve().parent)
        else:
            cmd = [
                sys.executable, "-u", "-X", "utf8",
                "-m", "dive_edit.main",
                "--job", str(folder),
            ]
            cwd = str(Path(__file__).resolve().parents[2])
        if extra_args:
            cmd.extend(extra_args)

        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            env=env,
            cwd=cwd,
            bufsize=1,
            creationflags=_windows_creationflags(),
        )

        if loop is None:
            loop = asyncio.get_event_loop()
        queue: asyncio.Queue[Event] = asyncio.Queue(maxsize=10_000)
        job = RunJob(
            job_id=job_id,
            folder=folder,
            proc=proc,
            queue=queue,
            loop=loop,
            started_at=time.time(),
        )
        self.jobs[job_id] = job

        # Pump subprocess output in a background thread. Cross-thread
        # enqueue via loop.call_soon_threadsafe so the asyncio queue stays
        # consistent with the main event loop.
        threading.Thread(
            target=self._pump, args=(job,), daemon=True, name=f"run-{job_id}"
        ).start()

        return job_id

    def _pump(self, job: RunJob) -> None:
        """Runs on a worker thread. Reads stdout line-by-line and enqueues
        typed events onto the asyncio queue.
        """
        proc = job.proc
        assert proc.stdout is not None

        current_step = 0

        def put(evt: Event) -> None:
            # Fire-and-forget — if queue is saturated, drop log entries rather
            # than block the subprocess reader. Stage events are few so they
            # tolerate a bounded queue.
            job.loop.call_soon_threadsafe(self._enqueue, job, evt)

        try:
            for raw in proc.stdout:
                line = raw.rstrip()
                if not line:
                    continue

                parsed, next_step = _parse_line(line, current_step)
                if next_step != current_step and job.current_stage is not None:
                    # Previous stage finishes as the next stage begins.
                    put(Event("stage", {
                        "stage": job.current_stage, "status": "done",
                    }))
                if parsed and parsed.type == "stage":
                    stage_name = parsed.data.get("stage")
                    if isinstance(stage_name, str):
                        job.current_stage = stage_name
                    put(parsed)
                current_step = next_step
                put(Event("log", {"msg": line}))
        finally:
            exit_code = proc.wait()
            job.exit_code = exit_code
            job.ended_at = time.time()

            # Close out the last running stage as done if no explicit marker came.
            if job.current_stage and exit_code == 0:
                job.loop.call_soon_threadsafe(
                    self._enqueue, job,
                    Event("stage", {"stage": job.current_stage, "status": "done"}),
                )

            job.loop.call_soon_threadsafe(
                self._enqueue, job,
                Event("done" if exit_code == 0 else "error", {"exit_code": exit_code}),
            )

    def _enqueue(self, job: RunJob, event: Event) -> None:
        try:
            job.queue.put_nowait(event)
        except asyncio.QueueFull:
            # Drop oldest log line to make room; preserve terminal events.
            if event.type in ("done", "error", "stage"):
                try:
                    job.queue.get_nowait()
                    job.queue.put_nowait(event)
                except (asyncio.QueueEmpty, asyncio.QueueFull):
                    pass

    def cancel(self, job_id: str) -> bool:
        job = self.jobs.get(job_id)
        if job is None or job.proc.poll() is not None:
            return False
        if not _kill_process_tree(job.proc):
            return False
        threading.Timer(5.0, lambda: _force_kill_if_alive(job.proc)).start()
        return True

    def cancel_all(self) -> None:
        for job in list(self.jobs.values()):
            if job.proc.poll() is None:
                _kill_process_tree(job.proc)

    def get(self, job_id: str) -> RunJob | None:
        return self.jobs.get(job_id)


# Module-global manager (FastAPI will import this).
manager = RunManager()
