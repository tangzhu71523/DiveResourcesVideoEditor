"""Batched isolated Whisper worker.

Loads the Whisper model ONCE and processes multiple audio files in a
single subprocess invocation. Skips the ~5-10 second CUDA + model
initialization cost per file that the single-file `whisper_worker.py`
pays.

Usage:
    python -m dive_edit.analyze.whisper_batch_worker <manifest.json>
        [model] [device] [compute_gpu] [compute_cpu] [language] [prompt_file]

The manifest is a JSON array of `{"input": "...wav", "output": "...json"}`
entries. For each entry, the worker writes a JSON document to the output
path BEFORE moving on. Results are persisted immediately so a
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


def _resolve_device_compute(
    requested_device: str,
    compute_gpu: str,
    compute_cpu: str,
) -> tuple[str, str]:
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
    wav_path: str,
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
        wav_path,
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
        progress_emit("file_total", wav_path, 0.0, total_audio_sec)

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
        if progress_emit and (float(seg.end) - last_emit) >= 0.5:
            progress_emit("segment_progress", wav_path, float(seg.end), total_audio_sec)
            last_emit = float(seg.end)
    # Final tick at the actual end of audio.
    if progress_emit:
        progress_emit("segment_progress", wav_path, total_audio_sec, total_audio_sec)

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


def main() -> int:
    if len(sys.argv) < 2:
        sys.stderr.write(
            "usage: whisper_batch_worker <manifest.json> "
            "[model] [device] [compute_gpu] [compute_cpu] [language]\n"
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

    try:
        model = WhisperModel(model_name, device=device, compute_type=compute_type)
    except Exception as e:
        import traceback as _tb
        _emit(
            f"[w pid={pid}] model_load_error device={device!r} "
            f"compute_type={compute_type!r} exc={type(e).__name__!r} msg={str(e)!r}"
        )
        for line in _tb.format_exc().splitlines():
            _emit(f"[w pid={pid}] tb: {line}")
        if device == "cuda":
            _emit(
                f"[w pid={pid}] retry device={'cpu'!r} "
                f"compute_type={compute_cpu!r}"
            )
            device, compute_type = "cpu", compute_cpu
            model = WhisperModel(model_name, device=device, compute_type=compute_type)
        else:
            raise

    load_dt = time.time() - t0
    _emit(
        f"[w pid={pid}] model_ready load_s={load_dt:.2f} "
        f"active_device={device!r} active_compute={compute_type!r}"
    )

    empty_payload = json.dumps({"words": [], "segments": []})

    for i, entry in enumerate(manifest, 1):
        wav = entry.get("input")
        out = entry.get("output")
        if not wav or not out:
            _emit(f"[w pid={pid}] file_skip i={i} reason=invalid_entry entry={entry!r}")
            continue
        if not Path(wav).exists():
            _emit(
                f"[w pid={pid}] file_skip i={i}/{len(manifest)} "
                f"reason=wav_missing wav={wav!r}"
            )
            Path(out).parent.mkdir(parents=True, exist_ok=True)
            Path(out).write_text(empty_payload, encoding="utf-8")
            continue

        wav_name = Path(wav).name
        t_file = time.time()
        wav_size = Path(wav).stat().st_size if Path(wav).exists() else 0
        _emit(
            f"[w pid={pid}] file_start i={i}/{len(manifest)} "
            f"wav={wav_name!r} size_bytes={wav_size} "
            f"in={wav!r} out={out!r}"
        )
        def _progress_emit(kind: str, wav_arg: str, t_done: float, t_total: float) -> None:
            _emit(
                f"[w pid={pid}] {kind} wav={Path(wav_arg).name!r} "
                f"t_done={t_done:.2f} t_total={t_total:.2f}"
            )

        try:
            words = _transcribe_one(
                model, wav, out, language, initial_prompt, vad_filter,
                progress_emit=_progress_emit,
            )
            file_dt = time.time() - t_file
            out_size = Path(out).stat().st_size if Path(out).exists() else 0
            _emit(
                f"[w pid={pid}] file_done i={i}/{len(manifest)} "
                f"wav={wav_name!r} wall_s={file_dt:.2f} "
                f"words={words} out_bytes={out_size} device={device!r}"
            )
        except Exception as e:
            import traceback as _tb
            _emit(
                f"[w pid={pid}] file_error i={i}/{len(manifest)} "
                f"wav={wav_name!r} exc={type(e).__name__!r} msg={str(e)!r}"
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
    del model
    return 0


if __name__ == "__main__":
    sys.exit(main())
