import test from 'node:test';
import assert from 'node:assert/strict';
import {Game,createActor} from '../src/engine.ts';
import {SpectatorCamera} from '../src/spectator.ts';
import {RULES} from '../src/config.ts';
const idle={forward:0,right:0,jump:false,walk:false,lean:0};

test('local spectator leaves combat without a death while AI and the round continue',()=>{
 const game=new Game();game.start('british','regular');game.seed=1234;
 const player=game.player;Object.assign(player,{kills:4,deaths:2,ammo:3,reserve:37,reload:1,reloadTotal:3});
 for(const bot of game.actors.slice(1)){bot.ai.target=0;bot.ai.sight=true;}
 const positions=game.actors.slice(1).map(a=>[a.x,a.z]);assert.equal(game.spectate(),true);
 assert.equal(player.spectator,true);assert.equal(player.alive,false);assert.equal(player.reload,0);assert.equal(player.deaths,2);
 assert.ok(game.actors.slice(1).every(a=>a.ai.target!==0));assert.ok(!game.events.some(e=>e.type==='kill'));
 game.fire();game.fire(player,true);game.reload();game.selectWeapon('grenade');game.setStance('prone');game.damage(player,game.actors[1],100);game.spawn(player);
 assert.equal(player.ammo,3);assert.equal(player.reserve,37);assert.equal(player.selectedWeapon,'rifle');assert.equal(player.stance,'stand');
 for(let i=0;i<600;i++)game.update(1/60,{...idle,forward:1,jump:true});
 assert.ok(game.time>9);assert.ok(game.remaining<RULES.roundSeconds-9);assert.equal(game.state,'playing');assert.equal(player.alive,false);assert.equal(player.deaths,2);
 assert.ok(game.actors.slice(1).some((a,i)=>Math.hypot(a.x-positions[i][0],a.z-positions[i][1])>1));assert.ok(game.actors.slice(1).every(a=>a.ai.target!==0));
 const opponents=structuredClone(game.actors.slice(1)),time=game.time;game.state='paused';assert.equal(game.changePlayerFaction('british'),true,'same faction joins from spectator');
 assert.equal(player.spectator,false);assert.equal(player.alive,true);assert.equal(player.ammo+player.reserve,150);assert.equal(player.kills,4);assert.equal(player.deaths,2);assert.equal(game.time,time);assert.deepEqual(game.actors.slice(1),opponents);
});

test('spectators neither block actor movement nor receive bullets or win a round',()=>{
 const game=new Game();game.start('british','recruit');game.actors=game.actors.slice(0,3);game.spectate();
 const [spectator,shooter,target]=game.actors;Object.assign(spectator,{x:13,y:0,z:1,alive:true,kills:100});
 Object.assign(shooter,{x:13,y:0,z:0,yaw:0,pitch:0,ads:true,spawnSafe:0,cooldown:0});Object.assign(target,{x:13,y:0,z:3,spawnSafe:0});
 shooter.ads=false;game.move(shooter,0,1,.5);assert.ok(shooter.z>1.8,'even a stale alive flag cannot add spectator collision');
 shooter.z=0;shooter.ads=true;game.fire(shooter);assert.equal(game.shots.at(-1)?.hit,target.id);assert.equal(spectator.hp,0);assert.equal(spectator.deaths,0);
 game.finish();assert.notEqual(game.winner,spectator);
});

test('free flight is independent of actors, normalized, vertical and faster with Shift',()=>{
 const camera=new SpectatorCamera(),actor=createActor(0,'british','Camera');camera.enter(actor);const original=structuredClone(actor),start={...camera.position};
 camera.move(.1,{forward:1,right:1,up:1,fast:false});assert.ok(Math.abs(Math.hypot(camera.position.x-start.x,camera.position.y-start.y,camera.position.z-start.z)-.7)<1e-9);assert.deepEqual(actor,original);
 camera.enter(actor);camera.move(.1,{forward:0,right:0,up:1,fast:true});assert.equal(camera.position.y,start.y+1.6);
 camera.look(Math.PI/2,.3);const before={...camera.position};camera.move(.1,{forward:1,right:0,up:0,fast:false});assert.ok(camera.position.x>before.x);assert.ok(camera.position.y>before.y);
});

test('follow cycles both directions, skips spectators/dead players and keeps free view on the last target',()=>{
 const actors=[createActor(0,'british','Viewer'),createActor(1,'russian','One'),createActor(2,'german','Two'),createActor(3,'british','Three')];actors[0].spectator=true;actors[0].alive=false;
 const camera=new SpectatorCamera();assert.equal(camera.cycle(actors,1)?.id,1);assert.equal(camera.cycle(actors,-1)?.id,3);assert.equal(camera.cycle(actors,1)?.id,1);
 actors[1].alive=false;camera.sync(actors);assert.equal(camera.targetId,2);actors[2].spectator=true;camera.sync(actors);assert.equal(camera.targetId,3);
 Object.assign(actors[3],{x:3,y:1,z:5,yaw:.3,pitch:.2});camera.sync(actors);const position={...camera.position};camera.free(actors);assert.equal(camera.following,false);assert.deepEqual(camera.position,position);assert.equal(camera.yaw,.3);
 camera.cycle(actors,-1);actors[3].alive=false;camera.sync(actors);assert.equal(camera.targetId,null);assert.deepEqual(camera.position,position);
});

test('follow survives network index remapping and advances when the participant disconnects',()=>{
 const camera=new SpectatorCamera(),actors=[createActor(0,'british','Viewer'),createActor(1,'british','Seven'),createActor(2,'german','Nine')];actors[0].spectator=true;camera.targetId=2;
 const withJoin=[actors[0],createActor(1,'russian','Three'),{...actors[1],id:2},{...actors[2],id:3}];camera.remap([42,7,9],[42,3,7,9],withJoin);assert.equal(camera.targetId,3);
 camera.remap([42,3,7,9],[42,3,7],withJoin.slice(0,3));assert.equal(camera.targetId,1);assert.equal(camera.target(withJoin)?.name,'Three');
});

test('Escape leaves follow in both browser key/unlock event orders, then opens the free-fly menu',()=>{
 for(const order of [['key','unlock'],['unlock','key']]as const){
  const camera=new SpectatorCamera(),actor=createActor(1,'british','Target');camera.targetId=1;
  assert.equal(camera.handleExit(order[0],100,[actor]),true);assert.equal(camera.following,false);
  assert.equal(camera.handleExit(order[1],105,[actor]),true,'the second browser event must not pause');
  assert.equal(camera.handleExit('key',500,[actor]),false,'Escape in free flight is available to the menu');
 }
});
