import test from 'node:test';
import assert from 'node:assert/strict';
import {Game,createActor,type Actor} from '../src/engine.ts';
import {ARENA,RULES} from '../src/config.ts';
import {advanceSoldierMotion,initialMotion} from '../src/soldierMotionState.ts';

function soldier(){const a=createActor(0,'british','Runner');a.pose=initialMotion(a);return a;}
function move(a:Actor,speed:number,seconds:number,step=1/120,sideways=false){
 for(let remaining=seconds;remaining>1e-12;){
  const dt=Math.min(step,remaining),x=a.x,z=a.z;a.moving=speed;
  if(sideways)a.x+=speed*dt;else a.z+=speed*dt;
  advanceSoldierMotion(a,dt,x,z);remaining-=dt;
 }
}

test('brief starts advance the step clock immediately and reach the moving pose promptly',()=>{
 for(const speed of [1.6,2.8,4.5]){
  const starting=soldier(),running=soldier();running.moving=speed;running.pose=initialMotion(running);
  move(starting,speed,.1);move(running,speed,.1);
  assert.ok(Math.abs(starting.pose!.phase-running.pose!.phase)<1e-12,'starting from rest cannot lose distance from the step clock');
  assert.ok(starting.pose!.speed>speed*.9,'a 100 ms movement reaches the walking/running pose');
  assert.ok(starting.pose!.speed<speed,'the pose still blends into motion');
 }
});

test('short moves accumulate the same footfalls as an equal continuous distance, with no steps after stopping',()=>{
 for(const stance of ['stand','crouch','prone'] as const)for(const sideways of [false,true]){
  const short=soldier(),continuous=soldier();
  for(const a of [short,continuous]){a.stance=stance;a.pose=initialMotion(a);}
  const speed=stance==='stand'?4.5:stance==='crouch'?1.3:.7;
  for(let i=0;i<6;i++){
   move(short,speed,.1,1/120,sideways);const phase=short.pose!.phase;
   move(short,0,.2);assert.equal(short.pose!.phase,phase,'idle blending must not add phantom footsteps');
  }
  move(continuous,speed,.6,1/120,sideways);
  assert.ok(Math.hypot(short.x-continuous.x,short.z-continuous.z)<1e-12);
  assert.ok(Math.abs(short.pose!.phase-continuous.pose!.phase)<1e-12,'stopping between bursts cannot change steps per metre');
 }
});

test('movement and stance blends agree across frame rates and freeze with simulation time',()=>{
 const simulate=(fps:number)=>{
  const a=soldier();move(a,4.5,.1,1/fps);move(a,0,.2,1/fps);
  a.stance='crouch';a.ads=true;move(a,1.3,.2,1/fps,true);
  a.stance='stand';move(a,2.8,.1,1/fps);move(a,0,.2,1/fps);
  const before={...a.pose!};advanceSoldierMotion(a,0,a.x,a.z);assert.deepEqual(a.pose,before);
  return a.pose!;
 };
 const reference=simulate(144);
 for(const fps of [30,60,120])for(const [key,value] of Object.entries(simulate(fps)))
  assert.ok(Math.abs(value-reference[key as keyof typeof reference])<1e-7,`${key} differs at ${fps} Hz`);
});

test('pushing against a wall cannot advance a stationary soldier gait',()=>{
 const game=new Game(),a=soldier();game.state='playing';game.actors=[a];
 a.x=ARENA.width/2-RULES.radius;a.z=-6;const phase=a.pose!.phase;
 for(let i=0;i<30;i++)game.move(a,1,0,1/60);
 assert.equal(a.moving,0);assert.equal(a.pose!.phase,phase);
});
