import test from 'node:test';
import assert from 'node:assert/strict';
import {synthesizeRifle,synthesizeCombat,COMBAT_SOUNDS,SOUND_DURATION_SCALE} from '../src/audioSynthesis.ts';
import {FACTIONS,type Faction} from '../src/config.ts';

// Independent frequency-domain measurements of produced PCM, not synthesis parameters.
function spectrum(samples:Float32Array,rate:number,start:number,end:number){
 const first=Math.round(start*rate),length=Math.round(end*rate)-first;let n=1;while(n<length)n*=2;
 const real=new Float64Array(n),imag=new Float64Array(n);let energy=0;
 for(let i=0;i<length;i++){real[i]=samples[first+i]*(.5-.5*Math.cos(2*Math.PI*i/(length-1)));energy+=samples[first+i]**2;}
 for(let i=1,j=0;i<n;i++){let bit=n>>1;for(;j&bit;bit>>=1)j^=bit;j^=bit;if(i<j)[real[i],real[j]]=[real[j],real[i]];}
 for(let len=2;len<=n;len<<=1){const angle=-2*Math.PI/len;for(let i=0;i<n;i+=len)for(let j=0;j<len/2;j++){
  const c=Math.cos(j*angle),s=Math.sin(j*angle),a=i+j,b=a+len/2,tr=real[b]*c-imag[b]*s,ti=real[b]*s+imag[b]*c;
  real[b]=real[a]-tr;imag[b]=imag[a]-ti;real[a]+=tr;imag[a]+=ti;
 }}
 let total=0,weighted=0,low=0,high=0;
 for(let i=0;i<=n/2;i++){const f=i*rate/n;if(f<60||f>=12000)continue;const power=real[i]**2+imag[i]**2;total+=power;weighted+=power*f;if(f<250)low+=power;if(f>=1800)high+=power;}
 return{centroid:weighted/total,low:low/total,high:high/total,rms:Math.sqrt(energy/length)};
}
const phases=[[0,.025],[.025,.14],[.14,.35]] as const;
const statistics=Object.fromEntries(FACTIONS.map(faction=>[faction,[0,1,2].map(variant=>{
 const pcm=synthesizeRifle(faction,48000,0x51f15e+variant*7919);return{pcm,phases:phases.map(([start,end])=>{const scale=(faction==='german'?.8:1)*SOUND_DURATION_SCALE;return spectrum(pcm,48000,start*scale,end*scale);})};
})])) as Record<Faction,{pcm:Float32Array;phases:ReturnType<typeof spectrum>[]}[]>;
const mean=(values:number[])=>values.reduce((sum,value)=>sum+value,0)/values.length;

test('all rifle variants have finite bounded PCM, a substantial body, and a click-free tail',()=>{
 for(const faction of FACTIONS){
  for(const {pcm} of statistics[faction]){
   const total=pcm.reduce((sum,v)=>sum+v*v,0);let cumulative=0,energy95=0;
   assert.ok(pcm.every(Number.isFinite));assert.ok(Math.max(...pcm.map(Math.abs))<.89);assert.equal(pcm[0],0);assert.ok(Math.abs(pcm.at(-1)!)<1e-5);
   for(let i=0;i<pcm.length;i++){cumulative+=pcm[i]**2;if(cumulative>=total*.95){energy95=i/48000;break;}}
   assert.ok(energy95>.26*SOUND_DURATION_SCALE&&energy95<.44*SOUND_DURATION_SCALE,`${faction}: ${energy95}s must retain a compressed shot body without an excessive tail`);
  }
  assert.notDeepEqual(statistics[faction][0].pcm,statistics[faction][1].pcm);
  assert.deepEqual(synthesizeRifle(faction,48000),statistics[faction][0].pcm,'repeatable review signal');
  assert.ok(synthesizeRifle(faction,44100).every(Number.isFinite),'44.1kHz devices');
 }
});

test('attack/body/tail spectra follow multiple verified reference shots instead of whole-shot EQ ordering',()=>{
 // Mean centroids of three visually verified CoD1/UO shots per rifle, measured only
 // before350ms. Later bolt/handling audio is explicitly excluded. See research/audio-reference.md.
 const reference={british:[2233,945,819],russian:[2210,857,617],german:[3000,1667,1535]};
 for(const faction of FACTIONS)for(let phase=0;phase<3;phase++){
  const measured=mean(statistics[faction].map(item=>item.phases[phase].centroid));
  // The compressed attack window is only 20 ms (16 ms for Kar); its few
  // low-frequency cycles allow more sample-to-sample variance than the body.
  assert.ok(Math.abs(measured/reference[faction][phase]-1)<(phase===2?.25:phase===0?.20:.15),`${faction} phase${phase}: ${measured}Hz must track the reference band`);
 }
 const avg=(faction:Faction,phase:number,key:'centroid'|'low'|'high')=>mean(statistics[faction].map(item=>item.phases[phase][key]));
 assert.ok(avg('german',0,'centroid')>avg('british',0,'centroid')*1.25,'Kar98k has the sharpest crack');
 assert.ok(avg('german',0,'centroid')>avg('russian',0,'centroid')*1.2);
 assert.ok(avg('russian',2,'centroid')<avg('british',2,'centroid')*.85,'Mosin settles into the deeper reference rumble');
 assert.ok(avg('german',2,'centroid')>avg('british',2,'centroid')*1.6,'Kar retains its raspy high-frequency tail');
 assert.ok(avg('russian',2,'low')>avg('british',2,'low')*1.35,'Mosin tail has substantially more sub250Hz energy');
});

test('rifle envelopes preserve the separate Enfield thump, Mosin decay, and Kar sustained body',()=>{
 const levels=(faction:Faction)=>statistics[faction].map(item=>({body:20*Math.log10(item.phases[1].rms/item.phases[0].rms),tail:20*Math.log10(item.phases[2].rms/item.phases[1].rms)}));
 const enfield=levels('british'),mosin=levels('russian'),kar=levels('german');
 assert.ok(mean(enfield.map(x=>x.tail))< -5,'Enfield body drops into its short warm tail');
 assert.ok(mean(mosin.map(x=>x.tail))> -4&&mean(mosin.map(x=>x.tail))< -1,'Mosin decay is longer than Enfield');
 assert.ok(mean(kar.map(x=>x.tail))> -2,'Kar body persists instead of sharing the Enfield decay');
 assert.ok(mean(kar.map(x=>x.body))>0,'Kar attack opens into the stronger body seen in reference spectra');
 assert.ok(mean(kar.map(x=>x.tail))-mean(enfield.map(x=>x.tail))>4,'the body/tail distinction must remain audible across variants');
});

test('combat Foley is bounded, click-free, repeatable, and varies across hits at device sample rates',()=>{
 for(const rate of [44100,48000])for(const kind of COMBAT_SOUNDS){
  const variants=[0,1,2].map(variant=>synthesizeCombat(kind,rate,0x71a9+variant*3571));
  for(const pcm of variants){
   assert.ok(pcm.every(Number.isFinite));assert.ok(Math.max(...pcm.map(Math.abs))<=.651);
   assert.equal(pcm[0],0);assert.equal(pcm.at(-1),0);
   const dc=pcm.reduce((sum,value)=>sum+value,0)/pcm.length;assert.ok(Math.abs(dc)<.002,'no headroom wasted on DC');
   assert.ok(pcm.length<=rate*.33*SOUND_DURATION_SCALE,'short Foley does not produce an excessive tail');
  }
  assert.notDeepEqual(variants[0],variants[1]);assert.deepEqual(variants[0],synthesizeCombat(kind,rate));
 }
});

test('contact has an immediate transient and low body, while a missed swing has a rising air envelope',()=>{
 const rate=48000,swing=synthesizeCombat('swing',rate),strike=synthesizeCombat('melee-impact',rate),bullet=synthesizeCombat('shot-impact',rate);
 const opening=(pcm:Float32Array)=>spectrum(pcm,rate,0,.025*SOUND_DURATION_SCALE),body=(pcm:Float32Array)=>spectrum(pcm,rate,.025*SOUND_DURATION_SCALE,.10*SOUND_DURATION_SCALE);
 assert.ok(body(swing).rms>opening(swing).rms*2,'swing builds with the arm motion');
 for(const hit of [strike,bullet])assert.ok(opening(hit).rms>body(hit).rms*1.5,'contact starts at the confirmed hit without a delayed attack');
 assert.ok(body(strike).rms>body(bullet).rms*1.4,'melee has a weightier sustained body than a bullet contact');
 assert.ok(opening(bullet).centroid>opening(strike).centroid*1.2,'bullet contact is sharper than the melee thud');
});


test('every rifle and combat report is 20% shorter at both device sample rates',()=>{
 assert.equal(SOUND_DURATION_SCALE,.8);
 for(const rate of [44100,48000]){
  assert.equal(synthesizeRifle('german',rate).length,Math.ceil(rate*.5248),'Kar keeps its previous compression and becomes .5248 seconds');
  for(const faction of ['british','russian'] as const)assert.equal(synthesizeRifle(faction,rate).length,Math.ceil(rate*.656));
  for(const kind of COMBAT_SOUNDS){const previous={swing:.32,'melee-impact':.28,'shot-impact':.22}[kind];assert.equal(synthesizeCombat(kind,rate).length,Math.ceil(rate*previous*.8));}
 }
});
