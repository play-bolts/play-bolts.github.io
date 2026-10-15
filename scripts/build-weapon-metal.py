"""Original visual rifle metalwork, called by build-model-details.py.

App coordinates use metres, +Y up and -Z toward the muzzle. These are surface
models for rendering, not dimensioned manufacturing or functioning mechanisms.
The geometry preserves Bolts' existing optical and animated bolt anchors.
"""
from mathutils import Vector

def _app(point): return Vector((point[0],-point[2],point[1]))

def _active(obj):
    bpy.ops.object.select_all(action='DESELECT');obj.select_set(True);bpy.context.view_layer.objects.active=obj

def _bevel(obj,width=.0012,segments=2):
    _active(obj)
    modifier=obj.modifiers.new('Small machined edge radii','BEVEL');modifier.width=width;modifier.segments=segments;modifier.limit_method='ANGLE'
    bpy.ops.object.modifier_apply(modifier=modifier.name)
    return obj

def _block(size,position,bevel=.0012):
    bpy.ops.mesh.primitive_cube_add(size=1,location=_app(position));obj=bpy.context.object
    obj.scale=(size[0],size[2],size[1]);bpy.ops.object.transform_apply(location=False,rotation=False,scale=True)
    return _bevel(obj,bevel) if bevel else obj

def _cylinder(radius,length,position,axis='z',vertices=32,radius2=None,bevel=.0007):
    bpy.ops.mesh.primitive_cone_add(vertices=vertices,radius1=radius,radius2=radius if radius2 is None else radius2,depth=length,location=_app(position))
    obj=bpy.context.object;direction=_app({'x':(1,0,0),'y':(0,1,0),'z':(0,0,1)}[axis]);obj.rotation_mode='QUATERNION';obj.rotation_quaternion=Vector((0,0,1)).rotation_difference(direction)
    bpy.ops.object.transform_apply(location=False,rotation=True,scale=True)
    return _bevel(obj,bevel) if bevel else obj

def _subtract(obj,cutter):
    _active(obj);modifier=obj.modifiers.new('Open machined recess','BOOLEAN');modifier.operation='DIFFERENCE';modifier.solver='EXACT';modifier.object=cutter
    bpy.ops.object.modifier_apply(modifier=modifier.name);bpy.data.objects.remove(cutter,do_unlink=True);return obj

def _profile(points,width):
    # Closed extruded side profile in Y/Z, useful for the distinct magazines.
    vertices=[(x,y,z) for x in [-width/2,width/2] for z,y in points];n=len(points)
    faces=[tuple(range(n-1,-1,-1)),tuple(range(n,n*2))]+[(i,(i+1)%n,(i+1)%n+n,i+n) for i in range(n)]
    obj=mesh_object('_profile',vertices,faces,[(z*4,y*4) for x,y,z in vertices],0);authored.remove(obj)
    return _bevel(obj,.002,3)

def _band(z,rx,ry,width,cy=-.010):
    vertices=[];faces=[];n=32
    for depth,radiusX,radiusY in [(z-width/2,rx,ry),(z+width/2,rx,ry),(z-width/2,rx-.004,ry-.004),(z+width/2,rx-.004,ry-.004)]:
        vertices.extend([(sin(i/n*2*pi)*radiusX,cy+cos(i/n*2*pi)*radiusY,depth) for i in range(n)])
    for i in range(n):
        j=(i+1)%n
        faces.extend([(i,j,n+j,n+i),(2*n+j,2*n+i,3*n+i,3*n+j),(j,i,2*n+i,2*n+j),(n+i,n+j,3*n+j,3*n+i)])
    obj=mesh_object('_band',vertices,faces,[(i%n/n,i//n) for i in range(len(vertices))],0);authored.remove(obj)
    return _bevel(obj,.0006,2)

def _guard():
    vertices=[];faces=[];n=40
    for x,ry,rz in [(-.0065,.040,.052),(.0065,.040,.052),(-.0065,.0315,.0425),(.0065,.0315,.0425)]:
        for i in range(n):
            a=i/n*2*pi
            vertices.append((x,-.104+cos(a)*ry,-.205+sin(a)*rz))
    for i in range(n):
        j=(i+1)%n;faces.extend([(i,j,n+j,n+i),(2*n+j,2*n+i,3*n+i,3*n+j),(j,i,2*n+i,2*n+j),(n+i,n+j,3*n+j,3*n+i)])
    obj=mesh_object('_guard',vertices,faces,[(i%n/n,i//n) for i in range(len(vertices))],0);authored.remove(obj)
    return _bevel(obj,.001,2)

def _curve(points,radius):
    curve=bpy.data.curves.new('Forged curve','CURVE');curve.dimensions='3D';curve.resolution_u=6;curve.bevel_depth=radius;curve.bevel_resolution=2
    spline=curve.splines.new('BEZIER');spline.bezier_points.add(len(points)-1)
    for point,co in zip(spline.bezier_points,points):point.co=_app(co);point.handle_left_type=point.handle_right_type='AUTO'
    obj=bpy.data.objects.new('Forged curve',curve);bpy.context.collection.objects.link(obj);_active(obj);bpy.ops.object.convert(target='MESH');return bpy.context.object

def _knob(position,size):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=24,ring_count=12,radius=1,location=_app(position));obj=bpy.context.object;obj.scale=(size[0],size[2],size[1]);bpy.ops.object.transform_apply(location=False,rotation=False,scale=True);return obj

def _screw(position,axis='x',radius=.0045):
    head=_cylinder(radius,.003,position,axis,20,bevel=.00035)
    cutSize=(.006,.0014,radius*1.65) if axis=='x' else (radius*1.65,.0014,.006)
    return _subtract(head,_block(cutSize,position,0))

def _finish(name,parts):
    bpy.ops.object.select_all(action='DESELECT')
    for obj in parts:obj.select_set(True)
    bpy.context.view_layer.objects.active=parts[0]
    if len(parts)>1:bpy.ops.object.join()
    obj=bpy.context.object;obj.name=name
    bpy.ops.object.transform_apply(location=True,rotation=True,scale=True)
    bm=bmesh.new();bm.from_mesh(obj.data);bmesh.ops.recalc_face_normals(bm,faces=list(bm.faces));bm.to_mesh(obj.data);bm.free()
    for polygon in obj.data.polygons:polygon.use_smooth=True
    normal=obj.modifiers.new('Weighted machining normals','WEIGHTED_NORMAL');normal.keep_sharp=True;normal.weight=40
    bpy.ops.object.modifier_apply(modifier=normal.name)
    # Joining the source primitives can retain multiple named UV layers. Only
    # one PBR coordinate set is used; remove the unused layers before unwrap.
    for layer in list(obj.data.uv_layers):obj.data.uv_layers.remove(layer)
    obj.data.uv_layers.new(name='Metal surface UV')
    bpy.ops.object.mode_set(mode='EDIT');bpy.ops.mesh.select_all(action='SELECT');bpy.ops.uv.smart_project(angle_limit=.9,island_margin=.012);bpy.ops.object.mode_set(mode='OBJECT')
    authored.append(obj);obj.select_set(False)

for faction,muzzle in [('british',-1.27),('russian',-1.46),('german',-1.18)]:
    body=[];trim=[];recess=[];bolt=[];boltTrim=[]
    if faction=='british':
        action=_block((.080,.068,.252),(0,.030,-.356),0)
        _subtract(action,_block((.046,.065,.200),(0,.064,-.346),0))
        _subtract(action,_block((.050,.043,.145),(.025,.053,-.352),0))
        body.append(_bevel(action,.0011,3))
        body.extend([_cylinder(.044,.061,(0,-.013,-.250)),_block((.013,.014,.222),(-.039,.060,-.345))])
        body.append(_profile([(-.460,-.035),(-.300,-.035),(-.298,-.111),(-.320,-.161),(-.429,-.176),(-.454,-.126)],.067))
        trim.append(_profile([(-.431,-.166),(-.319,-.151),(-.323,-.166),(-.428,-.182)],.069))
        for x in [-.0345,.0345]:
            for z in [-.425,-.390,-.355]:trim.append(_block((.002,.072,.005),(x,-.112,z),.0005))
        body.append(_block((.014,.040,.047),(-.046,.031,-.268)))
        trim.extend([_screw((-.055,.032,-.264)),_block((.010,.014,.037),(-.050,.056,-.254),.002)])
    else:
        action=_cylinder(.036 if faction=='russian' else .038,.250,(0,.034,-.356),vertices=32,bevel=0)
        _subtract(action,_cylinder(.024,.280,(0,.043,-.356),vertices=32,bevel=0))
        _subtract(action,_block((.080,.070,.155),(.014,.067,-.359),0))
        body.append(_bevel(action,.001,3))
        body.append(_cylinder(.039 if faction=='russian' else .041,.055,(0,.034,-.457)))
        if faction=='russian':
            body.append(_profile([(-.426,-.041),(-.266,-.044),(-.280,-.132),(-.397,-.129)],.050))
            trim.append(_profile([(-.400,-.126),(-.282,-.129),(-.280,-.136),(-.400,-.136)],.053))
            body.append(_block((.010,.027,.075),(-.035,.028,-.346)))
        else:
            body.append(_block((.067,.019,.220),(0,-.070,-.354),.006))
            trim.append(_block((.052,.004,.178),(0,-.081,-.354),.004))
            body.append(_block((.012,.018,.063),(-.039,.035,-.263)))
            for x in [-.043,.043]:
                trim.append(_cylinder(.012,.002,(x,-.049,.06),'x',24))
                recess.append(_cylinder(.0085,.0025,(x*1.035,-.049,.06),'x',24))
    # Raceway floor is actually below an open slot, rather than a dark plate
    # sitting on top of a solid receiver. The bolt slides inside this channel.
    recess.append(_block((.033,.003,.158),(0,.014,-.354),.001))
    barrel=_cylinder(.013,abs(muzzle+.485),(0,.031,(muzzle-.485)/2),vertices=32,radius2=.023,bevel=.00045)
    _subtract(barrel,_cylinder(.006,.044,(0,.031,muzzle+.014),vertices=24,bevel=0));body.append(barrel)
    trim.append(_band(muzzle+.009,.016,.016,.015,.031))
    recess.append(_cylinder(.0058,.002,(0,.031,muzzle+.029),vertices=20,bevel=0))
    bands=([- .650,-1.080] if faction=='british' else [-.820,-1.025] if faction=='russian' else [-.790,-.970])
    for i,z in enumerate(bands):
        rx=.046 if i==0 else .038;ry=.054 if i==0 else .045
        body.append(_band(z,rx,ry,.022 if faction!='german' else .027))
        body.append(_block((.042,.012,.025),(0,-.065 if i==0 else -.056,z),.002))
        trim.append(_screw((rx+.001,-.020,z)))
        if faction=='german' and i==1:body.append(_band(z-.038,rx-.002,ry-.003,.018))
    # Complete oval guard, tang screws and swept trigger blade.
    body.append(_guard());body.append(_block((.024,.009,.151),(0,-.067,-.212),.003))
    body.append(_curve([(0,-.072,-.225),(0,-.096,-.226),(0,-.117,-.213)],.0035))
    for z in [-.277,-.150]:trim.append(_screw((0,-.073,z),'y',.005))
    for z in [-.248,-.430]:
        for x in [-.041,.041]:trim.append(_screw((x,-.019,z)))
    # Bayonet lug / cleaning rod follows the appropriate muzzle furniture.
    if faction=='british':body.append(_block((.014,.014,.027),(0,.010,muzzle+.065),.002))
    else:
        body.append(_cylinder(.0035,.54,(0,-.043,muzzle+.30),vertices=16,bevel=.0002))
        if faction=='german':body.append(_block((.017,.015,.070),(0,-.036,-1.054),.002))
    # The complete moving bolt is authored relative to the existing pivot.
    boltTrim.append(_cylinder(.018,.193,(0,0,-.015),vertices=32,bevel=.001))
    bolt.append(_block((.008,.009,.146),(.016,-.001,-.021),.001))
    if faction=='russian':
        bolt.append(_curve([(.017,0,.010),(.060,-.002,.010),(.119,-.002,.010)],.008))
        bolt.append(_knob((.119,-.002,.010),(.0145,.014,.0145)))
        boltTrim.append(_cylinder(.023,.023,(0,0,.096),vertices=32,bevel=.0015))
        for i in range(16):
            a=i/16*2*pi;bolt.append(_block((.0018,.0018,.013),(sin(a)*.023,cos(a)*.023,.096),.0003))
    else:
        bolt.append(_curve([(.021,.003,-.017),(.055,-.014,-.006),(.087,-.057,.013)],.008))
        bolt.append(_knob((.087,-.057,.013),(.0145,.014,.015)))
        if faction=='british':bolt.append(_block((.031,.024,.031),(0,-.003,.098),.004))
        else:
            bolt.append(_cylinder(.024,.039,(0,0,.097),vertices=32,bevel=.0015))
            bolt.append(_block((.013,.027,.018),(.013,.022,.104),.002))
    for part,objects in [('body',body),('trim',trim),('recess',recess),('bolt',bolt),('bolt-trim',boltTrim)]:_finish('rifle-metal-'+faction+'-'+part,objects)
