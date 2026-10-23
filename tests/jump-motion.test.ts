import test from 'node:test';
import assert from 'node:assert/strict';
import {Game} from '../src/engine.ts';
import {ARENA,BOXES,RULES,blocked} from '../src/config.ts';

const idle={forward:0,right:0,jump:false,walk:false,lean:0};
function solo(){
 const game=new Game();game.start('british','recruit');
 for(const bot of game.actors.slice(1)){bot.alive=false;bot.deadAt=Infinity;}
 Object.assign(game.player,{x:ARENA.width/2-1,y:0,z:0,yaw:0,pitch:0});
 return game;
}

test('jump and landing animation events follow physics and survive replay sampling',()=>{
 const game=solo(),actor=game.player;
 game.setStance('crouch');game.update(.02,{...idle,jump:true});
 assert.equal(actor.jumpStarted,-Infinity,'standing up is not a jump');
 game.update(.02,{...idle,jump:true});
 assert.equal(actor.jumpStarted,game.time);assert.equal(actor.grounded,false);
 game.record();const launch=game.history.at(-1)!;
 assert.equal(launch.actors[0].jumpStarted,actor.jumpStarted);
 assert.equal(launch.actors[0].vy,actor.vy);
 while(!actor.grounded&&game.time<2)game.update(1/120,idle);
 assert.ok(actor.landingSpeed>RULES.jump*.8);
 assert.equal(actor.landedAt,game.time);game.record();const landing=game.history.at(-1)!;
 game.replay=[launch,landing];game.replayTime=launch.time;
 assert.equal(game.replayFrame()!.actors[0].grounded,false);
 game.replayTime=landing.time;
 assert.equal(game.replayFrame()!.actors[0].grounded,true);
 assert.equal(game.replayFrame()!.actors[0].landedAt,landing.time);
 const stamp=actor.landedAt;
 for(let i=0;i<20;i++)game.update(1/120,idle);
 assert.equal(actor.landedAt,stamp,'ground contact is recorded once, not every frame');
 game.spawn(actor);assert.equal(actor.jumpStarted,-Infinity);assert.equal(actor.landedAt,-Infinity);assert.equal(actor.landingSpeed,0);
});

test('crate landings record impact without inventing a takeoff when walking off',()=>{
 const game=solo(),actor=game.player,crate=BOXES.find(box=>box.kind!=='wall')!;
 Object.assign(actor,{x:crate.x,z:crate.z,y:crate.h+.2,vy:-3,grounded:false});
 while(!actor.grounded&&game.time<1)game.update(1/120,idle);
 assert.equal(actor.y,crate.h);assert.equal(actor.landedAt,game.time);assert.ok(actor.landingSpeed>3);
 actor.jumpStarted=game.time-.2;
 Object.assign(actor,{x:crate.x+crate.w/2+.17});
 game.move(actor,1,0,.05);
 assert.equal(actor.grounded,false);assert.equal(actor.jumpStarted,-Infinity);
 game.finish();assert.equal(actor.jumpStarted,-Infinity);assert.equal(actor.landedAt,-Infinity);assert.equal(actor.landingSpeed,0);
});

test('killcam shows takeoff and landing at event times between recorded frames',()=>{
 const game=solo(),actor=game.player;
 game.update(1/120,{...idle,jump:true});const takeoff=actor.jumpStarted;
 while(game.time<.75)game.update(1/120,idle);
 game.replay=game.history;
 game.replayTime=takeoff-.001;
 let frame=game.replayFrame()!.actors[0];assert.equal(frame.grounded,true);assert.equal(frame.jumpStarted,-Infinity);assert.equal(frame.y,0);
 game.replayTime=takeoff+.015;
 frame=game.replayFrame()!.actors[0];assert.equal(frame.grounded,false);assert.equal(frame.jumpStarted,takeoff);assert.ok(frame.vy>0);assert.ok(frame.y>0);
 game.replayTime=actor.landedAt-.00001;
 assert.ok(game.replayFrame()!.actors[0].y<.001,'the replay descends continuously to contact at the event time');
 game.replayTime=actor.landedAt+.005;
 frame=game.replayFrame()!.actors[0];assert.equal(frame.grounded,true);assert.equal(frame.landedAt,actor.landedAt);assert.equal(frame.y,0);assert.equal(frame.vy,0);
});

test('a respawn snapshot clears old airborne animation state without extrapolating a fall',()=>{
 const game=solo(),actor=game.player;
 Object.assign(actor,{alive:false,grounded:false,y:1,vy:-4,jumpStarted:.9,leftGroundAt:.9,landedAt:.4});game.time=1;game.record();
 const before=game.history.at(-1)!;game.spawn(actor);game.time=1.05;game.record();const after=game.history.at(-1)!;
 game.replay=[before,after];game.replayTime=1.04;
 assert.equal(game.replayFrame()!.actors[0].vy,-4);
 game.replayTime=after.time;assert.deepEqual(game.replayFrame()!.actors[0],after.actors[0]);
});

test('a landing immediately followed by another jump has separate replay snapshots',()=>{
 const game=solo(),actor=game.player;game.update(1/120,{...idle,jump:true});
 while(!actor.grounded)game.update(1/120,idle);
 const landing=actor.landedAt;
 game.update(1/120,{...idle,jump:true});const takeoff=actor.leftGroundAt;
 while(game.time<takeoff+.1)game.update(1/120,idle);
 assert.ok(game.history.some(frame=>frame.time===landing&&frame.actors[0].grounded));
 assert.ok(game.history.some(frame=>frame.time===takeoff&&!frame.actors[0].grounded));
 game.replay=game.history;game.replayTime=(landing+takeoff)/2;
 let frame=game.replayFrame()!.actors[0];assert.equal(frame.grounded,true);assert.equal(frame.y,0);assert.equal(frame.vy,0);
 game.replayTime=takeoff+.005;frame=game.replayFrame()!.actors[0];assert.equal(frame.grounded,false);assert.ok(frame.vy>0);assert.ok(frame.y>0);
});

test('landing on the collision footprint at crate faces and corners never embeds the player',()=>{
 const crate=BOXES.find(box=>box.kind!=='wall')!;
 for(const [sx,sz] of [[1,0],[-1,0],[0,1],[0,-1],[1,1],[-1,1],[1,-1],[-1,-1]]){
  const game=solo(),a=game.player;
  const x=crate.x+sx*(crate.w/2+RULES.radius-.015),z=crate.z+sz*(crate.d/2+RULES.radius-.015);
  Object.assign(a,{x,z,y:crate.h+.15,vy:-2,grounded:false});
  for(let i=0;i<30;i++)game.move(a,0,0,1/60);
  assert.equal(a.y,crate.h);assert.equal(a.grounded,true);assert.equal(blocked(a.x,a.z,a.y),false);
  // Both moving back onto the box and walking off it remain possible.
  game.move(a,-sx*.5,-sz*.5,1/60);assert.ok(Math.hypot(a.x-x,a.z-z)>.01);
  for(let i=0;i<40;i++){game.move(a,sx*.5,sz*.5,1/60);assert.equal(blocked(a.x,a.z,a.y),false);}
  assert.equal(a.y,0);assert.ok(Math.hypot(a.x-x,a.z-z)>1);
 }
});
