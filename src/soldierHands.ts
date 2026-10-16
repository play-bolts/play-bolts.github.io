import * as THREE from 'three';
import {configureRifleHand,handContactLocal,makeAnatomicalHand,poseAnatomicalHand} from './hands';
import type {WeaponPose} from './weaponAnimation';

export interface SoldierHand {
 hand:THREE.Group;frame:THREE.Group;normal:THREE.Vector3;
 palm:{mesh:THREE.SkinnedMesh;index:number};
 thumbWeight?:number;
}
const DOWN=new THREE.Vector3(0,-1,0);
function basis(normal:THREE.Vector3,fingers:THREE.Vector3){
 const x=normal.clone().normalize(),y=fingers.clone().addScaledVector(x,-fingers.dot(x)).normalize();
 return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x,y,new THREE.Vector3().crossVectors(x,y)));
}

/** Reuse the cached articulated hands, but calibrate their wrist and palm to
 * the soldier's neutral down-arm frame. Finger and skeleton resources are
 * cloned by makeAnatomicalHand; no actor can pose another actor's digits. */
export function makeSoldierHand(side:'left'|'right'):SoldierHand|undefined {
 const hand=makeAnatomicalHand(side);if(!hand)return;
 configureRifleHand(hand);
 const authored=hand.userData.anatomical.model as THREE.Group;
 const normal=new THREE.Vector3(side==='left'?-1:1,0,0),frame=new THREE.Group();frame.name=`articulated-${side}-hand`;
 const palmNormal=new THREE.Vector3(0,1,0).transformDirection(authored.matrix);
 const fingers=new THREE.Vector3(0,0,-1).transformDirection(authored.matrix);
 frame.quaternion.copy(basis(normal,DOWN).multiply(basis(palmNormal,fingers).invert()));
 hand.position.copy(hand.userData.wristSkinLocal??hand.userData.wristLocal).negate();frame.add(hand);
 hand.userData.supportThumbTurn=.30;
 hand.userData.supportThumbDirection=new THREE.Vector3(0,0,-1).transformDirection(authored.matrix);
 poseAnatomicalHand(hand,0);frame.updateMatrixWorld(true);
 const wanted=handContactLocal(hand);let palm:SoldierHand['palm']|undefined,distance=Infinity;
 hand.traverse(object=>{
  if(!(object instanceof THREE.SkinnedMesh))return;
  object.skeleton.update();const positions=object.geometry.getAttribute('position'),point=new THREE.Vector3();
  for(let index=0;index<positions.count;index++){
   point.fromBufferAttribute(positions,index);object.applyBoneTransform(index,point);object.localToWorld(point);hand.worldToLocal(point);
   const candidate=point.distanceToSquared(wanted);
   if(candidate<distance){distance=candidate;palm={mesh:object,index};}
  }
 });
 return palm?{hand,frame,normal,palm}:undefined;
}

export function poseSoldierHand(binding:SoldierHand,side:'left'|'right',weapon:WeaponPose,slot:'rifle'|'grenade',released:number){
 const open=slot==='grenade'&&side==='left'?.55:side==='right'?weapon.fingerOpen:0;
 poseAnatomicalHand(binding.hand,Math.max(open,released*.7),slot==='grenade'&&side==='right'?'cylinder':'rifle',side==='right'?weapon.thumbContact:0,side==='right'?weapon.boltGrip:0);
 binding.thumbWeight=side==='right'?weapon.thumbContact:0;
 binding.frame.updateWorldMatrix(true,true);
 binding.frame.updateMatrixWorld(true);
}

/** Actual skinned contact in the neutral wrist frame, including the loading
 * thumb. The coupled arm fit consumes this point after posing the fingers. */
const skinPosition=new THREE.Vector3(),skinInfluence=new THREE.Vector3(),skinMatrix=new THREE.Matrix4();
export function soldierHandContact(binding:SoldierHand,thumb=0):THREE.Vector3 {
 binding.frame.updateWorldMatrix(true,true);
 // SkinnedMesh refreshes bindMatrixInverse in updateMatrixWorld, not in
 // Object3D.updateWorldMatrix. Otherwise a local skin contact depends on
 // whichever world pose the actor occupied during the previous frame.
 binding.frame.updateMatrixWorld(true);
 const pointAt=(selected:SoldierHand['palm'])=>{
  const mesh=selected.mesh;mesh.skeleton.update();
  const position=skinPosition.fromBufferAttribute(mesh.geometry.getAttribute('position'),selected.index).applyMatrix4(mesh.bindMatrix);
  const indices=mesh.geometry.getAttribute('skinIndex'),weights=mesh.geometry.getAttribute('skinWeight'),point=new THREE.Vector3();
  for(let i=0;i<4;i++){
   const weight=weights.getComponent(selected.index,i);if(weight===0)continue;
   const bone=indices.getComponent(selected.index,i),matrix=skinMatrix.multiplyMatrices(mesh.skeleton.bones[bone].matrixWorld,mesh.skeleton.boneInverses[bone]);
   point.addScaledVector(skinInfluence.copy(position).applyMatrix4(matrix),weight);
  }
  return binding.frame.parent?binding.frame.parent.worldToLocal(point):point.applyMatrix4(skinMatrix.copy(binding.frame.matrixWorld).invert()).applyQuaternion(binding.frame.quaternion);
 };
 const palm=pointAt(binding.palm),marker=binding.hand.userData.thumbContact as SoldierHand['palm']|undefined;
 return marker&&thumb>0?palm.lerp(pointAt(marker),thumb):palm;
}
