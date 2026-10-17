import {ARENA,BOXES,blocked,dist,visible,type Vec} from './config';
const CELL=.7, W=Math.floor(ARENA.width/CELL), D=Math.floor(ARENA.depth/CELL);
const points=Array.from({length:W*D},(_,i)=>({x:(i%W+.5)*CELL-ARENA.width/2,z:(Math.floor(i/W)+.5)*CELL-ARENA.depth/2}));
const walkable=points.map(p=>!blocked(p.x,p.z,0,.43));
// Preserve the original dz/dx traversal and diagonal clearance. The arena is
// static; rebuilding these neighbours in every search adds no information.
const neighbours=points.map((_,current)=>{
 const edges:{node:number;cost:number}[]=[],x=current%W,z=Math.floor(current/W);
 for(let dz=-1;dz<=1;dz++)for(let dx=-1;dx<=1;dx++){
  if(!dx&&!dz)continue;const nx=x+dx,nz=z+dz;if(nx<0||nx>=W||nz<0||nz>=D)continue;
  const node=nz*W+nx;if(!walkable[node])continue;
  if(dx&&dz&&(!walkable[z*W+nx]||!walkable[nz*W+x]))continue;
  edges.push({node,cost:Math.hypot(dx,dz)*CELL});
 }
 return edges;
});
function nearest(p:{x:number;z:number}){let best=-1,d=Infinity;for(let i=0;i<points.length;i++)if(walkable[i]){const n=dist(points[i],p);if(n<d){d=n;best=i;}}return best;}

/** Indexed heap: updating an open node retains its original Set insertion
 * order, while reopening a removed node receives a new order. Equal scores
 * therefore select exactly the same route as the former linear Set scan. */
class Search {
 costs=new Float64Array(points.length);scores=new Float64Array(points.length);
 parents=new Int32Array(points.length);positions=new Int32Array(points.length);
 order=new Uint32Array(points.length);heap=new Int32Array(points.length);
 size=0;serial=0;
 reset(){this.costs.fill(Infinity);this.parents.fill(-1);this.positions.fill(-1);this.size=0;this.serial=0;}
 private before(a:number,b:number){return this.scores[a]<this.scores[b]||this.scores[a]===this.scores[b]&&this.order[a]<this.order[b];}
 private up(index:number){
  const node=this.heap[index];
  while(index>0){const parent=(index-1)>>1,other=this.heap[parent];if(!this.before(node,other))break;this.heap[index]=other;this.positions[other]=index;index=parent;}
  this.heap[index]=node;this.positions[node]=index;return index;
 }
 private down(index:number){
  const node=this.heap[index];
  while(index*2+1<this.size){
   let child=index*2+1;if(child+1<this.size&&this.before(this.heap[child+1],this.heap[child]))child++;
   const other=this.heap[child];if(!this.before(other,node))break;
   this.heap[index]=other;this.positions[other]=index;index=child;
  }
  this.heap[index]=node;this.positions[node]=index;
 }
 offer(node:number,score:number){
  this.scores[node]=score;let index=this.positions[node];
  if(index<0){index=this.size++;this.heap[index]=node;this.positions[node]=index;this.order[node]=this.serial++;}
  this.down(this.up(index));
 }
 take(){
  const node=this.heap[0];this.positions[node]=-1;this.size--;
  if(this.size){this.heap[0]=this.heap[this.size];this.positions[this.heap[0]]=0;this.down(0);}
  return node;
 }
}
// A risk callback may recursively request another route. Each active call
// leases separate scratch storage; finally also releases it when risk throws.
const searches:Search[]=[];let searchDepth=0;
export type RouteRisk=(point:{x:number;z:number})=>number;
export function findPath(from:{x:number;z:number},to:{x:number;z:number},risk?:RouteRisk):{x:number;z:number}[]{
 const start=nearest(from),end=nearest(to);if(start<0||end<0)return [];
 const search=searches[searchDepth]??=new Search();searchDepth++;
 try{
  search.reset();search.costs[start]=0;search.offer(start,dist(points[start],points[end]));
  let count=0;
  while(search.size&&count++<5000){
   const current=search.take();
   if(current===end){const path=[points[end]];for(let n=current;search.parents[n]>=0;){n=search.parents[n];path.push(points[n]);}return path.reverse().slice(1);}
   for(const edge of neighbours[current]){
    const node=edge.node;
    // Call risk for every visited edge, including non-improving ones. Its call
    // order/count and non-negative clamp are part of the existing behaviour.
    const candidate=search.costs[current]+edge.cost*(1+(risk?Math.max(0,risk(points[node])):0));
    if(candidate<search.costs[node]){search.parents[node]=current;search.costs[node]=candidate;search.offer(node,candidate+dist(points[node],points[end]));}
   }
  }
  return [];
 }finally{searchDepth--;}
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
