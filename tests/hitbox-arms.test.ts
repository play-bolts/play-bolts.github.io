import test,{before} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {FACTIONS,WEAPONS,MELEE_SECONDS,type Faction} from '../src/config.ts';
import {loadHandAssetFromBuffer} from '../src/hands.ts';
import {makeSoldierHand,poseSoldierHand,soldierHandContact} from '../src/soldierHands.ts';
import {loadSoldierModelFromBuffer,SOLDIER_BONES} from '../src/soldierModelAssets.ts';
import {loadImportedWeaponFromBuffer} from '../src/importedWeapons.ts';
import {makeSoldier} from '../src/soldier.ts';
import {applySoldierPose} from '../src/soldierAnimation.ts';
import {sampleWeaponAnimation} from '../src/weaponAnimation.ts';
import {sampleCollisionHandContact,solveHitboxArms,type ArmRigData} from '../src/hitboxArms.ts';
import {sampleHitboxCore} from '../src/hitboxCore.ts';
import type {HitActor} from '../src/hitboxes.ts';
import data from '../src/generated/hitboxData.json';
const bytes=(path:string)=>{const b=readFileSync(new URL(`../public/assets/${path}`,import.meta.url));return b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength) as ArrayBuffer;};
const json=(path:string)=>JSON.parse(readFileSync(new URL(`../public/assets/${path}`,import.meta.url),'utf8'));
before(async()=>{
 const loader=new GLTFLoader();loader.register(()=>({name:'arm-collision-textures',loadTexture:()=>Promise.resolve(new THREE.Texture())}));
 for(const side of ['left','right'] as const)await loadHandAssetFromBuffer(side,bytes(`arms/hand-${side[0]}.glb`),loader);
 for(const faction of FACTIONS){const weapon={british:'enfield',russian:'mosin',german:'kar98k'}[faction];
  await loadImportedWeaponFromBuffer(bytes(`imported-weapons/${weapon}.glb`),json(`imported-weapons/${weapon}-profile.json`),loader);
  await loadSoldierModelFromBuffer(bytes(`imported-soldiers/${faction}.glb`),json(`imported-soldiers/${faction}-profile.json`),loader);
 }
});
test('CPU hand contact FK exactly reproduces the selected deformed skin vertices',()=>{
 for(const side of ['left','right'] as const){
  const hand=makeSoldierHand(side)!,parent=new THREE.Group();parent.position.set(3,5,-2);parent.rotation.set(.8,-1.2,.4);parent.add(hand.frame);
  for(const slot of ['rifle','grenade'] as const)for(const action of ['idle','cycle','reload','melee'] as const)for(let i=0;i<=50;i++)for(const release of [0,.5,1]){
   const pose=sampleWeaponAnimation('british',action,i/50);poseSoldierHand(hand,side,pose,slot,release);
   const actual=soldierHandContact(hand,side==='right'?pose.thumbContact:0),cpu=sampleCollisionHandContact(side,pose,slot,release);
   assert.ok(actual.distanceTo(cpu.contact)<1e-9,`${side}/${slot}/${action}/${i/50}: contact is actual skin FK, not a pose lookup`);
  }
 }
});
function actor(faction:Faction,patch:Partial<HitActor>={}):HitActor{return{id:2,faction,x:0,y:0,z:0,yaw:0,pitch:0,stance:'stand',ads:false,moving:0,lean:0,alive:true,reload:0,reloadTotal:0,recoil:0,grounded:true,vy:0,jumpStarted:-1000,landedAt:-1000,landingSpeed:0,lastShotTime:-1000,lastMeleeTime:-1000,lastHurtTime:-1000,selectedWeapon:'rifle',...patch};}
test('CPU held-prop fitting reproduces all six rendered arm bones through stance and action transitions',()=>{
 const patches:Partial<HitActor>[]=[{},...['crouch','prone'].map(stance=>({stance} as Partial<HitActor>)),{ads:true,pitch:1.2},{ads:true,pitch:-1.2},{moving:4.8},{moving:2.4,pose:{phase:.37,crouch:.47,prone:.21,aim:.68,speed:2.4,forward:-.4,sideways:.8}},
  ...[.1,.25,.3,.4,.55,.75,.85].map(t=>({reload:3.2*(1-t),reloadTotal:3.2})),
  ...[.1,.4,.8].map(t=>({lastShotTime:10-t*1.1})),
  ...[.1,.22,.35,.4,.7].map(t=>({lastMeleeTime:10-t*MELEE_SECONDS})),
  {selectedWeapon:'grenade'},...['rifle','grenade'].flatMap(slot=>[.2,.35,.55,.7,.9].map(t=>({selectedWeapon:slot,switchFrom:slot==='rifle'?'grenade':'rifle',switchStarted:10-t*.6,switchDuration:.6} as Partial<HitActor>))),
  ...[.1,.2,.34,.7].map(t=>({selectedWeapon:'grenade',lastMeleeTime:10-t*MELEE_SECONDS} as Partial<HitActor>)),
 ];
 for(const faction of FACTIONS){const model=makeSoldier(faction);model.position.set(2,.4,-3);model.rotation.set(0,.9,0);
  for(const patch of patches){const input=actor(faction,patch),{pose,bones}=sampleHitboxCore(input,10),solved=solveHitboxArms(pose,bones[1],data.rigs[faction] as ArmRigData);
   applySoldierPose(model,pose);model.updateMatrixWorld(true);const inverse=model.getWorldQuaternion(new THREE.Quaternion()).invert();
   for(let i=3;i<=8;i++){
    const bone=model.getObjectByName(`skin-${SOLDIER_BONES[i]}`)!.parent!,point=model.worldToLocal(bone.getWorldPosition(new THREE.Vector3())),rotation=inverse.clone().multiply(bone.getWorldQuaternion(new THREE.Quaternion()));
    assert.ok(point.distanceTo(solved.bones[i].position)<1e-7,`${faction}/${JSON.stringify(patch)}/${SOLDIER_BONES[i]} position error ${point.distanceTo(solved.bones[i].position)}`);
    assert.ok(rotation.angleTo(solved.bones[i].rotation)<1e-6,`${faction}/${SOLDIER_BONES[i]} orientation matches rendered cloth`);
   }
  }
 }
});

test('world melee drives the imported buttplate ahead of the muzzle from the soldier right side',()=>{
 for(const faction of FACTIONS){
  const model=makeSoldier(faction),rig=model.userData.soldierRig,rifle=rig.rifle as THREE.Group;
  model.updateMatrixWorld(true);const inverse=rifle.matrixWorld.clone().invert(),points:THREE.Vector3[]=[];
  rifle.getObjectByName('furniture')!.traverse(object=>{if(object instanceof THREE.Mesh){const p=object.geometry.getAttribute('position');for(let i=0;i<p.count;i++)points.push(new THREE.Vector3().fromBufferAttribute(p,i).applyMatrix4(object.matrixWorld).applyMatrix4(inverse));}});
  const z=Math.max(...points.map(p=>p.z)),butt=new THREE.Box3().setFromPoints(points.filter(p=>p.z>z-.012)).getCenter(new THREE.Vector3());
  const muzzle=new THREE.Vector3(...data.rigs[faction].weaponProfile.muzzle);
  for(const stance of ['stand','crouch','prone'] as const)for(const ads of [false,true]){
   const at=(progress:number)=>{const{pose}=sampleHitboxCore(actor(faction,{stance,ads,lastMeleeTime:10-progress*MELEE_SECONDS}),10);applySoldierPose(model,pose);model.updateMatrixWorld(true);return{butt:rifle.localToWorld(butt.clone()),muzzle:rifle.localToWorld(muzzle.clone())};};
   const draw=at(.22),impact=at(.40);
   assert.ok(draw.butt.x<-.08,`${faction}/${stance}/${ads}: actual butt winds up on anatomical right`);
   assert.ok(impact.butt.x>draw.butt.x+.04,`${faction}/${stance}/${ads}: stock sweeps inward from the right`);
   assert.ok(impact.butt.z-impact.muzzle.z>.25,`${faction}/${stance}/${ads}: the actual buttplate leads the muzzle toward the target`);
  }
 }
});
