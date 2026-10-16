import test from 'node:test';
import assert from 'node:assert/strict';
import {Sound,type SoundEmitter} from '../src/audio.ts';
import {listenerBasis,soundEnvironment} from '../src/audioSpatial.ts';
import {BOXES} from '../src/config.ts';
import {COMBAT_SOUNDS} from '../src/audioSynthesis.ts';

class Param {value=0;setValueAtTime(v:number){this.value=v;}setTargetAtTime(v:number){this.value=v;}exponentialRampToValueAtTime(v:number){this.value=v;}}
class Node {
 connections:Node[]=[];disconnected=false;
 connect(node:Node){this.connections.push(node);return node;}
 disconnect(){this.connections=[];this.disconnected=true;}
}
class Source extends Node {onended:(()=>void)|null=null;stops:number[]=[];buffer:unknown;type='';frequency=new Param();start(){}stop(time=0){this.stops.push(time);}end(){this.onended?.();}}
class Gain extends Node {gain=new Param();}
class Filter extends Node {frequency=new Param();Q=new Param();type='';}
class Panner extends Node {positionX=new Param();positionY=new Param();positionZ=new Param();panningModel='';distanceModel='';refDistance=0;maxDistance=0;rolloffFactor=0;}
class Context {
 currentTime=10;sampleRate=48000;sources:Source[]=[];panners:Panner[]=[];filters:Filter[]=[];gains:Gain[]=[];
 destination=new Node();buffers:ReturnType<Context['createBuffer']>[]=[];
 listener={positionX:new Param(),positionY:new Param(),positionZ:new Param(),forwardX:new Param(),forwardY:new Param(),forwardZ:new Param(),upX:new Param(),upY:new Param(),upZ:new Param()};
 createBufferSource(){const node=new Source();this.sources.push(node);return node;}
 createOscillator(){return this.createBufferSource();}
 createGain(){const node=new Gain();this.gains.push(node);return node;}
 createBiquadFilter(){const node=new Filter();this.filters.push(node);return node;}
 createPanner(){const node=new Panner();this.panners.push(node);return node;}
 createBuffer(_channels:number,length:number,rate:number):{duration:number;getChannelData:()=>Float32Array}{const samples=new Float32Array(length),buffer={duration:length/rate,getChannelData:()=>samples};this.buffers.push(buffer);return buffer;}
 createDynamicsCompressor(){return Object.assign(new Node(),{threshold:new Param(),knee:new Param(),ratio:new Param(),attack:new Param(),release:new Param()});}
}
function setup(){const sound=new Sound(),ctx=new Context(),master=new Gain();sound.ctx=ctx as unknown as AudioContext;sound.master=master as unknown as GainNode;sound.noise=ctx.createBuffer(1,96000,48000) as unknown as AudioBuffer;return{sound,ctx,master};}
const remote:SoundEmitter={actor:2,position:{x:-3,y:2,z:0},local:false,faction:'german'};

test('listener orientation keeps world -X on the right at yaw zero, including pitch and turns',()=>{
 const {sound,ctx}=setup();
 for(const [yaw,pitch] of [[0,0],[Math.PI/2,.6],[Math.PI,-.7],[-Math.PI/2,0]]){
  sound.updateListener({x:1,y:3,z:5},yaw,pitch);
  const f=[ctx.listener.forwardX.value,ctx.listener.forwardY.value,ctx.listener.forwardZ.value],u=[ctx.listener.upX.value,ctx.listener.upY.value,ctx.listener.upZ.value];
  const right=[f[1]*u[2]-f[2]*u[1],f[2]*u[0]-f[0]*u[2],f[0]*u[1]-f[1]*u[0]];
  assert.ok(Math.abs(right[0]+Math.cos(yaw))<1e-10);assert.ok(Math.abs(right[2]-Math.sin(yaw))<1e-10);
  assert.ok(Math.abs(f.reduce((sum,v,i)=>sum+v*u[i],0))<1e-10);
 }
 assert.equal(listenerBasis(0).right.x,-1);assert.equal(ctx.listener.positionY.value,3);
});

test('cover attenuates and filters sound while an above-cover path remains clear',()=>{
 const box=BOXES[0],listener={x:box.x-box.w/2-1,y:1,z:box.z},origin={x:box.x+box.w/2+1,y:1,z:box.z};
 const blocked=soundEnvironment(origin,listener),clear=soundEnvironment({...origin,y:box.h+.5},{...listener,y:box.h+.5});
 assert.equal(blocked.occluded,true);assert.equal(clear.occluded,false);assert.ok(blocked.gain<clear.gain);assert.ok(blocked.cutoff<clear.cutoff/4);
 assert.equal(soundEnvironment(listener,listener).occluded,false);
});

test('every remote shot band shares one spatial source; steps and reload tones use the same route',()=>{
 const {sound,ctx,master}=setup();sound.updateListener({x:0,y:2,z:0},0);sound.shot(remote);
 assert.equal(ctx.sources.length,1,'one synthesized shot contains crack, body, bass and echoes');
 assert.equal(ctx.panners[0].panningModel,'HRTF');assert.equal(ctx.panners[0].positionX.value,-3);
 assert.equal(ctx.panners[0].distanceModel,'inverse');assert.ok(ctx.panners[0].rolloffFactor>0);
 sound.step(4,remote);sound.reload(remote);
 assert.equal(ctx.sources.length,9);assert.ok(ctx.gains.filter(g=>g.connections.includes(master)).length===0,'no unpanned remote bass/handling path');
 for(const p of ctx.panners){assert.equal(p.positionX.value,-3);assert.ok(p.connections.includes(master));}
 sound.updateEmitter({...remote,position:{x:7,y:2,z:4}});assert.ok(ctx.panners.every(p=>p.positionX.value===7&&p.positionZ.value===4));
 // Following the actor switches every queued cue to the first-person bus; free fly restores spatial sound.
 sound.updateEmitter({...remote,local:true});assert.ok(ctx.gains.filter(g=>g.connections.includes(master)).length===9);
 sound.updateEmitter(remote);assert.equal(ctx.gains.filter(g=>g.connections.includes(master)).length,0);
});

test('actor cancellation is isolated and releases all nodes, including queued reloads',()=>{
 const {sound,ctx}=setup();sound.reload(remote);const first=ctx.sources.slice();
 sound.reload({...remote,actor:3});const second=ctx.sources.slice(first.length);sound.cancelReload(2);
 assert.ok(first.every(s=>s.stops.at(-1)===0&&s.disconnected));assert.ok(second.every(s=>s.stops.length===1&&!s.disconnected));
 sound.stopActor(3);assert.ok(second.every(s=>s.disconnected));
 sound.shot(remote);const shot=ctx.sources.at(-1)!;shot.end();assert.ok(shot.disconnected);assert.ok(ctx.panners.at(-1)!.disconnected);
 sound.reload(remote);sound.click();const click=ctx.sources.at(-1)!;sound.resetScene();assert.equal(click.disconnected,false,'menu feedback is not a scene voice');
});

test('voice count remains bounded under excessive repeated events',()=>{
 const {sound,ctx}=setup();for(let i=0;i<180;i++)sound.melee(remote);
 assert.equal(ctx.sources.filter(s=>!s.disconnected).length,96);
 sound.resetScene();assert.equal(ctx.sources.filter(s=>!s.disconnected).length,0);
});

test('swing and contact use independent spatial voices, with no phantom impact on a miss',()=>{
 const {sound,ctx,master}=setup();sound.melee(remote);
 assert.equal(ctx.sources.length,1,'a swing alone does not imply a hit');
 const swing=ctx.sources[0].buffer;sound.impact({...remote,actor:3,position:{x:2,y:1,z:4}},'melee');
 assert.equal(ctx.sources.length,2);assert.notEqual(ctx.sources[1].buffer,swing);
 assert.equal(ctx.panners[1].positionX.value,2);assert.equal(ctx.panners[1].positionZ.value,4);
 assert.equal(ctx.gains.filter(g=>g.connections.includes(master)).length,0);
 sound.stopActor(remote.actor);assert.ok(ctx.sources[0].disconnected);assert.equal(ctx.sources[1].disconnected,false,'victim contact is not owned by the attacker');
 sound.impact({...remote,actor:0,local:true},'shot');assert.equal(ctx.gains.filter(g=>g.connections.includes(master)).length,1,'first-person damage remains centered');
 sound.resetScene();assert.ok(ctx.sources.every(source=>source.disconnected));
});

test('repeated actions vary their waveform without growing the fixed sample cache',()=>{
 const {sound,ctx}=setup(),random=Math.random;Math.random=()=>.1;
 try{
  for(let i=0;i<12;i++){sound.shot(remote);sound.melee(remote);sound.impact(remote,'melee');sound.impact(remote,'shot');}
  for(let kind=0;kind<4;kind++)for(let i=kind+4;i<ctx.sources.length;i+=4)assert.notEqual(ctx.sources[i].buffer,ctx.sources[i-4].buffer,'adjacent instances cannot repeat even when randomness repeats');
  assert.ok(ctx.buffers.length<=13,'one noise buffer plus at most three samples of each kind');
 }finally{Math.random=random;}
});

test('batched scene transforms route queued sounds once using the final actor position',()=>{
 const {sound,ctx}=setup();sound.updateListener({x:0,y:2,z:0},0);sound.reload(remote);
 const old=ctx.panners.map(p=>p.positionX.value);
 sound.beginSceneUpdate();sound.updateListener({x:10,y:2,z:0},0);sound.updateEmitter({...remote,position:{x:4,y:2,z:8}});
 assert.deepEqual(ctx.panners.map(p=>p.positionX.value),old,'no intermediate update with stale actor positions');
 sound.endSceneUpdate();assert.ok(ctx.panners.every(p=>p.positionX.value===4&&p.positionZ.value===8));
 sound.cancelReload(remote.actor);assert.ok(ctx.sources.every(source=>source.disconnected),'batching preserves scheduled reload cancellation');
});

test('initialization warms combat variants asynchronously and warm playback allocates no new buffers',()=>{
 const contextDescriptor=Object.getOwnPropertyDescriptor(globalThis,'AudioContext'),workerDescriptor=Object.getOwnPropertyDescriptor(globalThis,'Worker');
 const workers:WorkerStub[]=[];
 class WorkerStub {
  onmessage:((event:{data:unknown})=>void)|null=null;onerror:(()=>void)|null=null;rate=0;terminated=false;
  constructor(public url:URL,public options:{type:string}){workers.push(this);}
  postMessage(rate:number){this.rate=rate;}terminate(){this.terminated=true;}
 }
 Object.defineProperty(globalThis,'AudioContext',{configurable:true,value:Context});Object.defineProperty(globalThis,'Worker',{configurable:true,value:WorkerStub});
 const random=Math.random;
 try{
  const sound=new Sound();sound.init();const ctx=sound.ctx as unknown as Context,worker=workers[0];
  assert.equal(workers.length,1);assert.equal(worker.options.type,'module');assert.match(worker.url.pathname,/rifleAudio\.worker\.ts$/);assert.equal(worker.rate,48000);assert.equal(ctx.buffers.length,1,'init only creates its noise buffer; rifle synthesis is off-thread');
  const factions=['british','russian','german'] as const;
  for(const faction of factions)for(let variant=0;variant<3;variant++)worker.onmessage!({data:{faction,variant,samples:new Float32Array([variant/10,.5,-.5,0])}});
  for(const kind of COMBAT_SOUNDS)for(let variant=0;variant<3;variant++)worker.onmessage!({data:{kind,variant,samples:new Float32Array([variant/10,.25,-.25,0])}});
  worker.onmessage!({data:{done:true}});assert.equal(worker.terminated,true);assert.equal(ctx.buffers.length,19);
  for(const faction of factions)for(let variant=0;variant<3;variant++){
   Math.random=()=>variant/3+.01;sound.shot({...remote,faction});const buffer=ctx.sources.at(-1)!.buffer as ReturnType<Context['createBuffer']>;
   assert.deepEqual([...buffer.getChannelData()],[Math.fround(variant/10),.5,-.5,0]);
  }
  for(const kind of COMBAT_SOUNDS)for(let variant=0;variant<3;variant++){
   Math.random=()=>variant/3+.01;
   if(kind==='swing')sound.melee(remote);else sound.impact(remote,kind==='melee-impact'?'melee':'shot');
   const buffer=ctx.sources.at(-1)!.buffer as ReturnType<Context['createBuffer']>;
   assert.deepEqual([...buffer.getChannelData()],[Math.fround(variant/10),.25,-.25,0]);
  }
  assert.equal(ctx.buffers.length,19,'rifles, swings and contacts use all 18 warmed buffers');sound.resetScene();
 }finally{Math.random=random;if(contextDescriptor)Object.defineProperty(globalThis,'AudioContext',contextDescriptor);else delete(globalThis as any).AudioContext;if(workerDescriptor)Object.defineProperty(globalThis,'Worker',workerDescriptor);else delete(globalThis as any).Worker;}
});
