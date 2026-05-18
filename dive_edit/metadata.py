"""job.yaml read/write and the three interactive prompts.

job.yaml lives in the job folder and survives across runs so the second
processing of the same job needs zero typing.

Multi-line text input uses Notepad by default on Windows — console
`input()` loops with an "empty line terminates" rule are fragile and get
tripped up by stray whitespace, IME state, and paste buffers.
"""
from __future__ import annotations
import os
import re
import subprocess
import sys
import tempfile
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Any

import yaml


JOB_YAML_NAME = "job.yaml"


@dataclass
class OverlayElement:
    """Per-text-block tweak authored against a 1920×1080 canvas.

    Position is relative to the element's natural anchor:
      cover anchor = canvas center  → (0,0) means dead-center
      small anchor = top-left 2%/2% → (0,0) means standard watermark.
    Scale multiplies rendered size: 1.0 = 100%. Drag a corner of the
    overlay's bounding box → equal scale on both axes. Drag an edge →
    just that axis.
    """
    font_size: float = 44.0
    line_spacing: float = 16.0
    letter_spacing: float = 2.0
    position_x: float = 0.0
    position_y: float = 0.0
    scale_x: float = 1.0          # legacy
    scale_y: float = 1.0          # legacy
    whole_scale: float = 1.0      # master multiplier on font + line + letter
    box_width: float = 100.0      # text box max-width as % of canvas (20..100)

    def to_dict(self) -> dict[str, float]:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict[str, Any] | None, *, default: "OverlayElement") -> "OverlayElement":
        if not isinstance(d, dict):
            return OverlayElement(
                font_size=default.font_size,
                line_spacing=default.line_spacing,
                letter_spacing=default.letter_spacing,
                position_x=default.position_x,
                position_y=default.position_y,
                scale_x=default.scale_x,
                scale_y=default.scale_y,
                whole_scale=default.whole_scale,
                box_width=default.box_width,
            )
        return cls(
            font_size=float(d.get("font_size", default.font_size)),
            line_spacing=float(d.get("line_spacing", default.line_spacing)),
            letter_spacing=float(d.get("letter_spacing", default.letter_spacing)),
            position_x=float(d.get("position_x", default.position_x)),
            position_y=float(d.get("position_y", default.position_y)),
            scale_x=float(d.get("scale_x", default.scale_x)),
            scale_y=float(d.get("scale_y", default.scale_y)),
            whole_scale=float(d.get("whole_scale", default.whole_scale)),
            box_width=float(d.get("box_width", default.box_width)),
        )


_DEFAULT_COVER_OVERLAY = OverlayElement(
    font_size=44.0, line_spacing=16.0, letter_spacing=2.0,
    position_x=0.0, position_y=0.0, scale_x=1.0, scale_y=1.0,
    whole_scale=1.0, box_width=100.0,
)
_DEFAULT_SMALL_OVERLAY = OverlayElement(
    font_size=18.0, line_spacing=10.0, letter_spacing=0.0,
    position_x=0.0, position_y=0.0, scale_x=1.0, scale_y=1.0,
    whole_scale=1.0, box_width=50.0,
)


@dataclass
class JobMeta:
    job_no: str = ""
    vessel: str = ""
    intro_file: str = ""               # filename relative to job folder
    body_files: list[str] = field(default_factory=list)
    # Optional allow-list of body mp4 filenames. Empty list = include every
    # non-intro mp4 (current behaviour). Non-empty = only these files are
    # fed to the pipeline and EDL. Useful when the job folder
    # contains pre-dive setup footage that should not appear in the edit.
    cover_lines: list[str] = field(default_factory=list)
    small_lines: list[str] = field(default_factory=list)
    target_duration_min: int = 60
    intro_speech_override: tuple[float, float] | None = None
    cover_overlay: OverlayElement = field(default_factory=lambda: OverlayElement(
        font_size=_DEFAULT_COVER_OVERLAY.font_size,
        line_spacing=_DEFAULT_COVER_OVERLAY.line_spacing,
        letter_spacing=_DEFAULT_COVER_OVERLAY.letter_spacing,
        position_x=_DEFAULT_COVER_OVERLAY.position_x,
        position_y=_DEFAULT_COVER_OVERLAY.position_y,
        scale_x=_DEFAULT_COVER_OVERLAY.scale_x,
        scale_y=_DEFAULT_COVER_OVERLAY.scale_y,
        whole_scale=_DEFAULT_COVER_OVERLAY.whole_scale,
        box_width=_DEFAULT_COVER_OVERLAY.box_width,
    ))
    small_overlay: OverlayElement = field(default_factory=lambda: OverlayElement(
        font_size=_DEFAULT_SMALL_OVERLAY.font_size,
        line_spacing=_DEFAULT_SMALL_OVERLAY.line_spacing,
        letter_spacing=_DEFAULT_SMALL_OVERLAY.letter_spacing,
        position_x=_DEFAULT_SMALL_OVERLAY.position_x,
        position_y=_DEFAULT_SMALL_OVERLAY.position_y,
        scale_x=_DEFAULT_SMALL_OVERLAY.scale_x,
        scale_y=_DEFAULT_SMALL_OVERLAY.scale_y,
        whole_scale=_DEFAULT_SMALL_OVERLAY.whole_scale,
        box_width=_DEFAULT_SMALL_OVERLAY.box_width,
    ))
    # Master switch: False skips title, watermark, and logo during export.
    overlay_enabled: bool = True

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        if self.intro_speech_override is not None:
            d["intro_speech_override"] = list(self.intro_speech_override)
        return d

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "JobMeta":
        override = d.get("intro_speech_override")
        if isinstance(override, (list, tuple)) and len(override) == 2:
            override = (float(override[0]), float(override[1]))
        else:
            override = None
        return cls(
            job_no=str(d.get("job_no", "")),
            vessel=str(d.get("vessel", "")),
            intro_file=str(d.get("intro_file", "")),
            body_files=list(d.get("body_files", []) or []),
            cover_lines=list(d.get("cover_lines", []) or []),
            small_lines=list(d.get("small_lines", []) or []),
            target_duration_min=int(d.get("target_duration_min", 60)),
            intro_speech_override=override,
            cover_overlay=OverlayElement.from_dict(d.get("cover_overlay"), default=_DEFAULT_COVER_OVERLAY),
            small_overlay=OverlayElement.from_dict(d.get("small_overlay"), default=_DEFAULT_SMALL_OVERLAY),
            overlay_enabled=bool(d.get("overlay_enabled", True)),
        )


def yaml_path(job_folder: Path) -> Path:
    """Active job.yaml location: <job>/_diveedit/job.yaml. Legacy
    job folders that still have job.yaml at the root are migrated
    automatically the first time load() runs."""
    from .utils.paths import job_yaml_path
    return job_yaml_path(job_folder)


def _legacy_yaml_path(job_folder: Path) -> Path:
    return job_folder / JOB_YAML_NAME


def load(job_folder: Path) -> JobMeta | None:
    p = yaml_path(job_folder)
    legacy = _legacy_yaml_path(job_folder)
    # Migration: move root job.yaml under _diveedit/ on first read.
    if not p.exists() and legacy.exists():
        p.parent.mkdir(parents=True, exist_ok=True)
        try:
            legacy.rename(p)
        except OSError:
            # Fallback to copy + delete if rename failed (cross-volume).
            p.write_bytes(legacy.read_bytes())
            try:
                legacy.unlink()
            except OSError:
                pass
    if not p.exists():
        return None
    with p.open("r", encoding="utf-8") as f:
        data = yaml.safe_load(f) or {}
    return JobMeta.from_dict(data)


def save(job_folder: Path, meta: JobMeta) -> Path:
    p = yaml_path(job_folder)
    with p.open("w", encoding="utf-8") as f:
        yaml.safe_dump(meta.to_dict(), f, allow_unicode=True, sort_keys=False)
    return p


# ── regex extraction of JOB_NO + VESSEL from cover lines ─────
_JOB_NO_RE = re.compile(r"JOB\s*NO\s*[:#]\s*([A-Z0-9\-]+)", re.IGNORECASE)
_VESSEL_RE = re.compile(r"(?:VESSEL\s*NAME|INSTALLATION)\s*[:#]\s*(.+?)\s*$", re.IGNORECASE)
_TASK_RE = re.compile(r"(?:TASK|JOB\s*SCOPE)\s*[:#]\s*(.+?)\s*$", re.IGNORECASE)
_LOCATION_RE = re.compile(r"LOCATION\s*[:#]\s*(.+?)\s*$", re.IGNORECASE)
_DATE_RE = re.compile(r"DATE\s*[:#]\s*(.+?)\s*$", re.IGNORECASE)


def extract_job_no(lines: list[str]) -> str:
    for ln in lines:
        m = _JOB_NO_RE.search(ln)
        if m:
            return m.group(1).strip()
    # Fallback: first line that looks like a DD/JOB number
    for ln in lines:
        stripped = ln.strip()
        if re.match(r"^[A-Z]{2}\d{6,}$", stripped):
            return stripped
    return ""


def extract_vessel(lines: list[str]) -> str:
    for ln in lines:
        m = _VESSEL_RE.search(ln)
        if m:
            return m.group(1).strip()
    return ""


_DEFAULT_COMPANY = "DIVE RESOURCES SDN BHD"


def extract_company(lines: list[str]) -> str:
    """Return the company name line from cover_lines.

    A company name line has no 'KEY:' label prefix.
    Returns the first such standalone uppercase line found, or the
    default company name if none is present.
    """
    for ln in lines:
        stripped = ln.strip()
        if not stripped:
            continue
        # Labeled fields contain a colon — skip them
        if re.match(r"^[A-Z\s]+:", stripped):
            continue
        # Must look like an all-caps company name (letters, spaces, digits)
        if re.match(r"^[A-Z][A-Z0-9\s]+$", stripped):
            return stripped
    return _DEFAULT_COMPANY


def _extract_field(lines: list[str], pattern: re.Pattern) -> str:
    for ln in lines:
        m = pattern.search(ln)
        if m:
            return m.group(1).strip()
    return ""


def _format_date_short(date_str: str) -> str:
    """Convert '27 FEBRUARY 2026' → '27.02.2026'."""
    months = {
        "january": "01", "february": "02", "march": "03", "april": "04",
        "may": "05", "june": "06", "july": "07", "august": "08",
        "september": "09", "october": "10", "november": "11", "december": "12",
    }
    parts = date_str.strip().split()
    if len(parts) >= 3:
        day = parts[0].rstrip("STNDRH").rstrip("stndrh")
        month_name = parts[1].lower()
        year = parts[2]
        mm = months.get(month_name, "00")
        if mm != "00":
            return f"{int(day):02d}.{mm}.{year}"
    return date_str


def _strip_vessel_prefix(vessel: str) -> str:
    """Remove common vessel prefixes like MV, MT, M/V etc."""
    return re.sub(r"^(?:MV|MT|M/V|M/T|SS|HMS)\s+", "", vessel, flags=re.IGNORECASE).strip()


def _wrap_lines(text: str, max_chars: int = 30) -> list[str]:
    """Wrap a long line at word boundaries."""
    words = text.split()
    lines: list[str] = []
    current = ""
    for w in words:
        candidate = f"{current} {w}".strip() if current else w
        if len(candidate) <= max_chars:
            current = candidate
        else:
            if current:
                lines.append(current)
            current = w
    if current:
        lines.append(current)
    return lines if lines else [text]


def derive_small_lines(cover_lines: list[str], max_chars: int = 38) -> list[str]:
    """Auto-generate the overlay text from cover_lines.

    Format (matches employee reference):
      1. DIVE RESOURCES SDN BHD        (company — read from cover_lines)
      2. UNDERWATER HULL CLEANING      (task, auto-wrapped if long)
         & PROPELLER POLISHING
      3. FOR GUO YUAN 20               (vessel, no MV/MT prefix)
      4. KUKUP ANCHORAGE               (location)
      5. 27.02.2026                     (date, DD.MM.YYYY)

    The company name is read dynamically from cover_lines so that
    branch companies (e.g. DIVE RESOURCES BORNEO SDN BHD) are shown
    correctly without any code change.

    Long lines are wrapped at word boundaries to fit the overlay width.
    """
    company = extract_company(cover_lines)
    vessel = extract_vessel(cover_lines)
    task = _extract_field(cover_lines, _TASK_RE)
    date = _extract_field(cover_lines, _DATE_RE)
    location = _extract_field(cover_lines, _LOCATION_RE)

    vessel_short = _strip_vessel_prefix(vessel) if vessel else "N/A"
    date_short = _format_date_short(date) if date else "N/A"

    result: list[str] = [company]
    result.extend(_wrap_lines(task or "N/A", max_chars))
    result.extend(_wrap_lines(f"FOR {vessel_short}" if vessel_short != "N/A" else "N/A", max_chars))
    result.extend(_wrap_lines(location or "N/A", max_chars))
    result.append(date_short)
    return result


# ── multi-line editing via Notepad (primary) ──────────────────

_COVER_TEMPLATE: list[str] = [
    "JOB NO: ",
    "DIVE RESOURCES SDN BHD",
    "VESSEL NAME: ",
    "JOB SCOPE: ",
    "INSPECTOR DIVER: ",
    "LOCATION: ",
    "DATE: ",
]

_SMALL_TEMPLATE: list[str] = [
    "DIVE RESOURCES SDN BHD",
    "",
    "FOR ",
    "",
    "",
]


def _edit_in_notepad(
    *,
    title: str,
    instructions: list[str],
    template_lines: list[str],
) -> list[str] | None:
    """Open Notepad pre-filled with instructions + template, block until
    the user saves and closes, then return the non-comment non-empty lines.

    Returns None if Notepad isn't available (non-Windows or launch error).
    """
    if sys.platform != "win32":
        return None

    header: list[str] = [
        f"# === {title} ===",
        "# One item per line. Lines starting with # and blank lines are ignored.",
        "# Press Ctrl+S, then close Notepad to continue.",
        *[f"# {ln}" for ln in instructions],
        "#",
    ]
    body = template_lines if template_lines else [""]
    content = "\r\n".join([*header, *body]) + "\r\n"

    # Use a plain path (not NamedTemporaryFile) so we fully control the file.
    # Write with UTF-8 BOM so Notepad always opens and saves it as UTF-8
    # even on older Windows / Chinese locale where it would otherwise
    # guess GBK / ANSI.
    fd, tmp_path = tempfile.mkstemp(suffix=".txt", prefix="dive_edit_")
    os.close(fd)
    try:
        Path(tmp_path).write_text(content, encoding="utf-8-sig")
        try:
            subprocess.run(["notepad.exe", tmp_path], check=False)
        except FileNotFoundError:
            return None

        raw_bytes = Path(tmp_path).read_bytes()
        # Try the encodings Notepad might save in, in order of likelihood.
        decoded: str | None = None
        for enc in ("utf-8-sig", "utf-16", "utf-16-le", "gbk", "mbcs"):
            try:
                decoded = raw_bytes.decode(enc)
                break
            except (UnicodeDecodeError, LookupError):
                continue
        if decoded is None:
            decoded = raw_bytes.decode("utf-8", errors="replace")
        raw_lines = decoded.splitlines()
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass

    return [ln.rstrip() for ln in raw_lines if ln.strip() and not ln.lstrip().startswith("#")]


# ── console-mode fallback (robust empty check + `.` terminator) ──

def _prompt_multiline_console(label: str) -> list[str]:
    print(f"\n{label}")
    print("(one per line, blank line or a single . to finish)")
    lines: list[str] = []
    while True:
        try:
            ln = input("> ")
        except EOFError:
            break
        stripped = ln.strip()
        if stripped == "" or stripped == ".":
            break
        lines.append(ln.rstrip())
    return lines


def _prompt_multiline(
    *,
    title: str,
    instructions: list[str],
    template_lines: list[str],
    console_label: str,
) -> list[str]:
    """Notepad first, console fallback."""
    result = _edit_in_notepad(
        title=title, instructions=instructions, template_lines=template_lines
    )
    if result is not None:
        return result
    return _prompt_multiline_console(console_label)


def _prompt_int(label: str, default: int) -> int:
    while True:
        raw = input(f"{label} [{default}]: ").strip()
        if raw == "":
            return default
        try:
            return int(raw)
        except ValueError:
            print("  Please enter an integer.")


def prompt_three(existing: JobMeta | None = None) -> JobMeta:
    """Run the three required prompts.

    If `existing` is given, its values pre-fill the Notepad template so the
    user edits instead of retypes. Falls back to console input if Notepad
    is unavailable.
    """
    print()
    print("[1/3] cover large text (screenshot 1 style)")
    print("      -> Notepad will open; edit then Ctrl+S to save and close")
    cover_template = list(existing.cover_lines) if existing and existing.cover_lines else _COVER_TEMPLATE
    cover_lines = _prompt_multiline(
        title="cover title text",
        instructions=[
            "This is the large title shown over the intro segment.",
            "Include at least JOB NO and VESSEL NAME so the app can parse them.",
        ],
        template_lines=cover_template,
        console_label="> Enter cover text",
    )

    # Auto-derive small_lines from cover_lines
    auto_small = derive_small_lines(cover_lines)
    print()
    print("[2/3] top-left small text (auto-generated; Enter to confirm or edit manually)")
    for i, ln in enumerate(auto_small, 1):
        print(f"  {i}. {ln}")
    edit_small = input("> Press Enter to confirm / type 'e' to edit: ").strip().lower()
    if edit_small == "e":
        small_template = list(existing.small_lines) if existing and existing.small_lines else auto_small
        small_lines = _prompt_multiline(
            title="top-left watermark text",
            instructions=[
                "This watermark stays at the top-left of body segments.",
            ],
            template_lines=small_template,
            console_label="> Enter watermark text",
        )
    else:
        small_lines = auto_small

    print()
    print("[3/3] Target output duration (minutes)")
    print("  Enter 0 = speech-only mode: keep every speech segment, no padding")
    default_dur = existing.target_duration_min if existing else 60
    target = _prompt_int("> Target duration", default_dur)

    job_no = extract_job_no(cover_lines)
    vessel = extract_vessel(cover_lines)

    if not job_no:
        print("Warning: Could not extract JOB NO from cover text (expected format 'JOB NO: XXXXX')")
        job_no = input("  Enter JOB NO manually: ").strip()
    if not vessel:
        print("Warning: Could not extract VESSEL NAME from cover text (expected format 'VESSEL NAME: XXX')")
        vessel = input("  Enter VESSEL NAME manually: ").strip()

    return JobMeta(
        job_no=job_no,
        vessel=vessel,
        intro_file=existing.intro_file if existing else "",
        cover_lines=cover_lines,
        small_lines=small_lines,
        target_duration_min=target,
    )


def confirm_save() -> bool:
    raw = input("\nSave settings to job.yaml for next time? [Y/n]: ").strip().lower()
    return raw in ("", "y", "yes")
