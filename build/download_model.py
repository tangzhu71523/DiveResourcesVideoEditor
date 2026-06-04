"""Standalone Whisper model downloader used as a bootstrap fallback.

The installer normally calls ``DiveEdit.exe --download-model`` so customer
machines do not need system Python. This script remains for developer and
fallback installs where Python is already available.
"""
from __future__ import annotations

import subprocess
import sys
import os
import shutil
from pathlib import Path


MODEL_REPOS = {
    "large-v3-turbo": "mobiuslabsgmbh/faster-whisper-large-v3-turbo",
    "turbo": "mobiuslabsgmbh/faster-whisper-large-v3-turbo",
    "medium": "Systran/faster-whisper-medium",
    "large-v3": "Systran/faster-whisper-large-v3",
    "small": "Systran/faster-whisper-small",
}


def resolve_repo(value: str) -> str:
    if "/" in value:
        return value
    return MODEL_REPOS.get(value, f"Systran/faster-whisper-{value}")


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: download_model.py <repo_id_or_alias>", file=sys.stderr)
        return 2
    repo = resolve_repo(sys.argv[1])

    try:
        from huggingface_hub import snapshot_download
    except ImportError:
        print("huggingface_hub not installed; installing into user site", file=sys.stderr)
        subprocess.run(
            [sys.executable, "-m", "pip", "install", "--user", "--quiet", "huggingface_hub"],
            check=True,
        )
        from huggingface_hub import snapshot_download

    path = snapshot_download(repo_id=repo)
    root = Path(path)
    for item in root.iterdir():
        if not item.is_symlink():
            continue
        target = item.resolve(strict=True)
        tmp = item.with_name(f"{item.name}.diveedit.tmp")
        if tmp.exists():
            tmp.unlink()
        shutil.copy2(target, tmp)
        item.unlink()
        os.replace(tmp, item)

    model_bin = root / "model.bin"
    if not model_bin.is_file() or model_bin.stat().st_size <= 0:
        raise RuntimeError(f"model cache is incomplete: {model_bin}")
    print(f"downloaded to {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
