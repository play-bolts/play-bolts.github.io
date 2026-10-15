import {sampleFirstPersonWeaponAnimation} from '../src/firstPersonWeaponAnimation.ts';
import test,{before} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {loadHandAssetFromBuffer} from '../src/hands.ts';
import {loadImportedWeaponFromBuffer,getImportedWeaponProfile} from '../src/importedWeapons.ts';
import {makeRifle,getRifleVisuals} from '../src/rifle.ts';
import {defaultWeaponBodyMatrix,VIEWMODEL_HIP_POSITION} from '../src/viewmodelArms.ts';
import {applyWeaponAnimation} from '../src/weaponAnimation.ts';

const factions=['british','russian','german'] as const;
const bytes=(path:string)=>{const file=readFileSync(new URL(path,import.meta.url));return file.buffer.slice(file.byteOffset,file.byteOffset+file.byteLength) as ArrayBuffer;};
before(async()=>{
 const loader=new GLTFLoader();loader.register(()=>({name:'test-image-decoder',loadTexture:()=>Promise.resolve(new THREE.Texture())}));
 for(const side of ['left','right'] as const)await loadHandAssetFromBuffer(side,bytes(`../public/assets/arms/hand-${side[0]}.glb`),loader);
 for(const [faction,name]of [['british','enfield'],['russian','mosin'],['german','kar98k']]as const){
  const profile=JSON.parse(readFileSync(new URL(`../public/assets/imported-weapons/${name}-profile.json`,import.meta.url),'utf8'));
  assert.equal(profile.faction,faction);await loadImportedWeaponFromBuffer(bytes(`../public/assets/imported-weapons/${name}.glb`),profile,loader);
 }
});
function thumbSkin(hand:THREE.Group){
 const {mesh,index}=hand.userData.thumbContact as {mesh:THREE.SkinnedMesh;index:number};
 mesh.skeleton.update();return mesh.localToWorld(mesh.applyBoneTransform(index,new THREE.Vector3().fromBufferAttribute(mesh.geometry.getAttribute('position'),index)));
}

test('actual reload thumb skin presses the top cartridge with a complete physical arm',()=>{
 for(const faction of factions){
  const rifle=makeRifle(faction,true),rig=rifle.userData.handRig;
  assert.ok(rig.rightArm&&rig.leftArm,'exercise the same full arms used in game, not forearm-only mocks');
  for(const local of [.4,.5,.65]){
   const pose=sampleFirstPersonWeaponAnimation(faction,'reload',.35+local*(.735-.35));
   applyWeaponAnimation(rifle,pose);rifle.updateMatrixWorld(true);
   const cartridge=new THREE.Vector3(...pose.clipPosition).add(new THREE.Vector3(0,.058-pose.clipPress*.064,-.001));
   assert.ok(thumbSkin(rig.right).distanceTo(cartridge)<1e-6,'skinned thumb contact survives the coupled arm solve');
   const wrist=rig.right.localToWorld((rig.right.userData.wristLocal as THREE.Vector3).clone());
   assert.ok(wrist.x>cartridge.x+.025,'loading hand approaches the charger from the right');
   const {model,bones}=rig.right.userData.anatomical as {model:THREE.Group;bones:THREE.Bone[]};
   assert.ok(new THREE.Vector3(0,1,0).transformDirection(model.matrixWorld).y<0,'loading palm faces the receiver');
   const joint=(segment:string)=>bones.find(b=>b.name.replace(/[._]/g,'')===`fmiddle${segment}R`)!.getWorldPosition(new THREE.Vector3());
   assert.ok(joint('03').y<joint('01').y-.01,'fingers curl down beside the charger');
  }
 }
});

test('physical arm solve keeps the palm planted on each actual moving bolt knob',()=>{
 for(const faction of factions){
  const rifle=makeRifle(faction,true),rig=rifle.userData.handRig,profile=getImportedWeaponProfile(faction)!;
  for(let i=16;i<=84;i++){
   const pose=sampleFirstPersonWeaponAnimation(faction,'cycle',i/100);applyWeaponAnimation(rifle,pose);rifle.updateMatrixWorld(true);
   const cup=rig.right.localToWorld((rig.right.userData.gripLocal as THREE.Vector3).clone());
   const knob=rig.bolt.localToWorld(new THREE.Vector3(...profile.bolt.knobLocal));
   assert.ok(cup.distanceTo(knob)<1e-6,'palm follows lift, extraction, chamber and lock without lag');
  }
 }
});

test('support thumb follows the barrel while fingers cup the source stock',()=>{
 for(const faction of factions){
  const rifle=makeRifle(faction,true),rig=rifle.userData.handRig;
  applyWeaponAnimation(rifle,sampleFirstPersonWeaponAnimation(faction,'idle',0));rifle.updateMatrixWorld(true);
  const {model,bones}=rig.left.userData.anatomical as {model:THREE.Group;bones:THREE.Bone[]};
  assert.ok(new THREE.Vector3(0,1,0).transformDirection(model.matrixWorld).y>.5,'support palm cups underneath at a natural diagonal');
  const joint=(name:string)=>bones.find(b=>b.name.replace(/[._]/g,'')===name)!.getWorldPosition(new THREE.Vector3());
  const thumb=joint('thumb03L').sub(joint('thumb01L')).normalize();
  assert.ok(thumb.z<-.8&&thumb.y<.5,'thumb stays forward and below the sight line');
 }
});

test('stock, bolt and cartridge handoffs are continuous and absolute when scrubbed',()=>{
 for(const faction of factions){
  const rifle=makeRifle(faction,true),rig=rifle.userData.handRig;
  for(const full of [false,true])for(const boundary of [.08,.16,.24,.29,.35,.5425,.735,.755,.79,.85,.91]){
   const points=[boundary-1e-6,boundary+1e-6].map(t=>{
    applyWeaponAnimation(rifle,sampleFirstPersonWeaponAnimation(faction,'reload',t,full));rifle.updateMatrixWorld(true);
    return rig.right.localToWorld((rig.right.userData.wristLocal as THREE.Vector3).clone());
   });
   assert.ok(points[0].distanceTo(points[1])<.0001,`${faction} continuous skin wrist at ${boundary}, two chargers ${full}`);
  }
  const pose=sampleFirstPersonWeaponAnimation(faction,'cycle',.4);applyWeaponAnimation(rifle,pose);rifle.updateMatrixWorld(true);
  const objects=[rig.right,rig.left,...rig.rightArm.mesh.skeleton.bones,...rig.leftArm.mesh.skeleton.bones];
  const matrices=objects.map((object:THREE.Object3D)=>object.matrix.toArray());
  applyWeaponAnimation(rifle,sampleFirstPersonWeaponAnimation(faction,'reload',.43,true));applyWeaponAnimation(rifle,pose);rifle.updateMatrixWorld(true);
  objects.forEach((object:THREE.Object3D,i:number)=>assert.deepEqual(object.matrix.toArray(),matrices[i],'scrubbing restores skin and complete sleeve bones'));
 }
});


test('the Enfield operating hand stays in the hip camera during bolt extraction',()=>{
 const rifle=makeRifle('british',true),rig=rifle.userData.handRig,camera=new THREE.PerspectiveCamera(64,4/3,.008,80);
 for(const progress of [.3,.4,.5,.55,.6,.7]){
  const pose=sampleFirstPersonWeaponAnimation('british','cycle',progress),body=defaultWeaponBodyMatrix(VIEWMODEL_HIP_POSITION.map((v,i)=>v+pose.position[i]),[pose.rotation[0],pose.rotation[1]-.035,pose.rotation[2]]);
  applyWeaponAnimation(rifle,pose,body);rifle.updateMatrixWorld(true);
  let visible=0,total=0;
  rig.right.traverse((object:THREE.Object3D)=>{
   if(!(object instanceof THREE.SkinnedMesh))return;
   object.skeleton.update();const vertices=object.geometry.getAttribute('position');
   for(let i=0;i<vertices.count;i++){
    const point=object.localToWorld(object.applyBoneTransform(i,new THREE.Vector3().fromBufferAttribute(vertices,i))).applyMatrix4(body).project(camera);
    total++;if(Math.abs(point.x)<1&&Math.abs(point.y)<1&&point.z<1)visible++;
   }
  });
  assert.ok(visible/total>.5,`phase ${progress}: the operating hand is visible, not just cropped fingertips (${(visible/total*100).toFixed(1)}%)`);
 }
});

test('hip bolt framing does not lift the shouldered sights out of the ADS camera',()=>{
 const camera=new THREE.PerspectiveCamera(48,4/3,.008,80);
 for(const faction of factions)for(const progress of [.3,.4,.5,.6,.7]){
  const visual=getRifleVisuals(faction),profile=getImportedWeaponProfile(faction)!,pose=sampleFirstPersonWeaponAnimation(faction,'cycle',progress,false,undefined,1);
  const position=[-visual.sightX,-visual.sightY,visual.adsZ].map((v,i)=>v+pose.position[i]),rotation=visual.adsRotation.map((v,i)=>v+pose.rotation[i]);
  const body=defaultWeaponBodyMatrix(position,rotation);
  for(const sight of [profile.rearSight,profile.frontSight]){
   const screen=new THREE.Vector3(...sight).applyMatrix4(body).project(camera);
   assert.ok(Math.abs(screen.x)<.18&&Math.abs(screen.y)<.18,`${faction}/${progress}: shouldered cycle keeps the sights near the aim line`);
  }
 }
});
