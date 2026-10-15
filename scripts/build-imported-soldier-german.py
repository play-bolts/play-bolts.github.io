"""Fit the official licensed German source to the Bolts continuous skin rig.

Blender --disable-autoexec --factory-startup --background --python
scripts/build-imported-soldier-german.py [-- --preview]
"""
import bpy
import hashlib
import json
import math
import struct
import sys
import tempfile
from array import array
from pathlib import Path
from mathutils import Vector, Matrix, Quaternion

ROOT=Path(__file__).resolve().parents[1]
SOURCE=ROOT/'artifacts/sketchfab-source/soldier-german.glb'
OUT=ROOT/'public/assets/imported-soldiers'
OUT.mkdir(parents=True,exist_ok=True)
SOURCE_HASH='580adb9e5a1c43aca935bcc815ced0cf74434ccb25fbe21f253f4922a1f42f6a'
UID='99ae9a9deb2c46c5956342b3bf9de7a2'
URL='https://sketchfab.com/3d-models/ww2-panzergrenadier-fbx-tpose-cc0-'+UID
NAMES=['pelvis','spine','neck','upperArmL','lowerArmL','handL','upperArmR','lowerArmR','handR','thighL','calfL','footL','thighR','calfR','footR']
FLOOR=-.35964202880859375
TOP=13.879090309143066
SCALE=1.8/(TOP-FLOOR)
source_bytes=SOURCE.read_bytes()
assert hashlib.sha256(source_bytes).hexdigest()==SOURCE_HASH, 'Source changed; inspect before rebuilding'
source_json_size=struct.unpack_from('<I',source_bytes,12)[0]
source_asset=json.loads(source_bytes[20:20+source_json_size])['asset']

def smooth(low,high,value):
    t=max(0,min(1,(value-low)/(high-low)))
    return t*t*(3-2*t)

source={name:Vector(point) for name,point in {'pelvis':(0,.84,0),'spine':(0,.95,0),'neck':(0,1.46,0)}.items()}
target={name:point.copy() for name,point in source.items()}
for sign,side in [(-1,'L'),(1,'R')]:
    # Measured T-pose centres, in metre-scaled game coordinates. Source front
    # is Blender -Y. Bones use negative-X L regardless of source naming.
    source.update({
        'upperArm'+side:Vector((sign*.200,1.411,-.01)),
        'lowerArm'+side:Vector((sign*.470,1.388,-.004)),
        'hand'+side:Vector((sign*.685,1.387,.012)),
        'thigh'+side:Vector((sign*.103,.930,-.015)),
        'calf'+side:Vector((sign*.140,.510,-.008)),
        'foot'+side:Vector((sign*.181,.095,-.014)),
    })
    target.update({
        'upperArm'+side:Vector((sign*.215,1.42,0)),
        'lowerArm'+side:Vector((sign*.215,1.14,0)),
        'hand'+side:Vector((sign*.215,.90,0)),
        'thigh'+side:Vector((sign*.115,.930,0)),
        'calf'+side:Vector((sign*.115,.510,0)),
        'foot'+side:Vector((sign*.115,.095,0)),
    })
rotations={name:Quaternion() for name in NAMES}
for side in ['L','R']:
    for parent,child in [('upperArm','lowerArm'),('lowerArm','hand'),('thigh','calf'),('calf','foot')]:
        a,b=parent+side,child+side
        rotations[a]=(source[b]-source[a]).normalized().rotation_difference((target[b]-target[a]).normalized())
    # Fingers belong to the same neutral wrist orientation as the forearm.
    rotations['hand'+side]=rotations['lowerArm'+side].copy()
    rotations['foot'+side]=Quaternion()

def weights(point,category):
    x,y,z=point
    if category=='helmet':
        return {'neck':1}
    if category=='pouches':
        return {'spine':1}
    side='L' if x<0 else 'R'
    torso=smooth(.79,1.045,y)
    spine=smooth(.91,1.12,y)
    knee=smooth(.435,.585,y)
    ankle=smooth(.105,.25,y)
    # The coat hem crosses the centre line; blend both thigh influences there
    # instead of opening a seam when its two sides follow different legs.
    across=smooth(-.055,.055,x) if y>.77 else (0 if x<0 else 1)
    result={'pelvis':torso*(1-spine),'spine':torso*spine}
    for label,weight in [('L',1-across),('R',across)]:
        result['thigh'+label]=(1-torso)*weight*knee
        result['calf'+label]=(1-torso)*weight*(1-knee)*ankle
        result['foot'+label]=(1-torso)*weight*(1-knee)*(1-ankle)
    neck=smooth(1.42,1.515,y)*(1-smooth(.14,.23,abs(x)))
    result={name:value*(1-neck) for name,value in result.items()}
    result['neck']=neck
    # All source jacket vertices stay connected. Four smooth shoulder/elbow/
    # wrist influences deform the original garment, rather than cutting parts.
    arm=smooth(.17,.275,abs(x))*smooth(1.22,1.30,y)
    elbow=smooth(.420,.525,abs(x))
    wrist=smooth(.635,.705,abs(x))
    result={name:value*(1-arm) for name,value in result.items()}
    result['upperArm'+side]=arm*(1-elbow)
    result['lowerArm'+side]=arm*elbow*(1-wrist)
    result['hand'+side]=arm*elbow*wrist
    ordered=sorted(((name,value) for name,value in result.items() if value>1e-7),key=lambda item:-item[1])[:4]
    total=sum(value for _,value in ordered)
    return {name:value/total for name,value in ordered}

bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
bpy.ops.import_scene.gltf(filepath=str(SOURCE))
meshes=[obj for obj in bpy.context.scene.objects if obj.type=='MESH']
assert len(meshes)==5
surface_changes=[]
material_cache={}
def matte_material(original,role,low,high,metalness=0):
    key=(original.name,role)
    if key in material_cache:
        return material_cache[key]
    material=original.copy()
    material.name='german-'+role
    bsdf=next(node for node in material.node_tree.nodes if node.type=='BSDF_PRINCIPLED')
    def find_image(node,seen=None):
        seen=set() if seen is None else seen
        if node in seen:
            return None
        seen.add(node)
        if node.type=='TEX_IMAGE':
            return node.image
        for socket in node.inputs:
            for link in socket.links:
                image=find_image(link.from_node,seen)
                if image:
                    return image
        return None
    roughness=bsdf.inputs['Roughness']
    image=find_image(roughness.links[0].from_node) if roughness.links else None
    if roughness.links:
        node=roughness.links[0].from_node
        if node.type=='MATH' and node.operation=='MULTIPLY':
            for socket in node.inputs:
                if not socket.links:
                    socket.default_value=1
    if image:
        # The downloaded packed map gives wool the same glossy response as
        # metal. Preserve its local variation and AO, remapping only roughness
        # into each surface's usable range. Colors and sculpted normal folds
        # are untouched; all copied materials share those original images.
        width,height=image.size
        pixels=array('f',[0])*(width*height*4)
        image.pixels.foreach_get(pixels)
        for i in range(0,len(pixels),4):
            pixels[i+1]=low+(high-low)*pixels[i+1]
            pixels[i+2]=1
        remapped=bpy.data.images.new('german-'+role+'-roughness',width=width,height=height,alpha=False)
        remapped.colorspace_settings.name='Non-Color'
        remapped.pixels.foreach_set(pixels)
        remapped.file_format='PNG'
        with tempfile.TemporaryDirectory(prefix='bolts-soldier-material-') as temporary:
            remapped.filepath_raw=str(Path(temporary)/(role+'.png'))
            remapped.save()
            remapped.pack()
        for node in material.node_tree.nodes:
            if node.type=='TEX_IMAGE' and node.image==image:
                node.image=remapped
        roughness.default_value=1
    else:
        roughness.default_value=(low+high)/2
    for link in list(bsdf.inputs['Metallic'].links):
        material.node_tree.links.remove(link)
    bsdf.inputs['Metallic'].default_value=metalness
    surface_changes.append({'sourceMaterial':original.name,'material':material.name,'roughnessRange':[low,high],'metalness':metalness,'baseColorAndNormals':'unaltered source maps'})
    material_cache[key]=material
    return material

source_uv_hashes={}
triangle_count=0
for obj in meshes:
    name=obj.name
    category='helmet' if any(part in name for part in ['helmet','scrim']) else 'pouches' if 'ammopouches' in name else 'body'
    source_uv_hashes[name]=hashlib.sha256(b''.join(struct.pack('<ff',*loop.uv) for layer in obj.data.uv_layers for loop in layer.data)).hexdigest()
    triangle_count+=sum(len(poly.vertices)-2 for poly in obj.data.polygons)
    basis=Matrix(((SCALE,0,0,0),(0,0,SCALE,-FLOOR*SCALE),(0,-SCALE,0,0),(0,0,0,1)))@obj.matrix_world
    obj.parent=None
    obj.matrix_world=Matrix.Identity(4)
    obj.data.transform(basis)
    original_material=obj.data.materials[0]
    if category=='body':
        obj.data.materials.clear()
        for role,low,high in [('wool',.78,.96),('boot-leather',.42,.67),('skin',.63,.82)]:
            obj.data.materials.append(matte_material(original_material,role,low,high))
        for face in obj.data.polygons:
            center=sum((obj.data.vertices[index].co for index in face.vertices),Vector())/len(face.vertices)
            # Classify before T-pose normalization; wrists and collar follow
            # their source UV boundaries closely without changing the atlas.
            face.material_index=1 if center.y<.35 else 2 if (center.y>1.505 and abs(center.x)<.17) or (abs(center.x)>.691 and center.y>1.29) else 0
    else:
        role,low,high,metalness=('equipment-leather',.48,.76,0) if category=='pouches' else ('helmet-wire',.55,.8,.45) if 'wire' in name else ('foliage',.78,.96,0) if 'leaves' in name else ('painted-helmet',.68,.9,.15)
        obj.data.materials[0]=matte_material(original_material,role,low,high,metalness)
    groups={name:obj.vertex_groups.new(name=name) for name in NAMES}
    for vertex in obj.data.vertices:
        point=vertex.co.copy()
        influences=weights(point,category)
        fitted=Vector()
        for bone,weight in influences.items():
            groups[bone].add([vertex.index],weight,'REPLACE')
            fitted+=(rotations[bone]@(point-source[bone])+target[bone])*weight
        vertex.co=fitted
    obj.data.update()
    try:
        bpy.context.view_layer.objects.active=obj
        obj.select_set(True)
        bpy.ops.mesh.customdata_custom_splitnormals_clear()
    except Exception:
        pass
    assert hashlib.sha256(b''.join(struct.pack('<ff',*loop.uv) for layer in obj.data.uv_layers for loop in layer.data)).hexdigest()==source_uv_hashes[name]
    obj.name='german-'+category+'-'+name.replace('main_','')

for obj in list(bpy.context.scene.objects):
    if obj not in meshes:
        bpy.data.objects.remove(obj,do_unlink=True)
armature_data=bpy.data.armatures.new('Bolts German deformation bind')
armature=bpy.data.objects.new('Bolts German deformation bind',armature_data)
bpy.context.collection.objects.link(armature)
bpy.context.view_layer.objects.active=armature
armature.select_set(True)
bpy.ops.object.mode_set(mode='EDIT')
for name in NAMES:
    bone=armature_data.edit_bones.new(name)
    bone.head=target[name]
    bone.tail=target[name]+Vector((0,-.08,0))
bpy.ops.object.mode_set(mode='OBJECT')
for obj in meshes:
    modifier=obj.modifiers.new('Continuous source uniform skin','ARMATURE')
    modifier.object=armature

bpy.ops.object.select_all(action='DESELECT')
armature.select_set(True)
for obj in meshes:
    obj.select_set(True)
output=OUT/'german.glb'
bpy.ops.export_scene.gltf(filepath=str(output),export_format='GLB',use_selection=True,export_yup=False,export_materials='EXPORT',export_normals=True,export_texcoords=True,export_skins=True,export_animations=False)
# Carry the official download metadata into the derivative binary.
payload=output.read_bytes()
json_size=struct.unpack_from('<I',payload,12)[0]
document=json.loads(payload[20:20+json_size])
document['asset']['copyright']='WW2 Panzergrenadier by britdawgmasterfunk; CC BY 4.0'
document['asset']['extras']=dict(source_asset.get('extras',{}))
document['asset']['extras']['adaptation']='Bolts: metre scale, neutral bind pose, authored 15-bone four-weight continuous skin. Source topology, UVs, basecolor and normal maps retained; material-specific roughness remapping and metalness corrections.'
encoded=json.dumps(document,separators=(',',':')).encode()
encoded+=b' '*(-len(encoded)%4)
tail=payload[20+json_size:]
output.write_bytes(struct.pack('<4sII',b'glTF',2,20+len(encoded)+len(tail))+struct.pack('<II',len(encoded),0x4e4f534a)+encoded+tail)
points=[vertex.co for obj in meshes for vertex in obj.data.vertices]
bounds={'min':[min(point[i] for point in points) for i in range(3)],'max':[max(point[i] for point in points) for i in range(3)]}
profile={'faction':'german','sourceUid':UID,'author':'britdawgmasterfunk','sourceUrl':URL,'license':'CC BY 4.0','label':'German Panzergrenadier — britdawgmasterfunk','bonePositions':{name:list(target[name]) for name in NAMES},'boneNames':NAMES,'height':1.80,'bounds':bounds}
(OUT/'german-profile.json').write_text(json.dumps(profile,indent=2)+'\n')
manifest={**{key:profile[key] for key in ['faction','sourceUid','author','sourceUrl','license']},'authorUrl':'https://sketchfab.com/britdawgmasterfunk','licenseUrl':'https://creativecommons.org/licenses/by/4.0/','sourceAssetMetadata':source_asset,'sourceSha256':SOURCE_HASH,'outputSha256':hashlib.sha256(output.read_bytes()).hexdigest(),'sourceBytes':len(source_bytes),'outputBytes':output.stat().st_size,'triangles':triangle_count,'meshes':len(meshes),'joints':len(NAMES),'maximumSkinInfluences':4,'uniformScale':SCALE,'bounds':bounds,'sourceUvHashes':source_uv_hashes,'surfaceChanges':surface_changes,'generator':'scripts/build-imported-soldier-german.py','blender':bpy.app.version_string,'modifications':['Uniformly scaled to1.80m with floor at0; converted to+Y up/+Z forward.','Source T-pose arms fitted into neutral down-arm bind; legs fitted to runtime ankle/hip spacing.','Authored continuous shoulder, elbow, wrist, hip, knee and ankle skin weights, maximum four influences.','Retained all27,004source triangles, UV coordinates and original1K/512basecolor/normal textures.','Material-specific roughness remapping and metalness correct glossy source wool/skin/leather; color and normal maps unchanged.','Head, helmet and foliage retain source geometry and proportions; rigid head attachment with blended neck.'],'licenseNote':'Source title contains CC0, but official downloadable asset metadata specifies CC-BY-4.0; retain attribution under that explicit license.'}
(OUT/'german-provenance.json').write_text(json.dumps(manifest,indent=2)+'\n')
assert triangle_count==27004
assert output.stat().st_size<25*1024*1024, 'Optimize texture encoding before shipping'
print('GERMAN_OUTPUT',json.dumps(manifest))

if '--preview' in sys.argv:
    preview=ROOT/'artifacts/soldier-candidates/german'
    scene=bpy.context.scene
    scene.render.engine='CYCLES'
    scene.cycles.device='CPU'
    scene.cycles.samples=24
    scene.render.resolution_x=1000
    scene.render.resolution_y=1200
    scene.render.resolution_percentage=100
    scene.render.image_settings.file_format='PNG'
    scene.world.use_nodes=True
    scene.world.node_tree.nodes['Background'].inputs['Color'].default_value=(.18,.21,.24,1)
    scene.world.node_tree.nodes['Background'].inputs['Strength'].default_value=.45
    center=Vector((0,.9,0))
    def point_camera(obj,target):
        direction=(target-obj.location).normalized()
        right=direction.cross(Vector((0,1,0))).normalized()
        up=right.cross(direction).normalized()
        obj.rotation_euler=Matrix((right,up,-direction)).transposed().to_euler()
    for i,(location,power) in enumerate([((2.5,3.5,4),300),((-2,2,3),180),((1,3,-3),240)]):
        light=bpy.data.lights.new('Studio'+str(i),'AREA')
        light.energy=power
        light.shape='DISK'
        light.size=2.0
        obj=bpy.data.objects.new(light.name,light)
        scene.collection.objects.link(obj)
        obj.location=location
        point_camera(obj,center)
    camera_data=bpy.data.cameras.new('Preview camera')
    camera=bpy.data.objects.new(camera_data.name,camera_data)
    scene.collection.objects.link(camera)
    scene.camera=camera
    camera_data.type='ORTHO'
    camera_data.ortho_scale=2.1
    for label,location in [('bind-front',(0,.9,4)),('bind-side',(3,.95,2))]:
        camera.location=location
        point_camera(camera,center)
        scene.render.filepath=str(preview/(label+'.png'))
        bpy.ops.render.render(write_still=True)
