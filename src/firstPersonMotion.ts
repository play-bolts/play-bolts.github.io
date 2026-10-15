import {HEIGHTS,RULES,clamp,lerp,type Stance} from './config';
import {sampleSourceMotion,sampleLoopedSourceMotion,sourceMotionAverage,type MotionClip} from './humanoidMotion';

export interface FirstPersonMotionState {
 moving:number;stance:Stance;eyeHeight:number;ads:number;grounded:boolean;vy:number;
 jumpStarted:number;landedAt:number;landingSpeed:number;
}
const averages=Object.fromEntries(['Walk','Jog','Sprint','Crouch_Walk'].map(clip=>[clip,sourceMotionAverage(clip as MotionClip)]));
const smooth=(value:number)=>{const t=clamp(value,0,1);return t*t*(3-2*t);};
function gait(clip:MotionClip,phase:number){
 const frame=sampleLoopedSourceMotion(clip,phase),mean=averages[clip];
 return {
  x:(frame.chest[0]-mean.chest[0])*.17,
  y:(frame.chest[1]-mean.chest[1])*.18,
  pitch:(frame.chest[2]-mean.chest[2])*.13,
  roll:((frame.rightShoulder[1]-frame.leftShoulder[1])-(mean.rightShoulder[1]-mean.leftShoulder[1]))*.12,
 };
}

/** Small inertial response sampled from the CC0 body clips. It transforms
 * the whole held item, so neither palm loses its fitted weapon contact.
 * Absolute simulation time keeps pause and killcam scrubbing deterministic. */
export function sampleFirstPersonMotion(actor:FirstPersonMotionState,time:number){
 const phase=((time*1.65)%1+1)%1,walk=gait('Walk',phase),jog=gait('Jog',phase),run=gait('Sprint',phase),low=gait('Crouch_Walk',phase);
 const speed=clamp(actor.moving/.85,0,1),running=smooth((actor.moving-2.1)/2.4);
 const crouch=clamp((HEIGHTS.stand-actor.eyeHeight)/(HEIGHTS.stand-HEIGHTS.crouch),0,1);
 const prone=clamp((HEIGHTS.crouch-actor.eyeHeight)/(HEIGHTS.crouch-HEIGHTS.prone),0,1);
 const hip=1-clamp(actor.ads,0,1),ground=actor.grounded?1:0;
 const motion={x:0,y:0,pitch:0,roll:0};
 for(const key of ['x','y','pitch','roll'] as const){
  const standing=lerp(walk[key],lerp(jog[key],run[key],running),smooth((actor.moving-1.3)/2));
  motion[key]=lerp(standing,low[key],crouch)*speed*ground*(1-prone*.8)*hip;
 }
 // The eyes already follow the collision body's smooth stance height. Only
 // the weapon lags slightly; ADS stays exactly on the established sight axis.
 const stanceDip=Math.sin(Math.PI*crouch)*(1-prone)+Math.sin(Math.PI*prone)*.7;
 motion.y-=stanceDip*.014*hip;motion.pitch+=stanceDip*.015*hip;
 if(!actor.grounded){
  const age=Math.max(0,time-actor.jumpStarted),launch=Number.isFinite(age)?Math.sin(Math.PI*clamp(age/.18,0,1))*.012:0;
  motion.y-=launch*hip;
  motion.pitch-=clamp(actor.vy/RULES.jump,-1,1)*.022*smooth(age/.045)*hip;
 }
 const landingAge=time-actor.landedAt;
 if(landingAge>=0&&landingAge<.34&&actor.grounded){
  const t=landingAge/.34,source=sampleSourceMotion('Jump_Land',t),start=sampleSourceMotion('Jump_Land',0),end=sampleSourceMotion('Jump_Land',1);
  // Remove the source clip's different start/end heights. Its actual crouch
  // and recovery curve supplies a zero-at-both-ends landing compression.
  const compression=clamp(lerp(start.pelvis[1],end.pelvis[1],t)-source.pelvis[1],0,.5);
  const impact=clamp(actor.landingSpeed/RULES.jump,0,1);
  motion.y-=compression*.075*impact*hip;motion.pitch+=compression*.075*impact*hip;
 }
 return{position:[motion.x,motion.y,0] as [number,number,number],rotation:[motion.pitch,0,motion.roll] as [number,number,number]};
}
