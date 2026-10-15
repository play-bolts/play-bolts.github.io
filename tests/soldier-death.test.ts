import test,{before} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {FACTIONS,WEAPONS} from '../src/config.ts';
import {loadHandAssetFromBuffer} from '../src/hands.ts';
import {loadSoldierModelFromBuffer} from '../src/soldierModelAssets.ts';
import {loadImportedWeaponFromBuffer} from '../src/importedWeapons.ts';
import {makeSoldier} from '../src/soldier.ts';
import {sampleSoldierPose,applySoldierPose,type SoldierActor,type SoldierRig} from '../src/soldierAnimation.ts';

const bytes=(path:string)=>{const b=readFileSync(new URL(`../public/assets/${path}`,import.meta.url));return b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength) as ArrayBuffer;};
const json=(path:string)=>JSON.parse(readFileSync(new URL(`../public/assets/${path}`,import.meta.url),'utf8'));
before(async()=>{
 const loader=new GLTFLoader();loader.register(()=>({name:'death-test-maps',loadTexture:()=>Promise.resolve(new THREE.Texture())}));
 for(const side of ['left','right']as const)await loadHandAssetFromBuffer(side,bytes(`arms/hand-${side[0]}.glb`),loader);
 for(const faction of FACTIONS){const rifle={british:'enfield',russian:'mosin',german:'kar98k'}[faction];
  await loadImportedWeaponFromBuffer(bytes(`imported-weapons/${rifle}.glb`),json(`imported-weapons/${rifle}-profile.json`),loader);
  await loadSoldierModelFromBuffer(bytes(`imported-soldiers/${faction}.glb`),json(`imported-soldiers/${faction}-profile.json`),loader);
 }
});
const actor=(patch:Partial<SoldierActor>={}):SoldierActor=>({id:1,x:0,y:0,z:0,yaw:0,pitch:0,stance:'stand',alive:false,deadAt:0,moving:0,ads:false,recoil:0,cooldown:0,reload:0,reloadTotal:0,selectedWeapon:'rifle',...patch});

test('actual corpse arms release beside the torso with fixed lengths, neutral wrists and floor clearance',()=>{
 for(const faction of FACTIONS){
  const model=makeSoldier(faction),rig=model.userData.soldierRig as SoldierRig;
  model.position.set(2,.4,-3);model.rotation.y=.7;
  for(const stance of ['stand','crouch','prone']as const)for(const ads of [false,true])for(let direction=0;direction<8;direction++){
   const subject=actor({stance,ads,deathYaw:direction*Math.PI/4}),previous=new Map<string,THREE.Vector3>();
   for(let i=0;i<=144;i++){
    const time=i/120,pose=sampleSoldierPose(subject,faction,time);applySoldierPose(model,pose);model.updateMatrixWorld(true);
    for(const side of ['left','right']as const){
     const arm=side==='left'?rig.leftArm:rig.rightArm,label=`${faction}/${stance}/${ads}/${direction}/${time}/${side}`;
     const shoulder=arm.root.getWorldPosition(new THREE.Vector3()),elbow=arm.middle.getWorldPosition(new THREE.Vector3()),wrist=arm.end.getWorldPosition(new THREE.Vector3());
     assert.ok(Math.abs(shoulder.distanceTo(elbow)-arm.upperLength)<1e-7,`${label}: upper arm keeps its physical length`);
     assert.ok(Math.abs(elbow.distanceTo(wrist)-arm.lowerLength)<1e-7,`${label}: forearm keeps its physical length`);
     assert.ok(arm.end.quaternion.angleTo(new THREE.Quaternion())<35*Math.PI/180,`${label}: wrist cannot fold backwards`);
     const cuff=rig.hands![side].hand.localToWorld(rig.hands![side].hand.userData.wristSkinLocal.clone());
     assert.ok(cuff.distanceTo(wrist)<1e-8,`${label}: actual hand skin stays attached to sleeve`);
     if(pose.handRelease>0){assert.ok(elbow.y>=model.position.y+.085-1e-7,`${label}: elbow clears the floor`);assert.ok(wrist.y>=model.position.y+.035-1e-7,`${label}: wrist clears the floor`);}
     if(pose.handRelease===1){
      const chest=arm.root.parent!.getWorldQuaternion(new THREE.Quaternion()).invert(),upper=elbow.clone().sub(shoulder).applyQuaternion(chest);
      assert.ok(upper.z>-arm.upperLength*Math.sin(70*Math.PI/180),`${label}: shoulder extension stays bounded during collapse`);
      assert.ok(upper.x*(side==='left'?1:-1)>-arm.upperLength*Math.sin(40*Math.PI/180),`${label}: the upper-side arm cannot fold across the chest`);
      assert.ok(upper.y<.025,`${label}: elbow stays below the shoulder in the torso frame`);
      assert.ok(arm.end.quaternion.angleTo(new THREE.Quaternion())<1e-5,`${label}: released wrist relaxes along the forearm`);
     }
     if(i===144){
      const chest=arm.root.parent!.getWorldQuaternion(new THREE.Quaternion()).invert(),upper=elbow.clone().sub(shoulder).applyQuaternion(chest);
      assert.ok(upper.z>-arm.upperLength*Math.sin(55*Math.PI/180),`${label}: settled shoulder has no backward crumple`);
      let lowest=Infinity;
      rig.hands![side].hand.traverse(object=>{if(!(object instanceof THREE.SkinnedMesh))return;object.skeleton.update();
       for(let vertex=0;vertex<object.geometry.getAttribute('position').count;vertex++)lowest=Math.min(lowest,object.localToWorld(object.getVertexPosition(vertex,new THREE.Vector3())).y-model.position.y);
      });
      assert.ok(lowest>=.0029&&lowest<.008,`${label}: actual released fingertips rest on the floor, not in the air (${lowest}m)`);
     }
     const before=previous.get(side);if(before)assert.ok(before.distanceTo(elbow)<.060,`${label}: no discontinuous elbow branch (${before.distanceTo(elbow)}m)`);
     previous.set(side,elbow);
    }
   }
  }
 }
});

test('death captures the interrupted action once and absolute scrubbing cannot change the settled body',()=>{
 for(const faction of FACTIONS){
  const model=makeSoldier(faction),rig=model.userData.soldierRig as SoldierRig;
  for(const patch of [{},{selectedWeapon:'grenade'},{reloadTotal:WEAPONS[faction].reload,reload:WEAPONS[faction].reload*.5},{lastShotTime:-.25}] as Partial<SoldierActor>[]){
   const subject=actor({...patch,deathYaw:Math.PI}),early=sampleSoldierPose(subject,faction,.1),late=sampleSoldierPose(subject,faction,1.1);
   assert.deepEqual(early.deathStart,late.deathStart,'releasing hands do not repeatedly chase a later action pose');
   const snapshot=()=>[rig.leftArm.root,rig.leftArm.middle,rig.leftArm.end,rig.rightArm.root,rig.rightArm.middle,rig.rightArm.end].map(j=>j.matrixWorld.toArray());
   applySoldierPose(model,late);model.updateMatrixWorld(true);const expected=snapshot();
   applySoldierPose(model,early);applySoldierPose(model,late);model.updateMatrixWorld(true);assert.deepEqual(snapshot(),expected,'replay seeks reconstruct the same corpse');
   const live=sampleSoldierPose({...subject,alive:true},faction,0);assert.equal(live.deathStart,undefined,'the release solver has no live-state input or effect');
  }
 }
});

test('released hand skin is continuous through floor-fit activation and final finger relaxation',()=>{
 for(const faction of FACTIONS){
  const model=makeSoldier(faction),rig=model.userData.soldierRig as SoldierRig;
  for(const stance of ['stand','crouch','prone']as const)for(const direction of [0,Math.PI/2,Math.PI,Math.PI*1.5]){
   const subject=actor({stance,deathYaw:direction}),center=stance==='prone'?.42:.34;
   let previous:THREE.Vector3[]|undefined;
   for(let i=-12;i<=12;i++){
    applySoldierPose(model,sampleSoldierPose(subject,faction,center+i/240));model.updateMatrixWorld(true);
    const skin:THREE.Vector3[]=[];
    for(const side of ['left','right']as const)rig.hands![side].hand.traverse(object=>{
     if(!(object instanceof THREE.SkinnedMesh))return;object.skeleton.update();
     for(let vertex=0;vertex<object.geometry.getAttribute('position').count;vertex+=37)skin.push(object.localToWorld(object.getVertexPosition(vertex,new THREE.Vector3())));
    });
    if(previous)skin.forEach((point,index)=>assert.ok(point.distanceTo(previous![index])<.040,`${faction}/${stance}/${direction}/${i}: actual fingers cannot snap when release reaches one`));
    previous=skin;
   }
  }
 }
});

test('final face-down chest settles onto the ground without changing the early fall or side/back clearance',()=>{
 for(const faction of FACTIONS){
  const front=actor({deathYaw:0}),back=actor({deathYaw:Math.PI}),side=actor({deathYaw:Math.PI/2});
  assert.equal(sampleSoldierPose(front,faction,.40).pelvis[1],sampleSoldierPose(back,faction,.40).pelvis[1],'approved early/mid collapse keeps its original height');
  assert.equal(sampleSoldierPose(back,faction,1.2).pelvis[1],.285);assert.equal(sampleSoldierPose(side,faction,1.2).pelvis[1],.285);
  const model=makeSoldier(faction);applySoldierPose(model,sampleSoldierPose(front,faction,1.2));model.updateMatrixWorld(true);
  let chest=Infinity;
  model.traverse(object=>{
   if(!(object instanceof THREE.SkinnedMesh)||object.skeleton.bones.length!==15)return;object.skeleton.update();
   const positions=object.geometry.getAttribute('position'),indices=object.geometry.getAttribute('skinIndex'),weights=object.geometry.getAttribute('skinWeight');
   for(let vertex=0;vertex<positions.count;vertex++)for(let influence=0;influence<4;influence++)if(indices.getComponent(vertex,influence)===1&&weights.getComponent(vertex,influence)>.5){
    chest=Math.min(chest,object.localToWorld(object.getVertexPosition(vertex,new THREE.Vector3())).y);
   }
  });
  assert.ok(chest>.005&&chest<.030,`${faction}: real chest skin settles near the floor rather than holding a push-up (${chest}m)`);
 }
});
