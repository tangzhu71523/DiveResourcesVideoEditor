"""Path / naming helpers."""
from __future__ import annotations
import os
import re
import sys
from pathlib import Path


def is_frozen() -> bool:
    """True when running inside a PyInstaller bundle."""
    return getattr(sys, "frozen", False)


def app_root() -> Path:
    """Where bundled read-only resources live.

    - dev: project root (parent of dive_edit/)
    - frozen onedir: directory containing the exe (sys._MEIPASS for data files)
    - frozen onefile: sys._MEIPASS (extracted temp dir)

    Use this for `assets/`, `frontend/dist/`, `config.yaml`, model files
    that ship with the app. Read-only at runtime.
    """
    if is_frozen():
        meipass = getattr(sys, "_MEIPASS", None)
        if meipass:
            return Path(meipass)
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parents[2]


def user_data_root() -> Path:
    """Per-user writable directory.

    Stores: whisper model cache (downloaded by installer), preview cache,
    app logs. Survives upgrades. Lives under %LOCALAPPDATA%/DiveEdit on
    Windows, ~/.local/share/DiveEdit elsewhere.
    """
    if sys.platform == "win32":
        base = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
    else:
        base = os.environ.get("XDG_DATA_HOME") or str(Path.home() / ".local" / "share")
    p = Path(base) / "DiveEdit"
    p.mkdir(parents=True, exist_ok=True)
    return p


def app_settings_path() -> Path:
    return user_data_root() / "settings.json"


def resource_path(*parts: str) -> Path:
    """Resolve a bundled resource by relative path under app_root()."""
    return app_root().joinpath(*parts)


def sanitize_token(s: str) -> str:
    """Make a token filesystem-safe: trim, uppercase, spaces→-, drop weird chars."""
    s = s.strip().upper()
    s = re.sub(r"\s+", "-", s)
    s = re.sub(r"[^A-Z0-9_\-.]", "", s)
    return s


def build_output_name(job_no: str, vessel: str) -> str:
    """`[JOB_NO]_[VESSEL].mp4` with safe characters."""
    return f"{sanitize_token(job_no)}_{sanitize_token(vessel)}.mp4"


# ── Single-folder layout for ALL app-generated artifacts ──
# Every file the pipeline writes (logs, transcripts, EDL, overlays,
# preview cache, job.yaml) lives under <job>/_diveedit/ so the source
# video folder stays uncluttered. The only exception is render
# output, which the user picks an explicit destination for.
APP_SUBDIR = "_diveedit"


def app_dir(job_folder: Path) -> Path:
    """Path to the per-job application data folder. Created on demand."""
    p = job_folder / APP_SUBDIR
    p.mkdir(exist_ok=True)
    return p


def transcripts_dir(job_folder: Path) -> Path:
    p = app_dir(job_folder) / "transcripts"
    p.mkdir(exist_ok=True)
    return p


def preview_cache_dir(video_folder: Path) -> Path:
    """Cache lives in the *video's* folder so different jobs share a
    layout but never share state. Identical to job folder for the
    common case."""
    p = video_folder / APP_SUBDIR / "preview_cache"
    p.mkdir(parents=True, exist_ok=True)
    return p


def logs_dir(job_folder: Path) -> Path:
    p = app_dir(job_folder) / "logs"
    p.mkdir(exist_ok=True)
    return p


def edl_path(job_folder: Path) -> Path:
    return app_dir(job_folder) / "edl.json"


def edl_draft_path(job_folder: Path) -> Path:
    return app_dir(job_folder) / "edl.draft.json"


def edl_baseline_path(job_folder: Path) -> Path:
    """Read-only snapshot of the EDL exactly as the most recent pipeline
    run wrote it. Used as the deepest undo target so the user can always
    revert back to the pipeline output regardless of subsequent edits."""
    return app_dir(job_folder) / "edl.baseline.json"


def edl_history_path(job_folder: Path) -> Path:
    """Persisted undo/redo stack — JSON document {entries, cursor}
    describing every committed EDL snapshot (incl. laneFiles +
    laneFileCache) the UI has produced. Survives across sessions so
    closing/reopening the app keeps the full undo chain back to the
    baseline."""
    return app_dir(job_folder) / "edl.history.json"


def legacy_edl_path(job_folder: Path) -> Path:
    """Pre-_diveedit layout: <folder>/_edl.json at the job-folder root.
    Many existing job folders still have their EDL here from old runs;
    api_get_edl falls back to this when the new path is empty."""
    return job_folder / "_edl.json"


def legacy_edl_draft_path(job_folder: Path) -> Path:
    return job_folder / "_edl.draft.json"


def overlay_ass_path(job_folder: Path) -> Path:
    return app_dir(job_folder) / "overlay.ass"


def job_yaml_path(job_folder: Path) -> Path:
    """Active path for job.yaml. The new layout puts it under
    _diveedit/; a legacy job.yaml at the folder root is migrated on
    first read by load_job_yaml() below."""
    return app_dir(job_folder) / "job.yaml"


def legacy_job_yaml_path(job_folder: Path) -> Path:
    return job_folder / "job.yaml"


def ensure_job_subdirs(job_folder: Path, output_dir: Path | None = None) -> dict[str, Path]:
    """Create the _diveedit/logs/ subtree always; resolve render output.

    output_dir — explicit render destination. When provided it is created
    (mkdir parents) and returned as "output". When omitted, the classic
    ``<job>/output/`` path is returned but NOT created yet; the render
    step will create it on demand via ``output_path.parent.mkdir``.
    """
    logs = logs_dir(job_folder)
    if output_dir is not None:
        output_dir.mkdir(parents=True, exist_ok=True)
        out = output_dir
    else:
        out = job_folder / "output"
    return {"logs": logs, "output": out}


def _natural_key(name: str) -> list[object]:
    """Natural sort key: embedded integer groups compared as numbers.

    `2.mp4` < `10.mp4` (plain lexicographic would put `10` before `2`).
    `10_01_R_20260402` is split into [10, '_', 1, '_R_', 20260402].
    """
    parts = re.split(r"(\d+)", name.lower())
    return [int(p) if p.isdigit() else p for p in parts]


VIDEO_EXTENSIONS = frozenset({".mp4", ".avi", ".mov", ".mkv", ".m4v", ".mts", ".m2ts"})


def list_video_files(job_folder: Path) -> list[Path]:
    """All video files in the job folder, naturally sorted.

    Supports mp4/avi/mov/mkv/m4v/mts/m2ts. Scans the root of the job
    folder only — subdirectories are intentionally excluded.
    """
    return sorted(
        [
            p for p in job_folder.iterdir()
            if p.is_file() and p.suffix.lower() in VIDEO_EXTENSIONS
        ],
        key=lambda p: _natural_key(p.name),
    )


# Backward compatibility alias — callers can still use list_mp4s()
list_mp4s = list_video_files
