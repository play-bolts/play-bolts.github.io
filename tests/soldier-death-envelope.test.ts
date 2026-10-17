import test,{before} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {ConvexHull} from 'three/addons/math/ConvexHull.js';
import {FACTIONS,WEAPONS,type Faction,type WeaponSlot} from '../src/config.ts';
import {loadHandAssetFromBuffer,poseAnatomicalHand} from '../src/hands.ts';
import {loadSoldierModelFromBuffer} from '../src/soldierModelAssets.ts';
import {loadImportedWeaponFromBuffer,loadImportedGrenadeFromBuffer} from '../src/importedWeapons.ts';
import {makeSoldier} from '../src/soldier.ts';
import {makeSoldierHand,poseSoldierHand} from '../src/soldierHands.ts';
import {sampleSoldierPose,applySoldierPose,updateSoldier,type SoldierActor,type SoldierRig} from '../src/soldierAnimation.ts';
import {ModelPool} from '../src/modelPool.ts';
import type {DeathHandEnvelope} from '../src/soldierDeathEnvelope.ts';

const bytes=(path:string)=>{const b=readFileSync(new URL(`../public/assets/${path}`,import.meta.url));return b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength) as ArrayBuffer;};
const json=(path:string)=>JSON.parse(readFileSync(new URL(`../public/assets/${path}`,import.meta.url),'utf8'));
const loader=new GLTFLoader();loader.register(()=>({name:'death-envelope-test-images',loadTexture:()=>Promise.resolve(new THREE.Texture())}));
before(async()=>{
 for(const side of ['left','right'] as const)await loadHandAssetFromBuffer(side,bytes(`arms/hand-${side[0]}.glb`),loader);
 await loadImportedGrenadeFromBuffer(bytes('models/imported-stielhandgranate.glb'),loader);
 for(const faction of FACTIONS){const rifle={british:'enfield',russian:'mosin',german:'kar98k'}[faction];
  await loadImportedWeaponFromBuffer(bytes(`imported-weapons/${rifle}.glb`),json(`imported-weapons/${rifle}-profile.json`),loader);
  await loadSoldierModelFromBuffer(bytes(`imported-soldiers/${faction}.glb`),json(`imported-soldiers/${faction}-profile.json`),loader);
 }
});
const actor=(patch:Partial<SoldierActor>={}):SoldierActor=>({id:1,x:0,y:0,z:0,yaw:0,pitch:0,stance:'stand',alive:false,deadAt:0,moving:0,ads:false,recoil:0,cooldown:0,reload:0,reloadTotal:0,selectedWeapon:'rifle',...patch});
const rig=(model:THREE.Group)=>model.userData.soldierRig as SoldierRig;

// Independent old algorithm: pose a fully released hand in an actual actor's
// transformed wrist, skin every source vertex and convert world -> wrist.
function legacyEnvelope(model:THREE.Group,side:'left'|'right',faction:Faction,slot:WeaponSlot):DeathHandEnvelope {
 const hand=rig(model).hands![side],chain=side==='left'?rig(model).leftArm:rig(model).rightArm;
 poseSoldierHand(hand,side,sampleSoldierPose(actor({selectedWeapon:slot}),faction,.2).weapon,slot,1);
 hand.frame.updateWorldMatrix(true,true);hand.frame.updateMatrixWorld(true);
 const points:THREE.Vector3[]=[];
 hand.hand.traverse(object=>{if(!(object instanceof THREE.SkinnedMesh))return;object.skeleton.update();
  for(let i=0;i<object.geometry.getAttribute('position').count;i++)points.push(chain.end.worldToLocal(object.localToWorld(object.getVertexPosition(i,new THREE.Vector3()))));
 });
 const hull=new ConvexHull().setFromPoints(points),corners=new Set<THREE.Vector3>();
 for(const face of hull.faces){let edge=face.edge;do{corners.add(edge.head().point);edge=edge.next;}while(edge!==face.edge);}
 return [...corners].map(point=>point.toArray() as [number,number,number]);
}
const support=(points:DeathHandEnvelope,normal:THREE.Vector3)=>Math.min(...points.map(point=>point[0]*normal.x+point[1]*normal.y+point[2]*normal.z));

test('prepared envelopes match original wrist-local skin hulls across factions, both hands and held items',()=>{
 for(const faction of FACTIONS){
  const model=makeSoldier(faction);model.position.set(3,.4,-2);model.rotation.set(.18,.75,-.12);
  for(const slot of ['rifle','grenade'] as const){
   applySoldierPose(model,sampleSoldierPose(actor({selectedWeapon:slot,lean:.7,deathYaw:1.1}),faction,.2));model.updateMatrixWorld(true);
   for(const side of ['left','right'] as const){
    const actual=rig(model).hands![side].deathEnvelopes[slot],legacy=legacyEnvelope(model,side,faction,slot);
    assert.ok(Object.isFrozen(actual)&&actual.every(Object.isFrozen),'shared envelope is deeply immutable');
    for(let i=0;i<200;i++){
     const z=1-2*(i+.5)/200,angle=i*2.399963229728653,normal=new THREE.Vector3(Math.sqrt(1-z*z)*Math.cos(angle),z,Math.sqrt(1-z*z)*Math.sin(angle));
     const error=Math.abs(support(actual,normal)-support(legacy,normal));
     // The old world-space method reads Float32 bone matrices before undoing
     // translated/rotated parents; allow their sub-micrometre roundoff.
     assert.ok(error<1e-6,`${faction}/${side}/${slot}: same skin support plane (${error} m)`);
    }
   }
  }
 }
});

test('cached envelopes preserve the entire released pose for interrupted actions, stances and death directions',()=>{
 for(const faction of FACTIONS){
  const actual=makeSoldier(faction),reference=makeSoldier(faction);
  for(const side of ['left','right'] as const)rig(reference).hands![side].deathEnvelopes={rifle:legacyEnvelope(reference,side,faction,'rifle'),grenade:legacyEnvelope(reference,side,faction,'grenade')};
  const joints=(model:THREE.Group)=>{const r=rig(model);return[r.leftArm.root,r.leftArm.middle,r.leftArm.end,r.rightArm.root,r.rightArm.middle,r.rightArm.end,r.riflePivot,r.grenade!];};
  for(const slot of ['rifle','grenade'] as const)for(const stance of ['stand','crouch','prone'] as const)for(const interrupted of ['idle','reload','cycle','melee'] as const)for(const direction of [0,Math.PI/2,Math.PI]){
   const subject=actor({selectedWeapon:slot,stance,lean:.6,ads:true,deathYaw:direction,reload:interrupted==='reload'?WEAPONS[faction].reload*.5:0,reloadTotal:WEAPONS[faction].reload,lastShotTime:interrupted==='cycle'?-.25:-Infinity,lastMeleeTime:interrupted==='melee'?-.15:-Infinity});
   for(const age of [.09,.24,.57,1.2]){
    const pose=sampleSoldierPose(subject,faction,age);
    assert.deepEqual([pose.weapon.fingerOpen,pose.weapon.thumbContact,pose.weapon.boltGrip],[0,0,0],'dead hand shape is canonical even when the captured action differs');
    applySoldierPose(actual,pose);applySoldierPose(reference,pose);actual.updateMatrixWorld(true);reference.updateMatrixWorld(true);
    joints(actual).forEach((joint,index)=>joint.matrixWorld.elements.forEach((value,element)=>assert.ok(Math.abs(value-joints(reference)[index].matrixWorld.elements[element])<1e-8,`${faction}/${slot}/${stance}/${interrupted}/${direction}/${age}: pose preserved`)));
   }
  }
 }
});

test('new actors beyond startup reserves and pooled deaths never rebuild hand hulls or traverse hand vertices',t=>{
 const initial=makeSoldier('british'),initialHands=rig(initial).hands!;
 const pool=new ModelPool<Faction,THREE.Group>(makeSoldier,model=>{delete model.userData.soldierState;delete model.userData.animationPose;},model=>model.traverse(object=>{if(object instanceof THREE.Mesh)object.geometry.dispose();}));
 t.mock.method(ConvexHull.prototype,'setFromPoints',()=>{throw new Error('Hull construction escaped startup preparation');});
 for(const faction of FACTIONS){
  const first=pool.acquire(faction),overflow=pool.acquire(faction);
  assert.notEqual(rig(first).hands!.left.palm.mesh.skeleton,rig(overflow).hands!.left.palm.mesh.skeleton,'actors keep separate mutable bones');
  assert.equal(rig(first).hands!.left.deathEnvelopes,initialHands.left.deathEnvelopes,'immutable envelope shared across factions');
  for(const model of [first,overflow])for(const slot of ['rifle','grenade'] as const){
   const handMeshes:THREE.SkinnedMesh[]=[];for(const hand of Object.values(rig(model).hands!))hand.hand.traverse(object=>{if(object instanceof THREE.SkinnedMesh)handMeshes.push(object);});
   const guards=handMeshes.map(mesh=>t.mock.method(mesh,'getVertexPosition',()=>{throw new Error('Death traversed the hand skin');}));
   for(const time of [0,.09,.2,.5,1.2])updateSoldier(model,actor({selectedWeapon:slot}),1/60,time,true);
   guards.forEach(guard=>guard.mock.restore());
  }
  pool.release(first);pool.release(overflow);const reused=pool.acquire(faction);assert.equal(reused,first);
  for(const slot of ['rifle','grenade'] as const)for(const time of [0,.09,.6,1.2])updateSoldier(reused,actor({selectedWeapon:slot}),1/60,time,true);
  pool.release(reused);pool.clearIdle();
  assert.equal(rig(pool.acquire(faction)).hands!.left.deathEnvelopes,initialHands.left.deathEnvelopes,'disposing rig geometries does not invalidate immutable source envelopes');
 }
});

test('constructor warmup restores ordinary hand bone poses and reloaded geometry receives new envelopes',async()=>{
 const old=makeSoldierHand('left')!,bones=old.hand.userData.anatomical.bones as THREE.Bone[];
 const quaternions=bones.map(bone=>bone.quaternion.toArray());poseAnatomicalHand(old.hand,0);
 assert.deepEqual(bones.map(bone=>bone.quaternion.toArray()),quaternions,'warmup restores the original live grip');
 const changedLoader=new GLTFLoader();changedLoader.register(()=>({name:'changed-test-hand',loadTexture:()=>Promise.resolve(new THREE.Texture()),afterRoot(gltf){gltf.scene.traverse(object=>{if(object instanceof THREE.SkinnedMesh)object.geometry.scale(1.15,1,1);});}}));
 try{
  await loadHandAssetFromBuffer('left',bytes('arms/hand-l.glb'),changedLoader);
  const changed=makeSoldierHand('left')!;
  const changedBones=changed.hand.userData.anatomical.bones as THREE.Bone[],changedPose=changedBones.map(bone=>bone.quaternion.toArray());
  poseAnatomicalHand(changed.hand,0);assert.deepEqual(changedBones.map(bone=>bone.quaternion.toArray()),changedPose,'a cold source warmup restores its ordinary grip');
  assert.notEqual(changed.deathEnvelopes,old.deathEnvelopes,'source replacement must not reuse old geometry hulls');
  assert.ok(changed.deathEnvelopes.rifle.some((point,index)=>Math.abs(point[0]-(old.deathEnvelopes.rifle[index]?.[0]??Infinity))>1e-5),'changed source shape changes its envelope');
  assert.ok(old.deathEnvelopes.rifle.every(Object.isFrozen),'replacement leaves old actor cache immutable and valid');
 }finally{await loadHandAssetFromBuffer('left',bytes('arms/hand-l.glb'),loader);}
});
