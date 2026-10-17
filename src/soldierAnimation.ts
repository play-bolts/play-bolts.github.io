import * as THREE from 'three';
import {ConvexHull} from 'three/addons/math/ConvexHull.js';
import {WEAPONS,WEAPON_SWITCH_SECONDS,clamp,lerp,type Faction,type Stance,type WeaponSlot} from './config';
import {applyWeaponAnimation,sampleWeaponAnimation,sampleWeaponSwitch,sampleGrenadeMelee,MELEE_ANIMATION_SECONDS,type WeaponPose,type WeaponAction} from './weaponAnimation';
import {sampleBodyMotion,sourceGaitRate,proceduralBootClearance} from './soldierMotion';
import {soleRollOffset} from './footRoll';
import {solveTwoBone,solveArmGrip,solveHeldArms} from './hitboxArms';
export {solveTwoBone,solveArmGrip} from './hitboxArms';
import type {ImportedWeaponProfile} from './importedWeapons';
import type {SoldierMotionState} from './soldierMotionState';
import {poseSoldierHand,soldierHandContact,type SoldierHand} from './soldierHands';

export type Triple=[number,number,number];
export interface SoldierActor {
  id:number;x:number;y:number;z:number;yaw:number;pitch:number;stance:Stance;
  lean?:number;pose?:SoldierMotionState;
  alive:boolean;moving:number;ads:boolean;recoil:number;cooldown:number;reload:number;reloadTotal:number;
  hp?:number;deadAt?:number;lastShotTime?:number;lastHurtTime?:number;lastMeleeTime?:number;
  deathYaw?:number;deathHeadshot?:boolean;
  grounded?:boolean;vy?:number;jumpStarted?:number;landedAt?:number;landingSpeed?:number;
  selectedWeapon?:WeaponSlot;switchFrom?:WeaponSlot;switchStarted?:number;switchDuration?:number;
}
export interface JointChain {
  root:THREE.Group;middle:THREE.Group;end:THREE.Group;upperLength:number;lowerLength:number;
}
export interface ClothJoint {
  mesh:THREE.Mesh;chain:JointChain;radius:number;depth:number;reach:number;
}
export interface SoldierRig {
  faction:Faction;pelvis:THREE.Group;spine:THREE.Group;neck:THREE.Group;
  leftArm:JointChain;rightArm:JointChain;leftLeg:JointChain;rightLeg:JointChain;
  riflePivot:THREE.Group;rifle:THREE.Group;clip:THREE.Group;clipRounds:THREE.Group;
  clothJoints?:ClothJoint[];grenade?:THREE.Group;
  solePoints?:{left:ReadonlyArray<Triple>;right:ReadonlyArray<Triple>};
  hands?:{left:SoldierHand;right:SoldierHand};
  stockContacts?:{left:Triple;right:Triple};
}
export interface SoldierBlend {
  crouch:number;prone:number;aim:number;speed:number;phase:number;forward:number;sideways:number;
}
export interface SoldierPose {
  pelvis:Triple;pelvisRotation:Triple;spineRotation:Triple;neckRotation:Triple;
  leftFoot:Triple;rightFoot:Triple;leftKneeHint:Triple;rightKneeHint:Triple;footRotation:Triple;
  leftFootRotation?:Triple;rightFootRotation?:Triple;footRoll?:number;
  riflePosition:Triple;rifleRotation:Triple;weapon:WeaponPose;
  heldWeapon:WeaponSlot;itemVisible:boolean;grenadeRotation:Triple;
  leftElbowHint:Triple;rightElbowHint:Triple;
  leftHand?:Triple;rightHand?:Triple;handRelease:number;death:number;stage:string;lean?:number;
  /** Stable anatomical release pose; never part of live collision state. */
  deathStart?:SoldierPose;
}
interface RigState extends SoldierBlend {
  time:number;alive:boolean;hp:number;x:number;z:number;deathAt:number;hurtAt:number;
  deathBlend?:SoldierBlend;
}
const TAU=Math.PI*2,DOWN=new THREE.Vector3(0,-1,0);
const ease=(t:number)=>{const v=clamp(t,0,1);return v*v*(3-2*v);};
const blend3=(a:Triple,b:Triple,t:number):Triple=>t<=0?[...a]:t>=1?[...b]:a.map((v,i)=>lerp(v,b[i],t)) as Triple;
const elapsed=(time:number,event?:number)=>event===undefined?Infinity:time-event;
function poseKeys(t:number,points:Array<[number,Triple]>):Triple {
  if(t<=points[0][0])return [...points[0][1]];
  for(let i=1;i<points.length;i++)if(t<=points[i][0])return blend3(points[i-1][1],points[i][1],ease((t-points[i-1][0])/(points[i][0]-points[i-1][0])));
  return [...points[points.length-1][1]];
}
function blendRotation(a:Triple,b:THREE.Quaternion,t:number):Triple {
  const rotation=new THREE.Quaternion().setFromEuler(new THREE.Euler(...a)).slerp(b,t);
  const euler=new THREE.Euler().setFromQuaternion(rotation);
  return [euler.x,euler.y,euler.z];
}

/** Pure pose layer: locomotion/stance, aim, manipulation and additive hit
 * response are composed in model space. The clock is simulation/replay time. */
export function sampleSoldierPose(actor:SoldierActor,faction:Faction,time:number,blend?:Partial<SoldierBlend>,profileOverride?:Readonly<ImportedWeaponProfile>):SoldierPose {
  const variation=actor.pose?0:actor.id;
  const crouch=blend?.crouch??Number(actor.stance==='crouch'),prone=blend?.prone??Number(actor.stance==='prone');
  const aim=blend?.aim??Number(actor.ads),speed=blend?.speed??actor.moving;
  const phase=blend?.phase??time*sourceGaitRate(speed,crouch,prone)+actor.id*.19;
  const fwd=blend?.forward??1,side=blend?.sideways??0;
  const breathe=Math.sin(time*1.85+variation)*.0023;
  const hurtElapsed=elapsed(time,actor.lastHurtTime),hurt=hurtElapsed>=0&&hurtElapsed<.42?Math.sin(hurtElapsed/.42*Math.PI)*Math.exp(-hurtElapsed*3):0;
  const shotElapsed=elapsed(time,actor.lastShotTime),meleeElapsed=elapsed(time,actor.lastMeleeTime);
  let action:WeaponAction='idle',progress=0;
  if(meleeElapsed>=0&&meleeElapsed<MELEE_ANIMATION_SECONDS){action='melee';progress=meleeElapsed/MELEE_ANIMATION_SECONDS;}
  else if(actor.reload>0){action='reload';progress=1-actor.reload/Math.max(.01,actor.reloadTotal);}
  else if(shotElapsed>=0&&shotElapsed<WEAPONS[faction].cycle){action='cycle';progress=shotElapsed/WEAPONS[faction].cycle;}
  const worldRotationScale=action==='melee'&&(actor.selectedWeapon??'rifle')==='rifle'?1:.7;
  const weapon=sampleWeaponAnimation(faction,action,progress,faction==='british'&&actor.reloadTotal>WEAPONS.british.reload*.8,profileOverride);
  const manipulation=Math.max(weapon.boltGrip,weapon.thumbContact,weapon.fingerOpen);
  // A world soldier brings the action into the working space below the face.
  // Applying the full look pitch to a first-person charger track can send
  // the wrist through the shoulder when the player looks steeply upwards.
  const heldPitch=actor.pitch*(1-manipulation*.75),heldAim=aim*(1-manipulation*.75);
  const motionTime=actor.alive?time:(Number.isFinite(actor.deadAt)?actor.deadAt!:time);
  const body=sampleBodyMotion({speed,crouch,prone,phase:actor.alive?phase:(blend?.phase??motionTime*sourceGaitRate(speed,crouch,prone)+actor.id*.19),time:motionTime,forward:fwd,sideways:side,
    grounded:actor.grounded,vy:actor.vy,jumpStarted:actor.jumpStarted,landedAt:actor.landedAt,landingSpeed:actor.landingSpeed});
  const spineRotation:Triple=[body.spineRotation[0]-actor.pitch*.15*aim-hurt*.13,body.spineRotation[1],body.spineRotation[2]+hurt*(variation%2?-.06:.06)];
  // Weapon contacts follow the solved torso, including landing compression.
  const hipOrientation=new THREE.Quaternion().setFromEuler(new THREE.Euler(...body.pelvisRotation));
  const chestOrientation=hipOrientation.clone().multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(...spineRotation)));
  const neck=new THREE.Vector3(...body.pelvis).add(new THREE.Vector3(0,.11,0).applyQuaternion(hipOrientation)).add(new THREE.Vector3(0,.51,0).applyQuaternion(chestOrientation));
  const head=new THREE.Quaternion().setFromEuler(new THREE.Euler(-actor.pitch*.73,Math.sin(time*.7+variation)*.016*(1-aim),0));
  const neckOrientation=new THREE.Euler().setFromQuaternion(chestOrientation.clone().invert().multiply(head));
  const pose:SoldierPose={
    pelvis:body.pelvis,pelvisRotation:body.pelvisRotation,spineRotation,
    neckRotation:[neckOrientation.x,neckOrientation.y,neckOrientation.z],
    leftFoot:body.leftFoot,rightFoot:body.rightFoot,leftKneeHint:body.leftKnee,rightKneeHint:body.rightKnee,
    footRotation:[prone*.10,prone*Math.PI,0],leftFootRotation:body.leftFootRotation,rightFootRotation:body.rightFootRotation,footRoll:body.footRoll,
    riflePosition:[neck.x-.085-weapon.position[0]*.65,neck.y+lerp(lerp(-.175,.04,heldAim)-manipulation*.07,.11-manipulation*.035,prone)+breathe+weapon.position[1]*.65-hurt*.025,neck.z+lerp(lerp(.115,.025,heldAim),.025,prone)-weapon.position[2]*.65],
    rifleRotation:[-heldPitch-Math.min(.09,actor.recoil)-weapon.rotation[0]*worldRotationScale,weapon.rotation[1]*worldRotationScale,-weapon.rotation[2]*worldRotationScale],
    leftElbowHint:[neck.x+.34,neck.y+lerp(-.47,-.10,prone),neck.z+lerp(.20,.15,prone)],rightElbowHint:[neck.x-.36,neck.y+lerp(-.42,-.10,prone),neck.z+lerp(.07,.03,prone)],
    weapon,heldWeapon:actor.selectedWeapon??'rifle',itemVisible:true,grenadeRotation:[0,0,0],handRelease:0,death:0,stage:action!=='idle'?weapon.stage:body.stage==='Idle'&&aim>.5?'Aiming':body.stage,
  };
  const equipmentTime=!actor.alive&&Number.isFinite(actor.deadAt)?actor.deadAt!:time;
  const switchAge=elapsed(equipmentTime,actor.switchStarted),switchDuration=actor.switchDuration??WEAPON_SWITCH_SECONDS;
  const switching=switchAge>=0&&switchAge<switchDuration,switchPose=sampleWeaponSwitch(switching?switchAge/switchDuration:1);
  if(switching) {
    pose.heldWeapon=switchPose.item==='from'?(actor.switchFrom??'rifle'):(actor.selectedWeapon??'rifle');
    pose.itemVisible=!switchPose.hidden;pose.stage=switchPose.stage;
    pose.riflePosition[1]+=switchPose.position[1]*.65;
    pose.riflePosition[2]-=switchPose.position[2]*.35;
    pose.rifleRotation[0]-=switchPose.rotation[0]*.5;
  }
  if(pose.heldWeapon==='grenade') {
    const ready:Triple=[neck.x-.25,neck.y+lerp(-.36,.05,prone),neck.z+lerp(.22,.10,prone)];
    // Attach this carried item to the solved palm, including low stances.
    pose.rightHand=ready;
    pose.leftHand=[neck.x+.25,neck.y+lerp(-.60,-.11,prone),neck.z+lerp(.14,-.03,prone)];
    pose.rightHand[1]+=switchPose.position[1]*.5;pose.leftHand[1]+=switchPose.position[1]*.3;
    pose.handRelease=1;
    pose.rightElbowHint=[neck.x-.39,neck.y+lerp(-.34,-.07,prone),neck.z+lerp(.02,-.07,prone)];
    pose.weapon=sampleWeaponAnimation(faction,'idle',0,false,profileOverride);
    if(action==='melee'&&!switching){
      const bash=sampleGrenadeMelee(progress);
      pose.rightHand[0]-=bash.position[0];pose.rightHand[1]+=bash.position[1];pose.rightHand[2]-=bash.position[2];
      pose.grenadeRotation=[-bash.rotation[0],-bash.rotation[1],bash.rotation[2]];
      pose.rightElbowHint[1]+=Math.max(0,bash.position[1])*.55;
      pose.stage=bash.stage;
    }
  }
  if(!actor.alive) {
    const deathTime=Number.isFinite(actor.deadAt)?actor.deadAt!:time;
    pose.deathStart=sampleSoldierPose({...actor,alive:true},faction,deathTime,blend,profileOverride);
    if(body.footRoll===0){delete pose.leftFootRotation;delete pose.rightFootRotation;}
    const age=Math.max(0,time-(Number.isFinite(actor.deadAt)?actor.deadAt!:time));
    const death=ease(age/1.03),fall=ease((age-.12)/.59),release=ease((age-.08)/.26);
    // Fall in the recorded impact direction. A prone soldier only slumps;
    // already lying bodies must never spring upright to play a standing fall.
    const localYaw=(actor.deathYaw??actor.yaw+Math.PI+(variation%2?.20:-.20))-actor.yaw;
    const dx=Math.sin(localYaw),dz=Math.cos(localYaw),side=variation%2?1:-1;
    // Source chest depth differs by uniform. Settle a face-down torso onto
    // the ground only after the early fall; a common .285m hip height leaves
    // the Soviet chest suspended like a held push-up. Back/side falls retain
    // their existing clearance for packs and shoulder width.
    const faceDownDrop={british:.120,russian:.130,german:.075}[faction],groundSettle=ease((age-.46)/.48);
    const direction=new THREE.Vector3(dx,0,dz),across=new THREE.Vector3(dz,0,-dx);
    const point=(along:number,lateral:number,y:number):Triple=>[dx*along+across.x*lateral,y,dz*along+across.z*lateral];
    pose.death=death;pose.stage=age<.12?'Impact':age<.34?'Knees buckle':age<.71?'Fall':age<1.03?'Ground contact':'Dead';
    if(prone>.5) {
      const slump=ease(age/.42);
      pose.pelvis=blend3(pose.pelvis,[side*.025,.205,-.07],slump);
      pose.pelvisRotation=blend3(pose.pelvisRotation,[1.57,0,side*.07],slump);
      pose.spineRotation=blend3(pose.spineRotation,[.015,side*.055,.025],slump);
      pose.neckRotation=blend3(pose.neckRotation,[-.12,side*.18,side*.07],slump);
      pose.leftFoot=blend3(pose.leftFoot,[-.20,.102,-.73],slump);
      pose.rightFoot=blend3(pose.rightFoot,[.23,.102,-.66],slump);
      pose.leftKneeHint=blend3(pose.leftKneeHint,[-.4,.16,-.35],slump);
      pose.rightKneeHint=blend3(pose.rightKneeHint,[.4,.16,-.32],slump);
      pose.footRotation=blend3(pose.footRotation,[.05,Math.PI,0],slump);
      pose.riflePosition=blend3(pose.riflePosition,[.31,.115,.63],slump);
      pose.rifleRotation=blend3(pose.rifleRotation,[.015,.26,.12],slump);
      pose.leftHand=[.34,.13,.68];pose.rightHand=[-.37,.14,.61];pose.handRelease=slump;
      pose.leftElbowHint=blend3(pose.leftElbowHint,[.4,.12,.38],slump);pose.rightElbowHint=blend3(pose.rightElbowHint,[-.44,.12,.32],slump);
      pose.pelvis[1]-=Math.max(0,faceDownDrop-.08)*groundSettle;
    } else {
      const start=pose.pelvis as Triple,ground=point(.12,side*.018,.285);
      pose.pelvis=poseKeys(age,[[0,start],[.12,[start[0],Math.max(.30,start[1]-.055),start[2]]],[.31,point(.04,0,Math.max(.30,start[1]*.62))],[.70,point(.12,side*.018,.263)],[.80,point(.12,side*.018,.305)],[1.03,ground]]);
      const fallRotation=new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0,1,0),direction);
      pose.pelvisRotation=blendRotation(pose.pelvisRotation,fallRotation,fall);
      // Chest and head react first, then lag behind the pelvis on contact.
      const impact=Math.sin(Math.PI*clamp(age/.34,0,1))*(actor.deathHeadshot?.18:.09);
      pose.spineRotation=blend3([pose.spineRotation[0]-dz*impact,pose.spineRotation[1],-dx*impact],[0,side*.035,0],ease((age-.32)/.58));
      pose.neckRotation=blend3([pose.neckRotation[0]-dz*impact*1.9,pose.neckRotation[1],-dx*impact*1.4],[-.06,side*.16,side*.04],ease((age-.23)/.68));
      const feet=ease((age-.22)/.51);
      pose.leftFoot=blend3(pose.leftFoot,point(-.46,-.18,.102),feet);
      pose.rightFoot=blend3(pose.rightFoot,point(-.54,.20,.102),feet);
      pose.leftKneeHint=blend3(pose.leftKneeHint,point(-.23,-.25,.23),fall);
      pose.rightKneeHint=blend3(pose.rightKneeHint,point(-.24,.27,.19),fall);
      pose.footRotation=blend3(pose.footRotation,[-.025,localYaw+Math.PI,side*.04],fall);
      pose.riflePosition=poseKeys(age,[[0,pose.riflePosition],[.19,point(.18,.16,Math.max(.4,pose.riflePosition[1]-.10))],[.60,point(.32,.34,.13)],[.71,point(.34,.35,.17)],[.88,point(.34,.35,.13)]]);
      pose.rifleRotation=blend3(pose.rifleRotation,[.015,localYaw+.62,.12],ease((age-.10)/.65));
      pose.leftHand=point(.54,.31,.13);pose.rightHand=point(.64,-.26,.14);pose.handRelease=release;
      pose.leftElbowHint=blend3(pose.leftElbowHint,point(.38,.40,.12),fall);pose.rightElbowHint=blend3(pose.rightElbowHint,point(.40,-.42,.12),fall);
      pose.pelvis[1]-=faceDownDrop*Math.max(0,dz)**4*groundSettle;
    }
    // A crouched heel may still be raised at impact. Preserve that contact
    // until the feet release, instead of snapping the boot flat at death.
    if(body.footRoll>0){
      const release=ease((age-.22)/.51);
      pose.footRoll=body.footRoll*(1-release);
      pose.leftFootRotation=blend3(body.leftFootRotation,pose.footRotation,release);
      pose.rightFootRotation=blend3(body.rightFootRotation,pose.footRotation,release);
    }
    pose.weapon=sampleWeaponAnimation(faction,'idle',0,false,profileOverride);
  }
  // A released body cannot keep actively holding a lean after it has fallen.
  pose.lean=(actor.lean??0)*(1-prone*.6)*(actor.alive?1:1-ease(Math.max(0,time-(actor.deadAt??time))/.30));
  return pose;
}

function targetInParent(model:THREE.Group,parent:THREE.Object3D,target:Triple) {
  return parent.worldToLocal(model.localToWorld(new THREE.Vector3(...target)));
}
function applyChain(model:THREE.Group,chain:JointChain,target:Triple,hint:Triple,endOrientation:THREE.Quaternion,kneeFloor?:number) {
  const parent=chain.root.parent!;
  let contactPlane:{normal:THREE.Vector3;constant:number}|undefined;
  if(kneeFloor!==undefined){
    const point=targetInParent(model,parent,[0,kneeFloor,0]);
    const normal=targetInParent(model,parent,[0,kneeFloor+1,0]).sub(point).normalize();
    contactPlane={normal,constant:point.dot(normal)};
  }
  const solved=solveTwoBone(chain.root.position,targetInParent(model,parent,target),targetInParent(model,parent,hint),chain.upperLength,chain.lowerLength,contactPlane);
  const upperRotation=new THREE.Quaternion().setFromUnitVectors(DOWN,solved.middle.clone().sub(chain.root.position).normalize());
  const lowerRotation=new THREE.Quaternion().setFromUnitVectors(DOWN,solved.end.clone().sub(solved.middle).normalize());
  chain.root.quaternion.copy(upperRotation);
  chain.middle.position.set(0,-chain.upperLength,0);chain.middle.quaternion.copy(upperRotation).invert().multiply(lowerRotation);
  chain.end.position.set(0,-chain.lowerLength,0);chain.root.updateWorldMatrix(false,true);
  const parentWorld=chain.end.parent!.getWorldQuaternion(new THREE.Quaternion());
  const desired=model.getWorldQuaternion(new THREE.Quaternion()).multiply(endOrientation);
  chain.end.quaternion.copy(parentWorld).invert().multiply(desired);chain.end.updateWorldMatrix(false,true);
}

function applyArmGrip(model:THREE.Group,chain:JointChain,grip:ReturnType<typeof solveArmGrip>){
  const parent=chain.root.parent!;
  const origin=targetInParent(model,parent,model.worldToLocal(chain.root.getWorldPosition(new THREE.Vector3())).toArray() as Triple);
  const middle=targetInParent(model,parent,grip.middle.toArray() as Triple),end=targetInParent(model,parent,grip.end.toArray() as Triple);
  const upperRotation=new THREE.Quaternion().setFromUnitVectors(DOWN,middle.clone().sub(origin).normalize());
  const parentOrientation=model.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(parent.getWorldQuaternion(new THREE.Quaternion()));
  const handInParent=parentOrientation.invert().multiply(grip.rotation);
  const handAxis=DOWN.clone().applyQuaternion(handInParent),forearm=end.clone().sub(middle).normalize();
  // Carry pronation in the forearm instead of twisting the entire palm at
  // the cuff. The wrist's remaining relative rotation is only its bend.
  const lowerRotation=new THREE.Quaternion().setFromUnitVectors(handAxis,forearm).multiply(handInParent);
  chain.root.quaternion.copy(upperRotation);
  chain.middle.position.set(0,-chain.upperLength,0);chain.middle.quaternion.copy(upperRotation).invert().multiply(lowerRotation);
  chain.end.position.set(0,-chain.lowerLength,0);chain.end.quaternion.copy(lowerRotation).invert().multiply(handInParent);
  chain.root.updateWorldMatrix(false,true);
}

/** Released corpse arms fall beside the torso in its own anatomical frame.
 * A fixed world-space pole can cross behind the shoulders when the chest
 * rotates onto its back. Keep both physical segments and a neutral wrist,
 * with continuous floor clearance applied to each fixed-length segment. This is
 * presentation of a non-damageable corpse; live held-prop IK is unchanged. */
function settleDeathArm(model:THREE.Group,chain:JointChain,side:'left'|'right',release:number,death:number,weapon:WeaponPose,hand?:SoldierHand,slot:WeaponSlot='rifle'){
 if(release<=0)return;
 const shoulder=model.worldToLocal(chain.root.getWorldPosition(new THREE.Vector3()));
 const elbow=model.worldToLocal(chain.middle.getWorldPosition(new THREE.Vector3())),wrist=model.worldToLocal(chain.end.getWorldPosition(new THREE.Vector3()));
 const chest=model.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(chain.root.parent!.getWorldQuaternion(new THREE.Quaternion()));
 const sign=side==='left'?1:-1,settled=ease((death-.32)/.68),gravity=3.5*settled;
 const forward=new THREE.Vector3(0,0,1).applyQuaternion(chest),topSide=Math.max(0,new THREE.Vector3(sign,0,0).applyQuaternion(chest).y);
 const segment=(origin:THREE.Vector3,initial:THREE.Vector3,local:THREE.Vector3,length:number,upper=false)=>{
   // Early release follows the torso; once it reaches the ground, gravity
   // lowers both arms beside it. A chest-relative target alone makes hands
   // point into the air on a supine body. Project each physical segment onto
   // the floor contact plane without changing its length or elbow branch.
   const rest=local.normalize().applyQuaternion(chest).addScaledVector(DOWN,gravity);
   // On a side fall the upper shoulder must descend in front of the chest,
   // rather than pull its upper arm through the torso toward the lower arm.
   if(upper)rest.addScaledVector(forward,topSide*3*settled);
   rest.normalize();
   if(upper){
     const localRest=rest.clone().applyQuaternion(chest.clone().invert());
     // Limit cross-body shoulder adduction while allowing the upper-side
     // elbow to come forward. The old straight-down target crossed the chest.
     if(localRest.x*sign<-.60){
       const length=Math.hypot(localRest.y,localRest.z),scale=.8/Math.max(length,1e-8);
       localRest.set(-sign*.60,localRest.y*scale,localRest.z*scale);rest.copy(localRest).applyQuaternion(chest);
     }
   }
   const direction=initial.normalize().lerp(rest,release).normalize(),minimum=clamp(((upper?.085:.035)-origin.y)/length,-1,1);
   if(direction.y<minimum){
     const horizontal=Math.hypot(direction.x,direction.z),scale=Math.sqrt(Math.max(0,1-minimum*minimum))/Math.max(1e-8,horizontal);
     direction.set(direction.x*scale,minimum,direction.z*scale);
   }
   return origin.clone().addScaledVector(direction,length);
 };
 const middle=segment(shoulder,elbow.clone().sub(shoulder),new THREE.Vector3(sign*.43,-.88,.16),chain.upperLength,true);
 const end=segment(middle,wrist.clone().sub(elbow),new THREE.Vector3(sign*.12,-.88,side==='left'?.44:.36),chain.lowerLength);
 const neutral=(direction:THREE.Vector3)=>chest.clone().multiply(new THREE.Quaternion().setFromUnitVectors(DOWN,direction.clone().applyQuaternion(chest.clone().invert())));
 const forearm=end.clone().sub(middle).normalize();
 if(hand){
   // Fit the released hand's actual skinned envelope, not just its wrist.
   // A neutral downward forearm otherwise leaves fingertips below the floor.
   // Cache the actual relaxed skin hull once per held item. Its support plane
   // is tighter than a box, which visibly suspends diagonal fingers in the air.
   const cache=hand.hand.userData.deathHull??={};
   let corners=cache[slot] as THREE.Vector3[]|undefined;
   if(!corners){
     poseSoldierHand(hand,side,weapon,slot,1);
     hand.frame.updateWorldMatrix(true,true);hand.frame.updateMatrixWorld(true);
     const points:THREE.Vector3[]=[];
     hand.hand.traverse(object=>{
       if(!(object instanceof THREE.SkinnedMesh))return;object.skeleton.update();
       const count=object.geometry.getAttribute('position').count;
       for(let i=0;i<count;i++)points.push(chain.end.worldToLocal(object.localToWorld(object.getVertexPosition(i,new THREE.Vector3()))));
     });
     const hull=new ConvexHull().setFromPoints(points),unique=new Set<THREE.Vector3>();
     for(const face of hull.faces){let edge=face.edge;do{unique.add(edge.head().point);edge=edge.next;}while(edge!==face.edge);}
     corners=[...unique];
     cache[slot]=corners;
     poseSoldierHand(hand,side,weapon,slot,release);
   }
   const horizontal=new THREE.Vector3(forearm.x,0,forearm.z).normalize();
   const direction=(y:number)=>horizontal.clone().multiplyScalar(Math.sqrt(Math.max(0,1-y*y))).setY(y);
   const clearance=(y:number)=>{
     const up=new THREE.Vector3(0,1,0).applyQuaternion(neutral(direction(y)).invert());let lowest=Infinity;
     for(const point of corners!)lowest=Math.min(lowest,point.dot(up));
     return middle.y+chain.lowerLength*y+lowest-.003;
   };
   if(clearance(forearm.y)<0){
     let low=forearm.y,high=1;
     for(let i=0;i<20;i++){const mid=(low+high)*.5;if(clearance(mid)<0)low=mid;else high=mid;}
     forearm.copy(direction(lerp(forearm.y,high,ease(release))));end.copy(middle).addScaledVector(forearm,chain.lowerLength);
   }
 }
 const relaxed=neutral(forearm);
 const rotation=model.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(chain.end.getWorldQuaternion(new THREE.Quaternion()));
 rotation.premultiply(new THREE.Quaternion().setFromUnitVectors(DOWN.clone().applyQuaternion(rotation),forearm)).slerp(relaxed,release);
 applyArmGrip(model,chain,{middle,end,rotation,palm:end.clone(),error:new THREE.Vector3(),swing:new THREE.Quaternion()});
}

const CLOTH_RINGS=12,CLOTH_SIDES=16;
/** A continuous strip of cloth bridges both bones. Keeping this separate
 * from the rigid limb batches avoids open ends or spherical joint covers. */
export function makeClothJoint(chain:JointChain,material:THREE.Material,radius:number,depth:number,reach=.105):ClothJoint {
  const geometry=new THREE.BufferGeometry(),count=(CLOTH_RINGS+1)*(CLOTH_SIDES+1);
  const positions=new THREE.Float32BufferAttribute(new Float32Array(count*3),3);
  positions.setUsage(THREE.DynamicDrawUsage);geometry.setAttribute('position',positions);
  geometry.setAttribute('normal',new THREE.Float32BufferAttribute(new Float32Array(count*3),3).setUsage(THREE.DynamicDrawUsage));
  const uv:number[]=[],indices:number[]=[];
  for(let j=0;j<=CLOTH_RINGS;j++)for(let i=0;i<=CLOTH_SIDES;i++) {
    uv.push(i/CLOTH_SIDES,j/CLOTH_RINGS*.6);
    if(j<CLOTH_RINGS&&i<CLOTH_SIDES){const a=j*(CLOTH_SIDES+1)+i,b=a+CLOTH_SIDES+1;indices.push(a,a+1,b,b,a+1,b+1);}
  }
  geometry.setAttribute('uv',new THREE.Float32BufferAttribute(uv,2));geometry.setIndex(indices);
  const mesh=new THREE.Mesh(geometry,material);mesh.name=`${chain.middle.name}-cloth`;mesh.castShadow=mesh.receiveShadow=true;
  return{mesh,chain,radius,depth,reach};
}

function updateClothJoint(model:THREE.Group,joint:ClothJoint) {
  const center=model.worldToLocal(joint.chain.middle.getWorldPosition(new THREE.Vector3()));
  const upper=model.worldToLocal(joint.chain.root.getWorldPosition(new THREE.Vector3()));
  const lower=model.worldToLocal(joint.chain.end.getWorldPosition(new THREE.Vector3()));
  const incoming=center.clone().sub(upper).normalize(),outgoing=lower.clone().sub(center).normalize();
  const start=center.clone().addScaledVector(incoming,-joint.reach),end=center.clone().addScaledVector(outgoing,joint.reach);
  const control=center.clone().addScaledVector(incoming,joint.reach*.35).addScaledVector(outgoing,-joint.reach*.35);
  const across=new THREE.Vector3().crossVectors(incoming,outgoing);
  if(across.lengthSq()<1e-8){across.set(1,0,0).addScaledVector(incoming,-incoming.x);if(across.lengthSq()<1e-8)across.set(0,0,1);}
  across.normalize();
  const bend=Math.sqrt(Math.max(0,(1-incoming.dot(outgoing))*.5));
  const positions=joint.mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
  const tangent=new THREE.Vector3(),radial=new THREE.Vector3(),point=new THREE.Vector3(),endTangent=end.clone().sub(control);
  for(let j=0;j<=CLOTH_RINGS;j++) {
    const t=j/CLOTH_RINGS,s=1-t;
    point.copy(start).multiplyScalar(s*s).addScaledVector(control,2*s*t).addScaledVector(end,t*t);
    tangent.copy(control).sub(start).multiplyScalar(s).addScaledVector(endTangent,t);
    if(tangent.lengthSq()<1e-8)tangent.copy(incoming).add(outgoing);
    if(tangent.lengthSq()<1e-8)tangent.copy(incoming);
    tangent.normalize();
    // End rings tuck inside the rigid cloth. Their orientation matches the
    // bone at the overlap; the middle wraps the bend with shallow creases.
    if(t<.2)tangent.lerp(incoming,1-t/.2).normalize();
    if(t>.8)tangent.lerp(outgoing,(t-.8)/.2).normalize();
    radial.crossVectors(tangent,across).normalize();
    const taper=.93+.07*Math.sin(t*Math.PI),fold=1+.027*bend*Math.sin(t*Math.PI*6)*Math.sin(t*Math.PI);
    for(let i=0;i<=CLOTH_SIDES;i++) {
      const angle=i/CLOTH_SIDES*TAU,x=Math.cos(angle)*joint.radius*taper*fold,z=Math.sin(angle)*joint.depth*taper*fold;
      positions.setXYZ(j*(CLOTH_SIDES+1)+i,point.x+across.x*x+radial.x*z,point.y+across.y*x+radial.y*z,point.z+across.z*x+radial.z*z);
    }
  }
  positions.needsUpdate=true;joint.mesh.geometry.computeVertexNormals();joint.mesh.geometry.computeBoundingBox();joint.mesh.geometry.computeBoundingSphere();
}

interface SourcePalm {normal:THREE.Vector3;contact:THREE.Vector3;mesh?:THREE.SkinnedMesh;vertex?:number;hand?:SoldierHand;}
/** Fit the hand frame to the actual bind mesh once. Palm vertices follow the
 * wrist fully, so their contact stays exact after IK and source regeneration. */
function sourcePalm(model:THREE.Group,side:'left'|'right'):SourcePalm {
  const hand=(model.userData.soldierRig as SoldierRig).hands?.[side];
  if(hand)return{normal:hand.normal,contact:soldierHandContact(hand,hand.thumbWeight),hand};
  const cache=(model.userData.sourcePalmBindings??={}) as Partial<Record<'left'|'right',SourcePalm>>;
  if(cache[side])return cache[side]!;
  const points:Array<{point:THREE.Vector3;mesh:THREE.SkinnedMesh;vertex:number}>=[];
  model.traverse(object=>{
    if(!(object instanceof THREE.SkinnedMesh))return;
    const chain=(model.userData.soldierRig as SoldierRig)[side==='left'?'leftArm':'rightArm'];
    const bone=object.skeleton.bones.findIndex(bone=>bone.name===`skin-${chain.end.name}`);if(bone<0)return;
    const origin=new THREE.Vector3().setFromMatrixPosition(object.skeleton.boneInverses[bone].clone().invert());
    const position=object.geometry.getAttribute('position'),indices=object.geometry.getAttribute('skinIndex'),weights=object.geometry.getAttribute('skinWeight');
    for(let i=0;i<position.count;i++){
      let influence=0;for(let k=0;k<4;k++)if(indices.getComponent(i,k)===bone)influence+=weights.getComponent(i,k);
      if(influence<.999)continue;
      const point=new THREE.Vector3().fromBufferAttribute(position,i).sub(origin);
      if(point.y<-.025&&point.y>-.085)points.push({point,mesh:object,vertex:i});
    }
  });
  const inward=side==='left'?-1:1;
  if(points.length<8)return cache[side]={normal:new THREE.Vector3(inward,0,0),contact:new THREE.Vector3(inward*.018,-.060,0)};
  const mean=points.reduce((sum,value)=>sum.add(value.point),new THREE.Vector3()).multiplyScalar(1/points.length);
  let xx=0,zz=0,xz=0;for(const {point}of points){const x=point.x-mean.x,z=point.z-mean.z;xx+=x*x;zz+=z*z;xz+=x*z;}
  const angle=.5*Math.atan2(2*xz,xx-zz)+Math.PI/2;
  const normal=new THREE.Vector3(Math.cos(angle),0,Math.sin(angle));if(normal.x*inward<0)normal.negate();
  const pad=mean.clone().addScaledVector(normal,.018);
  const nearest=points.reduce((a,b)=>a.point.distanceToSquared(pad)<b.point.distanceToSquared(pad)?a:b);
  return cache[side]={normal,contact:nearest.point.clone(),mesh:nearest.mesh,vertex:nearest.vertex};
}
/** Actual source skin contact, useful for held props and deformation checks. */
export function getSoldierPalmContact(model:THREE.Group,side:'left'|'right'):THREE.Vector3|undefined {
  const binding=sourcePalm(model,side);
  if(binding.hand)return binding.hand.frame.parent!.localToWorld(binding.contact.clone());
  if(!binding.mesh||binding.vertex===undefined)return;
  model.updateMatrixWorld(true);binding.mesh.skeleton.update();
  return binding.mesh.localToWorld(binding.mesh.applyBoneTransform(binding.vertex,new THREE.Vector3().fromBufferAttribute(binding.mesh.geometry.getAttribute('position'),binding.vertex)));
}
function palmFrame(normal:THREE.Vector3,fingers:THREE.Vector3){
  const x=normal.clone().normalize(),y=fingers.clone().addScaledVector(x,-fingers.dot(x)).normalize();
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x,y,new THREE.Vector3().crossVectors(x,y)));
}
function importedHand(model:THREE.Group,side:'left'|'right',weapon:WeaponPose,orientation:THREE.Quaternion,mode:'rifle'|'grenade'|'relaxed'='rifle'){
  const bind=sourcePalm(model,side),normal=bind.normal;
  const source=palmFrame(normal,DOWN).invert();
  if(mode==='relaxed')return{rotation:orientation.clone(),contact:bind.contact.clone()};
  if(mode==='grenade')return{rotation:orientation.clone().multiply(palmFrame(new THREE.Vector3(1,0,0),new THREE.Vector3(0,-.10,1))).multiply(source),contact:bind.contact.clone()};
  const fingers=new THREE.Vector3(side==='left'?-.8:.8,0,.6);
  const desired=palmFrame(new THREE.Vector3(0,1,0),fingers);
  if(side==='right'){
    desired.slerp(palmFrame(new THREE.Vector3(1,.2,0),new THREE.Vector3(0,-.35,1)),weapon.boltGrip);
    desired.slerp(palmFrame(new THREE.Vector3(0,-1,0),fingers),weapon.thumbContact);
  }
  return{rotation:orientation.clone().multiply(desired).multiply(source),contact:bind.contact.clone()};
}

export function fitSourceFoot(target:Triple,rotation:Triple,points?:ReadonlyArray<Triple>,rollWeight=0):Triple {
  if(!points?.length)return target;
  const orientation=new THREE.Quaternion().setFromEuler(new THREE.Euler(...rotation)),point=new THREE.Vector3();
  let lowest=Infinity;
  for(const local of points)lowest=Math.min(lowest,point.set(...local).applyQuaternion(orientation).y);
  // The sampled pose includes the former procedural boot's floor allowance.
  // Replace that allowance and the box's roll with the real sole's shape;
  // any extra swing/airborne height is retained.
  const actual=rollWeight?soleRollOffset(rotation,points):[0,0,0],procedural=rollWeight?soleRollOffset(rotation):[0,0,0];
  return [target[0]+(actual[0]-procedural[0])*rollWeight,target[1]+.003-lowest-proceduralBootClearance(rotation),target[2]+(actual[2]-procedural[2])*rollWeight];
}

export function applySoldierPose(model:THREE.Group,pose:SoldierPose) {
  const rig=model.userData.soldierRig as SoldierRig|undefined;if(!rig)return;
  rig.pelvis.position.set(...pose.pelvis);rig.pelvis.rotation.set(...pose.pelvisRotation);
  rig.spine.rotation.set(...pose.spineRotation);rig.neck.rotation.set(...pose.neckRotation);
  rig.riflePivot.position.set(...pose.riflePosition);rig.riflePivot.rotation.set(...pose.rifleRotation);
  if(model.userData.importedSoldier){
    // The source rifles have real-length stocks. Tuck their butt toward the
    // shoulder so the support wrist can reach the actual wooden fore-end.
    rig.riflePivot.position.x+=.03;rig.riflePivot.position.z-=.055;
  }
  applyWeaponAnimation(rig.rifle,pose.weapon);
  for(const side of ['left','right'] as const)if(rig.hands)poseSoldierHand(rig.hands[side],side,pose.weapon,pose.heldWeapon,pose.death>0?pose.handRelease:0);
  rig.clip.visible=pose.weapon.clipVisible;rig.clip.position.set(...pose.weapon.clipPosition);
  rig.clipRounds.position.y=-pose.weapon.clipPress*.064;rig.clipRounds.visible=pose.weapon.clipPress<.98;
  model.updateMatrixWorld(true);
  const feetOrientation=new THREE.Quaternion().setFromEuler(new THREE.Euler(...pose.footRotation));
  applyChain(model,rig.leftLeg,fitSourceFoot(pose.leftFoot,pose.leftFootRotation??pose.footRotation,rig.solePoints?.left,pose.footRoll),pose.leftKneeHint,pose.leftFootRotation?new THREE.Quaternion().setFromEuler(new THREE.Euler(...pose.leftFootRotation)):feetOrientation,.11);
  applyChain(model,rig.rightLeg,fitSourceFoot(pose.rightFoot,pose.rightFootRotation??pose.footRotation,rig.solePoints?.right,pose.footRoll),pose.rightKneeHint,pose.rightFootRotation?new THREE.Quaternion().setFromEuler(new THREE.Euler(...pose.rightFootRotation)):feetOrientation,.11);
  const rightSource=new THREE.Vector3(...pose.weapon.right);
  const leftSource=new THREE.Vector3(pose.weapon.left[0],pose.weapon.left[1],pose.weapon.left[2]+.16);
  if(model.userData.importedSoldier){
    // Actual underside samples on each acquired stock. The Mosin support
    // point sits beside its open receiver channel, over solid source wood.
    const stock=rig.stockContacts??={british:{left:[0,-.0105,-.4205],right:[0,-.0356,-.18]},russian:{left:[.015,-.01819,-.3931],right:[0,-.04205,-.16]},german:{left:[0,-.0114,-.4195],right:[0,-.0359,-.18]}}[rig.faction] as {left:Triple;right:Triple};
    if(rig.hands&&!rig.rifle.userData.worldSupportFitted){
      // Move the support a few centimetres toward the receiver for the real
      // arm proportions, then sample the actual wood underside at that spot.
      const point=new THREE.Vector3(stock.left[0],.3,stock.left[2]+.05),wood:THREE.Mesh[]=[],sides=new Map<THREE.Material,THREE.Side>();
      rig.rifle.getObjectByName('furniture')?.traverse(object=>{
        if(!(object instanceof THREE.Mesh))return;const materials=Array.isArray(object.material)?object.material:[object.material];
        if(rig.faction==='german'||materials.some(material=>/wood|walnut/i.test(material.name))){wood.push(object);for(const material of materials){sides.set(material,material.side);material.side=THREE.DoubleSide;}}
      });
      const ray=new THREE.Raycaster(rig.rifle.localToWorld(point.clone()),new THREE.Vector3(0,-1,0).transformDirection(rig.rifle.matrixWorld));
      const hits=ray.intersectObjects(wood);if(hits.length>=2)stock.left=[point.x,Math.min(...hits.map(hit=>rig.rifle.worldToLocal(hit.point.clone()).y)),point.z];
      for(const[material,side]of sides)material.side=side;
      rig.rifle.userData.worldSupportFitted=true;
    }
    leftSource.set(...stock.left as Triple);
    rightSource.lerp(new THREE.Vector3(...stock.right),1-Math.max(pose.weapon.boltGrip,pose.weapon.thumbContact,pose.weapon.fingerOpen));
  }
  const toModel=(point:THREE.Vector3)=>model.worldToLocal(rig.rifle.localToWorld(point.clone())).toArray() as Triple;
  const handOrientation=new THREE.Quaternion().setFromEuler(new THREE.Euler(...(pose.heldWeapon==='grenade'?pose.grenadeRotation:pose.rifleRotation)));
  const relaxedOrientation=new THREE.Quaternion().setFromEuler(new THREE.Euler(...pose.pelvisRotation)).multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(...pose.spineRotation)));
  let grenadePalm:THREE.Vector3|undefined;
  let grenadeSwing:THREE.Quaternion|undefined;
  if(model.userData.importedSoldier){
    const chain=(side:'left'|'right')=>{const arm=side==='left'?rig.leftArm:rig.rightArm;return{shoulder:model.worldToLocal(arm.root.getWorldPosition(new THREE.Vector3())),upper:arm.upperLength,lower:arm.lowerLength};};
    const input={left:chain('left'),right:chain('right'),rifle:{position:rig.rifle.position.toArray(),rotation:rig.rifle.quaternion.toArray(),scale:rig.rifle.scale.toArray()},stockContacts:rig.stockContacts!,contacts:{left:sourcePalm(model,'left'),right:sourcePalm(model,'right')}};
    let fitted:ReturnType<typeof solveHeldArms>;
    if(pose.deathStart){
      // Freeze the anatomical holding pose at death, then carry it with the
      // falling chest. Re-solving a dropped rifle each frame can pick another
      // elbow branch even though both released hands should simply relax.
      const start=pose.deathStart,hip=new THREE.Quaternion().setFromEuler(new THREE.Euler(...start.pelvisRotation));
      const chest=hip.clone().multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(...start.spineRotation)));
      const spine=new THREE.Vector3(...start.pelvis).add(rig.spine.position.clone().applyQuaternion(hip));
      const initial=(side:'left'|'right')=>({...input[side],shoulder:(side==='left'?rig.leftArm:rig.rightArm).root.position.clone().applyQuaternion(chest).add(spine)});
      fitted=solveHeldArms(start,{...input,left:initial('left'),right:initial('right'),contacts:rig.hands?undefined:input.contacts});
      const currentChest=model.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(rig.spine.getWorldQuaternion(new THREE.Quaternion()));
      const currentSpine=model.worldToLocal(rig.spine.getWorldPosition(new THREE.Vector3()));
      const turn=currentChest.multiply(chest.invert()),point=(value:THREE.Vector3)=>value.sub(spine).applyQuaternion(turn).add(currentSpine);
      for(const side of ['left','right'] as const){const grip=fitted[side];point(grip.middle);point(grip.end);point(grip.palm);grip.rotation.premultiply(turn);}
      point(fitted.riflePosition);
    }else fitted=solveHeldArms(pose,input);
    rig.riflePivot.position.copy(fitted.riflePosition);
    if(pose.death>0)rig.riflePivot.position.lerp(new THREE.Vector3(...pose.riflePosition).add(new THREE.Vector3(.03,0,-.055)),pose.handRelease);
    applyArmGrip(model,rig.leftArm,fitted.left);applyArmGrip(model,rig.rightArm,fitted.right);
    if(pose.death>0){settleDeathArm(model,rig.leftArm,'left',pose.handRelease,pose.death,pose.weapon,rig.hands?.left,pose.heldWeapon);settleDeathArm(model,rig.rightArm,'right',pose.handRelease,pose.death,pose.weapon,rig.hands?.right,pose.heldWeapon);}
    grenadePalm=fitted.right.palm.clone();grenadeSwing=fitted.right.swing;
    if(pose.deathStart){
      const palm=getSoldierPalmContact(model,'right')??rig.rightArm.end.getWorldPosition(new THREE.Vector3());
      grenadePalm=model.worldToLocal(palm);
      const hand=model.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(rig.rightArm.end.getWorldQuaternion(new THREE.Quaternion()));
      grenadeSwing=hand.multiply(fitted.right.rotation.clone().invert()).multiply(fitted.right.swing);
    }
  }else{
    const rightGrip=toModel(rightSource),leftGrip=toModel(leftSource);
    const right=pose.rightHand?blend3(rightGrip,pose.rightHand,pose.handRelease):rightGrip;
    const left=pose.leftHand?blend3(leftGrip,pose.leftHand,pose.handRelease):leftGrip;
    applyChain(model,rig.leftArm,left,pose.leftElbowHint,handOrientation);
    applyChain(model,rig.rightArm,right,pose.rightElbowHint,handOrientation);
  }
  rig.rifle.visible=pose.heldWeapon==='rifle'&&pose.itemVisible;
  if(rig.grenade) {
    rig.grenade.visible=pose.heldWeapon==='grenade'&&pose.itemVisible;
    rig.grenade.rotation.set(...pose.grenadeRotation);
    if(grenadeSwing)rig.grenade.quaternion.premultiply(grenadeSwing);
    const palm=grenadePalm??model.worldToLocal(rig.rightArm.end.getWorldPosition(new THREE.Vector3()));
    const offset=(grenadePalm?new THREE.Vector3(.018,0,0):new THREE.Vector3(.018,.024,.015)).applyEuler(rig.grenade.rotation);
    rig.grenade.position.copy(palm).add(offset);
  }
  // Lean the upper body about its planted lumbar joint. Apply the same rigid
  // transform to held props after IK so palms stay attached and wrists retain
  // their authored angles. Camera lean never rotates the user’s view.
  if(pose.lean){
    const pivot=model.worldToLocal(rig.spine.getWorldPosition(new THREE.Vector3()));
    const turn=new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,0,1),pose.lean*.48);
    const parent=rig.pelvis.getWorldQuaternion(new THREE.Quaternion());
    rig.spine.quaternion.premultiply(parent.clone().invert().multiply(turn).multiply(parent));
    for(const item of [rig.riflePivot,rig.grenade])if(item){item.position.sub(pivot).applyQuaternion(turn).add(pivot);item.quaternion.premultiply(turn);}
    model.updateMatrixWorld(true);
  }
  for(const joint of rig.clothJoints??[])updateClothJoint(model,joint);
  model.userData.animationStage=pose.stage;model.userData.animationPose=pose;
}

/** Public renderer entry point. Transition state is reset on respawn, replay
 * rewind, or clock discontinuity; stance smoothing uses elapsed simulation
 * time, so pausing or changing frame rate cannot move the character. */
export function updateSoldier(model:THREE.Group,actor:SoldierActor,dt:number,simTime:number,applyPose=true) {
  const rig=model.userData.soldierRig as SoldierRig|undefined;if(!rig)return;
  let state=model.userData.soldierState as RigState|undefined;
  const reset=!state||simTime<state.time-1e-6||simTime-state.time>1||(!state.alive&&actor.alive);
  if(reset) {
    const phaseTime=!actor.alive&&Number.isFinite(actor.deadAt)?actor.deadAt!:simTime;
    state={time:simTime,alive:actor.alive,hp:actor.hp??100,x:actor.x,z:actor.z,deathAt:actor.deadAt??simTime,hurtAt:actor.lastHurtTime??-Infinity,crouch:Number(actor.stance==='crouch'),prone:Number(actor.stance==='prone'),aim:Number(actor.ads),speed:actor.moving,phase:phaseTime*sourceGaitRate(actor.moving,Number(actor.stance==='crouch'),Number(actor.stance==='prone'))+actor.id*.19,forward:1,sideways:0};
    if(!actor.alive)state.deathBlend={...(actor.pose??state)};
    model.userData.soldierState=state;
  }
  const s=state!,elapsedTime=Math.max(0,simTime-s.time);
  const weight=1-Math.exp(-elapsedTime*12);
  if(s.alive&&!actor.alive){
    s.deathAt=Number.isFinite(actor.deadAt)?actor.deadAt!:simTime;
    s.deathBlend=actor.pose?{...actor.pose}:{crouch:s.crouch,prone:s.prone,aim:s.aim,speed:s.speed,phase:s.phase,forward:s.forward,sideways:s.sideways};
  }
  if((actor.hp??100)<s.hp)s.hurtAt=Number.isFinite(actor.lastHurtTime)?actor.lastHurtTime!:simTime;
  // Integrate the eased speed, not just its end-of-frame value. Otherwise a
  // start/stop advances different gait phases at 30, 60 and 144 Hz. Gaussian
  // sampling keeps this inexpensive while matching the same smooth envelope.
  const targetSpeed=actor.alive?actor.moving:0,targetCrouch=Number(actor.stance==='crouch'),targetProne=Number(actor.stance==='prone');
  const rateAt=(t:number)=>targetSpeed>0&&actor.grounded!==false?sourceGaitRate(lerp(targetSpeed,s.speed,Math.exp(-t*9)),lerp(targetCrouch,s.crouch,Math.exp(-t*12)),lerp(targetProne,s.prone,Math.exp(-t*12))):0;
  const steps=Math.max(1,Math.ceil(elapsedTime/.02)),step=elapsedTime/steps,offset=Math.sqrt(3/5)*step*.5;
  for(let i=0;i<steps;i++){
    const middle=(i+.5)*step;
    s.phase+=step*(5*rateAt(middle-offset)+8*rateAt(middle)+5*rateAt(middle+offset))/18;
  }
  s.crouch=lerp(s.crouch,Number(actor.stance==='crouch'),weight);s.prone=lerp(s.prone,Number(actor.stance==='prone'),weight);
  s.aim=lerp(s.aim,Number(actor.ads),weight);s.speed=lerp(s.speed,targetSpeed,1-Math.exp(-elapsedTime*9));
  const dx=actor.x-s.x,dz=actor.z-s.z,moved=Math.hypot(dx,dz);
  if(moved>.0001&&elapsedTime>0){s.forward=lerp(s.forward,(dx*Math.sin(actor.yaw)+dz*Math.cos(actor.yaw))/moved,weight);s.sideways=lerp(s.sideways,(dx*Math.cos(actor.yaw)-dz*Math.sin(actor.yaw))/moved,weight);}
  model.visible=true;model.position.set(actor.x,actor.y,actor.z);model.rotation.set(0,actor.yaw,0);model.scale.set(1,1,1);
  // Hidden models still advance phase, blends and death history. Only the
  // expensive IK, hand skinning and cloth posing wait until they contribute
  // pixels or shadows again; re-entry therefore uses the exact current clock.
  if(applyPose){
    const pose=sampleSoldierPose({...actor,deadAt:actor.deadAt??s.deathAt,lastHurtTime:actor.lastHurtTime??s.hurtAt},rig.faction,simTime,!actor.alive&&s.deathBlend?s.deathBlend:actor.pose??s);
    applySoldierPose(model,pose);
  }
  s.time=simTime;s.alive=actor.alive;s.hp=actor.hp??100;s.x=actor.x;s.z=actor.z;
  void dt; // Simulation time, rather than wall-clock dt, is authoritative.
}
