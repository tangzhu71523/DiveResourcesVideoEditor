# -*- mode: python ; coding: utf-8 -*-
# PyInstaller spec for DiveEdit. Build:
#     pyinstaller build/dive_edit.spec --noconfirm
#
# Produces dist/DiveEdit/ (onedir). Inno Setup wraps that into the
# installer — see build/installer.iss.
#
# Onedir, not onefile: faster startup, simpler ffmpeg / model bundling,
# and lets the installer script swap individual files without re-extracting.

import os
from pathlib import Path
from PyInstaller.utils.hooks import collect_data_files, collect_submodules

PROJECT_ROOT = Path(SPECPATH).resolve().parent

# Inject nvidia/<sub>/bin into build-time PATH so PyInstaller's ctypes
# binding analyzer can resolve `ctypes.WinDLL("cudart64_12.dll")` in
# app.py (a runtime probe — the DLL is also bundled via
# _collect_nvidia_dlls below, but the analyzer searches PATH only and
# would otherwise emit "Library cudart64_12.dll required via ctypes
# not found".
try:
    import nvidia as _nvidia_pkg
    _nv_root = Path(_nvidia_pkg.__file__).parent
    for _sub in ("cuda_runtime", "cublas", "cuda_nvrtc", "nvjitlink", "cudnn"):
        _bd = _nv_root / _sub / "bin"
        if _bd.is_dir():
            os.environ["PATH"] = str(_bd) + os.pathsep + os.environ.get("PATH", "")
except ImportError:
    pass

# Bundle CUDA 12 minimum runtime DLLs directly into the frozen tree
# so `release/DiveEdit/DiveEdit.exe` works as GPU-enabled out of the
# box — no setup-gpu.bat, no installer, no Toolkit. This was the
# user's stated "one-time solve". Bundle ~700MB total, dominated by
# cublasLt64_12.dll (526MB).
#
# Filtered to the cu12-generation set ctranslate2 4.6 actually loads:
# cu11 wheels are the wrong ABI; cudnn ships inside the ctranslate2
# package directory (cudnn64_9.dll); cufft / cusolver are not used by
# faster-whisper inference, only matrix ops we don't touch.
def _collect_nvidia_dlls():
    # cuDNN 9 is intentionally NOT bundled here — the full cudnn 9
    # DLL set (~600MB) blows past GitHub's per-file/repo push limits.
    # The wizard (install-time bootstrap.ps1) downloads the
    # nvidia-cudnn-cu12 wheel to %LOCALAPPDATA%\DiveEdit\cuda\ which
    # app.py picks up via tier-4 detection. If wizard skipped or
    # offline → app.py's cuDNN gate flips DIVE_FORCE_CPU=1 so whisper
    # runs CPU instead of crashing mid-generate with 0xC0000409.
    try:
        import nvidia
    except ImportError:
        return []
    root = Path(nvidia.__file__).parent
    out = []
    cu12_subs = ("cublas", "cuda_nvrtc", "cuda_runtime", "nvjitlink")
    for sub in cu12_subs:
        bin_dir = root / sub / "bin"
        if not bin_dir.exists():
            continue
        for dll in bin_dir.glob("*.dll"):
            n = dll.name.lower()
            # Drop cu11-era libs.
            if "_11.dll" in n or "_118.dll" in n or "_112_" in n:
                continue
            out.append((str(dll), f"nvidia/{sub}/bin"))
    return out

# ── Bundled data ─────────────────────────────────────────────────────
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
# the assumption nothing in dive_edit imported them directly — but
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
#   we never call at runtime — drop them to shave ~200MB.
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
                               # SW_HIDE) in app.py — see _hide_console().
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
