"""Small subprocess helpers shared by the desktop app and dev server."""
from __future__ import annotations

import subprocess
import sys


def hidden_subprocess_kwargs(*extra_flag_names: str) -> dict[str, int]:
    """Return Windows flags that keep ffmpeg/nvidia-smi child windows hidden."""
    if sys.platform != "win32":
        return {}
    flags = int(getattr(subprocess, "CREATE_NO_WINDOW", 0))
    for name in extra_flag_names:
        flags |= int(getattr(subprocess, name, 0))
    return {"creationflags": flags} if flags else {}
