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
right sentinel; see those files for the call sites.
"""
from __future__ import annotations

import os
import socket
import subprocess
import sys
import threading
import time
from contextlib import closing
from urllib.parse import urlparse


def _patch_hidden_child_windows() -> None:
    """Prevent Windows console helper processes from flashing black windows."""
    if sys.platform != "win32":
        return
    if getattr(subprocess.Popen, "_diveedit_hidden_child_windows", False):
        return
    create_no_window = 0x08000000
    orig_popen_init = subprocess.Popen.__init__

    def hidden_popen_init(self, *args, **kwargs):  # type: ignore[no-untyped-def]
        if "creationflags" not in kwargs:
            kwargs["creationflags"] = create_no_window
        orig_popen_init(self, *args, **kwargs)

    hidden_popen_init._diveedit_hidden_child_windows = True  # type: ignore[attr-defined]
    subprocess.Popen.__init__ = hidden_popen_init  # type: ignore[method-assign]


# Subprocess hardening (Windows)
# Frozen windowed exes spawn child processes with attached consoles by
# default; every nvidia-smi / ffmpeg / powershell call flashes a black
# cmd window. /api/health fires nvidia-smi on every request, and the
# WebView2 focus events trigger frequent re-fetches, so users see a
# strobing console box.
#
# Patch subprocess.Popen so any child without an explicit creationflags
# is invisible. Run/check_output/etc. all go through Popen so this
# covers the entire stdlib surface.
if sys.platform == "win32" and getattr(sys, "frozen", False):
    _patch_hidden_child_windows()

    # stderr/stdout safety net
    # PyInstaller's windowed bootloader (runw.exe) sometimes leaves
    # sys.stderr / sys.stdout pointing at an invalid handle. Subsequent
    # writes raise OSError [Errno 22] Invalid argument. Replace them
    # with NUL devices so library code (uvicorn logger, ctranslate2
    # init prints, etc.) doesn't crash. Worker subprocesses still
    # receive the parent's PIPE through Popen; this only patches the
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

    # CUDA detection and device override.
    # Keep the 0.1.0 release behavior: prefer the frozen spec-bundled core
    # CUDA DLLs over the mutable LOCALAPPDATA runtime cache. The cache still
    # supplies cuDNN and remains a fallback for older installs.
    import ctypes
    from pathlib import Path

    def _try_load_cudart() -> bool:
        try:
            ctypes.WinDLL("cudart64_12.dll")
            return True
        except OSError:
            return False

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

    def _ct2_cuda_probe_ok() -> tuple[bool, str]:
        if len(sys.argv) > 1 and sys.argv[1] == "--cuda-probe":
            return True, "probe_child"
        try:
            probe = subprocess.run(
                [sys.executable, "--cuda-probe"],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=20,
            )
        except Exception as e:  # noqa: BLE001
            return False, f"probe_error:{type(e).__name__}:{e}"
        detail = (probe.stdout or probe.stderr or "").strip().replace("\r", " ").replace("\n", " ")
        if probe.returncode != 0:
            return False, f"probe_exit:{probe.returncode}:{detail[:240]}"
        return True, detail[:240] or "ok"

    _cuda_ok = False
    _cuda_source = "none"
    _force_cpu_requested = os.environ.get("DIVE_FORCE_CPU") == "1"

    if _force_cpu_requested:
        _cuda_source = "forced_cpu"
        os.environ["DIVE_CUDNN_STATUS"] = "skipped"

    if not _cuda_ok and not _force_cpu_requested:
        # Tier 1: PyInstaller spec-bundled core CUDA runtime.
        _meipass = getattr(sys, "_MEIPASS", None)
        if _meipass:
            _spec_root = Path(_meipass) / "nvidia"
            for _sub in ("cublas", "cuda_nvrtc", "cuda_runtime", "nvjitlink", "cudnn"):
                _bd = _spec_root / _sub / "bin"
                if not _bd.is_dir():
                    continue
                if hasattr(os, "add_dll_directory"):
                    try:
                        os.add_dll_directory(str(_bd))
                    except OSError:
                        pass
                os.environ["PATH"] = str(_bd) + os.pathsep + os.environ.get("PATH", "")
            if _try_load_cudart():
                _cuda_ok = True
                _cuda_source = "spec_bundle"

    if not _cuda_ok and not _force_cpu_requested:
        # Tier 2: legacy bundled-next-to-exe location (setup-gpu.bat
        # against InstallDir, pre-LOCALAPPDATA migration).
        _exe_dir = Path(sys.executable).resolve().parent
        if _try_register_dir(_exe_dir / "cuda"):
            _cuda_ok = True
            _cuda_source = "bundled"

    if not _cuda_ok and not _force_cpu_requested:
        # Tier 3: pinned runtime prepared by setup bootstrap.
        _appdata = os.environ.get("LOCALAPPDATA")
        if _appdata:
            _persistent = Path(_appdata) / "DiveEdit" / "cuda"
            if _try_register_dir(_persistent):
                _cuda_ok = True
                _cuda_source = "persistent"

    if not _cuda_ok and not _force_cpu_requested:
        _cuda_ok = _try_load_cudart()
        _cuda_source = "system_path" if _cuda_ok else "none"

    # spec_bundle | bundled | persistent | system_path | none
    os.environ["DIVE_CUDA_STATUS"] = _cuda_source

    # Also register the persistent CUDA dir for cuDNN. Setup downloads
    # the pinned runtime there when NVIDIA exists; without this loader
    # path, ctranslate2 can see cudart but still fail when cuDNN loads.
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

    # CUDA dependency gate. Even when cudart loaded, ctranslate2 can crash
    # at first generate() call if cuBLAS/cuDNN is unreachable. Fail closed
    # and fall back to CPU if any required DLL cannot load.
    if _cuda_ok:
        _gpu_required = (
            "cublas64_12.dll",
            "cublasLt64_12.dll",
            "cudnn64_9.dll",
            "cudnn_ops64_9.dll",
            "cudnn_cnn64_9.dll",
            "cudnn_graph64_9.dll",
        )
        _gpu_missing = []
        for _dll in _gpu_required:
            try:
                ctypes.WinDLL(_dll)
            except OSError:
                _gpu_missing.append(_dll)
        if _gpu_missing:
            os.environ["DIVE_FORCE_CPU"] = "1"
            os.environ["DIVE_CUDA_STATUS"] = "none"
            os.environ["DIVE_CUDNN_STATUS"] = "missing:" + ",".join(_gpu_missing)
        else:
            os.environ["DIVE_CUDNN_STATUS"] = "ok"
            _ct2_ok, _ct2_detail = _ct2_cuda_probe_ok()
            os.environ["DIVE_CUDA_PROBE"] = _ct2_detail
            if not _ct2_ok:
                os.environ["DIVE_FORCE_CPU"] = "1"
                os.environ["DIVE_CUDA_STATUS"] = "none"


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
    rc = main()
    try:
        sys.stdout.flush()
        sys.stderr.flush()
    except Exception:
        pass
    os._exit(rc)


def _run_download_model() -> int:
    _strip_sentinel("--download-model")
    if len(sys.argv) < 2:
        print("usage: DiveEdit.exe --download-model <repo_id>", file=sys.stderr)
        return 2
    repo = sys.argv[1]
    try:
        from huggingface_hub import snapshot_download
        import shutil
        from pathlib import Path

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
        print(f"downloaded to {path}", flush=True)
        return 0
    except Exception as e:  # noqa: BLE001
        print(f"model download failed: {e}", file=sys.stderr, flush=True)
        return 1


def _run_cuda_probe() -> int:
    try:
        import ctranslate2  # type: ignore
        count = int(ctranslate2.get_cuda_device_count())
    except Exception as e:  # noqa: BLE001
        print(f"ct2_probe_failed:{type(e).__name__}:{e}", file=sys.stderr, flush=True)
        return 1
    if count <= 0:
        print("ct2_cuda_devices=0", flush=True)
        return 1
    print(f"ct2_cuda_devices={count}", flush=True)
    return 0


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
    a tree control regardless of AutoUpgradeEnabled; that property only
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
    sys.stdout / sys.stderr unconditionally; that's what was breaking
    the runner's progress-line readline loop and the worker's stderr
    writes).

    SW_HIDE alone leaves the console window owned by this process, so
    Windows still shows a taskbar button for it; clicking the button
    re-summons the hidden console. FreeConsole detaches our process
    from the console entirely, removing the taskbar entry as well.

    After FreeConsole, fd 1/2 dangle, so we re-bind sys.stdout / stderr
    to NUL so library writes (uvicorn logger, etc.) keep working.
    Subprocess children spawned via Popen with stdout=PIPE create their
    own pipe handles independent of the parent console, so they are unaffected.
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
    # appeared on screen; see _on_window_shown below.
    print("[DiveEdit] booting...", flush=True)
    _patch_hidden_child_windows()
    import uvicorn
    import webview

    host = "127.0.0.1"
    port_env = os.environ.get("DIVE_BACKEND_PORT", "").strip()
    try:
        port = int(port_env) if port_env else _pick_free_port(8001)
    except ValueError:
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

    print(f"[DiveEdit] starting backend on {host}:{port}...", flush=True)
    server_thread = threading.Thread(target=_serve, daemon=True, name="uvicorn")
    server_thread.start()

    if not _wait_for_server(host, port):
        sys.stderr.write(f"[fatal] backend did not bind {host}:{port} in 30s\n")
        return 1

    dev_window_url = "" if getattr(sys, "frozen", False) else os.environ.get("DIVE_WEBVIEW_URL", "").strip()
    window_url = dev_window_url or f"http://{host}:{port}/"
    frontend = urlparse(window_url)
    if frontend.hostname and frontend.port and frontend.port != port:
        print(f"[DiveEdit] waiting for frontend on {frontend.hostname}:{frontend.port}...", flush=True)
        if not _wait_for_server(frontend.hostname, frontend.port):
            sys.stderr.write(f"[fatal] frontend did not bind {frontend.hostname}:{frontend.port} in 30s\n")
            for label, env_key in (("vite stderr", "DIVE_WEBVIEW_FRONTEND_ERR"), ("vite stdout", "DIVE_WEBVIEW_FRONTEND_LOG")):
                log_path = os.environ.get(env_key, "").strip()
                if not log_path or not os.path.exists(log_path):
                    continue
                try:
                    with open(log_path, "r", encoding="utf-8", errors="replace") as fh:
                        text = fh.read()[-4000:].strip()
                except OSError:
                    continue
                if text:
                    sys.stderr.write(f"[{label}] {log_path}\n{text}\n")
            return 1

    print(f"[DiveEdit] backend ready, opening window at {window_url}...", flush=True)

    # Single window, no remote debugging exposed. Resizable; minimum size
    # picked to keep the canvas-based UI legible.
    api = _PickerApi()
    window = webview.create_window(
        title="DiveEdit",
        url=window_url,
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
        print("[DiveEdit] window shown; hiding console", flush=True)
        _hide_console_window()

    try:
        window.events.shown += _on_window_shown
    except (AttributeError, TypeError):
        # Older pywebview without events.shown: fall back to hiding
        # right after start callback fires (close-enough timing).
        pass

    # Maximize at launch so the first-mount canvas baseline is the
    # full screen size. Otherwise the layout sizes itself for the
    # default 1440x900 startup window, then INPUT/PIPELINE look
    # squashed when the user later maximizes; they're locked at the
    # smaller baseline. Maximizing pre-mount avoids that whole class
    # of "looks deformed at startup" reports.
    def _maximize() -> None:
        try:
            window.maximize()
        except Exception:  # noqa: BLE001
            pass
        # Fallback for older pywebview without events.shown: hide ~1.5s
        # after start callback in case the shown event never fires.
        if not getattr(window, "events", None) or not hasattr(window.events, "shown"):
            try:
                threading.Timer(1.5, _hide_console_window).start()
            except Exception:  # noqa: BLE001
                _hide_console_window()

    try:
        webview.start(_maximize)  # blocks until the window closes
    finally:
        try:
            from dive_edit.webui.runner import manager as run_manager
            run_manager.cancel_all()
        except Exception:  # noqa: BLE001
            pass
    return 0


def main() -> int:
    first = sys.argv[1] if len(sys.argv) > 1 else ""
    if first == "--pipeline":
        return _run_pipeline()
    if first == "--whisper-batch":
        return _run_whisper_batch()
    if first == "--download-model":
        return _run_download_model()
    if first == "--cuda-probe":
        return _run_cuda_probe()
    return _run_gui()


if __name__ == "__main__":
    raise SystemExit(main())
