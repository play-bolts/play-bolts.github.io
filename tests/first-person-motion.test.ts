import test from 'node:test';
import assert from 'node:assert/strict';
import {sampleFirstPersonMotion,type FirstPersonMotionState} from '../src/firstPersonMotion.ts';
import {HEIGHTS,RULES} from '../src/config.ts';

const ready:FirstPersonMotionState={moving:0,stance:'stand',eyeHeight:HEIGHTS.stand,ads:0,grounded:true,vy:0,jumpStarted:-Infinity,landedAt:-Infinity,landingSpeed:0};
test('source gait creates bounded weapon inertia and deterministic pause/replay poses',()=>{
 let travel=0;
 for(const stance of ['stand','crouch','prone'] as const)for(let i=0;i<=120;i++){
  const state={...ready,moving:4.8,stance,eyeHeight:HEIGHTS[stance]},time=i/120;
  const pose=sampleFirstPersonMotion(state,time);
  travel=Math.max(travel,Math.hypot(...pose.position));
  assert.ok(pose.position.every(value=>Number.isFinite(value)&&Math.abs(value)<.05));
  assert.ok(pose.rotation.every(value=>Number.isFinite(value)&&Math.abs(value)<.05));
  sampleFirstPersonMotion(state,time+10);
  assert.deepEqual(sampleFirstPersonMotion(state,time),pose);
 }
 assert.ok(travel>.005);
 assert.equal(Math.hypot(...sampleFirstPersonMotion(ready,12).position),0);
});
test('continuous ADS keeps the exact sight axis during stance transitions',()=>{
 for(let i=0;i<=100;i++){
  const eyeHeight=HEIGHTS.stand+(HEIGHTS.prone-HEIGHTS.stand)*i/100;
  const pose=sampleFirstPersonMotion({...ready,moving:4.8,ads:1,eyeHeight},i/60);
  assert.equal(Math.hypot(...pose.position),0);assert.equal(Math.hypot(...pose.rotation),0);
 }
});
test('walking weapon motion crosses its loop without a position or rotation snap',()=>{
 for(const stance of ['stand','crouch','prone'] as const)for(const moving of [1.2,2.4,4.8]){
  const actor={...ready,stance,eyeHeight:HEIGHTS[stance],moving};
  const a=sampleFirstPersonMotion(actor,(1-1e-6)/1.65),b=sampleFirstPersonMotion(actor,(1+1e-6)/1.65);
  for(const key of ['position','rotation'] as const)
   assert.ok(Math.hypot(...a[key].map((value,index)=>value-b[key][index]))<1e-5);
 }
});
test('landing uses the source compression/recovery curve with impact scaling',()=>{
 const state={...ready,landedAt:1,landingSpeed:RULES.jump};
 assert.equal(Math.hypot(...sampleFirstPersonMotion(state,1).position),0);
 assert.ok(sampleFirstPersonMotion(state,1.05).position[1]<-.02);
 assert.equal(Math.hypot(...sampleFirstPersonMotion(state,1.34).position),0);
 const light=sampleFirstPersonMotion({...state,landingSpeed:1},1.05);
 assert.ok(Math.abs(light.position[1])<.006);
 const air=sampleFirstPersonMotion({...ready,grounded:false,jumpStarted:1,vy:6},1.09);
 assert.ok(air.position[1]<0);assert.ok(air.rotation[0]<0);
});
