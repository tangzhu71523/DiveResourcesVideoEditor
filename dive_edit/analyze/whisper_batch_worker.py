"""Batched isolated Whisper worker.

Loads the Whisper model ONCE and processes multiple audio files in a
single subprocess invocation. Skips the ~5-10 second CUDA + model
initialization cost that older per-file worker invocations paid.

Usage:
    python -m dive_edit.analyze.whisper_batch_worker <manifest.json>
        [model] [device] [compute_gpu] [compute_cpu] [language] [prompt_file]
        [vad] [cpu_threads] [inference_mode] [batch_size] [chunk_sec]

The manifest is a JSON array of `{"input": "...", "output": "...json"}`
entries. Input may be a temporary wav or a source media file that PyAV can
decode directly. For each entry, the worker writes a JSON document to the
output path BEFORE moving on. Results are persisted immediately so a
teardown-time crash (Windows 0xC0000409 in ctranslate2) doesn't lose
completed files.

Output schema (v21):
    {
      "words": [[start, end, text, seg_idx, probability], ...],
      "segments": [
        {"idx": 0, "start": ..., "end": ..., "text": "...",
         "no_speech_prob": ..., "avg_logprob": ..., "compression_ratio": ...},
        ...
      ]
    }

Segment metadata is used downstream to filter out Whisper hallucinations
on silent audio (e.g. repeated "Thank you." on breathing noise).

Optional prompt_file: path to a UTF-8 text file containing the
faster_whisper `initial_prompt` string to bias the decoder.
"""
from __future__ import annotations
import json
import os
import sys
import time
from pathlib import Path
from typing import Any


def _resolve_device_compute(
    requested_device: str,
    compute_gpu: str,
    compute_cpu: str,
) -> tuple[str, str]:
    if os.environ.get("DIVE_FORCE_CPU") == "1":
        return "cpu", compute_cpu
    if requested_device == "cpu":
        return "cpu", compute_cpu
    if requested_device in ("cuda", "auto"):
        try:
            import ctranslate2  # type: ignore
            if ctranslate2.get_cuda_device_count() > 0:
                return "cuda", compute_gpu
        except Exception as e:
            sys.stderr.write(f"[batch] CUDA probe failed: {e}\n")
        if requested_device == "cuda":
            sys.stderr.write(
                "[batch] cuda requested but unavailable, falling back to cpu\n"
            )
        return "cpu", compute_cpu
    return "cpu", compute_cpu


def _transcribe_one(
    model,
    input_path: str,
    out_path: str,
    language: str,
    initial_prompt: str = "",
    vad_filter: bool = False,
    progress_emit: "callable | None" = None,
) -> int:
    t0 = time.time()
    # Hallucination prevention:
    #   * condition_on_previous_text=False 切断跨段幻听传播
    #   * compression_ratio_threshold=2.4 检测重复段
    #   * initial_prompt 引导识别专业词汇
    segments_iter, info = model.transcribe(
        input_path,
        language=language,
        word_timestamps=True,
        vad_filter=vad_filter,
        condition_on_previous_text=False,
        compression_ratio_threshold=2.4,
        initial_prompt=initial_prompt or None,
    )
    # Emit total audio duration once so the parent can size the
    # aggregate progress denominator before the first segment lands.
    total_audio_sec = float(info.duration or 0.0)
    if progress_emit:
        progress_emit("file_total", input_path, 0.0, total_audio_sec)

    words: list[list] = []
    segments_meta: list[dict] = []
    last_emit = 0.0
    for seg in segments_iter:
        idx = len(segments_meta)
        segments_meta.append({
            "idx": idx,
            "start": float(seg.start),
            "end": float(seg.end),
            "text": (seg.text or "").strip(),
            "no_speech_prob": float(getattr(seg, "no_speech_prob", 0.0) or 0.0),
            "avg_logprob": float(getattr(seg, "avg_logprob", 0.0) or 0.0),
            "compression_ratio": float(getattr(seg, "compression_ratio", 0.0) or 0.0),
        })
        for w in (seg.words or []):
            words.append([
                float(w.start),
                float(w.end),
                str(w.word).strip(),
                idx,
                float(getattr(w, "probability", 0.0) or 0.0),
            ])
        # Throttle sub-event emits so they don't spam stderr — at most
        # one progress line every 0.5s of audio processed. The parent
        # aggregates these into a single percent across all workers.
        done_sec = min(float(seg.end), total_audio_sec)
        if progress_emit and (done_sec - last_emit) >= 0.5:
            progress_emit("segment_progress", input_path, done_sec, total_audio_sec)
            last_emit = done_sec
    # Final tick at the actual end of audio.
    if progress_emit:
        progress_emit("segment_progress", input_path, total_audio_sec, total_audio_sec)

    payload = {
        "words": words,
        "segments": segments_meta,
    }
    tmp = out_path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False)
    os.replace(tmp, out_path)

    # Per-file done line is emitted by the caller (main loop), so we
    # only return the word count.
    return len(words)


def _clip_timestamps(duration_sec: float, chunk_sec: float) -> list[dict[str, float]]:
    """Build fixed chunks for faster-whisper batched inference."""
    if duration_sec <= 0:
        return []
    out: list[dict[str, float]] = []
    start = 0.0
    step = max(5.0, float(chunk_sec or 30.0))
    while start < duration_sec:
        end = min(duration_sec, start + step)
        out.append({"start": start, "end": end})
        start = end
    return out


def _transcribe_one_batched(
    model,
    input_path: str,
    out_path: str,
    language: str,
    initial_prompt: str = "",
    vad_filter: bool = False,
    progress_emit: "callable | None" = None,
    batch_size: int = 8,
    chunk_sec: float = 30.0,
) -> int:
    """GPU-oriented batched inference over fixed chunks in one model process."""
    from faster_whisper.audio import decode_audio
    from faster_whisper.transcribe import BatchedInferencePipeline

    audio = decode_audio(input_path)
    total_audio_sec = float(len(audio) / 16000.0)
    if progress_emit:
        progress_emit("file_total", input_path, 0.0, total_audio_sec)

    clips = _clip_timestamps(total_audio_sec, chunk_sec)
    pipe = BatchedInferencePipeline(model)
    kwargs: dict[str, Any] = {
        "language": language,
        "word_timestamps": True,
        "vad_filter": vad_filter,
        "condition_on_previous_text": False,
        "compression_ratio_threshold": 2.4,
        "initial_prompt": initial_prompt or None,
        "batch_size": max(1, int(batch_size or 8)),
    }
    if not vad_filter:
        kwargs["clip_timestamps"] = clips
        kwargs["without_timestamps"] = False

    segments_iter, _info = pipe.transcribe(audio, **kwargs)

    words: list[list] = []
    segments_meta: list[dict] = []
    last_emit = 0.0
    for seg in segments_iter:
        idx = len(segments_meta)
        segments_meta.append({
            "idx": idx,
            "start": float(seg.start),
            "end": float(seg.end),
            "text": (seg.text or "").strip(),
            "no_speech_prob": float(getattr(seg, "no_speech_prob", 0.0) or 0.0),
            "avg_logprob": float(getattr(seg, "avg_logprob", 0.0) or 0.0),
            "compression_ratio": float(getattr(seg, "compression_ratio", 0.0) or 0.0),
        })
        for w in (seg.words or []):
            words.append([
                float(w.start),
                float(w.end),
                str(w.word).strip(),
                idx,
                float(getattr(w, "probability", 0.0) or 0.0),
            ])
        done_sec = min(float(seg.end), total_audio_sec)
        if progress_emit and (done_sec - last_emit) >= 0.5:
            progress_emit("segment_progress", input_path, done_sec, total_audio_sec)
            last_emit = done_sec

    if progress_emit:
        progress_emit("segment_progress", input_path, total_audio_sec, total_audio_sec)

    payload = {
        "words": words,
        "segments": segments_meta,
    }
    tmp = out_path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False)
    os.replace(tmp, out_path)
    return len(words)


def _load_whisper_model_with_cpu_fallback(
    whisper_model_cls,
    model_name: str,
    device: str,
    compute_type: str,
    compute_cpu: str,
    cpu_threads: int,
    emit,
):
    safe_cpu_threads = max(1, int(cpu_threads or 0) or max(1, (os.cpu_count() or 4) - 2))
    try:
        model = whisper_model_cls(
            model_name,
            device=device,
            compute_type=compute_type,
            cpu_threads=safe_cpu_threads if device == "cpu" else 0,
        )
        return model, device, compute_type, False
    except Exception as e:
        import traceback as _tb
        emit(
            f"model_load_error device={device!r} "
            f"compute_type={compute_type!r} exc={type(e).__name__!r} msg={str(e)!r}"
        )
        for line in _tb.format_exc().splitlines():
            emit(f"tb: {line}")
        if device != "cuda":
            raise
        emit(f"retry device={'cpu'!r} compute_type={compute_cpu!r}")
        os.environ["DIVE_FORCE_CPU"] = "1"
        model = whisper_model_cls(
            model_name,
            device="cpu",
            compute_type=compute_cpu,
            cpu_threads=safe_cpu_threads,
        )
        return model, "cpu", compute_cpu, True


def main() -> int:
    if len(sys.argv) < 2:
        sys.stderr.write(
            "usage: whisper_batch_worker <manifest.json> "
            "[model] [device] [compute_gpu] [compute_cpu] [language] "
            "[prompt_file] [vad] [cpu_threads] [inference_mode] "
            "[batch_size] [chunk_sec]\n"
        )
        return 2

    manifest_path = Path(sys.argv[1])
    model_name = sys.argv[2] if len(sys.argv) > 2 else "medium"
    requested_device = sys.argv[3] if len(sys.argv) > 3 else "auto"
    compute_gpu = sys.argv[4] if len(sys.argv) > 4 else "int8_float16"
    compute_cpu = sys.argv[5] if len(sys.argv) > 5 else "int8"
    language = sys.argv[6] if len(sys.argv) > 6 else "en"
    prompt_file = sys.argv[7] if len(sys.argv) > 7 else ""
    vad_arg = sys.argv[8] if len(sys.argv) > 8 else "off"
    vad_filter = vad_arg.lower() in ("on", "true", "1", "yes")
    try:
        cpu_threads = int(sys.argv[9]) if len(sys.argv) > 9 else 0
    except ValueError:
        cpu_threads = 0
    inference_mode = (sys.argv[10] if len(sys.argv) > 10 else "standard").lower()
    try:
        batch_size = max(1, int(sys.argv[11])) if len(sys.argv) > 11 else 8
    except ValueError:
        batch_size = 8
    try:
        chunk_sec = max(5.0, float(sys.argv[12])) if len(sys.argv) > 12 else 30.0
    except ValueError:
        chunk_sec = 30.0

    initial_prompt = ""
    if prompt_file and Path(prompt_file).exists():
        try:
            initial_prompt = Path(prompt_file).read_text(encoding="utf-8").strip()
            if initial_prompt:
                sys.stderr.write(
                    f"[batch] initial_prompt: {initial_prompt[:120]}"
                    f"{'...' if len(initial_prompt) > 120 else ''}\n"
                )
        except OSError as e:
            sys.stderr.write(f"[batch] failed to read prompt file: {e}\n")

    if not manifest_path.exists():
        sys.stderr.write(f"[batch] manifest not found: {manifest_path}\n")
        return 3

    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        sys.stderr.write(f"[batch] bad manifest: {e}\n")
        return 4

    if not manifest:
        sys.stderr.write("[batch] empty manifest — nothing to do\n")
        return 0

    device, compute_type = _resolve_device_compute(requested_device, compute_gpu, compute_cpu)
    pid = os.getpid()

    # Sidecar log file next to the manifest. PyInstaller's windowed
    # bootloader sometimes invalidates sys.stderr (OSError [Errno 22]
    # Invalid argument on write) even when the parent passed
    # stderr=PIPE. Writing the structured records to a file too means
    # the parent can still recover them via post-exit read; stderr
    # remains the primary path when it works.
    _log_fp = None
    try:
        _log_path = Path(manifest_path).parent / f"worker_{pid}.log"
        _log_fp = open(_log_path, "w", encoding="utf-8", buffering=1)
    except OSError:
        _log_fp = None

    def _emit(record: str) -> None:
        # Try stderr first; on Windows windowed-mode bootloader it may
        # raise OSError. The sidecar log file is the durable record.
        line = record + "\n"
        try:
            sys.stderr.write(line)
            sys.stderr.flush()
        except (OSError, AttributeError, ValueError):
            pass
        if _log_fp is not None:
            try:
                _log_fp.write(line)
            except OSError:
                pass

    _emit(
        f"[w pid={pid}] init "
        f"requested_device={requested_device!r} "
        f"resolved_device={device!r} "
        f"compute_type={compute_type!r} "
        f"compute_gpu={compute_gpu!r} "
        f"compute_cpu={compute_cpu!r} "
        f"cuda_status={os.environ.get('DIVE_CUDA_STATUS')!r} "
        f"force_cpu={os.environ.get('DIVE_FORCE_CPU')!r} "
        f"model={model_name!r} "
        f"language={language!r} "
        f"cpu_threads={cpu_threads} "
        f"inference_mode={inference_mode!r} "
        f"batch_size={batch_size} "
        f"chunk_sec={chunk_sec:.1f} "
        f"vad={'on' if vad_filter else 'off'} "
        f"n_files={len(manifest)} "
        f"manifest_path={str(manifest_path)!r}"
    )

    t0 = time.time()
    from faster_whisper import WhisperModel
    try:
        import faster_whisper as _fw
        import ctranslate2 as _ct2
        _emit(
            f"[w pid={pid}] versions "
            f"faster_whisper={getattr(_fw, '__version__', '?')!r} "
            f"ctranslate2={getattr(_ct2, '__version__', '?')!r}"
        )
    except Exception:
        pass

    def _emit_worker(msg: str) -> None:
        _emit(f"[w pid={pid}] {msg}")

    model, device, compute_type, fell_back_to_cpu = _load_whisper_model_with_cpu_fallback(
        WhisperModel,
        model_name,
        device,
        compute_type,
        compute_cpu,
        cpu_threads,
        _emit_worker,
    )
    if fell_back_to_cpu:
        inference_mode = "standard"

    load_dt = time.time() - t0
    _emit(
        f"[w pid={pid}] model_ready load_s={load_dt:.2f} "
        f"active_device={device!r} active_compute={compute_type!r}"
    )

    empty_payload = json.dumps({"words": [], "segments": []})

    for i, entry in enumerate(manifest, 1):
        input_file = entry.get("input")
        out = entry.get("output")
        if not input_file or not out:
            _emit(f"[w pid={pid}] file_skip i={i} reason=invalid_entry entry={entry!r}")
            continue
        if not Path(input_file).exists():
            _emit(
                f"[w pid={pid}] file_skip i={i}/{len(manifest)} "
                f"reason=input_missing input={input_file!r}"
            )
            Path(out).parent.mkdir(parents=True, exist_ok=True)
            Path(out).write_text(empty_payload, encoding="utf-8")
            continue

        input_name = Path(input_file).name
        input_mode = str(entry.get("mode") or "media")
        t_file = time.time()
        input_size = Path(input_file).stat().st_size if Path(input_file).exists() else 0
        _emit(
            f"[w pid={pid}] file_start i={i}/{len(manifest)} "
            f"input={input_name!r} mode={input_mode!r} size_bytes={input_size} "
            f"in={input_file!r} out={out!r}"
        )
        def _progress_emit(kind: str, input_arg: str, t_done: float, t_total: float) -> None:
            _emit(
                f"[w pid={pid}] {kind} input={Path(input_arg).name!r} "
                f"t_done={t_done:.2f} t_total={t_total:.2f}"
            )

        try:
            use_batched = inference_mode == "batched" or (
                inference_mode == "auto" and device == "cuda"
            )
            transcribe_mode = "batched" if use_batched else "standard"
            if use_batched:
                try:
                    words = _transcribe_one_batched(
                        model,
                        input_file,
                        out,
                        language,
                        initial_prompt,
                        vad_filter,
                        progress_emit=_progress_emit,
                        batch_size=batch_size,
                        chunk_sec=chunk_sec,
                    )
                except Exception as e:
                    _emit(
                        f"[w pid={pid}] batched_fallback input={input_name!r} "
                        f"exc={type(e).__name__!r} msg={str(e)!r}"
                    )
                    transcribe_mode = "standard_after_batched_error"
                    try:
                        words = _transcribe_one(
                            model, input_file, out, language, initial_prompt, vad_filter,
                            progress_emit=_progress_emit,
                        )
                    except Exception as standard_error:
                        if device != "cuda":
                            raise
                        _emit(
                            f"[w pid={pid}] cuda_inference_error input={input_name!r} "
                            f"exc={type(standard_error).__name__!r} msg={str(standard_error)!r}"
                        )
                        _emit(f"[w pid={pid}] retry_current_file_on_cpu input={input_name!r}")
                        model, device, compute_type, _ = _load_whisper_model_with_cpu_fallback(
                            WhisperModel,
                            model_name,
                            "cpu",
                            compute_cpu,
                            compute_cpu,
                            cpu_threads,
                            _emit_worker,
                        )
                        inference_mode = "standard"
                        transcribe_mode = "cpu_after_cuda_error"
                        words = _transcribe_one(
                            model, input_file, out, language, initial_prompt, vad_filter,
                            progress_emit=_progress_emit,
                        )
            else:
                try:
                    words = _transcribe_one(
                        model, input_file, out, language, initial_prompt, vad_filter,
                        progress_emit=_progress_emit,
                    )
                except Exception as e:
                    if device != "cuda":
                        raise
                    _emit(
                        f"[w pid={pid}] cuda_inference_error input={input_name!r} "
                        f"exc={type(e).__name__!r} msg={str(e)!r}"
                    )
                    _emit(f"[w pid={pid}] retry_current_file_on_cpu input={input_name!r}")
                    model, device, compute_type, _ = _load_whisper_model_with_cpu_fallback(
                        WhisperModel,
                        model_name,
                        "cpu",
                        compute_cpu,
                        compute_cpu,
                        cpu_threads,
                        _emit_worker,
                    )
                    inference_mode = "standard"
                    transcribe_mode = "cpu_after_cuda_error"
                    words = _transcribe_one(
                        model, input_file, out, language, initial_prompt, vad_filter,
                        progress_emit=_progress_emit,
                    )
            file_dt = time.time() - t_file
            out_size = Path(out).stat().st_size if Path(out).exists() else 0
            _emit(
                f"[w pid={pid}] file_done i={i}/{len(manifest)} "
                f"input={input_name!r} mode={input_mode!r} wall_s={file_dt:.2f} "
                f"words={words} out_bytes={out_size} device={device!r} "
                f"inference={transcribe_mode!r}"
            )
        except Exception as e:
            import traceback as _tb
            _emit(
                f"[w pid={pid}] file_error i={i}/{len(manifest)} "
                f"input={input_name!r} mode={input_mode!r} "
                f"exc={type(e).__name__!r} msg={str(e)!r}"
            )
            for line in _tb.format_exc().splitlines():
                _emit(f"[w pid={pid}] tb: {line}")
            Path(out).parent.mkdir(parents=True, exist_ok=True)
            Path(out).write_text(empty_payload, encoding="utf-8")

    total_dt = time.time() - t0
    _emit(
        f"[w pid={pid}] done total_s={total_dt:.2f} "
        f"n_files={len(manifest)} device={device!r}"
    )
    if _log_fp is not None:
        try:
            _log_fp.flush()
            _log_fp.close()
        except OSError:
            pass
    try:
        sys.stdout.flush()
        sys.stderr.flush()
    except Exception:
        pass
    # On Windows + CUDA, CTranslate2 can crash while Python unwinds the
    # WhisperModel object after all output files are already written.
    # Exit before object teardown so the parent sees the successful worker
    # result instead of rc=0xC0000409.
    os._exit(0)


if __name__ == "__main__":
    rc = main()
    try:
        sys.stdout.flush()
        sys.stderr.flush()
    except Exception:
        pass
    os._exit(rc)
