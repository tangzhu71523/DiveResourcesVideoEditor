# Third-Party Notices

DiveEdit integrates third-party open-source software. Each dependency remains
under its own license. The DiveEdit MIT License does not replace or relicense
those third-party components.

## Runtime and Application Dependencies

- Python
- PyInstaller
- pywebview
- FastAPI
- Uvicorn
- React
- TypeScript
- Vite
- lucide-react
- OpenCV
- NumPy
- faster-whisper
- CTranslate2
- Hugging Face Hub
- ONNX Runtime

## Video and Audio Tools

DiveEdit installers include FFmpeg and FFprobe binaries for video probing,
audio analysis, clip preparation, and rendering.

FFmpeg and FFprobe are distributed under their own upstream licenses. The exact
license obligations depend on the binary build and enabled codecs. The bundled
Windows binaries should be reviewed against the upstream FFmpeg license and the
binary provider's license notes before public redistribution.

## Model Files

DiveEdit may download Whisper model files into the user's local Hugging Face
cache during setup. Model files remain under their own upstream license terms.

## Packaged Dependency Metadata

Where packaged Python or JavaScript dependencies include their own `LICENSE`,
`NOTICE`, `METADATA`, or package manifest files, those files remain authoritative
for that dependency.
