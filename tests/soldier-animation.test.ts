import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {MELEE_SECONDS} from '../src/config.ts';
import {applySoldierPose,makeClothJoint,sampleSoldierPose,solveTwoBone,updateSoldier,type JointChain,type SoldierActor,type SoldierRig} from '../src/soldierAnimation.ts';

const actor=(patch:Partial<SoldierActor>={}):SoldierActor=>({id:1,x:0,y:0,z:0,yaw:0,pitch:0,stance:'stand',alive:true,moving:0,ads:true,recoil:0,cooldown:0,reload:0,reloadTotal:0,hp:100,deadAt:-Infinity,lastShotTime:-Infinity,lastHurtTime:-Infinity,lastMeleeTime:-Infinity,...patch});
function testRig() {
  const model=new THREE.Group(),pelvis=new THREE.Group(),spine=new THREE.Group(),neck=new THREE.Group();
  model.add(pelvis);pelvis.add(spine);spine.position.y=.11;spine.add(neck);neck.position.y=.51;
  const chain=(parent:THREE.Group,position:[number,number,number],upperLength:number,lowerLength:number):JointChain=>{
    const root=new THREE.Group(),middle=new THREE.Group(),end=new THREE.Group();parent.add(root);root.position.set(...position);root.add(middle);middle.position.y=-upperLength;middle.add(end);end.position.y=-lowerLength;return{root,middle,end,upperLength,lowerLength};
  };
  const riflePivot=new THREE.Group(),rifle=new THREE.Group(),clip=new THREE.Group(),clipRounds=new THREE.Group();
  model.add(riflePivot);riflePivot.add(rifle);rifle.rotation.y=Math.PI;rifle.scale.setScalar(.82);rifle.add(clip);clip.add(clipRounds);
  const bolt=new THREE.Group();bolt.name='bolt';rifle.add(bolt);
  const rig:SoldierRig={faction:'british',pelvis,spine,neck,leftArm:chain(spine,[.228,.394,.006],.33,.34),rightArm:chain(spine,[-.228,.394,.006],.33,.34),leftLeg:chain(pelvis,[-.13,-.015,0],.385,.345),rightLeg:chain(pelvis,[.13,-.015,0],.385,.345),riflePivot,rifle,clip,clipRounds};
  model.userData.soldierRig=rig;return{model,rig};
}

test('two-bone IK keeps anatomical lengths and clamps unreachable targets without NaNs',()=>{
  for(const target of [[.4,.2,.1],[0,0,0],[10,10,0],[0,-.73,0]]) {
    const start=new THREE.Vector3(),result=solveTwoBone(start,new THREE.Vector3(...target),new THREE.Vector3(0,.1,1),.385,.345);
    assert.ok(Math.abs(result.middle.distanceTo(start)-.385)<1e-9);
    assert.ok(Math.abs(result.end.distanceTo(result.middle)-.345)<1e-9);
    for(const value of [...result.middle.toArray(),...result.end.toArray()])assert.ok(Number.isFinite(value));
  }
});

test('kneeling contact rotates the knee around a fixed hip and planted ankle',()=>{
 const origin=new THREE.Vector3(-.13,.41,-.09),target=new THREE.Vector3(-.23,.21,-.35),hint=new THREE.Vector3(-.24,.05,-.01);
 const unconstrained=solveTwoBone(origin,target,hint,.385,.345);
 assert.ok(unconstrained.middle.y<.08,'the source knee would enter the uniform contact plane');
 const solved=solveTwoBone(origin,target,hint,.385,.345,{normal:new THREE.Vector3(0,1,0),constant:.11});
 assert.ok(Math.abs(solved.middle.y-.11)<1e-9);
 assert.ok(solved.end.distanceTo(target)<1e-9,'planted ankle does not move');
 assert.ok(Math.abs(solved.middle.distanceTo(origin)-.385)<1e-9);
 assert.ok(Math.abs(solved.end.distanceTo(solved.middle)-.345)<1e-9);
});

test('stance and locomotion foot targets remain grounded and reachable throughout gait cycles',()=>{
  const {model,rig}=testRig();
  for(const stance of ['stand','crouch','prone'] as const) for(const moving of [0,1.7,4.5]) for(let i=0;i<=80;i++) {
    const pose=sampleSoldierPose(actor({stance,moving}),'british',i/40);applySoldierPose(model,pose);model.updateMatrixWorld(true);
    for(const [chain,target] of [[rig.leftLeg,pose.leftFoot],[rig.rightLeg,pose.rightFoot]] as const) {
      const foot=chain.end.getWorldPosition(new THREE.Vector3());
      assert.ok(foot.y>=.09,`${stance} feet cannot pass below ground`);
      assert.ok(foot.distanceTo(new THREE.Vector3(...target))<.035,`${stance}/${moving} feet should reach planted/swing targets`);
    }
  }
});

test('rifle running keeps the torso steady while retaining a full articulated stride',()=>{
  const {model,rig}=testRig();
  for(const moving of [2.8,3.1,4.5,4.86]) {
    const neckX:number[]=[],rifleX:number[]=[],footZ:number[]=[],footY:number[]=[];
    for(let i=0;i<120;i++) {
      const pose=sampleSoldierPose(actor({moving,ads:false,grounded:true}),'british',2,{phase:i/120});
      applySoldierPose(model,pose);model.updateMatrixWorld(true);
      const chestUp=new THREE.Vector3(0,1,0).applyQuaternion(rig.spine.getWorldQuaternion(new THREE.Quaternion()));
      assert.ok(Math.abs(Math.atan2(chestUp.x,chestUp.y))<5*Math.PI/180,'running shoulders must not swing into a pronounced sideways lean');
      neckX.push(rig.neck.getWorldPosition(new THREE.Vector3()).x);rifleX.push(rig.riflePivot.position.x);
      footZ.push(pose.leftFoot[2]);footY.push(pose.leftFoot[1]);
      for(const leg of [rig.leftLeg,rig.rightLeg]) {
        const hip=leg.root.getWorldPosition(new THREE.Vector3()),knee=leg.middle.getWorldPosition(new THREE.Vector3()),ankle=leg.end.getWorldPosition(new THREE.Vector3());
        assert.ok(Math.abs(hip.distanceTo(knee)-leg.upperLength)<1e-8,'stabilizing the torso cannot stretch the upper leg');
        assert.ok(Math.abs(knee.distanceTo(ankle)-leg.lowerLength)<1e-8,'stabilizing the torso cannot stretch the lower leg');
      }
    }
    const range=(values:number[])=>Math.max(...values)-Math.min(...values);
    for(const values of [neckX,rifleX])assert.ok(range(values)>.025&&range(values)<.06,'head and held rifle retain a small, sub-6cm lateral weight shift');
    assert.ok(range(footZ)>.8,'running must retain its forward/back stride');
    assert.ok(range(footY)>.2,'running must retain its lifted swing leg');
  }
});

test('held rifle follows exact aim pitch while the neck and spine remain articulated',()=>{
  const {model,rig}=testRig();
  for(const pitch of [-1,-.4,0,.4,1]) {
    const pose=sampleSoldierPose(actor({pitch}),'british',2);applySoldierPose(model,pose);model.updateMatrixWorld(true);
    const barrel=new THREE.Vector3(0,0,1).applyQuaternion(rig.riflePivot.quaternion);
    assert.ok(barrel.distanceTo(new THREE.Vector3(0,Math.sin(pitch),Math.cos(pitch)))<1e-8);
    assert.ok(Math.abs(rig.neck.rotation.x+rig.spine.rotation.x+pitch*.73)<1e-8);
    assert.ok(rig.rightArm.middle.quaternion.angleTo(new THREE.Quaternion())>.1);
  }
});

test('jump and landing equipment follows the torso without pushing elbows over the head',()=>{
 const {model,rig}=testRig();rig.grenade=new THREE.Group();model.add(rig.grenade);
 for(const selectedWeapon of ['rifle','grenade'] as const)for(const ads of [false,true])for(let i=0;i<=100;i++){
  const age=i/100,time=2+age,grounded=age>=.66;
  const jumping=actor({ads,selectedWeapon,grounded,vy:grounded?0:7.3-22*age,jumpStarted:2,landedAt:grounded?2.66:-Infinity,landingSpeed:7.3});
  const pose=sampleSoldierPose(jumping,'british',time);applySoldierPose(model,pose);model.updateMatrixWorld(true);
  const neck=rig.neck.getWorldPosition(new THREE.Vector3());
  for(const arm of [rig.leftArm,rig.rightArm]){
   assert.ok(arm.middle.getWorldPosition(new THREE.Vector3()).y<neck.y+.08,'elbow remains below helmet / face during impact');
   const shoulder=arm.root.getWorldPosition(new THREE.Vector3()),elbow=arm.middle.getWorldPosition(new THREE.Vector3()),hand=arm.end.getWorldPosition(new THREE.Vector3());
   assert.ok(Math.abs(shoulder.distanceTo(elbow)-arm.upperLength)<1e-7);
   assert.ok(Math.abs(elbow.distanceTo(hand)-arm.lowerLength)<1e-7);
  }
  if(selectedWeapon==='rifle')assert.ok(Math.abs(pose.riflePosition[1]-neck.y-(ads?.04:-.175))<.003,'rifle height follows the landing torso');
 }
});

test('death progresses to a settled pose, stays still and respawn clears the collapse',()=>{
  const dead=actor({alive:false,deadAt:10}),early=sampleSoldierPose(dead,'british',10.08),late=sampleSoldierPose(dead,'british',10.65);
  assert.ok(late.death>early.death);assert.ok(late.pelvis[1]<early.pelvis[1]);
  assert.deepEqual(sampleSoldierPose(dead,'british',12),sampleSoldierPose(dead,'british',19));
  const {model,rig}=testRig();updateSoldier(model,actor(),.016,9.9);updateSoldier(model,dead,.016,10.65);assert.ok(rig.pelvis.rotation.x<-.5);
  updateSoldier(model,actor({x:4,z:3}),.016,12);assert.equal(rig.pelvis.rotation.x,0);assert.equal(model.position.x,4);assert.equal(model.position.z,3);assert.equal(model.userData.animationPose.death,0);
});

test('death buckles planted knees before falling toward the recorded impact direction',()=>{
  for(const yaw of [0,.7])for(const direction of [0,Math.PI/2,Math.PI,-Math.PI/2]) {
    const dead=actor({alive:false,deadAt:10,deathYaw:direction,yaw}),initial=sampleSoldierPose(dead,'british',10),impact=sampleSoldierPose(dead,'british',10.1),buckled=sampleSoldierPose(dead,'british',10.28),settled=sampleSoldierPose(dead,'british',12);
    assert.deepEqual(impact.leftFoot,initial.leftFoot);assert.deepEqual(impact.rightFoot,initial.rightFoot);
    assert.ok(buckled.pelvis[1]<impact.pelvis[1]-.10,'knees collapse before the body reaches the floor');
    const axis=new THREE.Vector3(0,1,0).applyEuler(new THREE.Euler(...settled.pelvisRotation));
    assert.ok(axis.distanceTo(new THREE.Vector3(Math.sin(direction-yaw),0,Math.cos(direction-yaw)))<1e-8);
    assert.ok(buckled.handRelease>.8);assert.equal(settled.stage,'Dead');
    assert.deepEqual(settled,sampleSoldierPose(dead,'british',40),'settled corpse has no live breathing/gait');
    const {model,rig}=testRig();
    for(let i=0;i<=110;i++) {
      applySoldierPose(model,sampleSoldierPose(dead,'british',10+i/100));model.updateMatrixWorld(true);
      for(const leg of [rig.leftLeg,rig.rightLeg])assert.ok(leg.end.getWorldPosition(new THREE.Vector3()).y>=.08,'falling feet do not penetrate the floor');
      model.traverse(object=>object.matrixWorld.elements.forEach(value=>assert.ok(Number.isFinite(value))));
    }
  }
});

test('prone deaths slump in place and headshots add a distinct early head response',()=>{
  const prone=actor({alive:false,stance:'prone',deadAt:10,deathYaw:Math.PI});
  for(let i=0;i<=120;i++) {
    const pose=sampleSoldierPose(prone,'german',10+i/100);
    assert.ok(pose.pelvis[1]<.25);assert.ok(pose.pelvisRotation[0]>1.5,'prone deaths never stand up before falling');
  }
  assert.deepEqual(sampleSoldierPose(prone,'german',12),sampleSoldierPose(prone,'german',20));
  const torso=sampleSoldierPose(actor({alive:false,deadAt:10,deathYaw:Math.PI}),'russian',10.1),head=sampleSoldierPose(actor({alive:false,deadAt:10,deathYaw:Math.PI,deathHeadshot:true}),'russian',10.1);
  assert.ok(Math.abs(head.neckRotation[0])>Math.abs(torso.neckRotation[0])+.1);
});

test('world soldiers replay the visible slot and keep the movement item on the solved palm',()=>{
  const {model,rig}=testRig();rig.grenade=new THREE.Group();model.add(rig.grenade);
  const switching=actor({selectedWeapon:'grenade',switchFrom:'rifle',switchStarted:10,switchDuration:.6,ads:false});
  applySoldierPose(model,sampleSoldierPose(switching,'british',10.1));assert.equal(rig.rifle.visible,true);assert.equal(rig.grenade.visible,false);
  applySoldierPose(model,sampleSoldierPose(switching,'british',10.3));assert.equal(rig.rifle.visible,false);assert.equal(rig.grenade.visible,false,'slot change happens with both items hidden');
  applySoldierPose(model,sampleSoldierPose(switching,'british',10.6));assert.equal(rig.rifle.visible,false);assert.equal(rig.grenade.visible,true);
  for(const stance of ['stand','crouch','prone'] as const)for(let i=0;i<=100;i++) {
    const time=11+i/100,pose=sampleSoldierPose({...switching,stance},'british',time);applySoldierPose(model,pose);model.updateMatrixWorld(true);
    const hand=model.worldToLocal(rig.rightArm.end.getWorldPosition(new THREE.Vector3()));
    assert.ok(rig.grenade.position.distanceTo(hand)<.04,'grenade cannot float off an IK-clamped palm');
    assert.equal(rig.grenade.visible,true);
  }
  const dead=actor({...switching,alive:false,deadAt:11.3});
  assert.deepEqual(sampleSoldierPose(dead,'british',13),sampleSoldierPose(dead,'british',18),'death keeps its settled equipment pose');
  updateSoldier(model,switching,.016,10.6);updateSoldier(model,switching,.016,10.1);assert.equal(rig.rifle.visible,true,'replay rewind restores outgoing rifle');
});

test('world grenade bash stays on the solved palm across its vertical strike and recovery',()=>{
 const {model,rig}=testRig();rig.grenade=new THREE.Group();model.add(rig.grenade);
 const soldier=actor({selectedWeapon:'grenade',lastMeleeTime:10,ads:false});
 const raised=sampleSoldierPose(soldier,'british',10+MELEE_SECONDS*.18),strike=sampleSoldierPose(soldier,'british',10+MELEE_SECONDS*.34);
 assert.ok(raised.rightHand[1]-strike.rightHand[1]>.44,'world bash uses the same higher windup and faster strike');
 assert.ok(raised.grenadeRotation[0]<0&&strike.grenadeRotation[0]>1);
 for(let i=0;i<=100;i++){
  applySoldierPose(model,sampleSoldierPose(soldier,'british',10+MELEE_SECONDS*i/100));model.updateMatrixWorld(true);
  const hand=model.worldToLocal(rig.rightArm.end.getWorldPosition(new THREE.Vector3()));
  assert.ok(rig.grenade.position.distanceTo(hand)<.04);assert.ok(rig.grenade.visible&&!rig.rifle.visible);
 }
});

test('stance blending is frame-rate independent and pauses with simulation time',()=>{
  const one=testRig(),two=testRig(),standing=actor({ads:false}),crouched=actor({stance:'crouch',ads:false});
  updateSoldier(one.model,standing,0,0);updateSoldier(two.model,standing,0,0);
  for(let i=1;i<=60;i++)updateSoldier(one.model,crouched,1/60,i/60);
  for(let i=1;i<=120;i++)updateSoldier(two.model,crouched,1/120,i/120);
  assert.ok(one.rig.pelvis.position.distanceTo(two.rig.pelvis.position)<1e-8);
  const before=JSON.stringify(one.model.userData.animationPose);updateSoldier(one.model,crouched,.5,1);assert.equal(JSON.stringify(one.model.userData.animationPose),before);
});

test('starts and stops preserve gait phase across render frame rates',()=>{
 const simulate=(fps:number)=>{
  const {model}=testRig();updateSoldier(model,actor({moving:0}),0,0);
  for(let i=1;i<=fps;i++)updateSoldier(model,actor({moving:4.8,z:4.8*i/fps}),1/fps,i/fps);
  const running=model.userData.animationPose;
  for(let i=1;i<=fps;i++)updateSoldier(model,actor({moving:0,z:4.8}),1/fps,1+i/fps);
  return {running,stopped:model.userData.animationPose,phase:model.userData.soldierState.phase};
 };
 const reference=simulate(144);
 for(const fps of [30,60]){
  const actual=simulate(fps);
  assert.ok(Math.abs(actual.phase-reference.phase)<.00001,'eased acceleration is integrated independently of render cadence');
  for(const stage of ['running','stopped'] as const)for(const key of ['pelvis','leftFoot','rightFoot'] as const)
   assert.ok(new THREE.Vector3(...actual[stage][key]).distanceTo(new THREE.Vector3(...reference[stage][key]))<.0001);
 }
});

test('death starts from the current integrated gait without changing the planted feet',()=>{
 const {model}=testRig();updateSoldier(model,actor({moving:0}),0,0);
 for(let i=1;i<=60;i++)updateSoldier(model,actor({moving:4.8,z:i/60}),1/60,i/60);
 const before=model.userData.animationPose;
 updateSoldier(model,actor({alive:false,moving:4.8,z:1,deadAt:1}),0,1);
 const after=model.userData.animationPose;
 assert.deepEqual(after.leftFoot,before.leftFoot);assert.deepEqual(after.rightFoot,before.rightFoot);
 updateSoldier(model,actor({alive:false,moving:4.8,z:1,deadAt:1}),.1,1.1);
 assert.deepEqual(model.userData.animationPose.leftFoot,before.leftFoot,'impact keeps its planted foot targets');
});

test('replay entry and rewind use recorded event times for reload, hits and collapse',()=>{
  const {model}=testRig();
  updateSoldier(model,actor({lastShotTime:4.8}),.016,5);assert.notEqual(model.userData.animationStage,'Aiming');
  updateSoldier(model,actor({lastHurtTime:2.9}),.016,3);assert.ok(Math.abs(model.userData.animationPose.spineRotation[2])>0);
  const dead=actor({alive:false,deadAt:2.8});updateSoldier(model,dead,.016,3);
  assert.equal(model.userData.animationPose.death,sampleSoldierPose(dead,'british',3).death);
  updateSoldier(model,actor({reload:1.2,reloadTotal:3.25}),.016,2);
  assert.ok(model.userData.animationPose.weapon.boltTravel>.1);
  model.traverse(object=>{for(const value of object.matrixWorld.elements)assert.ok(Number.isFinite(value));});
});

test('cloth bridges remain connected and overlap both limb segments through deep bends',()=>{
  const {model,rig}=testRig(),material=new THREE.MeshBasicMaterial();
  rig.clothJoints=[makeClothJoint(rig.leftLeg,material,.081,.077),makeClothJoint(rig.rightArm,material,.055,.051,.085)];
  for(const joint of rig.clothJoints)model.add(joint.mesh);
  // Moving the whole actor must not move the model-local deforming cloth.
  model.position.set(4,2,-7);model.rotation.y=.8;
  for(const stance of ['stand','crouch','prone'] as const)for(const pitch of [-.9,0,.9])for(let i=0;i<=20;i++) {
    const pose=sampleSoldierPose(actor({stance,pitch,moving:1.7}),'british',i/10);
    applySoldierPose(model,pose);
    for(const joint of rig.clothJoints) {
      const positions=joint.mesh.geometry.getAttribute('position'),normal=joint.mesh.geometry.getAttribute('normal');
      for(const value of [...positions.array,...normal.array])assert.ok(Number.isFinite(value),'a folded cloth hinge must not produce NaNs');
      const middle=model.worldToLocal(joint.chain.middle.getWorldPosition(new THREE.Vector3()));
      const root=model.worldToLocal(joint.chain.root.getWorldPosition(new THREE.Vector3()));
      const end=model.worldToLocal(joint.chain.end.getWorldPosition(new THREE.Vector3()));
      const ringCenter=(offset:number)=>{const result=new THREE.Vector3();for(let k=0;k<16;k++)result.add(new THREE.Vector3().fromBufferAttribute(positions,offset+k));return result.multiplyScalar(1/16);};
      const first=ringCenter(0),last=ringCenter(12*17);
      assert.ok(first.distanceTo(middle.clone().addScaledVector(middle.clone().sub(root).normalize(),-joint.reach))<1e-6,'upper edge must overlap the upper limb');
      assert.ok(last.distanceTo(middle.clone().addScaledVector(end.clone().sub(middle).normalize(),joint.reach))<1e-6,'lower edge must overlap the lower limb');
      for(let ring=0;ring<12;ring++)for(let vertex=0;vertex<17;vertex++) {
        const a=new THREE.Vector3().fromBufferAttribute(positions,ring*17+vertex),b=new THREE.Vector3().fromBufferAttribute(positions,(ring+1)*17+vertex);
        assert.ok(a.distanceTo(b)<.10,'adjacent cloth rings cannot separate into floating joint pieces');
      }
    }
  }
});
