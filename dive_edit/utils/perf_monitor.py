"""Lightweight runtime performance sampling for pipeline runs."""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import threading
import time
from pathlib import Path
from typing import Any

from .process_flags import hidden_subprocess_kwargs


class PipelinePerfMonitor:
    """Sample the current process tree while a pipeline run is active."""

    def __init__(self, output_path: Path, *, interval_sec: float = 1.0) -> None:
        self.output_path = output_path
        self.interval_sec = max(0.5, float(interval_sec))
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._t0 = 0.0
        self._samples = 0
        self._peak_rss_mb = 0.0
        self._min_available_ram_mb: float | None = None
        self._peak_gpu_vram_mb: float | None = None
        self._cpu_sum = 0.0
        self._system_cpu_sum = 0.0
        self._last_proc_cpu_sec: dict[int, float] = {}
        self._last_cpu_sample_ts: float | None = None

    def start(self) -> None:
        if self._thread is not None:
            return
        self.output_path.parent.mkdir(parents=True, exist_ok=True)
        self.output_path.write_text("", encoding="utf-8")
        self._t0 = time.time()
        self._thread = threading.Thread(target=self._run, name="perf-monitor", daemon=True)
        self._thread.start()

    def stop(self) -> dict[str, Any]:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=3.0)
        return self.summary()

    def summary(self) -> dict[str, Any]:
        avg_cpu = self._cpu_sum / self._samples if self._samples else 0.0
        avg_system_cpu = self._system_cpu_sum / self._samples if self._samples else 0.0
        return {
            "samples": self._samples,
            "elapsed_sec": round(max(0.0, time.time() - self._t0), 2) if self._t0 else 0.0,
            "peak_rss_mb": round(self._peak_rss_mb, 1),
            "min_available_ram_mb": (
                round(self._min_available_ram_mb, 1)
                if self._min_available_ram_mb is not None
                else None
            ),
            "avg_process_cpu_percent": round(avg_cpu, 1),
            "avg_system_cpu_percent": round(avg_system_cpu, 1),
            "peak_gpu_vram_mb": (
                round(self._peak_gpu_vram_mb, 1)
                if self._peak_gpu_vram_mb is not None
                else None
            ),
        }

    def _run(self) -> None:
        try:
            import psutil  # type: ignore
        except Exception:
            self._write({"error": "psutil unavailable", "elapsed_sec": 0.0})
            return

        root = psutil.Process(os.getpid())
        while not self._stop.is_set():
            try:
                sample = self._sample(root, psutil)
                self._record(sample)
                self._write(sample)
            except Exception as exc:  # noqa: BLE001
                self._write({
                    "ts": time.time(),
                    "elapsed_sec": round(time.time() - self._t0, 2),
                    "error": f"{type(exc).__name__}: {exc}",
                })
            self._stop.wait(self.interval_sec)

    def _sample(self, root: Any, psutil: Any) -> dict[str, Any]:
        procs = [root]
        try:
            procs.extend(root.children(recursive=True))
        except Exception:
            pass

        live = []
        total_rss_mb = 0.0
        children_rss_mb = 0.0
        cpu_seconds = 0.0
        pids: set[int] = set()
        for proc in procs:
            try:
                rss_mb = proc.memory_info().rss / (1024.0 * 1024.0)
                times = proc.cpu_times()
                proc_cpu_sec = float(times.user + times.system)
                pid = int(proc.pid)
                pids.add(pid)
                live.append({"pid": pid, "name": proc.name(), "rss_mb": round(rss_mb, 1)})
                total_rss_mb += rss_mb
                if pid != root.pid:
                    children_rss_mb += rss_mb
                prev = self._last_proc_cpu_sec.get(pid)
                if prev is not None:
                    cpu_seconds += max(0.0, proc_cpu_sec - prev)
                self._last_proc_cpu_sec[pid] = proc_cpu_sec
            except Exception:
                continue

        vm = psutil.virtual_memory()
        gpu_vram_mb = _gpu_vram_for_pids(pids)
        now = time.time()
        elapsed = max(0.001, now - self._last_cpu_sample_ts) if self._last_cpu_sample_ts else 0.0
        cpu_count = max(1, psutil.cpu_count(logical=True) or 1)
        cpu_percent = (cpu_seconds / elapsed / cpu_count * 100.0) if elapsed > 0 else 0.0
        self._last_cpu_sample_ts = now
        return {
            "ts": now,
            "elapsed_sec": round(now - self._t0, 2),
            "process_count": len(live),
            "root_pid": int(root.pid),
            "total_rss_mb": round(total_rss_mb, 1),
            "children_rss_mb": round(children_rss_mb, 1),
            "available_ram_mb": round(vm.available / (1024.0 * 1024.0), 1),
            "process_cpu_percent": round(cpu_percent, 1),
            "system_cpu_percent": round(float(psutil.cpu_percent(interval=None)), 1),
            "gpu_vram_mb": gpu_vram_mb,
            "processes": live,
        }

    def _record(self, sample: dict[str, Any]) -> None:
        self._samples += 1
        self._peak_rss_mb = max(self._peak_rss_mb, float(sample.get("total_rss_mb") or 0.0))
        avail = sample.get("available_ram_mb")
        if isinstance(avail, (int, float)):
            self._min_available_ram_mb = (
                float(avail)
                if self._min_available_ram_mb is None
                else min(self._min_available_ram_mb, float(avail))
            )
        gpu = sample.get("gpu_vram_mb")
        if isinstance(gpu, (int, float)):
            self._peak_gpu_vram_mb = (
                float(gpu)
                if self._peak_gpu_vram_mb is None
                else max(self._peak_gpu_vram_mb, float(gpu))
            )
        self._cpu_sum += float(sample.get("process_cpu_percent") or 0.0)
        self._system_cpu_sum += float(sample.get("system_cpu_percent") or 0.0)

    def _write(self, sample: dict[str, Any]) -> None:
        with self.output_path.open("a", encoding="utf-8") as fp:
            fp.write(json.dumps(sample, ensure_ascii=False) + "\n")


def _gpu_vram_for_pids(pids: set[int]) -> float | None:
    if not pids or not shutil.which("nvidia-smi"):
        return None
    try:
        out = subprocess.run(
            [
                "nvidia-smi",
                "--query-compute-apps=pid,used_memory",
                "--format=csv,noheader,nounits",
            ],
            capture_output=True,
            text=True,
            check=True,
            timeout=2,
            **hidden_subprocess_kwargs(),
        )
    except (OSError, subprocess.SubprocessError):
        return None

    total = 0.0
    found = False
    for raw in out.stdout.splitlines():
        parts = [part.strip() for part in raw.split(",")]
        if len(parts) < 2:
            continue
        try:
            pid = int(parts[0])
            used_mb = float(parts[1])
        except ValueError:
            continue
        if pid in pids:
            total += used_mb
            found = True
    return round(total, 1) if found else None
