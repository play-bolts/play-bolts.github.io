import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {Sound,type SoundEmitter} from '../src/audio.ts';
import {GameAudioBank,GAME_AUDIO_CLIPS,rifleReportId,movementClipId,boltAudioCues,reloadAudioCues,reloadAudioTiming} from '../src/gameAudio.ts';
import {WEAPONS,type Faction} from '../src/config.ts';
import {footstepLevel} from '../src/movementAudio.ts';

class Param {
 value=0;
 setValueAtTime(value:number){this.value=value;}
 setTargetAtTime(value:number){this.value=value;}
 exponentialRampToValueAtTime(value:number){this.value=value;}
}
class Node {
 connections:Node[]=[];disconnected=false;
 connect(node:Node){this.connections.push(node);return node;}
 disconnect(){this.connections=[];this.disconnected=true;}
}
class Source extends Node {
 buffer:AudioBuffer|null=null;onended:(()=>void)|null=null;type='';frequency=new Param();
 starts:{time:number;offset:number}[]=[];stops:number[]=[];
 start(time=0,offset=0){this.starts.push({time,offset});}
 stop(time=0){this.stops.push(time);}
}
class Gain extends Node {gain=new Param();}
class Filter extends Node {frequency=new Param();Q=new Param();type='';}
class Panner extends Node {
 positionX=new Param();positionY=new Param();positionZ=new Param();
 panningModel='';distanceModel='';refDistance=0;maxDistance=0;rolloffFactor=0;
}
class Context {
 currentTime=10;sampleRate=48000;sources:Source[]=[];gains:Gain[]=[];panners:Panner[]=[];
 createBufferSource(){const source=new Source();this.sources.push(source);return source;}
 createOscillator(){return this.createBufferSource();}
 createGain(){const gain=new Gain();this.gains.push(gain);return gain;}
 createBiquadFilter(){return new Filter();}
 createPanner(){const panner=new Panner();this.panners.push(panner);return panner;}
 createBuffer(channels:number,length:number,sampleRate:number):AudioBuffer {
  const samples=Array.from({length:channels},()=>new Float32Array(length));
  return {duration:length/sampleRate,length,sampleRate,numberOfChannels:channels,getChannelData:(channel:number)=>samples[channel]} as AudioBuffer;
 }
}
const remote:SoundEmitter={actor:2,position:{x:-3,y:2,z:8},local:false,faction:'british'};
const near=(actual:number,expected:number)=>assert.ok(Math.abs(actual-expected)<1e-9,`${actual} != ${expected}`);
function fixture(populate=true){
 const ctx=new Context(),buffers=new Map<string,AudioBuffer>();
 if(populate)for(const clip of GAME_AUDIO_CLIPS)buffers.set(clip.id,ctx.createBuffer(2,Math.round(clip.duration*ctx.sampleRate),ctx.sampleRate));
 const bank={get:(id:string)=>buffers.get(id),preload:async()=>{},load:async()=>{}} as unknown as GameAudioBank;
 const sound=new Sound(bank),master=new Gain();
 sound.ctx=ctx as unknown as AudioContext;sound.master=master as unknown as GainNode;
 sound.noise=ctx.createBuffer(1,ctx.sampleRate*2,ctx.sampleRate);
 return {sound,ctx,buffers,master};
}
function deferred<T>(){
 let resolve!:(value:T)=>void;
 const promise=new Promise<T>(yes=>{resolve=yes;});
 return {promise,resolve};
}

test('runtime WAV files match their provenance, declared durations and spatial-audio format',()=>{
 const provenance=JSON.parse(readFileSync(new URL('../public/assets/audio/game/provenance.json',import.meta.url),'utf8')) as {clips:{id:string;file:string;output_sha256:string;source_clip_sha256:string;duration_seconds:number;frames:number}[]};
 const ids=new Set<string>();
 for(const clip of GAME_AUDIO_CLIPS){
  assert.ok(!ids.has(clip.id),`duplicate ${clip.id}`);ids.add(clip.id);
  assert.match(clip.file,/^\/assets\/.+\.wav$/);assert.ok(!clip.file.includes('..'));
  const data=readFileSync(new URL(`../public${clip.file}`,import.meta.url));
  const record=provenance.clips.find(record=>record.id===clip.id);assert.ok(record,`${clip.id}: provenance exists`);
  const digest=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
  assert.equal(digest(data),record.output_sha256,`${clip.id} matches its prepared output`);
  assert.match(record.source_clip_sha256,/^[a-f0-9]{64}$/);assert.ok(clip.file.endsWith(`/${record.file}`));
  assert.equal(record.duration_seconds,clip.duration);
  assert.equal(data.toString('ascii',0,4),'RIFF');assert.equal(data.toString('ascii',8,12),'WAVE');
  let format:Buffer|undefined,pcm:Buffer|undefined;
  for(let offset=12;offset+8<=data.length;){
   const kind=data.toString('ascii',offset,offset+4),size=data.readUInt32LE(offset+4);
   assert.ok(offset+8+size<=data.length,`${clip.id}: complete WAV chunk`);
   if(kind==='fmt ')format=data.subarray(offset+8,offset+8+size);
   if(kind==='data')pcm=data.subarray(offset+8,offset+8+size);
   offset+=8+size+(size%2);
  }
  assert.ok(format&&pcm,`${clip.id}: format and audio chunks`);
  assert.equal(format.readUInt16LE(0),1,'uncompressed PCM is browser-decodable');
  assert.equal(format.readUInt16LE(2),1,'mono recordings can be positioned with the game panner');assert.equal(format.readUInt32LE(4),48000);assert.equal(format.readUInt16LE(14),16);
  assert.equal(pcm.length/2,record.frames);assert.equal(pcm.readInt16LE(0),0);assert.equal(pcm.readInt16LE(pcm.length-2),0);
  near(pcm.length/format.readUInt32LE(8),clip.duration);
 }
 assert.equal(ids.size,27,'nine reports, six bolt phases, ten reload phases and two movement contacts');
 assert.ok([...ids].every(id=>!id.includes('whole-')&&!id.includes('shot-and-cycle')&&!id.includes('full-reload')),'combined references do not duplicate live action cues');
});

test('factions select all three matching rifle reports and movement alternates the supplied contacts',()=>{
 for(const [faction,prefix] of [['british','enfield'],['russian','mosin'],['german','kar98k']] as const){
  for(let variant=0;variant<3;variant++)assert.equal(rifleReportId(faction,variant),`${prefix}-report-${variant+1}`);
  const bolt=boltAudioCues(faction);assert.deepEqual(bolt.map(cue=>cue.id),[`${prefix}-open-eject`,`${prefix}-close-lock`]);
  assert.equal(bolt[0].delay,0);assert.ok(bolt[1].delay>0&&bolt[1].delay<.65);
 }
 assert.equal(movementClipId('left'),'movement-footstep-candidate-1');assert.equal(movementClipId('right'),'movement-footstep-candidate-2');
});

test('an early network reload cue ignores stale timers while an active timer retains elapsed progress',()=>{
 const british=WEAPONS.british.reload;
 assert.deepEqual(reloadAudioTiming({faction:'british',ammo:0,reload:0,reloadTotal:british*.66}),{duration:british,elapsed:0},'new full reload cannot inherit the previous partial duration');
 assert.deepEqual(reloadAudioTiming({faction:'british',ammo:6,reload:0,reloadTotal:british}),{duration:british*.66,elapsed:0},'new partial reload is inferred from current ammunition');
 for(const faction of ['russian','german'] as const)assert.deepEqual(reloadAudioTiming({faction,ammo:1,reload:0,reloadTotal:99}),{duration:WEAPONS[faction].reload,elapsed:0});
 const active=reloadAudioTiming({faction:'british',ammo:0,reload:1.5,reloadTotal:british});
 near(active.duration,british);near(active.elapsed,british-1.5);
 const partial=reloadAudioTiming({faction:'british',ammo:7,reload:1,reloadTotal:british*.66});
 near(partial.duration,british*.66);near(partial.elapsed,british*.66-1);
});

test('preloading and decoding share work while individual missing or corrupt clips stay unavailable',async()=>{
 const requests:string[]=[],decodes:number[]=[],missing=GAME_AUDIO_CLIPS[1],corrupt=GAME_AUDIO_CLIPS[2];
 const fetchAudio=(async(input:RequestInfo|URL)=>{
  const file=String(input);requests.push(file);const index=GAME_AUDIO_CLIPS.findIndex(clip=>clip.file===file);
  assert.ok(index>=0);
  if(file===missing.file)return {ok:false} as Response;
  return {ok:true,arrayBuffer:async()=>new Uint8Array([index]).buffer} as Response;
 }) as typeof fetch;
 const bank=new GameAudioBank(fetchAudio),ctx=new Context(),decoded=new Map<number,AudioBuffer>();
 const context=Object.assign(ctx,{async decodeAudioData(bytes:ArrayBuffer){
  const index=new Uint8Array(bytes)[0];decodes.push(index);
  if(GAME_AUDIO_CLIPS[index].id===corrupt.id)throw new Error('corrupt audio');
  const buffer=ctx.createBuffer(2,4800,48000);decoded.set(index,buffer);return buffer;
 }}) as unknown as AudioContext;
 await Promise.all([bank.preload(),bank.preload()]);
 assert.equal(requests.length,GAME_AUDIO_CLIPS.length,'downloads are deduplicated');assert.equal(decodes.length,0,'byte preload does not require an audio context');
 await Promise.all([bank.load(context),bank.load(context)]);
 assert.equal(requests.filter(file=>file!==missing.file).length,GAME_AUDIO_CLIPS.length-1,'successful downloads are reused');
 assert.equal(decodes.length,GAME_AUDIO_CLIPS.length-1,'decode occurs once per fetched clip');
 assert.equal(bank.get(missing.id),undefined);assert.equal(bank.get(corrupt.id),undefined);
 for(const [index,buffer] of decoded)assert.equal(bank.get(GAME_AUDIO_CLIPS[index].id),buffer);
 await bank.load(context);assert.equal(decodes.length,GAME_AUDIO_CLIPS.length-1,'warm loads reuse decoded audio');
});

test('audio loading calls fetch without binding the bank as a browser API receiver',async()=>{
 const receivers:unknown[]=[];
 const fetchAudio=async function(this:unknown){
  receivers.push(this);
  return {ok:true,arrayBuffer:async()=>new ArrayBuffer(1)} as Response;
 } as typeof fetch;
 const bank=new GameAudioBank(fetchAudio);
 await bank.preload();
 assert.equal(receivers.length,GAME_AUDIO_CLIPS.length);
 assert.ok(receivers.every(receiver=>receiver===undefined),'native fetch must not receive GameAudioBank as its this value');
});

test('a new audio context reuses fetched bytes and cannot be overwritten by an older decode',async()=>{
 let fetches=0;const firstReady=deferred<void>(),secondReady=deferred<void>(),ctx=new Context();
 const first=ctx.createBuffer(1,4800,48000),second=ctx.createBuffer(1,9600,48000);
 const bank=new GameAudioBank((async()=>{fetches++;return {ok:true,arrayBuffer:async()=>new Uint8Array([17]).buffer} as Response;}) as typeof fetch);
 const context=(ready:Promise<void>,buffer:AudioBuffer)=>({async decodeAudioData(bytes:ArrayBuffer){
  assert.equal(new Uint8Array(bytes)[0],17,'each decoder receives intact source bytes');
  structuredClone(bytes,{transfer:[bytes]});await ready;return buffer;
 }}) as AudioContext;
 const firstLoad=bank.load(context(firstReady.promise,first)),secondLoad=bank.load(context(secondReady.promise,second));
 secondReady.resolve();await secondLoad;assert.equal(bank.get(GAME_AUDIO_CLIPS[0].id),second);
 firstReady.resolve();await firstLoad;assert.equal(bank.get(GAME_AUDIO_CLIPS[0].id),second,'stale context completion cannot replace current buffers');
 assert.equal(fetches,GAME_AUDIO_CLIPS.length,'decoder input detachment does not cause new downloads');
});

test('sampled reports and movement preserve actor routing, stance gain and buffer reuse',()=>{
 const {sound,ctx,buffers,master}=fixture();
 for(const faction of ['british','russian','german'] as Faction[]){
  let previous:AudioBuffer|null=null;
  for(let take=0;take<8;take++){
   sound.shot({...remote,faction});const source=ctx.sources.at(-1)!;
   assert.ok([0,1,2].some(variant=>source.buffer===buffers.get(rifleReportId(faction,variant))));
   assert.notEqual(source.buffer,previous,'consecutive shots avoid repeating one report');previous=source.buffer;
   assert.ok(ctx.panners.at(-1)!.connections.includes(master));assert.equal(ctx.panners.at(-1)!.positionZ.value,8);
  }
 }
 for(const stance of ['stand','crouch','prone'] as const){
  for(let index=0;index<2;index++){
   const gainsBefore=ctx.gains.length;sound.step(1.4,remote,stance);
   assert.equal(ctx.sources.at(-1)!.buffer,buffers.get(movementClipId(index?'right':'left')));
   near(ctx.gains[gainsBefore].gain.value,footstepLevel(stance,1.4));
  }
 }
 const count=ctx.sources.length;sound.step(0,remote);assert.equal(ctx.sources.length,count);
 sound.stopActor(remote.actor);assert.ok(ctx.sources.every(source=>source.disconnected));
});

test('reload samples follow full and partial animation phases and remain individually cancellable',()=>{
 for(const faction of ['british','russian','german'] as Faction[]){
  for(const partial of faction==='british'?[false,true]:[false]){
   const {sound,ctx,buffers}=fixture(),duration=WEAPONS[faction].reload*(partial?.66:1),prefix={british:'enfield',russian:'mosin',german:'kar98k'}[faction];
   const expected=[{id:`${prefix}-reload-bolt-open`,fraction:.08},{id:faction==='british'?'enfield-reload-clip-1-load':`${prefix}-reload-clip-load`,fraction:.35}];
   if(faction==='british'&&!partial)expected.push({id:'enfield-reload-clip-2-load',fraction:.5425});
   expected.push({id:`${prefix}-reload-bolt-close`,fraction:.79});
   const cues=reloadAudioCues(faction,duration);assert.deepEqual(cues.map(cue=>cue.id),expected.map(cue=>cue.id));
   cues.forEach((cue,index)=>near(cue.delay,expected[index].fraction*duration));
   sound.reload({...remote,faction},duration);assert.equal(ctx.sources.length,expected.length);
   ctx.sources.forEach((source,index)=>{
    assert.equal(source.buffer,buffers.get(expected[index].id));near(source.starts[0].time,10+expected[index].fraction*duration);
    near(source.stops[0],source.starts[0].time+source.buffer!.duration);
   });
   const reload=[...ctx.sources];sound.melee({...remote,faction});const melee=ctx.sources.at(-1)!;
   sound.cancelReload(remote.actor);assert.ok(reload.every(source=>source.disconnected));assert.equal(melee.disconnected,false);
   const stops=reload.map(source=>source.stops.length);sound.cancelReload(remote.actor);assert.deepEqual(reload.map(source=>source.stops.length),stops,'cancellation is idempotent');
  }
 }
});

test('sampled bolt phases fit before the next shot and survive unrelated reload cancellation',()=>{
 for(const faction of ['british','russian','german'] as Faction[]){
  const {sound,ctx,buffers}=fixture(),prefix={british:'enfield',russian:'mosin',german:'kar98k'}[faction];
  sound.bolt({...remote,faction});assert.equal(ctx.sources.length,2);
  assert.equal(ctx.sources[0].buffer,buffers.get(`${prefix}-open-eject`));near(ctx.sources[0].starts[0].time,10);
  assert.equal(ctx.sources[1].buffer,buffers.get(`${prefix}-close-lock`));near(ctx.sources[1].starts[0].time,10.17);
  assert.ok(ctx.sources.every(source=>source.stops[0]<=10.65));
  sound.cancelReload(remote.actor);assert.ok(ctx.sources.every(source=>!source.disconnected));
  sound.resetScene();assert.ok(ctx.sources.every(source=>source.disconnected));
 }
});

test('one unavailable handling phase selects a complete immediate fallback, with no duplicate sampled phases',()=>{
 const {sound,ctx,buffers}=fixture();buffers.delete('enfield-reload-bolt-close');
 sound.reload(remote);assert.equal(ctx.sources.length,6);
 assert.ok(ctx.sources.every(source=>![...buffers.values()].includes(source.buffer!)),'fallback action does not also schedule the available recorded phases');
 sound.cancelReload(remote.actor);assert.ok(ctx.sources.every(source=>source.disconnected));
 buffers.delete('enfield-close-lock');const before=ctx.sources.length;sound.bolt(remote);
 assert.equal(ctx.sources.length-before,3);assert.ok(ctx.sources.slice(before).every(source=>![...buffers.values()].includes(source.buffer!)));
});

test('late reload cues skip finished phases and seek active audio instead of restarting it',()=>{
 const {sound,ctx,buffers}=fixture(),duration=WEAPONS.british.reload,elapsed=duration*.4;
 sound.reload(remote,duration,elapsed);
 assert.equal(ctx.sources.length,3,'the completed bolt-opening phase is skipped');
 const active=ctx.sources[0];assert.equal(active.buffer,buffers.get('enfield-reload-clip-1-load'));
 near(active.starts[0].time,10);near(active.starts[0].offset,elapsed-duration*.35);
 near(active.stops[0],10+active.buffer!.duration-active.starts[0].offset);
 near(ctx.sources[1].starts[0].time,10+duration*.5425-elapsed);near(ctx.sources[2].starts[0].time,10+duration*.79-elapsed);
 sound.resetScene();assert.ok(ctx.sources.every(source=>source.disconnected));
});

test('loading a report cannot replay an earlier event after its actor or scene was stopped',async()=>{
 const {ctx,master}=fixture(false),ready=deferred<void>(),buffers=new Map<string,AudioBuffer>();
 const id=rifleReportId('british',0),sample=ctx.createBuffer(2,17280,48000);
 const bank={get:(key:string)=>buffers.get(key),preload:async()=>{},load:async()=>{await ready.promise;for(let variant=0;variant<3;variant++)buffers.set(rifleReportId('british',variant),sample);}} as unknown as GameAudioBank;
 const sound=new Sound(bank);sound.ctx=ctx as unknown as AudioContext;sound.master=master as unknown as GainNode;
 const pending=sound.loadSamples();sound.shot(remote);
 assert.equal(ctx.sources.length,1,'unavailable report has an immediate fallback');assert.notEqual(ctx.sources[0].buffer,sample);
 sound.stopActor(remote.actor);sound.resetScene();ready.resolve();await pending;
 assert.equal(ctx.sources.length,1,'finishing decode never starts a stale gameplay event');assert.equal(ctx.sources[0].disconnected,true);
 assert.equal(buffers.get(id),sample);sound.shot(remote);assert.equal(ctx.sources.at(-1)!.buffer,sample,'subsequent live events use decoded samples');
});
