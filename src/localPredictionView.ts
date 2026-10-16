import {BOXES,clamp,lerp,rayBox,worldHit,type Vec} from './config';

/** Limit only the rendered correction. The body and aim remain authoritative.
 * Sweeping an expanded box also protects the camera near plane at grazing
 * corners, where a center ray alone would not hit the crate or domain wall. */
export function clipPredictionView(position:Vec,body:Vec,eye:Vec):Vec{
 const delta={x:position.x-body.x,y:position.y-body.y,z:position.z-body.z},length=Math.hypot(delta.x,delta.y,delta.z);
 if(length<1e-8)return position;
 const direction={x:delta.x/length,y:delta.y/length,z:delta.z/length},margin=.12;
 let allowed=Math.min(length,Math.max(0,worldHit(eye,direction)-margin));
 for(const box of BOXES)allowed=Math.min(allowed,Math.max(0,rayBox(eye,direction,{min:{x:box.x-box.w/2-margin,y:-margin,z:box.z-box.d/2-margin},max:{x:box.x+box.w/2+margin,y:box.h+margin,z:box.z+box.d/2+margin}})-.001));
 const fraction=clamp(allowed/length,0,1);
 return {x:body.x+delta.x*fraction,y:body.y+delta.y*fraction,z:body.z+delta.z*fraction};
}

/** Presentation only: interpolation never feeds back into movement or aiming.
 * Reconciliation adds an error offset; ordinary input isn't eased, so releasing
 * movement cannot leave a camera spring chasing the player. */
export class LocalPredictionView {
 private previous:Vec={x:0,y:0,z:0};
 private current:Vec={x:0,y:0,z:0};
 private error:Vec={x:0,y:0,z:0};
 private at=0;
 private correctedAt=-Infinity;
 reset(position:Vec,now:number){this.previous={x:position.x,y:position.y,z:position.z};this.current={...this.previous};this.error={x:0,y:0,z:0};this.at=now;this.correctedAt=-Infinity;}
 step(before:Vec,after:Vec){this.previous={x:before.x,y:before.y,z:before.z};this.current={x:after.x,y:after.y,z:after.z};}
 private decay(now:number){
  const weight=Math.exp(-Math.max(0,now-this.at)/45);this.at=now;
  for(const key of ['x','y','z'] as const)this.error[key]*=weight;
  if(now-this.correctedAt>=200||Math.hypot(this.error.x,this.error.y,this.error.z)<.0001)this.error={x:0,y:0,z:0};
 }
 reconcile(before:Vec,after:Vec,now:number,reset=false){
  const delta={x:after.x-before.x,y:after.y-before.y,z:after.z-before.z};
  if(reset||Math.hypot(delta.x,delta.y,delta.z)>1){this.reset(after,now);return;}
  this.decay(now);
  for(const key of ['x','y','z'] as const){this.previous[key]+=delta[key];this.current[key]=after[key];this.error[key]-=delta[key];}
  if(Math.hypot(delta.x,delta.y,delta.z)>.000001)this.correctedAt=now;
 }
 sample(alpha:number,now:number):Vec{
  this.decay(now);alpha=clamp(alpha,0,1);
  return{x:lerp(this.previous.x,this.current.x,alpha)+this.error.x,y:lerp(this.previous.y,this.current.y,alpha)+this.error.y,z:lerp(this.previous.z,this.current.z,alpha)+this.error.z};
 }
}
