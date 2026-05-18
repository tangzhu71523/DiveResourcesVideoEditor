"""GPU 自适应：检测显存，计算最佳 Whisper worker 数。

VRAM-per-worker recalibration (2026-05-04):
  Whisper large-v3-turbo with compute_type=int8_float16:
    weights (int8 quantized)  ~0.7 GB
    activations + KV cache    ~0.3 GB
    safety margin             ~0.2 GB
    total per worker          ~1.2 GB  (was 1.6 GB — too conservative)

  WORKERS_CAP raised 5 → 8: user-tested 5+ workers on this hardware
  without OOM; 8 is the new diminishing-returns ceiling (CPU/IO bound
  beyond that). Adjust further only after re-testing on target hardware.
"""
from __future__ import annotations

import shutil
import subprocess
from collections.abc import Callable, Mapping

_VRAM_PER_WORKER_GB = 1.2
WORKERS_CAP = 8
_WORKERS_CAP = WORKERS_CAP  # backward-compat alias


def _workers_from_free_vram_mb(
    free_mb: int,
    *,
    cap: int = WORKERS_CAP,
    vram_per_worker_gb: float = _VRAM_PER_WORKER_GB,
) -> int:
    free_gb = max(0.0, float(free_mb) / 1024.0)
    return max(1, min(int(cap), int(free_gb / vram_per_worker_gb)))


def detect_optimal_workers() -> tuple[int, str]:
    """探测 GPU free VRAM，返回 (worker 数, 人类可读说明).

    无 NVIDIA GPU / nvidia-smi 不可用 → (1, '...').
    有 GPU → workers = min(WORKERS_CAP, max(1, free_GB / _VRAM_PER_WORKER_GB)).
    """
    if not shutil.which("nvidia-smi"):
        return 1, "nvidia-smi not found -> CPU single worker"
    try:
        out = subprocess.run(
            ["nvidia-smi", "--query-gpu=memory.free", "--format=csv,noheader,nounits"],
            capture_output=True, text=True, check=True, timeout=5,
        )
        # 取第一张 GPU 的 free MB
        free_mb = int(out.stdout.strip().splitlines()[0])
        free_gb = free_mb / 1024.0
        workers = _workers_from_free_vram_mb(free_mb, cap=_WORKERS_CAP)
        return workers, f"GPU free VRAM={free_gb:.1f}GB -> workers={workers}"
    except (subprocess.SubprocessError, ValueError, IndexError, OSError) as e:
        return 1, f"nvidia-smi failed ({e}) -> CPU single worker"


def select_pipeline_workers(
    *,
    env: Mapping[str, str | None] | None = None,
    detector: Callable[[], tuple[int, str]] = detect_optimal_workers,
) -> tuple[int, str]:
    """Return the worker count the backend should pass to the pipeline.

    Packaged exe startup writes DIVE_* status variables after probing CUDA DLLs.
    Dev mode may leave them unset, so an unset CUDA status must not force CPU;
    the live VRAM detector remains the source of truth in that case.
    """
    status = env if env is not None else {}
    force_cpu = status.get("DIVE_FORCE_CPU") == "1"
    cuda_status = status.get("DIVE_CUDA_STATUS")
    cudnn_status = status.get("DIVE_CUDNN_STATUS", "ok") or "ok"
    if force_cpu:
        return 1, "force CPU requested"
    if cuda_status == "none":
        return 1, "CUDA unavailable"
    if cudnn_status.startswith("missing"):
        return 1, f"cuDNN unavailable: {cudnn_status}"
    auto_workers, msg = detector()
    return max(1, int(auto_workers or 1)), msg
