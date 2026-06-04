# DiveEdit

DiveEdit is a Windows desktop video editor for underwater inspection report footage. It helps an operator import long raw DVR videos, mark useful windows, run an AI-assisted cut pipeline, review the generated timeline, and export a clean MP4 with title, watermark, and logo overlays.

The app is built for cases where most raw footage is not useful: black screen, overexposed frames, silence, repeated camera noise, or long gaps between useful inspection moments.

## What It Does

- Import raw MP4 files from a job folder.
- Preview and manually mark useful windows before running the pipeline.
- Keep manual edits as an editable cache, separate from system-generated pipeline outputs.
- Detect intro/title footage automatically, or use a manually marked intro window.
- Read speech with Whisper and build cut windows around useful spoken content.
- Use OCR and file metadata to keep DVR footage in the right time order.
- Filter obvious bad visual sections such as mostly black or blown-out frames.
- Export a final MP4 using FFmpeg with report title, watermark, and logo overlays.

## Download

Download the Windows installer from the [Releases](https://github.com/tangzhu71523/DiveResourcesVideoEditor/releases) page.

Normal users do not need Python, Node.js, npm, or development tools. The installer ships the desktop app runtime.

## How DiveEdit Decides What Is Useful

DiveEdit does not rely on a single signal. It combines several checks so the pipeline does not keep silent or visually empty footage just because one detector made a mistake.

### 1. Manual Windows Come First

If the user edits the timeline before starting the pipeline, the pipeline scans only those chosen windows. The original raw video stays as the source, but the scanned material becomes the user's selected time ranges.

If the user does not edit anything, each imported video starts as one full-length window.

### 2. Speech Detection

DiveEdit uses `faster-whisper` with the `large-v3-turbo` model by default. It reads spoken words with timestamps, then groups nearby words into protected speech windows.

The default VAD path is off because it can drop real diver/supervisor speech in noisy underwater footage. Instead, DiveEdit keeps Whisper word timestamps and applies its own filtering rules later.

### 3. Whisper Hallucination Filtering

Long noisy or silent footage can make Whisper invent repeated phrases such as "thank you" or "thanks for watching". DiveEdit removes likely hallucinations using:

- blacklist phrases for common fake speech,
- whitelist phrases for real inspection terms,
- repeated short phrase detection,
- low confidence checks,
- compression-ratio checks from Whisper segments,
- pronunciation-like matching for domain words.

This helps separate real report speech from repeated AI noise.

### 4. Audio Energy Backup

Some real speech may be weak or poorly transcribed. DiveEdit also scans audio energy with FFmpeg `silencedetect`. This can add non-silent regions back into the candidate list when Whisper alone is too strict.

### 5. Visual Bad-Frame Filter

DiveEdit samples frames inside candidate windows and checks HSV color values. It only drops high-confidence bad frames:

- mostly black or very dark frames,
- mostly bright, low-saturation blown-out frames.

This is intentionally conservative. It is meant to remove obvious empty footage, not judge normal underwater color changes.

### 6. Timeline Ordering

DiveEdit keeps footage order using several fallback signals:

- DVR timestamp in the filename when available,
- OCR from the burned-in video timestamp,
- file modified time as fallback,
- manual ordering as a user-editable rescue path.

OCR samples forward and backward around file edges so a black first frame or glare at the end does not immediately break ordering.

### 7. Intro Handling

The pipeline can detect intro/title footage from the report title text. If the user marks a timeline window as intro, that manual marker wins and automatic intro detection is skipped for that run.

Intro is still part of the timeline model; it is visually marked in the UI, but it remains a normal time window that can be reviewed and exported.

## Technology

### Desktop App

- Python 3.10
- PyInstaller onedir build
- pywebview desktop shell
- FastAPI backend
- WebSocket log streaming

### Frontend

- React 19
- TypeScript
- Vite
- lucide-react icons
- custom timeline editor UI

### Video and Audio

- FFmpeg for render, export, probing, audio energy checks, and clip preparation
- NVENC when CUDA is available
- libx264 fallback when GPU encode is not available

### AI and Analysis

- faster-whisper / CTranslate2 for speech recognition
- GPU preflight for CUDA, cuDNN, VRAM, and batch-size selection
- OneOCR primary OCR path for DVR timestamps
- PaddleOCR fallback when available
- OpenCV and NumPy for frame sampling and HSV checks

## Development

Install Python dependencies:

```powershell
pip install -r requirements.txt
```

Install frontend dependencies:

```powershell
cd frontend
npm install
```

Start backend:

```powershell
python -m dive_edit.webui
```

Start frontend:

```powershell
cd frontend
npm run dev
```

Build frontend:

```powershell
cd frontend
npm run build
```

Build desktop app:

```powershell
pyinstaller build/dive_edit.spec --noconfirm
```

Build installer:

```powershell
iscc build/installer.iss
```

## Runtime Output

Each job writes runtime files under:

```text
<job folder>/_diveedit/
```

This folder contains logs, cached transcripts, generated EDL files, timeline history, and export output. Job output is local runtime data and should not be committed.

## License

DiveEdit source code is released under the MIT License.

Dive Resources names, logos, icons, and brand artwork are not licensed for
reuse under the MIT License. See [TRADEMARKS.md](TRADEMARKS.md).

Third-party software and model files remain under their own licenses. See
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
