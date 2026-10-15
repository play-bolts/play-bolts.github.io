import {sampleFirstPersonWeaponAnimation} from '../src/firstPersonWeaponAnimation.ts';
import test,{before} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {FACTIONS,WEAPONS} from '../src/config.ts';
import {loadImportedWeaponFromBuffer} from '../src/importedWeapons.ts';
import {makeRifle,getRifleVisuals,ADS_WEAPON_FOV} from '../src/rifle.ts';
import {applyWeaponAnimation,type WeaponAction} from '../src/weaponAnimation.ts';
import {keepADSBoltInFront,ADS_BOLT_NEAR_MARGIN} from '../src/weaponPresentation.ts';
import {VIEWMODEL_HIP_POSITION} from '../src/viewmodelArms.ts';

before(async()=>{
 const loader=new GLTFLoader();
 loader.register(()=>({name:'geometry-only-image-decoder',loadTexture:()=>Promise.resolve(new THREE.Texture())}));
 for(const [faction,name] of Object.entries({british:'enfield',russian:'mosin',german:'kar98k'})){
  const file=readFileSync(new URL(`../public/assets/imported-weapons/${name}.glb`,import.meta.url));
  const profile=JSON.parse(readFileSync(new URL(`../public/assets/imported-weapons/${name}-profile.json`,import.meta.url),'utf8'));
  assert.equal(profile.faction,faction);
  await loadImportedWeaponFromBuffer(file.buffer.slice(file.byteOffset,file.byteOffset+file.byteLength) as ArrayBuffer,profile,loader);
 }
});

test('ADS keeps actual source bolt geometry ahead of the camera through cycling and added damage recoil',()=>{
 const camera=new THREE.PerspectiveCamera(ADS_WEAPON_FOV,16/9,.01,8);
 let guardedDamagePoses=0;
 for(const faction of FACTIONS){
  const weapon=new THREE.Group(),rifle=makeRifle(faction),visual=getRifleVisuals(faction);weapon.add(rifle);
  const bolt=rifle.getObjectByName('bolt')!;
  for(const ads of [0,.25,.5,.75,.95,1])for(let i=0;i<=60;i++)for(const damageRecoil of [0,.026,.078,.156]){
   const progress=i/60,recoil=WEAPONS[faction].recoil*Math.exp(-progress*WEAPONS[faction].cycle*4.2)+damageRecoil;
   const pose=sampleFirstPersonWeaponAnimation(faction,'cycle',progress,false,undefined,ads);applyWeaponAnimation(rifle,pose);
   weapon.position.set(THREE.MathUtils.lerp(VIEWMODEL_HIP_POSITION[0],-visual.sightX,ads)+pose.position[0],THREE.MathUtils.lerp(VIEWMODEL_HIP_POSITION[1],-visual.sightY,ads)+pose.position[1],THREE.MathUtils.lerp(VIEWMODEL_HIP_POSITION[2],visual.adsZ,ads)+Math.min(.11,recoil*1.8)+pose.position[2]);
   weapon.rotation.set(recoil*1.1+pose.rotation[0]+visual.adsRotation[0]*ads,THREE.MathUtils.lerp(-.035,0,ads)+pose.rotation[1]+visual.adsRotation[1]*ads,pose.rotation[2]+visual.adsRotation[2]*ads);
   const originalPosition=weapon.position.clone(),originalRotation=weapon.quaternion.clone(),boltPosition=bolt.position.clone();
   const correction=keepADSBoltInFront(weapon,rifle,camera,ads);
   assert.deepEqual(weapon.quaternion.toArray(),originalRotation.toArray(),'view-only clearance cannot reduce the visible pitch kick');
   assert.deepEqual(bolt.position.toArray(),boltPosition.toArray(),'source bolt travel is preserved');
   assert.deepEqual(weapon.scale.toArray(),[1,1,1],'source proportions are never scaled');
   if(ads===0){assert.equal(correction,0);assert.deepEqual(weapon.position.toArray(),originalPosition.toArray(),'hip placement is untouched');continue;}
   if(damageRecoil>0&&correction>0)guardedDamagePoses++;
   // Precise bounds inspect the real GLB vertices independently of the
   // conservative cached box used by the runtime guard.
   const actual=new THREE.Box3().setFromObject(bolt,true);
   assert.ok(actual.max.z<=-camera.near-ADS_BOLT_NEAR_MARGIN+1e-8,`${faction}/${ads}/${progress}/${damageRecoil}: bolt enters camera clearance (${actual.max.z})`);
   assert.equal(weapon.position.x,originalPosition.x);assert.equal(weapon.position.y,originalPosition.y);
  }
 }
 assert.ok(guardedDamagePoses>50,'the sweep must exercise damaging hits during the rearward cycle');
 assert.deepEqual(camera.position.toArray(),[0,0,0]);assert.deepEqual(camera.quaternion.toArray(),[0,0,0,1],'gameplay camera pose is not mutated');
});

test('safe ADS stays unchanged and manipulation poses remain deterministic after clearance',()=>{
 const camera=new THREE.PerspectiveCamera(ADS_WEAPON_FOV,16/9,.01,8);
 for(const faction of FACTIONS){
  const weapon=new THREE.Group(),rifle=makeRifle(faction),visual=getRifleVisuals(faction);weapon.add(rifle);
  const setPose=(action:WeaponAction,progress:number)=>{
   const pose=sampleFirstPersonWeaponAnimation(faction,action,progress,false,undefined,1);applyWeaponAnimation(rifle,pose);
   weapon.position.set(-visual.sightX+pose.position[0],-visual.sightY+pose.position[1],visual.adsZ+pose.position[2]);
   weapon.rotation.set(visual.adsRotation[0]+pose.rotation[0],visual.adsRotation[1]+pose.rotation[1],visual.adsRotation[2]+pose.rotation[2]);
   return keepADSBoltInFront(weapon,rifle,camera,1);
  };
  assert.equal(setPose('idle',0),0,'established idle sight framing stays unchanged');
  const settled=weapon.matrixWorld.clone();
  for(const action of ['cycle','reload','melee'] as const)for(let i=0;i<=40;i++){
   setPose(action,i/40);
   assert.ok(new THREE.Box3().setFromObject(rifle.getObjectByName('bolt')!,true).max.z<=-.05+1e-8);
  }
  setPose('idle',0);assert.deepEqual(weapon.matrixWorld.elements,settled.elements,'animation scrubbing cannot accumulate an ADS correction');
 }
});
