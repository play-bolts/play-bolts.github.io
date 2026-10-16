import test from 'node:test';
import assert from 'node:assert/strict';
import {Game,createActor} from '../src/engine.ts';
import {DIFFICULTIES,HEIGHTS,dist,type Difficulty} from '../src/config.ts';
import {selectTacticalCover,coverExposure,type TacticalThreat} from '../src/aiCover.ts';
import {rememberThreat,updateSurvival} from '../src/aiSurvival.ts';
import {initialMotion} from '../src/soldierMotionState.ts';

const dt=1/60;
const skilled=['regular','veteran'] as const;
function fixture(difficulty:Difficulty='regular'){
 const game=new Game(),target=createActor(0,'german','Target'),bot=createActor(1,'british','Bot');
 game.actors=[target,bot];game.difficulty=difficulty;game.state='playing';game.time=10;game.seed=719;
 Object.assign(target,{x:0,y:0,z:2,yaw:-Math.PI/2,hp:1e9,spawnSafe:0});
 Object.assign(bot,{x:-8,y:0,z:2,yaw:Math.PI/2,stance:'crouch',eyeHeight:HEIGHTS.crouch,hp:100,spawnSafe:0});
 target.pose=initialMotion(target);bot.pose=initialMotion(bot);
 const threat:TacticalThreat={id:target.id,point:{x:target.x,y:HEIGHTS.stand,z:target.z},time:game.time,confidence:1};
 rememberThreat(bot.ai.survival,threat.id,threat.point,threat.time,threat.confidence);
 const cover=selectTacticalCover(bot,[threat],{role:0,retreat:false});assert.ok(cover&&cover.peek);
 assert.equal(dist(bot,cover.hide),0,'fixture begins at actual protected cover');
 Object.assign(bot.ai.survival,{cover,phase:'hold',phaseUntil:game.time+.8,coverSince:game.time,scanAt:Infinity});
 const tick=()=>{game.time+=dt;bot.cooldown=Math.max(0,bot.cooldown-dt);bot.reload=Math.max(0,bot.reload-dt);bot.recoil*=Math.exp(-dt*4.2);game.updateAI(bot,dt);};
 return{game,target,bot,cover,threat,tick};
}

test('regular and veteran hold protective crouch cover throughout a reload',()=>{
 for(const difficulty of skilled){
  const {bot,cover,tick}=fixture(difficulty);bot.ammo=1;bot.reload=bot.reloadTotal=3;
  for(let frame=0;frame<120;frame++){
   tick();
   assert.ok(bot.reload>0);
   assert.equal(bot.ai.survival.phase,'hold',`${difficulty} left cover during reload`);
   assert.ok(dist(bot,cover.hide)<.14,`${difficulty} wandered from shelter`);
   assert.equal(bot.ai.path.length,0);
   assert.equal(bot.stance,'crouch','low cover needs crouched head and shoulders');
   assert.equal(bot.shots,0);
  }
 }
});

test('regular and veteran withdraw after a peek shot and hold the same anchor through bolt recovery',()=>{
 for(const difficulty of skilled){
  const {game,bot,cover,tick}=fixture(difficulty);
  Object.assign(bot,cover.peek!,{stance:cover.stance,eyeHeight:HEIGHTS[cover.stance],cooldown:1.08,lastShotTime:game.time,ammo:9});
  Object.assign(bot.ai.survival,{phase:'peek',phaseUntil:game.time+2,peekArrived:true,lastShot:game.time-.1});
  tick();assert.equal(bot.ai.survival.phase,'return');
  assert.equal(bot.ai.survival.cover,cover,'a shot should reuse the nearby shelter');
  for(let frame=0;frame<45;frame++)tick();
  assert.ok(bot.cooldown>0,'the bolt is still cycling');
  assert.equal(bot.ai.survival.phase,'hold');
  assert.ok(dist(bot,cover.hide)<.14);
  assert.equal(bot.ai.path.length,0);
  assert.equal(bot.shots,0,'returning to cover must not shoot through the obstacle');
 }
});

test('a new flank cue replaces cover that only protected against the frontal threat',()=>{
 for(const difficulty of skilled){
  const {game,bot,cover}=fixture(difficulty);
  const flank={x:-8,y:HEIGHTS.stand,z:8};
  rememberThreat(bot.ai.survival,2,flank,game.time,.9);
  const oldExposure=coverExposure(cover.hide,bot.ai.survival.threats,1.30);
  assert.ok(oldExposure>.5,'fixture must have a real unprotected flank');
  bot.lastHurtTime=game.time;
  updateSurvival(bot,game.time,dt,difficulty,false,true);
  const replacement=bot.ai.survival.cover;assert.ok(replacement);
  const height=replacement.stance==='crouch'?1.30:1.91;
  assert.ok(coverExposure(replacement.hide,bot.ai.survival.threats,height)<oldExposure);
  assert.ok(dist(replacement.hide,cover.hide)>1,'the bot must leave the compromised anchor');
  assert.equal(bot.ai.survival.phase,'seek');
  assert.equal(bot.ai.target,null,'a flank memory cannot grant a firing target');
 }
});

test('rear gunfire turns attention gradually without acquiring or firing on an unseen player',()=>{
 for(const difficulty of skilled){
  const {game,bot,target,tick}=fixture(difficulty);
  Object.assign(bot,{x:13.2,z:0,yaw:0,stance:'stand',eyeHeight:HEIGHTS.stand});
  Object.assign(target,{x:13.2,z:-4,yaw:Math.PI});
  Object.assign(bot.ai.survival,{cover:null,phase:'none',threats:[],scanAt:0});
  bot.ai.path=[];game.move=()=>{};
  game.fire(target);
  assert.equal(bot.ai.target,null);assert.equal(bot.ai.observed,null);
  assert.equal(bot.ai.survival.threats.length,1);
  assert.ok(dist(bot.ai.survival.threats[0].point,target)>1e-6,'hearing must preserve location uncertainty');
  let turn=0;
  for(let frame=0;frame<24;frame++){
   const oldYaw=bot.yaw;tick();const delta=Math.atan2(Math.sin(bot.yaw-oldYaw),Math.cos(bot.yaw-oldYaw));
   assert.ok(Math.abs(delta)<=DIFFICULTIES[difficulty].turn*dt+1e-8,'attention must obey the existing turn limit');
   turn+=Math.abs(delta);
   assert.equal(bot.ai.target,null);assert.equal(bot.ai.observed,null);assert.equal(bot.shots,0);
  }
  assert.ok(turn>.15,`${difficulty} ignored the rear sound`);
 }
});

test('separate sensory memories expire without following hidden actors',()=>{
 for(const difficulty of skilled){
  const {game,bot,target}=fixture(difficulty),state=bot.ai.survival,memory=DIFFICULTIES[difficulty].memory;
  state.cover=null;state.phase='none';state.threats=[];state.scanAt=Infinity;
  const first={x:2,y:1.4,z:3},second={x:-7,y:1.4,z:-8};
  rememberThreat(state,0,first,game.time,.55);rememberThreat(state,2,second,game.time+2,.6);
  first.x=999;second.z=999;target.x=100;
  assert.deepEqual(state.threats.find(t=>t.id===0)!.point,{x:2,y:1.4,z:3},'memory owns a snapshot');
  updateSurvival(bot,game.time+memory+.1,dt,difficulty,false,false);
  assert.deepEqual(state.threats.map(threat=>threat.id),[2]);
  assert.deepEqual(state.threats[0].point,{x:-7,y:1.4,z:-8});
  updateSurvival(bot,game.time+memory+2.1,dt,difficulty,false,false);
  assert.equal(state.threats.length,0);assert.equal(state.cover,null);assert.equal(state.scanPoint,null);
 }
});

test('a sound cannot immediately downgrade a fresh visual observation and memory remains bounded',()=>{
 const {bot}=fixture(),state=bot.ai.survival;state.threats=[];
 rememberThreat(state,0,{x:1,y:1.4,z:2},10,1);
 rememberThreat(state,0,{x:4,y:1.4,z:6},10.1,.5);
 assert.deepEqual(state.threats[0].point,{x:1,y:1.4,z:2});
 for(let id=1;id<=6;id++)rememberThreat(state,id,{x:id,y:1.4,z:0},10+id,.5);
 assert.equal(state.threats.length,3);
 assert.deepEqual(state.threats.map(threat=>threat.id),[6,5,4]);
});

test('recruit does not opt into tactical cover or flank scanning',()=>{
 const {game,bot,target,tick}=fixture('recruit');
 Object.assign(bot.ai.survival,{cover:null,phase:'none',threats:[],scanAt:0});
 Object.assign(target,{x:bot.x,z:bot.z-4,yaw:Math.PI});bot.yaw=0;
 game.fire(target);
 for(let frame=0;frame<60;frame++)tick();
 assert.equal(bot.ai.survival.cover,null);assert.equal(bot.ai.survival.phase,'none');
 assert.equal(bot.ai.survival.threats.length,0);assert.equal(bot.ai.survival.scanPoint,null);
});

test('skilled bots retain their last-resort melee attack when both ammo stores are empty',()=>{
 for(const difficulty of skilled){
  const {game,bot,target,tick}=fixture(difficulty);
  Object.assign(bot,{x:13.2,z:0,yaw:0,stance:'stand',eyeHeight:HEIGHTS.stand,ammo:0,reserve:0});
  Object.assign(target,{x:13.2,z:1.2,hp:100});
  Object.assign(bot.ai,{target:target.id,sight:true,seen:game.time,decision:Infinity,reaction:0,driftClock:Infinity});
  Object.assign(bot.ai.survival,{cover:null,phase:'none',threats:[],scanAt:Infinity});
  game.move=()=>{};
  for(let frame=0;frame<180&&target.alive;frame++)tick();
  assert.ok(Number.isFinite(bot.lastMeleeTime),`${difficulty} never swung its empty rifle`);
  assert.equal(target.alive,false,'the physical butt strike can still hit a nearby target');
  assert.equal(bot.ammo,0);assert.equal(bot.reserve,0);
 }
});

test('full update defers an empty skilled rifle reload until shelter and bounds a blocked-route wait',()=>{
 const idle={forward:0,right:0,jump:false,walk:false,lean:0};
 for(const difficulty of skilled)for(const blockedRoute of [false,true]){
  const {game,bot,target}=fixture(difficulty),started=game.time;
  Object.assign(bot,{x:13.2,z:-7,yaw:0,stance:'stand',eyeHeight:HEIGHTS.stand,ammo:0,reserve:50});
  Object.assign(target,{x:13.2,z:7,yaw:Math.PI});
  Object.assign(bot.ai,{known:{x:target.x,y:HEIGHTS.stand,z:target.z},heard:game.time,path:[]});
  Object.assign(bot.ai.survival,{cover:null,phase:'none',threats:[],scanAt:Infinity});
  rememberThreat(bot.ai.survival,target.id,game.eye(target),game.time,1);
  if(blockedRoute){
   // A stationary obstacle can invalidate an otherwise geometrically sound
   // route. Keep the real full-update reload/cooldown/decision ordering.
   const move=game.move.bind(game);
   game.move=(actor,...args)=>{if(actor!==bot)move(actor,...args);};
  }
  game.update(dt,idle);
  assert.equal(bot.reload,0,`${difficulty} global auto-reload bypassed the shelter decision`);
  assert.equal(bot.ai.survival.phase,'seek');
  assert.ok(bot.ai.survival.cover,'fixture must have reachable geometric cover');
  for(let frame=0;frame<240&&!bot.reload;frame++)game.update(dt,idle);
  assert.ok(bot.reload>0,`${difficulty} waited indefinitely with an empty rifle`);
  assert.ok(game.time-started<=4+dt,'the shelter wait has a bounded fallback');
  if(!blockedRoute){
   assert.equal(bot.ai.survival.phase,'hold','a clear route should finish before reloading');
   assert.ok(bot.ai.survival.cover);
   assert.ok(dist(bot,bot.ai.survival.cover.hide)<.14);
   assert.equal(coverExposure(bot,bot.ai.survival.threats,bot.eyeHeight+.26),0);
  }else{
   assert.ok(game.time-started>.4,'a reachable-looking route should get a real attempt');
   assert.ok(bot.ai.survival.phase==='hold'||!bot.ai.survival.cover||game.time-started>=3.5,'fallback needs shelter, failed cover, or expired wait');
  }
 }
});
