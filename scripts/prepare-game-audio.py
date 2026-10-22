#!/usr/bin/env python3
"""Prepare the selected local gameplay excerpts for browser playback.

Run: .tools/audio-analysis/bin/python scripts/prepare-game-audio.py [--check]
Requires NumPy. Inputs remain unchanged in temp/game-audio/. No downloads,
generation requests, resampling, pitch shifting, or time stretching are used.
"""
import argparse
import hashlib
import io
import json
import math
from pathlib import Path
import wave

import numpy as np

from audio_processing import cosine_release, read_wav, wav_bytes


ROOT = Path(__file__).resolve().parents[1]
WEAPONS = ("enfield", "mosin", "kar98k")
WEAPON_GAIN_DB = -2.3
MOVEMENT_PEAK_DBFS = -12.0


def selected_ids():
    reports = [f"{weapon}-report-{variant}" for weapon in WEAPONS for variant in (1, 2, 3)]
    bolts = [f"{weapon}-{phase}" for weapon in WEAPONS for phase in ("open-eject", "close-lock")]
    reloads = [
        "enfield-reload-bolt-open", "enfield-reload-clip-1-load",
        "enfield-reload-clip-2-load", "enfield-reload-bolt-close",
        "mosin-reload-bolt-open", "mosin-reload-clip-load", "mosin-reload-bolt-close",
        "kar98k-reload-bolt-open", "kar98k-reload-clip-load", "kar98k-reload-bolt-close",
    ]
    return reports + bolts + reloads + [f"movement-footstep-candidate-{variant}" for variant in (1, 2)]


def digest(blob):
    return hashlib.sha256(blob).hexdigest()


def json_bytes(value):
    return (json.dumps(value, indent=2, ensure_ascii=False) + "\n").encode()


def level(value):
    return round(20 * math.log10(max(float(value), 1e-12)), 6)


def prepare(source_dir):
    manifest_blob = (source_dir / "manifest.json").read_bytes()
    source_manifest = json.loads(manifest_blob)
    clips = {item["id"]: item for item in source_manifest["clips"]}
    decoded = {}
    for name in selected_ids():
        clip = clips[name]
        blob = (source_dir / clip["raw_file"]).read_bytes()
        if digest(blob) != clip["raw_sha256"]:
            raise ValueError(f"Source hash does not match extraction manifest: {name}")
        samples, rate = read_wav(blob)
        if rate != 48000 or len(samples) != clip["frames"]:
            raise ValueError(f"Unexpected sample rate or frame count: {name}")
        decoded[name] = (samples, rate)

    movement_peak = max(np.max(np.abs(samples)) for name, (samples, _) in decoded.items() if name.startswith("movement-"))
    movement_gain = 10 ** (MOVEMENT_PEAK_DBFS / 20) / movement_peak
    outputs, catalog, records = {}, [], []
    for name in selected_ids():
        clip = clips[name]
        samples, rate = decoded[name]
        samples = samples.copy()
        movement = name.startswith("movement-")
        report = "-report-" in name
        gain = movement_gain if movement else 10 ** (WEAPON_GAIN_DB / 20)
        # Leave the first 500 ms of each report intact, then ease its full tail
        # to zero with flat envelope slopes at both ends of the release.
        attack, release = (.002, .300) if report else (.004, .015 if movement else .012)
        attack_frames, release_frames = round(attack * rate), round(release * rate)
        samples[:attack_frames] *= np.linspace(0, 1, attack_frames)
        if report:
            samples = cosine_release(samples, rate, release)
        else:
            samples[-release_frames:] *= np.linspace(1, 0, release_frames)
        samples *= gain
        if np.max(np.abs(samples)) >= 1:
            raise ValueError(f"Output would clip: {name}")
        blob = wav_bytes(samples, rate)
        with wave.open(io.BytesIO(blob), "rb") as wav:
            if (wav.getnchannels(), wav.getsampwidth(), wav.getframerate(), wav.getnframes()) != (1, 2, rate, clip["frames"]):
                raise ValueError(f"Invalid output format: {name}")
            pcm = np.frombuffer(wav.readframes(wav.getnframes()), dtype="<i2")
        if pcm[0] or pcm[-1] or not np.any(pcm) or np.max(np.abs(pcm.astype(np.int32))) >= 32767:
            raise ValueError(f"Invalid output samples: {name}")
        filename = f"{name}.wav"
        outputs[filename] = blob
        catalog.append({"id": name, "file": f"/assets/audio/game/{filename}", "duration": len(samples) / rate})
        source = source_manifest["sources"][clip["source"]]
        records.append({
            "id": name,
            "file": filename,
            "duration_seconds": len(samples) / rate,
            "frames": len(samples),
            "source_id": clip["source"],
            "source_audio_sha256": source["audio_sha256"],
            "source_clip": f"temp/game-audio/{clip['raw_file']}",
            "source_clip_sha256": clip["raw_sha256"],
            "source_start_seconds": clip["start_seconds"],
            "source_end_seconds": clip["end_seconds"],
            "isolation": clip["isolation"],
            "notes": clip["notes"],
            "evidence": clip["evidence"],
            "processing": {
                "channel_mix": "arithmetic mean of stereo channels",
                "gain_db": level(gain),
                "linear_attack_seconds": attack,
                "release_seconds": release,
                "release_curve": "raised cosine" if report else "linear",
                "timing": "original sample count and pitch preserved",
            },
            "output_sha256": digest(blob),
            "output_peak_dbfs": level(np.max(np.abs(pcm.astype(np.float64))) / 32768),
            "output_rms_dbfs": level(np.sqrt(np.mean((pcm.astype(np.float64) / 32768) ** 2))),
        })
    provenance = {
        "format": "48 kHz mono PCM16 WAV",
        "preparation_script": "scripts/prepare-game-audio.py",
        "source_manifest_sha256": digest(manifest_blob),
        "method": "Selected local raw gameplay excerpts, stereo averaged to mono, fixed gain and a short attack fade, then PCM16 quantization. Reports use a 300 ms raised-cosine release; other clips retain short linear releases. Duration and pitch retained.",
        "weapon_gain_db": WEAPON_GAIN_DB,
        "movement_pair_peak_target_dbfs": MOVEMENT_PEAK_DBFS,
        "limitations": [
            "These are excerpts from the final recorded game mix, not isolated original game assets. Ambience and overlapping sounds remain.",
            "Reports retain 800 ms including pre-roll, decay and some early bolt handling; the final 300 ms fades smoothly. These excerpts do not include a complete bolt cycle.",
            "Bolt subdivisions are approximate mixed handling phases, especially for the Enfield. Reload loading bursts combine insertion, cartridge push and clip removal.",
            "Movement clips are unconfirmed footstep candidates. The source does not establish foot contact, side, gait, surface, or stance, and an off-screen sound cannot be excluded.",
        ],
        "clips": records,
    }
    return outputs, catalog, provenance


def run(args):
    outputs, catalog, provenance = prepare(args.source)
    files = {args.output / name: blob for name, blob in outputs.items()}
    files[args.output / "provenance.json"] = json_bytes(provenance)
    files[args.catalog] = json_bytes(catalog)
    for path, blob in files.items():
        if args.check:
            if not path.is_file() or path.read_bytes() != blob:
                raise ValueError(f"Prepared output differs or is absent: {path.relative_to(ROOT)}")
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(blob)
    total = sum(len(blob) for blob in outputs.values())
    verb = "Verified" if args.check else "Prepared"
    print(f"{verb} {len(outputs)} mono PCM16 assets ({total:,} bytes), catalog and provenance.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=ROOT / "temp/game-audio")
    parser.add_argument("--output", type=Path, default=ROOT / "public/assets/audio/game")
    parser.add_argument("--catalog", type=Path, default=ROOT / "shared/game-audio.json")
    parser.add_argument("--check", action="store_true", help="Compare reproducible output with installed assets without writing")
    run(parser.parse_args())
