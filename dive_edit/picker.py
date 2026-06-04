"""Folder picker (tkinter) and intro-file selector (numbered console list)."""
from __future__ import annotations
import json
import subprocess
import sys
import textwrap
from pathlib import Path

from .utils.paths import list_mp4s


def pick_job_folder(initial_dir: str | None = None) -> Path | None:
    """Open a tkinter folder picker dialog. Returns None if user cancels.

    Invoked via CLI directly runs tkinter on the current (main) thread.
    When called from the FastAPI threadpool worker, tkinter will raise
    "main thread is not in main loop" — use `pick_job_folder_subprocess()`
    from that context instead.
    """
    import tkinter as tk
    from tkinter import filedialog

    root = tk.Tk()
    root.withdraw()
    root.attributes("-topmost", True)
    chosen = filedialog.askdirectory(
        title="Select Job folder (containing exported mp4 files)",
        initialdir=initial_dir or "",
    )
    root.destroy()
    if not chosen:
        return None
    return Path(chosen)


def pick_folder_modern(initial_dir: str | None = None) -> str | None:
    """Folder picker — FolderBrowserDialog with DPI + VisualStyles for clean UI."""
    init = (initial_dir or "").replace("'", "''")
    ps_code = (
        "Add-Type -AssemblyName System.Windows.Forms\n"
        "[System.Windows.Forms.Application]::EnableVisualStyles()\n"
        "[System.Windows.Forms.Application]::SetCompatibleTextRenderingDefault($false)\n"
        "Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public class DpiAware { [DllImport(\"user32.dll\")] public static extern bool SetProcessDPIAware(); }'\n"
        "[DpiAware]::SetProcessDPIAware()\n"
        "$d = New-Object System.Windows.Forms.FolderBrowserDialog\n"
        f"$d.SelectedPath = '{init}'\n"
        "$d.Description = 'Select job folder'\n"
        "$d.UseDescriptionForTitle = $true\n"
        "$d.ShowNewFolderButton = $false\n"
        "$d.AutoUpgradeEnabled = $true\n"
        "if ($d.ShowDialog() -eq 'OK') { $d.SelectedPath } else { '' }\n"
    )
    try:
        proc = subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-STA", "-Command", ps_code],
            capture_output=True, text=True, encoding="utf-8",
            errors="replace", timeout=600, check=False,
        )
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
        return None
    raw = proc.stdout.strip()
    return raw if raw and Path(raw).is_dir() else None


def pick_files_modern(initial_dir: str | None = None) -> list[Path]:
    """IFileOpenDialog file picker — modern Explorer, multi-select, DPI-aware."""
    init = (initial_dir or "").replace("'", "''")
    ps_code = (
        "Add-Type -AssemblyName System.Windows.Forms\n"
        "[System.Windows.Forms.Application]::EnableVisualStyles()\n"
        "[System.Windows.Forms.Application]::SetCompatibleTextRenderingDefault($false)\n"
        "Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public class DpiAware { [DllImport(\"user32.dll\")] public static extern bool SetProcessDPIAware(); }'\n"
        "[DpiAware]::SetProcessDPIAware()\n"
        "$d = New-Object System.Windows.Forms.OpenFileDialog\n"
        "$d.Title = 'Select video files'\n"
        f"$d.InitialDirectory = '{init}'\n"
        "$d.Filter = 'Video files|*.mp4;*.avi;*.mov;*.mkv;*.m4v;*.mts;*.m2ts|All files|*.*'\n"
        "$d.Multiselect = $true\n"
        "$d.AutoUpgradeEnabled = $true\n"
        "if ($d.ShowDialog() -eq 'OK') { $d.FileNames -join '|' } else { '' }\n"
    )
    try:
        proc = subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-STA", "-Command", ps_code],
            capture_output=True, text=True, encoding="utf-8",
            errors="replace", timeout=600, check=False,
        )
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
        return []
    raw = proc.stdout.strip()
    if not raw:
        return []
    return [Path(p) for p in raw.split("|") if p.strip() and Path(p.strip()).is_file()]


def pick_files_subprocess(
    initial_dir: str | None = None,
    mode: str = "folder",
) -> tuple[list[Path], str | None]:
    """Unified picker entry point.

    mode="folder" → modern folder picker (first import)
    mode="files"  → modern file picker with multi-select (add more)

    Returns (file_list, folder_path):
      - Folder picked: ([], folder_string)
      - Files picked:  ([path, ...], None)
      - Cancel:        ([], None)
    """
    if mode == "folder":
        folder = pick_folder_modern(initial_dir)
        if folder:
            return ([], folder)
        return ([], None)
    else:
        files = pick_files_modern(initial_dir)
        if files:
            return (files, None)
        return ([], None)


def pick_job_folder_subprocess(initial_dir: str | None = None) -> Path | None:
    """Launch tkinter in a fresh Python subprocess so it owns its own main
    thread — required when this is called from an ASGI request handler.

    Prints the chosen absolute path to the child's stdout (or empty line on
    cancel). Parent blocks until the child exits, then returns a Path.
    """
    from .utils.paths import app_root
    project_root = app_root()
    logo_candidates = [
        project_root / "assets" / "Diveresources Logo.png",
        project_root / "frontend" / "src" / "assets" / "logo-only.png",
    ]
    logo_path = next((p for p in logo_candidates if p.is_file()), None)

    code = textwrap.dedent(f"""
        import sys
        import ctypes
        ctypes.windll.user32.SetProcessDPIAware()
        import tkinter as tk
        from tkinter import filedialog

        root = tk.Tk()
        root.withdraw()
        # Brand the dialog title-bar icon with the company logo (same PNG
        # the WebUI header uses). iconphoto(True, ...) applies to the root
        # AND every subsequent toplevel — so the file dialog inherits it.
        # Keep _logo as a module-level reference so Python doesn't GC it
        # before Tk has read the bitmap.
        _logo = None
        try:
            _logo = tk.PhotoImage(file={str(logo_path)!r})
            root.iconphoto(True, _logo)
        except (tk.TclError, OSError):
            pass
        root.attributes("-topmost", True)
        chosen = filedialog.askdirectory(
            title="Select job folder",
            initialdir={initial_dir!r} or "",
        )
        root.destroy()
        sys.stdout.buffer.write((chosen or "").encode("utf-8"))
        sys.stdout.flush()
    """).strip()

    # In frozen builds sys.executable points to DiveEdit.exe, which doesn't
    # accept `-c <code>`. Fall back to PowerShell + Windows.Forms.
    # FolderBrowserDialog — pure Win32, no Python child needed.
    if getattr(sys, "frozen", False):
        return _pick_via_powershell(initial_dir)

    try:
        result = subprocess.run(
            [sys.executable, "-c", code],
            capture_output=True,
            timeout=600,  # 10 min max — user may walk away
            check=False,
        )
    except (subprocess.TimeoutExpired, OSError):
        return None

    chosen = result.stdout.decode("utf-8", errors="replace").strip()
    return Path(chosen) if chosen else None


def _pick_via_powershell(initial_dir: str | None) -> Path | None:
    """Frozen-friendly folder picker. PowerShell is on every modern Windows."""
    initial = (initial_dir or "").replace("'", "''")
    ps_script = (
        "Add-Type -AssemblyName System.Windows.Forms; "
        "$dlg = New-Object System.Windows.Forms.FolderBrowserDialog; "
        "$dlg.Description = 'Select job folder'; "
        f"$dlg.SelectedPath = '{initial}'; "
        "$dlg.ShowNewFolderButton = $false; "
        "if ($dlg.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) "
        "{ [Console]::Out.Write($dlg.SelectedPath) }"
    )
    try:
        result = subprocess.run(
            ["powershell.exe", "-NoProfile", "-STA", "-Command", ps_script],
            capture_output=True,
            timeout=600,
            check=False,
        )
    except (subprocess.TimeoutExpired, OSError):
        return None
    chosen = result.stdout.decode("utf-8", errors="replace").strip()
    return Path(chosen) if chosen else None


def probe_duration_sec(mp4_path: Path) -> float:
    """Use ffprobe to read media duration in seconds. Returns 0.0 on failure."""
    try:
        result = subprocess.run(
            [
                "ffprobe", "-v", "error",
                "-show_entries", "format=duration",
                "-of", "json",
                str(mp4_path),
            ],
            capture_output=True, text=True, check=True,
        )
        data = json.loads(result.stdout or "{}")
        return float(data.get("format", {}).get("duration", 0.0))
    except (subprocess.CalledProcessError, ValueError, FileNotFoundError):
        return 0.0


def probe_dimensions(mp4_path: Path) -> tuple[int, int]:
    """ffprobe first video stream's display dimensions. Returns (w, h) or (0, 0) on failure.

    Honours stream-level SAR/DAR so anamorphic sources (e.g. 720x576 PAL with
    16:9 SAR=64/45) report their *display* ratio, not raw pixel count.
    """
    try:
        result = subprocess.run(
            [
                "ffprobe", "-v", "error",
                "-select_streams", "v:0",
                "-show_entries", "stream=width,height,display_aspect_ratio,sample_aspect_ratio",
                "-of", "json",
                str(mp4_path),
            ],
            capture_output=True, text=True, check=True,
        )
        data = json.loads(result.stdout or "{}")
        streams = data.get("streams") or []
        if not streams:
            return (0, 0)
        s = streams[0]
        w = int(s.get("width", 0) or 0)
        h = int(s.get("height", 0) or 0)
        if w <= 0 or h <= 0:
            return (0, 0)
        dar = s.get("display_aspect_ratio")
        if dar and ":" in dar:
            try:
                dw, dh = (int(x) for x in dar.split(":", 1))
                if dw > 0 and dh > 0:
                    return (round(h * dw / dh), h)
            except ValueError:
                pass
        sar = s.get("sample_aspect_ratio")
        if sar and ":" in sar and sar != "1:1":
            try:
                sw, sh = (int(x) for x in sar.split(":", 1))
                if sw > 0 and sh > 0:
                    return (round(w * sw / sh), h)
            except ValueError:
                pass
        return (w, h)
    except (subprocess.CalledProcessError, ValueError, FileNotFoundError):
        return (0, 0)


def _fmt_duration(sec: float) -> str:
    if sec <= 0:
        return "  --:--"
    m, s = divmod(int(round(sec)), 60)
    h, m = divmod(m, 60)
    if h:
        return f"{h:d}:{m:02d}:{s:02d}"
    return f"{m:2d}:{s:02d}"


def list_with_durations(job_folder: Path) -> list[tuple[Path, float]]:
    return [(p, probe_duration_sec(p)) for p in list_mp4s(job_folder)]


def pick_intro_file(job_folder: Path) -> Path | None:
    """Show a numbered list of all mp4s with durations and ask the user to pick one.

    Returns the chosen path, or None on EOF/invalid input.
    """
    files = list_with_durations(job_folder)
    if not files:
        print(f"⚠ No .mp4 files found in folder: {job_folder}")
        return None

    print()
    print(f"[Found {len(files)} mp4 file(s)]")
    for i, (path, dur) in enumerate(files, start=1):
        marker = "  <- short file, possible intro" if 0 < dur < 10 * 60 else ""
        print(f"  {i:2d}. {path.name:<40s} ({_fmt_duration(dur)}){marker}")

    print()
    while True:
        try:
            raw = input("Which file is the diver intro? Enter index: ").strip()
        except EOFError:
            return None
        if not raw:
            continue
        try:
            idx = int(raw)
        except ValueError:
            print("  Please enter a number.")
            continue
        if not (1 <= idx <= len(files)):
            print(f"  Range is 1-{len(files)}.")
            continue
        return files[idx - 1][0]
