"""Small subprocess helpers shared by the desktop app and dev server."""
from __future__ import annotations

import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path

_tracked_lock = threading.Lock()
_tracked_children: dict[int, subprocess.Popen] = {}


def hidden_subprocess_kwargs(*extra_flag_names: str) -> dict[str, int]:
    """Return Windows flags that keep ffmpeg/nvidia-smi child windows hidden."""
    if sys.platform != "win32":
        return {}
    flags = int(getattr(subprocess, "CREATE_NO_WINDOW", 0))
    for name in extra_flag_names:
        flags |= int(getattr(subprocess, name, 0))
    return {"creationflags": flags} if flags else {}


def register_child_process(proc: subprocess.Popen) -> None:
    """Track subprocesses so the desktop app can release file handles on exit."""
    with _tracked_lock:
        _tracked_children[int(proc.pid)] = proc


def _live_tracked_children() -> list[subprocess.Popen]:
    live: list[subprocess.Popen] = []
    with _tracked_lock:
        for pid, proc in list(_tracked_children.items()):
            if proc.poll() is None:
                live.append(proc)
            else:
                _tracked_children.pop(pid, None)
    return live


def terminate_tracked_children(timeout_sec: float = 1.5) -> None:
    """Best-effort cleanup for child processes that may still hold video files."""
    children = _live_tracked_children()
    if not children:
        return
    deadline = time.monotonic() + max(0.1, timeout_sec)
    for proc in children:
        if proc.poll() is not None:
            continue
        if sys.platform == "win32":
            try:
                subprocess.run(
                    ["taskkill", "/PID", str(proc.pid), "/T", "/F"],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    check=False,
                    creationflags=int(getattr(subprocess, "CREATE_NO_WINDOW", 0)),
                )
                continue
            except Exception:  # noqa: BLE001
                pass
        try:
            proc.terminate()
        except Exception:  # noqa: BLE001
            pass
    for proc in children:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        try:
            proc.wait(timeout=remaining)
        except Exception:  # noqa: BLE001
            pass
    for proc in children:
        if proc.poll() is not None:
            continue
        try:
            proc.kill()
        except Exception:  # noqa: BLE001
            pass
    _live_tracked_children()


def bundled_tool_executable(name: str) -> str:
    """Resolve bundled CLI tools before falling back to PATH."""
    exe_name = name if name.lower().endswith(".exe") else f"{name}.exe"
    candidates: list[Path] = []
    if getattr(sys, "frozen", False):
        exe_dir = Path(sys.executable).resolve().parent
        meipass = getattr(sys, "_MEIPASS", None)
        candidates.append(exe_dir / "bin" / exe_name)
        if meipass:
            candidates.append(Path(meipass) / "bin" / exe_name)
    else:
        candidates.append(Path(__file__).resolve().parents[2] / "bin" / exe_name)
    for candidate in candidates:
        if candidate.is_file():
            return str(candidate)
    resolved = shutil.which(name)
    return resolved or name


def ffmpeg_executable() -> str:
    return bundled_tool_executable("ffmpeg")


def ffprobe_executable() -> str:
    return bundled_tool_executable("ffprobe")
