"""Restore the original CC-BY irises on the retained British eyeballs.

The removed corneal shells and underlying eyes have identical source UVs.
Reuse their embedded JPEGs unchanged; do not duplicate translucent geometry.
Run after build-imported-soldiers.py/texture packing from the repository root.
"""
from pathlib import Path
from io import BytesIO
import hashlib
import json
import struct
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'artifacts/sketchfab-source/soldier-british.glb'
OUTPUT = ROOT / 'public/assets/imported-soldiers/british.glb'
PROVENANCE = OUTPUT.with_name('british-provenance.json')


def read_glb(path):
    raw = path.read_bytes()
    size = struct.unpack_from('<I', raw, 12)[0]
    document = json.loads(raw[20:20 + size])
    return document, bytearray(raw[28 + size:])


source, source_bin = read_glb(SOURCE)
document, buffer = read_glb(OUTPUT)
manifest = json.loads(PROVENANCE.read_text())
assert hashlib.sha256(SOURCE.read_bytes()).hexdigest() == manifest['sourceSha256']
manifest['eyeTextureSources'] = []
for side in ['L', 'R']:
    material = next(m for m in source['materials'] if m.get('name') == f'Std_Cornea_{side}.001')
    texture = source['textures'][material['pbrMetallicRoughness']['baseColorTexture']['index']]
    image = source['images'][texture['source']]
    view = source['bufferViews'][image['bufferView']]
    start = view.get('byteOffset', 0)
    payload = source_bin[start:start + view['byteLength']]
    manifest['eyeTextureSources'].append({'material': f'Std_Eye_{side}.001', 'sourceMaterial': material['name'], 'sha256': hashlib.sha256(payload).hexdigest()})
    name = f'original-british-iris-{side}'
    found = next((i for i, im in enumerate(document['images']) if im.get('name') == name), None)
    if found is None:
        buffer.extend(b'\0' * (-len(buffer) % 4))
        document['bufferViews'].append({'buffer': 0, 'byteOffset': len(buffer), 'byteLength': len(payload)})
        buffer.extend(payload)
        found = len(document['images'])
        document['images'].append({'name': name, 'bufferView': len(document['bufferViews']) - 1, 'mimeType': image['mimeType']})
        manifest['embeddedTextures'].append({'name': name, 'dimensions': list(Image.open(BytesIO(payload)).size), 'mimeType': image['mimeType'], 'bytes': len(payload)})
    texture_id = next((i for i, t in enumerate(document['textures']) if t.get('source') == found), None)
    if texture_id is None:
        texture_id = len(document['textures'])
        document['textures'].append({'source': found})
    target = next(m for m in document['materials'] if m.get('name') == f'Std_Eye_{side}.001')
    target['pbrMetallicRoughness'].update(baseColorTexture={'index': texture_id}, metallicFactor=0, roughnessFactor=.45)

buffer.extend(b'\0' * (-len(buffer) % 4))
document['buffers'][0]['byteLength'] = len(buffer)
encoded = json.dumps(document, separators=(',', ':')).encode()
encoded += b' ' * (-len(encoded) % 4)
result = struct.pack('<III', 0x46546c67, 2, 28 + len(encoded) + len(buffer)) + struct.pack('<II', len(encoded), 0x4e4f534a) + encoded + struct.pack('<II', len(buffer), 0x004e4942) + buffer
OUTPUT.write_bytes(result)
note = 'Original iris/pupil JPEGs restored unchanged from removed corneal shells onto retained eyeballs with identical UV coordinates; no geometry added.'
if note not in manifest['modifications']:
    manifest['modifications'].append(note)
manifest.update(outputSha256=hashlib.sha256(result).hexdigest(), outputBytes=len(result), eyeTextureRepairGenerator='scripts/restore-british-eye-maps.py')
PROVENANCE.write_text(json.dumps(manifest, indent=2) + '\n')
print(f'Restored two original eye maps; {len(result)} byte British model.')
