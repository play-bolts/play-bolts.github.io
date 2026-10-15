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

/** One mono shot carries its complete crack/body/tail through the same spatial route. */
export function synthesizeRifle(faction:Faction,sampleRate:number,seed=0x51f15e):Float32Array{
 const p=RIFLE_SOUND[faction],length=Math.ceil(sampleRate*.82),out=new Float32Array(length);
 const salt={british:0x2510b2,russian:0x6e4181,german:0x934fb3}[faction];
 const bands=p.bands.map(([hz,q],i)=>resonantNoise(length,sampleRate,hz,q,(seed^salt^Math.imul(i+1,0x9e3779b9))>>>0));
 let peak=0;
 for(let i=0;i<length;i++){
  const t=i/sampleRate,body=smooth((t-.012)/.028),tail=smooth((t-.11)/.075);
  let value=0;
  for(let b=0;b<bands.length;b++){
   const initial=p.attack[b]+(p.body[b]-p.attack[b])*body;
   value+=bands[b][i]*(initial+(p.tail[b]-initial)*tail);
  }
  const rough=1+p.roughness*(.65*Math.sin(2*Math.PI*p.roughHz*t)+.35*Math.sin(2*Math.PI*p.roughHz*1.618*t+.8));
  const shock=p.shock*Math.sin(2*Math.PI*93*t)*Math.exp(-t/.008);
  out[i]=(value*rough+shock)*envelope(p.envelope,t);
 }
 const direct=out.slice();
 for(const [delay,gain] of p.reflections){const offset=Math.round(delay*sampleRate);for(let i=offset;i<length;i++)out[i]+=direct[i-offset]*gain;}
 for(const value of out)peak=Math.max(peak,Math.abs(value));
 const normalization=.88/Math.max(peak,.001);
 for(let i=0;i<length;i++)out[i]*=normalization*Math.min(1,(length-i)/(sampleRate*.02));
 out[0]=0;
 return out;
}
