import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {poseAnatomicalHand} from '../src/hands.ts';

type Accessor={bufferView:number;byteOffset?:number;componentType:number;count:number;type:string;normalized?:boolean;sparse?:unknown};
type Primitive={attributes:Record<string,number>;indices:number;material?:number;mode?:number};
type GLB={bytes:Buffer;binary:Buffer;json:any;accessor:(index:number)=>number[][]};
function readGLB(path:string):GLB {
 const bytes=readFileSync(new URL('../public/assets/'+path,import.meta.url));
 assert.equal(bytes.readUInt32LE(0),0x46546c67,'glTF magic');
 assert.equal(bytes.readUInt32LE(4),2,'glTF 2.0');
 assert.equal(bytes.readUInt32LE(8),bytes.length,'complete file');
 let json:any,binary:Buffer|undefined;
 for(let offset=12;offset<bytes.length;){
  const length=bytes.readUInt32LE(offset),type=bytes.readUInt32LE(offset+4);offset+=8;
  assert.ok(offset+length<=bytes.length,'chunk lies inside the GLB');
  if(type===0x4e4f534a)json=JSON.parse(bytes.subarray(offset,offset+length).toString('utf8'));
  if(type===0x004e4942)binary=bytes.subarray(offset,offset+length);
  offset+=length;
 }
 assert.ok(json&&binary,'JSON and binary chunks exist');
 assert.equal(json.buffers.length,1);assert.equal(json.buffers[0].uri,undefined,'geometry is embedded');
 assert.ok(json.buffers[0].byteLength<=binary.length);
 const componentSizes:Record<number,number>={5120:1,5121:1,5122:2,5123:2,5125:4,5126:4};
 const widths:Record<string,number>={SCALAR:1,VEC2:2,VEC3:3,VEC4:4,MAT4:16};
 const cache=new Map<number,number[][]>();
 const accessor=(index:number):number[][]=>{
  const cached=cache.get(index);if(cached)return cached;
  const a=json.accessors[index] as Accessor;assert.ok(a);assert.equal(a.sparse,undefined);
  const view=json.bufferViews[a.bufferView],size=componentSizes[a.componentType],width=widths[a.type];
  assert.ok(view&&size&&width);assert.equal(view.buffer??0,0);
  const stride=view.byteStride??size*width,start=(view.byteOffset??0)+(a.byteOffset??0);
  assert.ok(stride>=size*width);assert.ok((a.byteOffset??0)+(a.count-1)*stride+size*width<=view.byteLength,'accessor lies inside its buffer view');
  assert.ok(start+(a.count-1)*stride+size*width<=binary!.length,'accessor lies inside binary data');
  const read=(offset:number)=>{
   switch(a.componentType){
    case 5120:return binary!.readInt8(offset);case 5121:return binary!.readUInt8(offset);
    case 5122:return binary!.readInt16LE(offset);case 5123:return binary!.readUInt16LE(offset);
    case 5125:return binary!.readUInt32LE(offset);case 5126:return binary!.readFloatLE(offset);
    default:throw Error('Unsupported component type');
   }
  };
  const normalize=(n:number)=>a.normalized?({5120:Math.max(n/127,-1),5121:n/255,5122:Math.max(n/32767,-1),5123:n/65535,5125:n/4294967295,5126:n}[a.componentType]??n):n;
  const rows=Array.from({length:a.count},(_,row)=>Array.from({length:width},(_,column)=>normalize(read(start+row*stride+column*size))));
  cache.set(index,rows);return rows;
 };
 return{bytes,binary:binary!,json,accessor};
}
function primitives(asset:GLB):Primitive[]{return asset.json.meshes.flatMap((mesh:any)=>mesh.primitives);}
function embeddedPNG(asset:GLB,index:number){
 const image=asset.json.images[index];assert.equal(image.uri,undefined,'texture has no external URI');assert.equal(image.mimeType,'image/png');
 const view=asset.json.bufferViews[image.bufferView];assert.ok(view&&view.byteLength>1000,'embedded image has data');
 const data=asset.binary.subarray(view.byteOffset??0,(view.byteOffset??0)+view.byteLength);
 assert.deepEqual([...data.subarray(0,8)],[137,80,78,71,13,10,26,10],'embedded PNG signature');
 assert.ok(data.readUInt32BE(16)>=512&&data.readUInt32BE(20)>=512,'skin texture retains useful resolution');
}
function validateGeometry(asset:GLB){
 for(const primitive of primitives(asset)){
  assert.equal(primitive.mode??4,4,'triangle primitive');
  const positions=asset.accessor(primitive.attributes.POSITION),normals=asset.accessor(primitive.attributes.NORMAL),uv=asset.accessor(primitive.attributes.TEXCOORD_0);
  assert.ok(positions.length>0);assert.equal(normals.length,positions.length);assert.equal(uv.length,positions.length);
  for(const rows of [positions,normals,uv])assert.ok(rows.every(row=>row.every(Number.isFinite)),'finite positions, normals and UVs');
  for(const normal of normals)assert.ok(Math.abs(Math.hypot(...normal)-1)<1e-4,'unit surface normal');
  const indices=asset.accessor(primitive.indices).flat();assert.equal(indices.length%3,0);
  assert.ok(indices.every(index=>Number.isInteger(index)&&index>=0&&index<positions.length),'valid triangle indices');
 }
}

const handAssets={left:readGLB('arms/hand-l.glb'),right:readGLB('arms/hand-r.glb')};
for(const side of ['left','right'] as const){
 const asset=handAssets[side],suffix=side==='left'?'L':'R';
 test(`${side} hand GLB contains a real 20-joint skinned mesh with normalized weights`,()=>{
  validateGeometry(asset);assert.equal(asset.json.skins.length,1);
  const skin=asset.json.skins[0];assert.equal(skin.joints.length,20);assert.equal(new Set(skin.joints).size,20);
  const names=skin.joints.map((id:number)=>asset.json.nodes[id].name);
  assert.ok(names.includes('hand.'+suffix));
  for(const digit of ['f_index','f_middle','f_ring','f_pinky','thumb'])for(const segment of ['01','02','03'])assert.ok(names.includes(`${digit}.${segment}.${suffix}`),'all three joints of each digit exist');
  const inverseBind=asset.accessor(skin.inverseBindMatrices);assert.equal(inverseBind.length,20);assert.ok(inverseBind.every(row=>row.length===16&&row.every(Number.isFinite)));
  assert.ok(asset.json.nodes.some((node:any)=>node.mesh!==undefined&&node.skin===0),'skin is actually bound to geometry');
  const influenced=new Set<number>();
  for(const primitive of primitives(asset)){
   const positions=asset.accessor(primitive.attributes.POSITION),joints=asset.accessor(primitive.attributes.JOINTS_0),weights=asset.accessor(primitive.attributes.WEIGHTS_0);
   assert.equal(joints.length,positions.length);assert.equal(weights.length,positions.length);
   for(let i=0;i<weights.length;i++){
    assert.equal(weights[i].length,4);assert.equal(joints[i].length,4);
    assert.ok(weights[i].every(w=>Number.isFinite(w)&&w>=0&&w<=1));assert.ok(Math.abs(weights[i].reduce((a,b)=>a+b,0)-1)<1e-5,'weights sum to one');
    joints[i].forEach((joint,k)=>{assert.ok(Number.isInteger(joint)&&joint>=0&&joint<20);if(weights[i][k]>.01)influenced.add(joint);});
   }
  }
  for(const digit of ['f_index','f_middle','f_ring','f_pinky','thumb'])assert.ok(influenced.has(names.indexOf(`${digit}.03.${suffix}`)),'fingertip bone has actual skin influence');
  embeddedPNG(asset,0);
 });
 test(`${side} hand anatomical surface masks stay within the skinned mesh`,()=>{
  const primitive=primitives(asset)[0],positions=asset.accessor(primitive.attributes.POSITION);
  const surface=asset.accessor(primitive.attributes._SKIN_DETAIL);
  assert.equal(surface.length,positions.length,'every skinned vertex carries its surface masks');
  assert.ok(surface.every(row=>row.length===3&&row.every(value=>Number.isFinite(value)&&value>=0&&value<=1)),'valid nail, knuckle and palm masks');
  for(let channel=0;channel<3;channel++)assert.ok(surface.some(row=>row[channel]>.6),'each anatomical region has an active mask');
  // Nails belong at the fingers, never the wrist or central palm. In glTF
  // the wrist-to-fingertip direction is -Z; thumb nails begin near -.1 m.
  assert.ok(surface.every((row,index)=>row[0]<.1||positions[index][2]<-.09),'nail response is confined to distal digits');
 });
 test(`${side} hand wrist is planar and closed after welding UV and normal seam duplicates`,()=>{
  const primitive=primitives(asset)[0],positions=asset.accessor(primitive.attributes.POSITION),indices=asset.accessor(primitive.indices).flat();
  // glTF splits vertices at UV/normal seams. Weld positions to one micrometre
  // before checking topology; otherwise valid texture seams resemble holes.
  const welded=new Map<string,number>();
  const ids=positions.map(position=>{const key=position.map(v=>Math.round(v*1e6)).join(',');if(!welded.has(key))welded.set(key,welded.size);return welded.get(key)!;});
  const edges=new Map<string,{count:number;direction:number}>();let capTriangles=0,capArea=0;
  for(let i=0;i<indices.length;i+=3){
   const triangle=indices.slice(i,i+3),vertices=triangle.map(index=>positions[index]),ids3=triangle.map(index=>ids[index]);
   assert.equal(new Set(ids3).size,3,'no collapsed welded triangle');
   for(let k=0;k<3;k++){const a=ids3[k],b=ids3[(k+1)%3],key=a<b?`${a}:${b}`:`${b}:${a}`,edge=edges.get(key)??{count:0,direction:0};edge.count++;edge.direction+=a<b?1:-1;edges.set(key,edge);}
   // Blender's +Y hand axis becomes -Z in glTF; the -.025 wrist plane is +.025 Z.
   if(vertices.every(v=>Math.abs(v[2]-.025)<1e-6)){
    capTriangles++;const [a,b,c]=vertices;capArea+=Math.abs((b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]))/2;
   }
  }
  assert.ok(capTriangles>=3&&capArea>.0001,'a nonzero planar cap closes the wrist');
  for(const edge of edges.values()){assert.equal(edge.count,2,'every geometric edge has exactly two faces');assert.equal(edge.direction,0,'neighboring triangle winding agrees');}
  assert.ok(positions.every(v=>v[2]<=.025001),'forearm is cut at the intended wrist plane');
 });
 test(`${side} hand pose helper deforms the imported fingertip and returns to the same pose`,async()=>{
  const loader=new GLTFLoader();
  // Only image decoding is stubbed: real GLB nodes, skeleton, inverse binds,
  // geometry and weights pass through Three's production loader unchanged.
  loader.register(()=>({name:'test-image-decoder',loadTexture:()=>Promise.resolve(new THREE.Texture())}));
  const buffer=asset.bytes.buffer.slice(asset.bytes.byteOffset,asset.bytes.byteOffset+asset.bytes.byteLength);
  const gltf=await loader.parseAsync(buffer as ArrayBuffer,'');const group=gltf.scene;
  const bones:THREE.Bone[]=[];let mesh:THREE.SkinnedMesh|undefined;
  group.traverse(object=>{if(object instanceof THREE.Bone){object.userData.restQuaternion=object.quaternion.clone();bones.push(object);}if(object instanceof THREE.SkinnedMesh)mesh=object;});
  assert.equal(bones.length,20);assert.ok(mesh);assert.equal(mesh.skeleton.bones.length,20);group.userData.anatomical={bones,side};
  const finger=mesh.skeleton.bones.findIndex(b=>b.name.replace(/[._]/g,'')===`fmiddle03${suffix}`);assert.ok(finger>=0);
  const joints=mesh.geometry.getAttribute('skinIndex'),weights=mesh.geometry.getAttribute('skinWeight'),positions=mesh.geometry.getAttribute('position');
  const tips:number[]=[];for(let i=0;i<positions.count;i++)for(let k=0;k<4;k++)if(joints.getComponent(i,k)===finger&&weights.getComponent(i,k)>.5){tips.push(i);break;}
  assert.ok(tips.length>3,'real fingertip vertices selected');
  const sample=(openness:number)=>{poseAnatomicalHand(group,openness);group.updateMatrixWorld(true);mesh!.skeleton.update();return tips.map(i=>mesh!.applyBoneTransform(i,new THREE.Vector3().fromBufferAttribute(positions,i)));};
  const closed=sample(0),open=sample(1),closedAgain=sample(0);
  assert.ok(Math.max(...open.map((point,i)=>point.distanceTo(closed[i])))>.01,'opening changes skinned fingertip position');
  assert.ok(closedAgain.every((point,i)=>point.distanceTo(closed[i])<1e-7),'poses do not accumulate rotation');
  assert.ok(sample(-1).every((point,i)=>point.distanceTo(closed[i])<1e-7),'negative openness clamps closed');
  assert.ok(sample(2).every((point,i)=>point.distanceTo(open[i])<1e-7),'excess openness clamps open');
 });
}

test('anatomical head GLB has valid face geometry and an embedded skin texture',()=>{
 const head=readGLB('makehuman/human-head.glb');validateGeometry(head);
 const face=head.json.meshes.find((mesh:any)=>mesh.name==='MakeHuman continuous face topology');assert.ok(face,'anatomical face mesh is present');
 assert.ok(head.accessor(face.primitives[0].attributes.POSITION).length>4000,'continuous detailed face topology');
 const material=head.json.materials[face.primitives[0].material],texture=head.json.textures[material.pbrMetallicRoughness.baseColorTexture.index];embeddedPNG(head,texture.source);
});

test('anatomical head has a continuous closed neck and horizontal cap inside the collar',()=>{
 const head=readGLB('makehuman/human-head.glb');
 const face=head.json.meshes.find((mesh:any)=>mesh.name==='MakeHuman continuous face topology');
 const primitive=face.primitives[0],positions=head.accessor(primitive.attributes.POSITION),indices=head.accessor(primitive.indices).flat();
 const welded=new Map<string,number>();
 const ids=positions.map(position=>{const key=position.map(v=>Math.round(v*1e6)).join(',');if(!welded.has(key))welded.set(key,welded.size);return welded.get(key)!;});
 const edges=new Map<string,{count:number;direction:number}>();let capTriangles=0,capArea=0;
 for(let i=0;i<indices.length;i+=3){
  const triangle=indices.slice(i,i+3),vertices=triangle.map(index=>positions[index]),ids3=triangle.map(index=>ids[index]);
  assert.equal(new Set(ids3).size,3,'no collapsed neck or face triangle');
  for(let k=0;k<3;k++){const a=ids3[k],b=ids3[(k+1)%3],key=a<b?`${a}:${b}`:`${b}:${a}`,edge=edges.get(key)??{count:0,direction:0};edge.count++;edge.direction+=a<b?1:-1;edges.set(key,edge);}
  if(vertices.every(v=>Math.abs(v[1]+.05)<1e-6)){
   capTriangles++;const [a,b,c]=vertices;capArea+=Math.abs((b[0]-a[0])*(c[2]-a[2])-(b[2]-a[2])*(c[0]-a[0]))/2;
  }
 }
 assert.ok(capTriangles>=3&&capArea>.001,'neck closes with a nonzero horizontal cap');
 for(const edge of edges.values()){assert.equal(edge.count,2,'no open ragged edge after UV seam welding');assert.equal(edge.direction,0,'neck and face winding agrees');}
 assert.ok(positions.every(v=>v[1]>=-.050001),'no hanging neck triangles below the cap');
 assert.ok(positions.some(v=>v[1]<-.049999),'neck extends into the uniform collar');
 assert.ok(positions.filter(v=>v[1]<=0).every(v=>Math.hypot(v[0]/.050,(v[2]+.015)/.044)<=1.00001),'lower neck stays inside the collar ellipse without shoulder skin flares');
});
