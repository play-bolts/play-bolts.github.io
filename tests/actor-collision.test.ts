import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveActorMovement,type CollisionActor} from '../src/actorCollision.ts';
import {HEIGHTS,RULES} from '../src/config.ts';

const actor=(id:number,x:number,z:number,patch:Partial<CollisionActor>={}):CollisionActor=>({id,x,y:0,z,alive:true,stance:'stand',...patch});
const noWorld={blocked:()=>false};
const gap=(a:{x:number;z:number},b:{x:number;z:number})=>Math.hypot(a.x-b.x,a.z-b.z);

test('living actors stop a long swept move without tunneling or pushing the obstacle',()=>{
  const mover=actor(0,-3,0),other=actor(1,0,0),original={...other};
  const result=resolveActorMovement(mover,[mover,other],12,0,noWorld);
  assert.ok(result.collided);assert.ok(Math.abs(result.x+RULES.radius*2)<.0001);
  assert.ok(gap(result,other)>=RULES.radius*2);assert.deepEqual(other,original);assert.equal(mover.x,-3);
  assert.ok(Math.abs(result.distance-(3-RULES.radius*2))<.0001);
});

test('dead actors and the moving actor itself never obstruct movement',()=>{
  const mover=actor(0,-2,0),corpse=actor(1,0,0,{alive:false});
  const result=resolveActorMovement(mover,[mover,corpse],4,0,noWorld);
  assert.ok(Math.abs(result.x-2)<1e-8);assert.equal(result.collided,false);
});

test('vertical body intervals permit jumping over actors and respect gradual stance height',()=>{
  const other=actor(1,0,0),height=HEIGHTS.stand+.18;
  const airborne=actor(0,-2,0,{y:height+.01});
  assert.ok(resolveActorMovement(airborne,[airborne,other],4,0,noWorld).x>1.9);
  airborne.y=height-.01;
  assert.ok(resolveActorMovement(airborne,[airborne,other],4,0,noWorld).x<-.59);
  const prone=actor(1,0,0,{stance:'prone',eyeHeight:.58}),jumper=actor(0,-2,0,{y:.9});
  assert.ok(resolveActorMovement(jumper,[jumper,prone],4,0,{...noWorld,height:a=>(a.eyeHeight??HEIGHTS.stand)+.18}).x>1.9);
  prone.eyeHeight=1.05; // The stance label alone cannot shorten a rising body.
  assert.ok(resolveActorMovement(jumper,[jumper,prone],4,0,{...noWorld,height:a=>(a.eyeHeight??HEIGHTS.stand)+.18}).x<-.59);
});

test('glancing contact slides around a cylinder and preserves tangential progress',()=>{
  const mover=actor(0,-2,.44),other=actor(1,0,0);
  const result=resolveActorMovement(mover,[mover,other],4,0,noWorld);
  assert.ok(result.collided);assert.ok(result.x>1.6,'glancing movement should continue past the opponent');
  assert.ok(result.z>=RULES.radius*2);assert.ok(gap(result,other)>=RULES.radius*2);
  assert.ok(result.distance>3.7&&result.distance<=4);
});

test('actor sliding remains outside walls, and unobstructed wall tangents still move',()=>{
  const wall=(x:number,z:number,_y:number,r:number)=>z>.7-r;
  const mover=actor(0,-1,.35),other=actor(1,0,0);
  const result=resolveActorMovement(mover,[mover,other],2,0,{blocked:wall});
  assert.ok(result.collided);assert.equal(wall(result.x,result.z,0,RULES.radius),false);
  assert.ok(gap(result,other)>=RULES.radius*2-1e-7);
  assert.ok(result.x<0,'the mover cannot squeeze into a gap narrower than its diameter');
  const clear=actor(0,-2,0),slide=resolveActorMovement(clear,[clear],2,2,{blocked:wall});
  assert.ok(slide.x>-.01);assert.ok(slide.z<=.4&&slide.z>.399);
});

test('initial overlaps separate safely, including coincident actors and a nearby wall',()=>{
  const other=actor(1,0,0),mover=actor(0,-.2,0),wall=(x:number)=>x<-.4;
  const result=resolveActorMovement(mover,[mover,other],0,0,{blocked:wall});
  assert.ok(result.collided);assert.equal(wall(result.x),false);assert.ok(gap(result,other)>=RULES.radius*2);
  assert.equal(result.distance,0,'spawn correction must not count as walking');assert.deepEqual([other.x,other.z],[0,0]);
  const coincident=actor(0,0,0),resolved=resolveActorMovement(coincident,[other,coincident],0,0,noWorld);
  assert.ok(gap(resolved,other)>=RULES.radius*2);assert.ok(Number.isFinite(resolved.x)&&Number.isFinite(resolved.z));
  assert.deepEqual(resolved,resolveActorMovement(coincident,[coincident,other],0,0,noWorld),'actor order cannot change recovery');
});

test('opposing moving actors cannot exchange sides across consecutive simulation moves',()=>{
  const left=actor(0,-1,0),right=actor(1,1,0);
  for(let i=0;i<20;i++) {
    Object.assign(left,resolveActorMovement(left,[left,right],.24,0,noWorld));
    Object.assign(right,resolveActorMovement(right,[left,right],-.24,0,noWorld));
    assert.ok(left.x<right.x);assert.ok(gap(left,right)>=RULES.radius*2-1e-7);
  }
});
