"""Build Bolts' CC0 MakeHuman head. Run with Blender --background --disable-autoexec.
Source files are downloaded separately to /tmp/bolts-makehuman; see asset SOURCES.md.
"""
from pathlib import Path
import bpy
import bmesh
from mathutils import Vector

SOURCE=Path('/tmp/bolts-makehuman')
OUTPUT=Path('/Users/ckrapu/bolts/public/assets/makehuman')
OUTPUT.mkdir(parents=True,exist_ok=True)
bpy.ops.object.select_all(action='SELECT');bpy.ops.object.delete(use_global=False)
vertices=[];uvs=[];faces=[];group=''
for line in (SOURCE/'base.obj').read_text().splitlines():
    if line.startswith('v '): vertices.append(Vector(tuple(map(float,line.split()[1:]))))
    elif line.startswith('vt '): uvs.append(tuple(map(float,line.split()[1:3])))
    elif line.startswith('g '): group=line[2:]
    elif line.startswith('f ') and group=='body':
        faces.append([(int(t.split('/')[0])-1,int(t.split('/')[1])-1) for t in line.split()[1:]])
for name in ['caucasian-male-young.target','universal-male-young-averagemuscle-averageweight.target']:
    for line in (SOURCE/name).read_text().splitlines():
        if line.strip() and not line.startswith('#'):
            words=line.split();vertices[int(words[0])]+=Vector(tuple(map(float,words[1:])))
cut=6.90;scale=.29/(9.3003-cut);center_z=.57
# Retain the whole neck through subdivision. Discarding faces which crossed a
# height threshold left a sawtooth neckline; the final surface is bisected below.
faces=[f for f in faces if any(vertices[i].y>=6.0 for i,_ in f)]
used=sorted({i for f in faces for i,_ in f});mapping={v:i for i,v in enumerate(used)}
def convert(v): return (v.x*scale,-(v.z-center_z)*scale,(v.y-cut)*scale)
mesh=bpy.data.meshes.new('MakeHuman continuous face topology')
mesh.from_pydata([convert(vertices[i]) for i in used],[],[[mapping[i] for i,_ in f] for f in faces]);mesh.update()
uv_layer=mesh.uv_layers.new(name='MakeHuman UV')
for poly,face in zip(mesh.polygons,faces):
    poly.use_smooth=True
    for loop_index,(_,uv_index) in zip(poly.loop_indices,face):uv_layer.data[loop_index].uv=uvs[uv_index]
head=bpy.data.objects.new('Human head',mesh);bpy.context.collection.objects.link(head)
material=bpy.data.materials.new('Freckled natural male skin (CC0)');material.use_nodes=True
bsdf=material.node_tree.nodes.get('Principled BSDF');bsdf.inputs['Roughness'].default_value=.78
bsdf.inputs['Specular IOR Level'].default_value=.22
skin=bpy.data.images.load(str(SOURCE/'skins/toigo_light_skin_male_freckles/young_lightskinned_male_diffuse_Freckles.png'))
# Keep the original UV layout and embed a compact two-kilopixel skin map.
if skin.size[0]>2048:skin.scale(2048,2048)
skin.pack()
texture=material.node_tree.nodes.new('ShaderNodeTexImage');texture.image=skin
material.node_tree.links.new(texture.outputs['Color'],bsdf.inputs['Base Color']);mesh.materials.append(material)
bpy.context.view_layer.objects.active=head;head.select_set(True)
sub=head.modifiers.new('Smooth anatomical surface','SUBSURF');sub.levels=1;sub.render_levels=1
bpy.ops.object.modifier_apply(modifier=sub.name)

# Blender's Z is glTF's Y. Extend the same anatomical neck into the uniform
# collar without moving the face, then make one genuinely horizontal closed rim.
neck_base=-.05
bm=bmesh.new();bm.from_mesh(head.data)
# The source contains trapezius/shoulder skin below the throat. Taper that into
# the tunic opening, retaining the actual jaw (which reaches down to y=.022).
# Work in glTF coordinates here: Blender Z is height and -Y is forward.
def smoothstep(a,b,value):
    t=max(0,min(1,(value-a)/(b-a)))
    return t*t*(3-2*t)
for vertex in bm.verts:
    height=vertex.co.z;forward=-vertex.co.y
    blend=1-smoothstep(.035,.06,height)
    # Preserve the front jaw/chin rather than projecting it onto a neck tube.
    jaw_mask=smoothstep(.005,.018,height)*smoothstep(.035,.070,forward)
    blend*=1-jaw_mask
    x=vertex.co.x;z=forward+.015
    radial=((x/.050)**2+(z/.044)**2)**.5
    if radial>1 and blend>0:
        factor=1+(1/radial-1)*blend
        vertex.co.x=x*factor;vertex.co.y=-(z*factor-.015)
neck_cut=bmesh.ops.bisect_plane(bm,geom=list(bm.verts)+list(bm.edges)+list(bm.faces),
    dist=1e-7,plane_co=(0,0,neck_base),plane_no=(0,0,1),clear_inner=True,clear_outer=False)
rim=[edge for edge in neck_cut['geom_cut'] if isinstance(edge,bmesh.types.BMEdge) and edge.is_boundary]
caps=bmesh.ops.holes_fill(bm,edges=rim,sides=0)['faces']
cap_set=set(caps);uv_layer=bm.loops.layers.uv.active
for face in caps:
    face.smooth=False
    if uv_layer:
        for loop in face.loops:
            neighbors=[other[uv_layer].uv.copy() for other in loop.vert.link_loops if other.face not in cap_set]
            if neighbors:loop[uv_layer].uv=sum(neighbors,Vector((0,0)))/len(neighbors)
bmesh.ops.recalc_face_normals(bm,faces=list(bm.faces))
boundary_count=sum(edge.is_boundary for edge in bm.edges)
assert caps and not any(edge.is_boundary and all(abs(vertex.co.z-neck_base)<1e-6 for vertex in edge.verts) for edge in bm.edges), 'Neck cap must close the complete cut rim'
bm.to_mesh(head.data);bm.free();head.data.update()
print('NECK_CAP',len(caps),'open_boundary_edges',boundary_count,'base_glTF_y',neck_base)

def solid(name,color,roughness):
    mat=bpy.data.materials.new(name);mat.diffuse_color=(*color,1);mat.use_nodes=True
    bsdf=mat.node_tree.nodes.get('Principled BSDF');bsdf.inputs['Base Color'].default_value=(*color,1);bsdf.inputs['Roughness'].default_value=roughness
    return mat
sclera=solid('Sclera',(.62,.58,.50),.35);iris=solid('Muted brown iris',(.065,.038,.018),.42);pupil=solid('Pupil',(.004,.004,.003),.25)
def eye_piece(name,point,radii,mat):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=28,ring_count=16,location=convert(Vector(point)))
    obj=bpy.context.object;obj.name=name;obj.scale=(radii[0]*scale,radii[2]*scale,radii[1]*scale);obj.data.materials.append(mat)
    for p in obj.data.polygons:p.use_smooth=True
    return obj
for side in [-1,1]:
    x=side*.29325;y=8.21615;z=1.30435
    eye_piece('Eye', (x,y,z),(.128,.128,.128),sclera)
    eye_piece('Iris',(x,y,z+.116),(.059,.059,.012),iris)
    eye_piece('Pupil',(x,y,z+.126),(.024,.024,.006),pupil)
# All model parts remain independent of the preview lighting and camera.
for obj in bpy.context.scene.objects:obj.select_set(obj.type=='MESH')
bpy.context.view_layer.objects.active=head
bpy.ops.export_scene.gltf(filepath=str(OUTPUT/'human-head.glb'),export_format='GLB',use_selection=True,export_yup=True,export_animations=False,export_cameras=False,export_lights=False)
print('HEAD_EXPORT',len(head.data.vertices),len(head.data.polygons),'scale',scale,'dimensions',tuple(head.dimensions))
# Neutral studio render is a QA artifact only, not shipped in the game.
scene=bpy.context.scene;scene.render.engine='CYCLES';scene.cycles.device='CPU';scene.cycles.samples=24
scene.render.resolution_x=800;scene.render.resolution_y=800;scene.render.resolution_percentage=100
scene.world.color=(.14,.14,.14)
scene.view_settings.view_transform='Standard';scene.view_settings.exposure=-2
for location,energy,size in [((-.4,-.5,.7),25,.55),((.4,-.2,.2),9,.4),((0,.5,.6),20,.5)]:
    bpy.ops.object.light_add(type='AREA',location=location);light=bpy.context.object;light.data.energy=energy;light.data.shape='DISK';light.data.size=size;light.rotation_euler=(Vector((0,0,.14))-light.location).to_track_quat('-Z','Y').to_euler()
bpy.ops.object.camera_add(location=(.32,-.62,.25));cam=bpy.context.object;cam.rotation_euler=(Vector((0,0,.145))-cam.location).to_track_quat('-Z','Y').to_euler();cam.data.type='ORTHO';cam.data.ortho_scale=.39;scene.camera=cam
scene.render.filepath='/tmp/bolts-makehuman/head-preview.png';bpy.ops.render.render(write_still=True)
