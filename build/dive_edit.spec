# -*- mode: python ; coding: utf-8 -*-
# PyInstaller spec for DiveEdit. Build:
#     pyinstaller build/dive_edit.spec --noconfirm
#
# Produces dist/DiveEdit/ (onedir). Inno Setup wraps that into the
# installer; see build/installer.iss.
#
# Onedir, not onefile: faster startup, simpler ffmpeg / model bundling,
# and lets the installer script swap individual files without re-extracting.

from pathlib import Path
from PyInstaller.utils.hooks import collect_data_files, collect_submodules

PROJECT_ROOT = Path(SPECPATH).resolve().parent

def _collect_nvidia_dlls():
    """Do not bundle CUDA into the release.

    The installer prepares CUDA/cuDNN under %LOCALAPPDATA%\DiveEdit\cuda only
    on GPU machines that pass the Whisper VRAM gate. CPU machines should not
    carry unused CUDA DLLs in Program Files.
    """
    return []

# Bundled data
# Anything in this list lands next to the exe under the same relative
# path. Read at runtime via dive_edit.utils.paths.app_root().
datas = [
    (str(PROJECT_ROOT / "frontend" / "dist"), "frontend/dist"),
    (str(PROJECT_ROOT / "assets"), "assets"),
    (str(PROJECT_ROOT / "config.yaml"), "."),
]

# faster-whisper / ctranslate2 ship native libs and tokenizer assets that
# PyInstaller's auto-detection misses.
datas += collect_data_files("faster_whisper")
datas += collect_data_files("ctranslate2")
datas += collect_data_files("oneocr")

# These packages have lazy / dynamic imports PyInstaller can't statically
# trace. Forcing collection prevents "No module named X" at runtime.
hiddenimports = []
hiddenimports += collect_submodules("faster_whisper")
hiddenimports += collect_submodules("ctranslate2")
hiddenimports += collect_submodules("uvicorn")
hiddenimports += collect_submodules("fastapi")
hiddenimports += collect_submodules("oneocr")
# faster-whisper runtime deps (Requires: av, ctranslate2, huggingface-hub,
# onnxruntime, tokenizers, tqdm). They were over-excluded earlier under
# the assumption nothing in dive_edit imported them directly, but
# faster_whisper.audio uses av and faster_whisper.tokenizer uses tokenizers,
# so excluding either crashes whisper batch at first call.
hiddenimports += collect_submodules("av")
hiddenimports += collect_submodules("tokenizers")
hiddenimports += collect_submodules("huggingface_hub")
hiddenimports += collect_submodules("onnxruntime")
hiddenimports += [
    "tkinter",
    "tkinter.filedialog",
    "PIL._tkinter_finder",
    "av",
    "av.audio",
    "av.video",
    "tqdm",
]

# Native binaries / data files for av and tokenizers.
datas += collect_data_files("av")
datas += collect_data_files("tokenizers")
datas += collect_data_files("huggingface_hub")
datas += collect_data_files("onnxruntime")

# Excluded: anything dev-only or we explicitly don't ship.
# - paddleocr is a fallback path retained in source but installer-gated;
#   if you ship a slim build, leave it out and rely on OneOCR alone.
# - matplotlib / pandas / scipy may be transitive deps from torch utils
#   we never call at runtime; drop them to shave package size.
excludes = [
    "paddleocr",
    "paddle",
    "paddlepaddle",
    "matplotlib",
    "pandas",
    "scipy",
    "tests",
    "test",
    "IPython",
    "jupyter",
    "notebook",
    "whisperx",
    "pytorch_lightning",
    "torch",
    "torchvision",
    "torchaudio",
    "torchcodec",
    "torch_audiomentations",
    "torch_pitch_shift",
    "torch_complex",
    "pytorch_metric_learning",
    "bitsandbytes",
    "numba",
    "llvmlite",
    "sympy",
    "transformers",
    "sentence_transformers",
    "speechbrain",
    "espnet",
    "espnet2",
    "torchmetrics",
    "lightning",
    "tensorflow",
    "keras",
    "datasets",
    "accelerate",
    "nvidia.cudnn",
]


a = Analysis(
    [str(PROJECT_ROOT / "app.py")],
    pathex=[str(PROJECT_ROOT)],
    binaries=_collect_nvidia_dlls(),
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=excludes,
    noarchive=False,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="DiveEdit",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,                 # UPX confuses Windows Defender + slows whisper load
    console=True,              # console=True keeps Python's stdout/stderr
                               # handles valid in subprocess mode (parent
                               # uses stdout=PIPE to read pipeline progress).
                               # PyInstaller's windowed bootloader NULs the
                               # handles unconditionally, breaking the
                               # progress bar wiring AND the worker stderr
                               # path. GUI mode hides the console window
                               # at runtime via ShowWindow(GetConsoleWindow,
                               # SW_HIDE) in app.py; see _hide_console().
    disable_windowed_traceback=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=str(PROJECT_ROOT / "assets" / "diveedit.ico"),
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name="DiveEdit",
)
