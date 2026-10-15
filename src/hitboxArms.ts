import * as THREE from 'three';
import handData from './generated/handCollisionData.json';
import type {SoldierPose} from './soldierAnimation';
import type {WeaponPose} from './weaponAnimation';
import {clamp} from './config';
export type ArmTriple=[number,number,number];
export type ArmQuaternion=[number,number,number,number];
export interface ArmTransform {position:THREE.Vector3;rotation:THREE.Quaternion}
const DOWN=new THREE.Vector3(0,-1,0);

export function solveTwoBone(origin:THREE.Vector3,target:THREE.Vector3,hint:THREE.Vector3,upper:number,lower:number,contactPlane?:{normal:THREE.Vector3;constant:number}) {
  const direction=target.clone().sub(origin);let distance=direction.length();
  if(distance<1e-8)direction.set(0,-1,0);else direction.multiplyScalar(1/distance);
  distance=clamp(distance,Math.abs(upper-lower)+.00001,upper+lower-.00001);
  const reach=origin.clone().addScaledVector(direction,distance);
  const pole=hint.clone().sub(origin).addScaledVector(direction,-hint.clone().sub(origin).dot(direction));
  if(pole.lengthSq()<1e-8){pole.crossVectors(direction,Math.abs(direction.x)<.8?new THREE.Vector3(1,0,0):new THREE.Vector3(0,0,1));}
  pole.normalize();
  const along=(upper*upper-lower*lower+distance*distance)/(2*distance),height=Math.sqrt(Math.max(0,upper*upper-along*along));
  const center=origin.clone().addScaledVector(direction,along);
  if(contactPlane&&height>1e-8){
    // The knee lies on a circle around the hip-to-ankle axis. Rotate its pole
    // along that circle to clear the floor without stretching either segment
    // or moving a planted foot. Keep the closest side to the source knee.
    const up=contactPlane.normal.clone().addScaledVector(direction,-contactPlane.normal.dot(direction));
    const projectedLength=up.length();
    if(projectedLength>1e-8){
      up.multiplyScalar(1/projectedLength);
      const minimum=clamp((contactPlane.constant-center.dot(contactPlane.normal))/(height*projectedLength),-1,1);
      if(pole.dot(up)<minimum){
        const across=pole.clone().addScaledVector(up,-pole.dot(up));
        if(across.lengthSq()<1e-8)across.crossVectors(direction,up);
        pole.copy(up).multiplyScalar(minimum).addScaledVector(across.normalize(),Math.sqrt(Math.max(0,1-minimum*minimum)));
      }
    }
  }
  return{middle:center.addScaledVector(pole,height),end:reach};
}

export function solveArmGrip(origin:THREE.Vector3,contact:THREE.Vector3,offset:THREE.Vector3,desired:THREE.Quaternion,hint:THREE.Vector3,upper:number,lower:number,outward=new THREE.Vector3(Math.sign(origin.x)||1,0,0),limits?:{floor?:number;ceiling?:number}) {
  // Solve to the real palm through a neutral wrist. The composite lower
  // link includes the hand's measured wrist-to-contact offset; its length
  // changes with a thumb press, but the actual forearm never stretches.
  // This direct solution avoids multiple fixed points from alternating
  // hand rotation and wrist position during low, tightly folded poses.
  const composite=DOWN.clone().multiplyScalar(lower).add(offset),length=composite.length();
  const target=contact.clone();if(limits)target.z=Math.max(target.z,origin.z+.12);
  const reach=target.clone().sub(origin),distance=reach.length();
  const minimum=Math.sqrt(upper*upper+length*length+2*upper*length*Math.cos(145*Math.PI/180));
  if(distance<minimum||distance>upper+length-.004){
    if(distance<1e-7)reach.copy(outward);else reach.multiplyScalar(1/distance);
    target.copy(origin).addScaledVector(reach,clamp(distance,minimum,upper+length-.004));
  }
  const solved=solveTwoBone(origin,target,hint,upper,length);
  const axis=solved.end.clone().sub(origin).normalize(),center=origin.clone().addScaledVector(axis,solved.middle.clone().sub(origin).dot(axis));
  const radius=solved.middle.distanceTo(center),pole=solved.middle.clone().sub(center).normalize();
  if(limits&&radius>1e-7){
    // One outward/downward branch in body space. The forward contact
    // clearance prevents the reference axes from becoming collinear.
    const outside=outward.clone().addScaledVector(axis,-outward.dot(axis)).normalize();
    const down=new THREE.Vector3().crossVectors(axis,outside).normalize();if(down.y>0)down.negate();
    const sideDistance=center.clone().sub(origin).dot(outward),sideRadius=radius*outside.dot(outward);
    const maximum=Math.min(1.45,Math.acos(clamp((.015-sideDistance)/Math.max(1e-7,sideRadius),-1,1)));
    // Stay on the monotone side of the circle's lowest point. Starting at
    // the exact bottom gives zero floor gradient and two competing branches.
    const lowerLimit=Math.max(0,Math.min(maximum,Math.atan2(down.y,outside.y)+Math.PI-.10));
    // Read the elbow bias in body axes, not from a projected hint vector:
    // a hand passing opposite that vector otherwise flips its normalized
    // projection even though the authored hand path itself is continuous.
    const preference=clamp(Math.atan2(origin.y-hint.y,.15+Math.abs(hint.x-origin.x)),-.8,1.35);
    const px=Math.cos(preference),py=Math.sin(preference);let angle=clamp(preference,-maximum,lowerLimit);
    for(let i=0;i<32;i++){
      const c=Math.cos(angle),s=Math.sin(angle),y=center.y+radius*(outside.y*c+down.y*s),dy=radius*(-outside.y*s+down.y*c);
      const low=Math.min(0,y-(limits.floor??-Infinity)),high=Math.max(0,y-(limits.ceiling??Infinity));
      angle=clamp(angle-(px*s-py*c+8000*(low+high)*dy)*.6/(1+8000*radius*radius),-maximum,lowerLimit);
    }
    pole.copy(outside).multiplyScalar(Math.cos(angle)).addScaledVector(down,Math.sin(angle));
  }
  solved.middle.copy(center).addScaledVector(pole,radius);
  const desiredAxis=composite.clone().normalize().applyQuaternion(desired),actualAxis=solved.end.clone().sub(solved.middle).normalize();
  const rotation=new THREE.Quaternion().setFromUnitVectors(desiredAxis,actualAxis).multiply(desired);
  const wrist=solved.middle.clone().addScaledVector(DOWN.clone().applyQuaternion(rotation),lower);
  const palm=wrist.clone().add(offset.clone().applyQuaternion(rotation));
  return{middle:solved.middle,end:wrist,rotation,palm,error:palm.clone().sub(contact),swing:rotation.clone().multiply(desired.clone().invert())};
}

interface ContactNode {parent:number;name:string;position:number[];rotation:number[];scale:number[];stockThumbAxis?:number[];supportThumbAxis?:number[]}
interface ContactInfluence {node:number;point:number[];weight:number}
interface ContactData {normal:number[];stockGrip:boolean;nodes:ContactNode[];palm:ContactInfluence[];thumb?:ContactInfluence[]}
/** Exact FK for the few skin influences used by the arm solver. The generated
 * descriptor is source geometry/bind data, never sampled animation poses. */
export function sampleCollisionHandContact(side:'left'|'right',weapon:Pick<WeaponPose,'fingerOpen'|'thumbContact'|'boltGrip'>,slot:'rifle'|'grenade',released=0){
 const data=handData[side] as ContactData,grip=slot==='grenade'&&side==='right'?'cylinder':'rifle';
 const open=clamp(Math.max(slot==='grenade'&&side==='left'?.55:side==='right'?weapon.fingerOpen:0,released*.7),0,1);
 const press=side==='right'?weapon.thumbContact:0,grasp=side==='right'?weapon.boltGrip:0;
 const stockWeight=data.stockGrip&&grip==='rifle'?(1-press)*(1-grasp):0;
 const matrices:THREE.Matrix4[]=[],turn=new THREE.Quaternion(),axis=new THREE.Vector3(1,0,0);
 for(const node of data.nodes){
  const rotation=new THREE.Quaternion().fromArray(node.rotation),name=node.name;
  if(name.startsWith('f')){
   const segment=name.includes('01')?0:name.includes('02')?1:2,index=name.startsWith('findex');
   let base=(side==='right'?(index&&grip==='rifle'?[.30,.5,.38]:[.72,1.02,.75]):[.54,.85,.7])[segment];
   if(side==='right'&&index&&grip==='rifle')base=THREE.MathUtils.lerp(base,[.72,1.02,.75][segment],grasp);
   if(stockWeight>0){const stock=index?[.30,.50,.38]:name.startsWith('fpinky')?[.15,.30,.20]:name.startsWith('fring')?[.50,.50,.30]:[.65,.52,.38];base=THREE.MathUtils.lerp(base,stock[segment],stockWeight);}
   rotation.multiply(turn.setFromAxisAngle(axis,THREE.MathUtils.lerp(base*(1-open*.85),[.90,1.35,.95][segment],press)));
  }else if(name.startsWith('thumb')){
   const segment=name.includes('01')?0:name.includes('02')?1:2,curl=[.18,.32,.38][segment];
   rotation.multiply(turn.setFromAxisAngle(axis,THREE.MathUtils.lerp(curl*(1-open*.65),segment===0?-.15:segment===1?.08:.12,press)));
   if(node.supportThumbAxis)rotation.multiply(turn.setFromAxisAngle(new THREE.Vector3().fromArray(node.supportThumbAxis),.30));
   if(node.stockThumbAxis)rotation.multiply(turn.setFromAxisAngle(new THREE.Vector3().fromArray(node.stockThumbAxis),-1.5*stockWeight));
  }
  const local=new THREE.Matrix4().compose(new THREE.Vector3().fromArray(node.position),rotation,new THREE.Vector3().fromArray(node.scale));
  matrices.push(node.parent<0?local:matrices[node.parent].clone().multiply(local));
 }
 const point=(influences:ContactInfluence[])=>influences.reduce((sum,item)=>sum.addScaledVector(new THREE.Vector3().fromArray(item.point).applyMatrix4(matrices[item.node]),item.weight),new THREE.Vector3());
 const contact=point(data.palm);if(data.thumb&&press>0)contact.lerp(point(data.thumb),press);
 return{normal:new THREE.Vector3().fromArray(data.normal),contact};
}

export function palmFrame(normal:THREE.Vector3,fingers:THREE.Vector3){
 const x=normal.clone().normalize(),y=fingers.clone().addScaledVector(x,-fingers.dot(x)).normalize();
 return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x,y,new THREE.Vector3().crossVectors(x,y)));
}

export interface CollisionRifleTransform {position:number[];rotation:number[];scale:number[]}
export interface ArmRigData {
 bonePositions:Record<string,number[]>;
 rifle:CollisionRifleTransform;
 stockContacts:{left:number[];right:number[]};
}
export interface ArmChainInput {shoulder:THREE.Vector3;upper:number;lower:number}
export interface HandContactInput {normal:THREE.Vector3;contact:THREE.Vector3}
export type ArmGrip=ReturnType<typeof solveArmGrip>;
export interface HeldArmInput {
 left:ArmChainInput;right:ArmChainInput;rifle:CollisionRifleTransform;
 stockContacts:{left:number[];right:number[]};
 contacts?:{left:HandContactInput;right:HandContactInput};
}
const euler=(v:readonly number[])=>new THREE.Quaternion().setFromEuler(new THREE.Euler(v[0],v[1],v[2]));
/** Shared rendered/collision prop and arm solve, entirely in soldier model
 * space before its final lean/yaw transform. No scene graph or GPU work. */
export function solveHeldArms(pose:SoldierPose,input:HeldArmInput){
 const leftSource=new THREE.Vector3().fromArray(input.stockContacts.left);
 const rightSource=new THREE.Vector3(...pose.weapon.right).lerp(new THREE.Vector3().fromArray(input.stockContacts.right),1-Math.max(pose.weapon.boltGrip,pose.weapon.thumbContact,pose.weapon.fingerOpen));
 const riflePosition=new THREE.Vector3(...pose.riflePosition).add(new THREE.Vector3(.03,0,-.055));
 const rifleRotation=euler(pose.rifleRotation),handOrientation=euler(pose.heldWeapon==='grenade'?pose.grenadeRotation:pose.rifleRotation);
 const relaxedOrientation=euler(pose.pelvisRotation).multiply(euler(pose.spineRotation));
 const released=pose.death>0?pose.handRelease:0;
 const contacts=input.contacts??{
  left:sampleCollisionHandContact('left',pose.weapon,pose.heldWeapon,released),
  right:sampleCollisionHandContact('right',pose.weapon,pose.heldWeapon,released),
 };
 const hands={} as Record<'left'|'right',{rotation:THREE.Quaternion;contact:THREE.Vector3}>;
 for(const side of ['left','right'] as const){
  const bind=contacts[side],source=palmFrame(bind.normal,DOWN).invert();
  let rotation:THREE.Quaternion;
  if(pose.heldWeapon==='grenade'&&side==='left')rotation=relaxedOrientation.clone();
  else if(pose.heldWeapon==='grenade')rotation=handOrientation.clone().multiply(palmFrame(new THREE.Vector3(1,0,0),new THREE.Vector3(0,-.10,1))).multiply(source);
  else{
   const fingers=new THREE.Vector3(side==='left'?-.8:.8,0,.6),desired=palmFrame(new THREE.Vector3(0,1,0),fingers);
   if(side==='right'){
    desired.slerp(palmFrame(new THREE.Vector3(1,.2,0),new THREE.Vector3(0,-.35,1)),pose.weapon.boltGrip);
    desired.slerp(palmFrame(new THREE.Vector3(0,-1,0),fingers),pose.weapon.thumbContact);
   }
   rotation=handOrientation.clone().multiply(desired).multiply(source);
  }
  hands[side]={rotation:rotation.slerp(relaxedOrientation,released),contact:bind.contact.clone().multiplyScalar(1-released)};
 }
 const fit=(side:'left'|'right',target:THREE.Vector3)=>{
  const chain=input[side],hand=hands[side],hint=new THREE.Vector3(...(side==='left'?pose.leftElbowHint:pose.rightElbowHint));hint.z-=.25;
  return solveArmGrip(chain.shoulder,target,hand.contact,hand.rotation,hint,chain.upper,chain.lower,new THREE.Vector3(side==='left'?1:-1,0,0),pose.death>0?undefined:{floor:.11,ceiling:pose.heldWeapon==='rifle'?chain.shoulder.y-.025:undefined});
 };
 const localRifle=new THREE.Matrix4().compose(new THREE.Vector3().fromArray(input.rifle.position),new THREE.Quaternion().fromArray(input.rifle.rotation),new THREE.Vector3().fromArray(input.rifle.scale));
 const rifleMatrix=new THREE.Matrix4(),unit=new THREE.Vector3(1,1,1);
 const updateRifle=()=>rifleMatrix.compose(riflePosition,rifleRotation,unit).multiply(localRifle);
 updateRifle();
 const target=(point:THREE.Vector3)=>point.clone().applyMatrix4(rifleMatrix);
 if(pose.heldWeapon==='rifle'&&pose.handRelease===0){
  for(let iteration=0;iteration<20;iteration++){
   const left=fit('left',target(leftSource)),right=fit('right',target(rightSource));
   const leftError=left.error.length(),rightError=right.error.length();if(Math.max(leftError,rightError)<.00005)break;
   const correction=leftError>rightError?left.error:right.error;if(correction.length()>.045)correction.setLength(.045);
   riflePosition.add(correction);updateRifle();
  }
 }
 const leftTarget=target(leftSource),rightTarget=target(rightSource);
 if(pose.leftHand)leftTarget.lerp(new THREE.Vector3(...pose.leftHand),pose.handRelease);
 if(pose.rightHand)rightTarget.lerp(new THREE.Vector3(...pose.rightHand),pose.handRelease);
 return{left:fit('left',leftTarget),right:fit('right',rightTarget),riflePosition};
}

/** Six exact arm bone transforms in the imported skeleton's original index
 * order (3–5 anatomical right,6–8 anatomical left). Lean is applied by caller. */
export function solveHitboxArms(pose:SoldierPose,spine:ArmTransform,rig:ArmRigData){
 const chain=(side:'left'|'right'):ArmChainInput=>{
  const suffix=side==='left'?'R':'L',root=new THREE.Vector3().fromArray(rig.bonePositions[`upperArm${suffix}`]);
  const middle=new THREE.Vector3().fromArray(rig.bonePositions[`lowerArm${suffix}`]),end=new THREE.Vector3().fromArray(rig.bonePositions[`hand${suffix}`]);
  return{shoulder:root.clone().sub(new THREE.Vector3().fromArray(rig.bonePositions.spine)).applyQuaternion(spine.rotation).add(spine.position),upper:root.distanceTo(middle),lower:middle.distanceTo(end)};
 };
 const left=chain('left'),right=chain('right'),result=solveHeldArms(pose,{left,right,rifle:rig.rifle,stockContacts:rig.stockContacts});
 const bones:ArmTransform[]=new Array(15),inverse=spine.rotation.clone().invert();
 for(const [side,start]of [['left',6],['right',3]] as const){
  const arm=side==='left'?left:right,grip=result[side];
  const upperDirection=grip.middle.clone().sub(arm.shoulder).applyQuaternion(inverse).normalize();
  const handInParent=inverse.clone().multiply(grip.rotation),handAxis=DOWN.clone().applyQuaternion(handInParent);
  const lowerDirection=grip.end.clone().sub(grip.middle).applyQuaternion(inverse).normalize();
  bones[start]={position:arm.shoulder.clone(),rotation:spine.rotation.clone().multiply(new THREE.Quaternion().setFromUnitVectors(DOWN,upperDirection))};
  bones[start+1]={position:grip.middle.clone(),rotation:spine.rotation.clone().multiply(new THREE.Quaternion().setFromUnitVectors(handAxis,lowerDirection).multiply(handInParent))};
  bones[start+2]={position:grip.end.clone(),rotation:grip.rotation.clone()};
 }
 return{...result,bones};
}
