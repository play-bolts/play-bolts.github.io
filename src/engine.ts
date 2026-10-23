import {BOXES,DIFFICULTIES,FACTIONS,GRENADE,HEIGHTS,MELEE_CONTACT_FRACTION,MELEE_RANGE,MELEE_RADIUS,MELEE_SECONDS,RULES,SPAWN_AMMO,SPAWNS,WEAPONS,WEAPON_SWITCH_SECONDS,clamp,damageFor,dist,lerp,playerShotSpread,rayBox,visible,worldHit,type DamagePart,type Difficulty,type Faction,type Stance,type Vec,type WeaponSlot} from './config';
import {coverPoints,findPath,selectCover} from './navigation';
import {createSurvivalState,rememberThreat,updateSurvival,type SurvivalState} from './aiSurvival';
import {DEFAULT_PLAYER_NAME,sanitizePlayerName} from './names';
import {advanceStanceHeight,stanceSpeedFactor} from './stance';
import {advanceHipSpread} from './accuracy';
import {resolveActorMovement,type CollisionActor} from './actorCollision';
import {SpectatorCamera} from './spectator';
import {advanceLean,leanEye} from './lean';
import {sampleHitVolumes,rayHitVolumes,meleeHitVolumes} from './hitboxes';
import {initialMotion,advanceSoldierMotion,type SoldierMotionState} from './soldierMotionState';
import {crossedFootContact} from './soldierGait';
export interface AIBrain {
 survival:SurvivalState;
 target:number|null;known:Vec|null;seen:number;reaction:number;decision:number;path:{x:number;z:number}[];mode:string;role:number;stuck:number;heard:number;strafe:number;engage:number;
 sight:boolean;observed:Vec|null;observations:{ready:number;point:Vec}[];observationClock:number;settled:number;shotWait:number;
 biasX:number;biasY:number;driftX:number;driftY:number;driftGoalX:number;driftGoalY:number;driftClock:number;
}
function createBrain(id:number):AIBrain{return{survival:createSurvivalState(),target:null,known:null,seen:-100,reaction:0,decision:0,path:[],mode:'patrol',role:(id%3)-1,stuck:0,heard:-100,strafe:id%2?1:-1,engage:0,sight:false,observed:null,observations:[],observationClock:0,settled:0,shotWait:0,biasX:0,biasY:0,driftX:0,driftY:0,driftGoalX:0,driftGoalY:0,driftClock:0};}
export interface Actor extends Vec {
 /** Stable renderer key across network roster reindexing; never used for gameplay. */
 renderIdentity?:string;
 collisionId?:number;
 id:number;name:string;faction:Faction;yaw:number;pitch:number;stance:Stance;eyeHeight:number;hp:number;ammo:number;reserve:number;kills:number;deaths:number;shots:number;hits:number;
 spectator:boolean;alive:boolean;cooldown:number;reload:number;reloadTotal:number;vy:number;grounded:boolean;leftGroundAt:number;jumpStarted:number;landedAt:number;landingSpeed:number;moving:number;ads:boolean;lean:number;recoil:number;spawnSafe:number;deadAt:number;lastShotTime:number;lastHurtTime:number;lastMeleeTime:number;
 selectedWeapon:WeaponSlot;switchFrom:WeaponSlot;switchStarted:number;switchDuration:number;deathYaw:number;deathHeadshot:boolean;
 ai:AIBrain;pose?:SoldierMotionState;
 /** Server-measured RTT in milliseconds; absent for local-only actors. */
 ping?:number|null;
}
/** Neutral actor state shared by local games and authoritative network snapshots. */
export function createActor(id:number,faction:Faction,name:string):Actor {
 return{id,name:sanitizePlayerName(name),faction,x:0,y:0,z:0,yaw:0,pitch:0,stance:'stand',eyeHeight:HEIGHTS.stand,hp:100,ammo:WEAPONS[faction].capacity,reserve:SPAWN_AMMO-WEAPONS[faction].capacity,kills:0,deaths:0,shots:0,hits:0,spectator:false,alive:true,cooldown:0,reload:0,reloadTotal:0,vy:0,grounded:true,leftGroundAt:-Infinity,jumpStarted:-Infinity,landedAt:-Infinity,landingSpeed:0,moving:0,ads:false,lean:0,recoil:0,spawnSafe:0,deadAt:-Infinity,lastShotTime:-Infinity,lastHurtTime:-Infinity,lastMeleeTime:-Infinity,selectedWeapon:'rifle',switchFrom:'rifle',switchStarted:-Infinity,switchDuration:WEAPON_SWITCH_SECONDS,deathYaw:0,deathHeadshot:false,ai:createBrain(id)};
}
export interface Shot {time:number;actor:number;origin:Vec;end:Vec;hit:number|null;headshot:boolean;kind:'shot'|'melee';impactOnly?:boolean}
export interface Event {type:'shot'|'kill'|'reload'|'bolt'|'hurt'|'spawn'|'end'|'step'|'switch';actor:number;victim?:number;shot?:Shot;headshot?:boolean;lethal?:boolean;value?:number;weapon?:'rifle'|'grenade'|'melee';actorName?:string;victimName?:string;actorFaction?:Faction;/** Historical notification: retain the feed, but do not trigger live reactions. */presentationOnly?:boolean}
export interface Snapshot {time:number;actors:Pick<Actor,'id'|'pose'|'x'|'y'|'z'|'yaw'|'pitch'|'stance'|'eyeHeight'|'spectator'|'alive'|'ads'|'moving'|'lean'|'recoil'|'ammo'|'reserve'|'hp'|'cooldown'|'reload'|'reloadTotal'|'deadAt'|'lastShotTime'|'lastHurtTime'|'lastMeleeTime'|'selectedWeapon'|'switchFrom'|'switchStarted'|'switchDuration'|'deathYaw'|'deathHeadshot'|'grounded'|'vy'|'leftGroundAt'|'jumpStarted'|'landedAt'|'landingSpeed'>[]}
export interface Input {forward:number;right:number;jump:boolean;walk:boolean;lean:number}
export class Game {
 private meleeContacts=new Map<Actor,{started:number;at:number;weapon:WeaponSlot}>();
 spectator=new SpectatorCamera();
 get viewedActor(){return this.player?.spectator?this.spectator.target(this.actors):this.player??null;}
 playerHipSpread=playerShotSpread(false,'stand',0);
 motionRecordPending=false;
 actors:Actor[]=[];time=0;remaining=RULES.roundSeconds;state:'menu'|'playing'|'paused'|'killcam'|'ended'='menu';difficulty:Difficulty='regular';events:Event[]=[];shots:Shot[]=[];history:Snapshot[]=[];replay:Snapshot[]=[];replayShots:Shot[]=[];killer=0;replayTime=0;replayEnd=0;recordClock=0;winner:Actor|null=null;seed=51235;
 get player(){return this.actors[0];}
 random(){this.seed=(Math.imul(this.seed,1664525)+1013904223)>>>0;return this.seed/4294967296;}
 start(faction:Faction,difficulty:Difficulty,playerName=DEFAULT_PLAYER_NAME){
  this.meleeContacts.clear();
  this.spectator.reset();this.difficulty=difficulty;this.actors=[];this.events=[];this.shots=[];this.history=[];this.replay=[];this.time=0;this.remaining=RULES.roundSeconds;this.winner=null;this.seed=Date.now()>>>0;
  const names=[sanitizePlayerName(playerName),'Cpl. Evans','Pvt. Sokolov','Sgt. Adler','Lt. Fletcher','Pvt. Volkov'];
  for(let i=0;i<=RULES.botCount;i++){
   const f=i===0?faction:FACTIONS[(i-1)%3];const a=createActor(i,f,names[i]);
   this.actors.push(a);this.spawn(a);
  }
  this.state='playing';this.events=[];this.record();
 }
 setPlayerName(name:unknown){const normalized=sanitizePlayerName(name);if(this.player)this.player.name=normalized;return normalized;}
 changePlayerFaction(faction:Faction){
  if(!this.player||this.state==='menu'||this.state==='ended'||this.player.faction===faction&&!this.player.spectator)return false;
  this.player.spectator=false;this.spectator.reset();this.player.faction=faction;this.spawn(this.player);
  // Old first-person frames belong to the previous equipment; keep the match,
  // opponents, scores and clock while starting fresh replay history.
  this.history=[];this.replay=[];this.shots=[];this.replayShots=[];this.recordClock=0;this.replayTime=this.replayEnd=0;
  this.record();if(this.state==='killcam')this.state='playing';return true;
 }
 spectate(){
  const player=this.player;if(!player||this.state==='menu'||this.state==='ended'||player.spectator)return false;
  this.spectator.enter(player);Object.assign(player,{spectator:true,alive:false,hp:0,moving:0,ads:false,lean:0,reload:0,reloadTotal:0,cooldown:0,recoil:0,vy:0,deadAt:-Infinity});
  for(const actor of this.actors){actor.ai.survival.threats=actor.ai.survival.threats.filter(threat=>threat.id!==player.id);if(actor.ai.target===player.id){actor.ai.target=null;actor.ai.sight=false;actor.ai.known=null;actor.ai.path=[];}}
  this.events=this.events.filter(event=>event.actor!==player.id);this.history=[];this.replay=[];this.replayShots=[];this.shots=[];
  if(this.state==='killcam')this.state='playing';return true;
 }
 spawn(a:Actor){
  this.meleeContacts.delete(a);
  if(a.spectator)return;
  let best=SPAWNS[0],score=-Infinity;
  for(const p of SPAWNS){let nearest=100;let sight=0;for(const b of this.actors)if(b!==a&&b.alive&&!b.spectator){nearest=Math.min(nearest,dist(p,b));if(visible({...p,y:1.65},this.eye(b)))sight++;}
   if(nearest<RULES.radius*2+.02)continue;
   const s=nearest-sight*9+this.random()*4;if(s>score){score=s;best=p;}}
  Object.assign(a,{...best,y:0,hp:100,alive:true,ammo:WEAPONS[a.faction].capacity,reserve:SPAWN_AMMO-WEAPONS[a.faction].capacity,stance:'stand',eyeHeight:HEIGHTS.stand,moving:0,reload:0,reloadTotal:0,cooldown:.45,vy:0,grounded:true,leftGroundAt:-Infinity,jumpStarted:-Infinity,landedAt:-Infinity,landingSpeed:0,ads:false,lean:0,recoil:0,spawnSafe:RULES.spawnProtection,deadAt:-Infinity,lastShotTime:-Infinity,lastHurtTime:-Infinity,lastMeleeTime:-Infinity,selectedWeapon:'rifle',switchFrom:'rifle',switchStarted:-Infinity,switchDuration:WEAPON_SWITCH_SECONDS,deathYaw:0,deathHeadshot:false});
  if(a.id===0)this.playerHipSpread=playerShotSpread(false,'stand',0);
  a.yaw=Math.atan2(-a.x,-a.z);a.pitch=0;a.ai=createBrain(a.id);a.pose=initialMotion(a);
  this.events.push({type:'spawn',actor:a.id});
 }
 eye(a:Actor):Vec {return leanEye(a);}
 direction(a:Actor,spread=0):Vec {const y=a.yaw+(this.random()-.5)*spread,p=a.pitch+a.recoil+(this.random()-.5)*spread;return{x:Math.sin(y)*Math.cos(p),y:Math.sin(p),z:Math.cos(y)*Math.cos(p)};}
 setStance(stance:Stance){const a=this.player;if(this.state!=='playing'||!a?.alive||a.spectator)return;a.stance=a.stance===stance?'stand':stance;}
 isSwitching(a=this.player){return !!a&&this.time-a.switchStarted<a.switchDuration;}
 isMeleeRecovery(a=this.player){return !!a&&this.time-a.lastMeleeTime<MELEE_SECONDS;}
 canADS(a=this.player){return !!a?.alive&&!a.spectator&&a.grounded&&a.selectedWeapon==='rifle'&&!a.reload&&!this.isSwitching(a);}
 selectWeapon(weapon:WeaponSlot,a=this.player){
  if(this.state!=='playing'||!a?.alive||a.spectator||a.selectedWeapon===weapon||this.isSwitching(a))return false;
  a.switchFrom=a.selectedWeapon;a.selectedWeapon=weapon;a.switchStarted=this.time;a.switchDuration=WEAPON_SWITCH_SECONDS;a.ads=false;
  // Ammunition moves only at reload completion; interruption cannot create or lose rounds.
  a.reload=0;a.reloadTotal=0;this.events.push({type:'switch',actor:a.id,weapon});return true;
 }
 reload(a=this.player){if(this.state!=='playing'||!a?.alive||a.spectator||a.selectedWeapon!=='rifle'||this.isSwitching(a)||this.isMeleeRecovery(a)||a.reload>0||a.ammo===WEAPONS[a.faction].capacity||a.reserve<=0)return; a.reloadTotal=WEAPONS[a.faction].reload*(a.faction==='british'&&a.ammo>=5?.66:1);a.reload=a.reloadTotal;a.ads=false;this.events.push({type:'reload',actor:a.id});}
 fire(a=this.player,melee=false){
  if(this.state!=='playing'||!a?.alive||a.spectator||this.isSwitching(a)||(a.stance==='prone'&&a.moving>.1))return;
  melee=melee||a.selectedWeapon==='grenade';
  if(!this.canADS(a))a.ads=false;
  if(a.cooldown>0||(!melee&&a.reload>0))return;
  if(melee){
   // Only an accepted strike cancels loading. Rounds transfer at completion,
   // so neither a partly loaded animation nor this interruption changes ammo.
   a.reload=0;a.reloadTotal=0;
   this.events=this.events.filter(event=>event.type!=='reload'||event.actor!==a.id);
  }
  if(!melee&&a.ammo<=0){this.reload(a);return;}
  if(!melee){a.ammo--;a.shots++;a.lastShotTime=this.time;}else{
   a.lastMeleeTime=this.time;
   this.meleeContacts.set(a,{started:this.time,at:this.time+MELEE_SECONDS*MELEE_CONTACT_FRACTION[a.selectedWeapon],weapon:a.selectedWeapon});
  }a.spawnSafe=0;a.cooldown=melee?MELEE_SECONDS:WEAPONS[a.faction].cycle;
  const spread=a.id===0?(a.ads?playerShotSpread(true,a.stance,a.moving):this.playerHipSpread):DIFFICULTIES[this.difficulty].spread*(a.ads?.7:1);
  const origin=this.eye(a),direction=this.direction(a,melee?0:spread);let length=Math.min(melee?MELEE_RANGE:120,worldHit(origin,direction)),victim:Actor|null=null,part:DamagePart='torso';
  for(const target of this.actors)if(!melee&&target!==a&&target.alive&&!target.spectator&&target.spawnSafe<=0){
   const hit=rayHitVolumes(origin,direction,sampleHitVolumes(target,this.time));if(hit&&hit.distance<length){length=hit.distance;victim=target;part=hit.part;}
  }
  const shot:Shot={time:this.time,actor:a.id,origin,end:{x:origin.x+direction.x*length,y:origin.y+direction.y*length,z:origin.z+direction.z*length},hit:victim?.id??null,headshot:!melee&&part==='head',kind:melee?'melee':'shot'};
  this.shots.push(shot);this.events.push({type:'shot',actor:a.id,shot});
  if(!melee)a.recoil+=WEAPONS[a.faction].recoil;
  for(const bot of this.actors)if(bot.id&&bot!==a&&bot.alive&&!bot.spectator&&dist(bot,a)<32){
   bot.ai.heard=this.time;
   let cue:Vec|undefined;
   if(bot.ai.target===null||this.time-bot.ai.seen>1){cue={x:a.x+(this.random()-.5)*3,y:1.4,z:a.z+(this.random()-.5)*3};bot.ai.known=cue;bot.ai.mode='investigate';bot.ai.decision=0;}
   if(this.difficulty!=='recruit'){
    cue??={x:a.x+(this.random()-.5)*3,y:a.y+1.4,z:a.z+(this.random()-.5)*3};
    rememberThreat(bot.ai.survival,a.id,cue,this.time,.55);
    // A nearby physical bullet path is a suppression cue; a shot stopped by
    // intervening cover cannot extend beyond its recorded impact point.
    if(!melee){const vx=shot.end.x-origin.x,vy=shot.end.y-origin.y,vz=shot.end.z-origin.z,bx=bot.x-origin.x,by=bot.y+1-origin.y,bz=bot.z-origin.z;
     const t=clamp((bx*vx+by*vy+bz*vz)/Math.max(.001,vx*vx+vy*vy+vz*vz),0,1);
     if(Math.hypot(bx-vx*t,by-vy*t,bz-vz*t)<1.35){bot.ai.survival.suppressedUntil=this.time+.75;bot.ai.decision=0;}
    }
   }
  }
  if(victim){if(!melee)a.hits++;this.damage(victim,a,melee?(a.selectedWeapon==='grenade'?75:150):damageFor(part,length),!melee&&part==='head',melee?'melee':'rifle');}
 }
 private resolveMeleeContacts(){
  for(const [a,contact]of this.meleeContacts){
   if(!a.alive||a.spectator||a.lastMeleeTime!==contact.started||a.selectedWeapon!==contact.weapon||this.isSwitching(a)){this.meleeContacts.delete(a);continue;}
   if(this.time+1e-9<contact.at)continue;
   this.meleeContacts.delete(a);
   // Both players may move during the wind-up. Resolve from the current hand/
   // eye position and aim, after this frame's movement for every actor.
   const origin=this.eye(a),direction=this.direction(a),occlusion=(ray:Vec)=>worldHit(origin,ray);
   let victim:Actor|null=null,nearest=Infinity,end:Vec|null=null;
   for(const target of this.actors)if(target!==a&&target.alive&&!target.spectator&&target.spawnSafe<=0){
    const hit=meleeHitVolumes(origin,direction,sampleHitVolumes(target,this.time),MELEE_RANGE,MELEE_RADIUS,occlusion);
    if(hit&&hit.distance<nearest){victim=target;nearest=hit.distance;end=hit.point;}
   }
   if(victim&&end){
    const shot:Shot={time:this.time,actor:a.id,origin,end,hit:victim.id,headshot:false,kind:'melee',impactOnly:true};
    this.shots.push(shot);this.events.push({type:'shot',actor:a.id,shot});
    this.damage(victim,a,contact.weapon==='grenade'?75:150,false,'melee');
   }
  }
 }
 damage(victim:Actor,killer:Actor,amount:number,headshot=false,weapon:'rifle'|'melee'='rifle',source:Vec=killer){
  if(!victim.alive||victim.spectator||killer.spectator||amount<=0)return;
  if(headshot)amount=Math.max(amount,victim.hp);
  victim.hp=Math.max(0,victim.hp-amount);victim.recoil+=.026;victim.lastHurtTime=this.time;
  // Being hit reveals a rough threat direction, not an exact target or instant aim.
  if(victim.id){const brain=victim.ai;brain.heard=this.time;brain.decision=0;brain.settled=0;brain.reaction=Math.max(brain.reaction,.3);
   let cue:Vec|undefined;
   if(!brain.sight){cue={x:killer.x+(this.random()-.5)*5,y:1.2,z:killer.z+(this.random()-.5)*5};brain.known=cue;brain.mode='investigate';}
   if(this.difficulty!=='recruit'){
    cue??={x:killer.x+(this.random()-.5)*5,y:killer.y+1.4,z:killer.z+(this.random()-.5)*5};
    rememberThreat(brain.survival,killer.id,cue,this.time,.85);brain.survival.suppressedUntil=this.time+1;
   }}
  this.events.push({type:'hurt',actor:victim.id,value:amount});
  if(victim.hp>0)return;
  victim.alive=false;victim.deaths++;victim.deadAt=this.time;victim.moving=0;victim.ads=false;victim.deathYaw=Math.atan2(victim.x-source.x,victim.z-source.z);victim.deathHeadshot=headshot;if(victim===killer)killer.kills--;else killer.kills++;this.events.push({type:'kill',actor:killer.id,victim:victim.id,headshot,weapon});
  if(victim.id===0){this.record();this.killer=killer.id;this.replay=this.history.map(s=>({...s,actors:s.actors.map(a=>({...a,pose:a.pose?{...a.pose}:undefined}))}));this.replayEnd=this.time;this.replayTime=Math.max(this.replay[0]?.time??0,this.time-3.3);this.replayShots=this.shots.filter(s=>s.time>=this.replayTime);this.state='killcam';}
 }
 finish(){
  if(this.state==='ended'||!this.actors.length)return;
  this.meleeContacts.clear();
  for(const a of this.actors)if(a.pose){a.pose.speed=0;a.pose.aim=0;}
  this.winner=this.actors.filter(a=>!a.spectator).sort((a,b)=>b.kills-a.kills||a.deaths-b.deaths)[0]??null;this.state='ended';
  // Simulation time stops here. Clear live action timestamps too, otherwise
  // renderers sampling that frozen time can stay inside a run/reload/strike.
  for(const a of this.actors)if(a.alive){
   Object.assign(a,{moving:0,vy:0,grounded:true,leftGroundAt:-Infinity,jumpStarted:-Infinity,landedAt:-Infinity,landingSpeed:0,ads:false,lean:0,recoil:0,cooldown:0,reload:0,reloadTotal:0,lastShotTime:-Infinity,lastMeleeTime:-Infinity,lastHurtTime:-Infinity,switchFrom:a.selectedWeapon,switchStarted:-Infinity});
   a.ai.path=[];a.ai.mode='idle';a.ai.sight=false;a.ai.target=null;
  }
  this.events.push({type:'end',actor:this.winner?.id??0});
 }
 skipReplay(){if(this.state!=='killcam')return;this.spawn(this.player);this.state='playing';this.history=[];this.replay=[];}
 move(a:Actor,dx:number,dz:number,dt:number,jump=false,colliders?:readonly CollisionActor[]){
  if(this.state!=='playing'||!a.alive||a.spectator)return;
  const wasGrounded=a.grounded,oldX=a.x,oldZ=a.z;
  if(jump&&a.grounded){if(a.stance!=='stand')a.stance='stand';else{a.vy=RULES.jump;a.grounded=false;a.ads=false;a.jumpStarted=this.time;}}
  a.eyeHeight=advanceStanceHeight(a.eyeHeight,a.stance,dt);
  const oldY=a.y,airborne=!a.grounded;
  if(!a.grounded||a.y>0){a.vy-=RULES.gravity*dt;a.y+=a.vy*dt;}
  const impactSpeed=Math.max(0,-a.vy);
  if(a.y<=0){a.y=0;a.vy=0;a.grounded=true;}
  for(const b of BOXES)if(a.x>b.x-b.w/2-RULES.radius&&a.x<b.x+b.w/2+RULES.radius&&a.z>b.z-b.d/2-RULES.radius&&a.z<b.z+b.d/2+RULES.radius&&oldY>=b.h-.08&&a.y<=b.h&&a.vy<=0){a.y=b.h;a.vy=0;a.grounded=true;}
  if(!a.grounded)a.ads=false;
  const speed=RULES.speed*stanceSpeedFactor(a.eyeHeight)*(a.ads?.58:1)*(a.selectedWeapon==='grenade'&&!this.isSwitching(a)?GRENADE.speedMultiplier:1);
  const movement=resolveActorMovement<CollisionActor>(a,colliders??this.actors.filter(other=>!other.spectator),dx*speed*dt,dz*speed*dt,{height:other=>(other.eyeHeight??HEIGHTS[other.stance??'stand'])+.18});
  a.x=movement.x;a.z=movement.z;
  if(a.y>0&&!BOXES.some(b=>Math.abs(a.y-b.h)<.1&&Math.abs(a.x-b.x)<b.w/2+RULES.radius&&Math.abs(a.z-b.z)<b.d/2+RULES.radius))a.grounded=false;
  if(!a.grounded)a.ads=false;
  if(wasGrounded&&!a.grounded)a.leftGroundAt=this.time;
  if(airborne&&a.grounded){a.landedAt=this.time;a.landingSpeed=impactSpeed;}
  else if(wasGrounded&&!a.grounded&&!airborne)a.jumpStarted=-Infinity;
  if(wasGrounded!==a.grounded)this.motionRecordPending=true;
  a.moving=movement.distance/Math.max(dt,.001);advanceSoldierMotion(a,dt,oldX,oldZ);
 }
 footstep(actor:Actor,previousPhase:number){
  if(actor.alive&&actor.grounded&&actor.moving>.2&&actor.pose&&crossedFootContact(previousPhase,actor.pose.phase))this.events.push({type:'step',actor:actor.id,value:actor.moving});
 }
 update(dt:number,input:Input){
  if(this.state==='killcam'){this.replayTime+=dt;if(this.replayTime>this.replayEnd+.65)this.skipReplay();return;}
  if(this.state!=='playing')return;
  this.time+=dt;this.remaining=Math.max(0,RULES.roundSeconds-this.time);if(this.remaining===0){this.finish();return;}
  for(const a of this.actors){
   if(a.spectator)continue;
   if(!a.alive){if(a.id&&this.time-a.deadAt>RULES.respawn)this.spawn(a);continue;}
   if(!this.canADS(a))a.ads=false;
   const old=a.cooldown;a.cooldown=Math.max(0,a.cooldown-dt);a.spawnSafe=Math.max(0,a.spawnSafe-dt);a.recoil*=Math.exp(-dt*4.2);
   if(a.selectedWeapon==='rifle'&&old>.65&&a.cooldown<=.65)this.events.push({type:'bolt',actor:a.id});
   if(a.reload>0){a.reload=Math.max(0,a.reload-dt);if(!a.reload){const n=Math.min(WEAPONS[a.faction].capacity-a.ammo,a.reserve);a.ammo+=n;a.reserve-=n;}}
   // Skilled bots choose shelter before reloading, with a bounded fallback.
   if(a.ammo===0&&a.cooldown===0&&!a.reload&&(a.id===0||this.difficulty==='recruit'))this.reload(a);
  }
  const p=this.player;
  if(p.alive&&!p.spectator){const l=Math.max(1,Math.hypot(input.forward,input.right));const f=input.forward/l,r=input.right/l,walk=input.walk?.55:1;
   const previousPhase=p.pose?.phase??0;
   this.move(p,(Math.sin(p.yaw)*f-Math.cos(p.yaw)*r)*walk,(Math.cos(p.yaw)*f+Math.sin(p.yaw)*r)*walk,dt,input.jump);
   this.playerHipSpread=advanceHipSpread(this.playerHipSpread,p.stance,p.moving,dt);
   p.lean=advanceLean(p,input.lean,dt);
   this.footstep(p,previousPhase);
  }
  for(const a of this.actors)if(a.id&&a.alive&&!a.spectator&&this.state==='playing')this.updateAI(a,dt);
  this.resolveMeleeContacts();
  if(this.state!=='playing')return;
  this.recordClock+=dt;if(this.recordClock>=.05||this.motionRecordPending){this.recordClock=0;this.record();}
  this.shots=this.shots.filter(s=>this.time-s.time<6);
 }
 updateAI(a:Actor,dt:number){
  const settings=DIFFICULTIES[this.difficulty],brain=a.ai,eye=this.eye(a),skilled=this.difficulty!=='recruit';brain.decision-=dt;const deciding=brain.decision<=0;
  let target=brain.target!==null?this.actors[brain.target]:undefined;
  const canSee=(other:Actor)=>{const bearing=Math.atan2(other.x-a.x,other.z-a.z),angle=Math.atan2(Math.sin(bearing-a.yaw),Math.cos(bearing-a.yaw));
   return other.alive&&!other.spectator&&other.spawnSafe<=0&&dist(a,other)<settings.awareness&&Math.abs(angle)<1.25&&visible(eye,this.eye(other));};
  let hasSight=!!target&&canSee(target);
  if(brain.decision<=0){
   brain.decision=settings.decision+this.random()*.1;
   let best:Actor|undefined,score=-Infinity;
   for(const other of this.actors)if(other!==a&&other.alive&&!other.spectator&&other.spawnSafe<=0){
    const d=dist(a,other);
    if(canSee(other)){const s=60-d+(other.id===brain.target?10:0);if(s>score){best=other;score=s;}}
   }
   if(best){if(brain.target!==best.id){brain.target=best.id;brain.sight=false;brain.seen=-100;brain.observed=null;brain.observations=[];}target=best;hasSight=true;}
   else if(this.time-brain.seen>settings.memory){brain.target=null;target=undefined;hasSight=false;brain.observed=null;brain.observations=[];if(this.time-brain.heard>settings.memory)brain.known=null;}
   if(!skilled){
    const retreat=a.reload>0||a.hp<60;
    if(brain.known&&(retreat||(!hasSight&&brain.path.length===0)||brain.engage>2.5+settings.aggression*2)){
     const goal=selectCover(a,brain.known,brain.role,retreat);brain.path=findPath(a,goal);brain.mode=retreat?'cover':brain.role?'flank':'advance';brain.engage=0;
    }else if(!hasSight&&!brain.known&&brain.path.length===0){const goal=coverPoints[Math.floor(this.random()*coverPoints.length)];brain.path=findPath(a,goal);brain.mode='patrol';}
    if(a.ammo<2&&a.reload===0&&!hasSight)this.reload(a);
   }
  }
  const survival=skilled?updateSurvival(a,this.time,dt,this.difficulty as 'regular'|'veteran',hasSight,deciding):null;
  if(survival?.reload)this.reload(a);
  if(skilled&&deciding&&!brain.survival.cover&&!hasSight&&brain.path.length===0){
   const goal=brain.known??coverPoints[Math.floor(this.random()*coverPoints.length)];brain.path=findPath(a,goal);brain.mode=brain.known?'investigate':'patrol';
  }
  if(hasSight&&target){
   // Re-peeking the same opponent requires recognition again. Hidden targets never
   // feed the observation queue, and memories cannot be used as a firing solution.
   if(!brain.sight&&this.time-brain.seen>.25){
    brain.reaction=settings.reaction+this.random()*settings.reactionJitter;brain.engage=0;brain.settled=0;brain.shotWait=.05+this.random()*.1;
    brain.observed=null;brain.observations=[];brain.observationClock=0;
    brain.biasX=this.random()*2-1;brain.biasY=this.random()*2-1;brain.driftX=0;brain.driftY=0;brain.driftClock=0;
   }
   brain.sight=true;brain.seen=this.time;brain.engage+=dt;brain.reaction=Math.max(0,brain.reaction-dt);brain.observationClock-=dt;
   if(brain.observationClock<=0){brain.observationClock=settings.observation*(.85+this.random()*.3);brain.observations.push({ready:this.time+settings.latency,point:{x:target.x,y:target.y+target.eyeHeight*.65,z:target.z}});}
   while(brain.observations.length&&brain.observations[0].ready<=this.time){brain.observed=brain.observations.shift()!.point;brain.known={...brain.observed};if(skilled)rememberThreat(brain.survival,target.id,{...brain.observed,y:brain.observed.y+.55},this.time,1);}
   brain.driftClock-=dt;
   if(brain.driftClock<=0){brain.driftClock=.35+this.random()*.35;brain.driftGoalX=this.random()*2-1;brain.driftGoalY=this.random()*2-1;}
   brain.driftX=lerp(brain.driftX,brain.driftGoalX,1-Math.exp(-dt*3));brain.driftY=lerp(brain.driftY,brain.driftGoalY,1-Math.exp(-dt*3));
   brain.settled+=dt*(a.moving>.5?.35:1);
   if(a.cooldown<=0)brain.shotWait=Math.max(0,brain.shotWait-dt);
   a.ads=this.canADS(a)&&brain.reaction<settings.reaction*.7&&!survival?.fastMove&&!survival?.lookAt;
   if(!a.reload&&brain.path.length===0&&(!skilled||!brain.survival.cover)){brain.mode='engage';a.stance=brain.observed&&dist(a,brain.observed)>16&&brain.role===0?'crouch':'stand';}
   if(brain.observed&&!survival?.lookAt){
    // Persistent motor error is in world metres; it remains meaningful at close
    // range. The rendered rifle and the actual ray use this same imperfect aim.
    const observed=brain.observed,bearing=Math.atan2(observed.x-eye.x,observed.z-eye.z);
    const error=(settings.errorFloor+(settings.error-settings.errorFloor)*Math.exp(-brain.settled/settings.settle))*(1+Math.min(.55,a.moving*.15));
    const lateral=(brain.biasX+brain.driftX*.3)*error,vertical=(brain.biasY+brain.driftY*.3)*error*.65;
    const aim={x:observed.x+Math.cos(bearing)*lateral,y:observed.y+vertical,z:observed.z-Math.sin(bearing)*lateral};
    const goal=Math.atan2(aim.x-eye.x,aim.z-eye.z),pitchGoal=Math.atan2(aim.y-eye.y,dist(eye,aim));
    const diff=Math.atan2(Math.sin(goal-a.yaw),Math.cos(goal-a.yaw)),motor=1-Math.exp(-dt*settings.tracking);
    a.yaw+=clamp(diff*motor,-dt*settings.turn,dt*settings.turn);a.pitch+=clamp((pitchGoal-a.pitch)*motor,-dt*settings.turn*.7,dt*settings.turn*.7);
    // Readiness is evaluated against the perceived aim point, never the exact
    // target hitbox; the bot must commit to shots that can physically miss.
    if((!survival||survival.canFire)&&brain.reaction===0&&brain.shotWait===0&&Math.abs(diff)<.12&&Math.abs(pitchGoal-a.pitch)<.12&&!a.reload&&a.cooldown<=0){
     const before=a.shots;this.fire(a,a.ammo===0&&a.reserve===0);if(a.shots>before)brain.shotWait=settings.hesitation*(.75+this.random()*.5);
    }
   }
  }else{brain.sight=false;brain.observations=[];brain.observationClock=0;a.ads=false;a.pitch=lerp(a.pitch,0,Math.min(1,dt*3));}
  let dx=0,dz=0;
  if(target?.alive&&brain.known&&a.ammo===0&&a.reserve===0){if(brain.path.length===0)brain.path=findPath(a,brain.known);brain.mode='melee';a.ads=false;}
  if(brain.path.length){
   const p=brain.path[0],len=dist(a,p),arrival=skilled&&brain.survival.cover&&brain.path.length===1?.12:.45;
   if(len<arrival)brain.path.shift();else{dx=(p.x-a.x)/len;dz=(p.z-a.z)/len;if(!hasSight&&!survival?.lookAt){const goal=Math.atan2(dx,dz);a.yaw+=Math.atan2(Math.sin(goal-a.yaw),Math.cos(goal-a.yaw))*Math.min(1,dt*6);}if(!skilled||!brain.survival.cover)a.stance='stand';}
  }else if(hasSight&&target&&dist(a,target)<8&&(!skilled||!brain.survival.cover)){dx=Math.cos(a.yaw)*brain.strafe*.6;dz=-Math.sin(a.yaw)*brain.strafe*.6;}
  if(survival?.lookAt){const goal=Math.atan2(survival.lookAt.x-a.x,survival.lookAt.z-a.z),diff=Math.atan2(Math.sin(goal-a.yaw),Math.cos(goal-a.yaw));a.yaw+=clamp(diff,-dt*settings.turn,dt*settings.turn);a.ads=false;}
  const before={x:a.x,z:a.z},previousPhase=a.pose?.phase??0;this.move(a,dx*settings.speed,dz*settings.speed,dt);
  this.footstep(a,previousPhase);
  if(Math.hypot(dx,dz)>.1&&dist(before,a)<.001){brain.stuck+=dt;if(brain.stuck>.5){brain.path=[];brain.decision=0;brain.strafe*=-1;brain.stuck=0;if(skilled&&brain.survival.cover){brain.survival.avoid={...brain.survival.cover.hide};brain.survival.cover=null;brain.survival.phase='none';}}}else brain.stuck=0;
 }
 record(){this.motionRecordPending=false;this.history.push({time:this.time,actors:this.actors.map(a=>({id:a.id,pose:a.pose?{...a.pose}:undefined,x:a.x,y:a.y,z:a.z,yaw:a.yaw,pitch:a.pitch,stance:a.stance,eyeHeight:a.eyeHeight,spectator:a.spectator,alive:a.alive,ads:a.ads,moving:a.moving,lean:a.lean,recoil:a.recoil,ammo:a.ammo,reserve:a.reserve,hp:a.hp,cooldown:a.cooldown,reload:a.reload,reloadTotal:a.reloadTotal,deadAt:a.deadAt,lastShotTime:a.lastShotTime,lastHurtTime:a.lastHurtTime,lastMeleeTime:a.lastMeleeTime,selectedWeapon:a.selectedWeapon,switchFrom:a.switchFrom,switchStarted:a.switchStarted,switchDuration:a.switchDuration,deathYaw:a.deathYaw,deathHeadshot:a.deathHeadshot,grounded:a.grounded,vy:a.vy,leftGroundAt:a.leftGroundAt,jumpStarted:a.jumpStarted,landedAt:a.landedAt,landingSpeed:a.landingSpeed}))});while(this.history.length&&this.time-this.history[0].time>4.5)this.history.shift();}
 replayFrame(){
  if(!this.replay.length)return null;let i=this.replay.findIndex(s=>s.time>=this.replayTime);if(i<0)return this.replay.at(-1)!;if(i===0)return this.replay[0];const a=this.replay[i-1],b=this.replay[i],t=clamp((this.replayTime-a.time)/(b.time-a.time||1),0,1);
  return{time:this.replayTime,actors:a.actors.map((v,n)=>{
   const next=b.actors[n],now=this.replayTime;
   if(t>=1)return{...next,pose:next.pose?{...next.pose}:undefined};
   if(!v.alive&&next.alive)return{...v,pose:v.pose?{...v.pose}:undefined};
   const takeoff=next.leftGroundAt>v.leftGroundAt&&next.leftGroundAt<=now;
   const landed=next.landedAt>v.landedAt&&next.landedAt<=now;
   const leftGroundAt=takeoff?next.leftGroundAt:v.leftGroundAt,landedAt=landed?next.landedAt:v.landedAt;
   const grounded=takeoff||landed?landedAt>=leftGroundAt:v.grounded;
   const jumpStarted=takeoff?next.jumpStarted:v.jumpStarted;
   let y=lerp(v.y,next.y,t),vy=lerp(v.vy,next.vy,t);
   // Events between the 20 Hz snapshots must appear at their recorded time,
   // not one snapshot later, or the replay walks in midair before jumping.
   if(next.leftGroundAt>a.time&&next.leftGroundAt<=b.time&&!takeoff){y=v.y;vy=0;}
   if(takeoff&&!landed){
    const weight=clamp((now-leftGroundAt)/(b.time-leftGroundAt||1),0,1);
    y=lerp(v.y,next.y,weight);vy=(jumpStarted===leftGroundAt?RULES.jump:0)-RULES.gravity*(now-leftGroundAt);
   }else if(!grounded&&next.grounded)vy=v.vy-RULES.gravity*(now-a.time);
   if(next.landedAt>a.time&&next.landedAt<=b.time)y=lerp(v.y,next.y,clamp((now-a.time)/(next.landedAt-a.time),0,1));
   if(landed){y=next.y;vy=0;}
   const pose=v.pose&&next.pose?Object.fromEntries(Object.keys(v.pose).map(key=>[key,lerp(v.pose![key as keyof SoldierMotionState],next.pose![key as keyof SoldierMotionState],t)])) as unknown as SoldierMotionState:v.pose?{...v.pose}:undefined;
   return{...(t>=1?next:v),pose,grounded,leftGroundAt,jumpStarted,landedAt,landingSpeed:landed?next.landingSpeed:v.landingSpeed,vy,
    x:lerp(v.x,next.x,t),y,z:lerp(v.z,next.z,t),yaw:v.yaw+Math.atan2(Math.sin(next.yaw-v.yaw),Math.cos(next.yaw-v.yaw))*t,pitch:lerp(v.pitch,next.pitch,t),eyeHeight:lerp(v.eyeHeight,next.eyeHeight,t)};
  })};
 }
}
