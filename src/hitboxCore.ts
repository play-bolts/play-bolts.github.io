/** Exact CPU skeletal solver shared with the rendered rig's source pose and
 * fixed-limb IK. No meshes/textures/assets are required for a damage query. */
import * as THREE from 'three';
import data from './generated/hitboxData.json';
import {sampleSoldierPose,solveTwoBone,fitSourceFoot,type Triple,type SoldierPose} from './soldierAnimation';
import {initialMotion} from './soldierMotionState';
import type {ImportedWeaponProfile} from './importedWeapons';
import type {HitActor} from './hitboxes';
export interface BoneTransform {position:THREE.Vector3;rotation:THREE.Quaternion}
const down=new THREE.Vector3(0,-1,0);
const rotation=(v:Triple)=>new THREE.Quaternion().setFromEuler(new THREE.Euler(...v));
export function sampleHitboxCore(actor:HitActor,time:number):{pose:SoldierPose;bones:BoneTransform[]}{
 const state=actor.pose??initialMotion(actor,time);
 const pose=sampleSoldierPose({...actor,cooldown:0,recoil:actor.recoil??0},actor.faction,time,state,data.rigs[actor.faction].weaponProfile as unknown as ImportedWeaponProfile);
 const rig=data.rigs[actor.faction],bind=rig.bonePositions;
 const bones:BoneTransform[]=new Array(15);
 bones[0]={position:new THREE.Vector3(...pose.pelvis),rotation:rotation(pose.pelvisRotation)};
 const child=(index:number,parent:number,offset:number[],r:THREE.Quaternion)=>bones[index]={position:new THREE.Vector3(...offset).applyQuaternion(bones[parent].rotation).add(bones[parent].position),rotation:bones[parent].rotation.clone().multiply(r)};
 child(1,0,new THREE.Vector3(...bind.spine).sub(new THREE.Vector3(...bind.pelvis)).toArray(),rotation(pose.spineRotation));
 child(2,1,new THREE.Vector3(...bind.neck).sub(new THREE.Vector3(...bind.spine)).toArray(),rotation(pose.neckRotation));
 for(const [side,start]of [['left',9],['right',12]] as const){
  const suffix=side==='left'?'L':'R',hip=new THREE.Vector3(...bind[`thigh${suffix}`]).sub(new THREE.Vector3(...bind.pelvis));
  const upper=new THREE.Vector3(...bind[`calf${suffix}`]).distanceTo(new THREE.Vector3(...bind[`thigh${suffix}`])),lower=new THREE.Vector3(...bind[`foot${suffix}`]).distanceTo(new THREE.Vector3(...bind[`calf${suffix}`]));
  const footRotation=pose[`${side}FootRotation`]??pose.footRotation;
  const foot=fitSourceFoot(pose[`${side}Foot`],footRotation,rig.solePoints[side] as Triple[],pose.footRoll);
  const inverse=bones[0].rotation.clone().invert(),local=(v:Triple)=>new THREE.Vector3(...v).sub(bones[0].position).applyQuaternion(inverse);
  const floor=local([0,.11,0]),normal=local([0,1.11,0]).sub(floor).normalize();
  const result=solveTwoBone(hip,local(foot),local(pose[`${side}KneeHint`]),upper,lower,{normal,constant:floor.dot(normal)});
  bones[start]={position:hip.clone().applyQuaternion(bones[0].rotation).add(bones[0].position),rotation:bones[0].rotation.clone().multiply(new THREE.Quaternion().setFromUnitVectors(down,result.middle.clone().sub(hip).normalize()))};
  bones[start+1]={position:result.middle.clone().applyQuaternion(bones[0].rotation).add(bones[0].position),rotation:bones[0].rotation.clone().multiply(new THREE.Quaternion().setFromUnitVectors(down,result.end.clone().sub(result.middle).normalize()))};
  bones[start+2]={position:result.end.clone().applyQuaternion(bones[0].rotation).add(bones[0].position),rotation:rotation(footRotation)};
 }
 return{pose,bones};
}
