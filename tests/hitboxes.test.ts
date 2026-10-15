import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {sampleHitVolumes,rayHitVolumes} from '../src/hitboxes.ts';
import {createActor,Game} from '../src/engine.ts';
import {initialMotion} from '../src/soldierMotionState.ts';
import {loadImportedWeaponFromBuffer} from '../src/importedWeapons.ts';

const actor=(faction:'british'|'russian'|'german')=>createActor(2,faction,'Target');
test('head corners, shoulder air and separated legs are not solid damage bands',()=>{
 for(const faction of ['british','russian','german']as const){const a=actor(faction),volumes=sampleHitVolumes(a,0),head=volumes.find(v=>v.name==='head')!;
  assert.ok(head.halfSize.x<.115&&head.halfSize.z<.12,'skull size excludes a broad helmet brim');
  const q=new THREE.Quaternion(...head.rotation),point=new THREE.Vector3(head.halfSize.x*.96,head.halfSize.y*.94,0).applyQuaternion(q).add(new THREE.Vector3(head.center.x,head.center.y,head.center.z));
  assert.equal(rayHitVolumes({x:point.x,y:point.y,z:point.z+3},{x:0,y:0,z:-1},volumes),null,'square AABB corner is empty');
  assert.equal(rayHitVolumes({x:0,y:.3,z:-3},{x:0,y:0,z:1},volumes),null,'gap between calves is empty');
  assert.equal(rayHitVolumes({x:head.center.x,y:head.center.y,z:3},{x:0,y:0,z:-1},volumes)?.part,'head');
 }
});
test('prone volumes follow horizontal head, torso and separate articulated legs',()=>{
 for(const faction of ['british','russian','german']as const){const a=actor(faction);a.stance='prone';a.pose=initialMotion(a);const volumes=sampleHitVolumes(a,0),head=volumes.find(v=>v.name==='head')!,foot=volumes.find(v=>v.name==='footL')!;
  assert.ok(head.center.z>.45&&head.center.y<.65);assert.ok(foot.center.z<-.6,'feet extend behind the hips');
  assert.equal(rayHitVolumes({x:head.center.x,y:head.center.y,z:3},{x:0,y:0,z:-1},volumes)?.part,'head');
  assert.equal(rayHitVolumes({x:0,y:1.0,z:-3},{x:0,y:0,z:1},volumes),null,'standing-height air stays empty');
 }
});
test('local combat uses posed anatomical gaps and keeps real headshots lethal',()=>{
 const g=new Game();g.start('british','regular');for(const other of g.actors.slice(1)){other.alive=false;other.deadAt=Infinity;}
 const shooter=g.player,target=g.actors[1];Object.assign(shooter,{x:13.6,y:0,z:-6,yaw:0,pitch:0,cooldown:0,ads:true,spawnSafe:0});Object.assign(target,{alive:true,x:13.6,y:0,z:-2,yaw:0,pitch:0,spawnSafe:0});
 const aim=(point:{x:number;y:number;z:number})=>{shooter.yaw=Math.atan2(point.x-shooter.x,point.z-shooter.z);shooter.pitch=Math.atan2(point.y-shooter.eyeHeight,Math.hypot(point.x-shooter.x,point.z-shooter.z));shooter.cooldown=0;shooter.recoil=0;g.fire();};
 aim({x:target.x,y:.3,z:target.z});assert.equal(target.hp,100);assert.equal(g.shots.at(-1)!.hit,null);
 const head=sampleHitVolumes(target,g.time).find(v=>v.name==='head')!;aim(head.center);assert.equal(target.hp,0);assert.equal(g.shots.at(-1)!.headshot,true);
});
test('collision results are independent of browser GLB preload and actor-ID remapping',async()=>{
 const cases=[];for(const faction of ['british','russian','german']as const){const a=actor(faction);Object.assign(a,{reload:1.3,reloadTotal:3.3,pitch:.5});a.pose=initialMotion(a);cases.push({a,before:sampleHitVolumes(a,10)});}
 const loader=new GLTFLoader();loader.register(()=>({name:'collision-independent-texture',loadTexture:()=>Promise.resolve(new THREE.Texture())}));
 for(const name of ['enfield','mosin','kar98k']){const b=readFileSync(new URL(`../public/assets/imported-weapons/${name}.glb`,import.meta.url));await loadImportedWeaponFromBuffer(b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength),JSON.parse(readFileSync(new URL(`../public/assets/imported-weapons/${name}-profile.json`,import.meta.url),'utf8')),loader);}
 for(const {a,before}of cases){assert.deepEqual(sampleHitVolumes(a,10),before);assert.deepEqual(sampleHitVolumes({...a,id:0},10),before,'authoritative pose removes local display-index variation');}
});

test('killcam interpolates authoritative gait without mutating historical poses',()=>{
 const g=new Game();g.start('british','regular');g.history=[];g.record();const before=g.history[0].actors[0].pose!;
 g.time=.05;Object.assign(g.player.pose!,{phase:before.phase+.1,crouch:.4,aim:.6,speed:2.4});g.record();const after=g.history[1].actors[0].pose!;
 g.replay=g.history;g.replayTime=.025;const frame=g.replayFrame()!.actors[0];assert.ok(frame.pose);
 for(const key of ['phase','crouch','prone','aim','speed','forward','sideways'] as const)assert.ok(Math.abs(frame.pose[key]-(before[key]+after[key])/2)<1e-12);
 frame.pose.phase=500;assert.notEqual(before.phase,500);assert.notEqual(after.phase,500);
});
