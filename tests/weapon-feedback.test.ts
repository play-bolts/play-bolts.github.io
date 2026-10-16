import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {RIFLE_VISUALS} from '../src/rifle.ts';
import {makeMuzzleFlash,placeMuzzleFlash,sampleMuzzleFlash,updateMuzzleFlash,MUZZLE_FLASH_RADII,MUZZLE_FLASH_SECONDS,MUZZLE_EFFECT_SECONDS,MUZZLE_PRESSURE_SECONDS} from '../src/weaponFeedback.ts';
import {makeImpactEffect,updateImpactEffect,shotFeedbackSeed,IMPACT_SECONDS,MAX_WORLD_EFFECTS} from '../src/impactFeedback.ts';
import {sampleFeedbackParticle,type FeedbackParticle} from '../src/particleFeedback.ts';
import {View} from '../src/renderer.ts';
import {Game,type Shot} from '../src/engine.ts';

function dispose(group:THREE.Object3D){const geometry=new Set<THREE.BufferGeometry>(),materials=new Set<THREE.Material>();group.traverse(child=>{if(child instanceof THREE.Mesh){geometry.add(child.geometry);for(const m of Array.isArray(child.material)?child.material:[child.material])materials.add(m);}});geometry.forEach(g=>g.dispose());materials.forEach(m=>m.dispose());}
function particleState(group:THREE.Object3D){const result:number[][]=[];group.traverse(child=>{if(child instanceof THREE.InstancedMesh){result.push(Array.from(child.instanceMatrix.array));for(const name of ['particleAlpha','particleProgress','particleDirection'])result.push(Array.from(child.geometry.getAttribute(name).array));}});return result;}
const shot:Shot={time:10,actor:1,origin:{x:0,y:1.5,z:0},end:{x:0,y:1.5,z:8},hit:0,headshot:false,kind:'shot'};

test('larger local and world muzzle flashes emit along the barrel',()=>{
 for(const [kind,formerRadius] of [['local',.075],['world',.12]] as const){
  const radius=MUZZLE_FLASH_RADII[kind];assert.ok(radius/formerRadius>2.2);
  const flash=makeMuzzleFlash(radius);updateMuzzleFlash(flash,0);flash.updateMatrixWorld(true);
  const bounds=new THREE.Box3().setFromObject(flash),size=bounds.getSize(new THREE.Vector3());
  assert.ok(size.x>=radius*1.99&&size.x<radius*2.1);assert.ok(size.y>radius*1.7&&size.y<radius*2.1);
  assert.ok(bounds.min.z<-radius*2,'flame projects forward out of the muzzle');
  assert.equal(flash.children.filter(child=>child.name==='flame-ribbon').length,3);assert.ok(flash.getObjectByName('muzzle-smoke'));assert.ok(flash.getObjectByName('muzzle-sparks'));
  dispose(flash);
 }
});

test('recorded shot age drives the same short flash and light pulse without stale replay flashes',()=>{
 const flash=makeMuzzleFlash(MUZZLE_FLASH_RADII.local),light=new THREE.PointLight();
 for(const elapsed of [-.1,Infinity,NaN,MUZZLE_EFFECT_SECONDS,1]){
  updateMuzzleFlash(flash,elapsed,light);assert.equal(flash.visible,false);assert.equal(light.intensity,0);
 }
 const beginning=sampleMuzzleFlash(0),middle=sampleMuzzleFlash(MUZZLE_FLASH_SECONDS/2);
 assert.ok(beginning.opacity>middle.opacity&&middle.opacity>0);assert.ok(beginning.light>middle.light&&middle.light>0);
 const live=updateMuzzleFlash(flash,.018,light),replay=updateMuzzleFlash(flash,.018,light);
 assert.deepEqual(replay,live);assert.equal(light.intensity,live.light);assert.equal(flash.visible,true);
 updateMuzzleFlash(flash,.16,light);assert.equal(light.intensity,0);assert.equal(flash.visible,true);assert.equal(flash.getObjectByName('flash-core')?.visible,false);assert.equal(flash.getObjectByName('muzzle-smoke')?.visible,true,'smoke trails after the brief luminous pulse');
 const lateState=particleState(flash);updateMuzzleFlash(flash,.04,light);updateMuzzleFlash(flash,.16,light);assert.deepEqual(particleState(flash),lateState,'seeking back and forward reproduces exactly the same smoke and sparks');
 dispose(flash);
});

test('hit spray has directional mist, streaks and droplets, with deterministic replay sampling',()=>{
 const live=makeImpactEffect(shot),replay=makeImpactEffect(shot),cloud=live.children[0] as THREE.InstancedMesh;
 const particles=cloud.userData.particles as FeedbackParticle[];
 assert.equal(live.name,'blood-impact');assert.ok(particles.length>=90&&particles.length<=120,'denser spray stays within a bounded instance budget');assert.ok(particles.some(p=>p.kind==='mist'));assert.ok(particles.some(p=>p.kind==='wisp'));
 assert.ok(particles.filter(p=>p.kind==='drop'&&p.stretch<3).every(p=>p.size>=.007&&p.size<=.02),'fine droplets avoid oversized opaque ovals');
 assert.ok(particles.filter(p=>p.kind==='drop'&&p.stretch>=3).every(p=>p.size>=.004&&p.size<=.008&&p.size*p.stretch<.04),'thin short streaks accompany the droplets');
 assert.ok(particles.filter(p=>p.kind==='mist').every(p=>p.opacity<=.22),'the denser surrounding cloud remains translucent');
 assert.ok(particles.every(p=>p.delay+p.life<IMPACT_SECONDS),'the pool retains bursts until their final droplets expire');
 assert.ok(particles.every(p=>p.velocity[2]<0),'spray travels back out from the struck surface toward the incoming shot');
 updateImpactEffect(live,.26);updateImpactEffect(replay,.07);updateImpactEffect(replay,.5);updateImpactEffect(replay,.26);
 assert.deepEqual(particleState(live),particleState(replay));
 const drop=particles.find(p=>p.kind==='drop'&&p.velocity[1]<=0)!,early=sampleFeedbackParticle(drop,drop.delay+.05),late=sampleFeedbackParticle(drop,drop.delay+drop.life*.9);
 assert.ok(late.position[1]<early.position[1],'droplets fall under gravity');
 for(const age of [-1,NaN,Infinity,IMPACT_SECONDS])assert.equal(updateImpactEffect(live,age),false);
 const dust=makeImpactEffect({...shot,hit:null});assert.equal(dust.name,'surface-impact');assert.notDeepEqual(particleState(dust),particleState(replay));
 dispose(live);dispose(replay);dispose(dust);
});

test('melee spreads a broad blood fan while rifle hits drive a faster directional cone',()=>{
 const rifle=makeImpactEffect(shot),melee=makeImpactEffect({...shot,kind:'melee'});
 const particles=(effect:THREE.Group)=>(effect.children[0] as THREE.InstancedMesh).userData.particles as FeedbackParticle[];
 const spread=(effect:THREE.Group)=>particles(effect).filter(p=>p.kind==='drop').reduce((sum,p)=>sum+Math.abs(p.velocity[0]/p.velocity[2]),0);
 const speed=(effect:THREE.Group)=>particles(effect).reduce((sum,p)=>sum+Math.abs(p.velocity[2]),0);
 assert.ok(spread(melee)>spread(rifle)*2,'melee sweeps noticeably wider than the bullet impact');assert.ok(speed(rifle)>speed(melee)*1.3,'rifle spray has more forward energy');
 assert.equal(particles(rifle).length,particles(melee).length,'the same pooled instanced mesh supports either weapon');
 for(const effect of [rifle,melee]){for(const age of [0,.12,.45,.9]){updateImpactEffect(effect,age);assert.ok(particleState(effect).flat().every(Number.isFinite));}dispose(effect);}
});

test('muzzle gas ring expands briefly, with smoke and sparks ending within the pooled lifetime',()=>{
 const flash=makeMuzzleFlash(MUZZLE_FLASH_RADII.local),ring=flash.getObjectByName('muzzle-pressure') as THREE.Mesh;
 updateMuzzleFlash(flash,0);const initialScale=ring.scale.x,initialZ=ring.position.z;
 updateMuzzleFlash(flash,MUZZLE_PRESSURE_SECONDS*.65);assert.ok(ring.visible&&ring.scale.x>initialScale&&ring.position.z<initialZ);
 ring.updateMatrix();const sampledMatrix=ring.matrix.clone();
 updateMuzzleFlash(flash,0);updateMuzzleFlash(flash,MUZZLE_PRESSURE_SECONDS*.65);ring.updateMatrix();assert.deepEqual(ring.matrix,sampledMatrix);
 updateMuzzleFlash(flash,MUZZLE_PRESSURE_SECONDS);assert.equal(ring.visible,false);assert.equal(flash.getObjectByName('muzzle-smoke')?.visible,true);
 for(const child of flash.children)if(child instanceof THREE.InstancedMesh)for(const p of child.userData.particles as FeedbackParticle[])assert.ok(p.delay+p.life<MUZZLE_EFFECT_SECONDS);
 dispose(flash);
});

test('melee hits get blood without muzzle flashes and effect allocation stays bounded',()=>{
 const view=Object.create(View.prototype) as View;Object.assign(view,{scene:new THREE.Scene(),effects:[],soldiers:[],weaponMeleeStart:-Infinity,weaponShotStart:-Infinity});
 view.effect({...shot,kind:'melee'},true,.12);assert.equal(view.weaponMeleeStart,shot.time);assert.equal(view.weaponShotStart,-Infinity);assert.equal(view.effects.length,1);assert.equal(view.effects[0].mesh.name,'blood-impact');assert.ok(particleState(view.effects[0].mesh)[0].some(v=>v!==0));
 const first=view.effects[0].mesh,cloud=first.children[0] as THREE.InstancedMesh,geometry=cloud.geometry;let disposed=0,instancesDisposed=0;geometry.addEventListener('dispose',()=>disposed++);cloud.addEventListener('dispose',()=>instancesDisposed++);
 view.effect({...shot,kind:'melee',hit:null},false);assert.equal(view.effects.length,1,'missed bashes do not invent a blood hit');
 for(let i=0;i<70;i++)view.effect({...shot,time:10+i*.01},false);
 assert.equal(view.effects.length,MAX_WORLD_EFFECTS);assert.equal(disposed,0,'evicted GPU resources are recycled during combat');assert.equal(instancesDisposed,0,'instance buffers remain reusable');assert.equal(view.scene.children.length,MAX_WORLD_EFFECTS);
 view.clearEffects();assert.equal(view.effects.length,0);assert.equal(view.scene.children.length,0);(view as any).effectPool.clear();assert.equal(disposed,1,'retained GPU resources are released exactly once on pool teardown');assert.equal(instancesDisposed,1);
});

test('confirmed local network impacts add blood without replaying predicted weapon actions',()=>{
 for(const kind of ['shot','melee'] as const){
  const view=Object.create(View.prototype) as View;Object.assign(view,{scene:new THREE.Scene(),effects:[],soldiers:[],weaponMeleeStart:3,weaponShotStart:4});
  view.effect({...shot,kind},true,.12,true);
  assert.equal(view.weaponMeleeStart,3);assert.equal(view.weaponShotStart,4);assert.equal(view.effects.length,1);assert.equal(view.effects[0].mesh.name,'blood-impact');
  assert.ok(particleState(view.effects[0].mesh)[0].some(v=>v!==0));assert.equal(view.scene.getObjectByName('muzzle-flash'),undefined);
  view.clearEffects();(view as any).effectPool.clear();
 }
});

test('late confirmed impacts receive a full live lifetime while preserving recorded shot time and replay shape',()=>{
 const recorded=Object.freeze({...shot,actor:0,hit:1}),game=new Game(),view=Object.create(View.prototype) as View;
 game.state='playing';game.time=recorded.time+IMPACT_SECONDS+2;game.shots=[recorded];game.replayShots=[recorded];
 const presentedAt=game.time;
 // Exercise the actual render/expiry loop without assets, actor rigs, or a GPU.
 Object.assign(view,{scene:new THREE.Scene(),effects:[],soldiers:[],camera:new THREE.PerspectiveCamera(),viewProjection:new THREE.Matrix4(),viewFrustum:new THREE.Frustum(),muzzle:new THREE.Group(),flash:new THREE.PointLight(),rifle:null,clock:0,weaponMeleeStart:3,weaponShotStart:4,renderer:{render(){},clearDepth(){}}});
 view.effect(recorded,true,0,true,presentedAt);
 assert.equal(view.effects.length,1);const effect=view.effects[0];
 assert.equal(effect.started,presentedAt);assert.equal(effect.seed,shotFeedbackSeed(recorded));
 for(const elapsed of [0,1/60,2/60,.18]){
  game.time=presentedAt+elapsed;view.render(game,1/60,false);
  assert.equal(view.effects[0],effect,'late authority does not immediately expire a fresh hit');assert.equal(effect.mesh.visible,true);
  const cloud=effect.mesh.children[0] as THREE.InstancedMesh;assert.ok(Array.from(cloud.geometry.getAttribute('particleAlpha').array).some(alpha=>alpha>0));
 }
 const liveShape=particleState(effect.mesh);
 assert.equal(view.weaponShotStart,4);assert.equal(view.weaponMeleeStart,3);assert.equal(recorded.time,shot.time);assert.equal(game.shots[0],recorded);assert.equal(game.replayShots[0],recorded);
 game.time=presentedAt+IMPACT_SECONDS+.001;view.render(game,1/60,false);
 assert.equal(view.effects.length,0);assert.equal(effect.mesh.parent,null);assert.equal(effect.mesh.visible,false);
 game.state='killcam';game.replayTime=recorded.time+.18;view.render(game,1/60,false);
 assert.equal(view.effects.length,1);assert.equal(view.effects[0].started,recorded.time,'killcam still ages the effect from the original authoritative shot');assert.equal(view.effects[0].seed,effect.seed);
 // Matrix/alpha values may differ by floating-point subtraction at the two clocks.
 const replayShape=particleState(view.effects[0].mesh);assert.equal(replayShape.length,liveShape.length);
 for(let i=0;i<liveShape.length;i++)for(let j=0;j<liveShape[i].length;j++)assert.ok(Math.abs(liveShape[i][j]-replayShape[i][j])<1e-6);
 view.clearEffects();(view as any).effectPool.clear();
});

test('every rifle world flash follows the animated muzzle position and firing orientation',()=>{
 for(const faction of ['british','russian','german'] as const){
  const soldier=new THREE.Group(),heldRifle=new THREE.Group(),rifle=new THREE.Group(),anchor=new THREE.Object3D(),flash=new THREE.Group();
  soldier.position.set(3,.1,-5);soldier.rotation.y=.7;soldier.add(heldRifle);
  heldRifle.position.set(.085,1.4,.025);heldRifle.rotation.set(-.23,0,-.1);heldRifle.add(rifle);
  rifle.rotation.y=Math.PI;rifle.scale.setScalar(.82);rifle.add(anchor);anchor.position.set(0,.031,RIFLE_VISUALS[faction].muzzleZ);
  placeMuzzleFlash(flash,anchor);
  assert.ok(flash.position.distanceTo(anchor.getWorldPosition(new THREE.Vector3()))<1e-12);
  const expected=new THREE.Vector3(0,0,-1).transformDirection(anchor.matrixWorld),actual=new THREE.Vector3(0,0,-1).applyQuaternion(flash.quaternion);
  assert.ok(actual.distanceTo(expected)<1e-12);
  const before=flash.position.clone();heldRifle.rotation.x+=.2;placeMuzzleFlash(flash,anchor);
  assert.ok(flash.position.distanceTo(before)>.1,'flash follows subsequent animation rather than its stale event position');
 }
});

test('live remote shot cues start a fresh flash on arrival without changing replay timestamps',()=>{
 const recorded=Object.freeze({...shot}),game=new Game(),view=Object.create(View.prototype) as View;
 game.state='playing';game.time=recorded.time+.25;game.shots=[recorded];game.replayShots=[recorded];const arrivedAt=game.time;
 Object.assign(view,{scene:new THREE.Scene(),effects:[],soldiers:[],camera:new THREE.PerspectiveCamera(),viewProjection:new THREE.Matrix4(),viewFrustum:new THREE.Frustum(),muzzle:new THREE.Group(),flash:new THREE.PointLight(),rifle:null,clock:0,weaponMeleeStart:-Infinity,weaponShotStart:-Infinity,renderer:{render(){},clearDepth(){}}});
 view.effect(recorded,false,0,false,arrivedAt);const muzzle=view.effects.find(effect=>effect.kind==='muzzle')!;assert.ok(muzzle);assert.equal(muzzle.started,arrivedAt);
 for(const elapsed of [0,1/60]){game.time=arrivedAt+elapsed;view.render(game,1/60,false);assert.equal(muzzle.mesh.getObjectByName('flash-core')?.visible,true,'network transit and prediction lead do not consume the luminous flash');}
 assert.equal(recorded.time,shot.time);assert.equal(game.shots[0],recorded);assert.equal(game.replayShots[0],recorded);
 game.state='killcam';game.replayTime=recorded.time+.01;view.render(game,1/60,false);const replayMuzzle=view.effects.find(effect=>effect.kind==='muzzle')!;
 assert.equal(replayMuzzle.started,recorded.time,'killcam retains authoritative action timing');
 view.clearEffects();(view as any).effectPool.clear();
});
