import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {FACTIONS,MELEE_SECONDS} from '../src/config.ts';
import {makeRifle} from '../src/rifle.ts';
import {applyWeaponAnimation,sampleWeaponAnimation,sampleWeaponSwitch,sampleGrenadeReadyPose,sampleGrenadeMelee,applyGrenadePose,MELEE_ANIMATION_SECONDS} from '../src/weaponAnimation.ts';
import {sampleSoldierPose,type SoldierActor} from '../src/soldierAnimation.ts';

test('first-person and world melee poses share the faster simulation recovery time',()=>{
  assert.equal(MELEE_ANIMATION_SECONDS,MELEE_SECONDS);assert.ok(Math.abs(MELEE_ANIMATION_SECONDS*1.2-.85)<1e-12);
  const actor:SoldierActor={id:1,x:0,y:0,z:0,yaw:0,pitch:0,stance:'stand',alive:true,moving:0,ads:false,recoil:0,cooldown:0,reload:0,reloadTotal:0,lastMeleeTime:0};
  for(const faction of FACTIONS){
    const strikeTime=MELEE_SECONDS*.38;
    assert.deepEqual(sampleSoldierPose(actor,faction,strikeTime).weapon,sampleWeaponAnimation(faction,'melee',strikeTime/MELEE_ANIMATION_SECONDS));
    assert.deepEqual(sampleSoldierPose(actor,faction,MELEE_SECONDS).weapon,sampleWeaponAnimation(faction,'idle',0));
  }
});

test('reload, bolt and melee return both hands and the rifle to their exact ready pose',()=>{
  for(const faction of FACTIONS) for(const action of ['reload','cycle','melee'] as const) {
    const ready=sampleWeaponAnimation(faction,'idle',0),end=sampleWeaponAnimation(faction,action,1,true);
    for(const key of ['position','rotation','right','rightRotation','left','leftRotation'] as const) assert.deepEqual(end[key],ready[key],`${faction} ${action} ${key}`);
    assert.equal(end.boltLift,0);assert.equal(end.boltTravel,0);assert.equal(end.clipVisible,false);
  }
});

test('the support hand holds the fore-end throughout reload and bolt manipulation',()=>{
  for(const faction of FACTIONS) for(const action of ['reload','cycle'] as const) {
    const ready=sampleWeaponAnimation(faction,'idle',0);
    for(let i=0;i<=100;i++) assert.deepEqual(sampleWeaponAnimation(faction,action,i/100,true).left,ready.left);
  }
  const lift=sampleWeaponAnimation('german','cycle',.23),extract=sampleWeaponAnimation('german','cycle',.49),closed=sampleWeaponAnimation('german','cycle',.85);
  assert.ok(lift.boltLift>0);assert.equal(lift.boltTravel,0);
  assert.ok(extract.boltLift>.99&&extract.boltTravel>.1);
  assert.equal(closed.boltLift,0);assert.equal(closed.boltTravel,0);
});

test('full Lee-Enfield reload presents two chargers; other reloads present one',()=>{
  for(const faction of FACTIONS) for(const full of [false,true]) {
    let count=0,visible=false,pressed=false;
    for(let i=0;i<=1000;i++) {
      const pose=sampleWeaponAnimation(faction,'reload',i/1000,full);
      if(pose.clipVisible&&!visible)count++;
      visible=pose.clipVisible;if(visible&&pose.clipPress>.9)pressed=true;
    }
    assert.equal(count,faction==='british'&&full?2:1);assert.equal(pressed,true);
  }
});

test('animation scrubbing is deterministic and keeps both hands attached during melee',()=>{
  for(const faction of FACTIONS) {
    const ready=sampleWeaponAnimation(faction,'idle',0);
    for(let i=0;i<=1000;i++) {
      const t=i/1000;
      for(const action of ['cycle','reload','melee'] as const) {
        const pose=sampleWeaponAnimation(faction,action,t,true);
        assert.deepEqual(pose,sampleWeaponAnimation(faction,action,t,true));
        for(const value of Object.values(pose).flat()) if(typeof value==='number')assert.ok(Number.isFinite(value));
        if(action==='melee') {assert.deepEqual(pose.right,ready.right);assert.ok(Math.abs(pose.left[2]-ready.left[2])<=.051);}
      }
    }
  }
});

test('rifle switching hides the hand-off, then raises and settles the incoming weapon',()=>{
  assert.deepEqual(sampleWeaponSwitch(0).position,[0,0,0]);
  assert.deepEqual(sampleWeaponSwitch(1).position,[0,0,0]);
  assert.deepEqual(sampleWeaponSwitch(1).rotation,[0,0,0]);
  const before=sampleWeaponSwitch(.499999),after=sampleWeaponSwitch(.500001);
  assert.equal(before.item,'from');assert.equal(after.item,'to');
  assert.equal(before.hidden,true);assert.equal(after.hidden,true);
  assert.deepEqual(before.position,after.position);assert.ok(before.position[1]<-.2&&before.position[2]>.2,'lower and withdraw inside real arm reach');
  assert.ok(sampleWeaponSwitch(.2).position[1]<0);assert.ok(sampleWeaponSwitch(.8).position[1]<0);
  for(let i=1;i<=1000;i++) {
    const previous=sampleWeaponSwitch((i-1)/1000),pose=sampleWeaponSwitch(i/1000);
    assert.deepEqual(pose,sampleWeaponSwitch(i/1000));
    assert.ok(new THREE.Vector3(...pose.position).distanceTo(new THREE.Vector3(...previous.position))<.004,'no visible switch-position pop');
  }
});

test('melee draws and strikes from the right while both palms remain on their grips',()=>{
  for(const faction of FACTIONS) {
    const ready=sampleWeaponAnimation(faction,'idle',0),draw=sampleWeaponAnimation(faction,'melee',.20),strike=sampleWeaponAnimation(faction,'melee',.38);
    assert.ok(draw.rotation[1]>.9&&strike.rotation[1]>Math.PI/2,'turn the buttstock past square instead of shoving the muzzle');
    assert.ok(strike.position[0]<draw.position[0]-.1,'the strike moves from the right-side draw toward the center');
    assert.equal(strike.unshoulder,1,'a buttstock smash comes out of the sights');
    assert.deepEqual(strike.right,ready.right);assert.ok(Math.abs(strike.left[2]-ready.left[2])<.051);
  }
});

test('grenade bash raises higher and strikes early while retaining its grip',()=>{
 const ready=sampleGrenadeReadyPose(),raised=sampleGrenadeMelee(.18),strike=sampleGrenadeMelee(.34);
 assert.ok(raised.position[1]>=.31&&strike.position[1]<-.1,'higher windup and completed strike within the first third of the swing');
 assert.ok(raised.rotation[0]>.5&&strike.rotation[0]<-1);
 assert.ok(sampleGrenadeMelee(.26).position[1]<.10,'the downward strike crosses its midpoint before the old strike phase');
 assert.equal(sampleGrenadeMelee(.45).stage,'Recover grip','recovery begins sooner without shortening the melee cooldown');
 for(let i=0;i<=100;i++){
  const pose=sampleGrenadeMelee(i/100);
  assert.ok(Math.abs(pose.position[0])<.05&&Math.abs(pose.rotation[1])<.01,'vertical rather than sideways swing');
  for(const key of ['right','rightRotation','grenadePosition','grenadeRotation'] as const)assert.deepEqual(pose[key],ready[key],'palm never releases handle');
 }
 for(const t of [0,1])for(const key of ['position','rotation'] as const)assert.deepEqual(sampleGrenadeMelee(t)[key],ready[key]);
});

test('the carried grenade stays visible and attached to the gripping palm',()=>{
  const pose=sampleGrenadeReadyPose();assert.equal(pose.grenadeVisible,true);assert.equal(pose.leftVisible,false);
  const item=new THREE.Group(),right=new THREE.Group(),left=new THREE.Group(),grenade=new THREE.Group(),rightForearm=new THREE.Mesh(),leftForearm=new THREE.Mesh();
  item.userData.grenadeRig={right,left,grenade,rightForearm,leftForearm};item.add(right,left,grenade,rightForearm,leftForearm);
  applyGrenadePose(item,pose);item.updateMatrixWorld(true);
  assert.ok(Math.abs(grenade.position.distanceTo(right.position)-new THREE.Vector3(.03-.05,-.05+.074,-.20+.185).length())<1e-10,'grenade remains attached to palm');
  assert.equal(grenade.visible,true);assert.equal(left.visible,false);
  const before=grenade.matrix.toArray();applyGrenadePose(item,sampleGrenadeReadyPose());item.updateMatrixWorld(true);assert.deepEqual(grenade.matrix.toArray(),before);
  item.traverse(object=>object.matrixWorld.elements.forEach(value=>assert.ok(Number.isFinite(value))));
});

test('first-person rifles keep independent hands and complete skinned sleeves with absolute poses',()=>{
  const original=globalThis.document;
  // Canvas texture generation only; no rendering or mocked model geometry.
  globalThis.document={createElement:()=>({width:0,height:0,getContext:()=>({createImageData:(w:number,h:number)=>({data:new Uint8ClampedArray(w*h*4)}),putImageData(){},beginPath(){},moveTo(){},bezierCurveTo(){},stroke(){}})})} as unknown as Document;
  try {
    for(const faction of FACTIONS) {
      const rifle=makeRifle(faction,true);
      for(const name of ['left-hand','right-hand','left-forearm','right-forearm']) assert.equal(rifle.getObjectByName(name)?.parent,rifle);
      for(const action of ['reload','cycle','melee'] as const) for(const t of [0,.2,.4,.6,.8,1]) {
        const pose=sampleWeaponAnimation(faction,action,t,true);applyWeaponAnimation(rifle,pose);rifle.updateMatrixWorld(true);
        rifle.traverse(object=>{for(const value of object.matrixWorld.elements)assert.ok(Number.isFinite(value));});
        const right=rifle.getObjectByName('right-hand')!,before=right.matrix.clone();
        applyWeaponAnimation(rifle,pose);rifle.updateMatrixWorld(true);assert.deepEqual(right.matrix.elements,before.elements);
        assert.ok(rifle.getObjectByName('left-forearm')!.scale.y>.2);
      }
      const geometry=new Set<THREE.BufferGeometry>();rifle.traverse(o=>{if(o instanceof THREE.Mesh)geometry.add(o.geometry);});geometry.forEach(g=>g.dispose());
    }
  } finally {globalThis.document=original;}
});
