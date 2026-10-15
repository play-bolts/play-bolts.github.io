import test from 'node:test';
import assert from 'node:assert/strict';
import {Game} from '../src/engine.ts';
import {HEIGHTS,WEAPONS,ARENA,type Stance} from '../src/config.ts';
import {advanceStanceHeight,stanceSpeedFactor} from '../src/stance.ts';

const idle={forward:0,right:0,jump:false,walk:false,lean:0};
function solo(){
 const game=new Game();game.start('british','regular');
 for(const bot of game.actors.slice(1)){bot.alive=false;bot.deadAt=Infinity;}
 Object.assign(game.player,{x:ARENA.width/2-1,y:0,z:0,yaw:0,pitch:0,cooldown:0,spawnSafe:0});
 return game;
}

test('crouch and prone change eye position gradually, reverse continuously and settle quickly',()=>{
 for(const stance of ['crouch','prone'] as Stance[]){
  const game=solo(),p=game.player;
  game.setStance(stance);assert.equal(game.eye(p).y,HEIGHTS.stand,'keypress must not teleport the camera');
  game.update(1/120,idle);
  assert.ok(p.eyeHeight<HEIGHTS.stand&&p.eyeHeight>HEIGHTS[stance]);
  const first=p.eyeHeight;game.setStance(stance);
  assert.equal(p.eyeHeight,first,'reversing a transition must preserve its current height');
  game.update(1/120,idle);assert.ok(p.eyeHeight>first&&p.eyeHeight<HEIGHTS.stand);
  game.setStance(stance);
  for(let i=0;i<42;i++)game.update(1/120,idle);
  assert.ok(Math.abs(p.eyeHeight-HEIGHTS[stance])<.02,'transition should be practically complete within .35s');
  for(let i=0;i<90;i++)game.update(1/120,idle);
  assert.equal(p.eyeHeight,HEIGHTS[stance]);
 }
});

test('stance response is frame-rate independent and movement speed follows intermediate height',()=>{
 for(const target of ['stand','crouch','prone'] as Stance[]){
  const start=target==='stand'?HEIGHTS.prone:HEIGHTS.stand;
  const values=[30,60,120,144].map(hz=>{let h=start;for(let i=0;i<hz;i++)h=advanceStanceHeight(h,target,.3/hz);return h;});
  assert.ok(Math.max(...values)-Math.min(...values)<1e-12);
 }
 assert.equal(stanceSpeedFactor(HEIGHTS.stand),1);
 assert.equal(stanceSpeedFactor(HEIGHTS.crouch),.58);
 assert.equal(stanceSpeedFactor(HEIGHTS.prone),.23);
 const game=solo();game.setStance('prone');game.update(1/120,{...idle,forward:1});
 assert.ok(game.player.moving>4.8*.23&&game.player.moving<4.8);
});

test('ADS remains active throughout crouch and stand transitions, including Space to stand up',()=>{
 for(const faction of ['british','russian','german'] as const){
  const game=solo(),p=game.player;p.faction=faction;p.ads=true;
  const settle=()=>{for(let i=0;i<60;i++){game.update(1/120,idle);assert.equal(p.ads,true);assert.equal(game.canADS(),true);}};
  game.setStance('crouch');assert.equal(p.ads,true);settle();
  assert.equal(p.stance,'crouch');assert.ok(Math.abs(p.eyeHeight-HEIGHTS.crouch)<.01);
  game.setStance('crouch');assert.equal(p.stance,'stand');settle();
  // The same jump input produced by Space first stands up from a low stance.
  for(const stance of ['crouch','prone'] as const){
   game.setStance(stance);settle();
   game.update(1/120,{...idle,jump:true});
   assert.equal(p.stance,'stand');assert.equal(p.y,0);assert.equal(p.grounded,true);assert.equal(p.ads,true);
   settle();
  }
  game.update(1/120,{...idle,jump:true});
  assert.equal(p.grounded,false);assert.ok(p.y>0);assert.equal(p.ads,false);assert.equal(game.canADS(),false,'an actual jump still disables iron sights');
 }
});

test('shots, replay and pause use the same transitioning eye height; respawn clears it',()=>{
 const game=solo(),p=game.player;game.setStance('prone');game.update(.05,idle);
 p.ads=true;game.fire();assert.equal(game.shots.at(-1)!.origin.y,game.eye(p).y);
 const h=p.eyeHeight;game.state='paused';game.update(.5,idle);assert.equal(p.eyeHeight,h);
 game.state='playing';game.history=[];game.record();const a=game.history[0];
 game.update(.05,idle);game.record();const b=game.history.at(-1)!;
 game.replay=[a,b];game.replayTime=(a.time+b.time)/2;
 assert.ok(Math.abs(game.replayFrame()!.actors[0].eyeHeight-(a.actors[0].eyeHeight+b.actors[0].eyeHeight)/2)<1e-12);
 game.spawn(p);assert.equal(p.eyeHeight,HEIGHTS.stand);assert.equal(a.actors[0].eyeHeight,h);
});

test('a lowering target keeps its intermediate hit volume until it reaches prone',()=>{
 const game=solo(),p=game.player,target=game.actors[1];
 Object.assign(target,{alive:true,x:p.x,y:0,z:4,stance:'prone',eyeHeight:HEIGHTS.stand,spawnSafe:0,cooldown:100});
 game.move(target,0,0,1/120);
 p.ads=true;game.fire();
 assert.equal(game.shots.at(-1)!.hit,target.id,'a crouch/prone key cannot instantly remove the old upper hit volume');
});

test('all rifles kick another 35 percent harder and recoil recovers gradually in simulation time',()=>{
 const before={british:.0588,russian:.0658,german:.0616};
 for(const faction of ['british','russian','german'] as const){
  const game=solo(),p=game.player;p.faction=faction;game.fire();
  assert.ok(Math.abs(p.recoil-before[faction]*1.35)<1e-12);
  assert.equal(p.recoil,WEAPONS[faction].recoil);
  game.update(.1,idle);assert.ok(p.recoil>before[faction]*1.35*Math.exp(-.5));
  assert.ok(p.recoil<WEAPONS[faction].recoil);
 }
});
