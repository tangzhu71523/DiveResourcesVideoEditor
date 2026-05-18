# DiveEdit

DiveEdit is a local Windows app for turning diver communication videos into report-ready cuts. It uses Whisper speech detection to find narrated inspection segments, OCR timestamps to keep file order grounded in the burned-in video time, and a React timeline for manual review and adjustment.

## What Is Included

- Python backend and pipeline in `dive_edit/`
- React/Vite frontend in `frontend/`
- Runtime defaults in `config.yaml`
- Installer and packaging files in `build/`
- Windows assets in `assets/`

Generated job output, caches, test files, local agent files, and packaged build output are intentionally not tracked.

## Customer Install

Use the GitHub Release installer:

`DiveEdit-Setup-0.1.0.exe`

The installer ships the frozen Python app. Customer machines do not need to install Python or create a virtual environment. The post-install bootstrap prepares FFmpeg, CUDA runtime files when available, and the faster-whisper model cache.

Default model selection:

- NVIDIA CUDA ready: `large-v3-turbo`
- CPU fallback: `medium`

## Development Setup

Requirements:

- Windows 11
- Python 3.10
- Node.js 20+
- FFmpeg available on `PATH`
- Inno Setup for installer builds

Install Python dependencies:

```powershell
pip install -r requirements.txt
```

Install frontend dependencies:

```powershell
cd frontend
npm install
```

Run backend:

```powershell
python -m dive_edit.webui
```

Run frontend:

```powershell
cd frontend
npm run dev
```

Run pipeline without final render:

```powershell
python -m dive_edit.main --job "C:\path\to\job" --skip-render
```

Build frontend:

```powershell
cd frontend
npm run build
```

Build frozen app:

```powershell
pyinstaller build/dive_edit.spec --noconfirm
```

Build installer:

```powershell
iscc build/installer.iss
```

## Runtime Notes

`config.yaml` stores global defaults for overlay layout, speech selection, Whisper, and encoder behavior. Each job can override metadata and user choices through its own `<job_folder>/job.yaml`.

All app-generated job files are written under:

```text
<job_folder>/_diveedit/
```
