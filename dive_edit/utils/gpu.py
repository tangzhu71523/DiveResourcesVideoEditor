"""GPU worker selection for the analysis pipeline."""
from __future__ import annotations

import shutil
import subprocess
import os
from collections.abc import Callable, Mapping

from .process_flags import hidden_subprocess_kwargs
from .gpu_preflight import run_whisper_preflight

_VRAM_PER_WORKER_GB = 1.2
WORKERS_CAP = 8
_WORKERS_CAP = WORKERS_CAP  # backward-compat alias
CPU_WORKERS_CAP = 4
_CPU_RAM_RESERVE_GB = 1.5
_CPU_RAM_PER_WORKER_GB = 1.5
_GPU_RAM_RESERVE_GB = 4.0
_GPU_RAM_PER_WORKER_GB = 3.0


def _workers_from_free_vram_mb(
    free_mb: int,
    *,
    cap: int = WORKERS_CAP,
    vram_per_worker_gb: float = _VRAM_PER_WORKER_GB,
) -> int:
    free_gb = max(0.0, float(free_mb) / 1024.0)
    return max(1, min(int(cap), int(free_gb / vram_per_worker_gb)))


def detect_optimal_workers() -> tuple[int, str]:
    """Detect free GPU VRAM and return a worker estimate."""
    plan = run_whisper_preflight(samples=1, interval_sec=0)
    if plan.whisper_device_plan == "cpu":
        return 1, f"{plan.gpu_reason} -> CPU single worker"
    if os.environ.get("DIVE_GPU_ALLOW_PARALLEL") != "1":
        return 1, (
            f"GPU free VRAM={(plan.vram_free_mb or 0) / 1024.0:.1f}GB "
            "-> workers=1"
        )
    if not shutil.which("nvidia-smi"):
        return 1, "nvidia-smi not found -> CPU single worker"
    try:
        out = subprocess.run(
            ["nvidia-smi", "--query-gpu=memory.free", "--format=csv,noheader,nounits"],
            capture_output=True,
            text=True,
            check=True,
            timeout=5,
            **hidden_subprocess_kwargs(),
        )
        # Use the first GPU because the app does not expose device picking yet.
        free_mb = int(out.stdout.strip().splitlines()[0])
        free_gb = free_mb / 1024.0
        workers = _workers_from_free_vram_mb(free_mb, cap=_WORKERS_CAP)
        return workers, f"GPU free VRAM={free_gb:.1f}GB -> workers={workers}"
    except (subprocess.SubprocessError, ValueError, IndexError, OSError) as e:
        return 1, f"nvidia-smi failed ({e}) -> CPU single worker"


def _available_ram_gb() -> float | None:
    try:
        import psutil  # type: ignore
        return float(psutil.virtual_memory().available) / (1024.0 ** 3)
    except Exception:
        return None


def _total_ram_gb() -> float | None:
    try:
        import psutil  # type: ignore
        return float(psutil.virtual_memory().total) / (1024.0 ** 3)
    except Exception:
        return None


def _float_env(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, ""))
    except (TypeError, ValueError):
        return default


def _int_env(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, ""))
    except (TypeError, ValueError):
        return default


def detect_cpu_workers() -> tuple[int, str]:
    """Pick a conservative CPU Whisper worker count.

    Each worker loads its own model and CTranslate2 threads internally, so
    RAM is the main safety gate. CPU cores are the second gate to leave the
    UI and OS responsive.
    """
    logical = os.cpu_count() or 4
    reserve_gb = max(1.0, _float_env("DIVE_CPU_RAM_RESERVE_GB", _CPU_RAM_RESERVE_GB))
    ram_per_worker_gb = max(1.25, _float_env("DIVE_CPU_RAM_PER_WORKER_GB", _CPU_RAM_PER_WORKER_GB))
    explicit_cpu_cap = "DIVE_CPU_WORKERS_CAP" in os.environ
    cpu_parallel_allowed = os.environ.get("DIVE_CPU_ALLOW_PARALLEL") == "1"
    cap = max(1, min(CPU_WORKERS_CAP, _int_env("DIVE_CPU_WORKERS_CAP", CPU_WORKERS_CAP)))
    total_ram_gb = _total_ram_gb()
    if total_ram_gb is not None:
        if not (explicit_cpu_cap or cpu_parallel_allowed):
            if total_ram_gb <= 18:
                cap = 1
            elif total_ram_gb <= 32:
                cap = min(cap, 2)
        elif total_ram_gb <= 10:
            cap = min(cap, 2)
    by_cpu = max(1, (logical - 2) // 4)
    ram_gb = _available_ram_gb()
    if ram_gb is None:
        by_ram = 1 if logical <= 8 else 2
        workers = max(1, min(cap, by_cpu, by_ram))
        return (
            workers,
            f"CPU workers={workers} (logical={logical}, RAM unknown, cap={cap})",
        )

    by_ram = max(1, int((ram_gb - reserve_gb) // ram_per_worker_gb))
    workers = max(1, min(cap, by_cpu, by_ram))
    return (
        workers,
        f"CPU available RAM={ram_gb:.1f}GB total={total_ram_gb or 0:.1f}GB logical={logical} "
        f"reserve={reserve_gb:.1f}GB per_worker={ram_per_worker_gb:.2f}GB "
        f"cap={cap} -> workers={workers}",
    )


def detect_gpu_ram_workers() -> tuple[int, str]:
    """Limit GPU Whisper workers by host RAM, not only VRAM.

    Each GPU worker is a separate frozen process. Even when the model runs on
    CUDA, the process still needs host RAM for Python, CTranslate2 state,
    decoded audio, temp WAV bookkeeping, and Windows desktop responsiveness.
    """
    cap = max(1, min(WORKERS_CAP, _int_env("DIVE_GPU_WORKERS_CAP", WORKERS_CAP)))
    reserve_gb = max(2.0, _float_env("DIVE_GPU_RAM_RESERVE_GB", _GPU_RAM_RESERVE_GB))
    ram_per_worker_gb = max(2.0, _float_env("DIVE_GPU_RAM_PER_WORKER_GB", _GPU_RAM_PER_WORKER_GB))
    total_ram_gb = _total_ram_gb()
    available_ram_gb = _available_ram_gb()

    total_cap = cap
    if total_ram_gb is not None:
        total_cap = max(1, int((total_ram_gb - reserve_gb) // ram_per_worker_gb))

    available_cap = total_cap
    if available_ram_gb is not None:
        available_cap = max(1, int((available_ram_gb - reserve_gb) // ram_per_worker_gb))

    workers = max(1, min(cap, total_cap, available_cap))
    total_msg = f"{total_ram_gb:.1f}GB" if total_ram_gb is not None else "unknown"
    available_msg = f"{available_ram_gb:.1f}GB" if available_ram_gb is not None else "unknown"
    return (
        workers,
        f"RAM total={total_msg} available={available_msg} "
        f"reserve={reserve_gb:.1f}GB per_worker={ram_per_worker_gb:.1f}GB "
        f"-> workers={workers}",
    )


def select_pipeline_workers(
    *,
    env: Mapping[str, str | None] | None = None,
    detector: Callable[[], tuple[int, str]] = detect_optimal_workers,
) -> tuple[int, str]:
    """Return the worker count the backend should pass to the pipeline.

    Packaged exe startup writes DIVE_* status variables after probing CUDA DLLs.
    Dev mode may leave them unset, so an unset CUDA status must not force CPU.
    The live VRAM detector remains the source of truth in that case.
    """
    status = env if env is not None else {}
    force_cpu = status.get("DIVE_FORCE_CPU") == "1"
    cuda_status = status.get("DIVE_CUDA_STATUS")
    cudnn_status = status.get("DIVE_CUDNN_STATUS", "ok") or "ok"
    if force_cpu:
        workers, msg = detect_cpu_workers()
        return workers, f"force CPU requested | {msg}"
    if cuda_status == "none":
        workers, msg = detect_cpu_workers()
        return workers, f"CUDA unavailable | {msg}"
    if cudnn_status.startswith("missing"):
        workers, msg = detect_cpu_workers()
        return workers, f"cuDNN unavailable: {cudnn_status} | {msg}"
    auto_workers, msg = detector()
    if msg.startswith("nvidia-smi not found") or msg.startswith("nvidia-smi failed"):
        workers, cpu_msg = detect_cpu_workers()
        return workers, f"{msg} | {cpu_msg}"
    if "CPU single worker" in msg:
        workers, cpu_msg = detect_cpu_workers()
        return workers, f"{msg} | {cpu_msg}"
    if status.get("DIVE_GPU_ALLOW_PARALLEL") != "1":
        return 1, f"{msg} | GPU worker capped at 1"
    ram_workers, ram_msg = detect_gpu_ram_workers()
    workers = max(1, min(int(auto_workers or 1), ram_workers))
    return workers, f"{msg} | {ram_msg} | selected workers={workers}"
