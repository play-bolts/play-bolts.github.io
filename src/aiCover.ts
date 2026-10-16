import {ARENA,BOXES,HEIGHTS,blocked,clamp,dist,type Vec} from './config';
import {findPath} from './navigation';

/** Only observed/heard memories enter the planner; it never reads actors. */
export interface TacticalThreat {id:number;point:Vec;time:number;confidence:number}
export interface TacticalCover {hide:Vec;peek:Vec|null;watch:Vec;stance:'crouch'|'stand';path:{x:number;z:number}[]}
type Point={x:number;z:number};
type Options={role:number;retreat:boolean;avoid?:Vec|null;occupied?:readonly Vec[]};
const BODY_RADIUS=.28,PATH_RADIUS=.31,MAX_PATHS=3;
const headHeight={stand:1.91,crouch:1.30};
const directions=Array.from({length:16},(_,i)=>({x:Math.sin(i*Math.PI/8),z:Math.cos(i*Math.PI/8)}));
// Static slabs avoid constructing 22 bounding boxes for each body/path probe.
// This is the same segment/solid visibility test as config.visible (including
// its 10 cm endpoint tolerance), with no transient objects in the inner loop.
const slabs=BOXES.map(b=>[b.x-b.w/2,b.x+b.w/2,0,b.h,b.z-b.d/2,b.z+b.d/2]);
function clearSight(x:number,y:number,z:number,target:Vec){
 const dx=target.x-x,dy=target.y-y,dz=target.z-z,length=Math.hypot(dx,dy,dz);if(length<1e-8)return true;
 const limit=1-.1/length;
 for(const b of slabs){
  let near=0,far=Infinity;
  if(Math.abs(dx)<1e-8){if(x<b[0]||x>b[1])continue;}else{const a=(b[0]-x)/dx,c=(b[1]-x)/dx;near=Math.max(near,Math.min(a,c));far=Math.min(far,Math.max(a,c));}
  if(Math.abs(dy)<1e-8){if(y<b[2]||y>b[3])continue;}else{const a=(b[2]-y)/dy,c=(b[3]-y)/dy;near=Math.max(near,Math.min(a,c));far=Math.min(far,Math.max(a,c));}
  if(Math.abs(dz)<1e-8){if(z<b[4]||z>b[5])continue;}else{const a=(b[4]-z)/dz,c=(b[5]-z)/dz;near=Math.max(near,Math.min(a,c));far=Math.min(far,Math.max(a,c));}
  if(far>=near&&near<=limit)return false;
 }
 return !(dy<0&&-y/dy<=limit);
}

function inside(p:Point){return Math.abs(p.x)<ARENA.width/2-PATH_RADIUS&&Math.abs(p.z)<ARENA.depth/2-PATH_RADIUS;}
function clearSegment(a:Point,b:Point){
 const steps=Math.max(1,Math.ceil(dist(a,b)/.12));
 for(let i=0;i<=steps;i++){const t=i/steps;if(blocked(a.x+(b.x-a.x)*t,a.z+(b.z-a.z)*t,0,PATH_RADIUS))return false;}
 return true;
}

// Face centres protect the entire body; edge points permit a short, genuinely
// reachable peek. Wall-adjacent points add retreat choices without treating the
// enclosing wall itself as protection from an opponent inside the arena.
const candidates:readonly Point[]=BOXES.flatMap(b=>{
 if(b.kind==='wall'){
  const vertical=b.d>b.w,edge=vertical?Math.sign(b.x)*(ARENA.width/2-.7):Math.sign(b.z)*(ARENA.depth/2-.7),span=vertical?ARENA.depth:ARENA.width;
  return Array.from({length:Math.ceil(span/3)},(_,i)=>vertical?{x:edge,z:-span/2+1.5+i*3}:{x:-span/2+1.5+i*3,z:edge});
 }
 const xs=[b.x-b.w/2+.3,b.x,b.x+b.w/2-.3],zs=[b.z-b.d/2+.3,b.z,b.z+b.d/2-.3];
 return [
  ...xs.flatMap(x=>[{x,z:b.z-b.d/2-.58},{x,z:b.z+b.d/2+.58}]),
  ...zs.flatMap(z=>[{x:b.x-b.w/2-.58,z},{x:b.x+b.w/2+.58,z}]),
 ];
}).filter(p=>inside(p)&&!blocked(p.x,p.z,0,PATH_RADIUS));

/** Sum of visible body fractions, weighted by memory confidence. Head/shoulder
 * probes prevent low crates or a hidden eye from masquerading as full cover.
 * `point.y` is feet height; `height` is the top of the intended stance. */
export function coverExposure(point:Vec,threats:readonly TacticalThreat[],height=headHeight.stand):number {
 let exposure=0;
 for(const threat of threats){
  const confidence=clamp(threat.confidence,0,1);if(!confidence)continue;
  const length=dist(point,threat.point)||1,sideX=(threat.point.z-point.z)/length*BODY_RADIUS,sideZ=-(threat.point.x-point.x)/length*BODY_RADIUS;
  const weight=confidence/4;
  if(clearSight(point.x,point.y+height,point.z,threat.point))exposure+=weight;
  if(clearSight(point.x-sideX,point.y+height*.76,point.z-sideZ,threat.point))exposure+=weight;
  if(clearSight(point.x+sideX,point.y+height*.76,point.z+sideZ,threat.point))exposure+=weight;
  if(clearSight(point.x,point.y+height*.4,point.z,threat.point))exposure+=weight;
 }
 return exposure;
}

function peekFrom(hide:Vec,stance:'crouch'|'stand',threats:readonly TacticalThreat[],occupied?:readonly Vec[]):Vec|null {
 let best:Vec|null=null,bestScore=Infinity;
 for(const radius of [.7,1.25,1.85])for(const direction of directions){
  const point={x:hide.x+direction.x*radius,y:hide.y,z:hide.z+direction.z*radius};
  if(!inside(point)||blocked(point.x,point.z,0,PATH_RADIUS)||occupied?.some(other=>dist(other,point)<.75)||!clearSegment(hide,point))continue;
  if(!clearSight(point.x,point.y+HEIGHTS[stance],point.z,threats[0].point))continue;
  // Avoid stepping into a second firing lane just to reacquire the main one.
  const score=radius+coverExposure(point,threats.slice(1),headHeight[stance])*5;
  if(score<bestScore){best=point;bestScore=score;}
 }
 return best;
}

export function selectTacticalCover(origin:Vec,memories:readonly TacticalThreat[],options:Options):TacticalCover|null {
 // Uncertain audio/damage cues can land inside a crate. Such a point has no
 // outward firing lane and would falsely make every location look protected.
 // Ignore it for geometric planning, leaving the sensory memory untouched so
 // the caller can still turn toward the approximate sound direction.
 const threats=memories.filter(t=>t.confidence>0&&Number.isFinite(t.point.x+t.point.y+t.point.z)&&!slabs.some(b=>t.point.x>b[0]&&t.point.x<b[1]&&t.point.y>=b[2]&&t.point.y<b[3]&&t.point.z>b[4]&&t.point.z<b[5])).slice().sort((a,b)=>b.confidence-a.confidence||b.time-a.time||a.id-b.id).slice(0,4);
 if(!threats.length||blocked(origin.x,origin.z,0,PATH_RADIUS))return null;
 const primary=threats[0],shortlist:{hide:Vec;stance:'stand'|'crouch';score:number}[]=[];
 const confidence=threats.reduce((sum,t)=>sum+clamp(t.confidence,0,1),0);
 for(const point of [{x:origin.x,z:origin.z},...candidates]){
  const travel=dist(origin,point);if(travel>13)continue;
  if(options.occupied?.some(other=>dist(other,point)<.75))continue;
  const hide={...point,y:0};
  const standing=coverExposure(hide,threats,headHeight.stand),crouching=coverExposure(hide,threats,headHeight.crouch);
  const stance=standing<=crouching+.025?'stand':'crouch',exposure=stance==='stand'?standing:crouching;
  // Cover must fully shield the main remembered opponent at the selected
  // stance. Crossfire remains a scored cost, never an invisible-target query.
  if(coverExposure(hide,[primary],headHeight[stance])>.001||exposure>confidence*.55)continue;
  const range=dist(primary.point,hide),side=((hide.x-primary.point.x)*(origin.z-primary.point.z)-(hide.z-primary.point.z)*(origin.x-primary.point.x))/Math.max(1,dist(origin,primary.point));
  const avoid=options.avoid?Math.max(0,2.6-dist(options.avoid,hide))*2.5:0;
  const score=travel*.8+exposure*12+avoid-Math.min(range,20)*(options.retreat?.11:0)-clamp(side*options.role,-3,3)*.12-(travel<.3?1.4:0);
  shortlist.push({hide,stance,score});
 }
 shortlist.sort((a,b)=>a.score-b.score);
 let best:TacticalCover|null=null,bestScore=Infinity;
 const riskCache=new Map<string,number>();
 const risk=(point:Point)=>{
  const key=`${point.x}:${point.z}`;let value=riskCache.get(key);
  if(value===undefined){
   // Routes are walked standing; a crouch-safe endpoint does not make an
   // exposed standing approach safe. Cache the field across the searches.
   value=coverExposure({...point,y:0},threats,headHeight.stand)*2.5;
   riskCache.set(key,value);
  }
  return value;
 };
 for(const candidate of shortlist.slice(0,MAX_PATHS)){
  const {hide,stance}=candidate,distance=dist(origin,hide);
  // The controller considers shelter reached at 14 cm. A slightly smaller
  // cutoff ensures a short final step is never replaced by an empty seek path.
  const path=distance<.10?[]:findPath(origin,hide,risk);
  if(distance>=.10){
   if(!path.length&&!clearSegment(origin,hide))continue;
   const points:Point[]=[origin,...path,hide];
   if(points.some((point,i)=>i>0&&!clearSegment(points[i-1],point)))continue;
   if(!path.length||dist(path.at(-1)!,hide)>.025)path.push({x:hide.x,z:hide.z});
  }
  let length=0,routeRisk=0,previous:Point=origin;
  for(const point of path){const segment=dist(previous,point);length+=segment;routeRisk+=segment*risk(point);previous=point;}
  // Do not commit to a long exposed excursion for a slightly safer endpoint.
  if(length>Math.max(5,distance*2.3+1))continue;
  const peek=peekFrom(hide,stance,threats,options.occupied);
  const score=candidate.score+length*.35+routeRisk*.5+(peek?0:options.retreat?1:5);
  if(score<bestScore){best={hide,peek,watch:{...primary.point},stance,path};bestScore=score;}
 }
 return best;
}
