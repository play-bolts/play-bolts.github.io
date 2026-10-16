import {RULES,clamp,lerp} from './config';
import {resolveActorMovement,type CollisionActor} from './actorCollision';

interface Body extends CollisionActor {spectator:boolean;grounded:boolean;vy:number;moving:number;spawnGeneration?:number}
interface Frame {time:number;actors:readonly Body[]}
const MAX_EXTRAPOLATION=.1,MAX_SPEED=RULES.speed*1.08;
const continuous=(a:Body,b:Body)=>a.alive===b.alive&&a.spectator===b.spectator&&a.spawnGeneration===b.spawnGeneration&&Math.hypot(b.x-a.x,b.y-a.y,b.z-a.z)<3;

/** Collision queries sample authoritative history, never the delayed display
 * actors. Future positions use at most 100ms of velocity and stay outside map
 * geometry. Replay queries the same timeline as initial prediction. */
export function sampleNetworkColliders(frames:readonly Frame[],time:number,selfId:number):CollisionActor[]{
 if(!frames.length)return[];
 const latest=frames[frames.length-1],after=frames.find(frame=>frame.time>=time)??latest,index=frames.indexOf(after),before=frames[Math.max(0,index-1)];
 const alpha=clamp((time-before.time)/(after.time-before.time||1),0,1);
 const result:CollisionActor[]=[];
 for(const authority of latest.actors){
  if(authority.id===selfId||!authority.alive||authority.spectator)continue;
  const b=after.actors.find(actor=>actor.id===authority.id)??authority,a=before.actors.find(actor=>actor.id===authority.id)??b;
  const body:Body={...b};
  if(time<=latest.time&&continuous(a,b)){
   for(const key of ['x','y','z'] as const)body[key]=lerp(a[key],b[key],alpha);
   body.eyeHeight=lerp(a.eyeHeight??1.65,b.eyeHeight??1.65,alpha);
  }else if(time>latest.time&&before!==after&&continuous(a,b)&&b.moving>.01){
   const dt=Math.min(MAX_EXTRAPOLATION,time-latest.time),span=after.time-before.time;
   const vx=(b.x-a.x)/span,vz=(b.z-a.z)/span,scale=Math.min(1,MAX_SPEED/(Math.hypot(vx,vz)||1));
   const moved=resolveActorMovement(body,[],vx*scale*dt,vz*scale*dt);body.x=moved.x;body.z=moved.z;
  }
  if(time>latest.time&&!b.grounded){const dt=Math.min(MAX_EXTRAPOLATION,time-latest.time);body.y=Math.max(0,b.y+b.vy*dt-RULES.gravity*dt*dt/2);}
  result.push({id:body.id,x:body.x,y:body.y,z:body.z,alive:body.alive,eyeHeight:body.eyeHeight,stance:body.stance});
 }
 return result;
}
