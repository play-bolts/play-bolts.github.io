"""Normalize the licensed Sketchfab grenade without altering its UVs or shape.

Blender --disable-autoexec --background --python scripts/build-grenade-model.py
Optional arguments after --: --source PATH --output PATH --preview PATH
"""
import argparse
from array import array
import hashlib
import json
import math
from pathlib import Path
import struct
import sys
import tempfile

import bpy
from mathutils import Matrix, Vector

ROOT = Path(__file__).resolve().parents[1]
SOURCE_HASH = 'eff2195fa645177ec86f532f8371eed375e30aaa4af4025ad4882580ca1741ce'
SOURCE_URL = 'https://sketchfab.com/3d-models/stielhandgranate-german-grenade-c49ce26939d64641afac1175a8d62338'
parser = argparse.ArgumentParser()
parser.add_argument('--source', type=Path, default=ROOT/'artifacts/sketchfab-source/stielhandgranate.glb')
parser.add_argument('--output', type=Path, default=ROOT/'public/assets/models/imported-stielhandgranate.glb')
parser.add_argument('--preview', type=Path)
args = parser.parse_args(sys.argv[sys.argv.index('--')+1:] if '--' in sys.argv else [])


def sha(data):
    return hashlib.sha256(data).hexdigest()


def glb_parts(data):
    if data[:4] != b'glTF' or struct.unpack_from('<I', data, 4)[0] != 2:
        raise ValueError('Expected glTF 2 binary source')
    size, kind = struct.unpack_from('<II', data, 12)
    if kind != 0x4e4f534a:
        raise ValueError('Missing GLB JSON chunk')
    return json.loads(data[20:20+size]), data[20+size:]


def patch_asset_metadata(path, original):
    data = path.read_bytes()
    doc, tail = glb_parts(data)
    doc['asset']['copyright'] = 'Stielhandgranate - German Grenade by Janovich, CC BY 4.0'
    doc['asset']['extras'] = dict(original.get('extras', {}))
    doc['asset']['extras']['conversion'] = 'Bolts: orientation/scale/grip normalization; 2K base color and 1K normal/metallic-roughness textures. Original geometry and UV layout preserved.'
    encoded = json.dumps(doc, separators=(',', ':')).encode('utf8')
    encoded += b' ' * (-len(encoded) % 4)
    total = 12+8+len(encoded)+len(tail)
    path.write_bytes(struct.pack('<4sII', b'glTF', 2, total)+struct.pack('<II', len(encoded), 0x4e4f534a)+encoded+tail)
    return doc


def encoded_image_size(data):
    if data.startswith(b'\x89PNG\r\n\x1a\n'):
        return list(struct.unpack_from('>II', data, 16))
    if data.startswith(b'\xff\xd8'):
        offset = 2
        while offset < len(data):
            if data[offset] != 0xff:
                raise ValueError('Invalid JPEG marker')
            while data[offset] == 0xff:
                offset += 1
            marker = data[offset]
            offset += 1
            if marker in (0x01, 0xd8, 0xd9) or 0xd0 <= marker <= 0xd7:
                continue
            length = struct.unpack_from('>H', data, offset)[0]
            if marker in (0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf):
                height, width = struct.unpack_from('>HH', data, offset+3)
                return [width, height]
            offset += length
    raise ValueError('Unable to inspect exported image dimensions')


source_bytes = args.source.read_bytes()
if sha(source_bytes) != SOURCE_HASH:
    raise ValueError('Unexpected source GLB hash; inspect and update provenance before converting')
source_doc, _ = glb_parts(source_bytes)
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
bpy.ops.import_scene.gltf(filepath=str(args.source.resolve()))
meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH']
if len(meshes) != 4:
    raise ValueError('Source assembly changed: expected four mesh components')
reference = meshes[0].matrix_world.copy()
if any(max(abs(o.matrix_world[i][j]-reference[i][j]) for i in range(4) for j in range(4)) > 1e-5 for o in meshes):
    raise ValueError('Components no longer share a common source frame')

# Blender imports glTF coordinates as (x, -z, y). The original grenade's
# unposed local +Z is its handle/canister axis. Remove the display-root rotation
# and orient that axis along Blender +Z, which exports as runtime glTF +Y.
axis_rotation = Matrix.Rotation(-math.pi/2, 4, 'X')
source_points = [axis_rotation @ v.co for o in meshes for v in o.data.vertices]
low, high = min(p.z for p in source_points), max(p.z for p in source_points)
scale = .38/(high-low)
grip = low+.126/scale
transform = Matrix.Translation((0, 0, -grip*scale)) @ Matrix.Scale(scale, 4) @ axis_rotation
uv_hashes = {}
triangles = 0
for obj in meshes:
    old_name = obj.name
    uv_hashes[old_name] = sha(b''.join(struct.pack('<ff', *loop.uv) for layer in obj.data.uv_layers for loop in layer.data))
    triangles += sum(len(p.vertices)-2 for p in obj.data.polygons)
    obj.parent = None
    obj.matrix_world = Matrix.Identity(4)
    obj.data.transform(transform)
    obj.data.update()
    after = sha(b''.join(struct.pack('<ff', *loop.uv) for layer in obj.data.uv_layers for loop in layer.data))
    if after != uv_hashes[old_name]:
        raise ValueError('UV coordinates changed during normalization')
    obj.name = ('wooden-handle' if old_name.startswith('handle_') else
                'pull-cap' if old_name.startswith('bottom_') else
                'pull-cap-lid' if old_name.startswith('Lid_') else 'canister')

# Remove the source's display nodes while keeping its material assignments.
for obj in list(bpy.context.scene.objects):
    if obj not in meshes:
        bpy.data.objects.remove(obj, do_unlink=True)
root = bpy.data.objects.new('imported-grenade', None)
furniture = bpy.data.objects.new('furniture', None)
bpy.context.scene.collection.objects.link(root)
bpy.context.scene.collection.objects.link(furniture)
furniture.parent = root
for obj in meshes:
    obj.parent = furniture
root['source'] = SOURCE_URL
root['author'] = 'Janovich (https://sketchfab.com/janovich3D)'
root['license'] = 'CC-BY-4.0'
root['grip'] = [0., 0., 0.]
root['movementOnly'] = True

material = meshes[0].data.materials[0]
if any(len(o.data.materials) != 1 or o.data.materials[0] != material for o in meshes):
    raise ValueError('Source material assignment changed')
images = [n.image for n in material.node_tree.nodes if n.type == 'TEX_IMAGE']
if len(set(images)) != 3:
    raise ValueError('Expected base color, metallic-roughness and normal textures')
textures = []
with tempfile.TemporaryDirectory(prefix='bolts-grenade-') as tmp:
    for image in images:
        role = 'basecolor' if image.colorspace_settings.name == 'sRGB' else ('normal' if image.name == 'Image_2' else 'metallic-roughness')
        target = 2048 if role == 'basecolor' else 1024
        original_size = list(image.size)
        image.scale(target, target)
        # Imported images retain their original packed byte payload. Merely
        # scaling/saving that datablock lets the exporter reuse the 4K bytes.
        # A fresh datablock owns only the resized pixels, preventing that path.
        pixels = array('f', [0.0]) * (target*target*4)
        image.pixels.foreach_get(pixels)
        resized = bpy.data.images.new(role, width=target, height=target, alpha=False)
        resized.colorspace_settings.name = image.colorspace_settings.name
        resized.pixels.foreach_set(pixels)
        resized.file_format = 'JPEG' if role == 'basecolor' else 'PNG'
        resized.filepath_raw = str(Path(tmp)/(role+('.jpg' if role == 'basecolor' else '.png')))
        resized.save()
        resized.pack()
        for node in material.node_tree.nodes:
            if node.type == 'TEX_IMAGE' and node.image == image:
                node.image = resized
        textures.append({'role': role, 'sourceSize': original_size, 'size': list(resized.size), 'format': resized.file_format, 'colorSpace': resized.colorspace_settings.name})
    args.output.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.object.select_all(action='SELECT')
    bpy.context.view_layer.objects.active = root
    bpy.ops.export_scene.gltf(filepath=str(args.output.resolve()), export_format='GLB', use_selection=True,
                             export_extras=True, export_animations=False, export_yup=True,
                             export_normals=True, export_tangents=True, export_texcoords=True,
                             export_materials='EXPORT', export_image_format='AUTO', export_jpeg_quality=90)

export_doc = patch_asset_metadata(args.output, source_doc['asset'])
_, binary_chunk = glb_parts(args.output.read_bytes())
binary_payload = binary_chunk[8:]
for encoded in export_doc['images']:
    view = export_doc['bufferViews'][encoded['bufferView']]
    start = view.get('byteOffset', 0)
    data = binary_payload[start:start+view['byteLength']]
    texture = next(t for t in textures if t['role'] == encoded['name'])
    actual_size = encoded_image_size(data)
    if actual_size != texture['size']:
        raise ValueError(f"Exporter embedded an incorrect texture size: {encoded['name']} {actual_size}")
    texture['embeddedBytes'] = len(data)
    texture['embeddedSha256'] = sha(data)
if args.output.stat().st_size > 8*1024*1024:
    raise ValueError('Runtime payload exceeds the expected optimization budget')


def game_point(p):
    return [round(p.x, 8), round(p.z, 8), round(-p.y, 8)]


points = [game_point(v.co) for o in meshes for v in o.data.vertices]
bounds = {'min': [min(p[i] for p in points) for i in range(3)], 'max': [max(p[i] for p in points) for i in range(3)]}
canister = next(o for o in meshes if o.name == 'canister')
canister_points = [game_point(v.co) for v in canister.data.vertices]
canister_bounds = {'min': [min(p[i] for p in canister_points) for i in range(3)], 'max': [max(p[i] for p in canister_points) for i in range(3)]}
output_bytes = args.output.read_bytes()
manifest = {
    'schemaVersion': 1, 'title': 'Stielhandgranate - German Grenade',
    'author': 'Janovich', 'authorUrl': 'https://sketchfab.com/janovich3D',
    'source': SOURCE_URL, 'sourceUid': 'c49ce26939d64641afac1175a8d62338',
    'license': 'CC-BY-4.0', 'licenseUrl': 'https://creativecommons.org/licenses/by/4.0/',
    'sourceBytes': len(source_bytes), 'sourceSha256': SOURCE_HASH,
    'output': args.output.name, 'outputBytes': len(output_bytes), 'outputSha256': sha(output_bytes),
    'generator': 'scripts/build-grenade-model.py', 'blender': bpy.app.version_string,
    'triangles': triangles, 'meshes': len(meshes), 'materials': 1, 'animations': 0,
    'axis': '+Y from handle to canister', 'grip': [0, 0, 0], 'muzzle': None,
    'bounds': bounds, 'canisterBounds': canister_bounds,
    'canisterCenter': [0, round((canister_bounds['min'][1]+canister_bounds['max'][1])/2, 8), 0],
    'uniformScaleFromSourceMesh': scale, 'gripHeightInSourceMesh': grip,
    'textures': textures, 'sourceImportedUvHashes': uv_hashes,
    'changes': ['Removed source presentation rotation and normalized the shared mesh frame.',
                'Uniformly scaled to 0.38 m overall, with grip at the origin and bottom at -0.126 m.',
                'Resampled original base color to 2K and original normal/metallic-roughness maps to 1K.',
                'Preserved all 3,688 source triangles, UV layout, component assembly and PBR map roles.',
                'Renamed hierarchy for runtime furniture attachment; retained creator/license metadata.'],
    'gameplay': 'Static carried movement-only item; no throwing or explosive behavior is introduced.',
}
manifest_path = args.output.with_suffix('.provenance.json')
manifest_path.write_text(json.dumps(manifest, indent=2)+'\n')
print(json.dumps(manifest, indent=2), flush=True)

if args.preview:
    scene = bpy.context.scene
    scene.render.engine = 'CYCLES'
    scene.cycles.device = 'CPU'
    scene.cycles.samples = 32
    scene.cycles.use_denoising = True
    scene.render.resolution_x = 800
    scene.render.resolution_y = 1000
    scene.render.resolution_percentage = 100
    scene.world.use_nodes = True
    scene.world.node_tree.nodes['Background'].inputs['Color'].default_value = (.13, .15, .16, 1)
    scene.world.node_tree.nodes['Background'].inputs['Strength'].default_value = .6
    for name, position, power, size in [('key', (-.4, -.55, .6), 35, .65), ('fill', (.5, -.25, .3), 12, .55), ('rim', (.1, .5, .5), 35, .5)]:
        data = bpy.data.lights.new(name, 'AREA')
        data.energy = power
        data.size = size
        obj = bpy.data.objects.new(name, data)
        scene.collection.objects.link(obj)
        obj.location = position
        obj.rotation_euler = (Vector((0, 0, .06))-obj.location).to_track_quat('-Z', 'Y').to_euler()
    camera = bpy.data.objects.new('preview-camera', bpy.data.cameras.new('preview-camera'))
    scene.collection.objects.link(camera)
    camera.location = (.24, -.72, .26)
    camera.rotation_euler = (Vector((0, 0, .064))-camera.location).to_track_quat('-Z', 'Y').to_euler()
    camera.data.lens = 70
    scene.camera = camera
    scene.render.filepath = str(args.preview.resolve())
    args.preview.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.render.render(write_still=True)
