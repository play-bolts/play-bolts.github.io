#!/usr/bin/env python3
"""Generate the nine original Bolts character lines once, never at game runtime.

Without --generate, prints the plan. Uses OPENAI_API_KEY from the environment;
never writes the credential or API response errors to disk/stdout. Existing WAVs
are skipped so a failed run can resume without buying the same clips again.
"""
import argparse
import array
import datetime
import hashlib
import json
import math
import os
from pathlib import Path
import sys
import urllib.error
import urllib.request
import wave

ROOT = Path(__file__).resolve().parents[1]
MODEL = "gpt-4o-mini-tts-2025-12-15"
RATE = 24000
ACCENTS = {
    "british": "Native British English, a rough and confident English infantry sergeant.",
    "german": "Sprich Deutsch als Muttersprachler, deutlich und natürlich. Eine kräftige, tiefe männliche Stimme, ein kurzer entschlossener Ausruf. Sage ausschließlich den angegebenen Satz einmal, ohne Wiederholung. Kein übertriebenes Brüllen und keine langen Pausen.",
    "russian": "Говори по-русски, естественно, без иностранного акцента. Голос взрослого мужчины, низкий, сильный и уверенный: короткий резкий возглас победы. Произнеси только указанную фразу один раз. Без дополнительных слов, повторов, долгих пауз или крика. Чёткое произношение.",
}
STYLE = (
    "Perform this original fictional adult soldier's brief victory bark. "
    "A powerful, deep, chest-resonant male voice, commanding and gritty, "
    "confident after winning a fight. Punchy natural delivery, not singsong. "
    "Sound strong without prolonged screaming or strained distortion. "
    "Say only the supplied line, once. No added words, music, sound effects, "
    "whispering, background ambience, or theatrical reverb. Dry close recording. "
)


def finish_pcm(raw: bytes) -> tuple[bytes, dict]:
    samples = array.array("h")
    samples.frombytes(raw)
    if sys.byteorder != "little":
        samples.byteswap()
    if not samples or len(samples) / RATE > 12:
        raise ValueError("Unexpected speech length")
    peak = max(abs(s) for s in samples)
    if peak < 500:
        raise ValueError("Speech was silent or too quiet")
    # Remove only surrounding silence; retain the attack and a natural short tail.
    threshold = max(100, peak * .008)
    first = next(i for i, s in enumerate(samples) if abs(s) > threshold)
    last = len(samples) - 1 - next(i for i, s in enumerate(reversed(samples)) if abs(s) > threshold)
    samples = samples[max(0, first - int(.035 * RATE)):min(len(samples), last + int(.12 * RATE))]
    scale = (32767 * 10 ** (-6 / 20)) / peak
    head, tail = int(.006 * RATE), int(.025 * RATE)
    for i, sample in enumerate(samples):
        envelope = min(1, i / head, (len(samples) - 1 - i) / tail)
        samples[i] = round(sample * scale * envelope)
    rms = math.sqrt(sum(s * s for s in samples) / len(samples)) / 32768
    meta = {"durationSeconds": round(len(samples) / RATE, 3), "rmsDbfs": round(20 * math.log10(max(rms, 1e-9)), 2), "peakDbfs": -6}
    if sys.byteorder != "little":
        samples.byteswap()
    return samples.tobytes(), meta


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--generate", action="store_true", help="Make at most nine paid speech API requests for missing clips")
    args = parser.parse_args()
    lines = json.loads((ROOT / "shared/kill-voices.json").read_text())
    if not args.generate:
        print(json.dumps({"model": MODEL, "lines": lines}, ensure_ascii=False, indent=2))
        return
    key = os.environ.get("OPENAI_API_KEY")
    if not key:
        raise SystemExit("OPENAI_API_KEY is not configured")
    work = ROOT / "temp/kill-voices"
    work.mkdir(parents=True, exist_ok=True)
    for line in lines:
        output = ROOT / "public" / line["file"].lstrip("/")
        if output.exists():
            print(f"Already generated: {line['id']}", flush=True)
            continue
        payload = {"model": MODEL, "voice": line["voice"], "input": line["text"], "instructions": STYLE + ACCENTS[line["faction"]], "response_format": "pcm"}
        request = urllib.request.Request("https://api.openai.com/v1/audio/speech", data=json.dumps(payload).encode(), headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(request, timeout=90) as response:
                raw = response.read(2 * RATE * 13)
        except urllib.error.HTTPError as error:
            raise SystemExit(f"Speech API failed with HTTP {error.code}; stopped without retries.") from None
        except urllib.error.URLError:
            raise SystemExit("Speech API could not be reached; stopped without retries.") from None
        (work / (line["id"] + ".pcm")).write_bytes(raw)
        pcm, metrics = finish_pcm(raw)
        output.parent.mkdir(parents=True, exist_ok=True)
        with wave.open(str(output), "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(RATE)
            wav.writeframes(pcm)
        record = {**line, "model": MODEL, "instructions": payload["instructions"], "generatedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(), "sha256": hashlib.sha256(output.read_bytes()).hexdigest(), **metrics}
        (work / (line["id"] + ".json")).write_text(json.dumps(record, ensure_ascii=False, indent=2) + "\n")
        print(f"Generated {line['id']}: {metrics['durationSeconds']}s", flush=True)


if __name__ == "__main__":
    main()
