"""Prepare legally downloaded CC-BY rifle sources; no viewer extraction.

Blender: --background --factory-startup --disable-autoexec --python this.py
-- enfield|kar98k|mosin. Uniform physical scale, rigid orientation and source
UV/corner normals are retained. The source archives remain untouched.
"""
import bpy,sys,json,math,hashlib
from pathlib import Path
from mathutils import Vector,Matrix
ROOT=Path(__file__).resolve().parents[1]
NAME=sys.argv[sys.argv.index('--')+1]
if NAME=='mosin':
 # The current Mosin uses MaX3Dd's authored PBR source. Keep the shared CLI
 # reproducible instead of accidentally restoring the retired D_U model.
 import runpy
 runpy.run_path(str(ROOT/'scripts/prepare-mosin-m91.py'),run_name='__main__')
 sys.exit(0)
OUT=ROOT/'public/assets/imported-weapons';OUT.mkdir(parents=True,exist_ok=True)
PREVIEW=ROOT/'artifacts/sketchfab-inspection'/NAME;PREVIEW.mkdir(parents=True,exist_ok=True)
SPECS={
'enfield':dict(file='lee-enfield-mkiii.glb',faction='british',model='Lee–Enfield Mk III',uid='f6a2160daf134071a84e3cae5f831875',author='Moony_State',slug='lee-enfield-mkiii',length=1.132,sourceLength=15.033724785,barrel=.985,wrist=3.8,drop=['Object_2','Object_3'],bolt={'Object_6':None},
 muzzle=[0,-6.915824,.85308],front=[0,-6.565,1.44087],rear=[0,-.979,1.501],right=[0,3.8,.25],left=[0,-2.05,.33],origin=[0,3.10,.985],knob=[-.59233,3.3667915,.5629191],charger=[0,1.40,1.15],travel=.107,lift=1.05),
'kar98k':dict(file='kar98k.glb',faction='german',model='Kar98k',uid='96b7387fe49b4dd491cc8277f765527a',author='Ecler',slug='kar98k',length=1.110,sourceLength=1.09601116,barrel=.170,wrist=.274,drop=[],bolt={'Object_2':[0,2,13,14,17,19,26,27]},
 muzzle=[0,-.549193,.1686096],front=[0,-.532,.19017],rear=[0,-.02416,.19017],right=[0,.274,.107],left=[0,-.16,.125],origin=[0,.180,.170],knob=[-.0524315,.1890245,.1393125],charger=[0,.06,.190],travel=.106,lift=1.04),
'mosin':dict(file='mosin-nagant.glb',faction='russian',model='Mosin–Nagant M1891/30',uid='2eb25ee9fdcd4ea38a6cbc5b4e6f9b37',author='D_U',slug='low-poly-mosin-nagant-189130',length=1.232,sourceLength=12.389234066,barrel=.508,wrist=-3.05,drop=['Object_4','Object_5','Object_7','Object_25','Object_26','Object_27','Object_29'],bolt={'Object_15':None},
 muzzle=[6.199581,0,.5134211],front=[5.91079,0,.73063],rear=[-.084,0,.77060],right=[-3.05,0,.09],left=[.30,0,.30],origin=[-1.7,0,.508],knob=[-1.8021467,-.504514,.5134211],charger=[-1.12,0,.625],travel=.113,lift=1.30),
}
cfg=SPECS[NAME];SOURCE=ROOT/'artifacts/sketchfab-source'/cfg['file'];scale=cfg['length']/cfg['sourceLength']
bpy.ops.object.select_all(action='SELECT');bpy.ops.object.delete(use_global=False)
bpy.ops.import_scene.gltf(filepath=str(SOURCE))
original=[o for o in bpy.context.scene.objects if o.type=='MESH']
(PREVIEW/'source-vertices.json').write_text(json.dumps({o.name:[list(o.matrix_world@v.co) for v in o.data.vertices] for o in original}))
# Original source-world coordinates -> right-handed game coordinates (+Y up,
# -Z forward, bolt handle on +X). Exporter applies Blender->glTF axis transform.
if NAME=='mosin':
 orient=Matrix(((0,-1,0),(0,0,1),(-1,0,0)));offset=Vector((0,.031-cfg['barrel']*scale,-.18+cfg['wrist']*scale))
else:
 orient=Matrix(((-1,0,0),(0,0,1),(0,1,0)));offset=Vector((0,.031-cfg['barrel']*scale,-.18-cfg['wrist']*scale))
def game(point):return orient@Vector(point)*scale+offset
# Blender coordinates that standard glTF Y-up export turns into `game`.
def blender(point):
 p=game(point);return Vector((p.x,-p.z,p.y))
B=Matrix(((1,0,0),(0,0,-1),(0,1,0)))
transform=(B@orient*scale).to_4x4();transform.translation=B@offset

def components(obj):
 points=[obj.matrix_world@v.co for v in obj.data.vertices]; canonical={};ids=[]
 for p in points:
  k=tuple(round(x,5) for x in p)
  if k not in canonical:canonical[k]=len(canonical)
  ids.append(canonical[k])
 parent=list(range(len(canonical)))
 def find(x):
  while parent[x]!=x:parent[x]=parent[parent[x]];x=parent[x]
  return x
 for p in obj.data.polygons:
  r=find(ids[p.vertices[0]])
  for v in p.vertices[1:]:parent[find(ids[v])]=r
 groups={}
 for i,p in enumerate(points):groups.setdefault(find(ids[i]),[]).append(i)
 return sorted(groups.values(),key=lambda a:-len(a))

def subset(obj,indices,name):
 selected=set(indices);old=obj.data
 polys=[p for p in old.polygons if all(v in selected for v in p.vertices)]
 used=sorted({v for p in polys for v in p.vertices});remap={v:i for i,v in enumerate(used)}
 mesh=bpy.data.meshes.new(name);mesh.from_pydata([old.vertices[i].co for i in used],[],[[remap[v] for v in p.vertices] for p in polys]);mesh.update()
 for mat in old.materials:mesh.materials.append(mat)
 for a,b in zip(mesh.polygons,polys):a.material_index=b.material_index;a.use_smooth=b.use_smooth
 for layer in old.uv_layers:
  dst=mesh.uv_layers.new(name=layer.name)
  for a,b in zip(mesh.polygons,polys):
   for i,j in zip(a.loop_indices,b.loop_indices):dst.data[i].uv=layer.data[j].uv
 normals=[old.corner_normals[j].vector[:] for p in polys for j in p.loop_indices]
 if normals:mesh.normals_split_custom_set(normals)
 new=bpy.data.objects.new(name,mesh);bpy.context.collection.objects.link(new);new.matrix_world=obj.matrix_world.copy()
 return new

static=[];moving=[];removed=[]
for obj in original:
 if obj.name in cfg['drop']:
  removed.append(obj.name);continue
 parts=components(obj)
 discard=set()
 if NAME=='kar98k' and obj.name=='Object_2':
  # Five floating display cartridges and their clip; retain the seated round.
  discard={4,5,6,7,8,20}
 bolt=cfg['bolt'].get(obj.name,[])
 boltparts=set(range(len(parts))) if bolt is None else set(bolt)
 for group,target in [(set(range(len(parts)))-discard-boltparts,static),(boltparts,moving)]:
  if group:
   indices=[v for index in sorted(group) for v in parts[index]]
   target.append(subset(obj,indices,('bolt-' if target is moving else 'source-')+obj.name))
 if discard:removed.append(obj.name+' display components '+str(sorted(discard)))
for obj in original:bpy.data.objects.remove(obj,do_unlink=True)
# Remove only imported transforms after baking them below.
for obj in static+moving:
 matrix=transform@obj.matrix_world;obj.parent=None;obj.matrix_world=Matrix.Identity(4);obj.data.transform(matrix)
# glTF source Mosin ships no image maps: author a cylindrical stock/planar metal
# unwrap and use already acquired CC0 physical maps, without altering topology.
if NAME=='mosin':
 # The low-poly source duplicates flat face vertices. Average corner normals
 # across coincident bolt vertices only, preserving cap/machined edges and
 # retaining every source vertex and triangle.
 for obj in moving:
  adjacent={}
  for poly in obj.data.polygons:
   for vi in poly.vertices:
    key=tuple(round(v,6) for v in obj.data.vertices[vi].co)
    adjacent.setdefault(key,[]).append((poly.normal.copy(),poly.area))
  normals=[]
  for poly in obj.data.polygons:
   for li in poly.loop_indices:
    key=tuple(round(v,6) for v in obj.data.vertices[obj.data.loops[li].vertex_index].co)
    total=sum((n*area for n,area in adjacent[key] if n.dot(poly.normal)>.49),Vector())
    normals.append(total.normalized())
  obj.data.normals_split_custom_set(normals)
 mats={} 
 for obj in static+moving:
  matname=obj.data.materials[0].name
  family='walnut' if matname=='wood_walnut' else 'steel'
  if matname not in mats:
   mat=bpy.data.materials.new('Mosin '+matname+' CC0 surface');mat.use_nodes=True
   nodes=mat.node_tree.nodes;links=mat.node_tree.links;bsdf=nodes.get('Principled BSDF')
   bsdf.inputs['Metallic'].default_value=0 if family=='walnut' else .96
   bsdf.inputs['Roughness'].default_value=.65 if family=='walnut' else .4
   for kind,socket in [('basecolor','Base Color'),('roughness','Roughness')]:
    tex=nodes.new('ShaderNodeTexImage');tex.image=bpy.data.images.load(str(ROOT/f'public/assets/materials/{family}/{kind}.jpg'),check_existing=True)
    if kind!='basecolor':tex.image.colorspace_settings.name='Non-Color'
    links.new(tex.outputs['Color'],bsdf.inputs[socket])
   normal=nodes.new('ShaderNodeTexImage');normal.image=bpy.data.images.load(str(ROOT/f'public/assets/materials/{family}/normal.jpg'),check_existing=True);normal.image.colorspace_settings.name='Non-Color'
   normalmap=nodes.new('ShaderNodeNormalMap');normalmap.inputs['Strength'].default_value=.25 if family=='walnut' else .45
   links.new(normal.outputs['Color'],normalmap.inputs['Color']);links.new(normalmap.outputs['Normal'],bsdf.inputs['Normal'])
   if family=='steel':
    # Neutral bluing on h-190 furniture, exposed silver bolt steel.
    tint=nodes.new('ShaderNodeMixRGB');tint.blend_type='MULTIPLY';tint.inputs[0].default_value=1
    factor=.075 if matname=='h-190' else .36;tint.inputs[2].default_value=(factor,factor,factor,1)
    base=next(n for n in nodes if n.type=='TEX_IMAGE' and 'basecolor' in n.image.filepath)
    links.new(base.outputs['Color'],tint.inputs[1]);links.new(tint.outputs[0],bsdf.inputs['Base Color'])
   mats[matname]=mat
  obj.data.materials.clear();obj.data.materials.append(mats[matname])
  uv=obj.data.uv_layers.active or obj.data.uv_layers.new(name='Authored source UV')
  for poly in obj.data.polygons:
   for li in poly.loop_indices:
    p=obj.data.vertices[obj.data.loops[li].vertex_index].co
    # Y is longitudinal in Blender. Wrap grain around stock length.
    uv.data[li].uv=(p.y/.65,math.atan2(p.z-.015,p.x)/(2*math.pi)*.42)
root=bpy.data.objects.new('imported-rifle-'+cfg['faction'],None);bpy.context.collection.objects.link(root)
furniture=bpy.data.objects.new('furniture',None);bpy.context.collection.objects.link(furniture);furniture.parent=root
pivot=bpy.data.objects.new('bolt',None);bpy.context.collection.objects.link(pivot);pivot.parent=root;pivot.location=blender(cfg['origin'])
for obj in static:obj.parent=furniture
for obj in moving:
 obj.data.transform(Matrix.Translation(-pivot.location));obj.parent=pivot
# Consolidate static geometry by material to bound draw calls; keep true UV and
# custom-normal boundaries. Bolt remains an independent animation child.
for parent in [furniture,pivot]:
 groups={}
 for obj in list(parent.children):groups.setdefault(tuple(m.name for m in obj.data.materials),[]).append(obj)
 for key,items in groups.items():
  if len(items)<2:continue
  bpy.ops.object.select_all(action='DESELECT')
  for obj in items:obj.select_set(True)
  bpy.context.view_layer.objects.active=items[0];bpy.ops.object.join();items[0].name=parent.name+'-'+key[0]
# Export only weapon tree and preserve all maps. JPEG is only used for Mosin's
# pre-existing photographic maps; source PNG PBR images remain source images.
bpy.ops.object.select_all(action='DESELECT')
root.select_set(True);furniture.select_set(True);pivot.select_set(True)
for obj in list(furniture.children)+list(pivot.children):obj.select_set(True)
output=OUT/(NAME+'.glb')
bpy.ops.export_scene.gltf(filepath=str(output),export_format='GLB',use_selection=True,export_yup=True,export_materials='EXPORT',export_normals=True,export_texcoords=True,export_animations=False,export_extras=False,export_image_format='AUTO')
bpy.context.view_layer.update()
pts=[obj.matrix_world@v.co for obj in furniture.children[:] + pivot.children[:] if obj.type=='MESH' for v in obj.data.vertices]
gamepts=[Vector((p.x,p.z,-p.y)) for p in pts]
lo=[min(p[i] for p in gamepts) for i in range(3)];hi=[max(p[i] for p in gamepts) for i in range(3)]
def point(key):return [round(x,7) for x in game(cfg[key])]
url='https://sketchfab.com/3d-models/'+cfg['slug']+'-'+cfg['uid']
profile=dict(faction=cfg['faction'],model=cfg['model'],sourceUid=cfg['uid'],sourceUrl=url,author=cfg['author'],license='CC BY 4.0',worldScale=1,nominalLength=cfg['length'],bounds=dict(min=lo,max=hi),muzzle=point('muzzle'),frontSight=point('front'),rearSight=point('rear'),sightY=game(cfg['rear']).y,adsZ=-.015,rightStock=point('right'),leftGrip=point('left'),bolt=dict(origin=point('origin'),knobLocal=list(game(cfg['knob'])-game(cfg['origin'])),axis=[0,0,1],lift=cfg['lift'],travel=cfg['travel']),chargerSeat=point('charger'))
(OUT/(NAME+'-profile.json')).write_text(json.dumps(profile,indent=2)+'\n')
manifest=dict(model=cfg['model'],author=cfg['author'],sourceUrl=url,license='CC BY 4.0',licenseUrl='https://creativecommons.org/licenses/by/4.0/',officialDownload=cfg['file'],sourceSha256=hashlib.sha256(SOURCE.read_bytes()).hexdigest(),outputSha256=hashlib.sha256(output.read_bytes()).hexdigest(),sourceBytes=SOURCE.stat().st_size,outputBytes=output.stat().st_size,uniformScale=scale,nominalLengthMetres=cfg['length'],removedDisplayExtras=removed,triangles=sum(sum(len(p.vertices)-2 for p in o.data.polygons) for o in furniture.children[:] + pivot.children[:] if o.type=='MESH'),modifications=['Uniform physical scale and rigid coordinate normalization','Source sights retained; independent moving bolt grouped for animation','Static meshes consolidated by source material; UVs and source corner normals retained','Loose display ammunition and bayonet removed']+(['Mosin UVs authored; Poly Haven Walnut Veneer 02 and ambientCG Metal012 CC0 surfaces applied to original mesh','Source low-poly bolt corner normals smoothed across rounded surfaces without changing topology'] if NAME=='mosin' else ['Original downloaded PBR images and material factors retained']))
(OUT/(NAME+'-provenance.json')).write_text(json.dumps(manifest,indent=2)+'\n')
print('CONVERTED',json.dumps(profile),json.dumps(manifest))
if '--no-render' in sys.argv:sys.exit(0)
# Render derived geometry from its shooting side and over shoulder.
scene=bpy.context.scene;scene.render.engine='CYCLES';scene.cycles.device='CPU';scene.cycles.samples=24
scene.render.resolution_x=1600;scene.render.resolution_y=900;scene.render.resolution_percentage=100;scene.render.image_settings.file_format='PNG'
scene.world.use_nodes=True;scene.world.node_tree.nodes['Background'].inputs['Color'].default_value=(.32,.36,.4,1);scene.world.node_tree.nodes['Background'].inputs['Strength'].default_value=.45
center=sum(pts,Vector())/len(pts);span=cfg['length']
for index,(studioOffset,power) in enumerate([((.3,-.6,1),65),((-.7,.3,.8),40),((.4,.6,.3),25)]):
 data=bpy.data.lights.new('Studio-'+str(index),'AREA');data.energy=power*span*span;data.shape='DISK';data.size=span*.9
 lamp=bpy.data.objects.new(data.name,data);scene.collection.objects.link(lamp);lamp.location=center+Vector(studioOffset)*span;lamp.rotation_euler=(center-lamp.location).to_track_quat('-Z','Y').to_euler()
data=bpy.data.cameras.new('Camera');cam=bpy.data.objects.new('Camera',data);scene.collection.objects.link(cam);scene.camera=cam;data.type='ORTHO';data.clip_end=20
for label,direction,target,viewspan in [('converted',Vector((1,-.25,.4)),Vector((0,.42,0)),span*1.16),('action',Vector((1,-.6,.8)),blender(cfg['origin']),.46),('bolt',Vector((1,-.6,.8)),blender(cfg['origin']),.35)]:
 if label=='bolt':
  for obj in furniture.children:obj.hide_render=True
 data.ortho_scale=viewspan;cam.location=target+direction.normalized()*2;cam.rotation_euler=(target-cam.location).to_track_quat('-Z','Y').to_euler();scene.render.filepath=str(PREVIEW/(label+'.png'));bpy.ops.render.render(write_still=True)
