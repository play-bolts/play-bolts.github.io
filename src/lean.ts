import {ARENA,BOXES,RULES,clamp,rayBox,type Box,type Vec} from './config';

export interface LeanActor {x:number;y:number;z:number;yaw:number;eyeHeight:number;lean:number}
// Covers the near plane at the game's widest normal FOV, with room around the
// eye at crate edges. This is camera clearance, separate from body collision.
export const LEAN_CAMERA_RADIUS=.16;
const LEAN_SKIN=.001;

/** Sweep the eye from the body's center to the requested lateral offset.
 * Checking the whole segment prevents corner/very thin cover tunnelling. The
 * resulting partial lean is stable against a wall instead of resetting to zero.
 * Rust's constrain_lean mirrors these constants and slab intersection rules.
 */
export function constrainLean(actor:LeanActor,desired:number,boxes:readonly Box[]=BOXES):number {
 desired=clamp(desired,-1,1);
 const distance=Math.abs(desired)*RULES.leanDistance;
 if(distance<1e-9)return 0;
 const start={x:actor.x,y:actor.y+actor.eyeHeight,z:actor.z};
 const delta={x:-Math.cos(actor.yaw)*desired*RULES.leanDistance,y:0,z:Math.sin(actor.yaw)*desired*RULES.leanDistance};
 let fraction=1;
 for(const box of boxes){
  const hit=rayBox(start,delta,{min:{x:box.x-box.w/2-LEAN_CAMERA_RADIUS,y:-LEAN_CAMERA_RADIUS,z:box.z-box.d/2-LEAN_CAMERA_RADIUS},max:{x:box.x+box.w/2+LEAN_CAMERA_RADIUS,y:box.h+LEAN_CAMERA_RADIUS,z:box.z+box.d/2+LEAN_CAMERA_RADIUS}});
  if(hit<=fraction)fraction=Math.max(0,hit-LEAN_SKIN/distance);
 }
 // Explicit bounds keep the camera inside the domain even at wall seams and
 // when collision fixtures omit the rendered outer wall boxes.
 if(start.y<ARENA.wallHeight+LEAN_CAMERA_RADIUS){
  for(const [origin,movement,extent] of [[start.x,delta.x,ARENA.width/2],[start.z,delta.z,ARENA.depth/2]]){
   if(Math.abs(movement)<1e-9)continue;
   const edge=Math.sign(movement)*(extent-LEAN_CAMERA_RADIUS);
   fraction=Math.min(fraction,Math.max(0,(edge-origin)/movement-LEAN_SKIN/distance));
  }
 }
 return desired*clamp(fraction,0,1);
}

export function advanceLean(actor:LeanActor,input:number,dt:number,boxes:readonly Box[]=BOXES):number {
 const next=actor.lean+(clamp(input,-1,1)-actor.lean)*(1-Math.exp(-12*Math.max(0,dt)));
 return constrainLean(actor,next,boxes);
}

/** Position only: leaning never alters the view's yaw, pitch or roll. */
export function leanEye(actor:LeanActor,lean=actor.lean,boxes:readonly Box[]=BOXES):Vec {
 const lateral=constrainLean(actor,lean,boxes)*RULES.leanDistance;
 return {x:actor.x-Math.cos(actor.yaw)*lateral,y:actor.y+actor.eyeHeight,z:actor.z+Math.sin(actor.yaw)*lateral};
}
