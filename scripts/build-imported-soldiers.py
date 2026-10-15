"""Retarget official CC-BY soldier surfaces to Bolts' continuous skin rig.

Blender --background --factory-startup --disable-autoexec --python this.py
-- british|russian|german. Source archive stays untouched. No source game rip.
"""
import bpy,bmesh,sys,json,math,hashlib
from pathlib import Path
from mathutils import Vector,Matrix,Quaternion
ROOT=Path(__file__).resolve().parents[1];FACTION=sys.argv[sys.argv.index('--')+1]
OUT=ROOT/'public/assets/imported-soldiers';OUT.mkdir(parents=True,exist_ok=True)
SOURCE=ROOT/'artifacts/sketchfab-source'/f'soldier-{FACTION}.glb'
NAMES=['pelvis','spine','neck','upperArmL','lowerArmL','handL','upperArmR','lowerArmR','handR','thighL','calfL','footL','thighR','calfR','footR']
SPEC={'british':dict(uid='9af571fa416546f08dfc2ba95e604083',author='patromes',slug='wwii-british-soldier',label='British battledress — patromes',floor=-.028885,top=1.814663,headYaw=.325)}
cfg=SPEC[FACTION];scale=1.80/(cfg['top']-cfg['floor'])
bpy.ops.object.select_all(action='SELECT');bpy.ops.object.delete(use_global=False);bpy.ops.import_scene.gltf(filepath=str(SOURCE))
original=[o for o in bpy.context.scene.objects if o.type=='MESH'];keep=[];removed=[]
# Outer cornea shells carry the source iris textures, while the underlying
# eyeballs share their exact UVs. Retain the maps when discarding those shells.
eye_materials={int(o.name.split('_')[-1]):o.data.materials[0] for o in original if int(o.name.split('_')[-1]) in [2,3]}
# Game coordinates are +Y up, +Z facing. Source Blender front is -Y.
def game(p):return Vector((p.x*scale,(p.z-cfg['floor'])*scale,-p.y*scale))
def blend(a,b,t):return a+(b-a)*t
def smooth(a,b,x):
 t=max(0,min(1,(x-a)/(b-a)));return t*t*(3-2*t)
# Source landmarks are measured on the acquired posed mesh. These are authored
# bind landmarks, not guessed source skeleton names (the GLB has no skeleton).
source={'pelvis':Vector((0,.84,0)),'spine':Vector((0,.95,0)),'neck':Vector((0,1.46,0))}
target={'pelvis':Vector((0,.84,0)),'spine':Vector((0,.95,0)),'neck':Vector((0,1.46,0))}
for side,label in [(-1,'L'),(1,'R')]:
 # Acquired mesh is asymmetrically posed. Cross-section centers locate the
 # pivots inside its sleeves and gaiters rather than in front of the limbs.
 measured={'L':{'upperArm':(-.202,1.447,-.089),'lowerArm':(-.243,1.179,-.125),'hand':(-.266,.942,-.078),'thigh':(-.092,.934,-.015),'calf':(-.083,.509,-.090),'foot':(-.079,.095,-.101)},
           'R':{'upperArm':(.206,1.447,-.065),'lowerArm':(.246,1.179,-.090),'hand':(.260,.942,.003),'thigh':(.095,.934,-.014),'calf':(.111,.509,-.035),'foot':(.190,.095,-.057)}}
 source.update({name+label:Vector(point)for name,point in measured[label].items()})
 target.update({f'upperArm{label}':Vector((side*.215,1.447,0)),f'lowerArm{label}':Vector((side*.215,1.167,0)),f'hand{label}':Vector((side*.215,.927,0)),f'thigh{label}':Vector((side*.115,.930,0)),f'calf{label}':Vector((side*.115,.510,0)),f'foot{label}':Vector((side*.115,.095,0))})
nextbone={f'{a}{s}':f'{b}{s}' for s in ['L','R']for a,b in [('upperArm','lowerArm'),('lowerArm','hand'),('thigh','calf'),('calf','foot')]}
rotations={name:Quaternion()for name in NAMES}
for name,child in nextbone.items():rotations[name]=(source[child]-source[name]).normalized().rotation_difference((target[child]-target[name]).normalized())
for side in ['L','R']:rotations['hand'+side]=rotations['lowerArm'+side].copy()
rotations['neck']=Quaternion((0,1,0),cfg['headYaw'])

def weights(p,category):
 side='L'if p.x<0 else'R'
 if category=='head':return {'neck':1}
 if category=='hand':
  cuff=smooth(.935,.995,p.y)
  return {'hand'+side:1-cuff,'lowerArm'+side:cuff}
 if category=='foot':
  t=smooth(.13,.245,p.y);return {'foot'+side:1-t,'calf'+side:t}
 if category=='legs':
  hip=smooth(.80,1.045,p.y)
  knee=smooth(.435,.585,p.y)
  return {'spine':hip*.3,'pelvis':hip*.7,'thigh'+side:(1-hip)*knee,'calf'+side:(1-hip)*(1-knee)}
 # Continuous shoulder and elbow gradients replace the visible rigid seams.
 # Low cuffs are still sleeves: a height gate here pins them to the torso
 # when the elbow bends and leaves the bare wrist exposed above the gun.
 arm=smooth(.145,.205,abs(p.x))
 elbow=smooth(1.105,1.24,p.y)
 hip=1-smooth(.91,1.10,p.y)
 return {'pelvis':(1-arm)*hip,'spine':(1-arm)*(1-hip),'upperArm'+side:arm*elbow,'lowerArm'+side:arm*(1-elbow)}

def category(obj):
 n=int(obj.name.split('_')[-1])
 if n in [2,3,4,5,6,11,28,29,30]:return 'head'
 if n in [8,9]:return 'hand'
 if n in [24,25,26,27]:return 'foot'
 if n==31 or n==20:return 'legs'
 return 'torso'
for obj in original:
 n=int(obj.name.split('_')[-1])
 if n in [2,3,7,12,13,14,21,22,23]:removed.append(obj.name);continue
 if n in [4,5]:
  eye=obj.data.materials[0];eye.use_nodes=True
  image=next(node.image for node in eye_materials[n-2].node_tree.nodes if node.type=='TEX_IMAGE'and node.image)
  texture=eye.node_tree.nodes.new('ShaderNodeTexImage');texture.image=image
  bsdf=next(node for node in eye.node_tree.nodes if node.type=='BSDF_PRINCIPLED')
  eye.node_tree.links.new(texture.outputs['Color'],bsdf.inputs['Base Color'])
  bsdf.inputs['Metallic'].default_value=0;bsdf.inputs['Roughness'].default_value=.45
 # Hidden nude skin beneath garments only increases overdraw and clipping.
 if n in [8,9,10]:
  bm=bmesh.new();bm.from_mesh(obj.data)
  for v in bm.verts:v.co=obj.matrix_world@v.co
  drop=[f for f in bm.faces if (max(v.co.z for v in f.verts)<1.50 if n==10 else min(v.co.z for v in f.verts)>.98 or max(v.co.z for v in f.verts)<.65)]
  bmesh.ops.delete(bm,geom=drop,context='FACES');bm.to_mesh(obj.data);bm.free();obj.matrix_world=Matrix.Identity(4)
  if not obj.data.polygons:removed.append(obj.name);continue
  if n==10:cat='head'
  else:cat=category(obj)
 else:cat=category(obj)
 original_world=obj.matrix_world.copy();obj.parent=None;obj.matrix_world=Matrix.Identity(4)
 # Convert positions and normals in one rigid+uniform basis first.
 M=Matrix(((scale,0,0,0),(0,0,scale,-cfg['floor']*scale),(0,-scale,0,0),(0,0,0,1)))@original_world
 obj.data.transform(M)
 # The acquired GLB stores most triangles with duplicate coincident vertices.
 # Weld position duplicates while preserving per-corner UVs before assigning
 # smooth normals/weights, reducing buffers without deleting any source faces.
 bm=bmesh.new();bm.from_mesh(obj.data)
 bmesh.ops.remove_doubles(bm,verts=list(bm.verts),dist=.0000005)
 bm.to_mesh(obj.data);bm.free()
 groups={name:obj.vertex_groups.new(name=name)for name in NAMES};coords=[]
 for vertex in obj.data.vertices:
  p=vertex.co.copy();ws={n:w for n,w in weights(p,cat).items()if w>1e-7}
  # A maximum of four influences matches WebGL skinning and preserves sums.
  ordered=sorted(ws.items(),key=lambda item:-item[1])[:4];total=sum(w for _,w in ordered)
  q=Vector()
  for name,w in ordered:
   w/=total;groups[name].add([vertex.index],w,'REPLACE');q+=(rotations[name]@(p-source[name])+target[name])*w
  vertex.co=q;coords.append(q)
 # Moving source geometry changes normals; recomputing smooth normals retains
 # the sculpted folds and avoids seams at the newly weighted joints.
 for poly in obj.data.polygons:poly.use_smooth=True
 try:bpy.context.view_layer.objects.active=obj;obj.select_set(True);bpy.ops.mesh.customdata_custom_splitnormals_clear()
 except Exception:pass
 # Source helmet was effectively chrome; wartime painted steel is matte.
 if n==28:
  for mat in obj.data.materials:
   if not mat.use_nodes:continue
   bsdf=next((n for n in mat.node_tree.nodes if n.type=='BSDF_PRINCIPLED'),None)
   if bsdf:
    for link in list(bsdf.inputs['Metallic'].links):mat.node_tree.links.remove(link)
    for link in list(bsdf.inputs['Roughness'].links):mat.node_tree.links.remove(link)
    bsdf.inputs['Metallic'].default_value=.25;bsdf.inputs['Roughness'].default_value=.77
 obj.name=FACTION+'-'+cat+'-'+str(n);keep.append(obj)
for obj in original:
 if obj not in keep and obj.name in bpy.data.objects:bpy.data.objects.remove(obj,do_unlink=True)
# Build simple independent bind bones. Runtime maps these names onto the actual
# articulated Groups; authored vertices remain one continuous skinned surface.
armature_data=bpy.data.armatures.new('Bolts deformation bind');armature=bpy.data.objects.new('Bolts deformation bind',armature_data);bpy.context.collection.objects.link(armature)
bpy.context.view_layer.objects.active=armature;armature.select_set(True);bpy.ops.object.mode_set(mode='EDIT')
for name in NAMES:
 bone=armature_data.edit_bones.new(name);bone.head=target[name];bone.tail=target[name]+Vector((0,-.08,0))
bpy.ops.object.mode_set(mode='OBJECT')
for obj in keep:
 mod=obj.modifiers.new('Continuous uniform deformation','ARMATURE');mod.object=armature
# Geometry currently uses game coordinates directly. Blender glTF export with
# Y-up disabled preserves this right-handed basis rather than converting again.
bpy.ops.object.select_all(action='DESELECT');armature.select_set(True)
for obj in keep:obj.select_set(True)
output=OUT/(FACTION+'.glb')
bpy.ops.export_scene.gltf(filepath=str(output),export_format='GLB',use_selection=True,export_yup=False,export_materials='EXPORT',export_normals=True,export_texcoords=True,export_skins=True,export_animations=False)
profile=dict(faction=FACTION,sourceUid=cfg['uid'],author=cfg['author'],sourceUrl='https://sketchfab.com/3d-models/'+cfg['slug']+'-'+cfg['uid'],license='CC BY 4.0',label=cfg['label'],bonePositions={n:list(p)for n,p in target.items()},boneNames=NAMES,height=1.80)
(OUT/(FACTION+'-profile.json')).write_text(json.dumps(profile,indent=2)+'\n')
manifest=dict(**{k:profile[k]for k in ['faction','sourceUid','author','sourceUrl','license']},sourceSha256=hashlib.sha256(SOURCE.read_bytes()).hexdigest(),outputSha256=hashlib.sha256(output.read_bytes()).hexdigest(),sourceBytes=SOURCE.stat().st_size,outputBytes=output.stat().st_size,triangles=sum(sum(len(p.vertices)-2 for p in o.data.polygons)for o in keep),removedObjects=removed,modifications=['Uniform scale to1.80m and neutral bind-pose normalization','Hidden skin/interior mouth/corneal shells and source-carried firearm removed','Coincident source vertices welded with per-corner UVs and source faces retained','Continuous garment meshes retain source UV/PBR; new four-influence animation weights authored','Helmet roughness/metalness adapted from chrome-like source response to painted steel'])
(OUT/(FACTION+'-provenance.json')).write_text(json.dumps(manifest,indent=2)+'\n');print('SOLDIER_OUTPUT',json.dumps(manifest))
