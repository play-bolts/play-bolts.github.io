/** Frozen pre-optimization algorithm from af984c1, shared by parity tests and
 * CPU comparisons. Keep this implementation unchanged when editing production
 * navigation. Map geometry intentionally comes from the same current config. */
import {ARENA,SPAWNS,blocked,dist} from '../src/config.ts';

const CELL=.7, W=Math.floor(ARENA.width/CELL), D=Math.floor(ARENA.depth/CELL);
const points=Array.from({length:W*D},(_,i)=>({x:(i%W+.5)*CELL-ARENA.width/2,z:(Math.floor(i/W)+.5)*CELL-ARENA.depth/2}));
const walkable=points.map(p=>!blocked(p.x,p.z,0,.43));
function nearest(p:{x:number;z:number}){let best=-1,d=Infinity;for(let i=0;i<points.length;i++)if(walkable[i]){const n=dist(points[i],p);if(n<d){d=n;best=i;}}return best;}
type RouteRisk=(point:{x:number;z:number})=>number;
export function referenceFindPath(from:{x:number;z:number},to:{x:number;z:number},risk?:RouteRisk):{x:number;z:number}[]{
 const start=nearest(from),end=nearest(to);if(start<0||end<0)return [];
 const open=new Set([start]),came=new Map<number,number>(),g=new Map([[start,0]]),f=new Map([[start,dist(points[start],points[end])]]);
 let count=0;
 while(open.size&&count++<5000){let current=-1,best=Infinity;for(const n of open){const v=f.get(n)??Infinity;if(v<best){current=n;best=v;}}
  if(current===end){const path=[points[end]];while(came.has(current)){current=came.get(current)!;path.push(points[current]);}return path.reverse().slice(1);}
  open.delete(current);const x=current%W,z=Math.floor(current/W);
  for(let dz=-1;dz<=1;dz++)for(let dx=-1;dx<=1;dx++){
   if(!dx&&!dz)continue;const nx=x+dx,nz=z+dz;if(nx<0||nx>=W||nz<0||nz>=D)continue;
   const n=nz*W+nx;if(!walkable[n])continue;
   if(dx&&dz&&(!walkable[z*W+nx]||!walkable[nz*W+x]))continue;
   const candidate=(g.get(current)??Infinity)+Math.hypot(dx,dz)*CELL*(1+(risk?Math.max(0,risk(points[n])):0));
   if(candidate<(g.get(n)??Infinity)){came.set(n,current);g.set(n,candidate);f.set(n,candidate+dist(points[n],points[end]));open.add(n);}
  }
 }return [];
}

/** The original audit's 64 spawn pairs and 200 deterministic random pairs. */
export function navigationComparisonPairs(){
 const pairs=SPAWNS.flatMap(from=>SPAWNS.map(to=>({from,to})));
 let seed=9248;
 const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/2**32;};
 for(let i=0;i<200;i++)pairs.push({from:{x:(random()-.5)*ARENA.width,z:(random()-.5)*ARENA.depth},to:{x:(random()-.5)*ARENA.width,z:(random()-.5)*ARENA.depth}});
 return pairs;
}
