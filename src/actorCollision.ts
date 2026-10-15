import {HEIGHTS,RULES,blocked as worldBlocked,type Stance} from './config';

export interface CollisionActor {
  id:number;x:number;y:number;z:number;alive:boolean;stance?:Stance;eyeHeight?:number;
}
export interface ActorCollisionOptions<T extends CollisionActor> {
  /** Full body height, measured from the feet. Supports an interpolated stance. */
  height?:(actor:T)=>number;
  radius?:number;
  blocked?:(x:number,z:number,y:number,radius:number)=>boolean;
}
export interface ActorMovement {x:number;z:number;distance:number;collided:boolean}
interface Contact {time:number;nx:number;nz:number}

const SKIN=.00001,EPSILON=1e-10;
const bodyHeight=(actor:CollisionActor)=>Math.max(.1,(actor.eyeHeight??HEIGHTS[actor.stance??'stand'])+.18);

/** Move one actor without mutating it or pushing its neighbours. Circular
 * contacts are swept, then the remaining motion slides along the tangent.
 * Short world steps retain the existing crate/wall clearance predicate. */
export function resolveActorMovement<T extends CollisionActor>(actor:T,actors:readonly T[],dx:number,dz:number,options:ActorCollisionOptions<T>={}):ActorMovement {
  const result:ActorMovement={x:actor.x,z:actor.z,distance:0,collided:false};
  if(!actor.alive||!Number.isFinite(dx)||!Number.isFinite(dz))return result;
  const radius=Math.max(.01,options.radius??RULES.radius),diameter=radius*2;
  const height=options.height??bodyHeight,isBlocked=options.blocked??worldBlocked;
  const top=actor.y+height(actor);
  // Sorting gives deterministic tie-breaking independent of array order.
  const others=actors.filter(other=>other!==actor&&other.id!==actor.id&&other.alive&&
    actor.y<other.y+height(other)-SKIN&&top>other.y+SKIN).sort((a,b)=>a.id-b.id);
  const blocked=(x:number,z:number)=>isBlocked(x,z,actor.y,radius);
  const clearSegment=(x:number,z:number,nx:number,nz:number)=>{
    const steps=Math.max(1,Math.ceil(Math.hypot(nx-x,nz-z)/.04));
    for(let i=1;i<=steps;i++)if(blocked(x+(nx-x)*i/steps,z+(nz-z)*i/steps))return false;
    return true;
  };
  const penetration=(x:number,z:number)=>others.reduce((sum,other)=>sum+Math.max(0,diameter-Math.hypot(x-other.x,z-other.z))**2,0);

  // Spawn/test overlaps can start inside a cylinder. Recover the moving
  // actor only; search outward alternatives if the nearest exit meets a wall.
  // The other actor is never pushed through cover or moved at all.
  for(let pass=0;pass<8;pass++) {
    let corrected=false;
    for(const other of others) {
      const sx=result.x-other.x,sz=result.z-other.z,distance=Math.hypot(sx,sz);
      if(distance>=diameter-SKIN)continue;
      result.collided=true;
      const fallback=((Math.min(actor.id,other.id)+1)*73856093^(Math.max(actor.id,other.id)+1)*19349663)>>>0;
      const direction=distance>SKIN?Math.atan2(sz,sx):(fallback%360)*Math.PI/180+(actor.id<other.id?Math.PI:0);
      let best:{x:number;z:number;score:number;length:number}|undefined;
      const before=penetration(result.x,result.z);
      for(const angle of [0,Math.PI/8,-Math.PI/8,Math.PI/4,-Math.PI/4,Math.PI/2,-Math.PI/2]) {
        const nx=Math.cos(direction+angle),nz=Math.sin(direction+angle),along=sx*nx+sz*nz;
        const length=-along+Math.sqrt(Math.max(0,along*along+(diameter+SKIN)**2-distance*distance));
        const x=result.x+nx*length,z=result.z+nz*length;
        if(!clearSegment(result.x,result.z,x,z))continue;
        const score=penetration(x,z);
        if(score>before+EPSILON)continue;
        if(!best||score<best.score-EPSILON||(Math.abs(score-best.score)<=EPSILON&&length<best.length))best={x,z,score,length};
      }
      if(best){result.x=best.x;result.z=best.z;corrected=true;}
    }
    if(!corrected)break;
  }

  const sweepActor=(x:number,z:number,vx:number,vz:number,other:T):Contact|undefined=>{
    const sx=x-other.x,sz=z-other.z,squared=sx*sx+sz*sz,length=Math.sqrt(squared);
    const speedSquared=vx*vx+vz*vz,approach=sx*vx+sz*vz;
    if(speedSquared<EPSILON)return;
    if(squared<=(diameter+SKIN*.5)**2) {
      if(approach>=-EPSILON)return; // Permit escape from an unresolved overlap.
      return{time:0,nx:length>SKIN?sx/length:-vx/Math.sqrt(speedSquared),nz:length>SKIN?sz/length:-vz/Math.sqrt(speedSquared)};
    }
    if(approach>=0)return;
    const discriminant=approach*approach-speedSquared*(squared-diameter*diameter);
    if(discriminant<0)return;
    const time=(-approach-Math.sqrt(discriminant))/speedSquared;
    if(time<0||time>1)return;
    const hx=sx+vx*time,hz=sz+vz*time,normalLength=Math.hypot(hx,hz);
    return{time,nx:hx/normalLength,nz:hz/normalLength};
  };
  const sweepWorld=(x:number,z:number,vx:number,vz:number):Contact|undefined=>{
    if(!blocked(x+vx,z+vz))return;
    let lo=0,hi=1;
    for(let i=0;i<18;i++){const t=(lo+hi)*.5;if(blocked(x+vx*t,z+vz*t))hi=t;else lo=t;}
    const px=x+vx*lo,pz=z+vz*lo,probe=.0002;
    const hitX=Math.abs(vx)>EPSILON&&blocked(px+Math.sign(vx)*probe,pz);
    const hitZ=Math.abs(vz)>EPSILON&&blocked(px,pz+Math.sign(vz)*probe);
    if(hitX&&!hitZ)return{time:lo,nx:-Math.sign(vx),nz:0};
    if(hitZ&&!hitX)return{time:lo,nx:0,nz:-Math.sign(vz)};
    const length=Math.hypot(vx,vz);
    return{time:lo,nx:-vx/length,nz:-vz/length};
  };
  const steps=Math.max(1,Math.ceil(Math.hypot(dx,dz)/Math.min(.12,radius*.4)));
  for(let step=0;step<steps;step++) {
    let vx=dx/steps,vz=dz/steps;
    for(let iteration=0;iteration<6;iteration++) {
      const length=Math.hypot(vx,vz);if(length<SKIN)break;
      let hit=sweepWorld(result.x,result.z,vx,vz);
      for(const other of others){const contact=sweepActor(result.x,result.z,vx,vz,other);if(contact&&(!hit||contact.time<hit.time))hit=contact;}
      if(!hit){result.x+=vx;result.z+=vz;result.distance+=length;break;}
      result.collided=true;
      const t=Math.max(0,hit.time-SKIN/length),mx=vx*t,mz=vz*t;
      result.x+=mx;result.z+=mz;result.distance+=Math.hypot(mx,mz);
      vx*=1-t;vz*=1-t;
      const inward=vx*hit.nx+vz*hit.nz;
      if(inward<0){vx-=inward*hit.nx;vz-=inward*hit.nz;}else break;
    }
  }
  return result;
}
