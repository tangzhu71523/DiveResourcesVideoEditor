"""Small subprocess helpers shared by the desktop app and dev server."""
from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path


def hidden_subprocess_kwargs(*extra_flag_names: str) -> dict[str, int]:
    """Return Windows flags that keep ffmpeg/nvidia-smi child windows hidden."""
    if sys.platform != "win32":
        return {}
    flags = int(getattr(subprocess, "CREATE_NO_WINDOW", 0))
    for name in extra_flag_names:
        flags |= int(getattr(subprocess, name, 0))
    return {"creationflags": flags} if flags else {}


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
