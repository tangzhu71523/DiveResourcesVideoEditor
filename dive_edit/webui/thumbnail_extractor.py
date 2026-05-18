"""时间线缩略图后台抽取器。

工作模型:
  - 单线程后台 worker(daemon),低优先级。
  - 用户触发 API 入队,worker 串行处理(避免 CPU 用户与 whisper / render 抢核)。
  - 输出落 <job>/_diveedit/thumbs/<file_stem>/00001.jpg ... + manifest.json。
  - 已有 manifest 视为完成,直接跳过(幂等)。
  - 前端轮询 status 接口,逐张拉 thumbnail 接口,UI 不阻塞。
"""
from __future__ import annotations
import json
import subprocess
import sys
import threading
from pathlib import Path
from queue import Queue, Empty


_queue: "Queue[tuple[Path, Path]]" = Queue()
_worker_started = False
_state_lock = threading.Lock()


def thumbnails_dir(job_folder: Path, file_path: Path) -> Path:
    return job_folder / "_diveedit" / "thumbs" / file_path.stem


def manifest_path(td: Path) -> Path:
    return td / "manifest.json"


def thumbnail_path(td: Path, idx: int) -> Path:
    # ffmpeg image2 序列从 1 开始计数;前端传 0-based idx,内部 +1。
    return td / f"{idx + 1:05d}.jpg"


def _ffmpeg_creation_flags() -> int:
    """Windows 下用 IDLE_PRIORITY_CLASS,让抽帧不抢 whisper / render 的 CPU。"""
    if sys.platform == "win32":
        return getattr(subprocess, "IDLE_PRIORITY_CLASS", 0) | getattr(
            subprocess, "CREATE_NO_WINDOW", 0
        )
    return 0


_TARGET_FRAMES_PER_FILE = 150
"""每文件目标缩略图张数。理论上限取自 zoom_max=12 + 16:9 单格宽 + 中
等长度文件下视觉所需帧数,150 足以覆盖到最大 zoom 也不糊;前端按当前
zoom 计算实际渲染数,从这 150 张中均匀挑选。"""


def _probe_duration_sec(file_path: Path) -> float:
    try:
        result = subprocess.run(
            [
                "ffprobe", "-v", "error",
                "-show_entries", "format=duration",
                "-of", "default=noprint_wrappers=1:nokey=1",
                str(file_path),
            ],
            capture_output=True, text=True, check=False, timeout=20,
            creationflags=_ffmpeg_creation_flags(),
        )
        v = float(result.stdout.strip())
        return v if v > 0 else 0.0
    except (OSError, ValueError, subprocess.SubprocessError):
        return 0.0


def _extract_one(file_path: Path, job_folder: Path) -> None:
    td = thumbnails_dir(job_folder, file_path)
    mp = manifest_path(td)
    if mp.exists():
        return
    td.mkdir(parents=True, exist_ok=True)
    duration = _probe_duration_sec(file_path)
    if duration <= 0:
        return
    # 抽帧密度自适应:目标 _TARGET_FRAMES_PER_FILE 张,fps 取
    # target/duration。短文件(< target 秒)上限 1 fps 防止过密。
    target_fps = min(1.0, _TARGET_FRAMES_PER_FILE / duration)
    if target_fps <= 0:
        return
    cmd = [
        "ffmpeg", "-y", "-loglevel", "error",
        "-i", str(file_path),
        "-vf", f"fps={target_fps:.6f},scale=w='min(160,iw)':h=-2",
        "-q:v", "5",
        str(td / "%05d.jpg"),
    ]
    try:
        subprocess.run(
            cmd, capture_output=True, check=False,
            creationflags=_ffmpeg_creation_flags(),
        )
    except (OSError, subprocess.SubprocessError):
        return
    count = len(sorted(td.glob("*.jpg")))
    if count == 0:
        return
    mp.write_text(json.dumps({"count": count, "duration_sec": duration, "fps": target_fps}))


def _worker_loop() -> None:
    while True:
        try:
            file_path, job_folder = _queue.get(timeout=600)
        except Empty:
            continue
        try:
            _extract_one(file_path, job_folder)
        finally:
            _queue.task_done()


def _ensure_worker() -> None:
    global _worker_started
    with _state_lock:
        if _worker_started:
            return
        _worker_started = True
        threading.Thread(target=_worker_loop, daemon=True, name="thumb-extractor").start()


def enqueue(files: list[Path], job_folder: Path) -> int:
    """把视频文件加入抽帧队列。返回真正入队数(已存在 manifest 的会跳过)。"""
    _ensure_worker()
    queued = 0
    for f in files:
        td = thumbnails_dir(job_folder, f)
        if manifest_path(td).exists():
            continue
        if not f.exists():
            continue
        _queue.put((f, job_folder))
        queued += 1
    return queued


def status(file_path: Path, job_folder: Path) -> dict:
    """前端 polling 用。ready=True 表示抽帧结束,count 是可用帧数。"""
    td = thumbnails_dir(job_folder, file_path)
    mp = manifest_path(td)
    if mp.exists():
        try:
            data = json.loads(mp.read_text())
            return {"count": int(data.get("count", 0)), "ready": True}
        except (OSError, ValueError):
            return {"count": 0, "ready": False}
    if td.exists():
        return {"count": len(list(td.glob("*.jpg"))), "ready": False}
    return {"count": 0, "ready": False}
