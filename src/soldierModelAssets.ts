import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {ConvexHull} from 'three/addons/math/ConvexHull.js';
import type {Faction} from './config';
import type {JointChain,SoldierRig} from './soldierAnimation';
import {makeSoldierHand} from './soldierHands';

export const SOLDIER_BONES=['pelvis','spine','neck','upperArmL','lowerArmL','handL','upperArmR','lowerArmR','handR','thighL','calfL','footL','thighR','calfR','footR'] as const;
export type SoldierBone=typeof SOLDIER_BONES[number];
type Point=[number,number,number];
export interface SoldierModelProfile {faction:Faction;label:string;sourceUid:string;bonePositions:Record<SoldierBone,Point>;height:number;}
export type SoldierBodyRig=Pick<SoldierRig,'pelvis'|'spine'|'neck'|'leftArm'|'rightArm'|'leftLeg'|'rightLeg'|'clothJoints'|'solePoints'|'hands'>;
interface Surface {name:string;geometry:THREE.BufferGeometry;material:THREE.Material|THREE.Material[];}
const cache=new Map<Faction,{surfaces:Surface[];profile:SoldierModelProfile;solePoints:NonNullable<SoldierRig['solePoints']>}>();
let loading:Promise<void>|undefined;
function soleHull(points:Point[]):Point[]{
 if(points.length<4)return points;
 const hull=new ConvexHull().setFromPoints(points.map(point=>new THREE.Vector3(...point))),corners=new Set<THREE.Vector3>();
 for(const face of hull.faces){let edge=face.edge;do{corners.add(edge.head().point);edge=edge.next;}while(edge!==face.edge);}
 return [...corners].map(point=>point.toArray() as Point);
}

/** Fit the source's oversized boots without changing the ankle pivots, sole
 * height or continuous skin. The correction fades out before the knee, so
 * the boot tops remain joined to the original trousers. */
function fitSovietBoots(geometry:THREE.BufferGeometry,profile:SoldierModelProfile){
 const positions=geometry.getAttribute('position'),normals=geometry.getAttribute('normal');
 for(let i=0;i<positions.count;i++){
  const x=positions.getX(i),y=positions.getY(i),z=positions.getZ(i);
  if(y>=.40)continue;
  const ankle=profile.bonePositions[x<0?'footL':'footR'];
  const t=Math.max(0,Math.min(1,(y-.18)/.22)),blend=t*t*(3-2*t);
  const sx=.78+.22*blend,sz=.80+.20*blend,derivative=6*t*(1-t)/.22;
  positions.setXYZ(i,ankle[0]+(x-ankle[0])*sx,y,ankle[2]+(z-ankle[2])*sz);
  if(normals){
   // Inverse-transpose of the tapered deformation: preserve the authored
   // smooth normals and UV seams instead of rebuilding a faceted boot.
   const nx=normals.getX(i)/sx,nz=normals.getZ(i)/sz;
   const normal=new THREE.Vector3(nx,normals.getY(i)-(x-ankle[0])*.22*derivative*nx-(z-ankle[2])*.20*derivative*nz,nz).normalize();
   normals.setXYZ(i,normal.x,normal.y,normal.z);
  }
 }
 positions.needsUpdate=true;if(normals)normals.needsUpdate=true;
}

function fittedMaterial(material:THREE.Material,faction:Faction):THREE.Material{
 if(faction!=='german'||material.name!=='german-painted-helmet'||!(material instanceof THREE.MeshStandardMaterial))return material;
 const helmet=material.clone();helmet.map=null;helmet.color.setHex(0x626262);
 helmet.normalScale.multiplyScalar(.65);
 helmet.userData.boltsSurfaceAdjustment='solid-gray-helmet';
 return helmet;
}

/** A fold in the British left trouser leg crosses x=0 in the source bind.
 * Its old position-based weights incorrectly attached that fold to the right
 * knee. Recover the garment's connected leg below the crotch, including UV
 * seam duplicates, and change only the side of existing leg influences. */
function fitBritishTrouserWeights(geometry:THREE.BufferGeometry){
 const position=geometry.getAttribute('position'),skin=geometry.getAttribute('skinIndex'),triangles=geometry.index;
 if(!triangles)return;
 const cutoff=.82,parent=Array.from({length:position.count},(_,i)=>i);
 const find=(i:number):number=>parent[i]===i?i:(parent[i]=find(parent[i]));
 const join=(a:number,b:number)=>{parent[find(a)]=find(b);};
 const welded=new Map<string,number>();
 for(let i=0;i<position.count;i++)if(position.getY(i)<cutoff){
  const key=[position.getX(i),position.getY(i),position.getZ(i)].map(value=>Math.round(value*1e5)).join(',');
  const previous=welded.get(key);if(previous===undefined)welded.set(key,i);else join(i,previous);
 }
 for(let i=0;i<triangles.count;i+=3){
  const a=triangles.getX(i),b=triangles.getX(i+1),c=triangles.getX(i+2);
  if(position.getY(a)<cutoff&&position.getY(b)<cutoff&&position.getY(c)<cutoff){join(a,b);join(b,c);}
 }
 const components=new Map<number,{count:number;x:number}>();
 for(let i=0;i<position.count;i++)if(position.getY(i)<cutoff){
  const root=find(i),part=components.get(root)??{count:0,x:0};part.count++;part.x+=position.getX(i);components.set(root,part);
 }
 for(let i=0;i<position.count;i++)if(position.getY(i)<cutoff){
  const part=components.get(find(i))!;if(part.count<10||Math.abs(part.x/part.count)<.04)continue;
  const side=part.x<0?9:12;
  for(let j=0;j<4;j++){const bone=skin.getComponent(i,j);if(bone>=9&&bone<=14)skin.setComponent(i,j,side+(bone-9)%3);}
 }
 skin.needsUpdate=true;
}

/** Shares the browser parser with offline asset validation. Source materials,
 * garment UVs and continuous four-weight skinning are preserved. */
export async function loadSoldierModelFromBuffer(buffer:ArrayBuffer,profile:SoldierModelProfile,loader=new GLTFLoader()):Promise<void> {
 for(const name of SOLDIER_BONES)if(!profile.bonePositions[name]?.every(Number.isFinite))throw new Error(`Invalid ${profile.faction} soldier bone ${name}`);
 const gltf=await loader.parseAsync(buffer,'');gltf.scene.updateMatrixWorld(true);const surfaces:Surface[]=[];
 gltf.scene.traverse(object=>{
  if(!(object instanceof THREE.SkinnedMesh))return;
  const materials=Array.isArray(object.material)?object.material:[object.material];
  // The shell has its own surface; removing its separate camouflage dressing
  // does not alter the head, uniform atlas or the helmet's original shape.
  if(profile.faction==='german'&&materials.every(material=>material.name==='german-foliage'||material.name==='german-helmet-wire'))return;
  const geometry=object.geometry.clone().applyMatrix4(object.matrixWorld);
  if(profile.faction==='russian'&&object.name==='russian-uniform')fitSovietBoots(geometry,profile);
  const index=geometry.getAttribute('skinIndex'),weight=geometry.getAttribute('skinWeight'),position=geometry.getAttribute('position');
  if(!index||!weight||!position)throw new Error(`Missing ${profile.faction} soldier skin attributes`);
  const mapping=object.skeleton.bones.map(bone=>SOLDIER_BONES.indexOf(bone.name as SoldierBone));
  const joints=new Uint16Array(index.count*4);
  for(let i=0;i<index.count;i++)for(let j=0;j<4;j++){
   const source=index.getComponent(i,j),mapped=mapping[source];
   if(weight.getComponent(i,j)>1e-7&&(mapped===undefined||mapped<0))throw new Error(`Unknown source soldier bone ${source}`);
   joints[i*4+j]=Math.max(0,mapped??0);
  }
  geometry.setAttribute('skinIndex',new THREE.Uint16BufferAttribute(joints,4));
  if(profile.faction==='british'&&object.name==='british-legs-31')fitBritishTrouserWeights(geometry);
  geometry.computeBoundingBox();geometry.computeBoundingSphere();
  if(![...position.array].every(Number.isFinite))throw new Error('Non-finite soldier source vertices');
  const material=Array.isArray(object.material)?object.material.map(material=>fittedMaterial(material,profile.faction)):fittedMaterial(object.material,profile.faction);
  surfaces.push({name:object.name,geometry,material});
 });
 if(!surfaces.length)throw new Error(`No continuous skinned surfaces in ${profile.faction} soldier`);
 const soles={left:new Map<string,Point>(),right:new Map<string,Point>()};
 for(const surface of surfaces){
  const positions=surface.geometry.getAttribute('position'),weights=surface.geometry.getAttribute('skinWeight'),indices=surface.geometry.getAttribute('skinIndex');
  for(let i=0;i<positions.count;i++)for(const [side,bone] of [['left','footL'],['right','footR']] as const){
   const joint=SOLDIER_BONES.indexOf(bone);let influence=0;
   for(let component=0;component<4;component++)if(indices.getComponent(i,component)===joint)influence+=weights.getComponent(i,component);
   // Only rigid sole/instep points: calf-blended boot tops do not define the
   // foot contact shape. Collapse duplicate UV-seam vertices in this cache.
   if(influence>.9999){
    const point=positions.itemSize===3?[positions.getX(i)-profile.bonePositions[bone][0],positions.getY(i)-profile.bonePositions[bone][1],positions.getZ(i)-profile.bonePositions[bone][2]] as Point:null;
    if(point)soles[side].set(point.map(value=>value.toFixed(6)).join(','),point);
   }
  }
 }
 // Only convex-hull vertices can be lowest under rotation. This exact
 // reduction avoids scanning thousands of detailed boot vertices each frame.
 cache.set(profile.faction,{surfaces,profile:structuredClone(profile),solePoints:{left:soleHull([...soles.left.values()]),right:soleHull([...soles.right.values()])}});
}

export function preloadSoldierModels():Promise<void>{
 if(typeof window==='undefined')return Promise.resolve();
 return loading??=Promise.all((['british','russian','german'] as const).map(async faction=>{
  const base=`${import.meta.env?.BASE_URL??'/'}assets/imported-soldiers/${faction}`;
  const [model,profile]=await Promise.all([fetch(`${base}.glb`),fetch(`${base}-profile.json`)]);
  if(!model.ok||!profile.ok)throw new Error(`Unable to load source ${faction} soldier`);
  await loadSoldierModelFromBuffer(await model.arrayBuffer(),await profile.json());
 })).then(()=>{});
}

/** The existing deterministic IK groups drive real skin bones. Elbows, knees,
 * shoulders and hips deform continuous source cloth instead of rigid tubes. */
export function makeImportedSoldierBody(faction:Faction,model:THREE.Group):SoldierBodyRig|null{
 const source=cache.get(faction);if(!source)return null;
 const points=source.profile.bonePositions,groups={} as Record<SoldierBone,THREE.Group>;
 const group=(name:SoldierBone,parent?:SoldierBone)=>{
  const node=new THREE.Group();node.name=name;node.position.set(...points[name]);
  if(parent){node.position.sub(new THREE.Vector3(...points[parent]));groups[parent].add(node);}else model.add(node);
  groups[name]=node;return node;
 };
 group('pelvis');group('spine','pelvis');group('neck','spine');
 const chain=(names:[SoldierBone,SoldierBone,SoldierBone],parent:SoldierBone):JointChain=>{
  const root=group(names[0],parent),middle=group(names[1],names[0]),end=group(names[2],names[1]);
  return{root,middle,end,upperLength:middle.position.length(),lowerLength:end.position.length()};
 };
 // Source profiles use screen-side labels in a +Z-facing bind. Anatomical
 // right is -X: it must operate the rifle's right-side bolt after its 180°
 // world rotation, rather than reaching across from the opposite shoulder.
 const leftArm=chain(['upperArmR','lowerArmR','handR'],'spine'),rightArm=chain(['upperArmL','lowerArmL','handL'],'spine');
 const leftLeg=chain(['thighL','calfL','footL'],'pelvis'),rightLeg=chain(['thighR','calfR','footR'],'pelvis');
 const leftHand=makeSoldierHand('left'),rightHand=makeSoldierHand('right');
 const hands=leftHand&&rightHand?{left:leftHand,right:rightHand}:undefined;
 if(hands){leftArm.end.add(hands.left.frame);rightArm.end.add(hands.right.frame);}
 const bones=SOLDIER_BONES.map(name=>{const bone=new THREE.Bone();bone.name=`skin-${name}`;groups[name].add(bone);return bone;});
 model.updateMatrixWorld(true);const skeleton=new THREE.Skeleton(bones);skeleton.calculateInverses();
 const materials=new Map<THREE.Material,THREE.Material>(),textures=new Map<THREE.Texture,THREE.Texture>();
 const copyMaterial=(material:THREE.Material)=>{
  let copy=materials.get(material);if(copy)return copy;
  copy=material.clone();materials.set(material,copy);
  for(const[key,value]of Object.entries(material))if(value instanceof THREE.Texture){let texture=textures.get(value);if(!texture){texture=value.clone();textures.set(value,texture);}(copy as unknown as Record<string,unknown>)[key]=texture;}
  return copy;
 };
 for(const surface of source.surfaces){
  const material=Array.isArray(surface.material)?surface.material.map(copyMaterial):copyMaterial(surface.material);
  const geometry=surface.geometry.clone();
  if(hands){
   // Remove the rigid source digits only when articulated replacements are
   // available. Keep the wrist transition strip under their cuffs, so the
   // original four-weight sleeve skin still meets the moving hand.
   const position=geometry.getAttribute('position'),weights=geometry.getAttribute('skinWeight'),indices=geometry.getAttribute('skinIndex');
   const remove=(vertex:number)=>{
    for(const name of ['handL','handR'] as const){
     let weight=0;for(let j=0;j<4;j++)if(indices.getComponent(vertex,j)===SOLDIER_BONES.indexOf(name))weight+=weights.getComponent(vertex,j);
     if(weight>.8&&position.getY(vertex)<points[name][1]-.003)return true;
    }
    return false;
   };
   const old=geometry.index,newIndices:number[]=[],groups=geometry.groups.length?geometry.groups:[{start:0,count:old?.count??position.count,materialIndex:0}];
   geometry.clearGroups();
   for(const group of groups){const start=newIndices.length;
    for(let i=group.start;i<group.start+group.count;i+=3){const a=old?old.getX(i):i,b=old?old.getX(i+1):i+1,c=old?old.getX(i+2):i+2;if(!(remove(a)&&remove(b)&&remove(c)))newIndices.push(a,b,c);}
    geometry.addGroup(start,newIndices.length-start,group.materialIndex);
   }
   geometry.setIndex(newIndices);
  }
  const mesh=new THREE.SkinnedMesh(geometry,material);mesh.name=surface.name;mesh.castShadow=mesh.receiveShadow=true;
  mesh.frustumCulled=false;model.add(mesh);mesh.bind(skeleton,new THREE.Matrix4());mesh.normalizeSkinWeights();
 }
 model.userData.importedSoldier=true;model.userData.authoredUniform=true;model.userData.soldierSource=source.profile.sourceUid;model.userData.uniform=source.profile.label;
 return{pelvis:groups.pelvis,spine:groups.spine,neck:groups.neck,leftArm,rightArm,leftLeg,rightLeg,clothJoints:[],solePoints:source.solePoints,hands};
}
