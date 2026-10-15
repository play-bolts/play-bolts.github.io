"""Bake and retarget the official CC-BY Soviet soldier to Bolts' 15-bone rig.

Blender --background --factory-startup --disable-autoexec --python this.py
Original UVs, materials and garment topology are retained. Source bones are
sampled in the evaluated pose, not their differently oriented rest hierarchy.
"""
import bpy,bmesh,json,hashlib,math
from pathlib import Path
from mathutils import Vector,Matrix,Quaternion
ROOT=Path(__file__).resolve().parents[1]
SOURCE=ROOT/'artifacts/sketchfab-source/soldier-russian.glb'
OUT=ROOT/'public/assets/imported-soldiers';OUT.mkdir(parents=True,exist_ok=True)
QA=ROOT/'artifacts/soldier-candidates/russian';QA.mkdir(parents=True,exist_ok=True)
NAMES=['pelvis','spine','neck','upperArmL','lowerArmL','handL','upperArmR','lowerArmR','handR','thighL','calfL','footL','thighR','calfR','footR']
bpy.ops.object.select_all(action='SELECT');bpy.ops.object.delete(use_global=False)
bpy.ops.import_scene.gltf(filepath=str(SOURCE))
source_arm=next(o for o in bpy.context.scene.objects if o.type=='ARMATURE')
original=[o for o in bpy.context.scene.objects if o.type=='MESH' and o.name!='Icosphere']
deps=bpy.context.evaluated_depsgraph_get()
low=-.0002963374718092382;high=1.852030634880066;scale=1.80/(high-low)
def game(p):return Vector((p.x*scale,(p.z-low)*scale,-p.y*scale))
def source_joint(prefix):
 b=next(b for b in source_arm.pose.bones if b.name.startswith(prefix))
 return game(source_arm.matrix_world@b.head)
# Torso binds use the same conceptual anchors as the runtime Groups. They do
# not compress the neck/head just because the source has extra spine joints.
source={n:Vector(p)for n,p in {'pelvis':(0,.84,0),'spine':(0,.95,0),'neck':(0,1.46,0)}.items()}
target={n:p.copy()for n,p in source.items()}
for side,label,source_label in [(-1,'L','r'),(1,'R','l')]:
 for name,prefix in [('upperArm','upperarm_'),('lowerArm','lowerarm_'),('hand','hand_'),('thigh','thigh_'),('calf','calf_'),('foot','foot_')]:source[name+label]=source_joint(prefix+source_label+'_')
 # A boot sole, not the imported foot bone's unusually high head, determines
 # the visible ankle pivot. This preserves the source sole's ground clearance.
 source['foot'+label].y=.095
 target.update({f'upperArm{label}':Vector((side*.215,1.447,0)),f'lowerArm{label}':Vector((side*.215,1.167,0)),f'hand{label}':Vector((side*.215,.927,0)),f'thigh{label}':Vector((side*.115,.930,0)),f'calf{label}':Vector((side*.115,.510,0)),f'foot{label}':Vector((side*.115,.095,0))})
rotations={name:Quaternion()for name in NAMES}
for side in ['L','R']:
 for a,b in [('upperArm','lowerArm'),('lowerArm','hand'),('thigh','calf'),('calf','foot')]:rotations[a+side]=(source[b+side]-source[a+side]).normalized().rotation_difference((target[b+side]-target[a+side]).normalized())
 rotations['hand'+side]=rotations['lowerArm'+side].copy()
def collapse(name):
 side='L'if '_r_'in name else'R'
 if name.startswith('upperarm'):return'upperArm'+side
 if name.startswith('lowerarm'):return'lowerArm'+side
 if name.startswith(('hand_','middle_','thumb_','index_','ring_','pinky_')):return'hand'+side
 if name.startswith('thigh'):return'thigh'+side
 if name.startswith('calf'):return'calf'+side
 if name.startswith(('foot_','ball_')):return'foot'+side
 if name.startswith(('neck_','head_')):return'neck'
 if name.startswith(('spine_','clavicle_')):return'spine'
 return'pelvis'
keep=[];removed=['Icosphere'];source_tris=0
basis=Matrix(((scale,0,0,0),(0,0,scale,-low*scale),(0,-scale,0,0),(0,0,0,1)))
for obj in original:
 old_name=obj.name;group_names={g.index:g.name for g in obj.vertex_groups}
 influences=[]
 for vertex in obj.data.vertices:
  ws={}
  for influence in vertex.groups:
   name=collapse(group_names[influence.group]);ws[name]=ws.get(name,0)+influence.weight
  ordered=sorted(ws.items(),key=lambda item:-item[1])[:4];total=sum(w for _,w in ordered)
  influences.append([(n,w/total)for n,w in ordered]if total>1e-8 else[('spine',1)])
 evaluated=obj.evaluated_get(deps);mesh=bpy.data.meshes.new_from_object(evaluated,preserve_all_data_layers=True,depsgraph=deps)
 assert len(mesh.vertices)==len(influences),'evaluated pose must preserve vertex topology'
 world=obj.matrix_world.copy();obj.modifiers.clear();obj.parent=None;obj.matrix_world=Matrix.Identity(4);obj.data=mesh
 obj.data.transform(basis@world);obj.vertex_groups.clear()
 groups={n:obj.vertex_groups.new(name=n)for n in NAMES}
 for vertex,weights in zip(obj.data.vertices,influences):
  p=vertex.co.copy();q=Vector()
  # Keep soles rigidly attached to their ankle. The source blends a few sole
  # vertices into calf twist bones, which otherwise pull them below the floor.
  if p.y<.18:
   alpha=max(0,min(1,(.18-p.y)/.08));alpha=alpha*alpha*(3-2*alpha)
   foot='foot'+('L'if p.x<0 else'R');merged={n:w*(1-alpha)for n,w in weights};merged[foot]=merged.get(foot,0)+alpha
   ordered=sorted(merged.items(),key=lambda item:-item[1])[:4];total=sum(w for _,w in ordered);weights=[(n,w/total)for n,w in ordered if w>1e-7]
  for name,w in weights:
   q+=(rotations[name]@(p-source[name])+target[name])*w;groups[name].add([vertex.index],w,'REPLACE')
  vertex.co=q
 # The original body includes unseen skin inside the jacket. Keep its neck,
 # face and independently weighted hands; remove the covered torso surface.
 if old_name=='Object_68':
  bm=bmesh.new();bm.from_mesh(obj.data)
  faces=[face for face in bm.faces if max(v.co.y for v in face.verts)<1.485 and max(abs(v.co.x)for v in face.verts)<.16]
  bmesh.ops.delete(bm,geom=faces,context='FACES');bm.to_mesh(obj.data);bm.free()
  removed.append('covered Body torso faces')
 # Recompute smooth normals after neutral-pose normalization; original UVs and
 # PBR maps remain on each continuous mesh (no generated limb cylinders).
 for poly in obj.data.polygons:poly.use_smooth=True
 try:
  bpy.context.view_layer.objects.active=obj;obj.select_set(True);bpy.ops.mesh.customdata_custom_splitnormals_clear()
 except Exception:pass
 obj.name={'Object_68':'russian-body','Object_69':'russian-eyelashes','Object_71':'russian-uniform','Object_73':'russian-pilotka'}[old_name]
 keep.append(obj)
# Remove the imported armature, animations and non-render dummy after baking.
for obj in list(bpy.context.scene.objects):
 if obj not in keep:bpy.data.objects.remove(obj,do_unlink=True)
armature_data=bpy.data.armatures.new('Bolts deformation bind');armature=bpy.data.objects.new('Bolts deformation bind',armature_data);bpy.context.collection.objects.link(armature)
bpy.context.view_layer.objects.active=armature;armature.select_set(True);bpy.ops.object.mode_set(mode='EDIT')
for name in NAMES:
 b=armature_data.edit_bones.new(name);b.head=target[name];b.tail=target[name]+Vector((0,-.08,0))
bpy.ops.object.mode_set(mode='OBJECT')
for obj in keep:
 modifier=obj.modifiers.new('Continuous source-weight deformation','ARMATURE');modifier.object=armature
bpy.ops.object.select_all(action='DESELECT');armature.select_set(True)
for obj in keep:obj.select_set(True)
output=OUT/'russian.glb'
bpy.ops.export_scene.gltf(filepath=str(output),export_format='GLB',use_selection=True,export_yup=False,export_materials='EXPORT',export_normals=True,export_texcoords=True,export_skins=True,export_animations=False)
all_points=[v.co for obj in keep for v in obj.data.vertices]
bounds=dict(min=[min(p[i]for p in all_points)for i in range(3)],max=[max(p[i]for p in all_points)for i in range(3)])
assert bounds['min'][1]>-.002,'normalized boot soles must not penetrate the ground'
profile=dict(faction='russian',sourceUid='f85a4ed8c33a43eca1a7caa45f7acf99',author='tnnv',sourceUrl='https://sketchfab.com/3d-models/ww2-soviet-uniform-f85a4ed8c33a43eca1a7caa45f7acf99',license='CC BY 4.0',label='Soviet field uniform — tnnv',bonePositions={n:list(p)for n,p in target.items()},boneNames=NAMES,height=1.80,bounds=bounds)
(OUT/'russian-profile.json').write_text(json.dumps(profile,indent=2)+'\n')
manifest=dict(**{k:profile[k]for k in ['faction','sourceUid','author','sourceUrl','license']},sourceSha256=hashlib.sha256(SOURCE.read_bytes()).hexdigest(),outputSha256=hashlib.sha256(output.read_bytes()).hexdigest(),sourceBytes=SOURCE.stat().st_size,outputBytes=output.stat().st_size,triangles=sum(sum(len(p.vertices)-2 for p in o.data.polygons)for o in keep),removedObjects=removed,modifications=['Evaluated original posed mesh baked before coordinate normalization','Uniform scale to1.80m; source original smooth joint weights collapsed to15 runtime bones (maximum four influences)','Arms and legs normalized to shared adult-proportioned neutral bind; original continuous garment topology retained','Original body/face, UVs, PBR materials, boots and Soviet pilotka cap retained','Hidden torso skin and non-render Icosphere removed; no imported animations retained','Sole weights stabilized to the foot bind to preserve floor contact'])
(OUT/'russian-provenance.json').write_text(json.dumps(manifest,indent=2)+'\n');print('SOLDIER_OUTPUT',json.dumps(manifest));print('RUSSIAN_BOUNDS',bounds)
# Review renders of exactly the exported surfaces in game coordinates.
scene=bpy.context.scene;scene.render.engine='CYCLES';scene.cycles.device='CPU';scene.cycles.samples=32;scene.render.resolution_x=1000;scene.render.resolution_y=1000;scene.render.resolution_percentage=100;scene.render.image_settings.file_format='PNG'
scene.world.use_nodes=True;scene.world.node_tree.nodes['Background'].inputs['Color'].default_value=(.22,.25,.28,1);scene.world.node_tree.nodes['Background'].inputs['Strength'].default_value=.45
center=Vector((0,.9,0))
for n,(position,power)in enumerate([((2,3,3),230),((-2,2,2),140),((0,3,-3),180)]):
 data=bpy.data.lights.new('review-light'+str(n),'AREA');data.energy=power;data.size=2;obj=bpy.data.objects.new(data.name,data);scene.collection.objects.link(obj);obj.location=position;obj.rotation_euler=(center-obj.location).to_track_quat('-Z','Y').to_euler()
data=bpy.data.cameras.new('review-camera');camera=bpy.data.objects.new('review-camera',data);scene.collection.objects.link(camera);scene.camera=camera;data.type='ORTHO';data.ortho_scale=2.06
for name,position in [('normalized-front',(0,.9,4)),('normalized-side',(3,.95,1.2))]:
 camera.location=position;direction=(center-camera.location).normalized();right=direction.cross(Vector((0,1,0))).normalized();up=right.cross(direction);camera.rotation_euler=Matrix((right,up,-direction)).transposed().to_euler();scene.render.filepath=str(QA/(name+'.png'));bpy.ops.render.render(write_still=True)
