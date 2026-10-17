import type {MotionVector} from './humanoidMotion';

/** Lower sagittal hull of a rigid sole. Each edge's angle is the pitch at
 * which ground support passes from one vertex to the next. */
type Profile={y:number;z:number;start:number}[];
const profiles=new WeakMap<ReadonlyArray<MotionVector>,Profile>();
export const PROCEDURAL_SOLE:ReadonlyArray<MotionVector>=[
 [0,-.087,-.096],[0,-.087,.198],
];
function profile(points:ReadonlyArray<MotionVector>):Profile {
 let cached=profiles.get(points);if(cached)return cached;
 const sorted=points.map(p=>({y:p[1],z:p[2]})).sort((a,b)=>a.z-b.z||a.y-b.y);
 const hull:typeof sorted=[];
 for(const point of sorted){
  if(hull.length&&point.z===hull[hull.length-1].z)continue;
  while(hull.length>1){
   const a=hull[hull.length-2],b=hull[hull.length-1];
   if((b.z-a.z)*(point.y-a.y)-(b.y-a.y)*(point.z-a.z)>0)break;
   hull.pop();
  }
  hull.push(point);
 }
 cached=hull.map((p,i)=>({...p,start:i?Math.atan2(p.y-hull[i-1].y,p.z-hull[i-1].z):-Math.PI/2}));
 profiles.set(points,cached);return cached;
}

/** Ankle displacement for rolling without slipping. Integrate about each
 * active contact vertex; simply rotating about the ankle slides the toe,
 * and switching directly between toe pivots makes the ankle jump. */
export function soleRollOffset(rotation:MotionVector,points=PROCEDURAL_SOLE):MotionVector {
 // Ground gait uses Ry(yaw)*Rx(pitch), encoded as XYZ Euler angles.
 const [x,y]=rotation;
 const tx=Math.sin(y),ty=-Math.sin(x)*Math.cos(y),tz=Math.cos(x)*Math.cos(y);
 const pitch=Math.atan2(-ty,Math.hypot(tx,tz)),yaw=Math.atan2(tx,tz);
 const lo=Math.min(0,pitch),hi=Math.max(0,pitch),hull=profile(points);
 let distance=0;
 for(let i=0;i<hull.length;i++){
  const p=hull[i],a=Math.max(lo,p.start),b=Math.min(hi,hull[i+1]?.start??Math.PI/2);
  if(b>a)distance+=p.y*(Math.sin(a)-Math.sin(b))+p.z*(Math.cos(a)-Math.cos(b));
 }
 distance*=Math.sign(pitch);
 return [Math.sin(yaw)*distance,0,Math.cos(yaw)*distance];
}
