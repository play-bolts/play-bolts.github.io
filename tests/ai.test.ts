import test from 'node:test';
import assert from 'node:assert/strict';
import {Game} from '../src/engine.ts';
import {ARENA,DIFFICULTIES,WEAPONS,visible,type Difficulty} from '../src/config.ts';

const difficulties:Difficulty[]=['recruit','regular','veteran'];
const dt=1/60;

// Isolate perception and shooting in the clear perimeter lane. Body damage and
// ray collisions remain real; restore the target after each sample so lethal
// headshots cannot bias the number of remaining shots in the accuracy trial.
function shootingLane(difficulty:Difficulty,seed:number){
 const game=new Game();game.start('german',difficulty);game.seed=seed;
 for(const actor of game.actors){actor.alive=false;actor.deadAt=99999;}
 const bot=game.actors[1],target=game.player,x=ARENA.width/2-1.2;
 Object.assign(bot,{alive:true,x,y:0,z:-7,yaw:0,pitch:0,cooldown:0,spawnSafe:0,ammo:100,reserve:100,hp:1e9});
 Object.assign(target,{alive:true,x,y:0,z:7,spawnSafe:0,hp:1e9});
 // Locomotion is tested by the separate full-round simulation. Keeping this
 // actor stationary isolates whether target movement defeats perfect tracking.
 game.move=()=>{};
 assert.ok(visible(game.eye(bot),game.eye(target)),'test lane must be unobstructed');
 function tick(){game.time+=dt;bot.cooldown=Math.max(0,bot.cooldown-dt);bot.recoil*=Math.exp(-dt*5);game.updateAI(bot,dt);target.alive=true;target.hp=1e9;game.state='playing';}
 return{game,bot,target,x,tick};
}

function accuracy(difficulty:Difficulty,moving:boolean){
 let shots=0,hits=0,earliest=Infinity;
 // Tight anatomical volumes make recruit hits sparse. Use enough independent
 // encounters that a few lucky shots do not reverse the movement comparison.
 for(let seed=1;seed<=500;seed++){
  const {game,bot,target,x,tick}=shootingLane(difficulty,seed*7919);
  for(let frame=0;frame<360;frame++){
   // A 1.1m side step at 4m/s fits inside the perimeter lane on either map size.
   if(moving){const phase=(frame*dt*4/1.1)%2;target.x=x+.55-1.1*(phase<1?phase:2-phase);}
   tick();bot.ai.decision=Infinity;
   if(bot.shots)earliest=Math.min(earliest,game.shots[0].time);
  }
  shots+=bot.shots;hits+=bot.hits;
 }
 return{shots,hits,rate:hits/shots,earliest};
}

test('seeded rifle accuracy is fallible at every difficulty and strafing disrupts tracking',()=>{
 const rates:number[]=[];
 for(const difficulty of difficulties){
  const stationary=accuracy(difficulty,false),strafing=accuracy(difficulty,true);
  assert.ok(stationary.shots>180,`${difficulty} must actively fight`);
  assert.ok(stationary.rate>.05&&stationary.rate<.7,`${difficulty}: stationary hit rate ${stationary.rate}`);
  assert.ok(strafing.rate<stationary.rate,`${difficulty}: strafing ${strafing.rate} must beat static ${stationary.rate}`);
  assert.ok(stationary.earliest>=DIFFICULTIES[difficulty].reaction-dt,`${difficulty} fired without recognition time`);
  rates.push(stationary.rate);
 }
 assert.ok(rates[0]<rates[1]&&rates[1]<rates[2],`difficulty progression: ${rates}`);
});

test('observations arrive late and are held instead of reading a live target every frame',()=>{
 const {bot,target,tick}=shootingLane('regular',123);
 tick();assert.equal(bot.ai.observed,null);
 for(let i=0;i<15;i++)tick();
 assert.ok(bot.ai.observed);
 const observedX=bot.ai.observed.x;
 target.x+=.4;tick();assert.equal(bot.ai.observed.x,observedX);
 for(let i=0;i<30;i++)tick();
 assert.equal(bot.ai.observed.x,target.x);
});

test('reacquiring the same target after sight loss restores the recognition delay',()=>{
 for(const difficulty of difficulties){
  const {game,bot,target,tick}=shootingLane(difficulty,581);
  for(let i=0;i<150;i++)tick();
  assert.equal(bot.ai.target,target.id);
  const z=target.z;target.z=bot.z-3;bot.ai.decision=Infinity;
  for(let i=0;i<30;i++)tick();
  assert.equal(bot.ai.sight,false);
  const shots=bot.shots;target.z=z;bot.yaw=0;bot.cooldown=0;tick();
  assert.ok(bot.ai.reaction>=DIFFICULTIES[difficulty].reaction-dt);
  for(let i=0;i<Math.floor(DIFFICULTIES[difficulty].reaction/dt)-2;i++)tick();
  assert.equal(bot.shots,shots,`${difficulty} instantly fired on a re-peek at ${game.time}`);
 }
});

test('damage and gunfire from behind convey a noisy location without acquiring an exact target',()=>{
 const {game,bot,target,tick}=shootingLane('veteran',719);
 target.z=bot.z-4;
 game.damage(bot,target,10);
 assert.equal(bot.ai.target,null);assert.equal(bot.ai.observed,null);
 assert.ok(bot.ai.known&&Math.hypot(bot.ai.known.x-target.x,bot.ai.known.z-target.z)>1e-6);
 game.fire(target);
 assert.equal(bot.ai.target,null);assert.equal(bot.ai.observed,null);
 for(let i=0;i<30;i++)tick();
 assert.equal(bot.shots,0);
});

test('a remembered target behind the bot cannot bypass its field of view',()=>{
 const {bot,target,tick}=shootingLane('veteran',41);
 for(let i=0;i<90;i++)tick();
 assert.equal(bot.ai.target,target.id);
 target.z=bot.z-3;bot.cooldown=0;bot.ai.decision=Infinity;
 const shots=bot.shots;
 for(let i=0;i<60;i++)tick();
 assert.equal(bot.shots,shots);assert.equal(bot.ai.sight,false);
});

test('AI shots use the recorded weapon orientation and wait beyond bolt cooldown',()=>{
 const {game,bot,tick}=shootingLane('regular',991);
 for(let i=0;i<300;i++){
  const shots=bot.shots;tick();
  if(bot.shots>shots){
   const shot=game.shots.at(-1)!,dx=shot.end.x-shot.origin.x,dy=shot.end.y-shot.origin.y,dz=shot.end.z-shot.origin.z;
   const yaw=Math.atan2(dx,dz),pitch=Math.atan2(dy,Math.hypot(dx,dz));
   assert.ok(Math.abs(Math.atan2(Math.sin(yaw-bot.yaw),Math.cos(yaw-bot.yaw)))<.02,'shot yaw must match visible rifle');
   assert.ok(Math.abs(pitch-(bot.pitch+bot.recoil-WEAPONS[bot.faction].recoil))<.02,'shot pitch must match visible rifle');
  }
 }
 assert.ok(bot.shots>=2);
 const times=game.shots.map(shot=>shot.time);
 for(let i=1;i<times.length;i++)assert.ok(times[i]-times[i-1]>1.35,'trigger hesitation must follow the 1.08s bolt cycle');
 assert.ok(game.shots.some(shot=>shot.hit===null),'physical misses should exist');
});
