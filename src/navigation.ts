import {ARENA,BOXES,blocked,dist,visible,type Vec} from './config';
const CELL=.7, W=Math.floor(ARENA.width/CELL), D=Math.floor(ARENA.depth/CELL);
const points=Array.from({length:W*D},(_,i)=>({x:(i%W+.5)*CELL-ARENA.width/2,z:(Math.floor(i/W)+.5)*CELL-ARENA.depth/2}));
const walkable=points.map(p=>!blocked(p.x,p.z,0,.43));
function nearest(p:{x:number;z:number}){let best=-1,d=Infinity;for(let i=0;i<points.length;i++)if(walkable[i]){const n=dist(points[i],p);if(n<d){d=n;best=i;}}return best;}
export function findPath(from:{x:number;z:number},to:{x:number;z:number}):{x:number;z:number}[]{
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
   const candidate=(g.get(current)??Infinity)+Math.hypot(dx,dz)*CELL;
   if(candidate<(g.get(n)??Infinity)){came.set(n,current);g.set(n,candidate);f.set(n,candidate+dist(points[n],points[end]));open.add(n);}
  }
 }return [];
}
export const coverPoints=BOXES.filter(b=>b.kind==='crate').flatMap(b=>[
 {x:b.x-b.w/2-.85,z:b.z-b.d/2-.5},{x:b.x+b.w/2+.85,z:b.z+b.d/2+.5},
 {x:b.x-b.w/2-.85,z:b.z+b.d/2+.5},{x:b.x+b.w/2+.85,z:b.z-b.d/2-.5},
 {x:b.x,z:b.z-b.d/2-.8},{x:b.x,z:b.z+b.d/2+.8},
]).filter(p=>!blocked(p.x,p.z,0,.4));
export function selectCover(origin:Vec,threat:Vec,flank:number,retreat:boolean){
 let best=coverPoints[0],score=-Infinity;
 for(const p of coverPoints){const travel=dist(origin,p),range=dist(threat,p);if(travel<1.2)continue;
  const safe=!visible({...p,y:1.05},threat),canPeek=visible({...p,x:p.x+.8,y:1.65},threat)||visible({...p,x:p.x-.8,y:1.65},threat);
  const cross=((p.x-threat.x)*(origin.z-threat.z)-(p.z-threat.z)*(origin.x-threat.x))/Math.max(1,dist(origin,threat));
  const s=(safe?12:0)+(canPeek?5:0)-travel*.55-Math.abs(range-(retreat?22:14))*.3+cross*flank*.3;
  if(s>score){score=s;best=p;}
 }return best;
}
