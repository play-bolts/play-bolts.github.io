import * as THREE from 'three';
import {ConvexHull} from 'three/addons/math/ConvexHull.js';
import {anatomicalHandSource,poseAnatomicalHand} from './hands';
import type {WeaponSlot} from './config';

type Side='left'|'right';
export type DeathHandEnvelope=ReadonlyArray<readonly [number,number,number]>;
export type DeathHandEnvelopes=Readonly<Record<WeaponSlot,DeathHandEnvelope>>;
// The asset includes geometry, bind skeleton and rest transforms. Calibration
// is the fixed makeSoldierHand configuration, shared across factions. Changing
// or reloading an asset creates a new identity, never a stale shape-cache hit.
// Values contain only frozen numbers: no meshes, skeletons or GPU resources.
const envelopes=new WeakMap<THREE.Group,Partial<Record<Side,DeathHandEnvelopes>>>();

/** Called only while constructing a canonically calibrated world hand. The
 * initial startup reserves build the four variants; every subsequent actor,
 * including actors beyond those reserves, receives the immutable result.
 * No gameplay death path traverses vertices or builds a hull.
 *
 * sampleSoldierPose always replaces a dead actor's weapon pose with idle before
 * applying it: fingerOpen/boltGrip/thumbContact are zero for every faction.
 * Full release opens either hand to .7, including a grenade support hand.
 * The held item still matters for the right hand's rifle/cylinder grip.
 */
export function prepareDeathHandEnvelopes(hand:THREE.Group,frame:THREE.Group,side:Side):DeathHandEnvelopes {
 const source=anatomicalHandSource(hand);
 if(!source)throw new Error('Death envelopes require a loaded anatomical hand');
 const cached=envelopes.get(source)?.[side];if(cached)return cached;
 const bones=(hand.userData.anatomical as {bones:THREE.Bone[]}).bones;
 const rotations=bones.map(bone=>bone.quaternion.clone());
 const result={} as Record<WeaponSlot,DeathHandEnvelope>;
 try{
  for(const slot of ['rifle','grenade'] as const){
   poseAnatomicalHand(hand,.7,side==='right'&&slot==='grenade'?'cylinder':'rifle',0,0);
   frame.updateWorldMatrix(true,true);frame.updateMatrixWorld(true);
   const parentInverse=frame.parent?frame.parent.matrixWorld.clone().invert():new THREE.Matrix4();
   const points:THREE.Vector3[]=[];
   hand.traverse(object=>{
    if(!(object instanceof THREE.SkinnedMesh))return;
    object.skeleton.update();
    const toWrist=new THREE.Matrix4().multiplyMatrices(parentInverse,object.matrixWorld);
    for(let i=0;i<object.geometry.getAttribute('position').count;i++)points.push(object.getVertexPosition(i,new THREE.Vector3()).applyMatrix4(toWrist));
   });
   const hull=new ConvexHull().setFromPoints(points),corners=new Set<THREE.Vector3>();
   for(const face of hull.faces){let edge=face.edge;do{corners.add(edge.head().point);edge=edge.next;}while(edge!==face.edge);}
   result[slot]=Object.freeze([...corners].map(point=>Object.freeze([point.x,point.y,point.z] as const)));
  }
 }finally{
  bones.forEach((bone,index)=>bone.quaternion.copy(rotations[index]));
  frame.updateWorldMatrix(true,true);frame.updateMatrixWorld(true);
  hand.traverse(object=>{if(object instanceof THREE.SkinnedMesh)object.skeleton.update();});
 }
 const frozen=Object.freeze(result),entries=envelopes.get(source)??{};
 entries[side]=frozen;envelopes.set(source,entries);return frozen;
}
