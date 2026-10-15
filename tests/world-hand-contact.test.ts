import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {loadSoldierModelFromBuffer} from '../src/soldierModelAssets.ts';
import {loadImportedWeaponFromBuffer} from '../src/importedWeapons.ts';
import {makeSoldier} from '../src/soldier.ts';
import {applySoldierPose,getSoldierPalmContact,sampleSoldierPose,type SoldierActor} from '../src/soldierAnimation.ts';
import {MELEE_SECONDS,WEAPONS} from '../src/config.ts';
import {loadHandAssetFromBuffer} from '../src/hands.ts';

const bytes=(path:string)=>{const file=readFileSync(new URL(path,import.meta.url));return file.buffer.slice(file.byteOffset,file.byteOffset+file.byteLength) as ArrayBuffer;};
const json=(path:string)=>JSON.parse(readFileSync(new URL(path,import.meta.url),'utf8'));
const loader=()=>{const result=new GLTFLoader();result.register(()=>({name:'test-maps',loadTexture:()=>Promise.resolve(new THREE.Texture())}));return result;};
const actor=(patch:Partial<SoldierActor>={}):SoldierActor=>({id:1,x:0,y:0,z:0,yaw:0,pitch:0,stance:'stand',alive:true,moving:0,ads:false,recoil:0,cooldown:0,reload:0,reloadTotal:0,...patch});

test('real imported palm skin supports the source wood through standing, crouch, prone and aim',async()=>{
 for(const [faction,file]of [['british','enfield'],['russian','mosin'],['german','kar98k']]as const){
  await loadSoldierModelFromBuffer(bytes(`../public/assets/imported-soldiers/${faction}.glb`),json(`../public/assets/imported-soldiers/${faction}-profile.json`),loader());
  await loadImportedWeaponFromBuffer(bytes(`../public/assets/imported-weapons/${file}.glb`),json(`../public/assets/imported-weapons/${file}-profile.json`),loader());
  const model=makeSoldier(faction),rig=model.userData.soldierRig;
  assert.equal(rig.hands,undefined,'without cached digit assets the original continuous source hands remain available');
  model.position.set(2,0,-3);model.rotation.y=.7;
  const wood:THREE.Mesh[]=[];
  rig.rifle.getObjectByName('furniture')!.traverse((object:THREE.Object3D)=>{
   if(!(object instanceof THREE.Mesh))return;
   const materials=Array.isArray(object.material)?object.material:[object.material];
   if(faction==='german'||materials.some(material=>/wood|walnut/i.test(material.name))){wood.push(object);materials.forEach(material=>material.side=THREE.DoubleSide);}
  });
  const ray=new THREE.Raycaster();
  for(const stance of ['stand','crouch','prone']as const)for(const ads of [false,true]){
   const pose=sampleSoldierPose(actor({stance,ads}),faction,0);applySoldierPose(model,pose);model.updateMatrixWorld(true);
   for(const side of ['left','right']as const){
    const skin=getSoldierPalmContact(model,side);assert.ok(skin,'a fully hand-weighted palm vertex exists in the real source mesh');
    const point=rig.rifle.worldToLocal(skin.clone());
    assert.ok(point.toArray().every(Number.isFinite));
    const origin=rig.rifle.localToWorld(new THREE.Vector3(point.x,.3,point.z));
    const direction=new THREE.Vector3(0,-1,0).transformDirection(rig.rifle.matrixWorld);
    ray.set(origin,direction);const hits=ray.intersectObjects(wood);
    assert.ok(hits.length>=2,`${faction}/${stance}/${side} palm reaches actual wood rather than an empty receiver gap`);
    const underside=Math.min(...hits.map(hit=>rig.rifle.worldToLocal(hit.point.clone()).y));
    assert.ok(Math.abs(point.y-underside)<.001,`${faction}/${stance}/${side} actual palm skin stays within 1 mm of the stock underside (${point.y-underside}m)`);
   }
  }
  const ready=sampleSoldierPose(actor({stance:'crouch',ads:true}),faction,0);applySoldierPose(model,ready);model.updateMatrixWorld(true);
  const exact=[rig.leftArm.end,rig.rightArm.end,rig.riflePivot].map(object=>object.matrixWorld.elements.slice());
  for(let i=0;i<=20;i++){
   const pose=sampleSoldierPose(actor({reload:3.2*(1-i/20),reloadTotal:3.2}),faction,i/20);applySoldierPose(model,pose);model.updateMatrixWorld(true);
   for(const side of ['left','right']as const)assert.ok(getSoldierPalmContact(model,side)!.toArray().every(Number.isFinite));
  }
  applySoldierPose(model,ready);model.updateMatrixWorld(true);
  [rig.leftArm.end,rig.rightArm.end,rig.riflePivot].forEach((object,index)=>assert.deepEqual(object.matrixWorld.elements,exact[index],'absolute pose scrubbing preserves both source hand fits'));
 }
});

test('source arms retain fixed lengths, neutral wrists and continuous elbow poles through complete actions',async()=>{
 for(const [side,file]of [['left','l'],['right','r']]as const)await loadHandAssetFromBuffer(side,bytes(`../public/assets/arms/hand-${file}.glb`),loader());
 for(const [faction,file]of [['british','enfield'],['russian','mosin'],['german','kar98k']]as const){
  await loadSoldierModelFromBuffer(bytes(`../public/assets/imported-soldiers/${faction}.glb`),json(`../public/assets/imported-soldiers/${faction}-profile.json`),loader());
  await loadImportedWeaponFromBuffer(bytes(`../public/assets/imported-weapons/${file}.glb`),json(`../public/assets/imported-weapons/${file}-profile.json`),loader());
  const model=makeSoldier(faction),rig=model.userData.soldierRig;
  assert.ok(rig.hands,'this sweep exercises the articulated replacement assets');
  assert.ok(rig.leftArm.root.position.x>0&&rig.rightArm.root.position.x<0,'+Z-facing soldiers use anatomical support/operating sides');
  model.position.set(-2,.4,3);model.rotation.y=-.8;
  for(const stance of ['stand','crouch','prone']as const)for(const pitch of [-.9,0,.9])for(const action of ['idle','aim','reload','cycle','melee','grenade','grenade-bash']as const){
   const previous=new Map<string,THREE.Vector3>();
   const at=(t:number)=>{
    const patch:Partial<SoldierActor>={stance,pitch};
    let time=10;
    if(action==='aim')patch.ads=true;
    if(action==='reload'){patch.reloadTotal=WEAPONS[faction].reload;patch.reload=patch.reloadTotal*(1-t);}
    if(action==='cycle'){patch.lastShotTime=10;time+=WEAPONS[faction].cycle*t;}
    if(action==='melee'||action==='grenade-bash'){patch.lastMeleeTime=10;time+=MELEE_SECONDS*t;}
    if(action==='grenade'||action==='grenade-bash')patch.selectedWeapon='grenade';
    return{patch,time,pose:sampleSoldierPose(actor(patch),faction,time)};
   };
   for(let i=0;i<=120;i++){
    const t=i/120,label=`${faction}/${stance}/${pitch}/${action}/${t}`,{patch,time,pose}=at(t);
    applySoldierPose(model,pose);model.updateMatrixWorld(true);
    for(const side of ['left','right']as const){
     const arm=rig[side==='left'?'leftArm':'rightArm'];
     const shoulder=arm.root.getWorldPosition(new THREE.Vector3()),elbow=arm.middle.getWorldPosition(new THREE.Vector3()),wrist=arm.end.getWorldPosition(new THREE.Vector3());
     assert.ok(Math.abs(elbow.distanceTo(shoulder)-arm.upperLength)<1e-7,`${label}/${side} upper arm length`);
     assert.ok(Math.abs(wrist.distanceTo(elbow)-arm.lowerLength)<1e-7,`${label}/${side} forearm length`);
     assert.ok(elbow.y>model.position.y+.085,`${label}/${side} elbow skin clears the ground`);
     if(action==='aim'&&Math.abs(pitch)<.5&&stance!=='prone')assert.ok(elbow.y<shoulder.y+.005,`${label}/${side} ordinary aim keeps the elbow below shoulder height`);
     const handAxis=new THREE.Vector3(0,-1,0).applyQuaternion(arm.end.getWorldQuaternion(new THREE.Quaternion()));
     const limit=(patch.selectedWeapon==='grenade'&&side==='left'?20:35)*Math.PI/180+.002;
     assert.ok(wrist.clone().sub(elbow).angleTo(handAxis)<=limit,`${label}/${side} wrist must not fold back`);
     assert.ok(arm.end.quaternion.angleTo(new THREE.Quaternion())<=limit,`${label}/${side} forearm carries pronation, not the cuff`);
     const before=previous.get(side);previous.set(side,elbow);
     if(before&&before.distanceTo(elbow)>.06){
      // Distinguish a fast authored hand-off from a pole discontinuity:
      // subdividing a smooth interval must reduce its largest motion.
      const whole=before.distanceTo(elbow);let last=before,largest=0;
      for(let part=1;part<=4;part++){
       applySoldierPose(model,at((i-1+part/4)/120).pose);model.updateMatrixWorld(true);
       const intermediate=arm.middle.getWorldPosition(new THREE.Vector3());largest=Math.max(largest,last.distanceTo(intermediate));last=intermediate;
      }
      assert.ok(largest<whole*.8+.003,`${label}/${side} pole jump persists at finer sampling (${largest}/${whole}m)`);
      applySoldierPose(model,pose);model.updateMatrixWorld(true);
     }
     const palm=getSoldierPalmContact(model,side)!;
     if(patch.selectedWeapon!=='grenade'){
      const contact=side==='left'?new THREE.Vector3(...rig.stockContacts.left):new THREE.Vector3(...pose.weapon.right).lerp(new THREE.Vector3(...rig.stockContacts.right),1-Math.max(pose.weapon.boltGrip,pose.weapon.thumbContact,pose.weapon.fingerOpen));
      const target=rig.rifle.localToWorld(contact);
      assert.ok(palm.distanceTo(target)<.0012,`${label}/${side} real skin contact error ${palm.distanceTo(target)}m`);
     }else if(side==='right'){
      assert.ok(palm.distanceTo(rig.grenade.getWorldPosition(new THREE.Vector3()))<.021,`${label} handle stays within its radius of the palm`);
     }else if(action==='grenade-bash'){
      const orientation=arm.end.getWorldQuaternion(new THREE.Quaternion());
      applySoldierPose(model,sampleSoldierPose(actor({...patch,lastMeleeTime:-Infinity}),faction,time));model.updateMatrixWorld(true);
      assert.ok(orientation.angleTo(arm.end.getWorldQuaternion(new THREE.Quaternion()))<1e-6,`${label} relaxed left hand must not copy the grenade's rotation`);
      applySoldierPose(model,pose);model.updateMatrixWorld(true);
     }
    }
   }
  }
 }
});

test('world articulated hands retain cuff attachment, moving digits and independent actor resources',()=>{
 const model=makeSoldier('british'),copy=makeSoldier('british'),rig=model.userData.soldierRig,other=copy.userData.soldierRig;
 for(const side of ['left','right']as const){
  const binding=rig.hands[side],independent=other.hands[side];
  assert.notEqual(binding.palm.mesh.skeleton,independent.palm.mesh.skeleton);
  assert.notEqual(binding.palm.mesh.geometry,independent.palm.mesh.geometry);
  assert.notEqual(binding.palm.mesh.material,independent.palm.mesh.material);
  assert.notEqual(binding.palm.mesh.material.map,independent.palm.mesh.material.map);
  assert.equal(binding.palm.mesh.skeleton.bones.length,20);
  const hand=binding.hand,chain=rig[side==='left'?'leftArm':'rightArm'];
  for(const patch of [{},{ads:true},{stance:'prone'},{reload:1.4,reloadTotal:3.2},{selectedWeapon:'grenade',lastMeleeTime:10}] as Partial<SoldierActor>[]){
   applySoldierPose(model,sampleSoldierPose(actor(patch),'british',10.22));model.updateMatrixWorld(true);
   const cuff=hand.localToWorld(hand.userData.wristSkinLocal.clone()),wrist=chain.end.getWorldPosition(new THREE.Vector3());
   assert.ok(cuff.distanceTo(wrist)<1e-8,'the articulated hand cuff is attached to the exact sleeve wrist');
  }
  const rest=independent.palm.mesh.skeleton.bones.map((bone:THREE.Bone)=>bone.quaternion.toArray());
  binding.palm.mesh.geometry.dispose();binding.palm.mesh.material.dispose();binding.palm.mesh.skeleton.dispose();
  assert.deepEqual(independent.palm.mesh.skeleton.bones.map((bone:THREE.Bone)=>bone.quaternion.toArray()),rest,'disposing or posing one actor cannot change another actor');
 }
 const body=makeSoldier('german'),grip=body.userData.soldierRig.hands.right.hand;
 const digits=()=>grip.userData.anatomical.bones.filter((bone:THREE.Bone)=>/fmiddle|thumb/.test(bone.name)).map((bone:THREE.Bone)=>bone.quaternion.toArray());
 applySoldierPose(body,sampleSoldierPose(actor(),'german',0));const stock=digits();
 applySoldierPose(body,sampleSoldierPose(actor({lastShotTime:0}),'german',WEAPONS.german.cycle*.4));assert.notDeepEqual(digits(),stock,'operating fingers close around the moving bolt');
 applySoldierPose(body,sampleSoldierPose(actor({reload:WEAPONS.german.reload*.55,reloadTotal:WEAPONS.german.reload}),'german',1));assert.notDeepEqual(digits(),stock,'reload articulates the loading thumb');
 const prone=sampleSoldierPose(actor({alive:false,stance:'prone',deadAt:0}),'german',2);
 assert.ok(prone.leftHand![0]>0&&prone.rightHand![0]<0,'released death hands stay on their anatomical side');
});
