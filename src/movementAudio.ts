import {clamp,type Stance} from './config';
import {gaitRate} from './soldierGait';
import {synthesizeFootstep,FOOTSTEP_VARIANTS,type FootSide} from './audioSynthesis';
export {synthesizeFootstep,FOOTSTEP_VARIANTS,FOOTSTEP_STANCES,FOOTSTEP_SIDES,type FootSide} from './audioSynthesis';

export const MOVEMENT_PREVIEW_SPEED:Readonly<Record<Stance,number>>={stand:2.5,crouch:1.4,prone:.65};
export const FOOTSTEP_SEQUENCE_SEED=0x5a17;

/** A deterministic shuffled bag visits all takes before refilling. Alternating
 * feet never reuses the previous take, including across stance/bag boundaries. */
export class FootstepSequence {
 private randomState:number;private nextSide:FootSide='left';private last=-1;
 private bag:number[]=[];
 constructor(seed=FOOTSTEP_SEQUENCE_SEED){this.randomState=seed>>>0||FOOTSTEP_SEQUENCE_SEED;}
 private random(){let state=this.randomState;state^=state<<13;state^=state>>>17;state^=state<<5;this.randomState=state>>>0;return this.randomState/4294967296;}
 next(_stance:Stance):{variant:number;side:FootSide}{
  let bag=this.bag;
  if(!bag.length){
   bag=this.bag=Array.from({length:FOOTSTEP_VARIANTS},(_,index)=>index);
   for(let i=bag.length-1;i>0;i--){const j=Math.floor(this.random()*(i+1));[bag[i],bag[j]]=[bag[j],bag[i]];}
  }
  if(bag.at(-1)===this.last)[bag[0],bag[bag.length-1]]=[bag[bag.length-1],bag[0]];
  const variant=bag.pop()!,side=this.nextSide;this.last=variant;this.nextSide=side==='left'?'right':'left';
  return{variant,side};
 }
}

/** Speed affects weight, never pitch. Crouch remains quieter but still has a
 * distinct sole scrape and fabric layer at ordinary crouch speeds. */
export function footstepLevel(stance:Stance,speed:number){
 if(!Number.isFinite(speed)||speed<=.2)return 0;
 const weight=clamp(speed/4.8,0,1);
 return stance==='prone'?.19+weight*.11:stance==='crouch'?.26+weight*.20:.34+weight*.30;
}

/** The review panel renders the exact runtime samples, ordering, gain and
 * animation cadence. No preview-only EQ, normalization or playback-rate shift. */
export function renderMovementPreview(stance:Stance,sampleRate:number,options:{speed?:number;steps?:number;seed?:number}={}):Float32Array{
 const speed=options.speed??MOVEMENT_PREVIEW_SPEED[stance],steps=Math.max(1,Math.min(24,Math.trunc(options.steps??8)));
 const rate=gaitRate(speed,Number(stance==='crouch'),Number(stance==='prone')),gain=footstepLevel(stance,speed);
 if(!rate||!gain)return new Float32Array(Math.ceil(sampleRate*.25));
 const sequence=new FootstepSequence(options.seed),interval=1/(rate*2),takes=Array.from({length:steps},()=>sequence.next(stance));
 const buffers=takes.map(({variant,side})=>synthesizeFootstep(stance,sampleRate,variant,side));
 const output=new Float32Array(Math.ceil((steps-1)*interval*sampleRate)+buffers.at(-1)!.length);
 buffers.forEach((samples,index)=>{const offset=Math.round(index*interval*sampleRate);for(let i=0;i<samples.length&&offset+i<output.length;i++)output[offset+i]+=samples[i]*gain;});
 return output;
}
