"""Inspect and convert the user's officially downloaded CC-BY weapon models.

Run Blender with --background --factory-startup --disable-autoexec before
--python scripts/convert-sketchfab-weapons.py -- <source.glb> <asset-name>.
Original files are retained; derived previews and reports go under artifacts.
"""
from pathlib import Path
import sys,json,hashlib,math
import bpy
from mathutils import Vector

ROOT=Path(__file__).resolve().parents[1]
args=sys.argv[sys.argv.index('--')+1:]
SOURCE=Path(args[0]).resolve()
NAME=args[1]
OUT=ROOT/'artifacts/sketchfab-inspection'/NAME
OUT.mkdir(parents=True,exist_ok=True)
bpy.ops.object.select_all(action='SELECT');bpy.ops.object.delete(use_global=False)
bpy.ops.import_scene.gltf(filepath=str(SOURCE))
objects=[obj for obj in bpy.context.scene.objects if obj.type=='MESH']

def bounds(obj):
    points=[obj.matrix_world@Vector(point) for point in obj.bound_box]
    return [[min(point[i] for point in points) for i in range(3)],
            [max(point[i] for point in points) for i in range(3)]]

def report():
    result={'source':str(SOURCE.relative_to(ROOT)),'bytes':SOURCE.stat().st_size,
            'sha256':hashlib.sha256(SOURCE.read_bytes()).hexdigest(),'objects':[]}
    for obj in objects:
        # Weld position duplicates for connectivity inspection only. The
        # actual mesh keeps all UV/normal seam vertices unmodified.
        canonical={}; ids=[];points=[obj.matrix_world@v.co for v in obj.data.vertices]
        for point in points:
            key=tuple(round(x,5) for x in point)
            if key not in canonical:canonical[key]=len(canonical)
            ids.append(canonical[key])
        parent=list(range(len(canonical)))
        def find(x):
            while parent[x]!=x:parent[x]=parent[parent[x]];x=parent[x]
            return x
        for polygon in obj.data.polygons:
            first=find(ids[polygon.vertices[0]])
            for vertex in polygon.vertices[1:]:parent[find(ids[vertex])]=first
        components={}
        for index,point in enumerate(points):components.setdefault(find(ids[index]),[]).append(point)
        result['objects'].append({'name':obj.name,'vertices':len(obj.data.vertices),
            'triangles':sum(len(p.vertices)-2 for p in obj.data.polygons),
            'bounds':bounds(obj),'materials':[slot.material.name for slot in obj.material_slots],
            'matrix_world':[list(row) for row in obj.matrix_world],
            'components':sorted([{'vertices':len(values),'bounds':[[min(p[i] for p in values) for i in range(3)],[max(p[i] for p in values) for i in range(3)]]} for values in components.values()],key=lambda c:-c['vertices'])})
    result['images']=[{'name':im.name,'size':list(im.size),'channels':im.channels,'source':im.source} for im in bpy.data.images if im.source!='VIEWER']
    (OUT/'inspection.json').write_text(json.dumps(result,indent=2)+'\n')
    print('WEAPON_INSPECTION',json.dumps(result))

report()

# A neutral studio renders the real acquired materials without touching them.
scene=bpy.context.scene
scene.render.engine='CYCLES';scene.cycles.device='CPU';scene.cycles.samples=32
scene.render.resolution_x=1600;scene.render.resolution_y=1000;scene.render.resolution_percentage=100
scene.render.image_settings.file_format='PNG';scene.render.film_transparent=False
scene.world.color=(.35,.35,.35)
scene.world.use_nodes=True
scene.world.node_tree.nodes['Background'].inputs['Color'].default_value=(.32,.36,.4,1)
scene.world.node_tree.nodes['Background'].inputs['Strength'].default_value=.45
all_points=[obj.matrix_world@Vector(p) for obj in objects for p in obj.bound_box]
lo=Vector([min(p[i] for p in all_points) for i in range(3)])
hi=Vector([max(p[i] for p in all_points) for i in range(3)])
center=(lo+hi)/2;size=hi-lo;span=max(size)
for index,(offset,power) in enumerate([((.3,-.6,1),65),((-.7,.3,.8),40),((.4,.6,.3),25)]):
    data=bpy.data.lights.new('Studio-'+str(index),'AREA');data.energy=power*span*span;data.shape='DISK';data.size=span*.9
    lamp=bpy.data.objects.new(data.name,data);scene.collection.objects.link(lamp);lamp.location=center+Vector(offset)*span
    lamp.rotation_euler=(center-lamp.location).to_track_quat('-Z','Y').to_euler()
camera_data=bpy.data.cameras.new('Inspection camera');camera=bpy.data.objects.new(camera_data.name,camera_data);scene.collection.objects.link(camera);scene.camera=camera
camera_data.type='ORTHO';camera_data.ortho_scale=span*1.2;camera_data.clip_end=span*20
longest=max(range(3),key=lambda i:size[i])
directions={'side':Vector((0,-1,.18)) if longest==0 else Vector((1,0,.18)),
            'top':Vector((0,0,1)),
            'quarter':Vector((.55,-1,.55)) if longest==0 else Vector((1,-.55,.55))}
for label,direction in directions.items():
    camera_data.ortho_scale=span*(1.9 if label=='top' else 1.2)
    camera.location=center+direction.normalized()*span*2
    camera.rotation_euler=(center-camera.location).to_track_quat('-Z','Y').to_euler()
    scene.render.filepath=str(OUT/(label+'.png'));bpy.ops.render.render(write_still=True)
