"""Adapt MaX3Dd's officially downloaded CC-BY-4.0 M91 for Bolts.

Blender --background --factory-startup --disable-autoexec --python this.py
Retains the author's UVs, corner normals and PBR atlas. The scope and bayonet
are removed; the sniper bolt is adapted to the infantry's straight handle.
"""
import bpy, json, hashlib, math
from pathlib import Path
from mathutils import Vector, Matrix

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'artifacts/sketchfab-source/mosin_nagant_m91.glb'
OUT = ROOT / 'public/assets/imported-weapons'
UID = '92ede39f23bd40c7982c727dfd7c4be0'
URL = 'https://sketchfab.com/3d-models/mosin-nagant-m91-' + UID
SCALE = 1.232 / (0.7073241472244263 - -0.3397449553012848)
CENTER_X = .000512
BARREL_Z = .1303009689
Z_OFFSET = -1.0997892082 - -.3397449553012848 * SCALE
ORIENT = Matrix(((-1,0,0),(0,0,1),(0,1,0)))
B = Matrix(((1,0,0),(0,0,-1),(0,1,0)))
OFFSET = Vector((CENTER_X*SCALE, .031-BARREL_Z*SCALE, Z_OFFSET))

def game(point): return ORIENT @ Vector(point) * SCALE + OFFSET
def blender(point): return B @ game(point)
TRANSFORM = (B @ ORIENT * SCALE).to_4x4()
TRANSFORM.translation = B @ OFFSET

bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
bpy.ops.import_scene.gltf(filepath=str(SOURCE))
original = {o.name:o for o in bpy.context.scene.objects if o.type=='MESH'}

def components(obj):
    keys={}; ids=[]
    for vertex in obj.data.vertices:
        key=tuple(round(x,5) for x in obj.matrix_world@vertex.co)
        if key not in keys: keys[key]=len(keys)
        ids.append(keys[key])
    parent=list(range(len(keys)))
    def find(i):
        while parent[i]!=i:
            parent[i]=parent[parent[i]]; i=parent[i]
        return i
    for polygon in obj.data.polygons:
        root=find(ids[polygon.vertices[0]])
        for i in polygon.vertices[1:]: parent[find(ids[i])]=root
    groups={}
    for i in range(len(ids)): groups.setdefault(find(ids[i]),[]).append(i)
    return sorted(groups.values(),key=lambda v:-len(v))

def subset(obj, indices, name, material=None):
    keep=set(indices); old=obj.data
    faces=[p for p in old.polygons if all(i in keep for i in p.vertices)]
    used=sorted({i for p in faces for i in p.vertices}); remap={v:i for i,v in enumerate(used)}
    mesh=bpy.data.meshes.new(name)
    mesh.from_pydata([old.vertices[i].co for i in used],[],[[remap[i] for i in p.vertices] for p in faces]); mesh.update()
    for mat in old.materials: mesh.materials.append(material or mat)
    for new,oldface in zip(mesh.polygons,faces):
        new.material_index=oldface.material_index; new.use_smooth=oldface.use_smooth
    for layer in old.uv_layers:
        dst=mesh.uv_layers.new(name=layer.name)
        for new,oldface in zip(mesh.polygons,faces):
            for a,b in zip(new.loop_indices,oldface.loop_indices): dst.data[a].uv=layer.data[b].uv
    mesh.normals_split_custom_set([old.corner_normals[i].vector[:] for p in faces for i in p.loop_indices])
    new=bpy.data.objects.new(name,mesh); bpy.context.collection.objects.link(new)
    new.matrix_world=obj.matrix_world.copy()
    return new

source_material=original['M91_M91_0'].data.materials[0]
metal=source_material.copy(); metal.name='Mosin blued metal — MaX3Dd'
wood=source_material.copy(); wood.name='Mosin walnut — MaX3Dd'
main=original['M91_M91_0']; groups=components(main)
# Source's lower stock and upper wooden handguard. Material separation only;
# their positions, normals and UV islands remain exactly the author's work.
wood_indices=set(groups[0]+groups[9])
static=[subset(main,wood_indices,'source-walnut-stock',wood),
        subset(main,set(range(len(main.data.vertices)))-wood_indices,'source-metal-furniture',metal)]
for name in ['sight_M91_0','sight_adjust_M91_0']:
    static.append(subset(original[name],range(len(original[name].data.vertices)),name,metal))
moving=[subset(original['bolt_M91_0'],range(len(original['bolt_M91_0'].data.vertices)),'source-bolt-body',metal)]

# Keep the source locking sleeve and round bolt knob. Remove the downward
# sniper stem, then bridge the knob horizontally to match the infantry rifle.
# Knob normals and UVs follow a rigid rotation; no stock geometry is deformed.
handle=original['bolt_02_M91_0']
points=[handle.matrix_world@v.co for v in handle.data.vertices]
body=subset(handle,[i for i,p in enumerate(points) if p.x>-.022 and p.z>.1209],'source-bolt-handle-base',metal)
knob=subset(handle,[i for i,p in enumerate(points) if p.z<.0905],'source-bolt-knob',metal)
old_center=Vector((-.029, .351625, .08076))
knob_center=Vector((-.042, .351625, .129))
rotate=Matrix.Rotation(math.pi/2,4,'Y')
knob.matrix_world=Matrix.Translation(knob_center)@rotate@Matrix.Translation(-old_center)@knob.matrix_world
moving.extend([body,knob])

# A modest 32-sided steel shank fills the original neck opening. The source
# knob remains the hand-contact surface and supplies its authored worn finish.
shank_material=bpy.data.materials.new('Mosin straight bolt shank — adaptation')
shank_material.use_nodes=True
shader=shank_material.node_tree.nodes.get('Principled BSDF')
shader.inputs['Base Color'].default_value=(.25,.26,.27,1)
shader.inputs['Metallic'].default_value=.96
shader.inputs['Roughness'].default_value=.36
start=Vector((-.014,.351625,.129)); end=knob_center
bpy.ops.mesh.primitive_cylinder_add(vertices=32,radius=.0037,depth=(end-start).length,location=(start+end)/2)
shank=bpy.context.object; shank.name='infantry-straight-bolt-shank'
shank.rotation_euler=(end-start).to_track_quat('Z','Y').to_euler()
for polygon in shank.data.polygons: polygon.use_smooth=len(polygon.vertices)==4
shank.data.materials.append(shank_material); moving.append(shank)

for obj in original.values(): bpy.data.objects.remove(obj,do_unlink=True)
bpy.context.view_layer.update()
for obj in static+moving:
    matrix=TRANSFORM@obj.matrix_world
    obj.parent=None; obj.matrix_world=Matrix.Identity(4); obj.data.transform(matrix)
for obj in list(bpy.context.scene.objects):
    if obj.type!='MESH': bpy.data.objects.remove(obj,do_unlink=True)

root=bpy.data.objects.new('imported-rifle-russian',None); bpy.context.collection.objects.link(root)
furniture=bpy.data.objects.new('furniture',None); bpy.context.collection.objects.link(furniture); furniture.parent=root
pivot=bpy.data.objects.new('bolt',None); bpy.context.collection.objects.link(pivot); pivot.parent=root
origin=Vector((CENTER_X,.351625,BARREL_Z)); pivot.location=blender(origin)
for obj in static: obj.parent=furniture
for obj in moving:
    obj.data.transform(Matrix.Translation(-pivot.location)); obj.parent=pivot
# Consolidate to one draw per material/animated group, without welding UV or
# normal seams. This preserves the authored metal highlights and wood grain.
for parent in [furniture,pivot]:
    grouped={}
    for obj in list(parent.children): grouped.setdefault(obj.data.materials[0].name,[]).append(obj)
    for material,objects in grouped.items():
        if len(objects)<2: continue
        bpy.ops.object.select_all(action='DESELECT')
        for obj in objects: obj.select_set(True)
        bpy.context.view_layer.objects.active=objects[0]; bpy.ops.object.join()
        objects[0].name=parent.name+'-'+material
bpy.context.view_layer.update()
pts=[obj.matrix_world@v.co for parent in [furniture,pivot] for obj in parent.children for v in obj.data.vertices]
gamepts=[Vector((p.x,p.z,-p.y)) for p in pts]
bpy.ops.object.select_all(action='DESELECT')
for obj in [root,furniture,pivot]+list(furniture.children)+list(pivot.children): obj.select_set(True)
output=OUT/'mosin.glb'
bpy.ops.export_scene.gltf(filepath=str(output),export_format='GLB',use_selection=True,export_yup=True,
    export_materials='EXPORT',export_normals=True,export_texcoords=True,export_animations=False,
    export_extras=False,export_image_format='AUTO')
def point(p): return [round(v,8) for v in game(p)]
front=[CENTER_X,-.31005,.14952056]
# Rear notch lip is at the rear end of the separate tangent sight leaf.
rear=[0.000506475691,0.216822593370,0.149981958516]
profile=dict(faction='russian',model='Mosin–Nagant M1891/30',sourceUid=UID,sourceUrl=URL,
    author='MaX3Dd',license='CC BY 4.0',worldScale=1,nominalLength=1.232,
    bounds=dict(min=[min(p[i] for p in gamepts) for i in range(3)],max=[max(p[i] for p in gamepts) for i in range(3)]),
    muzzle=point([CENTER_X,-.3397449553,BARREL_Z]),frontSight=point(front),rearSight=point(rear),
    sightY=game(rear).y,adsZ=-.015,rightStock=[0,-.0105664,-.18],leftGrip=[0,.0103162,-.5131279],
    bolt=dict(origin=point(origin),knobLocal=list(game(knob_center)-game(origin)),axis=[0,0,1],lift=1.30,travel=.113),
    chargerSeat=point([CENTER_X,.296,.142]))
(OUT/'mosin-profile.json').write_text(json.dumps(profile,indent=2)+'\n')
manifest=dict(model=profile['model'],sourceTitle='Mosin Nagant M91',author='MaX3Dd',sourceUrl=URL,
    license='CC BY 4.0',licenseUrl='https://creativecommons.org/licenses/by/4.0/',officialDownload=SOURCE.name,
    sourceSha256=hashlib.sha256(SOURCE.read_bytes()).hexdigest(),outputSha256=hashlib.sha256(output.read_bytes()).hexdigest(),
    sourceBytes=SOURCE.stat().st_size,outputBytes=output.stat().st_size,uniformScale=SCALE,nominalLengthMetres=1.232,
    removedDisplayExtras=['scope_M91_Scope_0','bayonet_M91_0','Downward sniper bolt stem'],
    triangles=sum(sum(len(p.vertices)-2 for p in obj.data.polygons) for parent in [furniture,pivot] for obj in parent.children),
    modifications=['Uniform physical scale and rigid coordinate normalization',
        'Source wood, receiver, barrel, sights and bolt retain authored UVs, corner normals and PBR atlas',
        'Scope and bayonet removed for infantry M1891/30 configuration',
        'Source bolt sleeve and knob retained; downward sniper stem replaced with a straight infantry shank',
        'Source stock and handguard separated by material for accurate grip contact checks',
        'Moving bolt grouped independently; measured muzzle, sights, charger and bolt-knob anchors'])
(OUT/'mosin-provenance.json').write_text(json.dumps(manifest,indent=2)+'\n')
print('MOSIN_CONVERTED',json.dumps(profile),json.dumps(manifest))
