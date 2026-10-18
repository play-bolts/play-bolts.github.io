import type {Faction} from './config';

type Band=readonly[frequency:number,q:number];
type Envelope=readonly(readonly[time:number,gain:number])[];
type RifleSound={bands:readonly Band[];attack:readonly number[];body:readonly number[];tail:readonly number[];envelope:Envelope;roughness:number;roughHz:number;shock:number;reflections:readonly(readonly[number,number])[]};

/** Original resonant-noise recipes. Phase spectra and envelopes were compared with
 * multiple recorded shots; no recorded samples or dense spectral data are shipped. */
export const RIFLE_SOUND:Record<Faction,RifleSound>={
 british:{
  bands:[[176,1.4],[313,2.2],[548,2.1],[1100,1],[2250,.8],[5800,.7]],
  attack:[.293,.147,.284,.731,.184,.285],body:[.475,.600,.368,.267,.225,.060],tail:[.644,.439,.272,.304,.189,.055],
  envelope:[[0,0],[.001,0.7],[.006,1],[.030,.94],[.070,.79],[.14,.57],[.23,.34],[.35,.20],[.48,.06],[.65,.005],[.82,0]],
  roughness:.09,roughHz:43,shock:.18,reflections:[[.037,.08],[.081,.035]],
 },
 russian:{
  bands:[[186,1.8],[245,2.5],[414,2],[650,2.1],[1250,1],[2600,.8],[6200,.7]],
  attack:[.378,.380,.115,.252,.450,.224,.400],body:[.550,.268,.374,.389,.310,.158,.055],tail:[.888,.177,.197,.092,.143,.198,.055],
  envelope:[[0,0],[.001,0.75],[.007,1],[.035,.87],[.085,.73],[.14,.65],[.23,.55],[.35,.32],[.49,.07],[.68,.004],[.82,0]],
  roughness:.16,roughHz:71,shock:.10,reflections:[[.024,.055],[.061,.045],[.112,.025]],
 },
 german:{
  bands:[[157,1.5],[339,2.5],[583,2.5],[950,1.5],[2300,.8],[6500,.65]],
  attack:[.155,.413,.277,.360,.713,.297],body:[.163,.563,.257,.527,.387,.150],tail:[.550,.280,.153,.361,.510,.129],
  envelope:[[0,0],[.0006,.85],[.005,.80],[.025,.79],[.045,1],[.14,.94],[.24,.94],[.33,.88],[.38,.43],[.46,.17],[.60,.015],[.82,0]],
  roughness:.15,roughHz:113,shock:.035,reflections:[[.014,.055],[.049,.04]],
 },
};

const bell=(time:number,center:number,width:number)=>Math.exp(-Math.pow((time-center)/width,2));
const smooth=(x:number)=>{const t=Math.max(0,Math.min(1,x));return t*t*(3-2*t);};
function envelope(points:Envelope,time:number){
 for(let i=1;i<points.length;i++)if(time<points[i][0]){const [ta,a]=points[i-1],[tb,b]=points[i];return a+(b-a)*smooth((time-ta)/(tb-ta));}
 return 0;
}
/** Unit-RMS band-pass noise. Separate seeds avoid the identical noise texture
 * that previously made all three rifles sound like EQ variants of one sample. */
function resonantNoise(length:number,rate:number,frequency:number,q:number,seed:number){
 const output=new Float32Array(length),w=2*Math.PI*frequency/rate,alpha=Math.sin(w)/(2*q),a0=1+alpha;
 const b0=alpha/a0,b2=-b0,a1=-2*Math.cos(w)/a0,a2=(1-alpha)/a0;
 let state=seed>>>0,x1=0,x2=0,y1=0,y2=0,power=0;
 for(let i=-1024;i<length;i++){
  state^=state<<13;state^=state>>>17;state^=state<<5;
  const x=(state>>>0)/2147483648-1,y=b0*x+b2*x2-a1*y1-a2*y2;x2=x1;x1=x;y2=y1;y1=y;
  if(i>=0){output[i]=y;power+=y*y;}
 }
 const gain=1/Math.sqrt(power/length||1);for(let i=0;i<length;i++)output[i]*=gain;
 return output;
}

/** Remove inaudible DC/rumble, round only large peaks, and leave mix headroom.
 * The final fades also prevent clicks when a one-shot buffer begins or ends. */
function finish(samples:Float32Array,rate:number,ceiling:number,drive=0){
 const pole=Math.exp(-2*Math.PI*28/rate);let previous=0,filtered=0,peak=0;
 for(let i=0;i<samples.length;i++){
  const input=samples[i];filtered=pole*(filtered+input-previous);previous=input;
  const value=drive?Math.tanh(filtered*drive)/drive:filtered;
  samples[i]=value*Math.min(1,i/(rate*.00015),(samples.length-1-i)/(rate*.02));peak=Math.max(peak,Math.abs(samples[i]));
 }
 const gain=ceiling/Math.max(peak,.001);for(let i=0;i<samples.length;i++)samples[i]*=gain;
 samples[0]=0;samples[samples.length-1]=0;
 return samples;
}

/** Short, increasingly dark reflections give the report depth without allocating
 * live delay/convolution nodes per shot or washing out its directional cue. */
function reflections(samples:Float32Array,rate:number,seed:number,timeScale=1){
 const direct=samples.slice(),times=[.019,.033,.057,.089,.131,.187,.271];
 for(let tap=0;tap<times.length;tap++){
  const delay=times[tap]*(1+(((seed>>>tap)&15)-7)*.003),offset=Math.round(delay*timeScale*rate);
  const gain=.15*Math.exp(-delay*8),pole=Math.exp(-2*Math.PI*(3800/(1+delay*9))/rate);let filtered=0;
  for(let i=offset;i<samples.length;i++){
   const time=(i-offset)/rate/timeScale;
   filtered=(1-pole)*direct[i-offset]+pole*filtered;
   samples[i]+=filtered*gain*(1-smooth((time-.18)/.20));
  }
 }
}

/** One mono shot carries its complete crack/body/tail through the same spatial route. */
export function synthesizeRifle(faction:Faction,sampleRate:number,seed=0x51f15e):Float32Array{
 // Compress the Kar98k's authored timing by 20% while retaining its resonant
 // frequencies. Playback-rate changes would raise its pitch by 25% as well.
 const timeScale=faction==='german'?.8:1;
 const p=RIFLE_SOUND[faction],length=Math.ceil(sampleRate*.82*timeScale),out=new Float32Array(length);
 const salt={british:0x2510b2,russian:0x6e4181,german:0x934fb3}[faction];
 const bands=p.bands.map(([hz,q],i)=>resonantNoise(length,sampleRate,hz,q,(seed^salt^Math.imul(i+1,0x9e3779b9))>>>0));
 const crack=resonantNoise(length,sampleRate,8200,.55,seed^0x2fd76a);
 const thump={british:.62,russian:.84,german:.44}[faction];
 for(let i=0;i<length;i++){
  const seconds=i/sampleRate,t=seconds/timeScale,body=smooth((t-.012)/.028),tail=smooth((t-.11)/.075);
  let value=0;
  for(let b=0;b<bands.length;b++){
   const initial=p.attack[b]+(p.body[b]-p.attack[b])*body;
   value+=bands[b][i]*(initial+(p.tail[b]-initial)*tail);
  }
  const rough=1+p.roughness*(.65*Math.sin(2*Math.PI*p.roughHz*seconds)+.35*Math.sin(2*Math.PI*p.roughHz*1.618*seconds+.8));
  const shock=p.shock*Math.sin(2*Math.PI*93*seconds)*Math.exp(-t/.008);
  // Independent micro-transients and a short pressure pulse avoid the old
  // single-envelope filtered-hiss attack. The low body has audible harmonics
  // for small phone speakers, rather than relying only on sub-bass.
  const attack=smooth(t/.0003),pressure=(1-t/.0012)*Math.exp(-t/.0012);
  const fracture=crack[i]*(Math.exp(-t/.0045)+.28*bell(t,.0065,.002));
  const phase=2*Math.PI*(85*seconds+1.8*timeScale*(1-Math.exp(-t/.023)));
  const punch=(Math.sin(phase)+.22*Math.sin(phase*2.03))*(1-Math.exp(-t/.001))*Math.exp(-t/.043)*thump;
  const mechanical=(Math.sin(2*Math.PI*1320*seconds)+.4*Math.sin(2*Math.PI*3130*seconds))*Math.exp(-t/.017)*.055;
  out[i]=(value*rough+shock)*envelope(p.envelope,t)+attack*(pressure*.95+fracture*.42+punch+mechanical);
 }
 const direct=out.slice();
 for(const [delay,gain] of p.reflections){const offset=Math.round(delay*timeScale*sampleRate);for(let i=offset;i<length;i++)out[i]+=direct[i-offset]*gain;}
 reflections(out,sampleRate,seed,timeScale);
 return finish(out,sampleRate,.88,.48);
}

export type CombatSound='swing'|'shot-impact'|'melee-impact';
export const COMBAT_SOUNDS:readonly CombatSound[]=['swing','shot-impact','melee-impact'];
/** Original short Foley-like layers, rendered once per variant in the warmup
 * worker. Swing is deliberately separate: a miss must not play contact audio. */
export function synthesizeCombat(kind:CombatSound,sampleRate:number,seed=0x71a9):Float32Array{
 const duration=kind==='swing'?.32:kind==='melee-impact'?.28:.22,length=Math.ceil(sampleRate*duration),out=new Float32Array(length);
 const low=resonantNoise(length,sampleRate,kind==='swing'?440:180,.7,seed^0x165b);
 const mid=resonantNoise(length,sampleRate,kind==='swing'?1450:950,.65,seed^0xa237);
 const high=resonantNoise(length,sampleRate,kind==='swing'?4600:3600,.6,seed^0x362d);
 const variation=.96+(seed%71)/900;
 for(let i=0;i<length;i++){
  const t=i/sampleRate;
  if(kind==='swing'){
   const whoosh=Math.sin(Math.PI*Math.min(1,t/.25))**2*Math.exp(-t/.28);
   const cloth=bell(t,.025,.015)+.45*bell(t,.16,.027);
   out[i]=(low[i]*.32+mid[i]*(.35+t*2.5)+high[i]*.15)*whoosh+mid[i]*cloth*.14;
  }else{
   const heavy=kind==='melee-impact',attack=smooth(t/.0004),bodyDecay=heavy?.055:.035;
   const phase=2*Math.PI*(78*t+1.1*(1-Math.exp(-t/.018)))*variation;
   const body=(Math.sin(phase)*(heavy?.9:.62)+low[i]*.42)*Math.exp(-t/bodyDecay);
   const snap=(mid[i]*.65+high[i]*(heavy?.28:.9))*Math.exp(-t/(heavy?.014:.012));
   // Several tiny irregular grains add texture to contact instead of a single
   // featureless thud. They remain quieter than the initial impact.
   const grains=bell(t,.018,.004)*.24+bell(t,.038,.007)*.14+bell(t,.071,.010)*.07;
   out[i]=attack*(body+snap+mid[i]*grains);
  }
 }
 return finish(out,sampleRate,kind==='swing'?.34:kind==='melee-impact'?.65:.48,.8);
}
