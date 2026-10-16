import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {Game,type Shot} from '../src/engine.ts';
import {View} from '../src/renderer.ts';
import {makeMuzzleFlash,MUZZLE_FLASH_RADII,MUZZLE_EFFECT_SECONDS} from '../src/weaponFeedback.ts';
import {IMPACT_SECONDS} from '../src/impactFeedback.ts';
import {type JointChain,type SoldierRig} from '../src/soldierAnimation.ts';
import type {Faction} from '../src/config.ts';

// Actual animation rigs and renderer control flow, without loading assets or
// creating a WebGL context. Only the final GPU draw calls are replaced.
function rig(faction:Faction){
 const model=new THREE.Group(),pelvis=new THREE.Group(),spine=new THREE.Group(),neck=new THREE.Group();
 model.add(pelvis);pelvis.add(spine);spine.position.y=.11;spine.add(neck);neck.position.y=.51;
 const chain=(parent:THREE.Group,position:[number,number,number],upperLength:number,lowerLength:number):JointChain=>{
  const root=new THREE.Group(),middle=new THREE.Group(),end=new THREE.Group();parent.add(root);root.position.set(...position);root.add(middle);middle.position.y=-upperLength;middle.add(end);end.position.y=-lowerLength;return{root,middle,end,upperLength,lowerLength};
 };
 const riflePivot=new THREE.Group(),rifle=new THREE.Group(),clip=new THREE.Group(),clipRounds=new THREE.Group();
 model.add(riflePivot);riflePivot.add(rifle);rifle.rotation.y=Math.PI;rifle.scale.setScalar(.82);rifle.add(clip);clip.add(clipRounds);
 const soldierRig:SoldierRig={faction,pelvis,spine,neck,leftArm:chain(spine,[-.228,.394,.006],.33,.34),rightArm:chain(spine,[.228,.394,.006],.33,.34),leftLeg:chain(pelvis,[-.13,-.015,0],.385,.345),rightLeg:chain(pelvis,[.13,-.015,0],.385,.345),riflePivot,rifle,clip,clipRounds};
 model.userData.soldierRig=soldierRig;return model;
}
function fakeView(game:Game):View {
 const view=Object.create(View.prototype) as View;
 const viewFrustum=new THREE.Frustum();viewFrustum.intersectsSphere=()=>true; // These tests exercise presentation, not frustum rejection.
 Object.assign(view,{viewFrustum,viewProjection:new THREE.Matrix4(),shadowDirection:new THREE.Vector3(24,-40,-16).normalize(),worldSun:new THREE.DirectionalLight(),scene:new THREE.Scene(),weaponScene:new THREE.Scene(),camera:new THREE.PerspectiveCamera(),weaponCamera:new THREE.PerspectiveCamera(),weapon:new THREE.Group(),rifle:new THREE.Group(),grenade:null,faction:game.player.faction,soldiers:game.actors.map(a=>rig(a.faction)),muzzle:makeMuzzleFlash(MUZZLE_FLASH_RADII.local),flash:new THREE.PointLight(),effects:[],ads:1,bob:2,clock:0,weaponActor:0,weaponMeleeStart:-Infinity,weaponShotStart:-Infinity,lastReplayShot:-1,roundEnded:false,renderer:{shadowMap:{enabled:true},autoClear:true,render(){},clearDepth(){}}});
 for(const soldier of view.soldiers)view.scene.add(soldier);
 return view;
}

test('ending a rendered round clears live blends and muzzle effects while preserving frozen corpses',()=>{
 const game=new Game();game.start('british','recruit');game.time=10;game.actors=game.actors.slice(0,3);
 const player=game.player,bot=game.actors[1],corpse=game.actors[2];
 Object.assign(player,{moving:4,ads:true,recoil:.04,cooldown:.7});
 Object.assign(bot,{moving:4,ads:true,reload:1,reloadTotal:3,lastHurtTime:9.9});
 Object.assign(corpse,{alive:false,deadAt:9.7,deathYaw:.4,deathHeadshot:true});
 const view=fakeView(game);
 const shot:Shot={time:9.99,actor:1,origin:{x:0,y:1,z:0},end:{x:0,y:1,z:4},hit:null,headshot:false,kind:'shot'};
 view.effect({...shot,actor:0},true);view.effect(shot,false);view.weaponMeleeStart=9.9;
 view.render(game,1/60,false);
 assert.equal(view.muzzle.visible,true);assert.ok(view.flash.intensity>0);
 assert.ok(view.effects.length>0);assert.ok(view.soldiers[1].userData.soldierState.speed>3);
 const oldLiveState=view.soldiers[1].userData.soldierState,deadState=view.soldiers[2].userData.soldierState;
 const deadPose=structuredClone(view.soldiers[2].userData.animationPose);
 const effectMeshes=view.effects.map(effect=>effect.mesh),geometries=new Set<THREE.BufferGeometry>();let disposed=0;
 for(const mesh of effectMeshes)mesh.traverse(object=>{if(object instanceof THREE.Mesh)geometries.add(object.geometry);});
 for(const geometry of geometries)geometry.addEventListener('dispose',()=>disposed++);
 game.finish();view.render(game,1/60,false);
 assert.equal(view.roundEnded,true);assert.equal(view.weaponShotStart,-Infinity);assert.equal(view.weaponMeleeStart,-Infinity);
 assert.equal(view.ads,0);assert.equal(view.muzzle.visible,false);assert.equal(view.flash.intensity,0);
 assert.equal(view.effects.length,0);assert.equal(disposed,0,'inactive bursts retain their GPU resources for reuse');assert.ok(effectMeshes.every(mesh=>mesh.parent===null&&!mesh.visible));
 const liveState=view.soldiers[1].userData.soldierState;
 assert.notEqual(liveState,oldLiveState);assert.equal(liveState.speed,0);assert.equal(liveState.aim,0);
 assert.equal(view.soldiers[1].userData.animationStage,'Idle');
 assert.equal(view.soldiers[2].userData.soldierState,deadState,'the dead rig is never reset');
 assert.deepEqual(view.soldiers[2].userData.animationPose,deadPose);
 const camera=view.camera.position.clone(),weapon=view.weapon.position.clone(),livePose=structuredClone(view.soldiers[1].userData.animationPose);
 for(let i=0;i<30;i++)view.render(game,1/30,false);
 assert.equal(view.soldiers[1].userData.soldierState,liveState,'transition cleanup happens once');
 assert.deepEqual(view.soldiers[1].userData.animationPose,livePose);
 assert.deepEqual(view.soldiers[2].userData.animationPose,deadPose);
 assert.ok(view.camera.position.equals(camera));assert.ok(view.weapon.position.equals(weapon));assert.equal(view.muzzle.visible,false);
 // Reusing a view for subsequent play must allow the next round's effects.
 game.start('british','recruit');view.render(game,1/60,false);assert.equal(view.roundEnded,false);
 view.effect({...shot,actor:0,time:game.time},true);view.render(game,1/60,false);assert.equal(view.muzzle.visible,true);
 game.finish();view.render(game,1/60,false);assert.equal(view.muzzle.visible,false,'another round gets its own cleanup');
});

test('ending during killcam hides the dead player weapon without changing an interrupted corpse action',t=>{
 for(const action of ['reload','switch'] as const){
  const game=new Game();game.start('british','recruit');game.time=10;game.actors=game.actors.slice(0,3);
  const player=game.player;player.ammo=3;
  if(action==='reload'){game.reload();player.reload=1.2;}else game.selectWeapon('grenade');
  player.recoil=.06;game.time+=.1;game.damage(player,game.actors[1],100);
  assert.equal(game.state,'killcam');game.replayTime=game.time;
  const view=fakeView(game),drawn:THREE.Scene[]=[];let depthClears=0;
  t.mock.method(view.renderer,'render',(scene:THREE.Scene)=>drawn.push(scene));
  t.mock.method(view.renderer,'clearDepth',()=>depthClears++);
  view.render(game,1/60,false);
  assert.deepEqual(drawn,[view.scene,view.weaponScene],'the killer weapon remains visible during killcam');
  const corpse=structuredClone(player),pose=structuredClone(view.soldiers[0].userData.animationPose),state=view.soldiers[0].userData.soldierState;
  drawn.length=0;depthClears=0;game.finish();
  for(let i=0;i<10;i++)view.render(game,1/60,false);
  assert.deepEqual(player,corpse,'ending preserves the dead actor and its recorded action');
  assert.equal(view.soldiers[0].userData.soldierState,state);
  assert.deepEqual(view.soldiers[0].userData.animationPose,pose);
  assert.equal(drawn.length,10);assert.ok(drawn.every(scene=>scene===view.scene),'no first-person overlay survives the ended dead-player view');
  assert.equal(depthClears,0);assert.equal(view.muzzle.visible,false);assert.equal(view.flash.intensity,0);
 }
});

test('a waiting death view without a killer recording never displays the dead player weapon',t=>{
 const game=new Game();game.start('british','recruit');game.time=10;game.actors=game.actors.slice(0,3);
 game.damage(game.player,game.actors[1],100);game.killer=0;game.replayTime=game.replayEnd+.65;
 const view=fakeView(game),drawn:THREE.Scene[]=[];t.mock.method(view.renderer,'render',(scene:THREE.Scene)=>drawn.push(scene));
 view.render(game,1/60,false);
 assert.deepEqual(drawn,[view.scene]);assert.equal(view.muzzle.visible,false);assert.equal(view.flash.intensity,0);
});

test('hit effects pause with simulation time and replay seeks reconstruct without stale duplicates',()=>{
 const game=new Game();game.start('british','recruit');game.time=10;game.actors=game.actors.slice(0,3);
 const view=fakeView(game),shot:Shot={time:9.8,actor:1,origin:{x:0,y:1,z:0},end:{x:0,y:1,z:4},hit:2,headshot:false,kind:'shot'};
 const particles=()=>view.effects.map(effect=>({kind:effect.kind,life:effect.life,data:effect.mesh.children.filter(child=>child instanceof THREE.InstancedMesh).map(child=>Array.from((child as THREE.InstancedMesh).instanceMatrix.array))}));
 view.effect(shot,false);view.render(game,1/60,false);const paused=particles();game.state='paused';
 for(let i=0;i<12;i++)view.render(game,1/30,false);
 assert.deepEqual(particles(),paused,'rendering alone does not age paused particles');
 const old=view.effects.slice();game.state='killcam';game.killer=0;game.replayTime=9.9;game.replayShots=[shot];view.render(game,1/60,false);
 assert.ok(old.every(effect=>!view.effects.includes(effect)),'live event records are discarded when replay begins, even if GPU buffers are reused');assert.equal(view.effects.length,2);assert.equal(new Set(view.effects.map(e=>e.mesh)).size,2,'each live burst has sole ownership of its buffers');const replay=particles();
 game.replayTime=10.2;view.render(game,1/30,false);game.replayTime=9.9;view.render(game,1/120,false);
 assert.deepEqual(particles(),replay,'rewinding reconstructs the same exact particle positions and lifetimes');assert.equal(view.effects.length,2);
 game.replayTime=shot.time+Math.max(IMPACT_SECONDS,MUZZLE_EFFECT_SECONDS)+.001;view.render(game,1/60,false);assert.equal(view.effects.length,0,'all GPU effects expire by recorded age');
 game.state='playing';view.render(game,1/60,false);assert.equal(view.effects.length,0);
});

test('spectator follow uses the target camera, delayed action clock and weapon while hiding its body',async t=>{
 const {sampleFirstPersonWeaponAnimation}=await import('../src/firstPersonWeaponAnimation.ts');
 const game=new Game();game.start('british','recruit');game.actors=game.actors.slice(0,3);game.time=20;game.spectate();
 const target=game.actors[1];Object.assign(target,{faction:'russian',x:13,y:0,z:4,yaw:.4,pitch:.1,lean:.7,recoil:0,ads:true,spawnSafe:0,lastShotTime:9.98});
 game.spectator.cycle(game.actors,1);const view=fakeView(game),drawn:THREE.Scene[]=[];
 const bolt=new THREE.Group();bolt.name='bolt';view.rifle!.add(bolt);view.grenade=new THREE.Group();view.ads=1;
 t.mock.method(view,'setFaction',(faction:Faction)=>{view.faction=faction;});
 t.mock.method(view.renderer,'render',(scene:THREE.Scene)=>drawn.push(scene));
 view.render(game,1/60,false,true,10);
 assert.equal(view.faction,'russian');assert.equal(view.weaponActor,1);assert.equal(view.soldiers[0].visible,false);assert.equal(view.soldiers[1].visible,false);assert.equal(view.soldiers[2].visible,true);
 const eye=game.eye(target);assert.ok(view.camera.position.distanceTo(new THREE.Vector3(eye.x,eye.y,eye.z))<1e-9);assert.equal(view.camera.fov,49);
 assert.equal(view.weaponShotStart,9.98);assert.equal(view.muzzle.visible,true,'a remote shot uses the delayed remote clock, not the newer local clock');assert.deepEqual(drawn,[view.scene,view.weaponScene]);
 Object.assign(target,{ads:false,lastShotTime:-Infinity,reload:1.5,reloadTotal:3});view.ads=0;view.render(game,1/60,false,true,10);
 const reloadPose=sampleFirstPersonWeaponAnimation('russian','reload',.5,false,undefined,0);
 assert.ok(bolt.position.distanceTo(new THREE.Vector3(...reloadPose.boltOrigin).add(new THREE.Vector3(0,0,reloadPose.boltTravel)))<1e-9,'follow shows the target reload mechanism');
 Object.assign(target,{selectedWeapon:'grenade',switchFrom:'rifle',switchStarted:8,reload:0});view.render(game,1/60,false,true,10);assert.equal(view.rifle!.visible,false);assert.equal(view.grenade.visible,true);
 target.alive=false;view.render(game,1/60,false,true,10);assert.equal(game.spectator.targetId,2);assert.equal(view.soldiers[1].visible,true);assert.equal(view.soldiers[2].visible,false);
 game.actors[2].alive=false;drawn.length=0;view.render(game,1/60,false,true,10);assert.equal(game.spectator.targetId,null);assert.deepEqual(drawn,[view.scene]);assert.equal(view.muzzle.visible,false);
});

test('free spectator camera draws the arena alone and near-plane clearance remains safe on ultrawide displays',async t=>{
 const {LEAN_CAMERA_RADIUS}=await import('../src/lean.ts');
 const game=new Game();game.start('british','recruit');game.spectate();game.spectator.position={x:13,y:4,z:5};game.spectator.yaw=.8;game.spectator.pitch=.3;
 const view=fakeView(game),drawn:THREE.Scene[]=[];t.mock.method(view.renderer,'render',(scene:THREE.Scene)=>drawn.push(scene));
 for(const aspect of [4/3,16/9,21/9,32/9,8]){
  view.camera.aspect=aspect;drawn.length=0;view.render(game,1/60,false);
  assert.deepEqual(drawn,[view.scene]);assert.ok(view.camera.position.equals(new THREE.Vector3(13,4,5)));assert.equal(view.soldiers[0].visible,false);assert.ok(view.soldiers.slice(1).every(s=>s.visible));
  const tangent=Math.tan(view.camera.fov*Math.PI/360),radius=view.camera.near*Math.sqrt(1+tangent*tangent*(1+aspect*aspect));
  assert.ok(radius<LEAN_CAMERA_RADIUS,'all near-plane corners fit inside the swept camera clearance');
  if(aspect===16/9)assert.equal(view.camera.near,.05,'ordinary screens retain the original near plane');
 }
});


test('static menu draws once, then invalidates on entry and explicit layout or quality changes',t=>{
 const game=new Game();game.start('british','recruit');const view=fakeView(game);let draws=0;
 Object.assign(view,{menuTarget:new THREE.Vector3(),intro:{scene:new THREE.Scene(),camera:new THREE.OrthographicCamera(),invalidateShadows(){}}});
 t.mock.method(view.renderer,'render',()=>draws++);
 view.render(game,1/60,true,true);assert.equal(draws,1);
 const time=view.soldiers[1].userData.soldierState.time;
 game.time+=1;for(let i=0;i<30;i++)view.render(game,1/60,true,true);
 assert.equal(draws,1,'unchanged menu does not submit another GPU frame');assert.equal(view.soldiers[1].userData.soldierState.time,time,'menu does no hidden pose work either');
 view.invalidateIntro();view.render(game,1/60,true,true);assert.equal(draws,2);
 view.render(game,1/60,false);const playingDraws=draws;assert.equal(playingDraws,4,'world and first-person rendering still run');
 view.render(game,1/60,true,true);assert.equal(draws,playingDraws+1,'returning from play always restores the menu pixels');
});
