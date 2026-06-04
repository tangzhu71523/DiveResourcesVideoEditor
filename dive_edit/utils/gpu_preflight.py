"""GPU/VRAM preflight for Whisper runtime selection."""
from __future__ import annotations

import ctypes
import os
import shutil
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping

from .process_flags import hidden_subprocess_kwargs

WHISPER_MIN_VRAM_MB = 4096
WHISPER_BATCHED_VRAM_MB = 6144


@dataclass(frozen=True)
class WhisperGpuPlan:
    gpu_name: str | None
    driver_version: str | None
    vram_total_mb: int | None
    vram_free_mb: int | None
    vram_used_mb: int | None
    whisper_device_plan: str
    whisper_inference_mode: str
    whisper_batch_size: int
    workers: int
    gpu_reason: str

    def env(self) -> dict[str, str]:
        out = {
            "DIVE_WHISPER_INFERENCE_MODE": self.whisper_inference_mode,
            "DIVE_WHISPER_BATCH_SIZE": str(self.whisper_batch_size),
            "DIVE_GPU_PREFLIGHT_REASON": self.gpu_reason,
            "DIVE_GPU_PREFLIGHT_FREE_MB": str(self.vram_free_mb or 0),
            "DIVE_GPU_PREFLIGHT_TOTAL_MB": str(self.vram_total_mb or 0),
        }
        if self.whisper_device_plan == "cpu":
            out["DIVE_FORCE_CPU"] = "1"
        return out

    def log_line(self) -> str:
        total = self.vram_total_mb if self.vram_total_mb is not None else "unknown"
        free = self.vram_free_mb if self.vram_free_mb is not None else "unknown"
        return (
            f"[gpu-preflight] total={total} free_min={free} "
            f"plan={self.whisper_device_plan} reason={self.gpu_reason} "
            f"workers={self.workers} inference={self.whisper_inference_mode} "
            f"batch={self.whisper_batch_size}"
        )

    def as_health(self) -> dict[str, object]:
        return {
            "gpu_name": self.gpu_name,
            "gpu_driver_version": self.driver_version,
            "vram_total_mb": self.vram_total_mb,
            "vram_free_mb": self.vram_free_mb,
            "vram_used_mb": self.vram_used_mb,
            "whisper_device_plan": self.whisper_device_plan,
            "whisper_inference_mode": self.whisper_inference_mode,
            "whisper_batch_size": self.whisper_batch_size,
            "gpu_reason": self.gpu_reason,
        }


def _int_env(env: Mapping[str, str | None], name: str, default: int) -> int:
    try:
        return int(env.get(name) or "")
    except (TypeError, ValueError):
        return default


def _register_dll_dir(path: Path, registered: list[str]) -> None:
    if not path.is_dir():
        return
    if hasattr(os, "add_dll_directory"):
        try:
            os.add_dll_directory(str(path))
        except OSError:
            pass
    os.environ["PATH"] = str(path) + os.pathsep + os.environ.get("PATH", "")
    registered.append(str(path))


def _register_cuda_paths(env: Mapping[str, str | None]) -> list[str]:
    """Register the same CUDA locations used by dev and packaged builds."""
    registered: list[str] = []

    roots: list[Path] = []
    meipass = getattr(sys, "_MEIPASS", None)
    if meipass:
        roots.append(Path(meipass))
    if getattr(sys, "frozen", False):
        roots.append(Path(sys.executable).resolve().parent / "_internal")

    for root in roots:
        nvidia_root = root / "nvidia"
        for sub in ("cublas", "cuda_nvrtc", "cuda_runtime", "nvjitlink", "cudnn"):
            _register_dll_dir(nvidia_root / sub / "bin", registered)
        _register_dll_dir(root / "ctranslate2", registered)

    exe_dir = Path(sys.executable).resolve().parent
    _register_dll_dir(exe_dir / "cuda", registered)

    local_appdata = env.get("LOCALAPPDATA") or os.environ.get("LOCALAPPDATA")
    if local_appdata:
        _register_dll_dir(Path(local_appdata) / "DiveEdit" / "cuda", registered)

    try:
        import nvidia  # type: ignore
        nvidia_root = Path(nvidia.__file__).resolve().parent
        for sub in ("cublas", "cuda_nvrtc", "cuda_runtime", "nvjitlink", "cudnn"):
            _register_dll_dir(nvidia_root / sub / "bin", registered)
    except Exception:
        pass

    return registered


def _has_cuda_dlls(env: Mapping[str, str | None]) -> tuple[bool, str]:
    if env.get("DIVE_FORCE_CPU") == "1":
        return False, "forced CPU"
    if env.get("DIVE_CUDA_STATUS") == "none":
        return False, "CUDA DLL missing"
    cudnn_status = env.get("DIVE_CUDNN_STATUS")
    if cudnn_status and cudnn_status.startswith("missing"):
        return False, "cuDNN missing"
    registered = _register_cuda_paths(env)
    if os.name == "nt":
        try:
            ctypes.WinDLL("cudart64_12.dll")
        except OSError:
            if env.get("DIVE_CUDA_STATUS") in (None, "", "unset"):
                return False, "CUDA DLL missing"
    suffix = f" ({len(registered)} CUDA path(s) registered)" if registered else ""
    return True, "CUDA DLL ok" + suffix


def _ct2_probe_ok() -> tuple[bool, str]:
    cached = (os.environ.get("DIVE_CUDA_PROBE") or "").strip()
    if cached.startswith("ct2_cuda_devices="):
        return True, cached
    try:
        import ctranslate2  # type: ignore
        count = int(ctranslate2.get_cuda_device_count())
    except Exception as e:  # noqa: BLE001
        return False, f"ct2 CUDA probe fail: {type(e).__name__}: {e}"
    if count <= 0:
        return False, "ct2 CUDA probe fail: no CUDA devices"
    return True, f"ct2 CUDA devices={count}"


def _cpu_plan(reason: str) -> WhisperGpuPlan:
    return WhisperGpuPlan(
        gpu_name=None,
        driver_version=None,
        vram_total_mb=None,
        vram_free_mb=None,
        vram_used_mb=None,
        whisper_device_plan="cpu",
        whisper_inference_mode="standard",
        whisper_batch_size=1,
        workers=1,
        gpu_reason=reason,
    )


def run_whisper_preflight(
    *,
    samples: int = 5,
    interval_sec: float = 1.0,
    env: Mapping[str, str | None] | None = None,
) -> WhisperGpuPlan:
    status_env = env if env is not None else os.environ
    allow_parallel = status_env.get("DIVE_GPU_ALLOW_PARALLEL") == "1"
    batch_override = _int_env(status_env, "DIVE_WHISPER_BATCH_SIZE", 0)

    cuda_ok, cuda_reason = _has_cuda_dlls(status_env)
    if not cuda_ok:
        return _cpu_plan(cuda_reason)
    if not shutil.which("nvidia-smi"):
        return _cpu_plan("nvidia-smi not found")

    rows: list[tuple[str, int, int, int, str]] = []
    query = "name,memory.total,memory.free,memory.used,driver_version"
    for idx in range(max(1, int(samples))):
        try:
            proc = subprocess.run(
                ["nvidia-smi", f"--query-gpu={query}", "--format=csv,noheader,nounits"],
                capture_output=True,
                text=True,
                check=True,
                timeout=5,
                **hidden_subprocess_kwargs(),
            )
            line = (proc.stdout or "").strip().splitlines()[0]
            parts = [p.strip() for p in line.split(",")]
            rows.append((parts[0], int(parts[1]), int(parts[2]), int(parts[3]), parts[4]))
        except (subprocess.SubprocessError, OSError, ValueError, IndexError) as e:
            return _cpu_plan(f"nvidia-smi failed: {e}")
        if idx < max(1, int(samples)) - 1 and interval_sec > 0:
            time.sleep(interval_sec)

    gpu_name = rows[-1][0]
    total_mb = rows[-1][1]
    free_min_mb = min(r[2] for r in rows)
    used_at_min = next(r[3] for r in rows if r[2] == free_min_mb)
    driver = rows[-1][4]

    ct2_ok, ct2_reason = _ct2_probe_ok()
    if not ct2_ok:
        return WhisperGpuPlan(
            gpu_name=gpu_name,
            driver_version=driver,
            vram_total_mb=total_mb,
            vram_free_mb=free_min_mb,
            vram_used_mb=used_at_min,
            whisper_device_plan="cpu",
            whisper_inference_mode="standard",
            whisper_batch_size=1,
            workers=1,
            gpu_reason=ct2_reason,
        )

    if free_min_mb < WHISPER_MIN_VRAM_MB:
        return WhisperGpuPlan(
            gpu_name=gpu_name,
            driver_version=driver,
            vram_total_mb=total_mb,
            vram_free_mb=free_min_mb,
            vram_used_mb=used_at_min,
            whisper_device_plan="cpu",
            whisper_inference_mode="standard",
            whisper_batch_size=1,
            workers=1,
            gpu_reason="free VRAM below Whisper minimum",
        )

    if free_min_mb < WHISPER_BATCHED_VRAM_MB:
        batch_size = batch_override if batch_override > 0 else 4
        inference = "standard"
        reason = "GPU standard mode"
    else:
        batch_size = batch_override if batch_override > 0 else 8
        inference = "auto"
        reason = "GPU batched/auto mode"

    workers = 1 if not allow_parallel else max(1, _int_env(status_env, "DIVE_GPU_WORKERS_CAP", 1))
    return WhisperGpuPlan(
        gpu_name=gpu_name,
        driver_version=driver,
        vram_total_mb=total_mb,
        vram_free_mb=free_min_mb,
        vram_used_mb=used_at_min,
        whisper_device_plan="gpu",
        whisper_inference_mode=inference,
        whisper_batch_size=max(1, batch_size),
        workers=workers,
        gpu_reason=reason if workers == 1 else f"{reason}; parallel override enabled",
    )
