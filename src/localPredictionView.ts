import {clamp,lerp,type Vec} from './config';

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
  const weight=Math.exp(-Math.max(0,now-this.at)/18);this.at=now;
  for(const key of ['x','y','z'] as const)this.error[key]*=weight;
  if(now-this.correctedAt>=100||Math.hypot(this.error.x,this.error.y,this.error.z)<.0001)this.error={x:0,y:0,z:0};
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
