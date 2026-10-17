import test from 'node:test';
import assert from 'node:assert/strict';
import {Game} from '../src/engine.ts';
import {WEAPONS,BOXES,MAP_SCALE,ARENA,RULES,SPAWNS,blocked,damageFor,rayBox,visible,worldHit} from '../src/config.ts';
import {findPath} from '../src/navigation.ts';
import {sampleHitVolumes,rayHitVolumes} from '../src/hitboxes.ts';
const scaled=(x:number,z:number,y=1.65)=>({x:x*MAP_SCALE,y,z:z*MAP_SCALE});
const idle={forward:0,right:0,jump:false,walk:false,lean:0};
function duel(){const g=new Game();g.start('german','regular');g.seed=42;for(const a of g.actors){a.alive=false;a.deadAt=99999;}const p=g.player,t=g.actors[1];Object.assign(p,{alive:true,...scaled(19,7,0),yaw:0,pitch:-.07,recoil:0,ads:true,spawnSafe:0,cooldown:0,pose:undefined});Object.assign(t,{alive:true,...scaled(19,12,0),yaw:0,pitch:0,spawnSafe:0,cooldown:100,pose:undefined});return{g,p,t};}
test('rays parallel to a slab and inside boxes behave correctly',()=>{const b={min:{x:0,y:0,z:0},max:{x:1,y:1,z:1}};assert.equal(rayBox({x:2,y:.5,z:-1},{x:0,y:0,z:1},b),Infinity);assert.equal(rayBox({x:.5,y:.5,z:-1},{x:0,y:0,z:1},b),1);assert.equal(rayBox({x:.5,y:.5,z:.5},{x:0,y:0,z:1},b),0);});
test('solid cover blocks sight but open lanes remain visible',()=>{assert.equal(visible(scaled(-7,-15),scaled(-7,-3)),false);assert.equal(visible(scaled(19,7),scaled(19,12)),true);});
test('A* navigates around tall and low crates without corner cutting',()=>{const path=findPath(scaled(-19,-21),scaled(19,21));assert.ok(path.length>30);for(const p of path)assert.equal(blocked(p.x,p.z,0,.4),false);for(let i=1;i<path.length;i++){const a=path[i-1],b=path[i];for(let j=0;j<=10;j++)assert.equal(blocked(a.x+(b.x-a.x)*j/10,a.z+(b.z-a.z)*j/10,0,.3),false);}});
test('all rifles keep their faction, capacity and reload conserves ammunition',()=>{for(const faction of ['british','russian','german'] as const){const g=new Game();g.start(faction,'recruit');for(const a of g.actors.slice(1)){a.alive=false;a.deadAt=1000;}const p=g.player,w=WEAPONS[faction];assert.equal(p.ammo,w.capacity);p.ammo=1;p.reserve=7;g.reload();for(let i=0;i<500;i++)g.update(.01,idle);assert.equal(p.ammo,Math.min(w.capacity,8));assert.equal(p.ammo+p.reserve,8);assert.equal(p.reload,0);}});
test('a close torso hit is lethal and produces scoreboard and recorded kill event',context=>{
 let startSeed=0;context.mock.method(Date,'now',()=>startSeed);
 // Spawn selection must not change this fixture's target orientation. Seed 153
 // previously left an arm across the intended torso ray and correctly dealt 72.
 for(startSeed of [0,153,0x7fffffff]){
  const {g,p,t}=duel(),volumes=sampleHitVolumes(t,g.time);g.fire();const shot=g.shots.at(-1)!;
  const direction={x:shot.end.x-shot.origin.x,y:shot.end.y-shot.origin.y,z:shot.end.z-shot.origin.z};
  assert.equal(rayHitVolumes(shot.origin,direction,volumes)?.part,'torso');assert.equal(shot.hit,t.id);assert.equal(shot.headshot,false);
  assert.equal(t.alive,false);assert.equal(p.kills,1);assert.equal(t.deaths,1);assert.equal(p.ammo,4);assert.equal(p.hits,1);assert.equal(g.events.filter(e=>e.type==='kill').length,1);
 }
});
test('cooldown prevents repeated fire; empty clip and no reserve cannot shoot',()=>{const {g,p}=duel();g.fire();g.fire();assert.equal(p.shots,1);p.cooldown=0;p.ammo=0;p.reserve=0;g.fire();assert.equal(p.shots,1);assert.equal(p.reload,0);});
test('cover intercepts a bullet before the target',()=>{const {g,p,t}=duel();Object.assign(p,{...scaled(-7,-15,0),pitch:0});Object.assign(t,{...scaled(-7,-3,0)});g.fire();assert.equal(t.hp,100);assert.equal(p.hits,0);});
test('spawn protection prevents hits and firing removes it',()=>{const {g,p,t}=duel();t.spawnSafe=1;p.spawnSafe=1;g.fire();assert.equal(t.hp,100);assert.equal(p.spawnSafe,0);});
test('limb damage differs from head and torso; health does not regenerate',()=>{assert.equal(damageFor('limb',5),72);assert.equal(damageFor('head',5),180);assert.equal(damageFor('torso',5),108);const {g,p,t}=duel();t.alive=false;p.hp=45;for(let i=0;i<100;i++)g.update(.01,idle);assert.equal(p.hp,45);});
test('player cannot walk through crate; can land on a low crate',()=>{const {g,p}=duel();const b=BOXES[1];Object.assign(p,{x:b.x,z:b.z-b.d/2-1,y:0,yaw:0});for(let i=0;i<100;i++)g.move(p,0,1,.02);assert.ok(p.z<=b.z-b.d/2-.29);Object.assign(p,{x:b.x,z:b.z,y:b.h+.6,vy:-2,grounded:false});for(let i=0;i<30;i++)g.move(p,0,0,.02);assert.equal(p.y,b.h);assert.equal(p.grounded,true);});
test('player and bot movement cannot pass through each other, while corpses do not block',()=>{
 const {g,p,t}=duel();Object.assign(p,{x:ARENA.width/2-1,z:0,ads:false});Object.assign(t,{x:p.x,z:2,ads:false});
 for(let i=0;i<120;i++){g.move(p,0,1,1/60);g.move(t,0,-1,1/60);assert.ok(t.z-p.z>=RULES.radius*2-1e-7);}
 assert.ok(p.z<t.z);const before=t.z;t.alive=false;g.move(p,0,1,.5);assert.ok(p.z>before+.6);
});
test('respawning actors choose a free spawn despite an occupied preferred point',()=>{
 const {g,p,t}=duel();Object.assign(t,{...SPAWNS[0],y:0,alive:true});
 for(let i=0;i<30;i++){g.spawn(p);assert.ok(Math.hypot(p.x-t.x,p.z-t.z)>=RULES.radius*2);}
});
test('prone crawling cannot fire and aim slows movement',()=>{const {g,p}=duel();p.stance='prone';p.moving=1;g.fire();assert.equal(p.shots,0);p.stance='stand';p.ads=false;const z=p.z;g.move(p,0,1,.1);const fast=p.z-z;p.z=z;p.ads=true;g.move(p,0,1,.1);assert.ok(p.z-z<fast*.7);});
test('killcam stores immutable history, advances and respawns',()=>{const {g,p,t}=duel();g.record();g.time=1;g.record();g.damage(p,t,100);assert.equal(g.state,'killcam');const x=g.replay[0].actors[1].x;t.x=1;assert.equal(g.replay[0].actors[1].x,x);for(let i=0;i<300;i++)g.update(.02,idle);assert.equal(g.state,'playing');assert.equal(p.alive,true);assert.equal(p.hp,100);assert.equal(p.deaths,1);});
test('kills do not end a round; the timer still ends it and pausing freezes it',()=>{
 const {g,p,t}=duel();
 for(const score of [19,49,99]){p.kills=score;t.alive=true;t.hp=100;g.damage(t,p,100);assert.equal(p.kills,score+1);assert.equal(g.state,'playing');}
 assert.equal(g.events.some(e=>e.type==='end'),false);
 g.state='paused';g.update(1,idle);assert.equal(g.time,0);assert.equal(g.remaining,RULES.roundSeconds);
 g.state='playing';g.time=RULES.roundSeconds-.05;g.update(.02,idle);assert.equal(g.state,'playing');assert.ok(g.remaining>0);
 g.update(.04,idle);assert.equal(g.state,'ended');assert.equal(g.remaining,0);assert.equal(g.winner?.id,p.id);assert.equal(g.events.filter(e=>e.type==='end').length,1);
 g.update(1,idle);assert.equal(g.events.filter(e=>e.type==='end').length,1,'finished rounds cannot end twice');
});

test('round timeout stops live movement and weapon actions without altering scores, ammunition or corpses',()=>{
 const g=new Game();g.start('british','regular');g.time=RULES.roundSeconds-.01;
 for(const a of g.actors){
  Object.assign(a,{moving:3,vy:2,ads:true,lean:.8,recoil:.05,cooldown:.7,reload:1,reloadTotal:3,lastShotTime:g.time-.05,lastMeleeTime:g.time-.1,lastHurtTime:g.time-.1,selectedWeapon:'grenade',switchFrom:'rifle',switchStarted:g.time-.2,ammo:2,reserve:37,kills:a.id,deaths:1});
  a.ai.path=[{x:0,z:0}];a.ai.mode='flank';a.ai.sight=true;a.ai.target=0;
 }
 const corpse=g.actors.at(-1)!;Object.assign(corpse,{alive:false,deadAt:g.time-.4,deathYaw:.7,deathHeadshot:true});
 const deadState=structuredClone(corpse);
 const preserved=g.actors.map(({x,y,z,yaw,pitch,stance,hp,ammo,reserve,kills,deaths,selectedWeapon})=>({x,y,z,yaw,pitch,stance,hp,ammo,reserve,kills,deaths,selectedWeapon}));
 const held={forward:1,right:1,jump:true,walk:false,lean:1};g.stepClock=.3;
 g.update(.02,held);assert.equal(g.state,'ended');assert.equal(g.remaining,0);
 assert.equal(g.winner,corpse,'final ranking is preserved even when its winner is dead');
 assert.deepEqual(g.actors.map(({x,y,z,yaw,pitch,stance,hp,ammo,reserve,kills,deaths,selectedWeapon})=>({x,y,z,yaw,pitch,stance,hp,ammo,reserve,kills,deaths,selectedWeapon})),preserved);
 assert.deepEqual(corpse,deadState,'death pose timing and state are untouched');
 for(const a of g.actors.filter(a=>a.alive)){
  for(const key of ['moving','vy','lean','recoil','cooldown','reload','reloadTotal'] as const)assert.equal(a[key],0,key);
  for(const key of ['lastShotTime','lastMeleeTime','lastHurtTime','switchStarted'] as const)assert.equal(a[key],-Infinity,key);
  assert.equal(a.ads,false);assert.equal(g.isSwitching(a),false);assert.equal(a.switchFrom,a.selectedWeapon);
  assert.deepEqual(a.ai.path,[]);assert.equal(a.ai.mode,'idle');assert.equal(a.ai.sight,false);assert.equal(a.ai.target,null);
 }
 assert.equal(g.stepClock,0);
 const endedActors=structuredClone(g.actors),time=g.time;
 g.update(1,held);g.move(g.player,1,1,.1,true);g.setStance('crouch');g.fire();g.fire(g.player,true);g.reload();g.selectWeapon('rifle');g.finish();
 assert.deepEqual(g.actors,endedActors,'held input and public action APIs cannot restart movement');
 assert.equal(g.time,time);assert.equal(g.events.filter(e=>e.type==='end').length,1,'ending is idempotent');
});
test('right strafe and right lean use camera-right at each cardinal yaw',()=>{for(const yaw of [0,Math.PI/2,Math.PI,Math.PI*1.5]){const {g,p,t}=duel();t.alive=false;Object.assign(p,{...scaled(0,7,0),yaw,ads:false});const before={x:p.x,z:p.z};g.update(.1,{...idle,right:1,lean:1});assert.ok((p.x-before.x)*-Math.cos(yaw)+(p.z-before.z)*Math.sin(yaw)>0);const eye=g.eye(p);assert.ok((eye.x-p.x)*-Math.cos(yaw)+(eye.z-p.z)*Math.sin(yaw)>0);}});
test('out-of-ammunition bots do not conjure extra rounds',()=>{const {g,t}=duel();t.ammo=0;t.reserve=0;g.update(.1,idle);assert.equal(t.reserve,0);assert.equal(t.ammo,0);});
test('each AI difficulty fights and navigates without entering cover',()=>{for(const difficulty of ['recruit','regular','veteran'] as const){const g=new Game();g.start('british',difficulty);g.seed=42;g.player.alive=false;g.player.deadAt=99999;for(let i=0;i<2400;i++)g.update(1/60,idle);assert.ok(g.actors.some(a=>a.id>0&&a.shots>0),difficulty+' should fire');for(const a of g.actors.filter(a=>a.alive))assert.equal(blocked(a.x,a.z,a.y,.28),false,`${difficulty} ${a.name} in cover`);}});

test('arena has exactly half the original floor area and all spawn points remain clear',()=>{assert.ok(Math.abs(ARENA.width*ARENA.depth-42*48*.5)<1e-8);for(const p of SPAWNS)assert.equal(blocked(p.x,p.z),false);});
test('full lean translates sideways by 130 percent without changing eye height or aim',()=>{
 const {g,p,t}=duel();t.alive=false;Object.assign(p,{...scaled(0,7,0),yaw:0,lean:0});const eye=g.eye(p),pitch=p.pitch;
 for(const lean of [-1,1]){p.lean=lean;g.update(.01,{...idle,lean});const moved=g.eye(p);assert.ok(Math.abs(moved.x-eye.x+lean*.416)<1e-8);assert.equal(moved.y,eye.y);assert.equal(moved.z,eye.z);assert.equal(p.yaw,0);assert.equal(p.pitch,pitch);}
 assert.equal(RULES.leanDistance,.32*1.3);
});
test('crouched lean cannot enter a low crate or produce a zero-length shot',()=>{
 const b=BOXES.find(b=>b.h===1.1)!;
 for(const lean of [-1,1]){
  const {g,p,t}=duel();t.alive=false;Object.assign(p,{x:b.x+lean*(b.w/2+.31),z:b.z,y:0,yaw:0,pitch:0,stance:'crouch',lean:0});
  for(let i=0;i<120;i++){g.update(1/60,{...idle,lean});assert.ok(worldHit(g.eye(p),{x:0,y:0,z:1})>0,'leaning eye must remain outside cover');}
  assert.ok(Math.abs(p.lean)<.65);g.fire();const shot=g.shots.at(-1)!;assert.ok(Math.hypot(shot.end.x-shot.origin.x,shot.end.y-shot.origin.y,shot.end.z-shot.origin.z)>.1);
  p.stance='stand';for(let i=0;i<120;i++)g.update(1/60,{...idle,lean});assert.ok(Math.abs(p.lean)>.99,'standing eye can lean above the low crate');
 }
});
