import {DIFFICULTIES,dist,type Vec} from './config';
import {coverExposure,selectTacticalCover,type TacticalCover,type TacticalThreat} from './aiCover';
import type {Actor} from './engine';

type SkilledDifficulty='regular'|'veteran';
export interface SurvivalState {
 threats:TacticalThreat[];cover:TacticalCover|null;phase:'none'|'seek'|'hold'|'peek'|'return';phaseUntil:number;planAt:number;
 scanAt:number;scanUntil:number;scanPoint:Vec|null;scanSide:number;suppressedUntil:number;lastDamage:number;lastShot:number;
 coverSince:number;peekArrived:boolean;failedPeeks:number;avoid:Vec|null;reloadWaitSince:number;
}
export function createSurvivalState():SurvivalState{return{threats:[],cover:null,phase:'none',phaseUntil:0,planAt:0,scanAt:0,scanUntil:0,scanPoint:null,scanSide:1,suppressedUntil:-Infinity,lastDamage:-Infinity,lastShot:-Infinity,coverSince:0,peekArrived:false,failedPeeks:0,avoid:null,reloadWaitSince:Infinity};}

/** Cues are remembered independently. A report from behind does not grant a
 * target or overwrite a fresh visual observation with a precise live position. */
export function rememberThreat(state:SurvivalState,id:number,point:Vec,time:number,confidence:number){
 const old=state.threats.find(threat=>threat.id===id);
 if(old&&old.confidence>confidence&&time-old.time<.45)return;
 const threat={id,point:{...point},time,confidence};
 if(old)Object.assign(old,threat);else state.threats.push(threat);
 state.threats.sort((a,b)=>b.time-a.time||b.confidence-a.confidence);
 if(state.threats.length>3)state.threats.length=3;
}
const profiles={
 regular:{plan:1.25,hold:.85,peek:3.3,scan:4.2,scanLength:.8,health:65,exposure:4.5,relocate:9},
 veteran:{plan:.9,hold:.65,peek:3,scan:2.8,scanLength:1,health:80,exposure:3.8,relocate:7},
};
function resetCover(a:Actor){const state=a.ai.survival;if(state.cover)a.ai.path=[];state.cover=null;state.phase='none';state.failedPeeks=0;}
function holdCover(a:Actor,time:number,duration:number){const state=a.ai.survival;state.phase='hold';state.phaseUntil=time+duration;state.lastDamage=a.lastHurtTime;a.ai.path=[];}
function returnToCover(a:Actor){const state=a.ai.survival;if(!state.cover)return;state.phase='return';a.ai.path=[{x:state.cover.hide.x,z:state.cover.hide.z}];}

/** Tactical decisions use only bounded sensory memory. Shooting recognition,
 * observation latency, aim error and turning limits remain in the engine. */
export function updateSurvival(a:Actor,time:number,_dt:number,difficulty:SkilledDifficulty,hasSight:boolean,decision:boolean){
 const state=a.ai.survival,profile=profiles[difficulty],memory=DIFFICULTIES[difficulty].memory;
 state.threats=state.threats.filter(threat=>time-threat.time<memory);
 const hurt=time-a.lastHurtTime<.85,suppressed=time<state.suppressedUntil,empty=a.ammo===0,lowAmmo=a.ammo<=2&&a.reserve>0;
 const urgent=a.reload>0||empty||hurt||suppressed;
 if(lowAmmo&&state.reloadWaitSince===Infinity)state.reloadWaitSince=time;
 if(!lowAmmo)state.reloadWaitSince=Infinity;
 if(!state.threats.length||a.ammo===0&&a.reserve===0){resetCover(a);state.scanPoint=null;state.scanUntil=0;}
 // An empty firing lane calls for investigation, not another identical peek.
 // Finish the withdrawal first; pressure can still keep the bot sheltered.
 if(state.cover&&state.phase==='hold'&&state.failedPeeks>=2&&!urgent&&!lowAmmo){
  state.avoid={...state.cover.hide};resetCover(a);state.planAt=time+3;a.ai.engage=0;
 }
 if(decision&&state.threats.length&&!(a.ammo===0&&a.reserve===0)){
  let replace=false;
  if(state.cover){
   const height=state.cover.stance==='crouch'?1.30:1.91;
   replace=coverExposure(state.cover.hide,state.threats,height)>.24||state.failedPeeks>=2;
   if(!urgent&&state.phase==='hold'&&time-state.coverSince>profile.relocate){state.avoid={...state.cover.hide};replace=true;}
  }
  const need=urgent||lowAmmo||a.hp<profile.health||hasSight&&a.ai.engage>profile.exposure;
  if(time>=state.planAt&&(!state.cover&&need||replace)){
   state.planAt=time+profile.plan+(a.id%3)*.09;
   const plan=selectTacticalCover(a,state.threats,{role:a.ai.role,retreat:urgent||a.hp<profile.health,avoid:state.avoid});
   if(plan){
    state.cover=plan;state.phase='seek';state.coverSince=time;state.failedPeeks=0;state.avoid=null;state.lastDamage=a.lastHurtTime;
    a.ai.path=plan.path.map(point=>({...point}));
    if(dist(a,plan.hide)<.14)holdCover(a,time,profile.hold);
   }
  }
 }
 if(state.cover){
  const cover=state.cover;
  if((state.phase==='seek'||state.phase==='return')&&dist(a,cover.hide)<.14)holdCover(a,time,profile.hold+(a.hp<profile.health?.35:0));
  if(state.phase==='hold'){
   a.ai.path=[];
   if(!urgent&&!lowAmmo&&time>=state.phaseUntil){
    if(cover.peek){state.phase='peek';state.phaseUntil=time+3.5;state.lastShot=a.lastShotTime;state.peekArrived=false;a.ai.path=[{x:cover.peek.x,z:cover.peek.z}];}
    else if(time-state.coverSince>1.5){state.avoid={...cover.hide};state.failedPeeks=2;}
   }
  }else if(state.phase==='peek'){
   if(!state.peekArrived&&cover.peek&&dist(a,cover.peek)<.14){state.peekArrived=true;state.phaseUntil=time+profile.peek;a.ai.path=[];}
   if(a.lastShotTime>state.lastShot||urgent||time>=state.phaseUntil){
    if(a.lastShotTime>state.lastShot)state.failedPeeks=0;else if(time>=state.phaseUntil)state.failedPeeks++;
    returnToCover(a);
   }
  }
  a.stance=state.phase==='seek'&&dist(a,cover.hide)>.7?'stand':cover.stance;
  a.ai.mode=state.phase==='peek'?'peek':state.phase==='seek'?'seek-cover':state.phase==='return'?'withdraw':'cover';
 }
 // A new rear cue can interrupt tunnel vision under pressure. Otherwise scan
 // during recovery or search, never fire while the rifle is looking elsewhere.
 if(time>=state.scanUntil)state.scanPoint=null;
 if(decision&&time>=state.scanAt&&(state.phase==='hold'||!state.cover&&!hasSight||hurt||suppressed)){
  const rear=state.threats.filter(threat=>{
   const bearing=Math.atan2(threat.point.x-a.x,threat.point.z-a.z);
   return Math.abs(Math.atan2(Math.sin(bearing-a.yaw),Math.cos(bearing-a.yaw)))>1.05;
  }).sort((a,b)=>b.time-a.time||b.confidence-a.confidence)[0];
  if(rear||state.phase==='hold'||!hasSight){
   state.scanSide*=-1;
   const yaw=a.yaw+state.scanSide*(state.phase==='hold'?1.65:1.35);
   state.scanPoint=rear?{...rear.point}:{x:a.x+Math.sin(yaw)*8,y:a.y+1.4,z:a.z+Math.cos(yaw)*8};
   state.scanUntil=time+profile.scanLength;state.scanAt=time+profile.scan+(a.id%3)*.2;
  }
 }
 const holding=state.phase==='hold',travelling=state.phase==='seek'||state.phase==='return';
 // Give the bot time to reach shelter before starting a vulnerable reload, but
 // do not deadlock it empty-handed if no reachable protection can be found.
 const reload=lowAmmo&&a.reload<=0&&(holding||!state.threats.length||!state.cover||time-state.reloadWaitSince>3.5)&&(!hasSight||holding||empty);
 return{canFire:!state.scanPoint&&(!state.cover||state.phase==='peek')&&(!empty||a.reserve===0),fastMove:travelling,lookAt:state.scanPoint??(!hasSight&&state.cover?state.cover.watch:null),hold:holding,reload};
}
