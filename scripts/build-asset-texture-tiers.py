#!/usr/bin/env python3
"""Build downloadable GLB texture variants without changing model data.

Run: python3 scripts/build-asset-texture-tiers.py (requires Pillow).
Originals and license/provenance files stay untouched. Only embedded image
payloads, their MIME types and buffer offsets/lengths may differ. The manifest
records exact source/output hashes, decoded dimensions and RGBA8+mip estimates.
"""
from pathlib import Path
from PIL import Image
import hashlib
import io
import json
import struct

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / 'public/assets'
FILES = ([f'imported-soldiers/{faction}.glb' for faction in ['british', 'russian', 'german']]
         + [f'imported-weapons/{rifle}.glb' for rifle in ['enfield', 'mosin', 'kar98k']]
         + ['models/imported-stielhandgranate.glb'])
# First-person rifle color keeps twice the world-character resolution. Data
# textures remain lossless after resizing; alpha imagery retains its channels.
LIMITS = {'low': {'soldier': (256, 128), 'weapon': (512, 256)},
          'medium': {'soldier': (512, 256), 'weapon': (1024, 512)}}


def mip_bytes(width, height):
    total = 0
    while True:
        total += width * height * 4
        if width == height == 1:
            return total
        width, height = max(1, width // 2), max(1, height // 2)


def read_glb(raw):
    magic, version, length = struct.unpack_from('<4sII', raw)
    assert magic == b'glTF' and version == 2 and length == len(raw)
    document, binary = None, None
    offset = 12
    while offset < len(raw):
        size, kind = struct.unpack_from('<I4s', raw, offset)
        chunk = raw[offset + 8:offset + 8 + size]
        if kind == b'JSON':
            document = json.loads(chunk)
        elif kind == b'BIN\0':
            binary = chunk
        else:
            raise ValueError(f'Unsupported GLB chunk {kind!r}')
        offset += size + 8
    assert document is not None and binary is not None
    assert len(document['buffers']) == 1
    return document, binary


def build(path, tier):
    raw = (ASSETS / path).read_bytes()
    document, binary = read_glb(raw)
    colors = set()
    for material in document.get('materials', []):
        for slot in [material.get('pbrMetallicRoughness', {}).get('baseColorTexture'), material.get('emissiveTexture')]:
            if slot:
                colors.add(document['textures'][slot['index']]['source'])
    replacements, images = {}, []
    family = 'soldier' if path.startswith('imported-soldiers/') else 'weapon'
    for index, entry in enumerate(document.get('images', [])):
        view = document['bufferViews'][entry['bufferView']]
        start = view.get('byteOffset', 0)
        original = binary[start:start + view['byteLength']]
        with Image.open(io.BytesIO(original)) as source:
            source_size = list(source.size)
            limit = LIMITS[tier][family][0 if index in colors else 1]
            if max(source.size) <= limit:
                resized, dimensions = original, list(source.size)
            else:
                image = source.convert('RGBA' if 'A' in source.getbands() or 'transparency' in source.info else 'RGB')
                image.thumbnail((limit, limit), Image.Resampling.LANCZOS)
                encoded = io.BytesIO()
                if entry.get('mimeType') == 'image/jpeg' and index in colors:
                    image.convert('RGB').save(encoded, format='JPEG', quality=92, subsampling=0, optimize=True)
                    entry['mimeType'] = 'image/jpeg'
                else:
                    image.save(encoded, format='PNG', compress_level=6)
                    entry['mimeType'] = 'image/png'
                resized, dimensions = encoded.getvalue(), list(image.size)
        replacements[entry['bufferView']] = resized
        images.append(dict(index=index, dimensions=dimensions, sourceDimensions=source_size,
                           bytes=len(resized), mimeType=entry['mimeType'], role='color' if index in colors else 'data',
                           rgba8MipBytes=mip_bytes(*dimensions), sourceRgba8MipBytes=mip_bytes(*source_size)))
    payload = bytearray()
    for index, view in enumerate(document['bufferViews']):
        payload += b'\0' * (-len(payload) % 4)
        start = view.get('byteOffset', 0)
        data = replacements.get(index, binary[start:start + view['byteLength']])
        view['byteOffset'], view['byteLength'] = len(payload), len(data)
        payload.extend(data)
    document['buffers'][0]['byteLength'] = len(payload)
    encoded = json.dumps(document, separators=(',', ':')).encode()
    encoded += b' ' * (-len(encoded) % 4)
    payload += b'\0' * (-len(payload) % 4)
    result = (struct.pack('<4sII', b'glTF', 2, 28 + len(encoded) + len(payload))
              + struct.pack('<I4s', len(encoded), b'JSON') + encoded
              + struct.pack('<I4s', len(payload), b'BIN\0') + payload)
    target = ASSETS / 'tiers' / tier / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(result)
    print(f'{tier:6} {path:43} {len(raw):>10,} -> {len(result):>10,}')
    return dict(path=path, tier=tier, sourceBytes=len(raw), bytes=len(result),
                sourceSha256=hashlib.sha256(raw).hexdigest(), sha256=hashlib.sha256(result).hexdigest(),
                images=images, rgba8MipBytes=sum(image['rgba8MipBytes'] for image in images))


if __name__ == '__main__':
    records = [build(path, tier) for tier in LIMITS for path in FILES]
    manifest = dict(schema=1, generator='scripts/build-asset-texture-tiers.py',
                    note='Image-only derivatives; original model licenses/provenance remain alongside high-tier GLBs. RGBA8 mip totals are estimates, not measured GPU memory.',
                    limits=LIMITS, assets=records)
    (ASSETS / 'tiers/manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
