import test from 'node:test';
import assert from 'node:assert/strict';
import {coverExposure,selectTacticalCover,type TacticalThreat} from '../src/aiCover.ts';
import {ARENA,BOXES,HEIGHTS,blocked,dist,visible,type Vec} from '../src/config.ts';
import {findPath} from '../src/navigation.ts';

const threat=(x:number,z:number,id=1,y=1.65):TacticalThreat=>({id,point:{x,y,z},time:4,confidence:1});
const height=(stance:'stand'|'crouch')=>stance==='stand'?1.91:1.3;
function assertClear(points:readonly {x:number;z:number}[]){
 for(let i=1;i<points.length;i++){
  const a=points[i-1],b=points[i],steps=Math.ceil(dist(a,b)/.04);
  for(let step=0;step<=steps;step++){const t=step/Math.max(1,steps);assert.equal(blocked(a.x+(b.x-a.x)*t,a.z+(b.z-a.z)*t,0,.3),false,'a body must fit along the entire segment');}
 }
}

test('tactical cover protects the body and provides a short collision-clear firing peek',()=>{
 for(const [x,z,tx,tz] of [[-12,-15,-8,-15],[0,0,0,-10],[-10,6,10,6],[12,7,12,-7]]){
  const origin={x,y:0,z},memories=[threat(tx,tz)];
  const cover=selectTacticalCover(origin,memories,{role:0,retreat:false});assert.ok(cover);
  assert.equal(coverExposure(cover.hide,memories,height(cover.stance)),0);
  assert.ok(cover.peek,'an attacking position needs a reachable firing lane');
  assert.ok(dist(cover.hide,cover.peek)<=1.851);
  assert.ok(visible({...cover.peek,y:cover.peek.y+HEIGHTS[cover.stance]},memories[0].point));
  assertClear([origin,...cover.path]);assertClear([cover.hide,cover.peek]);
  assert.ok(dist(cover.path.at(-1)!,cover.hide)<.026,'path ends at the protected point rather than a nearby grid cell');
 }
});

test('a bot already in useful cover can hold it instead of being sent to another crate',()=>{
 const origin={x:-8,y:0,z:2},cover=selectTacticalCover(origin,[threat(0,2)],{role:0,retreat:false});
 assert.ok(cover);assert.deepEqual(cover.hide,origin);assert.deepEqual(cover.path,[]);assert.equal(cover.stance,'crouch');assert.ok(cover.peek);
 assert.equal(coverExposure(origin,[threat(0,2)],1.91),.25,'standing would expose the head');
});

test('cover watches the remembered opponent used for its peek, not a later unrelated cue',()=>{
 const origin={x:-8,y:0,z:2},primary=threat(0,2),secondary={...threat(-8,8,2),time:primary.time+1,confidence:.1};
 const cover=selectTacticalCover(origin,[secondary,primary],{role:0,retreat:false});assert.ok(cover);
 assert.deepEqual(cover.watch,primary.point,'the peek and watch direction share the selected primary threat');
 primary.point.x=12;secondary.point.z=-14;
 assert.deepEqual(cover.watch,{x:0,y:1.65,z:2},'later memories cannot mutate the committed watch snapshot');
});

test('a final fifteen-centimetre move into shelter retains its waypoint',()=>{
 const box=BOXES[0],hide={x:box.x,y:0,z:box.z+box.d/2+.58},origin={...hide,x:hide.x+.15},memories=[threat(0,-15)];
 assert.ok(coverExposure(origin,memories,1.3)>0,'the nearby origin is still exposed');
 const cover=selectTacticalCover(origin,memories,{role:0,retreat:true});assert.ok(cover);
 assert.ok(dist(origin,cover.hide)>.14&&dist(origin,cover.hide)<.16);
 assert.ok(cover.path.length>0,'seek must have a waypoint until the controller can enter hold');
 assert.ok(dist(cover.path.at(-1)!,cover.hide)<.026);assertClear([origin,...cover.path]);
});

test('remembered crossfire makes the planner leave a previously safe firing position',()=>{
 const origin={x:-8,y:0,z:2},primary=threat(0,2),flank=threat(-8,8,2),both=[primary,flank];
 const one=selectTacticalCover(origin,[primary],{role:0,retreat:false});
 const two=selectTacticalCover(origin,both,{role:0,retreat:true});assert.ok(one&&two);
 assert.equal(coverExposure(one.hide,both,height(one.stance)),1);
 assert.equal(coverExposure(two.hide,both,height(two.stance)),0);
 assert.ok(dist(one.hide,two.hide)>2);assertClear([origin,...two.path]);
 assert.deepEqual(selectTacticalCover(origin,both,{role:0,retreat:true}),two,'same observations give the same plan without randomness');
});

test('occupied cover is avoided and a compromised spot can be abandoned',()=>{
 const origin={x:-8,y:0,z:2},memories=[threat(0,2)];
 const occupied=selectTacticalCover(origin,memories,{role:0,retreat:false,occupied:[origin]});
 const compromised=selectTacticalCover(origin,memories,{role:0,retreat:false,avoid:origin});
 assert.ok(occupied&&compromised);assert.ok(dist(origin,occupied.hide)>.75);assert.ok(dist(origin,compromised.hide)>2);
 if(occupied.peek)assert.ok(dist(origin,occupied.peek)>.75);
});

test('a low box hiding the eyes is rejected when the crouched head still protrudes',()=>{
 const box=BOXES[1],origin={x:box.x,y:0,z:box.z+box.d/2+.58},memories=[threat(box.x,-16)];
 assert.equal(visible({...origin,y:HEIGHTS.crouch},memories[0].point),false);
 assert.equal(coverExposure(origin,memories,1.3),.25);
 const cover=selectTacticalCover(origin,memories,{role:0,retreat:false});assert.ok(cover);
 assert.ok(dist(origin,cover.hide)>1);assert.equal(coverExposure(cover.hide,memories,height(cover.stance)),0);
});

test('risk-aware routes avoid a long exposed lane without cutting through crates',()=>{
 const from={x:-13,y:0,z:-15},to={x:-13,y:0,z:15},memories=[threat(-13,15)];
 const risk=(p:{x:number;z:number})=>coverExposure({...p,y:0},memories)*2.5;
 const direct=findPath(from,to),safer=findPath(from,to,risk);
 const exposure=(path:typeof direct)=>{let previous=from,sum=0;for(const point of path){sum+=dist(previous,point)*risk(point);previous={...point,y:0};}return sum;};
 assert.ok(exposure(safer)<exposure(direct)*.5,'a modest detour avoids most of the hostile firing lane');
 assert.ok(safer.length<direct.length*1.3);assertClear([from,...safer]);
 assert.deepEqual(findPath(from,to,()=>0),direct,'the old/default navigation remains unchanged');
});

test('no remembered threat or no physically protected position returns no cover plan',()=>{
 const origin={x:0,y:0,z:0};
 assert.equal(selectTacticalCover(origin,[],{role:0,retreat:true}),null);
 assert.equal(selectTacticalCover(origin,[{...threat(0,5),confidence:0}],{role:0,retreat:true}),null);
 assert.equal(selectTacticalCover(origin,[threat(0,0,1,1000)],{role:0,retreat:true}),null,'overhead exposure cannot be fixed by pretending the first crate is safe');
});

test('embedded noisy cues cannot make the whole arena look protected',()=>{
 const box=BOXES[0],origin={x:-8,y:0,z:2},embedded={...threat(box.x,box.z,2,1.4),confidence:.85},valid=threat(0,2),memories=[embedded,valid],before=structuredClone(memories);
 assert.equal(selectTacticalCover(origin,[embedded],{role:0,retreat:true}),null,'no geometrically valid threat means no invented shelter');
 assert.deepEqual(selectTacticalCover(origin,memories,{role:0,retreat:false}),selectTacticalCover(origin,[valid],{role:0,retreat:false}));
 assert.deepEqual(memories,before,'the caller retains the approximate cue for turning and scanning');
 // This includes the top eight centimetres that movement collision deliberately
 // tolerates: rays still hit this solid material, so a cue there is invalid too.
 assert.equal(selectTacticalCover(origin,[{...embedded,point:{...embedded.point,y:box.h-.04}}],{role:0,retreat:true}),null);
});

test('optimized cover probes agree with physical world visibility across the arena',()=>{
 let seed=17843;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/2**32;};
 function reference(point:Vec,memory:TacticalThreat,top:number){
  const length=dist(point,memory.point)||1,sideX=(memory.point.z-point.z)/length*.28,sideZ=-(memory.point.x-point.x)/length*.28;
  return [
   {x:point.x,y:point.y+top,z:point.z},
   {x:point.x-sideX,y:point.y+top*.76,z:point.z-sideZ},
   {x:point.x+sideX,y:point.y+top*.76,z:point.z+sideZ},
   {x:point.x,y:point.y+top*.4,z:point.z},
  ].filter(probe=>visible(probe,memory.point)).length/4*memory.confidence;
 }
 for(let i=0;i<2000;i++){
  const point={x:(random()-.5)*ARENA.width,y:random()*.5,z:(random()-.5)*ARENA.depth},memory={...threat((random()-.5)*ARENA.width,(random()-.5)*ARENA.depth,1,.4+random()*2),confidence:.5},top=i%2?1.3:1.91;
  assert.equal(coverExposure(point,[memory],top),reference(point,memory,top),`probe ${i}`);
 }
});
