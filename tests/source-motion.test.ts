import test from 'node:test';
import assert from 'node:assert/strict';
import {SOURCE_CLIPS,SOURCE_JOINTS} from '../src/generated/mesh2motionData.ts';
import {sampleSourceMotion,sampleLoopedSourceMotion,type MotionClip} from '../src/humanoidMotion.ts';
import {sampleBodyMotion,sourceGaitRate} from '../src/soldierMotion.ts';

test('baked source clips retain hierarchy-space anatomy and clamped animated endpoints',()=>{
 for(const [name,clip] of Object.entries(SOURCE_CLIPS)){
  assert.ok(clip.duration>0&&clip.frames.length>20);
  for(const frame of clip.frames){assert.equal(frame.length,SOURCE_JOINTS.length*3);frame.forEach(v=>assert.ok(Number.isFinite(v)));}
  const start=sampleSourceMotion(name as MotionClip,0),end=sampleSourceMotion(name as MotionClip,1);
  assert.ok(start.leftHip[0]<start.rightHip[0],'named limbs use target-side coordinates');
  for(const frame of [start,end]){
   for(const side of ['left','right'] as const){
    const distance=Math.hypot(...frame[`${side}Elbow`].map((v,i)=>v-frame[`${side}Wrist`][i]));
    assert.ok(distance>.25&&distance<.31,'source ancestor transforms preserve forearm length');
   }
  }
 }
 const reload=sampleSourceMotion('Pistol_Reload',1);
 assert.ok(reload.leftWrist[1]>1.1&&reload.leftWrist[2]>.2,'reload endpoint stays animated instead of returning to a T-pose');
});

test('looped locomotion closes source export seams in position and velocity',()=>{
 const epsilon=1e-6;
 for(const clip of ['Idle_Subtle','Walk','Jog','Sprint','Walk_Backwards','Strafe_left','Strafe_right','Crouch_Idle','Crouch_Walk','Crawl'] as MotionClip[]){
  const before=sampleLoopedSourceMotion(clip,1-epsilon),at=sampleLoopedSourceMotion(clip,0),after=sampleLoopedSourceMotion(clip,epsilon);
  assert.deepEqual(sampleLoopedSourceMotion(clip,1),at);
  for(const joint of SOURCE_JOINTS)for(let axis=0;axis<3;axis++){
   assert.ok(Math.abs(after[joint][axis]-before[joint][axis])<.00005,`${clip}/${joint}: no wrapped position jump`);
   const incoming=(at[joint][axis]-before[joint][axis])/epsilon,outgoing=(after[joint][axis]-at[joint][axis])/epsilon;
   assert.ok(Math.abs(incoming-outgoing)<.005,`${clip}/${joint}: no wrapped velocity jump`);
  }
 }
});

test('rifle locomotion uses a two-step cadence and a steady upright torso',()=>{
 assert.ok(sourceGaitRate(1.6,0,0)>1.1&&sourceGaitRate(1.6,0,0)<1.3,'short target legs need a shorter, quicker walking stride');
 for(const speed of [2.8,3.1,4.5,4.86]){
  assert.ok(sourceGaitRate(speed,0,0)*2<=3.5,'a complete source loop contains two footfalls');
  const poses=Array.from({length:180},(_,i)=>sampleBodyMotion({speed,crouch:0,prone:0,phase:i/180,time:2,forward:1,sideways:0,grounded:true}));
  const heights=poses.map(pose=>pose.pelvis[1]);
  assert.ok(Math.max(...heights)-Math.min(...heights)<.075,'hips do not bound up and down through the running cycle');
  for(const pose of poses)assert.ok(pose.spineRotation[0]<16*Math.PI/180,'carrying a rifle does not use the source sprinter chest lean');
 }
 assert.ok(sourceGaitRate(2.8,1,0)<1.65,'crouch walk cannot become a rapid shuffle');
 assert.equal(sourceGaitRate(0,0,0),0);
});

const input={speed:2,crouch:0,prone:0,phase:.35,time:2,forward:1,sideways:0,grounded:true,jumpStarted:-Infinity,landedAt:-Infinity};
test('walk-offs, jumps, landings and stance blends remain finite and continuous',()=>{
 for(const grounded of [true,false])for(const jumpStarted of [-Infinity,1.8])for(let i=0;i<=100;i++){
  const pose=sampleBodyMotion({...input,grounded,jumpStarted,crouch:i/100,prone:0,landedAt:grounded?1.9:-Infinity,landingSpeed:7.3});
  for(const value of Object.values(pose))if(Array.isArray(value))value.forEach(v=>assert.ok(Number.isFinite(v)));
 }
 for(const stance of ['crouch','prone'] as const){
  const before=sampleBodyMotion({...input,[stance]:.5-1e-6}),after=sampleBodyMotion({...input,[stance]:.5+1e-6});
  for(const key of ['pelvis','leftFoot','rightFoot'] as const)assert.ok(Math.hypot(...before[key].map((v,i)=>v-after[key][i]))<.0001,'no reference-pose switch at half crouch/prone');
 }
});

test('source body motion distinguishes gait, air tuck and impact while preserving absolute sampling',()=>{
 const idle=sampleBodyMotion({...input,speed:0}),walk=sampleBodyMotion(input),air=sampleBodyMotion({...input,grounded:false,jumpStarted:1.7});
 assert.notDeepEqual(walk.leftFoot,idle.leftFoot);
 assert.ok(Math.max(air.leftFoot[1],air.rightFoot[1])>Math.max(walk.leftFoot[1],walk.rightFoot[1])+.1,'air pose tucks a knee');
 const heavy=sampleBodyMotion({...input,speed:0,landedAt:1.92,landingSpeed:7.3}),light=sampleBodyMotion({...input,speed:0,landedAt:1.92,landingSpeed:.5});
 assert.ok(heavy.pelvis[1]<light.pelvis[1]-.04,'small ledge contacts do not play a heavy landing crouch');
 assert.deepEqual(sampleBodyMotion(input),walk,'sampling later actions cannot alter earlier motion');
});
