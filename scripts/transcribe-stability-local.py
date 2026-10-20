#!/usr/bin/env python3
"""Independently transcribe completed voice candidates with a local MLX model.

Run with .tools/local-whisper/bin/python. The model must already exist locally.
No upload, credentials, expected transcript, or remote inference is used.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import importlib.metadata
import json
import math
import os
from pathlib import Path
import time

ROOT = Path(__file__).resolve().parents[1]
# Enforce local model loading even if a dependency would otherwise contact a hub.
os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"
os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
os.environ["HF_HUB_DISABLE_IMPLICIT_TOKEN"] = "1"
os.environ["HF_HOME"] = str(ROOT / ".tools/huggingface-local-whisper")
os.environ["NUMBA_CACHE_DIR"] = str(ROOT / ".tools/numba-local-whisper")


def checksum(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def read_audio(path: Path):
    import numpy as np
    from scipy.io import wavfile
    from scipy.signal import resample_poly

    rate, samples = wavfile.read(path)
    if np.issubdtype(samples.dtype, np.signedinteger):
        samples = samples.astype(np.float32) / float(2 ** (samples.dtype.itemsize * 8 - 1))
    elif samples.dtype == np.uint8:
        samples = (samples.astype(np.float32) - 128) / 128
    elif np.issubdtype(samples.dtype, np.floating):
        samples = samples.astype(np.float32)
    else:
        raise ValueError(f"Unsupported WAV encoding: {samples.dtype}")
    if samples.ndim == 2:
        samples = samples.mean(axis=1)
    if samples.ndim != 1 or not np.isfinite(samples).all():
        raise ValueError("WAV must contain finite mono or stereo samples")
    duration = len(samples) / rate
    if rate != 16000:
        divisor = math.gcd(rate, 16000)
        samples = resample_poly(samples, 16000 // divisor, rate // divisor).astype(np.float32)
    return samples, duration, rate


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, default=ROOT / "shared/audio-candidates.json")
    parser.add_argument("--model", type=Path, default=ROOT / ".tools/whisper-large-v3-turbo")
    parser.add_argument("--out", type=Path, default=ROOT / "temp/stability-audio/local-transcripts")
    parser.add_argument("--id", action="append", help="Only process this candidate ID; repeatable")
    parser.add_argument("--limit", type=int, help="Maximum number of clips for an initial smoke run")
    parser.add_argument("--force", action="store_true", help="Repeat a clip even when its hash has a transcript")
    parser.add_argument("--references", action="store_true", help="Transcribe the current voice manifest as local controls")
    args = parser.parse_args()
    model = args.model.resolve(strict=True)
    if not (model / "config.json").is_file() or not (model / "weights.safetensors").is_file():
        parser.error("A complete local MLX Whisper model is required; this script never downloads it")
    args.out.mkdir(parents=True, exist_ok=True)
    manifest_bytes = args.manifest.read_bytes()
    entries = json.loads(manifest_bytes)
    candidates = ([{"id": f"reference-{entry['id']}", "sound": entry["id"], "file": entry["file"]}
                   for entry in entries] if args.references else
                  [entry for entry in entries if entry["group"] == "voice"])
    if args.id:
        candidates = [entry for entry in candidates if entry["id"] in args.id]
    if args.limit is not None:
        candidates = candidates[:args.limit]
    model_info_file = args.out / "model.json"
    if not model_info_file.exists():
        model_info_file = ROOT / "temp/stability-audio/local-transcripts/model.json"
    model_info = json.loads(model_info_file.read_text()) if model_info_file.exists() else {"path": str(model)}
    import mlx_whisper

    options = {"task": "transcribe", "temperature": 0.0,
               "condition_on_previous_text": False, "initial_prompt": None,
               "word_timestamps": False}
    records = []
    for index, candidate in enumerate(candidates, 1):
        path = (ROOT / "public" / candidate["file"].lstrip("/")).resolve(strict=True)
        path.relative_to(ROOT / "public/assets/audio" / ("voices" if args.references else "candidates"))
        digest = checksum(path)
        result_file = args.out / f"{candidate['id']}-{digest[:16]}.json"
        if result_file.exists() and not args.force:
            record = json.loads(result_file.read_text())
            if record.get("sha256") == digest and record.get("model") == model_info:
                records.append(record)
                print(f"{index}/{len(candidates)} cached {candidate['id']}: {record['transcript']}", flush=True)
                continue
        language = {"british": "en", "german": "de", "russian": "ru"}[candidate["sound"].split("-", 1)[0]]
        samples, duration, original_rate = read_audio(path)
        started = time.monotonic()
        result = mlx_whisper.transcribe(samples, path_or_hf_repo=str(model), verbose=None,
                                        language=language, **options)
        if checksum(path) != digest:
            raise RuntimeError(f"Clip changed during transcription: {candidate['id']}")
        record = {
            "id": candidate["id"], "file": candidate["file"], "sha256": digest,
            "language_hint": language, "duration": duration, "original_sample_rate": original_rate,
            "inference_sample_rate": 16000, "model": model_info,
            "engine": {"mlx-whisper": importlib.metadata.version("mlx-whisper"),
                       "mlx": importlib.metadata.version("mlx")},
            "options": options, "expected_text_supplied": False, "inference": "local-only",
            "transcript": result["text"].strip(), "detected_language": result.get("language"),
            "segments": result.get("segments", []),
            "elapsed_seconds": round(time.monotonic() - started, 3),
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
        result_file.write_text(json.dumps(record, ensure_ascii=False, indent=2) + "\n")
        records.append(record)
        print(f"{index}/{len(candidates)} {candidate['id']}: {record['transcript']}", flush=True)
    summary = {"manifest_sha256": hashlib.sha256(manifest_bytes).hexdigest(),
               "voice_count": len(records), "model": model_info,
               "expected_text_supplied": False, "inference": "local-only",
               "records": [{key: record[key] for key in ["id", "file", "sha256", "language_hint", "transcript"]}
                           for record in records]}
    (args.out / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n")
    print(f"Saved {len(records)} transcripts to {args.out}", flush=True)


if __name__ == "__main__":
    main()
