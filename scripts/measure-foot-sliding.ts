// node --import tsx scripts/measure-foot-sliding.ts > temp/foot-sliding.json
import {sampleBodyMotion,sourceGaitRate,proceduralBootClearance} from '../src/soldierMotion.ts';
const rows=[];
for(const [name,speed,crouch,forward,sideways] of [
 ['walk',1.7,0,1,0],['run',4.5,0,1,0],['backward',2.5,0,-1,0],
 ['strafe',2.5,0,0,1],['diagonal',3.1,0,Math.SQRT1_2,Math.SQRT1_2],['crouch',1.3,1,1,0],
] as const){
 const rate=sourceGaitRate(speed,crouch,0),dt=1/600,velocities:number[]=[];
 let last:ReturnType<typeof sampleBodyMotion>|undefined;
 for(let i=0;i<=Math.ceil(2/rate/dt);i++){
  const pose=sampleBodyMotion({speed,crouch,prone:0,phase:i*dt*rate,time:2,forward,sideways,grounded:true});
  if(last)for(const side of ['left','right'] as const){
   const p=pose[`${side}Foot`],a=last[`${side}Foot`];
   if(p[1]-proceduralBootClearance(pose[`${side}FootRotation`])<.008&&a[1]-proceduralBootClearance(last[`${side}FootRotation`])<.008)
    velocities.push(Math.hypot((p[0]-a[0])/dt+speed*sideways,(p[2]-a[2])/dt+speed*forward));
  }
  last=pose;
 }
 rows.push({name,speed,contacts:velocities.length,meanContactSlip:velocities.reduce((a,b)=>a+b,0)/velocities.length,maxContactSlip:Math.max(...velocities)});
}
console.log(JSON.stringify(rows,null,2));
