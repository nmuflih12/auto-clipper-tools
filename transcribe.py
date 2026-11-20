"""Speech-to-text with word timestamps (faster-whisper). Runs as its own process.

usage: python transcribe.py <media> <out.json> [--model auto] [--lang id] [--device auto] [--prompt "..."]
Prints "PROGRESS <0..1>" lines and "DEVICE <name>" for the GUI.
"""
import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

import numpy as np


def decode_audio(path, sr=16000):
    """16 kHz mono float32 via ffmpeg (avoids PyAV version issues)."""
    out = subprocess.run(["ffmpeg", "-v", "error", "-nostdin", "-i", str(path), "-vn", "-ac", "1", "-ar", str(sr),
                          "-f", "s16le", "-"], capture_output=True,
                         creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    if out.returncode != 0:
        raise RuntimeError(out.stderr.decode("utf-8", "replace")[-400:])
    return np.frombuffer(out.stdout, dtype=np.int16).astype(np.float32) / 32768.0


def add_cuda_dll_dirs():
    """pip-installed NVIDIA runtimes (cuBLAS) live in site-packages/nvidia/*/bin on Windows."""
    if os.name != "nt":
        return
    import site
    roots = list(site.getsitepackages()) + [site.getusersitepackages()]
    for root in roots:
        nv = Path(root) / "nvidia"
        if not nv.is_dir():
            continue
        for bin_dir in nv.glob("*/bin"):
            os.environ["PATH"] = str(bin_dir) + os.pathsep + os.environ.get("PATH", "")
            try:
                os.add_dll_directory(str(bin_dir))
            except OSError:
                pass


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("media")
    ap.add_argument("out")
    ap.add_argument("--model", default="auto")
    ap.add_argument("--lang", default="id")
    ap.add_argument("--device", default="auto")
    ap.add_argument("--prompt", default="")
    a = ap.parse_args()

    add_cuda_dll_dirs()
    import ctranslate2
    from faster_whisper import WhisperModel

    device = a.device
    if device == "auto":
        device = "cuda" if ctranslate2.get_cuda_device_count() > 0 else "cpu"
    model_name = a.model
    if model_name == "auto":
        model_name = "large-v3-turbo" if device == "cuda" else "small"

    def load(dev):
        ctype = "float16" if dev == "cuda" else "int8"
        return WhisperModel(model_name, device=dev, compute_type=ctype)

    audio = decode_audio(a.media)
    try:
        model = load(device)
        segments, info = model.transcribe(
            audio, language=a.lang or None, word_timestamps=True, vad_filter=True,
            vad_parameters={"min_silence_duration_ms": 600}, beam_size=5,
            initial_prompt=a.prompt or None, condition_on_previous_text=False,
        )
        # the CUDA libraries are only touched on the first decode step
        seg_iter = iter(segments)
        first = next(seg_iter, None)
    except Exception as e:  # missing CUDA DLLs etc. -> CPU fallback
        if device != "cuda":
            raise
        print(f"WARN GPU gagal ({e}); pakai CPU", flush=True)
        device = "cpu"
        if a.model == "auto":
            model_name = "small"
        model = load("cpu")
        segments, info = model.transcribe(
            audio, language=a.lang or None, word_timestamps=True, vad_filter=True,
            vad_parameters={"min_silence_duration_ms": 600}, beam_size=5,
            initial_prompt=a.prompt or None, condition_on_previous_text=False,
        )
        seg_iter = iter(segments)
        first = next(seg_iter, None)

    print(f"DEVICE {device} {model_name}", flush=True)
    duration = getattr(info, "duration", 0) or 0
    out_segments = []

    def take(seg):
        words = [
            {"w": w.word.strip(), "s": round(w.start, 2), "e": round(w.end, 2), "p": round(w.probability, 2)}
            for w in (seg.words or []) if w.word.strip()
        ]
        out_segments.append({"start": round(seg.start, 2), "end": round(seg.end, 2),
                             "text": seg.text.strip(), "words": words})
        if duration:
            print(f"PROGRESS {min(1.0, seg.end / duration):.3f}", flush=True)

    if first is not None:
        take(first)
        for seg in seg_iter:
            take(seg)

    data = {"language": getattr(info, "language", a.lang), "model": model_name, "device": device,
            "duration": duration, "segments": out_segments}
    Path(a.out).parent.mkdir(parents=True, exist_ok=True)
    with open(a.out, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
    print("PROGRESS 1.0", flush=True)
    print("DONE", flush=True)


if __name__ == "__main__":
    sys.exit(main())
