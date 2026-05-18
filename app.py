"""DiveEdit desktop entrypoint.

Three modes, dispatched by first sys.argv slot:

  --pipeline         re-entry for the editing pipeline subprocess
                     (frozen replacement for `python -m dive_edit.main`)
  --whisper-batch    re-entry for the parallel Whisper worker subprocess
                     (frozen replacement for `python -m
                     dive_edit.analyze.whisper_batch_worker`)
  (none)             GUI mode: start uvicorn on a background thread and
                     open a pywebview window pointed at it.

Both `runner.py` and `audio.py` already detect sys.frozen and emit the
right sentinel — see those files for the call sites.
"""
from __future__ import annotations

import os
import socket
import subprocess
import sys
import threading
import time
from contextlib import closing


# ── subprocess hardening (Windows) ─────────────────────────────────
# Frozen windowed exes spawn child processes with attached consoles by
# default — every nvidia-smi / ffmpeg / powershell call flashes a black
# cmd window. /api/health fires nvidia-smi on every request, and the
# WebView2 focus events trigger frequent re-fetches → users see a
# strobing console box.
#
# Patch subprocess.Popen so any child without an explicit creationflags
# is invisible. Run/check_output/etc. all go through Popen so this
# covers the entire stdlib surface.
if sys.platform == "win32" and getattr(sys, "frozen", False):
    _CREATE_NO_WINDOW = 0x08000000
    _orig_popen_init = subprocess.Popen.__init__

    def _hidden_popen_init(self, *args, **kwargs):  # type: ignore[no-untyped-def]
        if "creationflags" not in kwargs:
            kwargs["creationflags"] = _CREATE_NO_WINDOW
        _orig_popen_init(self, *args, **kwargs)

    subprocess.Popen.__init__ = _hidden_popen_init  # type: ignore[method-assign]

    # ── stderr/stdout safety net ─────────────────────────────────────
    # PyInstaller's windowed bootloader (runw.exe) sometimes leaves
    # sys.stderr / sys.stdout pointing at an invalid handle. Subsequent
    # writes raise OSError [Errno 22] Invalid argument. Replace them
    # with NUL devices so library code (uvicorn logger, ctranslate2
    # init prints, etc.) doesn't crash. Worker subprocesses still
    # receive the parent's PIPE through Popen — this only patches the
    # local handles when they're degenerate.
    import io as _io
    if sys.stderr is None or not hasattr(sys.stderr, "write"):
        try:
            sys.stderr = open(os.devnull, "w", encoding="utf-8")
        except OSError:
            sys.stderr = _io.StringIO()
    if sys.stdout is None or not hasattr(sys.stdout, "write"):
        try:
            sys.stdout = open(os.devnull, "w", encoding="utf-8")
        except OSError:
            sys.stdout = _io.StringIO()

    # ── CUDA detection → device override ─────────────────────────────
    # Look-up order:
    #   1. cudart64_12.dll already on system PATH (user installed CUDA
    #      Toolkit themselves) → use as-is.
    #   2. <install_dir>\cuda\cudart64_12.dll (bootstrap.ps1 downloaded
    #      the cu12 nvidia-* wheels at install time) → register that
    #      directory with add_dll_directory + PATH so ctranslate2 can
    #      LoadLibrary against it.
    #   3. None of the above → set DIVE_FORCE_CPU=1; audio.py will
    #      spawn whisper subprocess with device='cpu', avoiding the
    #      ctranslate2 delay-load that would crash with rc=0xC0000409.
    import ctypes
    from pathlib import Path

    def _try_load_cudart() -> bool:
        try:
            ctypes.WinDLL("cudart64_12.dll")
            return True
        except OSError:
            return False

    _cuda_ok = _try_load_cudart()
    _cuda_source = "system_path" if _cuda_ok else "none"

    def _try_register_dir(d: Path) -> bool:
        if not (d.is_dir() and (d / "cudart64_12.dll").is_file()):
            return False
        if hasattr(os, "add_dll_directory"):
            try:
                os.add_dll_directory(str(d))
            except OSError:
                pass
        os.environ["PATH"] = str(d) + os.pathsep + os.environ.get("PATH", "")
        return _try_load_cudart()

    if not _cuda_ok:
        # Tier 2: spec-bundled (the ~700MB cu12 DLL set the spec puts
        # under <_MEIPASS>/nvidia/<sub>/bin/ via _collect_nvidia_dlls).
        # This is the "one-time solve" — a fresh frozen build already
        # contains everything ctranslate2 needs to run on GPU; user
        # never has to install CUDA Toolkit or run setup-gpu.bat.
        _meipass = getattr(sys, "_MEIPASS", None)
        if _meipass:
            _spec_root = Path(_meipass) / "nvidia"
            # cudnn included so ctranslate2's delay-loaded cudnn_ops64_9.dll
            # resolves at generate-time. Without it whisper crashes mid-run.
            for _sub in ("cublas", "cuda_nvrtc", "cuda_runtime", "nvjitlink", "cudnn"):
                _bd = _spec_root / _sub / "bin"
                if _bd.is_dir():
                    if hasattr(os, "add_dll_directory"):
                        try:
                            os.add_dll_directory(str(_bd))
                        except OSError:
                            pass
                    os.environ["PATH"] = str(_bd) + os.pathsep + os.environ.get("PATH", "")
            if _try_load_cudart():
                _cuda_ok = True
                _cuda_source = "spec_bundle"

    if not _cuda_ok:
        # Tier 3: legacy bundled-next-to-exe location (setup-gpu.bat
        # against InstallDir, pre-LOCALAPPDATA migration).
        _exe_dir = Path(sys.executable).resolve().parent
        if _try_register_dir(_exe_dir / "cuda"):
            _cuda_ok = True
            _cuda_source = "bundled"

    if not _cuda_ok:
        # Tier 4: persistent user-data dir (bootstrap.ps1 / current
        # setup-gpu.bat download target). Survives rebuilds.
        _appdata = os.environ.get("LOCALAPPDATA")
        if _appdata:
            _persistent = Path(_appdata) / "DiveEdit" / "cuda"
            if _try_register_dir(_persistent):
                _cuda_ok = True
                _cuda_source = "persistent"

    # spec_bundle | system_path | bundled | persistent | none
    os.environ["DIVE_CUDA_STATUS"] = _cuda_source

    # ALSO register the persistent dir for cuDNN — independent of cuda
    # detection. cuDNN no longer ships in the spec bundle (too big for
    # GitHub push), so the wizard puts it under
    # %LOCALAPPDATA%\DiveEdit\cuda\ alongside cudart. Without this
    # registration step the cuDNN gate below fails when tier-2
    # spec_bundle wins for cudart but cuDNN lives in the persistent
    # dir → DIVE_FORCE_CPU=1 → whisper goes CPU even though everything
    # is actually present, just on a path the loader didn't search.
    _appdata = os.environ.get("LOCALAPPDATA")
    if _appdata:
        _persistent = Path(_appdata) / "DiveEdit" / "cuda"
        if _persistent.is_dir():
            if hasattr(os, "add_dll_directory"):
                try:
                    os.add_dll_directory(str(_persistent))
                except OSError:
                    pass
            os.environ["PATH"] = str(_persistent) + os.pathsep + os.environ.get("PATH", "")

    if not _cuda_ok:
        os.environ["DIVE_FORCE_CPU"] = "1"

    # cuDNN gate. Even when cudart loaded, ctranslate2 will still crash
    # at first generate() call if cudnn_ops64_9.dll is unreachable —
    # the rc=0xC0000409 crash is not a Python exception so we cannot
    # recover from it inside the worker. Fail closed: probe cuDNN here
    # and fall back to CPU if any of the required DLLs cannot load.
    if _cuda_ok:
        _cudnn_required = (
            "cudnn64_9.dll",
            "cudnn_ops64_9.dll",
            "cudnn_cnn64_9.dll",
            "cudnn_graph64_9.dll",
        )
        _cudnn_missing = []
        for _dll in _cudnn_required:
            try:
                ctypes.WinDLL(_dll)
            except OSError:
                _cudnn_missing.append(_dll)
        if _cudnn_missing:
            os.environ["DIVE_FORCE_CPU"] = "1"
            os.environ["DIVE_CUDNN_STATUS"] = "missing:" + ",".join(_cudnn_missing)
        else:
            os.environ["DIVE_CUDNN_STATUS"] = "ok"


def _strip_sentinel(flag: str) -> None:
    """Remove the dispatch sentinel so downstream argparse sees a clean argv."""
    if len(sys.argv) > 1 and sys.argv[1] == flag:
        del sys.argv[1]


def _run_pipeline() -> int:
    _strip_sentinel("--pipeline")
    from dive_edit.main import main
    return main()


def _run_whisper_batch() -> int:
    _strip_sentinel("--whisper-batch")
    from dive_edit.analyze.whisper_batch_worker import main
    return main()


def _run_download_model() -> int:
    _strip_sentinel("--download-model")
    if len(sys.argv) < 2:
        print("usage: DiveEdit.exe --download-model <repo_id>", file=sys.stderr)
        return 2
    repo = sys.argv[1]
    try:
        from huggingface_hub import snapshot_download
        path = snapshot_download(repo_id=repo)
        print(f"downloaded to {path}", flush=True)
        return 0
    except Exception as e:  # noqa: BLE001
        print(f"model download failed: {e}", file=sys.stderr, flush=True)
        return 1


def _pick_free_port(preferred: int = 8001) -> int:
    """Use the preferred port if free; otherwise let the OS pick one."""
    with closing(socket.socket(socket.AF_INET, socket.SOCK_STREAM)) as s:
        try:
            s.bind(("127.0.0.1", preferred))
            return preferred
        except OSError:
            pass
    with closing(socket.socket(socket.AF_INET, socket.SOCK_STREAM)) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _wait_for_server(host: str, port: int, timeout: float = 30.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        with closing(socket.socket(socket.AF_INET, socket.SOCK_STREAM)) as s:
            s.settimeout(0.5)
            if s.connect_ex((host, port)) == 0:
                return True
        time.sleep(0.1)
    return False


class _PickerApi:
    """JS-exposed native dialog bridge.

    PowerShell + System.Windows.Forms.FolderBrowserDialog always renders as
    a tree control regardless of AutoUpgradeEnabled — that property only
    affects visual styles, not the underlying widget. To get the modern
    Explorer view (IFileOpenDialog with FOS_PICKFOLDERS) we use pywebview's
    native dialog API, which on Windows wraps IFileOpenDialog directly.

    Frontend calls `await window.pywebview.api.pick_folder()`. In dev mode
    (no pywebview), api.ts falls back to /api/pick-folder over HTTP.
    """

    def __init__(self) -> None:
        self._window = None  # set after window creation

    def attach(self, window: object) -> None:
        self._window = window

    def pick_folder(self) -> str | None:
        if self._window is None:
            return None
        import webview
        result = self._window.create_file_dialog(  # type: ignore[attr-defined]
            webview.FOLDER_DIALOG,
            allow_multiple=False,
        )
        if not result:
            return None
        path = result[0] if isinstance(result, (list, tuple)) else result
        return str(path) if path else None

    def pick_files(self, file_filter: str | None = None) -> list[str]:
        if self._window is None:
            return []
        import webview
        # Default to the video extensions the pipeline ingests.
        types = file_filter or "Video files (*.mp4;*.avi;*.mov;*.mkv;*.m4v;*.mts;*.m2ts)"
        result = self._window.create_file_dialog(  # type: ignore[attr-defined]
            webview.OPEN_DIALOG,
            allow_multiple=True,
            file_types=(types, "All files (*.*)"),
        )
        if not result:
            return []
        return [str(p) for p in result]


def _hide_console_window() -> None:
    """Detach from the console allocated by spec console=True.

    spec is built with console=True so subprocess.Popen(stdout=PIPE) keeps
    a usable handle in the child (the windowed bootloader otherwise NULs
    sys.stdout / sys.stderr unconditionally — that's what was breaking
    the runner's progress-line readline loop and the worker's stderr
    writes).

    SW_HIDE alone leaves the console window owned by this process, so
    Windows still shows a taskbar button for it — clicking the button
    re-summons the hidden console. FreeConsole detaches our process
    from the console entirely, removing the taskbar entry as well.

    After FreeConsole, fd 1/2 dangle, so we re-bind sys.stdout / stderr
    to NUL so library writes (uvicorn logger, etc.) keep working.
    Subprocess children spawned via Popen with stdout=PIPE create their
    own pipe handles independent of the parent console — unaffected.
    """
    if sys.platform != "win32":
        return
    try:
        import ctypes
        import io as _io
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        user32 = ctypes.WinDLL("user32", use_last_error=True)
        hwnd = kernel32.GetConsoleWindow()
        if hwnd:
            SW_HIDE = 0
            user32.ShowWindow(hwnd, SW_HIDE)
        kernel32.FreeConsole()
        try:
            sys.stdout = open(os.devnull, "w", encoding="utf-8")
            sys.stderr = open(os.devnull, "w", encoding="utf-8")
        except OSError:
            sys.stdout = _io.StringIO()
            sys.stderr = _io.StringIO()
    except (OSError, AttributeError):
        pass


def _run_gui() -> int:
    # Console stays visible during boot so the user sees boot progress
    # (silent black box for several seconds otherwise reads as "frozen").
    # We only detach from the console once the webview window has actually
    # appeared on screen — see _on_window_shown below.
    print("[DiveEdit] booting…", flush=True)
    import uvicorn
    import webview

    host = "127.0.0.1"
    port = _pick_free_port(8001)

    # Make sure subprocesses inherit UTF-8 IO. Uvicorn itself logs via the
    # configured handlers; we leave its log_level at info so the packaged
    # app surfaces backend errors in the Windows event log / stderr.
    os.environ.setdefault("PYTHONIOENCODING", "utf-8")
    os.environ.setdefault("PYTHONUTF8", "1")

    # Pass the app object directly instead of "module:attr" string. uvicorn's
    # import_from_string fails under PyInstaller because the .pyc is in a
    # PYZ archive, not on sys.path as a discoverable module.
    from dive_edit.webui.server import app as fastapi_app

    def _serve() -> None:
        uvicorn.run(
            fastapi_app,
            host=host,
            port=port,
            log_level="info",
            access_log=False,
        )

    print(f"[DiveEdit] starting backend on {host}:{port}…", flush=True)
    server_thread = threading.Thread(target=_serve, daemon=True, name="uvicorn")
    server_thread.start()

    if not _wait_for_server(host, port):
        sys.stderr.write(f"[fatal] backend did not bind {host}:{port} in 30s\n")
        return 1

    print("[DiveEdit] backend ready, opening window…", flush=True)

    # Single window, no remote debugging exposed. Resizable; minimum size
    # picked to keep the canvas-based UI legible.
    api = _PickerApi()
    window = webview.create_window(
        title="DiveEdit",
        url=f"http://{host}:{port}/",
        width=1440,
        height=900,
        min_size=(1100, 720),
        js_api=api,
    )
    api.attach(window)

    # Hide the console only after the window is actually on screen. Using
    # `events.shown` (pywebview 4+) so the boot-progress prints above stay
    # visible until the user has the UI in front of them.
    def _on_window_shown() -> None:
        print("[DiveEdit] window shown — hiding console", flush=True)
        _hide_console_window()

    try:
        window.events.shown += _on_window_shown
    except (AttributeError, TypeError):
        # Older pywebview without events.shown — fall back to hiding
        # right after start callback fires (close-enough timing).
        pass

    # Maximize at launch so the first-mount canvas baseline is the
    # full screen size. Otherwise the layout sizes itself for the
    # default 1440×900 startup window, then INPUT/PIPELINE look
    # squashed when the user later maximizes — they're locked at the
    # smaller baseline. Maximizing pre-mount avoids that whole class
    # of "looks deformed at startup" reports.
    def _maximize() -> None:
        try:
            window.maximize()
        except Exception:  # noqa: BLE001
            pass
        # Fallback for older pywebview without events.shown — hide ~1.5s
        # after start callback in case the shown event never fires.
        if not getattr(window, "events", None) or not hasattr(window.events, "shown"):
            try:
                threading.Timer(1.5, _hide_console_window).start()
            except Exception:  # noqa: BLE001
                _hide_console_window()

    webview.start(_maximize)  # blocks until the window closes
    return 0


def main() -> int:
    first = sys.argv[1] if len(sys.argv) > 1 else ""
    if first == "--pipeline":
        return _run_pipeline()
    if first == "--whisper-batch":
        return _run_whisper_batch()
    if first == "--download-model":
        return _run_download_model()
    return _run_gui()


if __name__ == "__main__":
    raise SystemExit(main())
