/// <reference types="vite/client" />
import {Game,createActor,type Actor,type Event,type Input,type Shot,type Snapshot} from './engine';
import {MELEE_SECONDS,RULES,WEAPONS,WEAPON_SWITCH_SECONDS,clamp,lerp,worldHit,type Faction,type Stance,type WeaponSlot,type Vec} from './config';
import {advanceHipSpread} from './accuracy';
import {advanceLean} from './lean';
import {DEFAULT_PLAYER_NAME,sanitizePlayerName} from './names';
import {LocalPredictionView,clipPredictionView} from './localPredictionView';
import {AdaptiveInputLead,RemotePlaybackClock,type InputTimingSample} from './networkTiming';
import {decodeSnapshot,decodeMessage,encodeInput,PROTOCOL_VERSION} from './networkCodec';
import {sampleNetworkColliders} from './networkCollision';
import {gameEndpoint,locationLabel,probeLobby,type Lobby,type LobbyLocation} from './lobbies';
export type {Lobby} from './lobbies';

export type WireActor=Omit<Actor,'ai'>&{ack:number;hipSpread:number;bot?:boolean;spawnGeneration?:number;inputTiming?:InputTimingSample};
export interface WireEvent extends Omit<Event,'shot'> {seq?:number;actorGeneration?:number;victimGeneration?:number;hitGeneration?:number;roundNumber?:number;tick?:number;time?:number;shot?:(Shot&{seq?:number})}
export interface WireEventBatch {type:'events';lobbyId:string;roundNumber:number;tick:number;time:number;eventSeq:number;events:WireEvent[]}
export interface WireCueBatch {type:'cues';lobbyId:string;roundNumber:number;tick:number;time:number;cueSeq:number;events:WireEvent[]}
interface PendingCue {event:WireEvent;expiresAt:number}
interface ReloadCue {generation:number;roundNumber:number;tick:number;expiresAt:number;active:boolean}
export interface WireSnapshot {type:'snapshot';inputTiming:'tick-v2';lobbyId?:string;eventSeq?:number;tick:number;time:number;remaining:number;roundNumber:number;ended:boolean;winner:number|null;actors:WireActor[];events:WireEvent[]}
export interface NetworkInput extends Input {type:'input';seq:number;tick:number;generation:number;yaw:number;pitch:number;ads:boolean;stance:Stance;weapon:WeaponSlot;fire:boolean;reload:boolean;melee:boolean;shotTime:number}
interface PendingInput {input:NetworkInput}
export interface ChatMessage {id?:string;name:string;message:string}
export interface SocketLike {readyState:number;binaryType?:string;readonly bufferedAmount?:number;onopen:((event:any)=>void)|null;onmessage:((event:any)=>void)|null;onerror:((event:any)=>void)|null;onclose:((event:any)=>void)|null;send(data:string|ArrayBuffer|ArrayBufferView<ArrayBuffer>):void;close():void}
interface NetworkOptions {origin?:string;fetch?:typeof fetch;socket?:(url:string)=>SocketLike;storage?:Pick<Storage,'getItem'|'setItem'|'removeItem'>;now?:()=>number}
const EMPTY_INPUT:Input={forward:0,right:0,jump:false,walk:false,lean:0};
const TOKEN_KEY='bolts-multiplayer-session-v1';
const STEP=1/60,MAX_PREDICTION_TICKS=120,MAX_BUFFERED_INPUT_TICKS=12,MAX_PENDING_CUES=128,CUE_HOLD_MS=250;
const poseFields=['phase','crouch','prone','aim','speed','forward','sideways'] as const;
const timestampFields=['leftGroundAt','jumpStarted','landedAt','deadAt','lastShotTime','lastHurtTime','lastMeleeTime','switchStarted'] as const;
const actorNumericFields=['x','y','z','yaw','pitch','eyeHeight','hp','ammo','reserve','kills','deaths','shots','hits','cooldown','reload','reloadTotal','vy','landingSpeed','moving','lean','recoil','spawnSafe','switchDuration','deathYaw','ack','hipSpread',...timestampFields] as const;
const authoritativeRemoteFields=['spectator','name','faction','hp','ammo','reserve','kills','deaths','shots','hits','ping'] as const;
const eventTypes=new Set(['shot','kill','reload','bolt','hurt','spawn','end','step','switch']);
const cueTypes=new Set(['shot','hurt','reload','bolt','switch']);
function validEvents(value:unknown):value is WireEvent[]{
 if(!Array.isArray(value)||value.length>128)return false;
 return value.every(event=>{
  if(!event||!eventTypes.has(event.type)||!Number.isSafeInteger(event.actor)||event.actor<0)return false;
  for(const key of ['victim','seq','actorGeneration','victimGeneration','hitGeneration','roundNumber','tick'])if(event[key]!==undefined&&(!Number.isSafeInteger(event[key])||event[key]<0))return false;
  if(event.time!==undefined&&!Number.isFinite(event.time))return false;
  if(event.value!==undefined&&!Number.isFinite(event.value)||event.headshot!==undefined&&typeof event.headshot!=='boolean'||event.lethal!==undefined&&typeof event.lethal!=='boolean'||event.weapon!==undefined&&!['rifle','grenade','melee'].includes(event.weapon))return false;
  if(['actorName','victimName'].some(key=>event[key]!==undefined&&typeof event[key]!=='string'))return false;
  if(event.actorFaction!==undefined&&!['british','russian','german'].includes(event.actorFaction))return false;
  if(event.shot){const shot=event.shot;if(!Number.isSafeInteger(shot.actor)||shot.actor!==event.actor||!Number.isFinite(shot.time)||!['shot','melee'].includes(shot.kind)||typeof shot.headshot!=='boolean'||shot.hit!==null&&(!Number.isSafeInteger(shot.hit)||shot.hit<0)||shot.seq!==undefined&&(!Number.isSafeInteger(shot.seq)||shot.seq<0))return false;for(const point of [shot.origin,shot.end])if(!point||['x','y','z'].some(key=>!Number.isFinite(point[key])))return false;}
  return true;
 });
}

/** No device fingerprint or IP-derived identity. The server mints a random UUID
 * and an opaque bearer token, sent only over HTTPS / the first WebSocket frame. */
export class NetworkClient {
 readonly game:Game;
 onRoster=()=>{};onJoined=(_name:string)=>{};onStatus=(_text:string)=>{};onFailure=(_message:string)=>{};onChat=(_message:ChatMessage)=>{};onRound=()=>{};onImpact=(_shot:Shot)=>{};
 online=false;connected=false;ping=0;lobbyId='';lobbyName='';
 private origin:string;private fetcher:typeof fetch;private socketFactory:(url:string)=>SocketLike;private storage?:Pick<Storage,'getItem'|'setItem'|'removeItem'>;private now:()=>number;
 private socket:SocketLike|null=null;private token='';private actorId=-1;private ids:number[]=[];private seq=0;private pending:PendingInput[]=[];private snapshots:WireSnapshot[]=[];private predictedEffects=new Set<string>();
 private directory=new Map<string,Lobby>();private gameUrl='';private admission='';private managed=false;private joinRequest='';private joinAbort:AbortController|null=null;
 private directoryLocations:LobbyLocation[]=[];
 get locations():readonly LobbyLocation[]{return this.directoryLocations;}
 private lastSnapshotAt=0;private latestTime=0;private lastMessageAt=0;private lastPingAt=0;private roundNumber=-1;private actions={fire:false,singleFire:false,reload:false,melee:false};private desiredStance:Stance='stand';private desiredWeapon:WeaponSlot='rifle';private desiredADS=false;
 private presentationTime=0;private presentationAt=0;private clockReady=false;
 private playback=new RemotePlaybackClock();private inputLead=new AdaptiveInputLead();private leadDrain=0;
 private eventSeq=0;private eventBatches:WireEventBatch[]=[];
 private cueSeq=0;private pendingCues:PendingCue[]=[];private queuedCueEvents=new WeakMap<Event,WireEvent>();private reloadCues=new Map<number,ReloadCue>();
 private presentedCueKeys=new Set<string>();
 private correctionCount=0;private maximumCorrection=0;private inputStarvations=0;private skippedInputTicks=0;private congestedInputs=0;
 private latestTick=0;private predictionTick=0;private playerGeneration:number|undefined;private roundTrip=0;private rttSampleAt=-Infinity;private openedAt=0;
 private predictionView=new LocalPredictionView();private renderedPosition:Vec|null=null;
 private profile={name:DEFAULT_PLAYER_NAME,faction:'british' as Faction,spectator:false};private generation=0;private reconnectTimer:ReturnType<typeof setTimeout>|null=null;private reconnectAttempt=0;private reconnecting=false;private replaying=false;private uiPaused=false;private pingSent=new Map<number,number>();private connectionPromise:Promise<void>|null=null;private cancelOpening:(()=>void)|null=null;private profileTimer:ReturnType<typeof setTimeout>|null=null;
 constructor(game:Game,options:NetworkOptions={}) {
  this.game=game;this.origin=options.origin??import.meta.env?.VITE_MULTIPLAYER_URL??'';this.fetcher=options.fetch??globalThis.fetch.bind(globalThis);this.socketFactory=options.socket??(url=>new WebSocket(url));this.now=options.now??(()=>performance.now());
  if(options.storage)this.storage=options.storage;else try{if(typeof localStorage!=='undefined')this.storage=localStorage;}catch{}
 }
 private endpoint(path:string){
  if(!this.origin)throw new Error('Multiplayer unavailable.');
  const origin=new URL(this.origin);
  if(origin.protocol!=='https:'&&!(origin.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(origin.hostname)))throw new Error('Multiplayer requires a secure connection.');
  return new URL(path,origin).href;
 }
 async lobbies():Promise<Lobby[]>{
  const started=this.now();
  const response=await this.fetcher(this.endpoint('/api/lobbies'),{cache:'no-store',signal:AbortSignal.timeout(8000)});if(!response.ok)throw new Error('Unable to load servers.');const body=await response.json();if(!Array.isArray(body.lobbies))throw new Error('Invalid server list.');
  const rows:Lobby[]=body.lobbies.filter((l:any)=>l&&typeof l.id==='string'&&!l.id.startsWith('new:')&&typeof l.name==='string'&&Number.isInteger(l.players)&&l.players>=0&&l.capacity===6&&['playing','ended','starting'].includes(l.phase)).map((l:any)=>({id:l.id,name:l.name,players:l.players,bots:l.bots,capacity:6,phase:l.phase,location:typeof l.location==='string'?l.location:undefined,pingUrl:typeof l.pingUrl==='string'?l.pingUrl:undefined,managed:l.managed===true}));
  this.directoryLocations=body.version===2&&Array.isArray(body.locations)?[...new Set<LobbyLocation>(body.locations.filter((id:unknown):id is LobbyLocation=>typeof id==='string'&&!!locationLabel(id)))]:[];
  // Classic directory responses use their request RTT for the lobby list.
  if(body.version!==2){const ping=Math.max(0,Math.round(this.now()-started));for(const row of rows)if(!row.managed)row.ping=ping;}
  this.directory=new Map(rows.map(row=>[row.id,row]));return rows;
 }
 async measureLobbies(rows:readonly Lobby[],signal?:AbortSignal):Promise<Lobby[]>{
  const endpoints=new Map<string,Promise<number|undefined>>();
  return Promise.all(rows.map(async row=>{
   if(!row.managed&&!row.pingUrl&&row.ping!==undefined)return {...row};
   let ping:number|undefined;
   if(row.phase!=='starting'&&(!row.managed||row.pingUrl))try{
    const url=gameEndpoint(row.pingUrl??this.endpoint('/api/ping'),this.origin);url.protocol=url.protocol==='https:'?'wss:':url.protocol==='http:'?'ws:':url.protocol;
    if(!endpoints.has(url.href))endpoints.set(url.href,probeLobby(url.href,this.socketFactory,this.now,signal));ping=await endpoints.get(url.href);
   }catch{}
   return {...row,ping};
  }));
 }
 private async authenticate(){
  if(this.token)return;const generation=this.generation;
  let stored:string|null=null;try{stored=this.storage?.getItem(TOKEN_KEY)??null;}catch{}
  let response=await this.fetcher(this.endpoint('/api/session'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(stored?{token:stored}:{}),signal:AbortSignal.timeout(8000)});
  // An expired/revoked browser token is not reused. A fresh server-issued identity
  // is the only fallback; names and network addresses never authenticate users.
  if(response.status===401&&stored){try{this.storage?.removeItem(TOKEN_KEY);}catch{}response=await this.fetcher(this.endpoint('/api/session'),{method:'POST',headers:{'Content-Type':'application/json'},body:'{}',signal:AbortSignal.timeout(8000)});}
  if(!response.ok)throw new Error('Unable to connect.');const body=await response.json();if(typeof body.token!=='string'||body.token.length<20)throw new Error('Invalid session.');if(generation!==this.generation)return;this.token=body.token;try{this.storage?.setItem(TOKEN_KEY,this.token);}catch{}
 }
 async join(lobbyId:string|undefined,name:string,faction:Faction,spectator=false){
  const byLocation=!!lobbyId?.startsWith('new:');
  if(byLocation&&!this.directoryLocations.some(id=>`new:${id}`===lobbyId))throw new Error('This location is unavailable. Refresh the server list.');
  this.disconnect();this.online=true;this.profile={name:sanitizePlayerName(name),faction,spectator};this.lobbyId=lobbyId??'';this.reconnectAttempt=0;this.onStatus('Connecting…');const generation=this.generation;
  this.managed=byLocation||!!(lobbyId&&this.directory.get(lobbyId)?.managed);this.joinRequest=globalThis.crypto.randomUUID();
  try{await this.authenticate();if(!this.online||generation!==this.generation)return;if(this.managed)await this.reserveGame(generation);if(!this.online||generation!==this.generation)return;await this.openSocket();}catch(error){if(generation!==this.generation)return;this.disconnect();throw error;}
 }
 private async reserveGame(generation:number){
  const abort=new AbortController();this.joinAbort=abort;const deadline=this.now()+600000;
  while(this.online&&generation===this.generation){
   const response=await this.fetcher(this.endpoint('/api/join'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:this.token,lobbyId:this.lobbyId,requestId:this.joinRequest}),signal:AbortSignal.any([abort.signal,AbortSignal.timeout(12000)])});
   const result=await response.json().catch(()=>({}));if(generation!==this.generation)return;
   if(response.status===202){this.onStatus('Starting server…');if(this.now()>=deadline)throw new Error('Server startup timed out. Please try again.');await new Promise<void>((resolve,reject)=>{const cancel=()=>{clearTimeout(timer);reject(new Error('Connection cancelled.'));};const timer=setTimeout(()=>{abort.signal.removeEventListener('abort',cancel);resolve();},2000);abort.signal.addEventListener('abort',cancel,{once:true});});continue;}
   if(response.status===401){this.token='';try{this.storage?.removeItem(TOKEN_KEY);}catch{}}
   if(!response.ok)throw new Error(typeof result.message==='string'?result.message:'Unable to join this game.');
   if(typeof result.websocketUrl!=='string'||typeof result.ticket!=='string'||result.ticket.length<32||result.ticket.length>2048||typeof result.lobbyId!=='string')throw new Error('Invalid game reservation.');
   const url=gameEndpoint(result.websocketUrl,this.origin);if(url.protocol!=='wss:'&&url.protocol!=='ws:')throw new Error('Invalid game reservation.');
   this.gameUrl=url.href;this.admission=result.ticket;this.lobbyId=result.lobbyId;this.onStatus('Connecting…');return;
  }
 }
 private openSocket():Promise<void>{
  const previous=this.socket;if(previous){previous.onclose=null;previous.onmessage=null;previous.onerror=null;previous.onopen=null;previous.close();}
  const generation=this.generation,url=new URL(this.gameUrl||this.endpoint('/api/ws'));if(url.protocol==='https:'||url.protocol==='http:')url.protocol=url.protocol==='https:'?'wss:':'ws:';
  const socket=this.socketFactory(url.href);socket.binaryType='arraybuffer';this.socket=socket;
  this.connectionPromise=new Promise((resolve,reject)=>{
   let joined=false,settled=false;const timeout=setTimeout(()=>{if(settled)return;settled=true;reject(new Error('Connection timed out.'));socket.close();},10000);
   const fail=(message:string)=>{if(!settled){settled=true;clearTimeout(timeout);reject(new Error(message));}};this.cancelOpening=()=>fail('Connection cancelled.');
   socket.onopen=()=>{if(generation===this.generation){this.openedAt=this.now();this.send({type:'hello',version:PROTOCOL_VERSION,token:this.managed?this.admission:this.token});}};
   socket.onmessage=event=>{
    if(generation!==this.generation)return;let message:any;try{message=decodeMessage(event.data);}catch{return;}if(!message||typeof message!=='object'||Array.isArray(message))return;
    this.lastMessageAt=this.now();
    if(message.type==='welcome'){if(message.version!==PROTOCOL_VERSION){fail('Incompatible server version. Reload Bolts to update.');socket.close();return;}this.roundTrip=Math.max(0,this.now()-this.openedAt);this.send({type:'join',...(this.lobbyId?{lobbyId:this.lobbyId}:{}),name:this.profile.name,faction:this.profile.faction,...(this.profile.spectator?{spectator:true}:{})});return;}
    if(message.type==='joined'){
     if(!Number.isSafeInteger(message.actorId)||typeof message.lobbyId!=='string'||typeof message.lobbyName!=='string'||!Number.isSafeInteger(message.cueSeq)||message.cueSeq<0){fail('Invalid server response.');socket.close();return;}
     this.actorId=message.actorId;this.lobbyId=message.lobbyId;this.lobbyName=message.lobbyName;this.connected=true;this.reconnecting=false;this.reconnectAttempt=0;this.seq=0;this.pending=[];this.snapshots=[];this.ids=[];this.predictedEffects.clear();this.actions={fire:false,singleFire:false,reload:false,melee:false};this.replaying=false;
     this.predictionTick=0;this.playerGeneration=undefined;this.clockReady=false;this.eventSeq=Number.isSafeInteger(message.snapshot?.eventSeq)?message.snapshot.eventSeq:0;this.eventBatches=[];this.inputLead.reset(this.now());this.leadDrain=0;
     this.cueSeq=message.cueSeq;this.pendingCues=[];this.reloadCues.clear();this.queuedCueEvents=new WeakMap();this.presentedCueKeys.clear();
     if(!this.receiveSnapshot(message.snapshot)){fail('Invalid game state.');socket.close();return;}
     joined=true;settled=true;clearTimeout(timeout);this.onStatus('');this.onJoined(this.lobbyName);if(this.profile.name!==this.game.player.name)this.send({type:'profile',name:this.profile.name});resolve();return;
    }
    if(message.type==='snapshot'&&joined){this.receiveSnapshot(message);return;}
    if(message.type==='events'&&joined){this.receiveEvents(message);return;}
    if(message.type==='cues'&&joined){this.receiveCues(message);return;}
    if(message.type==='chat'&&joined&&typeof message.text==='string'&&typeof message.name==='string'){this.onChat({id:typeof message.id==='string'?message.id:undefined,name:sanitizePlayerName(message.name),message:message.text.slice(0,2048)});return;}
    if(message.type==='pong'&&typeof message.nonce==='number'){const sent=this.pingSent.get(message.nonce);if(sent!==undefined){this.ping=Math.round(this.now()-sent);this.roundTrip=this.ping;this.rttSampleAt=this.now();this.pingSent.delete(message.nonce);}return;}
    if(message.type==='error'){
     const text=typeof message.message==='string'?message.message:'Connection failed.';
     if(message.code==='session_replaced'||message.code==='unauthenticated'){if(message.code==='unauthenticated'){this.token='';try{this.storage?.removeItem(TOKEN_KEY);}catch{}}fail(text);this.fatal(text);return;}
     if(!joined){fail(text);socket.close();}else this.onStatus(text);
    }
   };
   socket.onerror=()=>{if(!joined)fail('Unable to connect.');};
   socket.onclose=event=>{
    clearTimeout(timeout);if(generation!==this.generation||!this.online)return;if(event?.code===4001){fail('Connected in another tab.');this.fatal('Connected in another tab.');return;}this.connected=false;this.pending=[];this.actions={fire:false,singleFire:false,reload:false,melee:false};
    for(const actor of this.game.actors)actor.ping=null;
    if(!joined){fail('Connection closed.');return;}this.scheduleReconnect();
   };
  });return this.connectionPromise;
 }
 private scheduleReconnect(){
  if(!this.online||this.reconnectTimer)return;this.reconnecting=true;this.onStatus('Reconnecting…');
  if(this.reconnectAttempt>=5){this.fatal('Connection lost.');return;}
  const generation=this.generation,delay=Math.min(4000,500*2**this.reconnectAttempt++);
  this.reconnectTimer=setTimeout(()=>{this.reconnectTimer=null;if(generation!==this.generation||!this.online)return;void (async()=>{if(this.managed)await this.reserveGame(generation);if(generation===this.generation&&this.online)await this.openSocket();})().catch(()=>{if(generation===this.generation)this.scheduleReconnect();});},delay);
 }
 private fatal(message:string){this.disconnect();this.onFailure(message);}
 disconnect(){
  this.joinAbort?.abort();this.joinAbort=null;this.gameUrl='';this.admission='';this.managed=false;
  this.generation++;this.cancelOpening?.();this.cancelOpening=null;this.online=false;this.connected=false;this.reconnecting=false;if(this.reconnectTimer)clearTimeout(this.reconnectTimer);this.reconnectTimer=null;if(this.profileTimer)clearTimeout(this.profileTimer);this.profileTimer=null;
  const socket=this.socket;this.socket=null;if(socket){socket.onclose=null;socket.onmessage=null;socket.onerror=null;socket.onopen=null;if(socket.readyState===1)try{socket.send(JSON.stringify({type:'leave'}));}catch{}socket.close();}
  this.pending=[];this.snapshots=[];this.predictedEffects.clear();this.actions={fire:false,singleFire:false,reload:false,melee:false};this.ids=[];this.actorId=-1;this.replaying=false;this.uiPaused=false;this.pingSent.clear();this.clockReady=false;for(const actor of this.game.actors)actor.ping=null;
  this.predictionTick=0;this.renderedPosition=null;this.playerGeneration=undefined;this.eventBatches=[];this.eventSeq=0;this.inputLead.reset(this.now());this.leadDrain=0;
  this.cueSeq=0;this.pendingCues=[];this.reloadCues.clear();this.queuedCueEvents=new WeakMap();this.presentedCueKeys.clear();
 }
 private send(message:unknown){if(this.socket?.readyState===1){this.socket.send(JSON.stringify(message));return true;}return false;}
 setName(name:string){const safe=sanitizePlayerName(name);if(this.profile.name===safe)return;this.profile.name=safe;if(this.profileTimer)clearTimeout(this.profileTimer);if(this.online)this.profileTimer=setTimeout(()=>{this.profileTimer=null;if(this.connected)this.send({type:'profile',name:this.profile.name});},450);}
 setFaction(faction:Faction){this.profile.faction=faction;this.profile.spectator=false;if(this.online)this.send({type:'loadout',faction});}
 spectate(){this.profile.spectator=true;this.desiredADS=false;this.actions={fire:false,singleFire:false,reload:false,melee:false};this.pending=[];if(this.online)this.send({type:'spectate'});}
 chat(text:string){const clean=Array.from(text.trim()).slice(0,256).join('');if(clean&&this.connected)this.send({type:'chat',text:clean});}
 /** Drop unsent combat intent when focus moves to chat. Already acknowledged
  * actions remain authoritative; opening a text field never undoes a shot. */
 clearInput(){this.actions={fire:false,singleFire:false,reload:false,melee:false};this.setADS(false);const p=this.game.player;if(p){this.desiredStance=p.stance;this.desiredWeapon=p.selectedWeapon;}}
 /** A normal release stops repeats but preserves the initial tap until sent.
  * Cancellation and lifecycle resets discard that tap too. */
 clearFire(cancelSingle=false){this.actions.fire=false;this.actions.melee=false;if(cancelSingle)this.actions.singleFire=false;}
 setPaused(paused:boolean){this.uiPaused=paused;if(paused){this.desiredADS=false;this.actions={fire:false,singleFire:false,reload:false,melee:false};if(this.game.player)this.game.player.ads=false;}this.applyState();}
 toggleStance(stance:Stance){if(this.canInput())this.desiredStance=this.desiredStance===stance?'stand':stance;}
 selectWeapon(weapon:WeaponSlot){if(this.canInput())this.desiredWeapon=weapon;}
 setADS(ads:boolean){this.desiredADS=ads&&this.canInput()&&this.game.canADS();if(this.game.player)this.game.player.ads=this.desiredADS;}
 fire(melee=false){if(this.canInput())this.actions[melee?'melee':'fire']=true;}
 fireOnce(){if(this.canInput())this.actions.singleFire=true;}
 reload(){if(this.canInput())this.actions.reload=true;}
 private canInput(){return this.connected&&!this.uiPaused&&!this.replaying&&this.game.state==='playing'&&this.game.player?.alive&&!this.game.player.spectator&&!this.profile.spectator;}
 get waitingForRespawn(){return this.replaying&&!this.game.player.alive&&this.game.replayTime>=this.game.replayEnd+.65;}
 skipReplay(){
  if(!this.replaying)return;
  // Skipping seeks to the end; only an authoritative new life may restore
  // the local gameplay camera. Short recordings can end before respawn.
  this.game.replayTime=this.game.replayEnd+.65;this.game.replayShots=[];this.applyState();
 }
 private applyState(){if(!this.online||!this.game.player)return;const latest=this.snapshots.at(-1);this.game.state=latest?.ended?'ended':this.uiPaused?'paused':this.replaying?'killcam':'playing';}
 /** Keep the remote playback clock independent of local prediction. A late
  * packet may change its target buffer, never jump a soldier forward. */
 private advancePresentation(now:number){
  const elapsed=Math.max(0,(now-this.lastSnapshotAt)/1000),estimate=this.latestTime+Math.min(.25,elapsed);
  if(!this.clockReady){this.presentationTime=this.latestTime;this.clockReady=true;}
  else {
   const dt=Math.min(.25,Math.max(0,(now-this.presentationAt)/1000)),candidate=this.presentationTime+dt;
   this.presentationTime=Math.max(this.presentationTime,Math.min(this.latestTime+.25,candidate+clamp(estimate-candidate,-dt*.1,dt*.1)));
  }
  this.playback.advance(now);this.presentationAt=now;this.game.time=this.predictionTime;
  const latest=this.snapshots.at(-1);if(latest)this.game.remaining=Math.max(0,latest.remaining-Math.max(0,this.presentationTime-latest.time));
 }
 /** Debug/telemetry only: none of these estimates are sent as authority. */
 get diagnostics(){return {roundTripMs:this.roundTrip,inputLeadTicks:this.inputLead.ticks,inputLeadChanges:this.inputLead.changes,inputTiming:this.inputLead.sample,interpolationMs:this.playback.targetDelay*1000,jitterMs:this.playback.jitter*1000,remoteBufferedMs:this.playback.bufferedSeconds*1000,remotePlaybackAgeMs:Math.max(0,this.predictionTime-this.remoteTime)*1000,interpolationUnderruns:this.playback.underruns,playbackResyncs:this.playback.resyncs,inputStarvations:this.inputStarvations,skippedInputTicks:this.skippedInputTicks,correctionCount:this.correctionCount,maximumCorrection:this.maximumCorrection,congestedInputs:this.congestedInputs,bufferedBytes:this.socket?.bufferedAmount??0};}
 /** Call once before each rendered frame, including frames between 60 Hz ticks. */
 present(alpha=1){
  if(!this.online||!this.game.player||!this.snapshots.length)return;const now=this.now();this.advancePresentation(now);this.interpolate();
  this.flushCues();
  this.renderedPosition=this.predictionView.sample(alpha,now);
  this.game.time=this.predictionTime+clamp(alpha,0,1)*STEP;
 }
 /** A camera-only position; authoritative and predicted actors stay untouched. */
 get localPosition(){const p=this.game.player;return !this.replaying&&p?.alive&&!p.spectator&&this.renderedPosition?clipPredictionView(this.renderedPosition,p,this.game.eye(p)):null;}
 private get predictionTime(){return this.latestTime+(this.predictionTick-this.latestTick)*STEP;}
 /** Remote action timestamps use the same delayed clock as remote positions. */
 get remoteTime(){if(!this.snapshots.length)return this.game.time;return clamp(this.playback.time,this.snapshots[0].time,this.snapshots.at(-1)!.time);}
 private neutralCommand():NetworkInput{
  const p=this.game.player;return{type:'input',seq:0,tick:this.predictionTick,generation:this.playerGeneration!,...EMPTY_INPUT,yaw:p.yaw,pitch:p.pitch,ads:false,stance:p.stance,weapon:p.selectedWeapon,fire:false,reload:false,melee:false,shotTime:0};
 }
 private inputHorizon(now:number){
  // The snapshot is already roughly RTT/2 old on arrival, and the command
  // needs another RTT/2 to reach the server. Two extra ticks absorb batching.
  return this.latestTick+Math.ceil((Math.max(0,now-this.lastSnapshotAt)+this.roundTrip)/(STEP*1000));
 }
 /** Fixed 60 Hz local prediction. Never runs Game.update / AI or Game.damage. */
 update(dt:number,input:Input,enabled=true){
  if(!this.online||!this.game.player)return;const now=this.now();
  if(this.connected&&now-this.lastMessageAt>5000){this.socket?.close();return;}
  if(this.connected&&now-this.lastPingAt>1000){this.lastPingAt=now;this.pingSent.set(now,now);this.send({type:'ping',nonce:now});if(this.pingSent.size>4)this.pingSent.delete(this.pingSent.keys().next().value!);}
  const latest=this.snapshots.at(-1);if(!latest)return;
  this.advancePresentation(now);
  if(this.replaying&&!this.uiPaused)this.game.replayTime=Math.min(this.game.replayEnd+.65,this.game.replayTime+dt);
  if(!this.connected){this.predictionView.step(this.game.player,this.game.player);this.interpolate();return;}
  const active=enabled&&this.canInput(),p=this.game.player,movement=active?input:EMPTY_INPUT;
  {
   const shift=this.inputLead.takeShift();this.leadDrain+=Math.max(0,-shift);
   // Changing lead is an explicit, bounded scheduling adjustment. Replay the
   // same neutral holes as the server; never duplicate an old action to fill it.
   if(shift>0){for(let n=0;n<shift;n++){this.predictionTick++;this.game.time=this.predictionTime;if(!latest.ended)this.predict(this.neutralCommand(),STEP,false);this.skippedInputTicks++;}}
   const horizon=this.inputHorizon(now),limit=Math.min(this.latestTick+MAX_PREDICTION_TICKS,horizon+this.inputLead.ticks+4);
   if(this.predictionTick<horizon){
    this.inputStarvations++;const target=Math.min(limit,horizon+this.inputLead.ticks);
    while(this.predictionTick<target){this.predictionTick++;this.game.time=this.predictionTime;if(!latest.ended)this.predict(this.neutralCommand(),STEP,false);this.skippedInputTicks++;}
    // Neutral recovery changes timers, not horizontal position. Retaining the
    // view's existing offset avoids a second visible snap during reconciliation.
   }
   if(this.predictionTick>=limit||this.leadDrain>0){if(this.leadDrain>0)this.leadDrain--;p.moving=0;this.predictionView.step(p,p);return;}
   this.predictionTick++;this.game.time=this.predictionTime;
  }
  const command:NetworkInput={type:'input',seq:this.seq+1,tick:this.predictionTick,generation:this.playerGeneration!,...movement,yaw:p.yaw,pitch:p.pitch,ads:active&&this.desiredADS,stance:this.desiredStance,weapon:this.desiredWeapon,fire:active&&(this.actions.fire||this.actions.singleFire),reload:active&&this.actions.reload,melee:active&&this.actions.melee,shotTime:Math.max(0,this.remoteTime)};
  const encoded=encodeInput(command);
  // Preserve the former roughly 200 ms local queue limit after binary encoding
  // shrinks each input. A fixed 4 KiB allowance would now hold far older intent.
  if((this.socket?.bufferedAmount??0)>encoded.byteLength*MAX_BUFFERED_INPUT_TICKS){
   this.congestedInputs++;this.actions={fire:false,singleFire:false,reload:false,melee:false};
   const before={x:p.x,y:p.y,z:p.z};if(!latest.ended)this.predict(this.neutralCommand(),STEP,false);this.predictionView.step(before,p);return;
  }
  this.seq=command.seq;
  this.actions={fire:false,singleFire:false,reload:false,melee:false};
  if(command.jump&&command.stance!=='stand')this.desiredStance='stand';
  if(this.socket?.readyState===1){this.socket.send(encoded);this.pending.push({input:command});if(this.pending.length>120)this.pending.shift();}
  const before={x:p.x,y:p.y,z:p.z};
  if(!latest.ended)this.predict(command,STEP,active);else{p.moving=0;p.ads=false;}
  this.predictionView.step(before,p);
  this.interpolate();this.applyState();
 }
 private predict(input:NetworkInput,dt:number,effects:boolean){
  const game=this.game,p=game.player;if(!p?.alive||p.spectator)return;const priorState=game.state;game.state='playing';p.yaw=input.yaw;p.pitch=input.pitch;p.stance=input.stance;
  // These are provisional presentation states. Every snapshot replaces them;
  // HP, hit detection, deaths, score and respawning have no prediction path.
  p.cooldown=Math.max(0,p.cooldown-dt);p.spawnSafe=Math.max(0,p.spawnSafe-dt);p.recoil*=Math.exp(-dt*4.2);
  if(p.reload>0){p.reload=Math.max(0,p.reload-dt);if(!p.reload){const amount=Math.min(WEAPONS[p.faction].capacity-p.ammo,p.reserve);p.ammo+=amount;p.reserve-=amount;}}
  const emit=(event:Event)=>{if(effects){if(event.type==='shot'||event.type==='switch')this.reloadCues.delete(this.actorId);game.events.push(event);this.predictedEffects.add(`${event.type}:${input.seq}`);}};
  if(input.weapon!==p.selectedWeapon&&!game.isSwitching(p)){p.switchFrom=p.selectedWeapon;p.selectedWeapon=input.weapon;p.switchStarted=game.time;p.switchDuration=WEAPON_SWITCH_SECONDS;p.reload=0;p.reloadTotal=0;p.ads=false;emit({type:'switch',actor:0,weapon:p.selectedWeapon});}
  let startedReload=false;
  if(input.reload&&p.selectedWeapon==='rifle'&&!game.isSwitching(p)&&!game.isMeleeRecovery(p)&&!p.reload&&p.ammo<WEAPONS[p.faction].capacity&&p.reserve>0){p.reloadTotal=WEAPONS[p.faction].reload*(p.faction==='british'&&p.ammo>=5?.66:1);p.reload=p.reloadTotal;p.ads=false;startedReload=true;}
  p.ads=input.ads&&game.canADS(p);
  const length=Math.max(1,Math.hypot(input.forward,input.right)),f=input.forward/length,r=input.right/length,walk=input.walk?.55:1;
  const previousPhase=p.pose?.phase??0;
  game.move(p,(Math.sin(p.yaw)*f-Math.cos(p.yaw)*r)*walk,(Math.cos(p.yaw)*f+Math.sin(p.yaw)*r)*walk,dt,input.jump,sampleNetworkColliders(this.snapshots,game.time,this.actorId));
  game.playerHipSpread=advanceHipSpread(game.playerHipSpread,p.stance,p.moving,dt);
  p.lean=advanceLean(p,input.lean,dt);
  const melee=input.melee||p.selectedWeapon==='grenade';
  if((input.fire||input.melee)&&!game.isSwitching(p)&&!p.cooldown&&(melee||!p.reload)&&!(p.stance==='prone'&&p.moving>.1)&&(melee||p.ammo>0)){
   const origin=game.eye(p),direction={x:Math.sin(p.yaw)*Math.cos(p.pitch+p.recoil),y:Math.sin(p.pitch+p.recoil),z:Math.cos(p.yaw)*Math.cos(p.pitch+p.recoil)},range=Math.min(melee?1.85:120,worldHit(origin,direction));
   if(melee){p.reload=0;p.reloadTotal=0;p.lastMeleeTime=game.time;}else{p.lastShotTime=game.time;p.ammo--;p.recoil+=WEAPONS[p.faction].recoil;}p.cooldown=melee?MELEE_SECONDS:WEAPONS[p.faction].cycle;p.spawnSafe=0;
   emit({type:'shot',actor:0,shot:{time:game.time,actor:0,origin,end:{x:origin.x+direction.x*range,y:origin.y+direction.y*range,z:origin.z+direction.z*range},kind:melee?'melee':'shot',hit:null,headshot:false}});
  }
  // Resolve coalesced R+melee after actual movement/prone eligibility. A
  // cancelled provisional reload must not play a reload sound or effect.
  if(startedReload&&p.reload>0)emit({type:'reload',actor:0});
  if(effects)game.footstep(p,previousPhase);
  game.state=priorState;
 }
 private validSnapshot(value:unknown):value is WireSnapshot {
  const s=value as WireSnapshot;if(!s||s.type!=='snapshot'||!Array.isArray(s.actors)||s.actors.length<1||s.actors.length>6||s.actors.some(actor=>!actor||typeof actor!=='object')||!validEvents(s.events)||!Number.isFinite(s.time)||!Number.isFinite(s.remaining)||!Number.isSafeInteger(s.tick)||!Number.isSafeInteger(s.roundNumber))return false;
  if(s.inputTiming!=='tick-v2')return false;
  if(s.lobbyId!==undefined&&s.lobbyId!==this.lobbyId||s.eventSeq!==undefined&&(!Number.isSafeInteger(s.eventSeq)||s.eventSeq<0))return false;
  for(const a of s.actors)if(!Number.isSafeInteger(a.ack)||a.ack<0||(!Number.isSafeInteger(a.spawnGeneration)||a.spawnGeneration!<0))return false;
  for(const a of s.actors)if(a.inputTiming&&(['received','late','missing'].some(key=>!Number.isSafeInteger(a.inputTiming![key as 'received'])||a.inputTiming![key as 'received']<0)||!Number.isSafeInteger(a.inputTiming.arrivalLead)))return false;
  const ids=new Set<number>();for(const a of s.actors){if(!Number.isSafeInteger(a.id)||ids.has(a.id)||!['british','russian','german'].includes(a.faction)||!['stand','crouch','prone'].includes(a.stance)||!['rifle','grenade'].includes(a.selectedWeapon)||!['rifle','grenade'].includes(a.switchFrom)||typeof a.name!=='string'||typeof a.spectator!=='boolean')return false;ids.add(a.id);if(actorNumericFields.some(key=>!Number.isFinite(a[key])))return false;if(a.ping!=null&&(!Number.isInteger(a.ping)||a.ping<0||a.ping>999))return false;if(a.pose&&(poseFields.some(key=>!Number.isFinite(a.pose![key]))||['crouch','prone','aim'].some(key=>a.pose![key as 'crouch']<0||a.pose![key as 'crouch']>1)||a.pose.speed<0||a.pose.speed>10||Math.abs(a.pose.forward)>1.001||Math.abs(a.pose.sideways)>1.001))return false;}
  return ids.has(this.actorId);
 }
 /** Public for deterministic protocol regression tests; rejects malformed frames. */
 receiveSnapshot(snapshot:unknown):boolean {
  const decoded=decodeSnapshot(snapshot);if(!this.validSnapshot(decoded))return false;const s=decoded,last=this.snapshots.at(-1);if(last&&(s.tick<=last.tick||s.time<last.time))return false;
  const game=this.game,newIds=[this.actorId,...s.actors.filter(a=>a.id!==this.actorId).map(a=>a.id).sort((a,b)=>a-b)],rosterChanged=newIds.join(',')!==this.ids.join(',')||s.actors.some(a=>{const index=this.ids.indexOf(a.id);return index>=0&&game.actors[index]?.faction!==a.faction;});
  const oldIds=this.ids;const newRound=this.roundNumber!==s.roundNumber,oldPlayer=game.player,oldYaw=oldPlayer?.yaw,oldPitch=oldPlayer?.pitch,wasAlive=oldPlayer?.alive??false,wasSpectator=oldPlayer?.spectator??false;
  const self=s.actors.find(a=>a.id===this.actorId)!,before=oldPlayer?{x:oldPlayer.x,y:oldPlayer.y,z:oldPlayer.z}:self;
  const reset=!last||newRound||wasAlive!==self.alive||wasSpectator!==self.spectator||oldPlayer?.faction!==self.faction||self.spawnGeneration!==this.playerGeneration;
  this.playerGeneration=self.spawnGeneration;
  if(self.ping!=null&&this.now()-this.rttSampleAt>2500)this.roundTrip=self.ping;
  if(rosterChanged){
   // A reliable kill may be waiting for the next render when a newer roster
   // arrives. Keep its captured identity and remap its indices before removing
   // body effects that refer to the previous actor array.
   const queuedKills=game.events.filter(event=>event.type==='kill').map(event=>({
    ...event,actorName:event.actorName??game.actors[event.actor]?.name,
    victimName:event.victimName??game.actors[event.victim!]?.name,
    actorFaction:event.actorFaction??game.actors[event.actor]?.faction,
    actor:newIds.indexOf(oldIds[event.actor]),victim:event.victim===undefined?undefined:newIds.indexOf(oldIds[event.victim]),
   }));
   const existing=new Map(oldIds.map((id,index)=>[id,game.actors[index]]));this.ids=newIds;
   game.actors=newIds.map((id,index)=>{const a=s.actors.find(p=>p.id===id)!;const actor=existing.get(id)??Object.assign(createActor(index,a.faction,a.name),a,{pose:a.pose?{...a.pose}:undefined});return Object.assign(actor,{id:index,collisionId:id,renderIdentity:`${this.lobbyId}:${id}`});});
   game.history=[];game.shots=[];game.events=queuedKills;this.replaying=false;game.replay=[];game.replayShots=[];
  }
  this.seq=Math.max(this.seq,self.ack);
  if(self.spectator&&!wasSpectator)game.spectator.enter(oldPlayer??self);
  if(!self.spectator&&wasSpectator)game.spectator.reset();
  Object.assign(game.player,self,{id:0,collisionId:this.actorId,name:sanitizePlayerName(self.name),ping:self.ping??null,pose:self.pose?{...self.pose}:undefined});game.time=s.time;game.remaining=s.remaining;game.playerHipSpread=self.hipSpread;
  this.latestTime=s.time;this.latestTick=s.tick;this.lastSnapshotAt=this.now();this.roundNumber=s.roundNumber;
  if(reset){this.inputLead.reset(this.lastSnapshotAt,!!last);this.leadDrain=0;}this.inputLead.observe(self.inputTiming,this.lastSnapshotAt);
  this.playback.receive(s.time,this.lastSnapshotAt,!last||newRound);
  if(newRound)this.snapshots=[];this.snapshots.push(s);if(this.snapshots.length>12)this.snapshots.shift();
  if(reset){
   this.pending=[];this.actions={fire:false,singleFire:false,reload:false,melee:false};this.desiredStance=self.stance;this.desiredWeapon=self.selectedWeapon;this.desiredADS=false;this.predictedEffects.clear();
   this.predictionTick=s.tick+(s.ended?0:Math.min(MAX_PREDICTION_TICKS-1,Math.ceil(this.roundTrip/(STEP*1000))+this.inputLead.ticks));
  }
  this.predictionTick=Math.max(this.predictionTick,s.tick);
  this.advancePresentation(this.lastSnapshotAt);
  this.pending=this.pending.filter(p=>p.input.tick>s.tick);
  if(self.alive&&!self.spectator&&!s.ended){
   {
    const commands=new Map(this.pending.map(p=>[p.input.tick,p.input]));
    for(let tick=s.tick+1;tick<=this.predictionTick;tick++){game.time=s.time+(tick-s.tick)*STEP;this.predict(commands.get(tick)??this.neutralCommand(),STEP,false);}
   }
   if(!reset&&oldYaw!==undefined){game.player.yaw=oldYaw;game.player.pitch=oldPitch!;}
  }
  game.time=this.predictionTime;game.remaining=Math.max(0,s.remaining-Math.max(0,this.presentationTime-s.time));
  const correction=Math.hypot(game.player.x-before.x,game.player.y-before.y,game.player.z-before.z);if(!reset&&correction>.001){this.correctionCount++;this.maximumCorrection=Math.max(this.maximumCorrection,correction);}
  this.predictionView.reconcile(before,game.player,this.lastSnapshotAt,reset);this.renderedPosition=this.predictionView.sample(1,this.lastSnapshotAt);
  const mapActor=(a:WireActor)=>({...a,pose:a.pose?{...a.pose}:undefined,id:this.ids.indexOf(a.id),name:sanitizePlayerName(a.name)});
  const frame:Snapshot={time:s.time,actors:this.ids.map(id=>mapActor(s.actors.find(a=>a.id===id)!))};game.history.push(frame);while(game.history.length&&s.time-game.history[0].time>4.5)game.history.shift();
  // Never expose the newest remote position between a socket callback and the
  // next render. The same buffered sample is used on arrival and on every RAF.
  this.interpolate();
  if(newRound){this.replaying=false;game.replay=[];game.replayShots=[];game.shots=[];game.winner=null;this.presentedCueKeys.clear();this.onRound();}
  // A cue can be queued for rendering when the authority callback replaces a
  // body. Never apply that old-life effect to the newly spawned actor array.
  game.events=game.events.filter(event=>{const source=this.queuedCueEvents.get(event);return !source||this.cueDisposition(source,s)==='ready';});
  this.applyEvents(s.events,s.time,s);
  this.flushEvents();
  this.flushCues();
  const mapId=(id:number)=>this.ids.indexOf(id);
  if(self.alive||self.spectator||s.ended){this.replaying=false;game.replay=[];game.replayShots=[];}
  else if(!this.replaying){
   // Reconnects and roster changes may leave no usable recording. Keep a
   // labelled death view instead of presenting a dead actor as playable.
   this.replaying=true;game.killer=0;game.replay=[frame];game.replayShots=[];game.replayEnd=s.time;game.replayTime=s.time+.65;
  }
  if(this.predictedEffects.size>120)this.predictedEffects.clear();
  if(self.spectator){this.replaying=false;if(rosterChanged)game.spectator.remap(oldIds,this.ids,game.actors);game.spectator.sync(game.actors);}
  game.winner=s.winner===null?null:game.actors[mapId(s.winner)]??null;if(s.ended)this.replaying=false;this.applyState();if(rosterChanged)this.onRoster();return true;
 }
 /** Reliable event batches may arrive before their replaceable state. Delay
  * effects until the corresponding authority frame, then deduplicate by batch. */
 receiveEvents(value:unknown):boolean{
  const batch=value as WireEventBatch;
  if(!batch||batch.type!=='events'||batch.lobbyId!==this.lobbyId||!Number.isSafeInteger(batch.eventSeq)||batch.eventSeq<1||!Number.isSafeInteger(batch.tick)||!Number.isSafeInteger(batch.roundNumber)||!Number.isFinite(batch.time)||!validEvents(batch.events))return false;
  if(batch.eventSeq<=this.eventSeq||this.eventBatches.some(event=>event.eventSeq===batch.eventSeq))return true;
  if(this.eventBatches.length>=128){this.socket?.close();return false;}
  this.eventBatches.push(batch);this.eventBatches.sort((a,b)=>a.eventSeq-b.eventSeq);this.flushEvents();return true;
 }
 /** Cosmetic cues do not wait for a replaceable authority snapshot. Identity
  * tags keep them bound to the known life; unknown/new lives get a short hold.
  * HP, positions, scores, respawns and replay transitions remain snapshot-led. */
 receiveCues(value:unknown):boolean{
  const batch=value as WireCueBatch;
  if(!batch||batch.type!=='cues'||batch.lobbyId!==this.lobbyId||!Number.isSafeInteger(batch.cueSeq)||batch.cueSeq<1||!Number.isSafeInteger(batch.tick)||batch.tick<0||!Number.isSafeInteger(batch.roundNumber)||batch.roundNumber<0||!Number.isFinite(batch.time)||batch.time<0||!validEvents(batch.events))return false;
  if(batch.events.some(event=>!cueTypes.has(event.type)||!Number.isSafeInteger(event.actorGeneration)||event.victim!==undefined&&!Number.isSafeInteger(event.victimGeneration)||event.type==='shot'&&!event.shot||event.shot?.hit!=null&&!Number.isSafeInteger(event.hitGeneration)||event.roundNumber!==undefined&&event.roundNumber!==batch.roundNumber||event.tick!==undefined&&event.tick!==batch.tick||event.time!==undefined&&event.time!==batch.time))return false;
  if(batch.cueSeq<=this.cueSeq)return true;
  this.cueSeq=batch.cueSeq;
  this.flushCues();
  // Only this cosmetic stream is lossy at the bounded hold limit. A malicious
  // or stalled future life cannot accumulate unbounded sounds or animations.
  for(const event of batch.events){if(this.pendingCues.length>=MAX_PENDING_CUES)this.pendingCues.shift();this.pendingCues.push({event:{...event,roundNumber:batch.roundNumber,tick:batch.tick,time:batch.time},expiresAt:this.now()+CUE_HOLD_MS});}
  this.flushCues();return true;
 }
 private cueDisposition(event:WireEvent,s:WireSnapshot):'ready'|'wait'|'drop'{
  if(event.roundNumber!<s.roundNumber||s.time-event.time!>CUE_HOLD_MS/1000)return'drop';
  if(event.roundNumber!>s.roundNumber)return'wait';
  const identities:[[number,number],...Array<[number,number]>]=[[event.actor,event.actorGeneration!]];
  if(event.victim!==undefined)identities.push([event.victim,event.victimGeneration!]);
  if(event.shot?.hit!=null)identities.push([event.shot.hit,event.hitGeneration!]);
  let wait=false;
  for(const [id,generation]of identities){const actor=s.actors.find(actor=>actor.id===id);if(!actor){if(event.tick!<=s.tick)return'drop';wait=true;continue;}if(generation<actor.spawnGeneration!)return'drop';if(generation>actor.spawnGeneration!){if(event.tick!<=s.tick)return'drop';wait=true;}}
  return wait?'wait':'ready';
 }
 private flushCues(){
  const latest=this.snapshots.at(-1);if(!latest)return;const now=this.now(),remaining:PendingCue[]=[];
  for(const pending of this.pendingCues){if(now>=pending.expiresAt)continue;const state=this.cueDisposition(pending.event,latest);if(state==='wait'){remaining.push(pending);continue;}if(state==='drop')continue;
   const event=pending.event;
   if(event.type==='reload'||event.type==='shot'||event.type==='switch')this.reloadCues.set(event.actor,{generation:event.actorGeneration!,roundNumber:event.roundNumber!,tick:event.tick!,expiresAt:pending.expiresAt,active:event.type==='reload'});
   const count=this.game.events.length;this.applyEvents([event],event.time!,latest,true);
   for(let index=count;index<this.game.events.length;index++)this.queuedCueEvents.set(this.game.events[index],event);
  }
  this.pendingCues=remaining;
  for(const [id,hint]of this.reloadCues){const actor=latest.actors.find(actor=>actor.id===id);if(now>=hint.expiresAt||hint.roundNumber!==latest.roundNumber||actor?.spawnGeneration!==hint.generation||!actor.alive||latest.tick>=hint.tick)this.reloadCues.delete(id);}
 }
 /** A short presentation lease prevents audio cleanup from stopping a remote
  * reload cue before its matching state arrives. It never changes ammo/timers. */
 private reloadAudioHint(actorIndex:number){const id=this.ids[actorIndex],hint=this.reloadCues.get(id);if(hint&&this.now()>=hint.expiresAt)this.reloadCues.delete(id);return this.connected?this.reloadCues.get(id):undefined;}
 hasPendingReloadCue(actorIndex:number){return this.reloadAudioHint(actorIndex)?.active===true;}
 /** Remote poses intentionally trail authority. Audio follows the newest
  * accepted action/state, so a delayed idle pose cannot cancel a new sound. */
 reloadAudioActive(actorIndex:number){const actor=this.game.actors[actorIndex];if(!this.connected||!actor?.alive)return false;const hint=this.reloadAudioHint(actorIndex);if(hint)return hint.active;return actorIndex===0?actor.reload>0:(this.snapshots.at(-1)?.actors.find(actor=>actor.id===this.ids[actorIndex])?.reload??0)>0;}
 private flushEvents(){
  const latest=this.snapshots.at(-1);if(!latest)return;
  while(this.eventBatches.length){
   const batch=this.eventBatches[0];
   if(batch.roundNumber>latest.roundNumber||batch.roundNumber===latest.roundNumber&&batch.tick>latest.tick)break;
   this.eventBatches.shift();if(batch.eventSeq<=this.eventSeq)continue;this.eventSeq=batch.eventSeq;
   this.applyEvents(batch.events.map(event=>({roundNumber:batch.roundNumber,...event})),batch.time,latest);
  }
  this.applyState();
 }
 private applyEvents(events:WireEvent[],eventTime:number,s:WireSnapshot,immediate=false){
  const game=this.game,self=s.actors.find(a=>a.id===this.actorId);if(!self)return;
  const mapId=(id:number)=>this.ids.indexOf(id);
  for(const source of events){
   const cueKey=cueTypes.has(source.type)&&source.actorGeneration!==undefined&&source.roundNumber!==undefined&&source.tick!==undefined?`${source.roundNumber}:${source.tick}:${source.actor}:${source.actorGeneration}:${source.type}:${source.seq??source.shot?.seq??-1}:${source.victim??-1}:${source.value??''}`:null;
   if(cueKey&&this.presentedCueKeys.has(cueKey))continue;
   const sourceActor=s.actors.find(a=>a.id===source.actor),sourceVictim=s.actors.find(a=>a.id===source.victim);
   const staleActor=source.actorGeneration!==undefined&&source.actorGeneration!==sourceActor?.spawnGeneration;
   const staleVictim=source.victimGeneration!==undefined&&source.victimGeneration!==sourceVictim?.spawnGeneration;
   const staleRound=source.roundNumber!==undefined&&source.roundNumber!==s.roundNumber;
   if((staleActor||staleRound)&&source.type!=='kill')continue;
   const actor=mapId(source.actor);if(actor<0&&source.type!=='kill')continue;const victim=source.victim===undefined?undefined:mapId(source.victim);
   if(victim!==undefined&&victim<0&&source.type!=='kill')continue;
   const shot=source.shot?{...source.shot,actor:mapId(source.shot.actor),hit:source.shot.hit===null?null:mapId(source.shot.hit)}:undefined;
   const event:Event={...source,actor,victim,shot};
   if(immediate&&cueKey){this.presentedCueKeys.add(cueKey);if(this.presentedCueKeys.size>512)this.presentedCueKeys.delete(this.presentedCueKeys.values().next().value!);}
   if(shot){game.shots.push(shot);if(game.shots.length>200)game.shots.shift();}
   const effectKey=`${event.type}:${source.seq??source.shot?.seq??-1}`,predicted=actor===0&&this.predictedEffects.delete(effectKey);
   // The attack already played locally; its confirmed hit still needs blood
   // and contact audio, without a second muzzle flash, report or recoil.
   if(predicted&&event.type==='shot'&&shot?.actor===0&&shot.hit!==null&&shot.hit>=0)this.onImpact(shot);
   if(!predicted&&!(actor===0&&event.type==='step'))game.events.push(event);
   if(event.type==='kill'&&!staleRound&&!staleActor&&!staleVictim&&actor>=0&&victim===0&&!self.alive&&!self.spectator&&!s.ended){game.killer=actor;game.replay=game.history.map(f=>({time:f.time,actors:f.actors.map(a=>({...a,pose:a.pose?{...a.pose}:undefined}))}));game.replayEnd=source.time??eventTime;game.replayTime=Math.max(game.replay[0]?.time??0,game.replayEnd-3.3);game.replayShots=game.shots.filter(shot=>shot.time>=game.replayTime&&shot.time<=game.replayEnd);this.replaying=true;this.desiredADS=false;}
   if(event.type==='spawn'&&actor===0){this.desiredStance=self.stance;this.desiredWeapon=self.selectedWeapon;this.desiredADS=false;this.replaying=false;}
  }
 }
 private interpolate(){
  if(!this.snapshots.length)return;const target=this.remoteTime;let after=this.snapshots.find(s=>s.time>=target)??this.snapshots.at(-1)!,index=this.snapshots.indexOf(after),before=this.snapshots[Math.max(0,index-1)],latest=this.snapshots.at(-1)!;
  const alpha=clamp((target-before.time)/(after.time-before.time||1),0,1);
  for(let id=1;id<this.ids.length;id++){
   const authority=latest.actors.find(a=>a.id===this.ids[id]);if(!authority)continue;
   const a=before.actors.find(a=>a.id===this.ids[id])??authority,b=after.actors.find(a=>a.id===this.ids[id])??authority;const actor=this.game.actors[id],base=alpha>=1?b:a;
   Object.assign(actor,base,{id,name:sanitizePlayerName(base.name),pose:base.pose?{...base.pose}:undefined});
   // Scores/health and identity stay authoritative even while the body is
   // presented at an earlier instant. They must not roll back with a pose.
   Object.assign(actor,Object.fromEntries(authoritativeRemoteFields.map(key=>[key,authority[key]])),{name:sanitizePlayerName(authority.name),ping:this.connected?authority.ping??null:null});
   if(a.alive!==b.alive||Math.hypot(a.x-b.x,a.z-b.z)>3)continue;
   for(const key of ['x','y','z','pitch','eyeHeight','moving','lean','recoil','vy'] as const)actor[key]=lerp(a[key],b[key],alpha);
   if(alpha<1){
    // A jump/landing can occur between the 20 Hz frames. Switching only at
    // the next snapshot makes the rendered limbs stay grounded in midair.
    const takeoff=b.leftGroundAt>a.leftGroundAt&&b.leftGroundAt<=target;
    const landed=b.landedAt>a.landedAt&&b.landedAt<=target;
    actor.leftGroundAt=takeoff?b.leftGroundAt:a.leftGroundAt;actor.jumpStarted=takeoff?b.jumpStarted:a.jumpStarted;
    actor.landedAt=landed?b.landedAt:a.landedAt;actor.landingSpeed=landed?b.landingSpeed:a.landingSpeed;
    actor.grounded=takeoff||landed?actor.landedAt>=actor.leftGroundAt:a.grounded;
    const starts=b.leftGroundAt>before.time&&b.leftGroundAt<=after.time,lands=b.landedAt>before.time&&b.landedAt<=after.time;
    // Anchor the vertical segment to the contact event instead of lifting
    // before takeoff or continuing to descend after the recorded landing.
    // Two transitions in one interval retain endpoint interpolation; their
    // event ordering still selects the correct airborne/grounded animation.
    if(starts&&!lands){
     actor.y=takeoff?lerp(a.y,b.y,clamp((target-b.leftGroundAt)/(after.time-b.leftGroundAt||1),0,1)):a.y;
     actor.vy=takeoff?(actor.jumpStarted===actor.leftGroundAt?RULES.jump:0)-RULES.gravity*(target-actor.leftGroundAt):0;
    }else if(lands&&!starts){
     actor.y=landed?b.y:lerp(a.y,b.y,clamp((target-before.time)/(b.landedAt-before.time||1),0,1));
     actor.vy=landed?0:a.vy-RULES.gravity*(target-before.time);
    }
    if(!actor.grounded)actor.ads=false;
   }
   if(a.pose&&b.pose)actor.pose=Object.fromEntries(poseFields.map(key=>[key,lerp(a.pose![key],b.pose![key],alpha)])) as unknown as NonNullable<Actor['pose']>;
   actor.yaw=a.yaw+Math.atan2(Math.sin(b.yaw-a.yaw),Math.cos(b.yaw-a.yaw))*alpha;
   if(a.reload>0&&b.reload>0&&a.reloadTotal===b.reloadTotal)actor.reload=lerp(a.reload,b.reload,alpha);
   if(a.cooldown>=b.cooldown)actor.cooldown=lerp(a.cooldown,b.cooldown,alpha);
  }
 }
}
