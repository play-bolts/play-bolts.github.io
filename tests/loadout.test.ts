import test from 'node:test';
import assert from 'node:assert/strict';
import {Game} from '../src/engine.ts';
import {FACTIONS,RULES,SPAWN_AMMO,WEAPONS} from '../src/config.ts';

test('every player and bot spawns with 150 total rounds including a full magazine',()=>{
 assert.equal(SPAWN_AMMO,150);
 const check=(game:Game)=>{for(const actor of game.actors){
  assert.equal(actor.ammo,WEAPONS[actor.faction].capacity,actor.faction+' starts loaded');
  assert.equal(actor.ammo+actor.reserve,150,actor.faction+' total includes the magazine');
 }};
 for(const faction of FACTIONS){
  const game=new Game();game.start(faction,'recruit');check(game);
  for(const actor of game.actors){actor.ammo=0;actor.reserve=0;actor.alive=false;game.spawn(actor);}
  check(game);
 }
});

test('killcam and automatic bot respawns restore the same total ammunition',()=>{
 const game=new Game();game.start('british','recruit');game.updateAI=()=>{};
 const player=game.player,bot=game.actors[1];
 player.ammo=0;player.reserve=0;game.damage(player,bot,100);game.skipReplay();
 assert.equal(player.ammo,10);assert.equal(player.reserve,140);
 bot.ammo=0;bot.reserve=0;game.damage(bot,player,100);
 game.update(RULES.respawn+.01,{forward:0,right:0,jump:false,walk:false,lean:0});
 assert.equal(bot.alive,true);assert.equal(bot.ammo+bot.reserve,150);
});

test('changing faction preserves match scores, opponents and clock while replacing only the player loadout',()=>{
 const game=new Game();game.start('british','recruit');game.state='paused';game.time=70;game.remaining=230;
 Object.assign(game.player,{kills:7,deaths:3,hp:27,ammo:2});
 const opponents=structuredClone(game.actors.slice(1));
 assert.equal(game.changePlayerFaction('german'),true);
 assert.equal(game.player.faction,'german');assert.equal(game.player.ammo,5);assert.equal(game.player.hp,100);
 assert.equal(game.player.reserve,145,'faction selection uses the same total ammunition as every spawn');
 assert.equal(game.player.kills,7);assert.equal(game.player.deaths,3);
 assert.deepEqual(game.actors.slice(1),opponents);assert.equal(game.time,70);assert.equal(game.remaining,230);assert.equal(game.state,'paused');
 assert.equal(game.history.length,1);assert.equal(game.history[0].time,70);assert.equal(game.replay.length,0);
});

test('confirming the current rifle does not refill ammunition or heal the player',()=>{
 const game=new Game();game.start('british','recruit');game.state='paused';game.player.hp=27;game.player.ammo=2;
 const before=structuredClone(game.player);
 assert.equal(game.changePlayerFaction('british'),false);assert.deepEqual(game.player,before);
});

test('loadout changes are rejected outside a match and do not leave stale killcam state',()=>{
 const game=new Game();assert.equal(game.changePlayerFaction('russian'),false);game.start('british','recruit');
 game.state='ended';assert.equal(game.changePlayerFaction('russian'),false);
 game.state='playing';game.damage(game.player,game.actors[1],100);assert.equal(game.state,'killcam');
 assert.equal(game.changePlayerFaction('russian'),true);assert.equal(game.state,'playing');assert.equal(game.player.alive,true);
 assert.equal(game.player.deaths,1);assert.equal(game.actors[1].kills,1);assert.equal(game.replayShots.length,0);
});
