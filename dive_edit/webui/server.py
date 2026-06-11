"""FastAPI app — thin HTTP/WS wrapper around dive_edit pipeline modules.

Design principles:
  - Endpoints mirror frontend/src/lib/api.ts exactly. Anything new must be
    added to both sides in the same change.
  - All heavy work reuses dive_edit.* modules — this file stays < 500 lines.
  - No job-level state lives in memory; disk (_edl.json, job.yaml) is
    authoritative. Restart-safe by default.
"""
from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any

import yaml
from fastapi import FastAPI, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from pydantic import BaseModel, Field

from .. import metadata
from ..analyze.edl import EDL
from ..picker import list_with_durations, pick_job_folder_subprocess, pick_files_subprocess, pick_folder_modern, probe_duration_sec
from ..source_edl import SourceEDLSegment, load_source_edl, resolve_source_segments, save_source_edl
from ..utils.gpu import detect_optimal_workers
from ..utils.gpu_preflight import run_whisper_preflight
from ..utils.paths import app_root, is_frozen, list_video_files
from ..utils.process_flags import ffmpeg_executable, ffprobe_executable, hidden_subprocess_kwargs
from . import preview_cache
from .runner import manager as run_manager

_AUTO_WORKERS, _gpu_msg = detect_optimal_workers()
print(f"[gpu] {_gpu_msg}", flush=True)

app = FastAPI(title="dive_edit webui", version="v24-ui1")

# CORS — Vite dev server lives at a different origin. Production bundle
# served from the same origin by pywebview won't need this, but leaving it
# on is harmless (no cookies/credentials anywhere).
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("shutdown")
def _shutdown_running_jobs() -> None:
    run_manager.cancel_all()


# ── Response models ───────────────────────────────────────────────────

class VideoFileDto(BaseModel):
    name: str
    path: str
    duration_sec: float
    size_bytes: int


class PickFolderResponse(BaseModel):
    folder: str | None


class OverlayElementDto(BaseModel):
    font_size: float = 44.0
    line_spacing: float = 16.0
    letter_spacing: float = 2.0
    position_x: float = 0.0
    position_y: float = 0.0
    scale_x: float = 1.0
    scale_y: float = 1.0
    whole_scale: float = 1.0
    box_width: float = 100.0
    align: str = "center"


class LogoOverlayDto(BaseModel):
    position_x: float = 0.0
    position_y: float = 0.0
    scale: float = 1.0


class JobMetaDto(BaseModel):
    job_no: str = ""
    vessel: str = ""
    intro_file: str = ""
    body_files: list[str] = Field(default_factory=list)
    cover_lines: list[str] = Field(default_factory=list)
    small_lines: list[str] = Field(default_factory=list)
    target_duration_min: int = 0
    intro_speech_override: tuple[float, float] | None = None
    cover_overlay: OverlayElementDto = Field(default_factory=lambda: OverlayElementDto(
        font_size=44.0, line_spacing=16.0, letter_spacing=2.0,
        position_x=0.0, position_y=0.0, scale_x=1.0, scale_y=1.0,
        whole_scale=1.0, align="center",
    ))
    small_overlay: OverlayElementDto = Field(default_factory=lambda: OverlayElementDto(
        font_size=18.0, line_spacing=10.0, letter_spacing=0.0,
        position_x=0.0, position_y=0.0, scale_x=1.0, scale_y=1.0,
        whole_scale=1.0, align="left",
    ))
    logo_overlay: LogoOverlayDto = Field(default_factory=LogoOverlayDto)
    overlay_enabled: bool = True
    filter_enabled: bool = False
    job_rev: str | None = None


class SaveJobRequest(BaseModel):
    folder: str
    meta: JobMetaDto


@app.get("/api/settings")
def api_get_settings() -> dict[str, Any]:
    from ..utils.paths import app_settings_path
    p = app_settings_path()
    if not p.exists():
        return {}
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


@app.put("/api/settings")
def api_put_settings(payload: dict[str, Any]) -> dict[str, bool]:
    from ..utils.paths import app_settings_path
    p = app_settings_path()
    try:
        current = json.loads(p.read_text(encoding="utf-8")) if p.exists() else {}
    except (OSError, json.JSONDecodeError):
        current = {}
    if not isinstance(current, dict):
        current = {}
    current.update(payload)
    try:
        p.write_text(json.dumps(current, ensure_ascii=False, indent=2), encoding="utf-8")
    except OSError as e:
        raise HTTPException(status_code=500, detail=f"failed to write settings: {e}")
    return {"ok": True}


class SegmentDto(BaseModel):
    file: str
    lane_file: str | None = None
    start: float
    end: float
    label: str
    score: float = 0.0
    protected: bool = False


class EDLDto(BaseModel):
    """Unified EDL DTO. Single segments list — INTRO labels mark the
    cover/title period, anything else is body content. Replaces the
    earlier intro_file + intro_speech_* + body_segments split."""
    segments: list[SegmentDto] = Field(default_factory=list)
    target_duration_sec: float = 0.0
    actual_body_duration_sec: float = 0.0
    raw_body_duration_sec: float = 0.0
    adaptive_padding_sec: float = 0.0


class SaveEDLRequest(BaseModel):
    folder: str
    edl: EDLDto


class SourceEDLSegmentDto(BaseModel):
    file: str
    start: float = Field(ge=0.0)
    end: float = Field(gt=0.0)
    label: str = "SOURCE"
    enabled: bool = True
    group_id: str = ""


class SourceEDLDto(BaseModel):
    segments: list[SourceEDLSegmentDto] = Field(default_factory=list)


class SaveSourceEDLRequest(BaseModel):
    folder: str
    source_edl: SourceEDLDto


class PathPayload(BaseModel):
    path: str


class FolderPayload(BaseModel):
    folder: str


# ── Utilities ─────────────────────────────────────────────────────────

def _resolve_folder(folder: str) -> Path:
    """Canonicalize + existence-check a folder path from the client.

    All folder paths coming from the UI should already be absolute, but users
    can paste anything. Raise 400 on nonsense rather than silently misbehaving.
    """
    try:
        p = Path(folder).expanduser().resolve()
    except OSError as e:
        raise HTTPException(status_code=400, detail=f"invalid folder path: {e}")
    if not p.exists() or not p.is_dir():
        raise HTTPException(status_code=404, detail=f"folder not found: {p}")
    return p


def _resolve_output_dir(path: str) -> Path:
    """Canonicalize an output directory path. Creates it (mkdir parents) if it
    does not yet exist. Raises 400 for invalid paths, 500 if mkdir fails.

    Unlike _resolve_folder this is intentionally permissive — the user is
    selecting a destination that may not exist yet.
    """
    try:
        p = Path(path).expanduser().resolve()
    except OSError as e:
        raise HTTPException(status_code=400, detail=f"invalid output_dir path: {e}")
    if p.exists() and not p.is_dir():
        raise HTTPException(status_code=400, detail=f"output_dir exists but is not a directory: {p}")
    try:
        p.mkdir(parents=True, exist_ok=True)
    except OSError as e:
        raise HTTPException(status_code=500, detail=f"cannot create output_dir: {e}")
    # Basic writability check.
    if not os.access(p, os.W_OK):
        raise HTTPException(status_code=400, detail=f"output_dir not writable: {p}")
    return p


# ── Endpoint: folder picker (tkinter on main thread) ──────────────────

DEFAULT_INITIAL_DIR = str(Path.home() / "Videos")


@app.post("/api/pick-folder", response_model=PickFolderResponse)
def api_pick_folder() -> PickFolderResponse:
    """Open a native folder picker. Returns the chosen absolute path or null.

    Uses pick_folder_modern (PowerShell + FolderBrowserDialog with
    AutoUpgradeEnabled=$true) so the dialog is the modern IFileOpenDialog
    Explorer view, not the legacy tree control. tkinter's askdirectory
    showed a tree-only widget that the user explicitly rejected
    (memory: project_file_picker_requirements).
    """
    initial = DEFAULT_INITIAL_DIR if Path(DEFAULT_INITIAL_DIR).exists() else None
    chosen = pick_folder_modern(initial)
    return PickFolderResponse(folder=chosen)


class PickFilesResponse(BaseModel):
    mode: str                        # "folder" | "files" | "cancel"
    folder: str | None = None        # set when mode == "folder"
    files: list[VideoFileDto] = Field(default_factory=list)


@app.post("/api/pick-files", response_model=PickFilesResponse)
def api_pick_files() -> PickFilesResponse:
    """Open modern Explorer file picker with multi-select for video files."""
    initial = DEFAULT_INITIAL_DIR if Path(DEFAULT_INITIAL_DIR).exists() else None
    file_paths, folder_path = pick_files_subprocess(initial, mode="files")

    if folder_path:
        return PickFilesResponse(mode="folder", folder=folder_path)

    if file_paths:
        out: list[VideoFileDto] = []
        for p in file_paths:
            if not p.exists() or not p.is_file():
                continue
            dur = probe_duration_sec(p)
            try:
                size = p.stat().st_size
            except OSError:
                size = 0
            out.append(VideoFileDto(
                name=p.name,
                path=str(p),
                duration_sec=dur,
                size_bytes=size,
            ))
        return PickFilesResponse(mode="files", files=out)

    return PickFilesResponse(mode="cancel")


class ValidateFolderRequest(BaseModel):
    folder: str


class ValidateFolderResponse(BaseModel):
    ok: bool
    folder: str | None = None
    file_count: int = 0
    message: str | None = None


@app.post("/api/validate-folder", response_model=ValidateFolderResponse)
def api_validate_folder(payload: ValidateFolderRequest) -> ValidateFolderResponse:
    """Sanity-check a manually-typed folder path before committing to it.

    Returns how many video files were found + a hint message so the UI can
    call this on paste/blur and show immediate feedback.
    """
    try:
        p = Path(payload.folder).expanduser().resolve()
    except OSError as e:
        return ValidateFolderResponse(ok=False, message=f"invalid path: {e}")
    if not p.exists():
        return ValidateFolderResponse(ok=False, message="Folder does not exist")
    if not p.is_dir():
        return ValidateFolderResponse(ok=False, message="Path is not a folder")
    files = list_with_durations(p)
    if not files:
        hint = "No video files found (mp4/avi/mov/mkv)"
        if p.name.lower() == "output":
            hint += " - this is the output subfolder; choose the parent job folder"
        return ValidateFolderResponse(ok=False, folder=str(p), message=hint)
    return ValidateFolderResponse(ok=True, folder=str(p), file_count=len(files))


# ── Endpoint: list video files in a folder ────────────────────────────

@app.post("/api/list-files", response_model=list[VideoFileDto])
def api_list_files(payload: FolderPayload) -> list[VideoFileDto]:
    folder = _resolve_folder(payload.folder)
    out: list[VideoFileDto] = []
    for path in list_video_files(folder):
        dur = _probe_duration_for_import_list(path)
        try:
            size = path.stat().st_size
        except OSError:
            size = 0
        out.append(
            VideoFileDto(
                name=path.name,
                path=str(path),
                duration_sec=dur,
                size_bytes=size,
            )
        )
    return out


def _probe_duration_for_import_list(path: Path) -> float:
    """Fast, non-fatal duration probe for the Import file list.

    The UI must still show raw files if ffprobe is slow, locked, or broken.
    Pipeline code keeps using the full probe path elsewhere.
    """
    try:
        result = subprocess.run(
            [
                ffprobe_executable(), "-v", "error",
                "-show_entries", "format=duration",
                "-of", "json",
                str(path),
            ],
            capture_output=True,
            text=True,
            check=True,
            timeout=12,
            **hidden_subprocess_kwargs(),
        )
        data = json.loads(result.stdout or "{}")
        duration = float(data.get("format", {}).get("duration", 0.0))
        if duration > 0:
            return duration
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, OSError, ValueError, json.JSONDecodeError):
        pass
    try:
        import av

        with av.open(str(path), mode="r", metadata_errors="ignore") as container:
            if container.duration:
                duration = float(container.duration) / 1_000_000.0
                if duration > 0:
                    return duration
            for stream in container.streams.video:
                if stream.duration and stream.time_base:
                    duration = float(stream.duration * stream.time_base)
                    if duration > 0:
                        return duration
    except Exception:
        pass
    return 0.0


# ── Endpoint: job.yaml read/write ─────────────────────────────────────

def _job_yaml_rev(folder: Path) -> str | None:
    path = metadata.yaml_path(folder)
    try:
        st = path.stat()
    except OSError:
        return None
    return f"{st.st_mtime_ns}:{st.st_size}"


@app.get("/api/job", response_model=JobMetaDto | None)
def api_get_job(folder: str = Query(...)) -> JobMetaDto | None:
    p = _resolve_folder(folder)
    meta = metadata.load(p)
    if meta is None:
        return None
    data = meta.to_dict()
    data["job_rev"] = _job_yaml_rev(p)
    return JobMetaDto(**data)


@app.put("/api/job")
def api_put_job(payload: SaveJobRequest) -> dict[str, bool | str | None]:
    p = _resolve_folder(payload.folder)
    current_rev = _job_yaml_rev(p)
    incoming_rev = payload.meta.job_rev
    if current_rev is not None and incoming_rev != current_rev:
        raise HTTPException(
            status_code=409,
            detail={"reason": "job_changed", "job_rev": current_rev},
        )
    meta = metadata.JobMeta.from_dict(payload.meta.model_dump())
    existing = metadata.load(p)
    incoming_has_content = (
        bool(meta.job_no.strip())
        or bool(meta.vessel.strip())
        or bool(meta.intro_file.strip())
        or bool(meta.body_files)
        or any(line.strip() for line in meta.cover_lines)
        or any(line.strip() for line in meta.small_lines)
    )
    if existing is not None and not incoming_has_content:
        return {"ok": True}
    if not meta.job_no.strip():
        meta.job_no = metadata.extract_job_no(meta.cover_lines) or (existing.job_no if existing else "")
    if not meta.vessel.strip():
        meta.vessel = metadata.extract_vessel(meta.cover_lines) or (existing.vessel if existing else "")
    metadata.save(p, meta)
    return {"ok": True, "job_rev": _job_yaml_rev(p)}


# ── Endpoint: EDL read/write ──────────────────────────────────────────

def _edl_path(folder: Path) -> Path:
    from ..utils.paths import edl_path as _ep
    return _ep(folder)


def _edl_draft_path(folder: Path) -> Path:
    from ..utils.paths import edl_draft_path as _edp
    return _edp(folder)


def _edl_has_output(edl: EDL) -> bool:
    return (
        len(edl.segments) > 0
        or edl.target_duration_sec > 0
        or edl.actual_body_duration_sec > 0
        or edl.raw_body_duration_sec > 0
    )


def _load_edl_candidate(path: Path) -> EDL | None:
    try:
        return EDL.load(path)
    except (OSError, ValueError, KeyError, json.JSONDecodeError, TypeError):
        return None


@app.get("/api/edl", response_model=EDLDto | None)
def api_get_edl(folder: str = Query(...)) -> EDLDto | None:
    """Return the EDL the UI should display.

    Tier order — first existing wins, BUT a draft only wins if it is
    NEWER than the official by mtime. This prevents the classic bug:
    user edits draft → runs pipeline → pipeline writes fresh official
    → frontend loads stale draft (because draft is the "preferred"
    source) → Export promotes stale draft over fresh official → render
    points at deleted/wrong files.

    Tiers (each pair: new path, then pre-_diveedit legacy path):
      draft     : _diveedit/edl.draft.json  ⊕  <folder>/_edl.draft.json
      official  : _diveedit/edl.json        ⊕  <folder>/_edl.json
    """
    from ..utils.paths import legacy_edl_path, legacy_edl_draft_path
    p = _resolve_folder(folder)
    candidates = [
        c for c in (
            _edl_draft_path(p),
            legacy_edl_draft_path(p),
            _edl_path(p),
            legacy_edl_path(p),
        )
        if c.exists()
    ]
    candidates.sort(key=lambda c: c.stat().st_mtime, reverse=True)
    loaded = [(c, e) for c in candidates if (e := _load_edl_candidate(c)) is not None]
    if not loaded:
        return None
    # Migration guard: an empty _diveedit/edl*.json from the intro-merge era
    # must not hide an older legacy _edl.json that still has real segments.
    edl = next((e for _c, e in loaded if _edl_has_output(e)), loaded[0][1])
    return EDLDto.model_validate(edl.to_json())


@app.put("/api/edl")
def api_put_edl(payload: SaveEDLRequest) -> dict[str, bool]:
    """Write user edits to both draft and official EDL files.

    The draft survives browser refresh / backend restart. It is consumed by
    /api/export which copies draft → official before rendering, and is
    cleared by /api/edl/draft DELETE when the user switches job folders.
    """
    p = _resolve_folder(payload.folder)
    data = payload.edl.model_dump()
    # Save is now authoritative for rendering: keep draft for resume, and
    # mirror it to official so render-only never falls back to baseline.
    draft_path = _edl_draft_path(p)
    official_path = _edl_path(p)
    try:
        text = json.dumps(data, indent=2, ensure_ascii=False)
        draft_path.parent.mkdir(parents=True, exist_ok=True)
        official_path.parent.mkdir(parents=True, exist_ok=True)
        draft_path.write_text(text, encoding="utf-8")
        official_path.write_text(text, encoding="utf-8")
    except OSError as e:
        raise HTTPException(status_code=500, detail=f"failed to write edl.json: {e}")
    return {"ok": True}


@app.delete("/api/edl/draft")
def api_delete_edl_draft(folder: str = Query(...)) -> dict[str, bool]:
    """Remove the draft EDL for a folder. Narrow-scope: only the unsaved
    UI draft, nothing else. Used when the user wants to discard edits.
    """
    p = _resolve_folder(folder)
    draft = _edl_draft_path(p)
    if draft.exists():
        try:
            draft.unlink()
        except OSError as e:
            raise HTTPException(status_code=500, detail=f"failed to delete draft: {e}")
    return {"ok": True}


# ── EDL baseline + history (super-undo persistence) ────────────────
#
# baseline = read-only snapshot written exactly once per pipeline run
# (see dive_edit/main.py). The deepest-undo target — undo can always
# walk back to it.
#
# history = JSON document { entries: [...], cursor: int } recording every
# UI-committed snapshot. cursor < len(entries)-1 means user has undone N
# steps; a new edit in that state truncates entries to cursor+1 (standard
# branch-discard, matches Photoshop / VSCode). Entries carry full state
# (EDL + laneFiles + laneFileCache) so closing/reopening preserves the
# whole undo chain.

@app.get("/api/edl/baseline")
def api_get_edl_baseline(folder: str = Query(...)) -> dict[str, Any] | None:
    p = _resolve_folder(folder)
    from ..utils.paths import edl_baseline_path as _ebp
    bp = _ebp(p)
    if not bp.exists():
        return None
    try:
        return EDL.load(bp).to_json()
    except (OSError, json.JSONDecodeError, TypeError, ValueError):
        return None


@app.get("/api/edl/history")
def api_get_edl_history(folder: str = Query(...)) -> dict[str, Any] | None:
    p = _resolve_folder(folder)
    from ..utils.paths import edl_history_path as _ehp
    hp = _ehp(p)
    if not hp.exists():
        return None
    try:
        data = json.loads(hp.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            return None
        return data
    except (OSError, json.JSONDecodeError):
        return None


class EDLHistoryPayload(BaseModel):
    folder: str
    entries: list[dict[str, Any]]
    cursor: int


@app.put("/api/edl/history")
def api_put_edl_history(payload: EDLHistoryPayload) -> dict[str, bool]:
    p = _resolve_folder(payload.folder)
    from ..utils.paths import edl_history_path as _ehp
    hp = _ehp(p)
    try:
        hp.write_text(
            json.dumps({"entries": payload.entries, "cursor": payload.cursor},
                       ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
    except OSError as e:
        raise HTTPException(status_code=500, detail=f"failed to write history: {e}")
    return {"ok": True}


@app.delete("/api/edl/history")
def api_delete_edl_history(folder: str = Query(...)) -> dict[str, bool]:
    p = _resolve_folder(folder)
    from ..utils.paths import edl_history_path as _ehp
    hp = _ehp(p)
    if hp.exists():
        try:
            hp.unlink()
        except OSError as e:
            raise HTTPException(status_code=500, detail=f"failed to delete history: {e}")
    return {"ok": True}


def _source_edl_path(folder: Path) -> Path:
    from ..utils.paths import source_edl_path as _sep
    return _sep(folder)


@app.get("/api/source-edl", response_model=SourceEDLDto)
def api_get_source_edl(folder: str = Query(...)) -> SourceEDLDto:
    p = _resolve_folder(folder)
    try:
        segments = load_source_edl(_source_edl_path(p))
    except (OSError, json.JSONDecodeError, ValueError) as e:
        raise HTTPException(status_code=500, detail=f"failed to read source_edl.json: {e}")
    return SourceEDLDto(
        segments=[
            SourceEDLSegmentDto(
                file=seg.file,
                start=seg.start,
                end=seg.end,
                label=seg.label,
                enabled=seg.enabled,
                group_id=seg.group_id,
            )
            for seg in segments
        ]
    )


@app.put("/api/source-edl", response_model=SourceEDLDto)
def api_put_source_edl(payload: SaveSourceEDLRequest) -> SourceEDLDto:
    p = _resolve_folder(payload.folder)
    incoming = [
        SourceEDLSegment(
            file=seg.file,
            start=seg.start,
            end=seg.end,
            label=seg.label,
            enabled=seg.enabled,
            group_id=seg.group_id,
        )
        for seg in payload.source_edl.segments
        if seg.end > seg.start
    ]
    normalized: list[SourceEDLSegment] = []
    for seg in incoming:
        if not seg.enabled:
            normalized.append(seg)
            continue
        resolved = resolve_source_segments(p, [seg])
        if not resolved:
            continue
        _source, resolved_seg = resolved[0]
        normalized.append(resolved_seg)
    enabled_incoming = any(seg.enabled for seg in incoming)
    enabled_saved = any(seg.enabled for seg in normalized)
    if enabled_incoming and not enabled_saved:
        raise HTTPException(
            status_code=400,
            detail="source_edl has no valid enabled source ranges for this folder",
        )
    try:
        save_source_edl(_source_edl_path(p), normalized)
    except OSError as e:
        raise HTTPException(status_code=500, detail=f"failed to write source_edl.json: {e}")
    return SourceEDLDto(
        segments=[
            SourceEDLSegmentDto(
                file=s.file,
                start=s.start,
                end=s.end,
                label=s.label,
                enabled=s.enabled,
                group_id=s.group_id,
            )
            for s in normalized
        ]
    )


@app.delete("/api/source-edl")
def api_delete_source_edl(folder: str = Query(...)) -> dict[str, bool]:
    p = _resolve_folder(folder)
    sp = _source_edl_path(p)
    if sp.exists():
        try:
            sp.unlink()
        except OSError as e:
            raise HTTPException(status_code=500, detail=f"failed to delete source_edl.json: {e}")
    return {"ok": True}


@app.delete("/api/job/cache")
def api_delete_job_cache(folder: str = Query(...)) -> dict[str, Any]:
    """Wipe analysis caches for a job folder. Called manually via the
    DELETE endpoint; the UI no longer auto-fires this on folder switch.

    Survives:
      - source video files          (user content)
      - <job>/_diveedit/job.yaml    (user input)
      - <job>/_diveedit/source_edl.json (manual source trims)
      - output/                     (rendered deliverable)
    Removes the rest of <job>/_diveedit/.
    """
    import shutil
    from ..utils.paths import app_dir, APP_SUBDIR  # noqa: F401

    p = _resolve_folder(folder)
    diveedit_root = p / APP_SUBDIR
    removed: list[str] = []
    if diveedit_root.is_dir():
        for child in diveedit_root.iterdir():
            if child.name in {"job.yaml", "source_edl.json"}:
                continue  # preserve user input
            try:
                if child.is_dir():
                    shutil.rmtree(child)
                else:
                    child.unlink()
                removed.append(child.name)
            except OSError:
                pass
    return {"ok": True, "removed": removed}


# ── Endpoint: overlay .ass read / write ──
# The WYSIWYG text editor in the UI round-trips through this file. Backend ffmpeg
# uses the same file via `subtitles=` filter on export → pixel-identical output.

def _overlay_ass_path(folder: Path) -> Path:
    from ..utils.paths import overlay_ass_path as _oap
    return _oap(folder)


@app.get("/api/overlay_ass")
def api_get_overlay_ass(folder: str = Query(...)) -> dict[str, Any]:
    p = _resolve_folder(folder)
    ap = _overlay_ass_path(p)
    if not ap.exists():
        return {"content": None}
    try:
        return {"content": ap.read_text(encoding="utf-8")}
    except OSError as e:
        raise HTTPException(status_code=500, detail=f"failed to read _overlay.ass: {e}")


class SaveOverlayAssRequest(BaseModel):
    folder: str
    content: str


@app.put("/api/overlay_ass")
def api_put_overlay_ass(payload: SaveOverlayAssRequest) -> dict[str, bool]:
    p = _resolve_folder(payload.folder)
    try:
        _overlay_ass_path(p).write_text(payload.content, encoding="utf-8")
    except OSError as e:
        raise HTTPException(status_code=500, detail=f"failed to write _overlay.ass: {e}")
    return {"ok": True}


# ── Endpoint: raw video stream (for file-card previews + suggestion thumbs) ──

@app.get("/api/video_stream")
def api_video_stream(path: str = Query(...), request: Request = None) -> Response:  # type: ignore[assignment]
    """Serve a raw video file with HTTP Range support so <video> elements
    can seek without downloading the whole file.

    Security: we intentionally do NOT restrict to a specific base directory
    here because jobs live in arbitrary user folders. The UI only ever passes
    paths that came from /api/list-files (server-controlled). If this server
    is ever exposed beyond localhost we must add a path whitelist.
    """
    p = Path(path)
    if not p.exists() or not p.is_file():
        raise HTTPException(status_code=404, detail="file not found")

    # Guess content-type from extension; browser needs this for <video>.
    ext = p.suffix.lower()
    ctype = {
        ".mp4": "video/mp4",
        ".m4v": "video/mp4",
        ".mov": "video/quicktime",
        ".mkv": "video/x-matroska",
        ".avi": "video/x-msvideo",
        ".webm": "video/webm",
        ".mts": "video/mp2t",
        ".m2ts": "video/mp2t",
    }.get(ext, "application/octet-stream")

    file_size = p.stat().st_size
    range_header = request.headers.get("range") if request is not None else None

    # No Range header → just stream the whole file (simple case).
    if not range_header:
        return FileResponse(p, media_type=ctype)

    # Parse "Range: bytes=START-END" (END is optional).
    try:
        units, _, rng = range_header.partition("=")
        if units.strip().lower() != "bytes":
            raise ValueError("only bytes ranges supported")
        start_s, _, end_s = rng.partition("-")
        start = int(start_s) if start_s else 0
        end = int(end_s) if end_s else file_size - 1
    except ValueError:
        raise HTTPException(status_code=416, detail="invalid Range header")

    if start < 0 or end >= file_size or start > end:
        raise HTTPException(status_code=416, detail="Range not satisfiable")

    chunk_size = end - start + 1

    def iter_chunk():
        with p.open("rb") as f:
            f.seek(start)
            remaining = chunk_size
            while remaining > 0:
                read = f.read(min(65536, remaining))
                if not read:
                    break
                remaining -= len(read)
                yield read

    headers = {
        "Content-Range": f"bytes {start}-{end}/{file_size}",
        "Accept-Ranges": "bytes",
        "Content-Length": str(chunk_size),
        "Content-Type": ctype,
    }
    return StreamingResponse(iter_chunk(), status_code=206, headers=headers)


# ── Endpoint: open folder / file in OS file explorer ──────────────────

@app.post("/api/open-folder")
def api_open_folder(payload: PathPayload) -> dict[str, bool]:
    p = Path(payload.path)
    if not p.exists():
        raise HTTPException(status_code=404, detail="path not found")
    try:
        if sys.platform.startswith("win"):
            os.startfile(p)  # type: ignore[attr-defined]
        elif sys.platform == "darwin":
            subprocess.Popen(["open", str(p)])
        else:
            subprocess.Popen(["xdg-open", str(p)])
    except OSError as e:
        raise HTTPException(status_code=500, detail=f"failed to open: {e}")
    return {"ok": True}


# ── Asset serving (company logo, etc.) ───────────────────────────────

@app.get("/api/asset/logo")
def api_asset_logo() -> Response:
    """Return the company logo PNG used by the renderer.

    Lets the frontend preview show the same logo top-right that
    ffmpeg bakes into the final video.
    """
    # Resolve from config.yaml::assets.logo_path with sensible fallback.
    project_root = app_root()
    candidates: list[Path] = []
    try:
        cfg_p = project_root / "config.yaml"
        if cfg_p.exists():
            with cfg_p.open("r", encoding="utf-8") as f:
                cfg = yaml.safe_load(f) or {}
            assets_cfg = cfg.get("assets", {})
            logo = assets_cfg.get("logo_path")
            if logo:
                candidates.append(Path(str(logo)))
    except Exception:
        pass
    candidates.append(project_root / "assets" / "Diveresources Logo.png")
    candidates.append(project_root / "assets" / "logo.png")
    for p in candidates:
        try:
            if p.exists() and p.is_file():
                return FileResponse(str(p), media_type="image/png")
        except OSError:
            continue
    raise HTTPException(status_code=404, detail="logo asset not found")


# ── Health check ──────────────────────────────────────────────────────

@app.get("/api/health")
def api_health() -> dict[str, Any]:
    # Re-detect every call so freed VRAM (closed other GPU apps) bumps
    # the cap up; previously frozen at module import → cap got stuck.
    preflight = run_whisper_preflight()
    print(preflight.log_line(), flush=True)
    selected_workers = 1
    gpu_available = preflight.whisper_device_plan == "gpu"
    # cuda_runtime_ok = whether ctranslate2 can actually run on GPU.
    # Distinct from gpu_available (which only means nvidia-smi sees a
    # card). When the frozen exe boots and probes for cudart64_12.dll,
    # it sets DIVE_FORCE_CPU=1 if neither system PATH nor the bundled
    # cuda/ dir has it — that's the true "GPU works" gate. In dev mode
    # (running via `python -m dive_edit.webui`), DIVE_FORCE_CPU is
    # unset, so we default to True (site-packages nvidia-* wheels
    # auto-register their DLL search paths through pkg_resources).
    cuda_runtime_ok = (
        gpu_available and os.environ.get("DIVE_FORCE_CPU") != "1"
    )
    return {
        "status": "ok",
        "version": "v24-ui1",
        "platform": sys.platform,
        "gpu_available": gpu_available,
        "cuda_runtime_ok": cuda_runtime_ok,
        "cuda_status": os.environ.get("DIVE_CUDA_STATUS", "unset"),
        "cudnn_status": os.environ.get("DIVE_CUDNN_STATUS", "unset"),
        "force_cpu": os.environ.get("DIVE_FORCE_CPU") == "1",
        "auto_workers": selected_workers,
        "workers_cap": selected_workers,
        "gpu_msg": preflight.gpu_reason,
        **preflight.as_health(),
    }


# ── Pipeline runner: start + cancel + WS progress stream ─────────────

class RunRequest(BaseModel):
    folder: str
    workers: int | None = None  # None = use server-side auto-detect


class RunResponse(BaseModel):
    job_id: str


class CancelRequest(BaseModel):
    job_id: str


@app.post("/api/run", response_model=RunResponse)
async def api_run(payload: RunRequest) -> RunResponse:
    """Start the full pipeline as a subprocess. job.yaml must already be
    saved (via PUT /api/job) — pipeline uses it to skip interactive prompts.
    Returns a job_id the client then subscribes to via WS /ws/logs.
    """
    folder = _resolve_folder(payload.folder)
    from ..utils.paths import job_yaml_path as _jyp
    if not _jyp(folder).exists() and not (folder / "job.yaml").exists():
        raise HTTPException(
            status_code=400,
            detail="job.yaml missing — save job params first via PUT /api/job",
        )
    # Drop stale draft before launching a fresh pipeline. Without this,
    # a draft saved during a previous session can outlive the run and
    # later get promoted at Export time, overwriting the brand-new
    # official EDL with whatever was on screen before Start was clicked.
    _draft = _edl_draft_path(folder)
    if _draft.exists():
        try:
            _draft.unlink()
        except OSError:
            pass
    # Worker count is fully system-decided — UI no longer exposes a
    # parallel-workers control. Rules:
    #   GPU + cuDNN + cudart all OK → use auto_workers (VRAM-derived cap)
    #   anything else (CPU mode / cuDNN missing / no GPU)   → 1
    # Each whisper subprocess loads ~3GB + saturates CPU cores; running
    # >1 of them on CPU pegs the host in seconds, so CPU is never given
    # parallelism no matter what the caller hints.
    preflight = run_whisper_preflight()
    print(preflight.log_line(), flush=True)
    worker_env = preflight.env()
    workers = 1 if preflight.whisper_device_plan == "gpu" else 1
    loop = asyncio.get_running_loop()
    try:
        job_id = run_manager.start(
            folder,
            extra_args=["--skip-render", "--workers", str(workers)],
            loop=loop,
            extra_env=worker_env,
        )
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    return RunResponse(job_id=job_id)


@app.post("/api/cancel")
def api_cancel(payload: CancelRequest) -> dict[str, bool]:
    ok = run_manager.cancel(payload.job_id)
    return {"ok": ok}


@app.websocket("/ws/logs")
async def ws_logs(ws: WebSocket, job_id: str) -> None:
    """Stream events for a running job to the client.

    Each message on the wire is one JSON object:
      {type: "log",   msg: "..."}
      {type: "stage", stage: "whisper"|"intro"|"ocr"|"edl"|"render",
                     status: "running"|"done", current?, total?}
      {type: "done",  exit_code: 0}
      {type: "error", exit_code: N}
    """
    job = run_manager.get(job_id)
    if job is None:
        await ws.close(code=4404, reason="unknown job_id")
        return
    await ws.accept()
    try:
        while True:
            event = await job.queue.get()
            await ws.send_json(event.to_dict())
            if event.type in ("done", "error"):
                # Stream is closed naturally when the run finishes.
                break
    except WebSocketDisconnect:
        # Client closed the tab — subprocess keeps running; they can
        # reconnect by job_id or read run.log after the fact.
        return
    finally:
        try:
            await ws.close()
        except Exception:  # noqa: BLE001
            pass


class ExportRequest(BaseModel):
    folder: str
    output_dir: str  # required — user selects via native folder picker


@app.post("/api/export", response_model=RunResponse)
async def api_export(payload: ExportRequest) -> RunResponse:
    """Render by reusing the current EDL and writing to the selected output dir.

    output_dir must come from /api/pick-folder after the user clicks Export.
    Empty output paths are rejected so export never silently writes to the job
    folder. Progress is streamed through the same WebSocket path as /api/run.
    """
    folder = _resolve_folder(payload.folder)
    output_dir = _resolve_output_dir(payload.output_dir)
    from ..utils.paths import edl_path as _ep, job_yaml_path as _jyp
    edl_path = _ep(folder)
    draft_path = _edl_draft_path(folder)
    job_yaml_p = _jyp(folder)
    # Promote draft → official before rendering, BUT only if the draft
    # is actually newer than the official. Otherwise we'd overwrite a
    # fresh pipeline output with a stale draft left over from before
    # the run (frontend's `edl` state can lag a few hundred ms behind
    # the WS done event). When official is newer or equal, we discard
    # the draft entirely so future loads can't pick it up either.
    if draft_path.exists():
        official_mtime = edl_path.stat().st_mtime if edl_path.exists() else 0.0
        draft_mtime = draft_path.stat().st_mtime
        if draft_mtime > official_mtime:
            try:
                edl_path.write_text(draft_path.read_text(encoding="utf-8"), encoding="utf-8")
            except OSError as e:
                raise HTTPException(status_code=500, detail=f"failed to promote draft EDL: {e}")
        else:
            try:
                draft_path.unlink()
            except OSError:
                pass
    if not edl_path.exists() or (not job_yaml_p.exists() and not (folder / "job.yaml").exists()):
        raise HTTPException(
            status_code=400,
            detail="No pipeline output yet (edl.json missing) — click Start first.",
        )
    # Reject concurrent export on the same folder. Without this guard a
    # double-fired /api/export (frontend race, user double-click) spawns two
    # ffmpegs both writing to the same -o path with -y; the resulting mp4
    # has interleaved H.264 NAL units and is unplayable even though the
    # container ftyp/moov look fine. Symptom: ffprobe reports massive
    # "Invalid NAL unit size" errors.
    for j in run_manager.jobs.values():
        if j.folder == folder and j.proc.poll() is None:
            raise HTTPException(
                status_code=409,
                detail=f"Export already running for this folder (job_id={j.job_id}). Wait for it to finish or cancel it first.",
            )
    loop = asyncio.get_running_loop()
    try:
        job_id = run_manager.start(
            folder,
            extra_args=["--render-only", "--output-path", str(output_dir)],
            loop=loop,
        )
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except OSError as e:
        raise HTTPException(status_code=500, detail=f"failed to start export process: {e}")
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"failed to start export process: {type(e).__name__}: {e}")
    return RunResponse(job_id=job_id)


# Thumbnail extractor (background frame extraction + local cache)

from . import thumbnail_extractor as _thumb


class ThumbnailsStartRequest(BaseModel):
    folder: str
    files: list[str]


@app.post("/api/thumbnails/start")
def api_thumbnails_start(payload: ThumbnailsStartRequest) -> dict:
    """Queue lane files for background thumbnail extraction."""
    folder = _resolve_folder(payload.folder)
    paths = [Path(f) for f in payload.files]
    queued = _thumb.enqueue(paths, folder)
    return {"ok": True, "queued": queued}


@app.get("/api/thumbnails/status")
def api_thumbnails_status(folder: str = Query(...), file: str = Query(...)) -> dict:
    folder_p = _resolve_folder(folder)
    return _thumb.status(Path(file), folder_p)


@app.get("/api/thumbnail")
def api_thumbnail(
    folder: str = Query(...),
    file: str = Query(...),
    idx: int = Query(..., ge=0),
) -> Response:
    folder_p = _resolve_folder(folder)
    td = _thumb.thumbnails_dir(folder_p, Path(file))
    p = _thumb.thumbnail_path(td, idx)
    if not p.exists():
        raise HTTPException(status_code=404, detail="thumbnail not ready")
    return FileResponse(
        p, media_type="image/jpeg",
        headers={"Cache-Control": "public, max-age=86400"},
    )


@app.get("/api/preview_frame")
def api_preview_frame(
    file: str = Query(...),
    offset_sec: float = Query(0.0, ge=0.0),
) -> Response:
    """Return one JPEG frame at the requested source offset."""
    p = Path(file)
    if not p.exists() or not p.is_file():
        raise HTTPException(status_code=404, detail="file not found")
    try:
        result = subprocess.run(
            [
                ffmpeg_executable(), "-ss", f"{offset_sec:.3f}", "-i", str(p),
                "-frames:v", "1", "-q:v", "4", "-f", "image2pipe",
                "-vcodec", "mjpeg", "-",
            ],
            capture_output=True,
            timeout=10,
            check=False,
            **hidden_subprocess_kwargs(),
        )
        if result.returncode != 0 or not result.stdout:
            raise HTTPException(
                status_code=500,
                detail=f"ffmpeg failed: {result.stderr.decode('utf-8', errors='replace')[:200]}",
            )
        return Response(
            content=result.stdout,
            media_type="image/jpeg",
            headers={"Cache-Control": "public, max-age=86400"},
        )
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=500, detail="ffmpeg timeout (>10s)")


@app.get("/api/segment_stream")
def api_segment_stream(
    file: str = Query(...),
    start: float = Query(0.0, ge=0.0),
    end: float = Query(...),
) -> Response:
    """Stream a source segment as fragmented MP4 for browser playback."""
    p = Path(file)
    if not p.exists() or not p.is_file():
        raise HTTPException(status_code=404, detail="file not found")
    if end <= start:
        raise HTTPException(status_code=400, detail="end must > start")

    cmd = [
        ffmpeg_executable(),
        "-ss", f"{start:.3f}",
        "-to", f"{end:.3f}",
        "-i", str(p),
        "-c:v", "libx264",
        "-preset", "ultrafast",
        "-tune", "zerolatency",
        "-c:a", "aac",
        "-b:a", "128k",
        "-movflags", "frag_keyframe+empty_moov+default_base_moof+faststart",
        "-f", "mp4",
        "-",
    ]
    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        bufsize=0,
        **hidden_subprocess_kwargs(),
    )

    def iter_chunks():
        try:
            while True:
                chunk = proc.stdout.read(64 * 1024)
                if not chunk:
                    break
                yield chunk
        finally:
            try:
                proc.terminate()
                proc.wait(timeout=2)
            except Exception:  # noqa: BLE001
                proc.kill()

    return StreamingResponse(
        iter_chunks(),
        media_type="video/mp4",
        headers={"Cache-Control": "no-store", "Accept-Ranges": "none"},
    )


def _serve_file_with_range(path: Path, request: Request, media_type: str) -> Response:
    """Serve a file with HTTP Range support so <video> can native-seek.

    Without Range the browser downloads the whole MP4 up front — seeking
    still works but is wasteful for long files.
    """
    import re
    file_size = path.stat().st_size
    range_header = request.headers.get("range")
    if not range_header:
        return FileResponse(
            str(path),
            media_type=media_type,
            headers={"Accept-Ranges": "bytes", "Cache-Control": "public, max-age=86400"},
        )
    m = re.match(r"bytes=(\d+)-(\d*)", range_header)
    if not m:
        raise HTTPException(status_code=400, detail="bad range header")
    start = int(m.group(1))
    end = int(m.group(2)) if m.group(2) else file_size - 1
    end = min(end, file_size - 1)
    if start > end:
        raise HTTPException(status_code=416, detail="range not satisfiable")
    length = end - start + 1

    def iter_chunks():
        with open(path, "rb") as f:
            f.seek(start)
            remaining = length
            while remaining > 0:
                chunk = f.read(min(64 * 1024, remaining))
                if not chunk:
                    break
                yield chunk
                remaining -= len(chunk)

    return StreamingResponse(
        iter_chunks(),
        status_code=206,
        media_type=media_type,
        headers={
            "Content-Range": f"bytes {start}-{end}/{file_size}",
            "Accept-Ranges": "bytes",
            "Content-Length": str(length),
            "Cache-Control": "public, max-age=86400",
        },
    )


@app.get("/api/preview_cache/status")
def api_preview_cache_status(file: str = Query(...)) -> dict:
    return preview_cache.cache_status(file)


@app.post("/api/preview_cache/start")
def api_preview_cache_start(file: str = Query(...), priority: int = Query(50, ge=0, le=100)) -> dict:
    p = Path(file)
    if not p.exists() or not p.is_file():
        raise HTTPException(status_code=404, detail="file not found")
    preview_cache.ensure_cache(file, priority=priority)
    return preview_cache.cache_status(file)


@app.get("/api/preview_cache/mp4")
def api_preview_cache_mp4(request: Request, file: str = Query(...)) -> Response:
    p = preview_cache.cache_path(file)
    if not p.exists():
        raise HTTPException(status_code=404, detail="not cached yet")
    return _serve_file_with_range(p, request, "video/mp4")


@app.get("/api/suggestions")
def api_suggestions_stub() -> list[Any]:
    # Deliberately empty (not 501) so the UI doesn't crash. Real content
    # comes from Phase 5 when pipeline exposes candidates.
    return []


# ── Production static UI ─────────────────────────────────────────────
# In dev, Vite serves the SPA on :5173 and proxies /api here. In a
# packaged build there is no Vite — FastAPI itself serves frontend/dist.
# Mounted last so /api/* and /ws/* still take precedence.
def _mount_spa() -> None:
    candidates = [
        app_root() / "frontend" / "dist",
        Path(sys.executable).resolve().parent / "_internal" / "frontend" / "dist",
        Path(__file__).resolve().parent.parent.parent / "frontend" / "dist",
    ]
    for d in candidates:
        if d.is_dir() and (d / "index.html").is_file():
            from fastapi.staticfiles import StaticFiles
            app.mount("/", StaticFiles(directory=str(d), html=True), name="ui")
            print(f"[ui] mounted SPA from {d}", flush=True)
            return
    print(f"[ui] no SPA dist found in: {[str(c) for c in candidates]}", flush=True)


_mount_spa()
