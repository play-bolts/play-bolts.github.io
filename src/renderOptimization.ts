import * as THREE from 'three';
import {mergeGeometries} from 'three/addons/utils/BufferGeometryUtils.js';

/** Only opt-in immutable arena meshes are baked. Canvas hems use the original
 * local vertex coordinates, so those meshes deliberately stay separate. Other
 * arena weathering uses world coordinates, which baking preserves exactly. */
export function batchArenaMeshes(root:THREE.Object3D,cellSize=12){
 root.updateMatrixWorld(true);
 const inverse=new THREE.Matrix4().copy(root.matrixWorld).invert();
 const groups=new Map<string,{material:THREE.Material;meshes:THREE.Mesh[]}>();
 root.traverse(object=>{
  if(!(object instanceof THREE.Mesh)||object instanceof THREE.InstancedMesh||!object.userData.arenaStaticBatch||Array.isArray(object.material))return;
  const material=object.material;
  if(material.transparent||material.userData.weathering==='canvas')return;
  const position=new THREE.Vector3().setFromMatrixPosition(object.matrixWorld).applyMatrix4(inverse);
  const key=`${material.uuid}/${Math.floor(position.x/cellSize)}/${Math.floor(position.z/cellSize)}/${object.castShadow}/${object.receiveShadow}/${object.renderOrder}`;
  const entry=groups.get(key)??{material,meshes:[] as THREE.Mesh[]};entry.meshes.push(object);groups.set(key,entry);
 });
 let before=0,after=0;
 const oldGeometry=new Set<THREE.BufferGeometry>();
 for(const {material,meshes} of groups.values()){
  before+=meshes.length;
  if(meshes.length<2){after++;continue;}
  const parts=meshes.map(mesh=>{
   const geometry=mesh.geometry.clone();
   geometry.applyMatrix4(new THREE.Matrix4().multiplyMatrices(inverse,mesh.matrixWorld));
   return geometry;
  });
  const geometry=mergeGeometries(parts,false);parts.forEach(part=>part.dispose());
  if(!geometry){after+=meshes.length;continue;}
  geometry.computeBoundingBox();geometry.computeBoundingSphere();
  const batch=new THREE.Mesh(geometry,material),first=meshes[0];
  batch.name='arena-static-batch';batch.castShadow=first.castShadow;batch.receiveShadow=first.receiveShadow;batch.renderOrder=first.renderOrder;
  batch.matrixAutoUpdate=false;root.add(batch);after++;
  for(const mesh of meshes){oldGeometry.add(mesh.geometry);mesh.removeFromParent();}
 }
 // A caller may opt in meshes that share geometry. Dispose only sources no
 // longer referenced anywhere in this scene; material/texture ownership stays
 // with the arena and is never transferred or cloned by batching.
 root.traverse(object=>{if(object instanceof THREE.Mesh)oldGeometry.delete(object.geometry);});
 oldGeometry.forEach(geometry=>geometry.dispose());
 root.traverse(object=>{if(object instanceof THREE.Mesh&&object.userData.arenaStaticBatch){object.updateMatrix();object.matrixAutoUpdate=false;}});
 const empty:THREE.Object3D[]=[];root.traverse(object=>{if(object!==root&&object instanceof THREE.Group&&object.children.length===0)empty.push(object);});
 empty.forEach(object=>object.removeFromParent());
 return{before,after};
}

export interface ModelActor {faction:string;renderIdentity?:string}
export interface ActorModelEntry<A extends ModelActor,M>{actor:A;identity:A|string;faction:string;model:M}
/** Network array indices shift when somebody leaves. Reuse by connection/actor
 * identity, never by name or transient array slot. Local matches use the actor
 * object's lifetime; a new local match therefore cannot inherit an old pose. */
export function reconcileActorModels<A extends ModelActor,M>(previous:ActorModelEntry<A,M>[],actors:readonly A[],create:(actor:A)=>M,remove:(model:M)=>void){
 const remaining=new Map(previous.map(entry=>[entry.identity,entry]));
 const next:ActorModelEntry<A,M>[]=[];
 for(const actor of actors){
  const identity=actor.renderIdentity??actor,old=remaining.get(identity);remaining.delete(identity);
  if(old&&old.faction===actor.faction){old.actor=actor;next.push(old);}
  else{if(old)remove(old.model);next.push({actor,identity,faction:actor.faction,model:create(actor)});}
 }
 for(const old of remaining.values())remove(old.model);
 return next;
}

/** Encloses every stance, released weapon and death direction, including lean.
 * The generous world envelope replaces unsafe bind-pose mesh culling. */
export const SOLDIER_RENDER_RADIUS=2.4;
const bodySphere=new THREE.Sphere(),shadowSphere=new THREE.Sphere(),shadowTravel=new THREE.Vector3();
export function soldierContributesToView(frustum:THREE.Frustum,actor:{x:number;y:number;z:number},shadowDirection:THREE.Vector3|null){
 bodySphere.center.set(actor.x,actor.y+.9,actor.z);bodySphere.radius=SOLDIER_RENDER_RADIUS;
 if(frustum.intersectsSphere(bodySphere))return true;
 if(!shadowDirection||shadowDirection.y>=-.001)return false;
 // Sweep the complete animation envelope down to the lowest receiver. An
 // offscreen soldier remains fully animated if any of its shadow may be seen.
 const travel=Math.max(0,bodySphere.center.y+bodySphere.radius+.05)/-shadowDirection.y;
 shadowTravel.copy(shadowDirection).multiplyScalar(travel);
 shadowSphere.center.copy(bodySphere.center).addScaledVector(shadowTravel,.5);
 shadowSphere.radius=bodySphere.radius+shadowTravel.length()*.5;
 return frustum.intersectsSphere(shadowSphere);
}
