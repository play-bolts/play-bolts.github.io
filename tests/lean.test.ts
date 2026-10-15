import assert from 'node:assert/strict';
import test from 'node:test';
import {ARENA,RULES,type Box} from '../src/config';
import {advanceLean,constrainLean,leanEye,LEAN_CAMERA_RADIUS,type LeanActor} from '../src/lean';

const actor=(overrides:Partial<LeanActor>={}):LeanActor=>({x:0,y:0,z:0,yaw:0,eyeHeight:1.65,lean:0,...overrides});
const close=(actual:number,expected:number)=>assert.ok(Math.abs(actual-expected)<1e-9,`${actual} != ${expected}`);

test('lean stops continuously at all domain walls and corners with camera clearance',()=>{
 for(const sign of [-1,1])for(const axis of ['x','z'] as const){
  const extent=axis==='x'?ARENA.width/2:ARENA.depth/2;
  const a=actor({[axis]:sign*(extent-.31),yaw:axis==='x'?(sign<0?0:Math.PI):(sign<0?-Math.PI/2:Math.PI/2)});
  const value=constrainLean(a,1,[]);close(value,(.31-LEAN_CAMERA_RADIUS-.001)/RULES.leanDistance);
  const eye=leanEye(a,value,[]);assert.ok(Math.abs(eye[axis])<=extent-LEAN_CAMERA_RADIUS-.00099);
 }
 const a=actor({x:-ARENA.width/2+.31,z:-ARENA.depth/2+.31,yaw:-Math.PI/4});
 close(constrainLean(a,1,[]),(.31-LEAN_CAMERA_RADIUS-.001/Math.SQRT2)/(RULES.leanDistance/Math.SQRT2));
 const eye=leanEye(a,1,[]);assert.ok(eye.x>-ARENA.width/2+LEAN_CAMERA_RADIUS&&eye.z>-ARENA.depth/2+LEAN_CAMERA_RADIUS);
});

test('held lean against cover converges without resetting or oscillating',()=>{
 const a=actor({x:-ARENA.width/2+.31});let previous=0;
 for(let i=0;i<240;i++){
  a.lean=advanceLean(a,1,1/60,[]);assert.ok(a.lean>=previous-1e-10);previous=a.lean;
 }
 const held=a.lean;assert.ok(held>.3&&held<.4);
 for(let i=0;i<60;i++){a.lean=advanceLean(a,1,1/60,[]);close(a.lean,held);}
 a.lean=advanceLean(a,0,1/60,[]);assert.ok(a.lean>0&&a.lean<held);
});

test('sweep blocks a thin obstacle even when the requested endpoint is beyond it',()=>{
 const thin:Box={x:-.21,z:0,w:.02,d:1,h:2,kind:'crate'};
 const a=actor();close(constrainLean(a,1,[thin]),(.21-.01-LEAN_CAMERA_RADIUS-.001)/RULES.leanDistance);
 assert.equal(constrainLean(a,-1,[thin]),-1,'lean away remains available');
});

test('stance transitions include clearance above crate tops and never use target stance height',()=>{
 const crate:Box={x:-.5,z:0,w:.4,d:1,h:1.2,kind:'crate'};
 const a=actor();assert.equal(constrainLean(a,1,[crate]),1,'standing clears the low crate');
 a.eyeHeight=crate.h+LEAN_CAMERA_RADIUS-.001;
 const partial=constrainLean(a,1,[crate]);assert.ok(partial>0&&partial<.4);
 for(const height of [1.05,.43]){a.eyeHeight=height;close(constrainLean(a,1,[crate]),partial);}
 a.y=1.2;a.eyeHeight=.43;assert.equal(constrainLean(a,1,[crate]),1,'standing on cover uses world eye height');
});

test('rendered and followed eyes recheck stale interpolated lean without modifying view angles',()=>{
 const a=actor({x:-ARENA.width/2+.31,lean:1,yaw:0});const before={...a};
 const eye=leanEye(a,undefined,[]);assert.ok(eye.x>-ARENA.width/2+LEAN_CAMERA_RADIUS);
 close(eye.y,a.y+a.eyeHeight);close(eye.z,a.z);assert.deepEqual(a,before);
 a.yaw=Math.PI;close(leanEye(a,undefined,[]).x,a.x+RULES.leanDistance);
});

test('actual arena boxes preserve camera clearance for every wall-facing yaw',()=>{
 for(const x of [-ARENA.width/2+.31,ARENA.width/2-.31])for(const z of [-ARENA.depth/2+.31,0,ARENA.depth/2-.31]){
  for(let i=0;i<72;i++)for(const lean of [-1,1]){
   const eye=leanEye(actor({x,z,yaw:i*Math.PI/36,lean}));
   assert.ok(Math.abs(eye.x)<ARENA.width/2-LEAN_CAMERA_RADIUS);
   assert.ok(Math.abs(eye.z)<ARENA.depth/2-LEAN_CAMERA_RADIUS);
  }
 }
});
