import test from 'node:test';
import assert from 'node:assert/strict';
import {KillVoices,KILL_VOICE_LINES,DEFAULT_KILL_VOICE_CHANCE,normalizeKillVoiceChance} from '../src/killVoices.ts';
import {createActor,type Actor,type Event as GameEvent} from '../src/engine.ts';
import type {SoundEmitter} from '../src/audio.ts';

class VoiceSource extends EventTarget {
 stops=0;throwOnStop=false;
 stop(){this.stops++;if(this.throwOnStop)throw new Error('already stopped');}
 end(){this.dispatchEvent(new Event('ended'));}
}
type Clip=AudioBuffer&{id:string;context:number};
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return{promise,resolve};}
function fixture(options:{random?:()=>number;gate?:Promise<void>;missing?:number[];fetchFailure?:number[];decodeFailure?:number[];noContext?:boolean;noSource?:boolean}={}){
 const requests:string[]=[],decodes:number[]=[],plays:{buffer:Clip;emitter:SoundEmitter;gain:number|undefined;source:VoiceSource}[]=[];
 const context=(generation=1)=>({decodeAudioData:async(data:ArrayBuffer)=>{
  const index=new Uint8Array(data)[0];decodes.push(index);if(options.decodeFailure?.includes(index))throw new Error('invalid optional clip');
  return{id:KILL_VOICE_LINES[index].id,context:generation,duration:.4} as Clip;
 }}) as unknown as AudioContext;
 const sound={ctx:options.noContext?null:context(),playBuffer(buffer:AudioBuffer,emitter:SoundEmitter,gain?:number){
  if(options.noSource)return;
  const source=new VoiceSource();plays.push({buffer:buffer as Clip,emitter,gain,source});return source as unknown as AudioBufferSourceNode;
 }};
 const fetchAudio:typeof fetch=async(input)=>{
  const file=String(input),index=KILL_VOICE_LINES.findIndex(line=>line.file===file);requests.push(file);
  assert.notEqual(index,-1,'preload can only fetch the fixed manifest bank');
  if(options.gate)await options.gate;
  if(options.fetchFailure?.includes(index))throw new Error('offline optional clip');
  return new Response(new Uint8Array([index]),{status:options.missing?.includes(index)?404:200});
 };
 const voices=new KillVoices(sound,options.random??(()=>0),fetchAudio);
 const actor=createActor(0,'british','Test soldier');
 const emitter=(value:Actor=actor):SoundEmitter=>({actor:value.id,position:{x:value.x,y:value.y,z:value.z},faction:value.faction,local:value.id===0});
 const kill=(value:Actor=actor):GameEvent=>({type:'kill',actor:value.id,victim:value.id+1,actorFaction:value.faction});
 return{voices,sound,requests,decodes,plays,actor,emitter,kill,context};
}

test('kill voice probability defaults to ten percent and clamps finite settings',()=>{
 assert.equal(DEFAULT_KILL_VOICE_CHANCE,.1);
 for(const value of [undefined,null,'0.9',NaN,Infinity,-Infinity,{},true])assert.equal(normalizeKillVoiceChance(value),.1);
 for(const [input,expected]of [[-.5,0],[0,0],[.1,.1],[.5,.5],[1,1],[2,1]])assert.equal(normalizeKillVoiceChance(input),expected);
});

test('ten percent uses an exclusive threshold, and zero/one explicitly disable/enable',async()=>{
 for(const [draw,chance,expected]of [[.099,.1,true],[.1,.1,false],[0,0,false],[.999999,1,true]]as const){
  const f=fixture({random:()=>draw});await f.voices.preload();
  assert.equal(f.voices.consider(f.kill(),f.actor,f.emitter(),1000,chance),expected,`draw ${draw}, chance ${chance}`);
  assert.equal(f.plays.length,Number(expected));
 }
});

test('confirmed kill reactions select the killer faction and never immediately repeat a line',async()=>{
 const f=fixture();await f.voices.preload();
 for(const faction of ['british','german','russian']as const){
  f.actor.faction=faction;let previous:string|undefined;
  for(let i=0;i<6;i++){
   assert.equal(f.voices.consider(f.kill(),f.actor,f.emitter(),1000+f.plays.length*1000,1),true);
   const played=f.plays.at(-1)!;assert.equal(KILL_VOICE_LINES.find(line=>line.id===played.buffer.id)?.faction,faction);
   assert.notEqual(played.buffer.id,previous);previous=played.buffer.id;
   assert.deepEqual(played.emitter,f.emitter());assert.equal(played.gain,.9);played.source.end();
  }
 }
 assert.equal(f.requests.length,KILL_VOICE_LINES.length,'confirmed kills never fetch or decode on their playback path');
});

test('only a fresh confirmed kill by the live identified soldier may react',async()=>{
 for(const invalid of ['shot','hurt','suicide','missing victim','negative victim','missing actor','dead','zero hp while alive','spectator','wrong actor','wrong emitter','stale faction','historical notification']as const){
  const f=fixture();await f.voices.preload();let actor:Actor|undefined=f.actor;
  const event=f.kill(),emitter=f.emitter();
  if(invalid==='shot')event.type='shot';if(invalid==='hurt')event.type='hurt';
  if(invalid==='suicide')event.victim=f.actor.id;
  if(invalid==='missing victim')delete event.victim;if(invalid==='negative victim')event.victim=-1;
  if(invalid==='missing actor')actor=undefined;if(invalid==='dead')f.actor.alive=false;if(invalid==='spectator')f.actor.spectator=true;
  if(invalid==='zero hp while alive')f.actor.hp=0;
  if(invalid==='wrong actor')event.actor=3;if(invalid==='wrong emitter')emitter.actor=3;
  if(invalid==='stale faction')event.actorFaction='german';if(invalid==='historical notification')event.presentationOnly=true;
  assert.equal(f.voices.consider(event,actor,emitter,1000,1),false,invalid);assert.equal(f.plays.length,0,invalid);
 }
});

test('one active voice and its short cooldown discard overlapping kills without replaying them later',async()=>{
 const f=fixture();await f.voices.preload();const original=f.kill();
 assert.equal(f.voices.consider(original,f.actor,f.emitter(),1000,1),true);
 assert.equal(f.voices.consider(original,f.actor,f.emitter(),1001,1),false,'the same event object is consumed once');
 const overlapping=f.kill();assert.equal(f.voices.consider(overlapping,f.actor,f.emitter(),1100,1),false);
 f.plays[0].source.end();const cooldown=f.kill();assert.equal(f.voices.consider(cooldown,f.actor,f.emitter(),1899,1),false);
 for(const event of [original,overlapping,cooldown])assert.equal(f.voices.consider(event,f.actor,f.emitter(),3000,1),false,'missed opportunities cannot become late barks');
 assert.equal(f.voices.consider(f.kill(),f.actor,f.emitter(),1900,1),true,'new kill is eligible at duration plus 500 ms');
 assert.equal(f.plays.length,2);
});

test('active voice stops on death, spectator mode, actor replacement, life/faction changes and suspended play',async()=>{
 for(const condition of ['death','zero hp while alive','spectator','replace','removed','new life','faction','paused','expired']as const){
  const f=fixture();await f.voices.preload();assert.equal(f.voices.consider(f.kill(),f.actor,f.emitter(),1000,1),true);
  const actors=[f.actor];let live=true,now=1100;
  if(condition==='death')f.actor.alive=false;if(condition==='spectator')f.actor.spectator=true;
  if(condition==='zero hp while alive')f.actor.hp=0;if(condition==='removed')actors.length=0;
  if(condition==='replace')actors[0]=createActor(0,'british','Replacement');if(condition==='new life')f.actor.deaths++;
  if(condition==='faction')f.actor.faction='german';if(condition==='paused')live=false;if(condition==='expired')now=1400;
  f.voices.update(actors,live,now);assert.equal(f.plays[0].source.stops,1,condition);
  f.voices.update(actors,live,now+10);assert.equal(f.plays[0].source.stops,1,'cleanup is idempotent');
 }
});

test('reset stops playback, tolerates an already stopped source and clears cooldown/event history',async()=>{
 const f=fixture();await f.voices.preload();const event=f.kill();assert.equal(f.voices.consider(event,f.actor,f.emitter(),1000,1),true);
 f.plays[0].source.throwOnStop=true;assert.doesNotThrow(()=>f.voices.reset());assert.equal(f.plays[0].source.stops,1);
 assert.equal(f.voices.consider(event,f.actor,f.emitter(),1001,1),true,'a new scene resets event identities and cooldown');
 f.plays[0].source.end();assert.equal(f.voices.consider(f.kill(),f.actor,f.emitter(),2000,1),false,'an old ended callback cannot clear a newer active voice');
 f.voices.reset();assert.equal(f.plays[1].source.stops,1);await f.voices.preload();assert.equal(f.requests.length,KILL_VOICE_LINES.length,'scene reset retains the decoded fixed bank');
});

test('preload requires a context, shares one fixed bank promise and never plays a late kill',async()=>{
 const gate=deferred(),f=fixture({gate:gate.promise,noContext:true});await f.voices.preload();assert.equal(f.requests.length,0);
 f.sound.ctx=f.context();const loading=f.voices.preload();assert.equal(f.voices.preload(),loading);
 assert.deepEqual(f.requests,[...KILL_VOICE_LINES].map(line=>line.file));
 const earlyKill=f.kill();assert.equal(f.voices.consider(earlyKill,f.actor,f.emitter(),1000,1),false);
 gate.resolve();await loading;assert.equal(f.plays.length,0,'finishing downloads never starts deferred playback');
 assert.equal(f.voices.consider(earlyKill,f.actor,f.emitter(),2000,1),false);
 await f.voices.preload();assert.equal(f.requests.length,KILL_VOICE_LINES.length);assert.equal(f.decodes.length,KILL_VOICE_LINES.length);
 assert.equal(f.voices.consider(f.kill(),f.actor,f.emitter(),2000,1),true);
});

test('missing, failed and undecodable optional voices are nonfatal and do not suppress healthy factions',async()=>{
 const failed=KILL_VOICE_LINES.map((line,index)=>({line,index})).filter(item=>item.line.faction==='british').map(item=>item.index);
 const f=fixture({missing:[failed[0]],fetchFailure:[failed[1]],decodeFailure:[failed[2]]});
 await assert.doesNotReject(f.voices.preload());assert.equal(f.voices.consider(f.kill(),f.actor,f.emitter(),1000,1),false);
 f.actor.faction='german';assert.equal(f.voices.consider(f.kill(),f.actor,f.emitter(),2000,1),true);
 assert.equal(KILL_VOICE_LINES.find(line=>line.id===f.plays[0].buffer.id)?.faction,'german');
 const unavailable=fixture({noSource:true});await unavailable.voices.preload();assert.equal(unavailable.voices.consider(unavailable.kill(),unavailable.actor,unavailable.emitter(),1000,1),false);
});

test('replacing an audio context reloads its bank and cannot use a stale decoded clip',async()=>{
 const f=fixture();await f.voices.preload();f.sound.ctx=f.context(2);
 assert.equal(f.voices.consider(f.kill(),f.actor,f.emitter(),1000,1),false,'old context buffers cannot play before new preload');
 await f.voices.preload();assert.equal(f.requests.length,KILL_VOICE_LINES.length*2);
 assert.equal(f.voices.consider(f.kill(),f.actor,f.emitter(),2000,1),true);assert.equal(f.plays[0].buffer.context,2);
});
