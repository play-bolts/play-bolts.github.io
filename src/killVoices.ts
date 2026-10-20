import manifest from '../shared/kill-voices.json';
import features from '../shared/features.json';
import type {Faction} from './config';
import type {Actor,Event} from './engine';
import type {Sound,SoundEmitter} from './audio';

export interface KillVoiceLine {id:string;faction:Faction;language:string;text:string;translation:string;file:string;voice:string}
export const KILL_VOICE_LINES:readonly KillVoiceLine[]=manifest as KillVoiceLine[];
export const KILL_VOICES_ENABLED=features.killVoices===true;
export const DEFAULT_KILL_VOICE_CHANCE=.1;
export function normalizeKillVoiceChance(value:unknown):number {
 return typeof value==='number'&&Number.isFinite(value)?Math.min(1,Math.max(0,value)):DEFAULT_KILL_VOICE_CHANCE;
}
const byFaction=new Map<Faction,readonly KillVoiceLine[]>(['british','german','russian'].map(faction=>[faction as Faction,KILL_VOICE_LINES.filter(line=>line.faction===faction)]));
type ActiveVoice={source:AudioBufferSourceNode;actor:Actor;deaths:number;faction:Faction;until:number};

/** Cosmetic reactions to confirmed live kills. Decoding happens during loadout
 * selection, never on the kill/event path. An unavailable clip is simply skipped,
 * so a slow connection cannot deliver a line after death, replay or menu exit. */
export class KillVoices {
 private context:AudioContext|null=null;
 private buffers=new Map<string,AudioBuffer>();
 private loading:Promise<void>|null=null;
 private active:ActiveVoice|null=null;
 private nextAt=-Infinity;
 private previous=new Map<Faction,string>();
 private seen=new WeakSet<Event>();
 constructor(private sound:Pick<Sound,'ctx'|'playBuffer'>,private random:()=>number=Math.random,private fetchAudio:typeof fetch=fetch,private enabled=KILL_VOICES_ENABLED){}

 preload():Promise<void>{
  if(!this.enabled)return Promise.resolve();
  const ctx=this.sound.ctx;if(!ctx)return Promise.resolve();
  if(this.context===ctx&&this.loading)return this.loading;
  this.context=ctx;this.buffers.clear();
  // A tiny fixed bank (nine mono clips); downloads start only after a play gesture.
  this.loading=Promise.all(KILL_VOICE_LINES.map(async line=>{
   try{
    const response=await this.fetchAudio(line.file);if(!response.ok)return;
    const buffer=await ctx.decodeAudioData(await response.arrayBuffer());
    if(this.context===ctx)this.buffers.set(line.id,buffer);
   }catch{/* Optional voices must never interrupt entry into a game. */}
  })).then(()=>{});
  return this.loading;
 }

 consider(event:Event,actor:Actor|undefined,emitter:SoundEmitter,now:number,chance:number):boolean {
  if(!this.enabled)return false;
  if(event.type!=='kill'||event.presentationOnly||this.seen.has(event))return false;
  this.seen.add(event);
  if(!actor||!actor.alive||actor.hp<=0||actor.spectator||event.actor!==actor.id||emitter.actor!==actor.id||event.victim===undefined||event.victim<0||event.victim===actor.id)return false;
  if(event.actorFaction&&event.actorFaction!==actor.faction)return false;
  if(this.active||now<this.nextAt||!this.sound.ctx||this.sound.ctx!==this.context)return false;
  const probability=normalizeKillVoiceChance(chance);if(probability===0||this.random()>=probability)return false;
  const lines=byFaction.get(actor.faction)!.filter(line=>this.buffers.has(line.id));if(!lines.length)return false;
  const candidates=lines.filter(line=>line.id!==this.previous.get(actor.faction));
  const pool=candidates.length?candidates:lines;
  const line=pool[Math.min(pool.length-1,Math.max(0,Math.floor(this.random()*pool.length)))];
  const buffer=this.buffers.get(line.id)!,source=this.sound.playBuffer(buffer,emitter,.9);if(!source)return false;
  this.previous.set(actor.faction,line.id);
  const active=this.active={source,actor,deaths:actor.deaths,faction:actor.faction,until:now+buffer.duration*1000};
  this.nextAt=active.until+500;
  source.addEventListener('ended',()=>{if(this.active===active)this.active=null;},{once:true});
  return true;
 }

 /** Stop barks when their soldier dies/changes life or live play is suspended. */
 update(actors:readonly Actor[],live:boolean,now:number){
  if(!this.enabled){this.stop();return;}
  const active=this.active;if(!active)return;
  const actor=actors[active.actor.id];
  if(!live||actor!==active.actor||!actor.alive||actor.hp<=0||actor.spectator||actor.deaths!==active.deaths||actor.faction!==active.faction||now>=active.until)this.stop();
 }
 private stop(){const source=this.active?.source;this.active=null;if(source)try{source.stop();}catch{/* It may already have ended or been stopped by Sound.resetScene. */}}
 reset(){this.stop();this.nextAt=-Infinity;this.previous.clear();this.seen=new WeakSet();}
}
