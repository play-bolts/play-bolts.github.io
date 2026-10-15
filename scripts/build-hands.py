"""Convert para's CC0 MakeHuman FPS arms to compact wrist-local glTF hands.
Run with Blender --background --disable-autoexec --python scripts/build-hands.py.
The source .blend is loaded with script execution disabled; constraints are not run.
"""
import bpy, bmesh, os, math
from mathutils import Matrix, Vector

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SOURCE = os.path.join(ROOT, 'assets-source/arms/FPS ARMS RIG 1.blend')
OUT = os.path.join(ROOT, 'public/assets/arms')
os.makedirs(OUT, exist_ok=True)

def smooth(a, b, x):
    t=max(0,min(1,(x-a)/(b-a)))
    return t*t*(3-2*t)

def bell(point, center, radius):
    return math.exp(-sum(((point[i]-center[i])/radius[i])**2 for i in range(3))*2)

def refine_anatomy(mesh, landmarks, side):
    """Subdivide the source topology, keeping the wrist seam exactly anchored.

    Sub-millimetre knuckle volumes and broad palm pads augment the original
    MakeHuman anatomy. Surface masks follow the same skinned vertices as the
    geometry, so nail/knuckle shading cannot slide when a finger bends.
    """
    data=mesh.data
    crease=data.attributes.new('crease_edge','FLOAT','EDGE')
    for edge in data.edges:
        if all(abs(data.vertices[index].co.y+.025)<1e-6 for index in edge.vertices):
            crease.data[edge.index].value=1
    bpy.context.view_layer.objects.active=mesh
    subdivision=mesh.modifiers.new('Anatomical surface refinement','SUBSURF')
    subdivision.levels=1;subdivision.subdivision_type='CATMULL_CLARK'
    bpy.ops.object.modifier_apply(modifier=subdivision.name)
    data=mesh.data
    # Blender/glTF custom vertex attribute: nail, knuckle and palmar masks.
    surface=data.attributes.new('_SKIN_DETAIL','FLOAT_VECTOR','POINT')
    joints=[];nails=[]
    for name,head,tail in landmarks:
        if not (name.startswith('f_') or name.startswith('thumb.')):continue
        direction=(tail-head).normalized()
        dorsal=Vector((0,0,-1));dorsal=(dorsal-direction*dorsal.dot(direction)).normalized()
        if '.03.' in name:
            width=.0051 if 'pinky' in name else .0063 if 'ring' in name else .007
            if name.startswith('thumb.'):width=.0078
            nails.append((head,tail,direction,dorsal,direction.cross(dorsal).normalized(),width))
        if not name.startswith('thumb.'):
            joints.append((head,.010 if '.01.' in name else .0075,.00075 if '.01.' in name else .00045))
    side_sign=1 if side=='R' else -1
    for vertex in data.vertices:
        point=vertex.co.copy();palmar=smooth(-.1,.72,vertex.normal.z)
        dorsal=smooth(-.05,.68,-vertex.normal.z)
        knuckle=0
        for center,radius,amount in joints:
            bump=bell(point,center,(radius,radius,.024))*dorsal
            vertex.co.z-=amount*bump
            knuckle=max(knuckle,bump)
        if point.y>.015 and point.y<.115:
            # Thenar and hypothenar pads curve into the palm's shallow hollow.
            pads=bell(point,(side_sign*.023,.061,.009),(.024,.035,.05))*.0017
            pads+=bell(point,(-side_sign*.025,.059,.003),(.018,.043,.05))*.0011
            hollow=bell(point,(-side_sign*.004,.081,.008),(.018,.023,.05))*.00065
            vertex.co.z+=(pads-hollow)*palmar
        nail=0
        for head,tail,direction,outward,across,width in nails:
            delta=point-head;length=(tail-head).length;t=delta.dot(direction)/length
            ellipse=math.sqrt((delta.dot(across)/width)**2+((t-.61)/.37)**2)
            mask=(1-smooth(.70,1,ellipse))*smooth(.0025,.006,delta.dot(outward))
            nail=max(nail,mask)
        surface.data[vertex.index].vector=(nail,min(1,knuckle),palmar)
        if point.y<=-.02499:vertex.co.y=-.025
        # Subdivision can blend a fifth tiny influence or round a unit weight
        # above one. Resolve the glTF four-weight budget deterministically.
        influences=sorted([(group.group,group.weight) for group in vertex.groups],key=lambda item:-item[1])
        retained=[(index,weight) for index,weight in influences[:4] if weight>1e-8]
        total=sum(weight for _,weight in retained)
        for index,_ in influences:mesh.vertex_groups[index].remove([vertex.index])
        for index,weight in retained:mesh.vertex_groups[index].add([vertex.index],min(1,weight/total),'REPLACE')
    data.update()
    if data.validate(verbose=True):raise RuntimeError('Refined hand mesh required unexpected topology repair')

for side in ['R', 'L']:
    bpy.ops.wm.open_mainfile(filepath=SOURCE, load_ui=False, use_scripts=False)
    rig = next(o for o in bpy.data.objects if o.type == 'ARMATURE')
    source = next(o for o in bpy.data.objects if o.type == 'MESH')
    hand_name = 'hand.' + side
    hand = rig.data.bones[hand_name]
    bones = [hand] + list(hand.children_recursive)
    names = {b.name for b in bones}
    # Include the adjoining forearm so triangles crossing the wrist plane are
    # cut geometrically, rather than lost when one of their vertices is omitted.
    selection_names = names | ({hand.parent.name} if hand.parent else set())
    # Preserve the artist's hand axes, skin weights and UVs at a real-world scale.
    transform = Matrix.Scale(.1, 4) @ hand.matrix_local.inverted()
    landmarks=[(bone.name,transform@bone.head_local,transform@bone.tail_local) for bone in bones]
    verts, faces, uvs, weights = [], [], [], []
    keep = {}
    groups = {g.index:g.name for g in source.vertex_groups}
    for v in source.data.vertices:
        influence = [(groups[g.group], g.weight) for g in v.groups if groups[g.group] in names]
        if sum(g.weight for g in v.groups if groups[g.group] in selection_names) < .01:
            continue
        p = transform @ v.co
        keep[v.index] = len(verts)
        verts.append(tuple(p))
        total = sum(w for _,w in influence)
        weights.append([(name,w / max(1,total)) for name,w in influence] + [(hand.name,max(0,1-total))])
    source_uv = source.data.uv_layers.active.data
    for polygon in source.data.polygons:
        if all(v in keep for v in polygon.vertices):
            faces.append([keep[v] for v in polygon.vertices])
            uvs.append([tuple(source_uv[i].uv) for i in polygon.loop_indices])
    data=bpy.data.meshes.new('AnatomicalHand');data.from_pydata(verts,[],faces);data.update()
    mesh=bpy.data.objects.new('hand-mesh-'+side,data);bpy.context.collection.objects.link(mesh)
    uv=data.uv_layers.new(name='UVMap')
    for polygon,coordinates in zip(data.polygons,uvs):
        for index,coordinate in zip(polygon.loop_indices,coordinates): uv.data[index].uv=coordinate
        polygon.use_smooth=True
    armature=bpy.data.armatures.new('HandSkeleton');arm=bpy.data.objects.new('hand-rig-'+side,armature)
    bpy.context.collection.objects.link(arm);bpy.context.view_layer.objects.active=arm
    bpy.ops.object.mode_set(mode='EDIT')
    for original in bones:
        bone=armature.edit_bones.new(original.name)
        bone.head=transform @ original.head_local;bone.tail=transform @ original.tail_local
        bone.align_roll((hand.matrix_local.inverted().to_3x3() @ original.matrix_local.to_3x3().col[2]).normalized())
        if original.parent and original.parent.name in names: bone.parent=armature.edit_bones[original.parent.name]
    bpy.ops.object.mode_set(mode='OBJECT')
    for name in names: mesh.vertex_groups.new(name=name)
    for index,influence in enumerate(weights):
        for name,weight in influence:
            if weight>0: mesh.vertex_groups[name].add([index],weight,'ADD')
    # Bisect interpolates UVs and deform weights at every new edge intersection.
    # Close only the new coplanar boundary; the cloth sleeve overlaps this cap.
    bm=bmesh.new();bm.from_mesh(data)
    cut=bmesh.ops.bisect_plane(bm,geom=list(bm.verts)+list(bm.edges)+list(bm.faces),dist=1e-7,
        plane_co=(0,-.025,0),plane_no=(0,1,0),clear_inner=True,clear_outer=False)
    rim=[edge for edge in cut['geom_cut'] if isinstance(edge,bmesh.types.BMEdge) and edge.is_boundary]
    caps=bmesh.ops.holes_fill(bm,edges=rim,sides=0)['faces'] if rim else []
    uv_layer=bm.loops.layers.uv.active
    for face in caps:
        face.smooth=False
        for loop in face.loops:
            adjacent=[other[uv_layer].uv.copy() for other in loop.vert.link_loops if other.face not in caps]
            if adjacent:loop[uv_layer].uv=sum(adjacent,Vector((0,0)))/len(adjacent)
    deform=bm.verts.layers.deform.verify();hand_index=mesh.vertex_groups[hand_name].index
    for vertex in bm.verts:
        total=sum(vertex[deform].values())
        if total<1e-8:vertex[deform][hand_index]=1
        else:
            for index in list(vertex[deform].keys()):vertex[deform][index]/=total
    bmesh.ops.recalc_face_normals(bm,faces=list(bm.faces))
    boundary_count=sum(edge.is_boundary for edge in bm.edges)
    bm.to_mesh(data);bm.free();data.update()
    refine_anatomy(mesh,landmarks,side)
    data=mesh.data
    modifier=mesh.modifiers.new('Finger skinning','ARMATURE');modifier.object=arm;mesh.parent=arm
    mat=bpy.data.materials.new('NaturalSkin');mat.use_nodes=True
    shader=mat.node_tree.nodes.get('Principled BSDF');shader.inputs['Roughness'].default_value=.61
    texture=mat.node_tree.nodes.new('ShaderNodeTexImage')
    texture.image=bpy.data.images.load(os.path.join(ROOT,'assets-source/arms/new_diff.png'),check_existing=True)
    mat.node_tree.links.new(texture.outputs['Color'],shader.inputs['Base Color']);mesh.data.materials.append(mat)
    bpy.ops.object.select_all(action='DESELECT');mesh.select_set(True);arm.select_set(True)
    bpy.context.view_layer.objects.active=arm
    bpy.ops.export_scene.gltf(filepath=os.path.join(OUT,'hand-'+side.lower()+'.glb'),use_selection=True,export_format='GLB',export_animations=False,export_yup=True,export_attributes=True)
    print('EXPORTED',side,len(data.vertices),'vertices',len(data.polygons),'faces',len(bones),'bones',len(caps),'wrist caps',boundary_count,'open boundary edges')
