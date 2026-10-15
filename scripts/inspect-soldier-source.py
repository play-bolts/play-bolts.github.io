"""Inspect official soldier downloads; neutral studio and rig inventory."""
import bpy,sys,json
from pathlib import Path
from mathutils import Vector
root=Path(__file__).resolve().parents[1];name=sys.argv[sys.argv.index('--')+1];source=root/'artifacts/sketchfab-source'/f'soldier-{name}.glb';out=root/'artifacts/soldier-candidates'/name;out.mkdir(exist_ok=True)
bpy.ops.object.select_all(action='SELECT');bpy.ops.object.delete(use_global=False);bpy.ops.import_scene.gltf(filepath=str(source))
meshes=[o for o in bpy.context.scene.objects if o.type=='MESH'];bones=[]
def bounds(o):
 ps=[o.matrix_world@Vector(v) for v in o.bound_box];return [[min(p[i]for p in ps)for i in range(3)],[max(p[i]for p in ps)for i in range(3)]]
for o in bpy.context.scene.objects:
 if o.type=='ARMATURE':
  bones+=[dict(name=b.name,head=list(o.matrix_world@b.head_local),tail=list(o.matrix_world@b.tail_local),parent=b.parent.name if b.parent else None)for b in o.data.bones]
report={'objects':[dict(name=o.name,bounds=bounds(o),triangles=sum(len(p.vertices)-2 for p in o.data.polygons),materials=[m.name for m in o.data.materials],groups=[g.name for g in o.vertex_groups],modifiers=[m.type for m in o.modifiers])for o in meshes],'bones':bones,'images':[dict(name=i.name,size=list(i.size))for i in bpy.data.images]}
(out/'inspection.json').write_text(json.dumps(report,indent=2));print(json.dumps(report))
scene=bpy.context.scene;scene.render.engine='CYCLES';scene.cycles.device='CPU';scene.cycles.samples=24;scene.render.resolution_x=1200;scene.render.resolution_y=1200;scene.render.resolution_percentage=100;scene.render.image_settings.file_format='PNG'
scene.world.use_nodes=True;scene.world.node_tree.nodes['Background'].inputs['Color'].default_value=(.22,.25,.28,1);scene.world.node_tree.nodes['Background'].inputs['Strength'].default_value=.6
ps=[o.matrix_world@Vector(v)for o in meshes for v in o.bound_box];lo=Vector([min(p[i]for p in ps)for i in range(3)]);hi=Vector([max(p[i]for p in ps)for i in range(3)]);span=max(hi-lo);center=(lo+hi)/2
for n,(offset,power)in enumerate([((.5,-.5,.8),60),((-.6,-.2,.6),45),((.3,.6,.8),65)]):
 d=bpy.data.lights.new('light'+str(n),'AREA');d.energy=power*span*span;d.size=span*.65;o=bpy.data.objects.new(d.name,d);scene.collection.objects.link(o);o.location=center+Vector(offset)*span;o.rotation_euler=(center-o.location).to_track_quat('-Z','Y').to_euler()
d=bpy.data.cameras.new('camera');cam=bpy.data.objects.new('camera',d);scene.collection.objects.link(cam);scene.camera=cam;d.type='ORTHO';d.ortho_scale=span*1.15;d.clip_end=span*10
for name,direction in [('front',(0,-1,.02)),('side',(1,-.35,.05))]:
 cam.location=center+Vector(direction)*span*2;cam.rotation_euler=(center-cam.location).to_track_quat('-Z','Y').to_euler();scene.render.filepath=str(out/(name+'.png'));bpy.ops.render.render(write_still=True)
