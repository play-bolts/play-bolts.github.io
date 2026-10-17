import test from 'node:test';
import assert from 'node:assert/strict';
import {groundGait,gaitRate,crossedFootContact} from '../src/soldierGait.ts';
import {advanceSoldierMotion,initialMotion} from '../src/soldierMotionState.ts';
import {Game,createActor} from '../src/engine.ts';

test('planted feet cancel world travel in all eight directions and at analog speeds',()=>{
 for(const speed of [.08,.4,1.7,2.8,4.5,4.86])for(const crouch of [0,1])for(let direction=0;direction<8;direction++){
  const forward=Math.cos(direction*Math.PI/4),sideways=Math.sin(direction*Math.PI/4),rate=gaitRate(speed,crouch,0),dt=1e-5;
  for(let i=0;i<100;i++){
   const phase=i/100,a=groundGait(speed,crouch,phase,forward,sideways),b=groundGait(speed,crouch,phase+rate*dt,forward,sideways);
   for(const side of ['left','right'] as const)if(a[side].support&&b[side].support){
    const dx=b[side].position[0]-a[side].position[0]+speed*sideways*dt,dz=b[side].position[2]-a[side].position[2]+speed*forward*dt;
    assert.ok(Math.hypot(dx,dz)<1e-10,'supported soles must remain still against the ground');
    assert.equal(a[side].position[1],0);assert.equal(b[side].position[1],0);
   }
  }
 }
});

test('swing matches support velocity at toe-off and touchdown with continuous boot clearance',()=>{
 for(const speed of [1.7,4.5])for(const crouch of [0,1]){
  const input=(phase:number)=>groundGait(speed,crouch,phase,1,0).left.position;
  const duty=groundGait(speed,crouch,0,1,0).duty,eps=1e-6;
  for(const p of [duty,1]){
   const a=input(p-eps),b=input(p),c=input(p+eps);
   for(let axis=0;axis<3;axis++)assert.ok(Math.abs((b[axis]-a[axis])/eps-(c[axis]-b[axis])/eps)<.001,'foot velocity cannot snap at contact');
  }
  const gait=groundGait(speed,crouch,duty/2,1,0);
  if(speed<2)assert.ok(gait.left.support||gait.right.support,'walking has no flight phase');
 }
});

test('blocked, stopped and airborne actors do not advance the grounded gait',()=>{
 const actor=createActor(0,'british','Test');actor.moving=4.5;actor.pose=initialMotion(actor);actor.pose.phase=.21;
 for(const grounded of [true,false]){
  actor.grounded=grounded;actor.moving=grounded?0:4.5;
  const before=actor.pose.phase;
  for(let i=0;i<60;i++)advanceSoldierMotion(actor,1/60,actor.x,actor.z);
  assert.equal(actor.pose.phase,before);
 }
});

test('crouch feet turn continuously through sideways and backward travel',()=>{
 for(const phase of [.05,.3,.65,.8])for(let degree=0;degree<360;degree++){
  const angle=degree*Math.PI/180,epsilon=1e-5;
  const before=groundGait(1.3,1,phase,Math.cos(angle-epsilon),Math.sin(angle-epsilon));
  const after=groundGait(1.3,1,phase,Math.cos(angle+epsilon),Math.sin(angle+epsilon));
  for(const side of ['left','right'] as const)for(let i=0;i<3;i++)
   assert.ok(Math.abs(after[side].rotation[i]-before[side].rotation[i])<.001,'heel roll cannot switch abruptly when travel turns backward');
 }
});

test('footstep events occur at alternating visual contacts and never during air or rewind',()=>{
 const game=new Game(),actor=createActor(0,'british','Test');actor.moving=4.5;actor.pose=initialMotion(actor);
 for(let i=0;i<160;i++){
  game.events=[];const before=i/100,after=(i+1)/100;actor.pose.phase=after;
  game.footstep(actor,before);
  assert.equal(game.events.length,(i+1)%50===0?1:0);
 }
 for(const patch of [{moving:0},{grounded:false},{alive:false}]){
  Object.assign(actor,{moving:4.5,grounded:true,alive:true},patch);actor.pose.phase=1;game.events=[];game.footstep(actor,.99);assert.equal(game.events.length,0);
 }
 assert.equal(crossedFootContact(3,.1),false);assert.equal(crossedFootContact(0,5),false);
});
