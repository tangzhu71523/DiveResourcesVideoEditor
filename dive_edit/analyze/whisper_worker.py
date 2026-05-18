"""Isolated Whisper worker script.

Runs in a fresh Python subprocess to keep ctranslate2's CUDA init separate
from cv2's. Writes JSON results to a FILE (not stdout) because ctranslate2
on Windows + CUDA has a teardown-time stack buffer overrun bug
(exit code 0xC0000409) that would otherwise drop the output.

Usage:
    python -m dive_edit.analyze.whisper_worker \\
        <wav_path> <out_json_path> [model] [device] [compute_type] [language]
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
    """Map 'auto' to cuda if available, otherwise cpu. Explicit cuda/cpu
    pass through but fall back on CUDA init failure."""
    if requested_device == "cpu":
        return "cpu", compute_cpu

    if requested_device in ("cuda", "auto"):
        try:
            import ctranslate2  # type: ignore
            if ctranslate2.get_cuda_device_count() > 0:
                return "cuda", compute_gpu
        except Exception as e:
            sys.stderr.write(f"[worker] CUDA probe failed: {e}\n")
        if requested_device == "cuda":
            sys.stderr.write("[worker] cuda requested but unavailable, falling back to cpu\n")
        return "cpu", compute_cpu

    return "cpu", compute_cpu


def main() -> int:
    if len(sys.argv) < 3:
        sys.stderr.write(
            "usage: whisper_worker <wav> <out_json> [model] [device] [compute_gpu] [compute_cpu] [language]\n"
        )
        return 2

    wav_path = sys.argv[1]
    out_json = Path(sys.argv[2])
    model_name = sys.argv[3] if len(sys.argv) > 3 else "medium"
    requested_device = sys.argv[4] if len(sys.argv) > 4 else "auto"
    compute_gpu = sys.argv[5] if len(sys.argv) > 5 else "int8_float16"
    compute_cpu = sys.argv[6] if len(sys.argv) > 6 else "int8"
    language = sys.argv[7] if len(sys.argv) > 7 else "en"

    if not Path(wav_path).exists():
        sys.stderr.write(f"wav not found: {wav_path}\n")
        return 3

    device, compute_type = _resolve_device_compute(requested_device, compute_gpu, compute_cpu)
    sys.stderr.write(f"[worker] loading {model_name} on {device}/{compute_type}\n")
    sys.stderr.flush()

    t0 = time.time()
    from faster_whisper import WhisperModel

    try:
        model = WhisperModel(model_name, device=device, compute_type=compute_type)
    except Exception as e:
        if device == "cuda":
            sys.stderr.write(f"[worker] cuda load failed ({e}); retrying on cpu\n")
            sys.stderr.flush()
            device, compute_type = "cpu", compute_cpu
            model = WhisperModel(model_name, device=device, compute_type=compute_type)
        else:
            raise
    sys.stderr.write(f"[worker] model ready in {time.time() - t0:.1f}s ({device}/{compute_type})\n")
    sys.stderr.flush()

    t0 = time.time()
    segments, _info = model.transcribe(
        wav_path,
        language=language,
        word_timestamps=True,
        vad_filter=False,
        condition_on_previous_text=False,
        compression_ratio_threshold=2.4,
    )
    words: list[list] = []  # [[start, end, text], ...]
    for seg in segments:
        for w in (seg.words or []):
            words.append([float(w.start), float(w.end), str(w.word).strip()])
    sys.stderr.write(f"[worker] transcribed {len(words)} words in {time.time() - t0:.1f}s\n")
    sys.stderr.flush()

    # Write results to file BEFORE any teardown can crash us.
    tmp_out = out_json.with_suffix(out_json.suffix + ".tmp")
    tmp_out.write_text(json.dumps(words), encoding="utf-8")
    os.replace(tmp_out, out_json)
    sys.stderr.write(f"[worker] wrote {len(words)} words to {out_json}\n")
    sys.stderr.flush()

    # Explicit best-effort cleanup. If ctranslate2 segfaults during teardown,
    # our output file is already on disk and the parent will read it regardless.
    del model
    return 0


if __name__ == "__main__":
    sys.exit(main())
