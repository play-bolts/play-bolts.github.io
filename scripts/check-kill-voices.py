#!/usr/bin/env python3
"""One-off independent transcription check; results stay in temp/kill-voices.

Uploads only the generated, original game clips, never the target transcript.
Requires OPENAI_API_KEY. Does not run in the app or its test suite.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import urllib.error
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", default="gpt-transcribe")
    args = parser.parse_args()
    key = os.environ.get("OPENAI_API_KEY")
    if not key:
        raise SystemExit("OPENAI_API_KEY is not configured")
    output = ROOT / "temp/kill-voices"
    output.mkdir(parents=True, exist_ok=True)
    for line in json.loads((ROOT / "shared/kill-voices.json").read_text()):
        path = ROOT / "public" / line["file"].lstrip("/")
        audio = path.read_bytes()
        digest = hashlib.sha256(audio).hexdigest()
        report = output / (line["id"] + ".transcript.json")
        if report.exists() and json.loads(report.read_text()).get("sha256") == digest:
            print(f"Already checked: {line['id']}", flush=True)
            continue
        boundary = uuid.uuid4().hex
        body = (f'--{boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n{args.model}\r\n'
                f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{path.name}"\r\nContent-Type: audio/wav\r\n\r\n').encode() + audio + f'\r\n--{boundary}--\r\n'.encode()
        request = urllib.request.Request("https://api.openai.com/v1/audio/transcriptions", data=body, headers={"Authorization": "Bearer " + key, "Content-Type": "multipart/form-data; boundary=" + boundary})
        try:
            with urllib.request.urlopen(request, timeout=90) as response:
                transcript = json.load(response)
        except urllib.error.HTTPError as error:
            raise SystemExit(f"Transcription API failed with HTTP {error.code}; stopped without retries.") from None
        except urllib.error.URLError:
            raise SystemExit("Transcription API could not be reached; stopped without retries.") from None
        report.write_text(json.dumps({"id": line["id"], "model": args.model, "sha256": digest, "text": transcript["text"]}, ensure_ascii=False, indent=2) + "\n")
        print(f"{line['id']}: {transcript['text']}", flush=True)


if __name__ == "__main__":
    main()
