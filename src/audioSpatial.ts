import {clamp,worldHit,type Vec} from './config';

/** The game faces +Z at yaw zero; its screen-right axis is world -X. */
export function listenerBasis(yaw:number,pitch=0){
 const sy=Math.sin(yaw),cy=Math.cos(yaw),sp=Math.sin(pitch),cp=Math.cos(pitch);
 return {forward:{x:sy*cp,y:sp,z:cy*cp},up:{x:-sy*sp,y:cp,z:-cy*sp},right:{x:-cy,y:0,z:sy}};
}

/** Obstruction is deliberately modest: cover muffles, rather than silences, a shot. */
export function soundEnvironment(origin:Vec,listener:Vec){
 const dx=origin.x-listener.x,dy=origin.y-listener.y,dz=origin.z-listener.z,distance=Math.hypot(dx,dy,dz);
 const occluded=distance>.25&&worldHit(listener,{x:dx/distance,y:dy/distance,z:dz/distance})<distance-.18;
 return {distance,occluded,gain:occluded?.43:1,cutoff:occluded?1050:clamp(16000-distance*200,4600,16000)};
}
