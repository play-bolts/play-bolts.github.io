"""Author compact rifle/uniform detail meshes with Blender.
Run: blender --background --factory-startup --disable-autoexec --python scripts/build-model-details.py
Geometry is authored in Bolts' metre/+Y-up coordinate system, then exported as glTF.
The Mosin walnut stock is adapted from Tabasco's acquired CC0 small-arms model.
"""
from pathlib import Path
from math import sin, cos, pi, exp, atan2
import hashlib,json
import bpy, bmesh
from mathutils import Vector

ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'public/assets/details';OUT.mkdir(parents=True,exist_ok=True)
SOURCE=ROOT/'assets-source/details';SOURCE.mkdir(parents=True,exist_ok=True)
bpy.ops.object.select_all(action='SELECT');bpy.ops.object.delete(use_global=False)
authored=[]

def mesh_object(name,vertices,faces,uvs,subdivision=1):
    mesh=bpy.data.meshes.new(name)
    mesh.from_pydata([(x,-z,y) for x,y,z in vertices],[],faces);mesh.update()
    uv=mesh.uv_layers.new(name='Tailored longitudinal UV')
    for polygon in mesh.polygons:
        polygon.use_smooth=True
        values=[uvs[mesh.loops[loop_index].vertex_index] for loop_index in polygon.loop_indices]
        crosses_seam=max(value[0] for value in values)-min(value[0] for value in values)>.5
        for loop_index,(u,v) in zip(polygon.loop_indices,values):uv.data[loop_index].uv=(u+1 if crosses_seam and u<.5 else u,v)
    obj=bpy.data.objects.new(name,mesh);bpy.context.collection.objects.link(obj)
    bpy.context.view_layer.objects.active=obj;obj.select_set(True)
    if subdivision:
        modifier=obj.modifiers.new('Continuous subdivision surface','SUBSURF');modifier.levels=subdivision
        bpy.ops.object.modifier_apply(modifier=modifier.name)
    obj.select_set(False);authored.append(obj);return obj

def interpolate(keys,t):
    n=len(keys)-1;scaled=t*n;i=min(n-1,int(scaled));u=scaled-i
    a=keys[max(0,i-1)];b=keys[i];c=keys[i+1];d=keys[min(n,i+2)]
    return [0.5*((2*b[j])+(-a[j]+c[j])*u+(2*a[j]-5*b[j]+4*c[j]-d[j])*u*u+(-a[j]+3*b[j]-3*c[j]+d[j])*u*u*u) for j in range(len(b))]

def tube(name,keys,axis='y',segments=24,rings=28,fold=0):
    # Y: height,width,depth,centerZ. Z: length,width,topY,bottomY.
    vertices=[];uvs=[];faces=[]
    for j in range(rings+1):
        t=j/rings;values=interpolate(keys,t)
        for i in range(segments):
            angle=i/segments*2*pi
            if axis=='y':
                y,rx,rz,center=values
                envelope=sin(pi*t)**2
                wrinkle=fold*envelope*(.55*sin(t*pi*9+sin(angle*2)*1.1)+.35*sin(t*pi*17-angle*3))
                x=sin(angle)*max(.002,rx+wrinkle)
                z=cos(angle)*max(.002,rz+wrinkle*.75)+center
                # Cloth gathers form diagonal shallow creases, not spherical joints.
                if name.startswith('uniform-') and 'torso' in name:
                    gather=exp(-((y-1.03)/.085)**2)*.0045*sin(angle*7+y*18)
                    x+=sin(angle)*gather;z+=cos(angle)*gather
                vertices.append((x,y,z));uvs.append((i/segments,t*1.25))
            else:
                z,rx,top,bottom=values;center=(top+bottom)/2;ry=(top-bottom)/2
                # Slightly flattened sides and rounded comb/underside.
                x=(1 if sin(angle)>=0 else -1)*abs(sin(angle))**.75*max(.002,rx)
                y=center+cos(angle)*ry
                vertices.append((x,y,z));uvs.append((i/segments,t*2))
    for j in range(rings):
        for i in range(segments):
            a=j*segments+i;b=j*segments+(i+1)%segments;c=b+segments;d=a+segments
            faces.append((a,b,c,d) if axis=='y' else (d,c,b,a))
    faces.extend([tuple(range(segments-1,-1,-1)),tuple(rings*segments+i for i in range(segments))])
    obj=mesh_object(name,vertices,faces,uvs)
    bm=bmesh.new();bm.from_mesh(obj.data);bmesh.ops.recalc_face_normals(bm,faces=list(bm.faces));bm.to_mesh(obj.data);bm.free()
    return obj

butt=[[.239,.035,.009,-.151],[.226,.043,.012,-.155],[.15,.043,-.006,-.15],[.055,.035,-.025,-.129],[-.055,.030,-.035,-.104],[-.15,.027,-.021,-.091],[-.23,.034,.009,-.075]]
british_butt=tube('rifle-wood-british-butt',butt,'z',20,28)
tube('rifle-wood-british-foreend',[[-.295,.043,.027,-.070],[-.35,.044,.025,-.077],[-.48,.045,.019,-.073],[-.67,.042,.020,-.070],[-.83,.035,.022,-.062],[-1.02,.033,.016,-.056],[-1.10,.028,.005,-.054]],'z',20,28)
tube('rifle-wood-german',[[.239,.035,.011,-.155],[.226,.042,.010,-.159],[.15,.041,-.006,-.151],[.055,.035,-.022,-.129],[-.055,.029,-.035,-.105],[-.145,.030,-.023,-.110],[-.23,.035,.007,-.087],[-.36,.038,.010,-.078],[-.48,.038,.012,-.071],[-.66,.035,.017,-.067],[-.86,.031,.010,-.064],[-.99,.028,-.005,-.057]],'z',20,36)

# Reuse the actual openly licensed stock mesh, keeping the public asset's
# carved finger groove, wrist, comb and butt profile. Only walnut faces ship.
with bpy.data.libraries.load(str(ROOT/'assets-source/reference-rifles/mosin9130.blend'),link=False) as (available,loaded):loaded.objects=['Cube']
donor=loaded.objects[0];bpy.context.collection.objects.link(donor)
wood_faces=[polygon for polygon in donor.data.polygons if polygon.material_index==3]
used=sorted({i for polygon in wood_faces for i in polygon.vertices});mapping={old:i for i,old in enumerate(used)}
vertices=[];uvs=[]
for index in used:
    v=donor.data.vertices[index].co;x=v.x*.245;y=v.z*.137-.068;z=-v.y*.1452-.491
    vertices.append((x,y,z));uvs.append((atan2(x,y+.05)/(2*pi)+.5,(.235-z)*1.45))
mosin=mesh_object('rifle-wood-russian',vertices,[tuple(mapping[i] for i in polygon.vertices) for polygon in wood_faces],uvs,0)
bpy.context.view_layer.objects.active=mosin;mosin.select_set(True)
smooth=mosin.modifiers.new('Smooth carved stock cross sections','SUBSURF');smooth.levels=1
bpy.ops.object.modifier_apply(modifier=smooth.name)
bevel=mosin.modifiers.new('Rounded carved walnut edges','BEVEL');bevel.width=.0022;bevel.segments=3;bevel.limit_method='ANGLE';bevel.angle_limit=.55
bpy.ops.object.modifier_apply(modifier=bevel.name);mosin.select_set(False)
bpy.data.objects.remove(donor,do_unlink=True)

torso=[[.824,.174,.104,0],[.847,.184,.114,0],[.914,.190,.121,0],[1.018,.182,.119,0],[1.115,.197,.126,0],[1.215,.218,.139,.002],[1.296,.227,.135,0],[1.356,.220,.118,0],[1.402,.179,.095,0],[1.438,.099,.076,0],[1.451,.068,.060,0]]
for faction in ['british','russian','german']:
    keys=[row[:] for row in torso]
    if faction=='russian':
        for row in keys:
            if row[0]<1.3:row[1]*=1.02;row[2]*=1.025
    if faction=='german':
        for row in keys:
            if .97<row[0]<1.2:row[1]*=.98
    tube('uniform-'+faction+'-torso',keys,'y',24,24,.0038 if faction=='british' else .003)
tube('uniform-upper-sleeve',[[.061,.029,.031,0],[.04,.058,.061,0],[-.006,.073,.073,0],[-.075,.072,.072,0],[-.16,.067,.068,.003],[-.255,.057,.059,.005],[-.335,.052,.055,0],[-.355,.051,.054,0]],'y',20,18,.0035)
tube('uniform-lower-sleeve',[[.025,.047,.049,0],[0,.055,.057,0],[-.073,.059,.063,.004],[-.16,.053,.058,.003],[-.24,.043,.046,0],[-.31,.041,.042,0],[-.35,.038,.038,0]],'y',20,18,.0038)
tube('uniform-thigh',[[.043,.09,.095,0],[.02,.112,.108,0],[-.08,.116,.112,0],[-.18,.104,.101,.006],[-.26,.094,.094,.008],[-.345,.080,.084,.004],[-.397,.078,.082,0]],'y',20,20,.0045)
tube('uniform-british-trouser',[[.015,.079,.083,0],[-.045,.080,.084,0],[-.10,.075,.080,0],[-.17,.069,.074,0],[-.26,.066,.070,0]],'y',20,16,.0035)

# Separate metal authoring keeps the material batches and animated bolt pivots
# independent while sharing this editable scene and compact geometry export.
exec(compile((ROOT/'scripts/build-weapon-metal.py').read_text(),str(ROOT/'scripts/build-weapon-metal.py'),'exec'),globals())

# Save an editable authoring scene plus geometry-only runtime asset. Runtime
# assigns the existing CC0 walnut/fabric materials, avoiding duplicate images.
bpy.ops.object.select_all(action='DESELECT')
for obj in authored:obj.select_set(True)
bpy.ops.wm.save_as_mainfile(filepath=str(SOURCE/'model-details.blend'))
bpy.ops.export_scene.gltf(filepath=str(OUT/'model-details.glb'),use_selection=True,export_format='GLB',export_animations=False,export_materials='NONE',export_yup=True)
paths=['assets-source/reference-rifles/smallarms.zip','assets-source/reference-rifles/lee-enfield.zip','public/assets/details/model-details.glb','assets-source/details/model-details.blend']
records=[{'path':path,'bytes':(ROOT/path).stat().st_size,'sha256':hashlib.sha256((ROOT/path).read_bytes()).hexdigest()} for path in paths]
(OUT/'provenance.json').write_text(json.dumps({'built':'2026-10-13','tool':'Blender '+bpy.app.version_string,'buildScript':'scripts/build-model-details.py','files':records},indent=2)+'\n')
backup=SOURCE/'model-details.blend1'
if backup.exists():backup.unlink()
print('AUTHORED_MESHES',[(obj.name,len(obj.data.vertices),sum(len(p.vertices)-2 for p in obj.data.polygons)) for obj in authored])
