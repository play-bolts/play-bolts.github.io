import {clamp,type Faction,type Vec} from './config';
import {listenerBasis} from './audioSpatial';
import {synthesizeRifle} from './audioSynthesis';
import {AudioEnvironmentCache} from './audioEnvironmentCache';

export interface SoundEmitter {actor:number;position:Vec;local:boolean;faction?:Faction}
type Voice={source:AudioScheduledSourceNode;nodes:AudioNode[];filter:BiquadFilterNode;gain:GainNode;panner:PannerNode;actor:number|null;emitter?:SoundEmitter;local:boolean};
const LOCAL:SoundEmitter={actor:0,position:{x:0,y:0,z:0},local:true};
const MAX_VOICES=96;

export class Sound {
 ctx:AudioContext|null=null;master:GainNode|null=null;volume=.6;noise:AudioBuffer|null=null;
 private reloadSounds=new Map<number,AudioScheduledSourceNode[]>();
 private voices=new Map<AudioScheduledSourceNode,Voice>();
 private emitters=new Map<number,SoundEmitter>();
 private rifleBuffers=new Map<string,AudioBuffer>();
 private listener={position:{x:0,y:0,z:0},yaw:0,pitch:0};
 private environments=new AudioEnvironmentCache();
 private updatingScene=false;
 private rifleWarmup:Worker|null=null;

 init(){
  if(this.ctx){void this.ctx.resume().catch(()=>{});return;}
  const c=this.ctx=new AudioContext();this.master=c.createGain();this.master.gain.value=this.volume;
  const limiter=c.createDynamicsCompressor();limiter.threshold.value=-5;limiter.knee.value=8;limiter.ratio.value=8;limiter.attack.value=.002;limiter.release.value=.12;
  this.master.connect(limiter).connect(c.destination);
  this.noise=c.createBuffer(1,c.sampleRate*2,c.sampleRate);
  const a=this.noise.getChannelData(0);for(let i=0;i<a.length;i++)a[i]=Math.random()*2-1;
  this.updateListener(this.listener.position,this.listener.yaw,this.listener.pitch);
  this.warmRifles();
 }
 private saveRifleBuffer(faction:Faction,variant:number,samples:Float32Array){
  const c=this.ctx!;const key=`${faction}:${variant}`;if(this.rifleBuffers.has(key))return;
  const buffer=c.createBuffer(1,samples.length,c.sampleRate);buffer.getChannelData(0).set(samples);this.rifleBuffers.set(key,buffer);
 }
 private warmRifles(){
  if(!this.ctx||typeof Worker==='undefined')return;
  try{
   const worker=this.rifleWarmup=new Worker(new URL('./rifleAudio.worker.ts',import.meta.url),{type:'module'});
   const finish=()=>{worker.terminate();if(this.rifleWarmup===worker)this.rifleWarmup=null;};
   worker.onmessage=(event:MessageEvent<{done?:boolean;faction:Faction;variant:number;samples:Float32Array}>)=>{
    if(event.data.done){finish();return;}const {faction,variant,samples}=event.data;this.saveRifleBuffer(faction,variant,samples);
   };
   worker.onerror=finish;worker.postMessage(this.ctx.sampleRate);
  }catch{/* An exact first-use fallback preserves sound if workers are unavailable. */}
 }
 setVolume(v:number){this.volume=clamp(v,0,1);if(this.master)this.master.gain.value=this.volume;}
 /** Update all transforms before routing voices, avoiding old/new position pairs. */
 beginSceneUpdate(){this.updatingScene=true;}
 endSceneUpdate(){this.updatingScene=false;for(const voice of this.voices.values())this.syncVoice(voice);}

 updateListener(position:Vec,yaw:number,pitch=0){
  this.listener={position:{...position},yaw,pitch};this.environments.setListener(position);const c=this.ctx;if(!c)return;
  const l=c.listener,{forward,up}=listenerBasis(yaw,pitch),t=c.currentTime;
  if(l.positionX){
   l.positionX.setValueAtTime(position.x,t);l.positionY.setValueAtTime(position.y,t);l.positionZ.setValueAtTime(position.z,t);
   l.forwardX.setValueAtTime(forward.x,t);l.forwardY.setValueAtTime(forward.y,t);l.forwardZ.setValueAtTime(forward.z,t);
   l.upX.setValueAtTime(up.x,t);l.upY.setValueAtTime(up.y,t);l.upZ.setValueAtTime(up.z,t);
  }else{l.setPosition(position.x,position.y,position.z);l.setOrientation(forward.x,forward.y,forward.z,up.x,up.y,up.z);}
  if(!this.updatingScene)for(const voice of this.voices.values())this.syncVoice(voice);
 }
 updateEmitter(emitter:SoundEmitter){
  this.emitters.set(emitter.actor,{...emitter,position:{...emitter.position}});
  if(!this.updatingScene)for(const voice of this.voices.values())if(voice.actor===emitter.actor)this.syncVoice(voice);
 }
 private syncVoice(voice:Voice,initial=false){
  const c=this.ctx;if(!c)return;
  const emitter=voice.actor===null?undefined:this.emitters.get(voice.actor)??voice.emitter;
  const local=!emitter||emitter.local;
  if(local!==voice.local){voice.gain.disconnect();voice.gain.connect(local?this.master!:voice.panner);voice.local=local;}
  const environment=emitter?this.environments.get(emitter.actor,emitter.position,local):{gain:1,cutoff:20000};
  if(initial){voice.filter.frequency.setValueAtTime(environment.cutoff,c.currentTime);voice.gain.gain.setValueAtTime(environment.gain,c.currentTime);}
  else{voice.filter.frequency.setTargetAtTime(environment.cutoff,c.currentTime,.035);voice.gain.gain.setTargetAtTime(environment.gain,c.currentTime,.035);}
  if(emitter){const p=emitter.position;voice.panner.positionX.setValueAtTime(p.x,c.currentTime);voice.panner.positionY.setValueAtTime(p.y,c.currentTime);voice.panner.positionZ.setValueAtTime(p.z,c.currentTime);}
 }
 private release(source:AudioScheduledSourceNode){
  const voice=this.voices.get(source);if(!voice)return;
  this.voices.delete(source);for(const node of voice.nodes)node.disconnect();
  if(voice.actor!==null){const reload=this.reloadSounds.get(voice.actor);if(reload){const index=reload.indexOf(source);if(index>=0)reload.splice(index,1);if(!reload.length)this.reloadSounds.delete(voice.actor);}}
 }
 private stop(source:AudioScheduledSourceNode){try{source.stop();}catch{/* It may have ended between cancellation and this audio tick. */}this.release(source);}
 private route(source:AudioScheduledSourceNode,tail:AudioNode,nodes:AudioNode[],emitter?:SoundEmitter){
  const c=this.ctx!,filter=c.createBiquadFilter(),gain=c.createGain(),panner=c.createPanner();
  filter.type='lowpass';filter.Q.value=.55;panner.panningModel='HRTF';panner.distanceModel='inverse';panner.refDistance=3;panner.maxDistance=80;panner.rolloffFactor=.85;
  const local=!emitter||emitter.local,actor=emitter?.actor??null;
  if(emitter)this.emitters.set(emitter.actor,{...emitter,position:{...emitter.position}});
  tail.connect(filter).connect(gain).connect(local?this.master!:panner);panner.connect(this.master!);
  const voice:Voice={source,nodes:[...nodes,filter,gain,panner],filter,gain,panner,actor,emitter,local};
  // Bound both scheduled sources and graph nodes during rapid fire / long sessions.
  while(this.voices.size>=MAX_VOICES)this.stop(this.voices.keys().next().value!);
  this.voices.set(source,voice);source.onended=()=>this.release(source);this.syncVoice(voice,true);return source;
 }
 noiseBurst(volume:number,duration:number,freq:number,delay=0,_pan=0,emitter?:SoundEmitter){
  if(!this.ctx||!this.master||!this.noise)return;
  const c=this.ctx,t=c.currentTime+delay,s=c.createBufferSource(),f=c.createBiquadFilter(),g=c.createGain();
  s.buffer=this.noise;f.type='lowpass';f.frequency.value=freq;g.gain.setValueAtTime(Math.max(.001,volume),t);g.gain.exponentialRampToValueAtTime(.001,t+duration);
  s.connect(f).connect(g);this.route(s,g,[s,f,g],emitter);s.start(t,Math.random()*.6);s.stop(t+duration);return s;
 }
 tone(freq:number,duration:number,vol:number,delay=0,emitter?:SoundEmitter){
  if(!this.ctx||!this.master)return;
  const c=this.ctx,t=c.currentTime+delay,o=c.createOscillator(),g=c.createGain();
  o.type='triangle';o.frequency.setValueAtTime(freq,t);o.frequency.exponentialRampToValueAtTime(freq*.3,t+duration);g.gain.setValueAtTime(Math.max(.001,vol),t);g.gain.exponentialRampToValueAtTime(.001,t+duration);
  o.connect(g);this.route(o,g,[o,g],emitter);o.start(t);o.stop(t+duration);return o;
 }
 shot(emitter:SoundEmitter){
  if(!this.ctx||!this.master)return;
  const c=this.ctx,faction=emitter.faction??'british',variant=Math.floor(Math.random()*3),key=`${faction}:${variant}`;
  let buffer=this.rifleBuffers.get(key);
  if(!buffer){this.saveRifleBuffer(faction,variant,synthesizeRifle(faction,c.sampleRate,0x51f15e+variant*7919));buffer=this.rifleBuffers.get(key)!;}
  const s=c.createBufferSource();s.buffer=buffer;this.route(s,s,[s],emitter);s.start();s.stop(c.currentTime+buffer.duration);
 }
 bolt(emitter:SoundEmitter=LOCAL){this.noiseBurst(.14,.06,4300,0,0,emitter);this.tone(800,.035,.06,0,emitter);this.noiseBurst(.12,.09,2800,.17,0,emitter);}
 cancelReload(actor?:number){
  const keys=actor===undefined?[...this.reloadSounds.keys()]:[actor];
  for(const key of keys){const sources=this.reloadSounds.get(key);this.reloadSounds.delete(key);if(sources)for(const source of [...sources])this.stop(source);}
 }
 reload(emitter:SoundEmitter=LOCAL){
  this.cancelReload(emitter.actor);
  const sounds=[this.noiseBurst(.14,.06,4300,0,0,emitter),this.tone(800,.035,.06,0,emitter),this.noiseBurst(.12,.09,2800,.17,0,emitter)];
  for(let i=0;i<3;i++)sounds.push(this.noiseBurst(.1,.1,3200,.7+i*.43,0,emitter));
  this.reloadSounds.set(emitter.actor,sounds.filter((source):source is AudioBufferSourceNode|OscillatorNode=>!!source));
 }
 step(speed:number,emitter:SoundEmitter=LOCAL){this.noiseBurst(clamp(speed/30,.025,.14),.12,950,0,0,emitter);this.tone(65,.09,.035,0,emitter);}
 melee(emitter:SoundEmitter=LOCAL){this.noiseBurst(.25,.15,1000,0,0,emitter);}
 switch(emitter:SoundEmitter=LOCAL){this.noiseBurst(.13,.12,1700,0,0,emitter);}
 stopActor(actor:number){this.cancelReload(actor);for(const voice of [...this.voices.values()])if(voice.actor===actor)this.stop(voice.source);this.emitters.delete(actor);this.environments.delete(actor);}
 resetScene(){this.cancelReload();for(const voice of [...this.voices.values()])if(voice.actor!==null)this.stop(voice.source);this.emitters.clear();this.environments.clear();this.updatingScene=false;}
 hit(){this.noiseBurst(.3,.16,600,0,0,LOCAL);this.tone(85,.13,.08,0,LOCAL);}
 click(){this.tone(700,.035,.04);}
}
