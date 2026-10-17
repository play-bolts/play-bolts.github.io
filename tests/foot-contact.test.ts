import test,{before} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {FACTIONS} from '../src/config.ts';
import {makeSoldier} from '../src/soldier.ts';
import {loadSoldierModelFromBuffer} from '../src/soldierModelAssets.ts';
import {sampleSoldierPose,applySoldierPose,type SoldierActor,type SoldierRig} from '../src/soldierAnimation.ts';
import {gaitRate,groundGait} from '../src/soldierGait.ts';

before(async()=>{
 const loader=new GLTFLoader();loader.register(()=>({name:'foot-test-images',loadTexture:()=>Promise.resolve(new THREE.Texture())}));
 for(const faction of FACTIONS){
  const bytes=readFileSync(new URL(`../public/assets/imported-soldiers/${faction}.glb`,import.meta.url));
  const profile=JSON.parse(readFileSync(new URL(`../public/assets/imported-soldiers/${faction}-profile.json`,import.meta.url),'utf8'));
  await loadSoldierModelFromBuffer(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength) as ArrayBuffer,profile,loader);
 }
});
const actor=(stance:SoldierActor['stance'],moving:number):SoldierActor=>({id:1,x:0,y:0,z:0,yaw:0,pitch:0,stance,moving,grounded:true,alive:true,ads:true,recoil:0,cooldown:0,reload:0,reloadTotal:0,lastShotTime:-Infinity,lastMeleeTime:-Infinity,lastHurtTime:-Infinity});
function soles(model:THREE.Group){
 const points:{mesh:THREE.SkinnedMesh;index:number;side:'left'|'right'}[]=[];
 model.traverse(object=>{if(object instanceof THREE.SkinnedMesh){
  const positions=object.geometry.getAttribute('position');
  // Independent of the runtime contact hull: inspect the real lower-boot
  // surface, including the source's skin weights and exact deformation.
  for(let i=0;i<positions.count;i++)if(positions.getY(i)<.12)points.push({mesh:object,index:i,side:positions.getX(i)<0?'left':'right'});
 }});
 return()=>{
  model.updateMatrixWorld(true);const minimum={left:Infinity,right:Infinity};
  for(const mesh of new Set(points.map(point=>point.mesh)))mesh.skeleton.update();
  for(const {mesh,index,side} of points){
   const point=mesh.localToWorld(mesh.applyBoneTransform(index,new THREE.Vector3().fromBufferAttribute(mesh.geometry.getAttribute('position'),index)));
   minimum[side]=Math.min(minimum[side],point.y);
  }
  return minimum;
 };
}

test('both actual source soles are planted during stationary crouch and standing',()=>{
 for(const faction of FACTIONS){
  const model=makeSoldier(faction),measure=soles(model);
  for(const stance of ['stand','crouch'] as const)for(const time of [0,.6,1.5,2.475,3]){
   applySoldierPose(model,sampleSoldierPose(actor(stance,0),faction,time));
   const minimum=measure();
   for(const side of ['left','right'] as const)assert.ok(minimum[side]>=-.005&&minimum[side]<.012,`${faction}/${stance}/${time}/${side}: sole ${minimum[side]}m above floor`);
  }
 }
});

test('source sole fitting retains lifted running feet and fixed IK segment lengths',()=>{
 for(const faction of FACTIONS){
  const model=makeSoldier(faction),measure=soles(model),rig=model.userData.soldierRig as SoldierRig;
  let highest=0,lowest=Infinity;
  for(let i=0;i<48;i++){
   applySoldierPose(model,sampleSoldierPose(actor('stand',4.5),faction,2,{phase:i/48}));
   const minimum=measure();highest=Math.max(highest,minimum.left,minimum.right);lowest=Math.min(lowest,minimum.left,minimum.right);
   for(const chain of [rig.leftLeg,rig.rightLeg]){
    const hip=chain.root.getWorldPosition(new THREE.Vector3()),knee=chain.middle.getWorldPosition(new THREE.Vector3()),ankle=chain.end.getWorldPosition(new THREE.Vector3());
    assert.ok(Math.abs(hip.distanceTo(knee)-chain.upperLength)<1e-7);assert.ok(Math.abs(knee.distanceTo(ankle)-chain.lowerLength)<1e-7);
   }
  }
  assert.ok(highest>.15,'swinging foot must retain its running lift');assert.ok(lowest>-.012&&lowest<.012,'running still has ground contacts');
 }
});

test('all three fitted skeletons hold their support boots still as the actor travels',()=>{
 for(const faction of FACTIONS){
  const model=makeSoldier(faction),rig=model.userData.soldierRig as SoldierRig;
  for(const [stance,speed] of [['stand',1.7],['stand',4.5],['crouch',1.3]] as const)for(let direction=0;direction<8;direction++){
   const forward=Math.cos(direction*Math.PI/4),sideways=Math.sin(direction*Math.PI/4),crouch=Number(stance==='crouch'),rate=gaitRate(speed,crouch,0),yaw=.57,dt=.001;
   const poseAt=(phase:number,time:number)=>{
    model.position.set(speed*time*(sideways*Math.cos(yaw)+forward*Math.sin(yaw)),0,speed*time*(forward*Math.cos(yaw)-sideways*Math.sin(yaw)));model.rotation.y=yaw;
    applySoldierPose(model,sampleSoldierPose(actor(stance,speed),faction,2,{phase,forward,sideways,crouch}));model.updateMatrixWorld(true);
    return [rig.leftLeg.end.getWorldPosition(new THREE.Vector3()),rig.rightLeg.end.getWorldPosition(new THREE.Vector3())];
   };
   for(let i=0;i<24;i++){
    const phase=i/24,a=groundGait(speed,crouch,phase,forward,sideways),b=groundGait(speed,crouch,phase+rate*dt,forward,sideways);
    const before=poseAt(phase,0),after=poseAt(phase+rate*dt,dt);
    for(const [index,side] of (['left','right'] as const).entries())if(a[side].support&&b[side].support)
     assert.ok(before[index].distanceTo(after[index])<1e-6,`${faction}/${stance}/${direction}/${i}/${side}: planted boot drifts ${before[index].distanceTo(after[index])}m`);
   }
  }
 }
});

test('source knees stay on the anatomical branch with no reversal or straight-leg snap',()=>{
 for(const faction of FACTIONS){
  const model=makeSoldier(faction),rig=model.userData.soldierRig as SoldierRig;
  for(const [stance,speed] of [['stand',0],['stand',1.7],['stand',2.8],['stand',4.5],['crouch',1.3]] as const)for(let direction=0;direction<8;direction++){
   const crouch=Number(stance==='crouch'),forward=Math.cos(direction*Math.PI/4),sideways=Math.sin(direction*Math.PI/4);
   let previous:THREE.Vector3[]|undefined;
   for(let i=0;i<=180;i++){
    const phase=i/180,gait=groundGait(speed,crouch,phase,forward,sideways);
    applySoldierPose(model,sampleSoldierPose(actor(stance,speed),faction,2,{phase,crouch,forward,sideways}));model.updateMatrixWorld(true);
    const knees=[];
    for(const [index,chain] of [rig.leftLeg,rig.rightLeg].entries()){
     const hip=chain.root.getWorldPosition(new THREE.Vector3()),knee=chain.middle.getWorldPosition(new THREE.Vector3()),ankle=chain.end.getWorldPosition(new THREE.Vector3());
     const axis=ankle.clone().sub(hip).normalize(),bend=knee.clone().sub(hip);
     bend.addScaledVector(axis,-bend.dot(axis));
     const facing=new THREE.Vector3(Math.sin(gait.heading),0,Math.cos(gait.heading));
     assert.ok(bend.dot(facing)>.001,`${faction}/${stance}/${speed}/${direction}/${phase}: knee must bend ahead of the hip-to-ankle line`);
     if(stance==='stand')assert.ok(knee.clone().sub(hip).angleTo(ankle.clone().sub(knee))>10*Math.PI/180,'reserve knee flex instead of locking IK at full extension');
     if(previous)assert.ok(knee.distanceTo(previous[index])<.045,`${faction}/${stance}/${speed}/${direction}/${phase}: continuous knee path, including wraparound`);
     knees.push(knee);
    }
    previous=knees;
   }
  }
 }
});
