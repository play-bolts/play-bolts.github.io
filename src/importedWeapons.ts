import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import type {Faction} from './config';

export type WeaponPoint=[number,number,number];
export interface ImportedWeaponProfile {
 faction:Faction;model:string;sourceUid:string;
 bounds:{min:WeaponPoint;max:WeaponPoint};
 muzzle:WeaponPoint;frontSight:WeaponPoint;rearSight:WeaponPoint;sightY:number;adsZ:number;
 rightStock:WeaponPoint;leftGrip:WeaponPoint;rightRotation?:WeaponPoint;leftRotation?:WeaponPoint;
 bolt:{origin:WeaponPoint;knobLocal:WeaponPoint;axis:WeaponPoint;lift:number;travel:number};
 chargerSeat:WeaponPoint;worldScale?:number;
}
const files:Record<Faction,string>={british:'enfield',russian:'mosin',german:'kar98k'};
const cache=new Map<Faction,{scene:THREE.Group;profile:ImportedWeaponProfile}>();
let grenadeSource:THREE.Group|undefined;
let loading:Promise<void>|undefined;

/** Open the original Kar98k notch and thicken its front blade slightly.
 * Work on the source vertices: sight height, optical axis, UVs, and the rest
 * of the rifle stay intact instead of drawing a second sight over the mesh. */
function fitKar98kSights(scene:THREE.Group){
 scene.updateMatrixWorld(true);
 scene.getObjectByName('furniture')?.traverse(object=>{
  if(!(object instanceof THREE.Mesh))return;
  const positions=object.geometry.getAttribute('position'),normals=object.geometry.getAttribute('normal');
  const inverse=object.matrixWorld.clone().invert(),toWorldNormal=new THREE.Matrix3().getNormalMatrix(object.matrixWorld),toLocalNormal=toWorldNormal.clone().invert();
  const point=new THREE.Vector3(),normal=new THREE.Vector3();let changed=false;
  for(let i=0;i<positions.count;i++){
   point.fromBufferAttribute(positions,i).applyMatrix4(object.matrixWorld);
   const x=Math.abs(point.x);let factor=1;
   if(point.z>-.489&&point.z<-.480&&point.y>.048&&x<.006){
    const fade=THREE.MathUtils.smoothstep(x,.0016,.006);factor=1+.4*(1-fade);
   }
   if(point.z> -1.0045&&point.z<-.9898&&point.y>.0462&&x<.0018)factor=1.4;
   if(factor===1)continue;
   point.x*=factor;point.applyMatrix4(inverse);positions.setXYZ(i,point.x,point.y,point.z);
   if(normals){normal.fromBufferAttribute(normals,i).applyMatrix3(toWorldNormal);normal.x/=factor;normal.normalize().applyMatrix3(toLocalNormal).normalize();normals.setXYZ(i,normal.x,normal.y,normal.z);}
   changed=true;
  }
  if(changed){positions.needsUpdate=true;if(normals)normals.needsUpdate=true;object.geometry.computeBoundingBox();object.geometry.computeBoundingSphere();}
 });
}

function validateProfile(profile:ImportedWeaponProfile) {
 if(!Object.hasOwn(files,profile.faction))throw new Error('Unknown imported rifle faction');
 for(const point of [profile.bounds.min,profile.bounds.max,profile.muzzle,profile.frontSight,profile.rearSight,profile.rightStock,profile.leftGrip,profile.bolt.origin,profile.bolt.knobLocal,profile.bolt.axis,profile.chargerSeat])
  if(!Array.isArray(point)||point.length!==3||!point.every(Number.isFinite))throw new Error(`Invalid ${profile.faction} rifle contact profile`);
 if(![profile.sightY,profile.adsZ,profile.bolt.lift,profile.bolt.travel].every(Number.isFinite)||new THREE.Vector3(...profile.frontSight).distanceTo(new THREE.Vector3(...profile.rearSight))<.15)
  throw new Error(`Invalid ${profile.faction} rifle sight/bolt profile`);
}

/** The offline validator uses the same parser, profile and mesh tree as the app. */
export async function loadImportedWeaponFromBuffer(buffer:ArrayBuffer,profile:ImportedWeaponProfile,loader=new GLTFLoader()):Promise<void> {
 validateProfile(profile);
 const gltf=await loader.parseAsync(buffer,'');
 const furniture=gltf.scene.getObjectByName('furniture'),bolt=gltf.scene.getObjectByName('bolt');
 if(!furniture||!bolt)throw new Error(`${profile.faction} source rifle lacks independent furniture/bolt groups`);
 gltf.scene.updateMatrixWorld(true);
 let vertices=0;
 gltf.scene.traverse(object=>{
  if(!(object instanceof THREE.Mesh))return;
  const position=object.geometry.getAttribute('position');vertices+=position.count;
  if(![...position.array].every(Number.isFinite))throw new Error(`${profile.faction} rifle has non-finite source vertices`);
  object.castShadow=object.receiveShadow=true;
 });
 if(!vertices)throw new Error(`${profile.faction} source rifle is empty`);
 if(profile.faction==='german')fitKar98kSights(gltf.scene);
 cache.set(profile.faction,{scene:gltf.scene,profile:structuredClone(profile)});
}

export function getImportedWeaponProfile(faction:Faction):Readonly<ImportedWeaponProfile>|undefined {
 return cache.get(faction)?.profile;
}

export async function loadImportedGrenadeFromBuffer(buffer:ArrayBuffer,loader=new GLTFLoader()):Promise<void> {
 const gltf=await loader.parseAsync(buffer,'');
 if(!gltf.scene.getObjectByName('furniture'))throw new Error('Imported grenade has no source furniture');
 let vertices=0;
 gltf.scene.traverse(object=>{if(object instanceof THREE.Mesh){
  const position=object.geometry.getAttribute('position');vertices+=position?.count??0;
  if(!position||![...position.array].every(Number.isFinite))throw new Error('Imported grenade has invalid source vertices');
 }});
 if(!vertices)throw new Error('Imported grenade is empty');
 grenadeSource=gltf.scene;
}

/** Source geometry, UVs and PBR maps are cached once before any scene is built. */
export function preloadImportedWeapons():Promise<void> {
 if(typeof window==='undefined')return Promise.resolve();
 return loading??=Promise.all([...Object.entries(files).map(async([faction,name])=>{
  const base=`${import.meta.env?.BASE_URL??'/'}assets/imported-weapons/${name}`;
  const [modelResponse,profileResponse]=await Promise.all([fetch(`${base}.glb`),fetch(`${base}-profile.json`)]);
  if(!modelResponse.ok||!profileResponse.ok)throw new Error(`Unable to load ${faction} source rifle`);
  const [buffer,profile]=await Promise.all([modelResponse.arrayBuffer(),profileResponse.json()]);
  if(profile.faction!==faction)throw new Error(`Wrong ${faction} rifle profile`);
  await loadImportedWeaponFromBuffer(buffer,profile);
 }),fetch(`${import.meta.env?.BASE_URL??'/'}assets/models/imported-stielhandgranate.glb`).then(async response=>{
  if(!response.ok)throw new Error('Unable to load source grenade');
  await loadImportedGrenadeFromBuffer(await response.arrayBuffer());
 })]).then(()=>{});
}

/** Clone disposable GPU resources per rifle. Disposing an old faction must not
 * invalidate the cache or another actor's geometry, maps or materials. Images
 * remain immutable shared decode results; textures themselves are independent. */
function cloneImportedScene(scene:THREE.Group):THREE.Group {
 const root=scene.clone(true),geometries=new Map<THREE.BufferGeometry,THREE.BufferGeometry>(),materials=new Map<THREE.Material,THREE.Material>(),textures=new Map<THREE.Texture,THREE.Texture>();
 const cloneMaterial=(material:THREE.Material)=>{
  let copy=materials.get(material);if(copy)return copy;
  copy=material.clone();materials.set(material,copy);
  for(const [key,value] of Object.entries(material))if(value instanceof THREE.Texture){
   let texture=textures.get(value);if(!texture){texture=value.clone();textures.set(value,texture);}
   (copy as unknown as Record<string,unknown>)[key]=texture;
  }
  return copy;
 };
 root.traverse(object=>{
  if(!(object instanceof THREE.Mesh))return;
  const original=object.geometry as THREE.BufferGeometry;
  let geometry=geometries.get(original);if(!geometry){geometry=original.clone();geometries.set(original,geometry);}
  object.geometry=geometry;object.material=Array.isArray(object.material)?object.material.map(cloneMaterial):cloneMaterial(object.material);
  object.castShadow=object.receiveShadow=true;
 });
 return root;
}

export function makeImportedWeapon(faction:Faction):THREE.Group|null {
 const source=cache.get(faction);if(!source)return null;
 const root=cloneImportedScene(source.scene);root.name=`rifle-${faction}`;root.userData.importedWeapon=true;root.userData.weaponProfile=structuredClone(source.profile);
 return root;
}

export function makeImportedGrenade():THREE.Group|null {
 if(!grenadeSource)return null;
 const root=cloneImportedScene(grenadeSource);root.userData.importedWeapon=true;return root;
}
