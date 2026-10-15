import {HEIGHTS,clamp,lerp,type Stance} from './config';

// Reach 90% of a stance change in 0.18 seconds, independent of frame rate.
export const STANCE_RESPONSE=Math.LN10/.18;
export function advanceStanceHeight(current:number,stance:Stance,dt:number):number {
 const target=HEIGHTS[stance];
 if(dt<=0)return current;
 const next=lerp(current,target,-Math.expm1(-STANCE_RESPONSE*dt));
 return Math.abs(next-target)<.001?target:next;
}

// Movement slows with the body instead of switching instantly on keypress.
export function stanceSpeedFactor(height:number):number {
 return height>=HEIGHTS.crouch
  ?lerp(.58,1,clamp((height-HEIGHTS.crouch)/(HEIGHTS.stand-HEIGHTS.crouch),0,1))
  :lerp(.23,.58,clamp((height-HEIGHTS.prone)/(HEIGHTS.crouch-HEIGHTS.prone),0,1));
}
