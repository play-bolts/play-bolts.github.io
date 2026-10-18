import {solveHitboxArms} from './hitboxArms';
import {sampleHitboxCore} from './hitboxCore';
import dataJson from './generated/hitboxData.json';
import {type DamagePart,type Faction,type Stance,type Vec,type WeaponSlot} from './config';
import {initialMotion,type SoldierMotionState} from './soldierMotionState';
type Q=[number,number,number,number];
type T={p:Vec;q:Q};
interface Shape {name:string;part:DamagePart;bone:number;center:number[];halfSize:number[]}
interface Atlas {shapes:Record<Faction,Shape[]>}
const data=dataJson as Atlas;
export interface HitActor {id:number;faction:Faction;x:number;y:number;z:number;yaw:number;pitch:number;stance:Stance;ads:boolean;moving:number;lean:number;alive:boolean;pose?:SoldierMotionState;grounded?:boolean;vy?:number;jumpStarted?:number;landedAt?:number;landingSpeed?:number;lastShotTime?:number;lastMeleeTime?:number;lastHurtTime?:number;reload:number;reloadTotal:number;recoil?:number;selectedWeapon?:WeaponSlot;switchStarted?:number;switchDuration?:number;switchFrom?:WeaponSlot}
export interface HitVolume {name:string;part:DamagePart;center:Vec;halfSize:Vec;rotation:Q;kind:'ellipsoid'}
const v=(a:number[]):Vec=>({x:a[0],y:a[1],z:a[2]});
const add=(a:Vec,b:Vec):Vec=>({x:a.x+b.x,y:a.y+b.y,z:a.z+b.z});
const sub=(a:Vec,b:Vec):Vec=>({x:a.x-b.x,y:a.y-b.y,z:a.z-b.z});
const inverse=(q:Q):Q=>[-q[0],-q[1],-q[2],q[3]];
function multiply(a:Q,b:Q):Q {return[a[0]*b[3]+a[3]*b[0]+a[1]*b[2]-a[2]*b[1],a[1]*b[3]+a[3]*b[1]+a[2]*b[0]-a[0]*b[2],a[2]*b[3]+a[3]*b[2]+a[0]*b[1]-a[1]*b[0],a[3]*b[3]-a[0]*b[0]-a[1]*b[1]-a[2]*b[2]];}
function rotate(p:Vec,q:Q):Vec {const tx=2*(q[1]*p.z-q[2]*p.y),ty=2*(q[2]*p.x-q[0]*p.z),tz=2*(q[0]*p.y-q[1]*p.x);return{x:p.x+q[3]*tx+q[1]*tz-q[2]*ty,y:p.y+q[3]*ty+q[2]*tx-q[0]*tz,z:p.z+q[3]*tz+q[0]*ty-q[1]*tx};}
const axis=(axis:0|1|2,angle:number):Q=>{const q:Q=[0,0,0,Math.cos(angle/2)];q[axis]=Math.sin(angle/2);return q;};
/** Body-only oriented volumes fitted to imported skin and driven by exact skeletal IK. Separate
 * limbs preserve gaps; accessories, rifles and helmet brims never take damage.
 * Physics collision continues to use RULES.radius independently of this mesh. */
export function sampleHitVolumes(actor:HitActor,time:number):HitVolume[]{
 const state=actor.pose??initialMotion(actor,time),exact=sampleHitboxCore(actor,time),bones:T[]=exact.bones.map(b=>b?{p:{x:b.position.x,y:b.position.y,z:b.position.z},q:b.rotation.toArray() as Q}:b);
 const spine=bones[1];
 solveHitboxArms(exact.pose,exact.bones[1],dataJson.rigs[actor.faction]).bones.forEach((bone,i)=>{if(bone)bones[i]={p:{x:bone.position.x,y:bone.position.y,z:bone.position.z},q:bone.rotation.toArray() as Q};});
 const lean=axis(2,actor.lean*(1-state.prone*.6)*.48),yaw=axis(1,actor.yaw),world={x:actor.x,y:actor.y,z:actor.z};
 return data.shapes[actor.faction].map(shape=>{const bone=bones[shape.bone];let center=add(bone.p,rotate(v(shape.center),bone.q)),q=bone.q;
  if(shape.bone>=1&&shape.bone<=8){center=add(spine.p,rotate(sub(center,spine.p),lean));q=multiply(lean,q);}
  return{name:shape.name,part:shape.part,center:add(world,rotate(center,yaw)),halfSize:v(shape.halfSize),rotation:multiply(yaw,q),kind:'ellipsoid'};
 });
}
/** Ray direction need not be normalized. Distance is its positive parameter,
 * matching rayBox and preserving the nearest surface across body and walls. */
export function rayHitVolumes(origin:Vec,direction:Vec,volumes:readonly HitVolume[]):{distance:number;part:DamagePart;name:string}|null {
 let best:{distance:number;part:DamagePart;name:string}|null=null;
 for(const volume of volumes){const q=inverse(volume.rotation),o=rotate(sub(origin,volume.center),q),d=rotate(direction,q),r=volume.halfSize;let a=0,b=0,c=-1;for(const key of ['x','y','z'] as const){const x=o[key]/r[key],v=d[key]/r[key];a+=v*v;b+=2*x*v;c+=x*x;}if(a<1e-15)continue;const disc=b*b-4*a*c;if(disc<0)continue;const first=(-b-Math.sqrt(disc))/(2*a),last=(-b+Math.sqrt(disc))/(2*a);if(last<0)continue;const distance=Math.max(0,first);if(!best||distance<best.distance)best={distance,part:volume.part,name:volume.name};}
 return best;
}

/** Broad bash sweep against body volumes. A candidate must also have an actual
 * body surface within reach and an unobstructed ray to that surface: widening
 * the sweep must never widen its path through walls or cover. */
export function meleeHitVolumes(origin:Vec,direction:Vec,volumes:readonly HitVolume[],range:number,radius:number,worldDistance:(direction:Vec)=>number):{distance:number;point:Vec}|null {
 let best:{distance:number;point:Vec}|null=null;
 for(const volume of volumes){
  const delta=sub(volume.center,origin),distance=Math.hypot(delta.x,delta.y,delta.z);
  if(distance<1e-9||delta.x*direction.x+delta.y*direction.y+delta.z*direction.z<=0)continue;
  const padded={...volume,halfSize:{x:volume.halfSize.x+radius,y:volume.halfSize.y+radius,z:volume.halfSize.z+radius}};
  const sweep=rayHitVolumes(origin,direction,[padded]);if(!sweep||sweep.distance>range)continue;
  const toward={x:delta.x/distance,y:delta.y/distance,z:delta.z/distance},hit=rayHitVolumes(origin,toward,[volume]);
  if(!hit||hit.distance>range||best&&hit.distance>=best.distance||worldDistance(toward)<=hit.distance)continue;
  best={distance:hit.distance,point:{x:origin.x+toward.x*hit.distance,y:origin.y+toward.y*hit.distance,z:origin.z+toward.z*hit.distance}};
 }
 return best;
}
