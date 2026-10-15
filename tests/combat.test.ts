import test from 'node:test';
import assert from 'node:assert/strict';
import {Game} from '../src/engine.ts';
import {ARENA,GRENADE,HEIGHTS,MELEE_SECONDS,WEAPON_SWITCH_SECONDS,WEAPONS,damageFor,type DamagePart} from '../src/config.ts';

const idle={forward:0,right:0,jump:false,walk:false,lean:0};
function solo(){
 const game=new Game();game.start('british','regular');
 for(const a of game.actors.slice(1)){a.alive=false;a.deadAt=Infinity;}
 Object.assign(game.player,{x:ARENA.width/2-1.2,y:0,z:-6,yaw:0,pitch:0,cooldown:0,spawnSafe:0});return game;
}
function advance(game:Game,seconds:number){for(let remaining=seconds;remaining>1e-9;){const dt=Math.min(remaining,1/120);game.update(dt,idle);remaining-=dt;}}

test('melee recovers twenty percent faster without allowing an early second attack',()=>{
 assert.ok(Math.abs(MELEE_SECONDS*1.2-.85)<1e-12);
 for(const faction of ['british','russian','german'] as const){
  const g=solo(),p=g.player;p.faction=faction;const ammo=p.ammo;
  g.fire(p,true);assert.equal(p.cooldown,MELEE_SECONDS);assert.equal(g.shots.length,1);assert.equal(g.shots[0].kind,'melee');
  advance(g,MELEE_SECONDS-.001);g.fire(p,true);assert.equal(g.shots.length,1,'recovery still gates the next strike');
  advance(g,.002);g.fire(p,true);assert.equal(g.shots.length,2);assert.ok(Math.abs(p.lastMeleeTime-(MELEE_SECONDS+.001))<1e-10);
  assert.equal(p.ammo,ammo);assert.equal(p.shots,0,'melee does not consume rifle ammunition');
 }
});

test('weapon APIs cannot fire, melee, reload or switch outside active play',()=>{
 for(const state of ['menu','paused','killcam','ended'] as const){
  const g=solo(),p=g.player;p.ammo=3;p.ads=true;g.state=state;
  const rifle=structuredClone(p),events=g.events.length;
  g.fire();g.fire(p,true);g.reload();assert.equal(g.selectWeapon('grenade'),false);
  assert.deepEqual(p,rifle,`${state} must preserve rifle state`);assert.equal(g.events.length,events);assert.equal(g.shots.length,0);
  p.selectedWeapon='grenade';const grenade=structuredClone(p);
  g.fire();g.fire(p,true);g.reload();
  assert.deepEqual(p,grenade,`${state} must preserve grenade state`);assert.equal(g.events.length,events);
 }
});

test('switching lowers ADS, blocks attacks, preserves the bolt cooldown and safely cancels reload',()=>{
 const g=solo(),p=g.player;p.ammo=3;p.reserve=17;p.ads=true;p.cooldown=.9;g.reload();
 assert.ok(p.reload>0);assert.equal(g.selectWeapon('grenade'),true);
 assert.equal(p.switchFrom,'rifle');assert.equal(p.switchStarted,g.time);assert.equal(p.switchDuration,WEAPON_SWITCH_SECONDS);
 assert.equal(p.ads,false);assert.equal(p.reload,0);assert.equal(p.cooldown,.9);
 assert.equal(g.selectWeapon('rifle'),false,'rapid cycling cannot reset an in-progress switch');
 g.fire();g.fire(p,true);g.reload();assert.equal(p.shots,0);assert.equal(p.reload,0);
 advance(g,.61);assert.equal(p.ammo,3);assert.equal(p.reserve,17);assert.ok(p.cooldown>.28&&p.cooldown<.3);
 assert.equal(g.selectWeapon('rifle'),true);assert.equal(g.canADS(),false);advance(g,.61);
 assert.equal(g.canADS(),true);g.reload();advance(g,WEAPONS.british.reload+.01);
 assert.equal(p.ammo,10);assert.equal(p.reserve,10,'cancelled reload transfers no ammunition');
});

test('selected grenade grants exactly eight percent more movement after the switch',()=>{
 const g=solo(),p=g.player,z=p.z;g.move(p,0,1,.1);const rifle=p.z-z;p.z=z;
 g.selectWeapon('grenade');g.move(p,0,1,.1);assert.ok(Math.abs(p.z-z-rifle)<1e-12,'holstering still uses rifle speed');p.z=z;
 advance(g,.61);g.move(p,0,1,.1);assert.ok(Math.abs((p.z-z)/rifle-GRENADE.speedMultiplier)<1e-12);
});

test('grenade primary fire and melee bash for half rifle damage without throwing or using ammunition',()=>{
 for(const faction of ['british','russian','german'] as const){
  const g=solo(),p=g.player,target=g.actors[1];p.faction=faction;p.ammo=3;p.reserve=17;
  Object.assign(target,{alive:true,x:p.x,y:0,z:p.z+1.2,spawnSafe:0});g.updateAI=()=>{};
  g.selectWeapon('grenade');advance(g,.61);g.events=[];
  g.fire();assert.equal(target.hp,25);assert.equal(target.alive,true);assert.equal(p.cooldown,MELEE_SECONDS);
  assert.equal(p.lastMeleeTime,g.time);assert.equal(p.lastShotTime,-Infinity);assert.equal(p.recoil,0);
  assert.equal(g.shots.length,1);assert.equal(g.shots[0].kind,'melee');assert.equal(g.shots[0].headshot,false,'a head-height bash still deals only 75 damage');
  for(let attempt=0;attempt<20;attempt++){g.fire();g.fire(p,true);g.reload();}
  assert.equal(g.shots.length,1,'both controls share recovery');assert.equal(target.hp,25);assert.equal(g.canADS(),false);
  advance(g,MELEE_SECONDS-.001);g.fire(p,true);assert.equal(g.shots.length,1);
  advance(g,.002);g.fire(p,true);assert.equal(target.hp,0);assert.equal(target.alive,false);assert.equal(p.kills,1);
  assert.deepEqual(g.events.filter(event=>event.type==='hurt').map(event=>event.value),[75,75]);
  assert.equal(g.events.find(event=>event.type==='kill')?.weapon,'melee');assert.equal(target.deathHeadshot,false);
  advance(g,8);assert.equal(p.selectedWeapon,'grenade','carrying the grenade never automatically returns to rifle');
  assert.equal(p.ammo,3);assert.equal(p.reserve,17);assert.equal(p.reload,0);assert.equal(p.shots,0);assert.equal(p.hits,0);
  for(let cycle=0;cycle<5;cycle++){
   assert.equal(g.selectWeapon('rifle'),true);advance(g,.61);
   assert.equal(g.selectWeapon('grenade'),true);advance(g,.61);
  }
  assert.equal(p.selectedWeapon,'grenade','the movement item is always available');assert.equal(p.ammo,3);assert.equal(p.reserve,17);
 }
});

test('grenade bash keeps rifle melee reach and cannot bypass switching or empty-ammo rules',()=>{
 const g=solo(),p=g.player,target=g.actors[1];g.updateAI=()=>{};p.ammo=p.reserve=0;
 Object.assign(target,{alive:true,x:p.x,y:0,z:p.z+1.2,spawnSafe:0,hp:300});
 g.fire(p,true);assert.equal(target.hp,150,'rifle melee remains 150 damage even with no ammo');
 p.cooldown=0;g.selectWeapon('grenade');g.fire();g.fire(p,true);assert.equal(target.hp,150,'switch animation blocks either attack control');
 advance(g,.61);target.z=p.z+2.1;g.fire();assert.equal(target.hp,150,'the grenade cannot reach past the 1.85 m melee ray');
 assert.equal(g.shots.at(-1)?.kind,'melee');assert.equal(g.shots.at(-1)?.hit,null);
 advance(g,MELEE_SECONDS+.001);target.z=p.z+1.2;g.fire();assert.equal(target.hp,75,'grenade bash does not require rifle ammo');
 assert.equal(p.ammo,0);assert.equal(p.reserve,0);assert.equal(p.reload,0);
});

test('all rifles use classic region damage and actual head hits always kill',()=>{
 const expected:Record<DamagePart,number>={head:180,torso:108,lowerTorso:96,limb:72,lowerLimb:60,extremity:48};
 for(const [part,value] of Object.entries(expected))for(const distance of [1,30,100])assert.equal(damageFor(part as DamagePart,distance),value);
 for(const faction of ['british','russian','german'] as const){
  const g=solo(),p=g.player,t=g.actors[1];p.faction=faction;p.ads=true;
  Object.assign(t,{alive:true,x:p.x,y:0,z:p.z+4,spawnSafe:0,hp:100});g.fire();
  assert.equal(t.alive,false);assert.equal(g.shots.at(-1)?.headshot,true);assert.equal(t.deathHeadshot,true);
 }
 const g=solo(),p=g.player,t=g.actors[1];Object.assign(t,{alive:true,x:p.x,y:0,z:p.z+4,spawnSafe:0});
 p.ads=true;p.pitch=Math.atan2(HEIGHTS.stand*.52-HEIGHTS.stand,4);g.fire();assert.equal(t.hp,4,'an abdomen hit is survivable');
});

test('jumping and falling cancel ADS for players and bots, including the actual bullet ray',()=>{
 const g=solo(),p=g.player;p.ads=true;g.update(1/120,{...idle,jump:true});assert.equal(p.grounded,false);assert.equal(p.ads,false);assert.equal(g.canADS(),false);
 p.ads=true;g.fire();assert.equal(p.ads,false,'direct fire cannot bypass airborne accuracy');assert.equal(p.shots,1);
 for(const actor of [p,g.actors[1]]){
  Object.assign(actor,{alive:true,grounded:false,y:2,vy:-1,ads:true,selectedWeapon:'rifle'});g.move(actor,0,0,1/120);
  assert.equal(actor.ads,false);assert.equal(g.canADS(actor),false);
 }
});

test('slot switching and directional death remain immutable in killcam snapshots',()=>{
 const g=solo(),p=g.player,killer=g.actors[1];
 g.selectWeapon('grenade');advance(g,.2);g.record();
 const recorded=g.history.at(-1)!,switchTime=p.switchStarted;
 assert.equal(recorded.actors[0].selectedWeapon,'grenade');assert.equal(recorded.actors[0].switchFrom,'rifle');assert.equal(recorded.actors[0].switchStarted,switchTime);
 Object.assign(killer,{x:p.x-1,z:p.z});g.damage(p,killer,100,true);
 const death=g.replay.at(-1)!.actors[0];assert.equal(death.deathYaw,Math.PI/2);assert.equal(death.deathHeadshot,true);assert.equal(death.selectedWeapon,'grenade');
 g.spawn(p);assert.equal(p.selectedWeapon,'rifle');assert.equal(p.deathHeadshot,false);assert.equal(death.deathHeadshot,true);
 assert.equal(recorded.actors[0].selectedWeapon,'grenade');assert.equal(recorded.actors[0].switchStarted,switchTime);
});

test('melee interrupts every rifle reload immediately without transferring rounds',()=>{
 for(const faction of ['british','russian','german']as const)for(const ammo of [0,1,WEAPONS[faction].capacity-1]){
  const g=solo(),p=g.player;p.faction=faction;p.ammo=ammo;p.reserve=17;
  g.reload();advance(g,p.reload*.45);assert.ok(p.reload>0);
  const before={ammo:p.ammo,reserve:p.reserve};g.fire(p,true);
  assert.equal(p.reload,0);assert.equal(p.reloadTotal,0);assert.equal(p.lastMeleeTime,g.time);
  assert.equal(p.cooldown,MELEE_SECONDS);assert.equal(g.shots.at(-1)?.kind,'melee');
  assert.deepEqual({ammo:p.ammo,reserve:p.reserve},before,'cancelling the animation neither loads nor discards rounds');
  assert.equal(g.events.some(event=>event.type==='reload'&&event.actor===p.id),false,'a queued reload effect cannot survive the same-frame strike');
  g.record();assert.equal(g.history.at(-1)!.actors[0].reload,0);assert.equal(g.history.at(-1)!.actors[0].lastMeleeTime,g.time);
  advance(g,MELEE_SECONDS*.5);assert.equal(p.reload,0,'empty-clip auto-reload cannot hide an active melee animation');
  assert.deepEqual({ammo:p.ammo,reserve:p.reserve},before);
 }
});

test('rejected melee and normal rifle fire cannot cancel an active reload',()=>{
 for(const blocked of ['cooldown','switching','crawling','dead']as const){
  const g=solo(),p=g.player;p.ammo=2;p.reserve=17;g.reload();
  if(blocked==='cooldown')p.cooldown=.2;
  if(blocked==='switching')p.switchStarted=g.time;
  if(blocked==='crawling'){p.stance='prone';p.moving=1;}
  if(blocked==='dead')p.alive=false;
  const loading={reload:p.reload,reloadTotal:p.reloadTotal,ammo:p.ammo,reserve:p.reserve,lastMeleeTime:p.lastMeleeTime};
  g.fire(p,true);assert.deepEqual({reload:p.reload,reloadTotal:p.reloadTotal,ammo:p.ammo,reserve:p.reserve,lastMeleeTime:p.lastMeleeTime},loading,blocked);
  assert.equal(g.shots.length,0);
 }
 const g=solo(),p=g.player;p.ammo=2;p.reserve=17;g.reload();const reload=p.reload;
 g.fire();assert.equal(p.reload,reload);assert.equal(p.ammo,2);assert.equal(g.shots.length,0,'rifle fire still waits for loading');
});

test('melee wins simultaneous local reload input and a fresh reload waits for recovery',()=>{
 for(const reloadFirst of [false,true]){
  const g=solo(),p=g.player;p.ammo=3;p.reserve=17;
  if(reloadFirst)g.reload();g.fire(p,true);g.reload();
  assert.equal(p.reload,0);assert.equal(p.reloadTotal,0);assert.equal(g.shots.length,1);
  assert.equal(g.events.filter(event=>event.type==='reload').length,0);
  advance(g,MELEE_SECONDS-.001);g.reload();assert.equal(p.reload,0);
  advance(g,.002);g.reload();assert.ok(p.reload>0,'a new deliberate reload is allowed after the strike');
  advance(g,p.reload+.01);assert.equal(p.ammo,10);assert.equal(p.reserve,10);
 }
});

test('melee does not undo ammunition already transferred at reload completion',()=>{
 const g=solo(),p=g.player;p.ammo=1;p.reserve=7;g.reload();p.reload=.005;
 g.update(1/60,idle);assert.equal(p.ammo,8);assert.equal(p.reserve,0);
 g.fire(p,true);assert.equal(p.reload,0);assert.equal(p.reloadTotal,0);assert.equal(p.ammo,8);assert.equal(p.reserve,0);assert.equal(g.shots.at(-1)?.kind,'melee');
});
