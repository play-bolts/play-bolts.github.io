#!/usr/bin/env python3
"""Restore the exact licensed material files in provenance.json, or verify offline.

Python standard library only. Existing correct files are never downloaded again.
Usage: python3 scripts/fetch-materials.py [--verify-only]
"""
import argparse
import hashlib
import io
import json
from pathlib import Path
import urllib.request
import zipfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--verify-only', action='store_true')
args = parser.parse_args()
root = Path(__file__).resolve().parents[1] / 'public/assets/materials'
manifest = json.loads((root / 'provenance.json').read_text())
archives = {}
downloaded_bytes = 0


def download(url):
    global downloaded_bytes
    request = urllib.request.Request(url, headers={
        'User-Agent': 'BoltsMaterialRestore/1.0 (CC0 assets; local game, no runtime API)',
    })
    with urllib.request.urlopen(request, timeout=60) as response:
        content = response.read()
    downloaded_bytes += len(content)
    return content


def verified(content, record):
    return (len(content) == record['bytes']
            and hashlib.sha256(content).hexdigest() == record['sha256']
            and ('source_md5' not in record
                 or hashlib.md5(content).hexdigest() == record['source_md5']))


count = 0
for asset in manifest['assets']:
    for record in asset['maps']:
        path = root / record['path']
        if not path.resolve().is_relative_to(root.resolve()):
            raise ValueError('Material path escapes the asset directory')
        if not path.exists() or not verified(path.read_bytes(), record):
            if args.verify_only:
                raise ValueError(f"Missing or changed source file: {record['path']}")
            if 'archive_member' in record:
                archive_record = asset['source_archive']
                url = archive_record['source_url']
                if url not in archives:
                    content = download(url)
                    if not verified(content, archive_record):
                        raise ValueError(f'Source archive checksum changed: {url}')
                    archives[url] = zipfile.ZipFile(io.BytesIO(content))
                content = archives[url].read(record['archive_member'])
            else:
                content = download(record['source_url'])
            if not verified(content, record):
                raise ValueError(f"Source checksum changed: {record['source_url']}")
            path.parent.mkdir(parents=True, exist_ok=True)
            temporary = path.with_suffix('.download')
            temporary.write_bytes(content)
            temporary.replace(path)
        count += 1

for archive in archives.values():
    archive.close()
print(f"Verified {count} original maps, {manifest['total_bytes']:,} shipped bytes; {downloaded_bytes:,} downloaded bytes.")
