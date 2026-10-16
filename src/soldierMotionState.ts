import {clamp,lerp,type Stance} from './config';
/** Simulation-owned gait state: snapshots and rewind use the same blend/phase
 * that the mesh renders, independent of local actor numbering or frame rate. */
export interface SoldierMotionState {phase:number;crouch:number;prone:number;aim:number;speed:number;forward:number;sideways:number}
interface MotionActor {id:number;x:number;z:number;yaw:number;stance:Stance;ads:boolean;moving:number;alive:boolean;pose?:SoldierMotionState}
const ease=(v:number)=>{const t=clamp(v,0,1);return t*t*(3-2*t);};
/** One cycle contains two footfalls. Shorter standing strides keep the feet
 * turning over during ordinary runs and brief changes of position. */
export function gaitRate(speed:number,crouch:number,prone:number){const stride=lerp(lerp(1.35,2.40,ease((speed-1.8)/3)),1.80,crouch);return Math.min(lerp(lerp(2.10,1.60,crouch),1.20,prone),Math.max(0,speed)/lerp(stride,1.10,prone));}
export function initialMotion(actor:MotionActor,time=0):SoldierMotionState {const crouch=Number(actor.stance==='crouch'),prone=Number(actor.stance==='prone');return{phase:time*gaitRate(actor.moving,crouch,prone)+actor.id*.19,crouch,prone,aim:Number(actor.ads),speed:actor.moving,forward:1,sideways:0};}
export function advanceSoldierMotion(actor:MotionActor,dt:number,oldX:number,oldZ:number){
 return advanceMotionBlend(actor.pose??=initialMotion(actor),actor,dt,oldX,oldZ);
}
/** Shared by simulation and renderer-only actors. The resolved movement speed
 * drives phase immediately; easing only changes the pose's movement blend. */
export function advanceMotionBlend(s:SoldierMotionState,actor:MotionActor,dt:number,oldX:number,oldZ:number){
 if(dt<=0)return s;
 const speed=actor.alive?actor.moving:0,crouch=Number(actor.stance==='crouch'),prone=Number(actor.stance==='prone'),weight=1-Math.exp(-dt*12);
 // Integrate stance transitions without delaying the first step or advancing
 // the gait after a stop. Gaussian sampling keeps the result frame-rate independent.
 const rateAt=(t:number)=>gaitRate(speed,lerp(crouch,s.crouch,Math.exp(-t*12)),lerp(prone,s.prone,Math.exp(-t*12)));
 const steps=Math.max(1,Math.ceil(dt/.02)),step=dt/steps,offset=Math.sqrt(3/5)*step*.5;
 for(let i=0;i<steps;i++){const middle=(i+.5)*step;s.phase+=step*(5*rateAt(middle-offset)+8*rateAt(middle)+5*rateAt(middle+offset))/18;}
 s.crouch=lerp(s.crouch,crouch,weight);s.prone=lerp(s.prone,prone,weight);s.aim=lerp(s.aim,Number(actor.ads),weight);s.speed=lerp(s.speed,speed,1-Math.exp(-dt*(speed>s.speed?24:12)));
 const dx=actor.x-oldX,dz=actor.z-oldZ,distance=Math.hypot(dx,dz);if(distance>.0001&&dt>0){s.forward=lerp(s.forward,(dx*Math.sin(actor.yaw)+dz*Math.cos(actor.yaw))/distance,weight);s.sideways=lerp(s.sideways,(dx*Math.cos(actor.yaw)-dz*Math.sin(actor.yaw))/distance,weight);}
 return s;
}
