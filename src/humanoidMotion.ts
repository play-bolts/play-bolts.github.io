import {SOURCE_CLIPS,SOURCE_JOINTS,SOURCE_BIND} from './generated/mesh2motionData';

export type MotionClip='Idle_A'|'Idle_Subtle'|'Walk'|'Jog'|'Sprint'|'Walk_Backwards'|'Strafe_left'|'Strafe_right'|'Crouch_Idle'|'Crouch_Walk'|'Jump_Start'|'Jump_air'|'Jump_Land'|'Crawl'|'Pistol_Reload';
export type MotionVector=[number,number,number];
export type SourceMotionFrame=Record<typeof SOURCE_JOINTS[number],MotionVector>;
function unpack(row:readonly number[]):SourceMotionFrame {
 return Object.fromEntries(SOURCE_JOINTS.map((name,index)=>[name,[row[index*3],row[index*3+1],row[index*3+2]]])) as SourceMotionFrame;
}
/** Absolute, deterministic clip sampling for live animation and replay scrubs.
 * Coordinates are metres, +Y up, +Z forward, with left limbs on negative X. */
export function sampleSourceMotion(clip:MotionClip,phase:number):SourceMotionFrame {
 const frames=SOURCE_CLIPS[clip].frames,t=Math.max(0,Math.min(1,phase))*(frames.length-1),a=Math.floor(t),b=Math.min(a+1,frames.length-1),weight=t-a;
 return unpack(frames[a].map((v,i)=>v+(frames[b][i]-v)*weight));
}
const loopFrames=new Map<MotionClip,number[][]>();
/** Locomotion clips are cyclic; several source exports finish a few centimetres
 * away from their first pose. Close that drift over the cycle, then interpolate
 * a periodic curve so neither position nor velocity snaps at the wrap. Keep
 * the clamped sampler above for one-shot actions and their authored endpoints. */
export function sampleLoopedSourceMotion(clip:MotionClip,phase:number):SourceMotionFrame {
 let frames=loopFrames.get(clip);
 if(!frames){
  const source=SOURCE_CLIPS[clip].frames,first=source[0],last=source[source.length-1];
  frames=source.slice(0,-1).map((row,index)=>{
   const p=index/(source.length-1),weight=p*p*(3-2*p);
   return row.map((value,j)=>value-(last[j]-first[j])*weight);
  });
  loopFrames.set(clip,frames);
 }
 const count=frames.length,t=(((phase%1)+1)%1)*count,index=Math.floor(t),f=t-index;
 const a=frames[(index+count-1)%count],b=frames[index],c=frames[(index+1)%count],d=frames[(index+2)%count];
 return unpack(b.map((value,j)=>.5*(2*value+(c[j]-a[j])*f+(2*a[j]-5*value+4*c[j]-d[j])*f*f+(-a[j]+3*value-3*c[j]+d[j])*f*f*f)));
}
export function sourceMotionDuration(clip:MotionClip){return SOURCE_CLIPS[clip].duration;}
export function sourceMotionAverage(clip:MotionClip){return unpack(SOURCE_CLIPS[clip].average);}
export function sourceMotionBind(clip:MotionClip){return unpack(SOURCE_BIND[SOURCE_CLIPS[clip].source]);}
