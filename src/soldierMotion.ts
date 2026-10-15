import * as THREE from 'three';
import {sampleSourceMotion,sampleLoopedSourceMotion,sourceMotionAverage,sourceMotionBind,type MotionVector,type SourceMotionFrame} from './humanoidMotion';

const clamp=(v:number,a=0,b=1)=>Math.max(a,Math.min(b,v));
const ease=(v:number)=>{const t=clamp(v);return t*t*(3-2*t);};
const mix=(a:number,b:number,t:number)=>a+(b-a)*t;
const wrap=(v:number)=>((v%1)+1)%1;
const vector=(p:MotionVector)=>new THREE.Vector3(...p);
const triple=(p:THREE.Vector3)=>p.toArray() as MotionVector;
// Bounds of the soldier's boot around its ankle joint. Ground contact must
// include the toe/heel after rotation, rather than treating the ankle as a sole.
export function proceduralBootClearance(rotation:MotionVector) {
 const orientation=new THREE.Euler(...rotation);let lowest=Infinity;
 for(const x of [-.081,.081])for(const y of [-.087,.099])for(const z of [-.096,.198])
  lowest=Math.min(lowest,new THREE.Vector3(x,y,z).applyEuler(orientation).y);
 return .003-lowest;
}
function blend(a:SourceMotionFrame,b:SourceMotionFrame,t:number):SourceMotionFrame {
 return Object.fromEntries(Object.keys(a).map(key=>{const name=key as keyof SourceMotionFrame;return [name,a[name].map((v,i)=>mix(v,b[name][i],t))];})) as SourceMotionFrame;
}
export interface BodyMotionInput {
 speed:number;crouch:number;prone:number;phase:number;time:number;forward:number;sideways:number;
 grounded?:boolean;vy?:number;jumpStarted?:number;landedAt?:number;landingSpeed?:number;
}
export interface BodyMotion {
 pelvis:MotionVector;pelvisRotation:MotionVector;spineRotation:MotionVector;
 leftFoot:MotionVector;rightFoot:MotionVector;leftKnee:MotionVector;rightKnee:MotionVector;
 leftFootRotation:MotionVector;rightFootRotation:MotionVector;stage:string;
}

/** The clip provides joint directions, while the target rig retains its own
 * limb lengths. Weapon hands remain constrained separately to their contacts. */
export function sampleBodyMotion(input:BodyMotionInput):BodyMotion {
 const {speed,crouch,prone,phase,time,forward,sideways}=input;
 const moving=ease(speed/.65),run=ease((speed-1.8)/1.3),sprint=ease((speed-3.2)/1.6),p=wrap(phase);
 const idle=sampleLoopedSourceMotion('Idle_Subtle',time/2.583333+0.17);
 let gait=blend(sampleLoopedSourceMotion('Walk',p),sampleLoopedSourceMotion('Jog',p),run);
 gait=blend(gait,sampleLoopedSourceMotion('Sprint',p),sprint);
 const backwardWeight=forward<0?ease(-forward):0,strafeWeight=Math.abs(sideways)>.05?ease(Math.abs(sideways)):0;
 if(backwardWeight>0)gait=blend(gait,sampleLoopedSourceMotion('Walk_Backwards',p),backwardWeight);
 if(strafeWeight>0)gait=blend(gait,sampleLoopedSourceMotion(sideways<0?'Strafe_left':'Strafe_right',p),strafeWeight);
 let frame=blend(idle,gait,moving);
 frame=blend(frame,blend(sampleLoopedSourceMotion('Crouch_Idle',time/3.666667),sampleLoopedSourceMotion('Crouch_Walk',p),moving),crouch);
 frame=blend(frame,sampleLoopedSourceMotion('Crawl',moving>.01?p:.15),prone);
 // The unarmed source run throws its shoulders from side to side. A carried
 // rifle needs a steadier torso, while the hips still shift weight between
 // strides. Fade the correction with the same stance/air/impact clip weights
 // so it never changes a crouch, crawl or full jump pose.
 let runningStability=run*moving*(1-backwardWeight)*(1-strafeWeight)*(1-crouch)*(1-prone);
 let stage=prone>.5?'Prone':crouch>.5?(moving>.1?'Crouch walk':'Crouched'):moving>.1?(sprint>.5?'Sprint':run>.5?'Jog':'Walk'):'Idle';
 const jumpAge=time-(input.jumpStarted??-Infinity),landAge=time-(input.landedAt??-Infinity);
 if(input.grounded===false){
  // Physics launches immediately. Use the source's airborne extension rather
  // than delaying the launch for its long anticipation crouch.
  const flightAge=Number.isFinite(jumpAge)?Math.max(0,jumpAge):.20;
  const start=sampleSourceMotion('Jump_Start',.16+.84*ease(flightAge/.20));
  const air=sampleLoopedSourceMotion('Jump_air',(Number.isFinite(jumpAge)?Math.max(0,jumpAge-.20):time)/3.125);
  const airborne=blend(start,air,ease((flightAge-.12)/.16));
  const airWeight=Number.isFinite(jumpAge)?ease(flightAge/.07):1;
  frame=blend(frame,airborne,airWeight);runningStability*=1-airWeight;stage='Airborne';
 }else if(landAge>=0&&landAge<.38){
  const impact=clamp((input.landingSpeed??7.3)/7.3),weight=ease(landAge/.035)*(1-ease((landAge-.24)/.14))*impact*.72;
  frame=blend(frame,sampleSourceMotion('Jump_Land',clamp(landAge/.38)),weight);runningStability*=1-weight;stage='Landing';
 }
 const hipLine=vector(frame.rightHip).sub(vector(frame.leftHip));
 const shoulderLine=vector(frame.rightShoulder).sub(vector(frame.leftShoulder));
 const torso=vector(frame.chest).sub(vector(frame.pelvis));
 const hipYaw=Math.atan2(-hipLine.z,hipLine.x),hipRoll=Math.atan2(hipLine.y,hipLine.x);
 const pelvisRotation:MotionVector=[prone*1.52,hipYaw*.55*(1-prone),hipRoll*.6*(1-prone)*mix(1,.45,runningStability)];
 const spineRotation:MotionVector=[Math.atan2(torso.z,torso.y)-pelvisRotation[0],Math.atan2(-shoulderLine.z,shoulderLine.x)*.65-pelvisRotation[1],Math.atan2(shoulderLine.y,shoulderLine.x)*.65*mix(1,.20,runningStability)-pelvisRotation[2]];
 // The source is an unarmed, forward-pitched sprint. Carrying a rifle keeps
 // the chest nearer upright; retain a little source motion around that lean.
 spineRotation[0]=mix(spineRotation[0],.17+spineRotation[0]*.12,runningStability);
 spineRotation[0]=clamp(spineRotation[0],-.22,.95);
 const bind=blend(sourceMotionBind('Walk'),sourceMotionBind('Crawl'),prone);
 const neutral=blend(blend(sourceMotionAverage('Idle_Subtle'),sourceMotionAverage('Crouch_Idle'),crouch),sourceMotionAverage('Crawl'),prone);
 const pelvis:MotionVector=[frame.pelvis[0]*.6*mix(1,.40,runningStability),mix(mix(.84,.42,crouch),.245,prone)+(frame.pelvis[1]-neutral.pelvis[1])*.88,mix(-.105*crouch,-.07,prone)+(frame.pelvis[2]-neutral.pelvis[2])*.55];
 const rotation=new THREE.Quaternion().setFromEuler(new THREE.Euler(...pelvisRotation));
 const leg=(side:'left'|'right')=>{
  const upper=vector(frame[`${side}Knee`]).sub(vector(frame[`${side}Hip`])).normalize().multiplyScalar(.385);
  const lower=vector(frame[`${side}Foot`]).sub(vector(frame[`${side}Knee`])).normalize().multiplyScalar(.345);
  const hip=new THREE.Vector3(side==='left'?-.13:.13,-.015,0).applyQuaternion(rotation).add(vector(pelvis));
  const knee=hip.clone().add(upper),foot=knee.clone().add(lower);
  const toe=vector(frame[`${side}Toe`]).sub(vector(frame[`${side}Foot`]));
  const bindToe=vector(bind[`${side}Toe`]).sub(vector(bind[`${side}Foot`]));
  const pitch=Math.atan2(-toe.y,Math.hypot(toe.x,toe.z))-Math.atan2(-bindToe.y,Math.hypot(bindToe.x,bindToe.z));
  const footRotation:MotionVector=[mix(clamp(pitch,-.7,.9),.10,prone),mix(Math.atan2(toe.x,toe.z),Math.PI,prone),0];
  return{knee,foot,footRotation};
 };
 const left=leg('left'),right=leg('right');
 if(input.grounded!==false){
  // Preserve the source's heel rise / running flight while adapting shorter
  // legs; this also keeps stance interpolation grounded without stretched IK.
  const sourceFloor=Math.min(frame.leftFoot[1],frame.rightFoot[1]),bindFloor=Math.min(bind.leftFoot[1],bind.rightFoot[1]);
  const floor=.095+Math.max(0,sourceFloor-bindFloor)*.88;
  const correction=floor-Math.min(left.foot.y,right.foot.y);
  pelvis[1]+=correction;for(const item of [left,right]){item.foot.y+=correction;item.knee.y+=correction;}
  // Retarget the athletic source into a steadier rifle run. Keep its planted
  // ankle positions and knee bends, with a slightly shorter stride and much
  // less vertical travel of the hips. IK still uses the fixed limb lengths.
  for(const item of [left,right]){
   item.foot.z=mix(item.foot.z,pelvis[2]+(item.foot.z-pelvis[2])*.88,runningStability);
   // The imported run drives its lead knee almost level with the belt. Lower
   // the forward swing while retaining the trailing heel's natural recovery.
   const clearance=proceduralBootClearance(item.footRotation);
   const lead=ease((item.foot.z-pelvis[2]+.10)/.36)*runningStability;
   item.foot.y-=Math.max(0,item.foot.y-clearance)*lead*.42;
  }
  const settledHeight=.755+(pelvis[1]-.755)*.24;
  let hipHeight=mix(pelvis[1],settledHeight,runningStability);
  for(const [item,side] of [[left,-1],[right,1]] as const){
   const offset=new THREE.Vector3(side*.13,-.015,0).applyQuaternion(rotation);
   const dx=item.foot.x-pelvis[0]-offset.x,dz=item.foot.z-pelvis[2]-offset.z;
   const reachable=item.foot.y-offset.y+Math.sqrt(Math.max(0,.725*.725-dx*dx-dz*dz));
   hipHeight=Math.min(hipHeight,reachable);
  }
  const hipShift=hipHeight-pelvis[1];pelvis[1]=hipHeight;
  left.knee.y+=hipShift;right.knee.y+=hipShift;
  // The source's foot skeleton has different toe/ankle proportions. Preserve
  // its heel-lift pose without letting our longer boot tip through the floor;
  // the target rig's IK resolves the small change with fixed-length limbs.
  for(const item of [left,right])item.foot.y=Math.max(item.foot.y,proceduralBootClearance(item.footRotation));
  // Crawling is supported by the torso/knees as well as the feet. Planting a
  // short target leg must not pull the belly and uniform below the floor.
  const bodyClearance=Math.max(0,.245*prone-pelvis[1]);
  pelvis[1]+=bodyClearance;left.knee.y+=bodyClearance;right.knee.y+=bodyClearance;
 }
 return{pelvis,pelvisRotation,spineRotation,leftFoot:triple(left.foot),rightFoot:triple(right.foot),leftKnee:triple(left.knee),rightKnee:triple(right.knee),leftFootRotation:left.footRotation,rightFootRotation:right.footRotation,stage};
}

/** Distance-driven cycle rate avoids accelerating a stationary gait when the
 * simulation is paused. Caps keep slow crouched shuffles from becoming jittery. */
export function sourceGaitRate(speed:number,crouch:number,prone:number){
 // Each source cycle contains TWO steps. Treating its stride as one step
 // played a full run at over five footfalls per second.
 const stride=mix(mix(1.65,2.95,ease((speed-1.8)/3)),1.80,crouch);
 const limit=mix(mix(1.75,1.60,crouch),1.20,prone);
 return Math.min(limit,Math.max(0,speed)/mix(stride,1.10,prone));
}
