import test from 'node:test';
import assert from 'node:assert/strict';
import {Game,type Actor} from '../src/engine.ts';
import {ARENA,FACTIONS,playerShotSpread,type Difficulty,type Stance} from '../src/config.ts';
import {advanceHipSpread,crosshairGapPixels,crosshairDisplayGapPixels} from '../src/accuracy.ts';

const cases:{stance:Stance;moving:number}[]=[{stance:'stand',moving:0},{stance:'stand',moving:2.4},{stance:'stand',moving:4.8},{stance:'crouch',moving:0},{stance:'crouch',moving:2.4},{stance:'prone',moving:0},{stance:'prone',moving:.08}];
function seededOffsets(seed:number,spread:number){
 const next=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
 return{yaw:(next()-.5)*spread,pitch:(next()-.5)*spread};
}
function shoot(game:Game,actor:Actor,seed:number){
 Object.assign(actor,{alive:true,x:ARENA.width/2-1.2,y:4,z:0,yaw:0,pitch:0,recoil:0,lean:0,cooldown:0,reload:0,ammo:10,spawnSafe:0});
 game.seed=seed;game.shots=[];game.events=[];game.fire(actor);
 const shot=game.shots[0];assert.ok(shot,'an allowed shot must fire');
 const x=shot.end.x-shot.origin.x,y=shot.end.y-shot.origin.y,z=shot.end.z-shot.origin.z;
 return{yaw:Math.atan2(x,z),pitch:Math.atan2(y,Math.hypot(x,z))};
}

test('physical hip-fire rays use the widened projected radius for every rifle and firing stance',()=>{
 for(const faction of FACTIONS){
  const game=new Game();game.start(faction,'regular');for(const actor of game.actors)actor.alive=false;
  for(const {stance,moving} of cases){
   Object.assign(game.player,{stance,moving,ads:false});
   // Independent benchmark values: preserve the doubled hip distribution,
   // move the prone base closer to crouch, then enlarge its projected radius.
   const reference=2*(.037*(stance==='prone'?.5:stance==='crouch'?.6:1)+moving*.008);
   const radiusFactor=1.21*(stance==='prone'?1.15:1);
   const expectedSpread=2*Math.atan(Math.tan(reference/2)*radiusFactor);
   game.playerHipSpread=advanceHipSpread(game.playerHipSpread,stance,moving,20);
   for(let n=1;n<=512;n++){
    const seed=n*7919,expected=seededOffsets(seed,expectedSpread),actual=shoot(game,game.player,seed);
    assert.ok(Math.abs(actual.yaw-expected.yaw)<1e-10,`${faction}/${stance}/${moving}: yaw`);
    assert.ok(Math.abs(actual.pitch-expected.pitch)<1e-10,`${faction}/${stance}/${moving}: pitch`);
   }
   for(const height of [480,844,1440])for(const fov of [60,72,90]){
    const prior=crosshairGapPixels(reference,height,fov),current=crosshairGapPixels(game.playerHipSpread,height,fov);
    assert.ok(Math.abs(current/prior-radiusFactor)<1e-12,'pixel radius must increase by the exact requested factor');
   }
  }
 }
});

test('settled prone crosshairs are only slightly tighter than crouched crosshairs',()=>{
 for(const height of [480,844,1440])for(const fov of [60,72,90]){
  const crouch=crosshairGapPixels(playerShotSpread(false,'crouch',0),height,fov);
  const prone=crosshairGapPixels(playerShotSpread(false,'prone',0),height,fov);
  assert.ok(prone/crouch>.95&&prone/crouch<.97,'prone remains about four percent tighter than crouch');
 }
});

test('display reticles are twenty percent wider while preserving physical spread and stance ratios',()=>{
 for(const {stance,moving} of cases)for(const height of [480,844,1440])for(const fov of [60,72,90]){
  const spread=playerShotSpread(false,stance,moving),physical=crosshairGapPixels(spread,height,fov);
  assert.ok(Math.abs(crosshairDisplayGapPixels(spread,height,fov)/physical-1.2)<1e-12);
  assert.equal(playerShotSpread(false,stance,moving),spread,'presentation has no mutable accuracy state');
 }
 const crouch=playerShotSpread(false,'crouch',0),prone=playerShotSpread(false,'prone',0);
 assert.ok(Math.abs(crosshairDisplayGapPixels(prone,844)/crosshairDisplayGapPixels(crouch,844)-crosshairGapPixels(prone,844)/crosshairGapPixels(crouch,844))<1e-12);
 assert.equal(crosshairDisplayGapPixels(0,480),2.4,'the minimum visible radius scales too');
});

test('hip spread widens quickly but retains movement and stance inaccuracy while recovering',()=>{
 const stand=playerShotSpread(false,'stand',0),running=playerShotSpread(false,'stand',4.8);
 const widened=advanceHipSpread(stand,'stand',4.8,.075);
 assert.ok(Math.abs((widened-stand)/(running-stand)-.9)<1e-12,'90% widening takes 75ms');
 const recovering=advanceHipSpread(running,'stand',0,.075);
 assert.ok((running-recovering)/(running-stand)<.32,'stopping must not restore accuracy as fast as starting to move loses it');
 const recovered=advanceHipSpread(running,'stand',0,.45);
 assert.ok(Math.abs((recovered-stand)/(running-stand)-.1)<1e-12,'10% residual spread remains after 450ms');

 let current=running;
 for(const stance of ['stand','crouch','prone'] as const){
  const target=playerShotSpread(false,stance,0),initial=current;
  for(let frame=0;frame<27;frame++){
   const next=advanceHipSpread(current,stance,0,1/60);
   assert.ok(next>=target&&next<=current,'recovery is monotonic and cannot overshoot');
   current=next;
  }
  assert.ok(Math.abs((current-target)/(initial-target)-.1)<1e-12,`${stance} accuracy settles over time`);
 }
 assert.equal(advanceHipSpread(current,'stand',4.8,0),current,'paused simulation cannot change accuracy');
});

test('hip spread recovery and widening are independent of frame rate and uneven frame durations',()=>{
 const initial=playerShotSpread(false,'prone',0);
 const phases:{stance:Stance;moving:number;duration:number}[]=[
  {stance:'stand',moving:4.8,duration:.3},{stance:'stand',moving:0,duration:.2},
  {stance:'crouch',moving:0,duration:.45},{stance:'prone',moving:0,duration:.45},
 ];
 let reference=initial;
 for(const p of phases)reference=advanceHipSpread(reference,p.stance,p.moving,p.duration);
 for(const steps of [[1/30],[1/60],[1/144],[.005,.019,.041,.009,.028]]){
  let current=initial,index=0;
  for(const p of phases){
   let remaining=p.duration;
   while(remaining>1e-12){const dt=Math.min(remaining,steps[index++%steps.length]);current=advanceHipSpread(current,p.stance,p.moving,dt);remaining-=dt;}
  }
  assert.ok(Math.abs(current-reference)<1e-12,`frame durations ${steps}`);
 }
});

test('stopping movement preserves real shot dispersion and the crosshair displays that same angular state',()=>{
 const game=new Game();game.start('british','regular');
 for(const bot of game.actors.slice(1))bot.alive=false;
 Object.assign(game.player,{x:ARENA.width/2-1.2,z:-8,y:0,yaw:0,stance:'stand',grounded:true,ads:false,cooldown:0});
 const still={forward:0,right:0,jump:false,walk:false,lean:0};
 for(let i=0;i<18;i++)game.update(1/60,{...still,forward:1});
 const running=game.playerHipSpread;
 game.update(1/60,still);
 const residual=game.playerHipSpread,stationary=playerShotSpread(false,'stand',0);
 assert.ok(residual>stationary&&residual<running,'one stopped frame must retain some movement spread');
 assert.ok(residual>stationary+(running-stationary)*.9,'first stopped frame closes less than 10%');
 for(let n=1;n<=128;n++){
  const seed=n*7919,expected=seededOffsets(seed,residual),actual=shoot(game,game.player,seed);
  assert.ok(Math.abs(actual.yaw-expected.yaw)<1e-10);
  assert.ok(Math.abs(actual.pitch-expected.pitch)<1e-10);
 }
 for(const height of [480,844,1440]){
  const pixels=crosshairGapPixels(residual,height);
  const reconstructed=2*Math.atan(pixels*2*Math.tan(72*Math.PI/360)/height);
  assert.ok(Math.abs(reconstructed-residual)<1e-12,'displayed gap projects the actual bullet spread');
 }
});

test('respawn resets player spread and pausing does not recover it',()=>{
 const game=new Game();game.start('german','regular');
 game.playerHipSpread=playerShotSpread(false,'stand',4.8);
 const moving=game.playerHipSpread;
 game.state='paused';game.update(1,{forward:0,right:0,jump:false,walk:false,lean:0});
 assert.equal(game.playerHipSpread,moving);
 game.spawn(game.player);
 assert.equal(game.playerHipSpread,playerShotSpread(false,'stand',0));
});

test('ADS ray distributions remain exactly unchanged for every rifle, stance, and allowed movement',()=>{
 for(const faction of FACTIONS){
  const game=new Game();game.start(faction,'regular');for(const actor of game.actors)actor.alive=false;
  for(const state of cases){
   Object.assign(game.player,{...state,ads:true});
   for(let n=1;n<=128;n++){
    const seed=n*11213,before=seededOffsets(seed,.0015),after=shoot(game,game.player,seed);
    assert.ok(Math.abs(after.yaw-before.yaw)<1e-10);
    assert.ok(Math.abs(after.pitch-before.pitch)<1e-10);
   }
  }
 }
});

test('player hip-fire tuning does not change either AI hip-fire or AI ADS dispersion',()=>{
 const original:Record<Difficulty,number>={recruit:.032,regular:.024,veteran:.018};
 for(const difficulty of Object.keys(original) as Difficulty[]){
  const game=new Game();game.start('british',difficulty);for(const actor of game.actors)actor.alive=false;
  const bot=game.actors[1];
  for(const ads of [false,true]){
   Object.assign(bot,{ads,stance:'stand',moving:0});
   for(let n=1;n<=256;n++){
    const seed=n*12289,before=seededOffsets(seed,original[difficulty]*(ads?.7:1)),after=shoot(game,bot,seed);
    assert.ok(Math.abs(after.yaw-before.yaw)<1e-10);
    assert.ok(Math.abs(after.pitch-before.pitch)<1e-10);
   }
  }
 }
});

test('shot, melee, hurt, and death animation timestamps are recorded immutably and reset on spawn',()=>{
 const game=new Game();game.start('british','regular');
 for(const actor of game.actors)actor.alive=false;
 const actor=game.player,bot=game.actors[1];
 actor.alive=true;game.time=1;shoot(game,actor,43);
 assert.equal(actor.lastShotTime,1);assert.equal(actor.lastMeleeTime,-Infinity);
 game.time=1.1;game.fire(actor,true);assert.equal(actor.lastMeleeTime,-Infinity,'blocked attacks must not animate');
 game.time=2;actor.cooldown=0;game.fire(actor,true);assert.equal(actor.lastMeleeTime,2);assert.equal(actor.lastShotTime,1);
 game.time=3;game.damage(actor,bot,10);assert.equal(actor.lastHurtTime,3);game.record();
 const recorded=game.history.at(-1)!.actors[0];
 game.time=4;game.damage(actor,bot,100);
 assert.equal(actor.deadAt,4);assert.equal(actor.lastHurtTime,4);
 const death=game.replay.at(-1)!.actors[0];assert.equal(death.deadAt,4);assert.equal(death.lastHurtTime,4);
 assert.equal(death.lastShotTime,1);assert.equal(death.lastMeleeTime,2);assert.equal(recorded.lastHurtTime,3);
 game.spawn(actor);
 for(const key of ['lastShotTime','lastMeleeTime','lastHurtTime','deadAt'] as const)assert.equal(actor[key],-Infinity);
 assert.equal(death.deadAt,4,'respawn cannot rewrite replay animation metadata');
});
