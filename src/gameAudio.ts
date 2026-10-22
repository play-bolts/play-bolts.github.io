import manifest from '../shared/game-audio.json';
import {WEAPONS,type Faction} from './config';
import type {FootSide} from './movementAudio';

export interface GameAudioClip {id:string;file:string;duration:number}
export const GAME_AUDIO_CLIPS:readonly GameAudioClip[]=manifest;
const rifles:Record<Faction,string>={british:'enfield',russian:'mosin',german:'kar98k'};
export const rifleReportId=(faction:Faction,variant=0)=>`${rifles[faction]}-report-${variant+1}`;
export const movementClipId=(side:FootSide)=>`movement-footstep-candidate-${side==='left'?1:2}`;
export interface GameAudioCue {id:string;delay:number}

/** Remote cosmetic cues can precede their authority snapshot. An idle actor's
 * reloadTotal can belong to a previous action, so infer the new duration from
 * the current ammunition until a running reload timer is available. */
export function reloadAudioTiming(actor:{faction:Faction;ammo:number;reload:number;reloadTotal:number}){
 const active=actor.reload>0&&actor.reloadTotal>0;
 const duration=active?actor.reloadTotal:WEAPONS[actor.faction].reload*(actor.faction==='british'&&actor.ammo>=5?.66:1);
 return{duration,elapsed:active?Math.max(0,duration-actor.reload):0};
}

/** The simulation emits bolt with .65 seconds left in the cycle. Both excerpts
 * finish before the next shot, without changing their recorded pitch. */
export function boltAudioCues(faction:Faction):GameAudioCue[]{
 const rifle=rifles[faction];
 return[{id:`${rifle}-open-eject`,delay:0},{id:`${rifle}-close-lock`,delay:.17}];
}

/** Match the opening, charger and closing phases in weaponAnimation. A partial
 * Enfield reload uses one charger and its actual shorter animation duration. */
export function reloadAudioCues(faction:Faction,duration:number=WEAPONS[faction].reload):GameAudioCue[]{
 const rifle=rifles[faction],twoClips=faction==='british'&&duration>WEAPONS.british.reload*.8;
 const cues=[{id:`${rifle}-reload-bolt-open`,delay:.08*duration},
  {id:`${rifle}-reload-clip${faction==='british'?'-1':''}-load`,delay:.35*duration}];
 if(twoClips)cues.push({id:`${rifle}-reload-clip-2-load`,delay:.5425*duration});
 cues.push({id:`${rifle}-reload-bolt-close`,delay:.79*duration});
 return cues;
}

/** Fetch while other assets load, decode after the audio gesture, and only ever
 * cache results. Gameplay events never wait for downloads or replay on decode. */
export class GameAudioBank {
 private bytes=new Map<string,Promise<ArrayBuffer|null>>();
 private buffers=new Map<string,AudioBuffer>();
 private context:AudioContext|null=null;
 private loading:Promise<void>|null=null;
 constructor(private fetchAudio:typeof fetch=fetch){}

 private fetchClip(clip:GameAudioClip):Promise<ArrayBuffer|null>{
  const cached=this.bytes.get(clip.id);if(cached)return cached;
  // Native browser fetch must not receive this bank as its Window receiver.
  const fetchAudio=this.fetchAudio;
  const request=(async()=>{
   try{
    const response=await fetchAudio(clip.file);if(!response.ok)throw new Error('Audio unavailable');
    return await response.arrayBuffer();
   }catch{this.bytes.delete(clip.id);return null;}
  })();
  this.bytes.set(clip.id,request);return request;
 }
 async preload():Promise<void>{await Promise.all(GAME_AUDIO_CLIPS.map(clip=>this.fetchClip(clip)));}
 load(context:AudioContext):Promise<void>{
  if(this.context===context&&this.loading)return this.loading;
  this.context=context;this.buffers.clear();
  const loading=Promise.all(GAME_AUDIO_CLIPS.map(async clip=>{
   try{
    const bytes=await this.fetchClip(clip);if(!bytes)return;
    // Decoders may detach their input. Preserve the prefetched bytes for a new context.
    const buffer=await context.decodeAudioData(bytes.slice(0));
    if(this.context===context)this.buffers.set(clip.id,buffer);
   }catch{/* A failed clip keeps its immediate procedural fallback. */}
  })).then(()=>{});
  this.loading=loading;return loading;
 }
 get(id:string):AudioBuffer|undefined{return this.buffers.get(id);}
}
