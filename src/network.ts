/// <reference types="vite/client" />
import {Game,createActor,type Actor,type Event,type Input,type Shot,type Snapshot} from './engine';
import {MELEE_SECONDS,RULES,WEAPONS,WEAPON_SWITCH_SECONDS,clamp,lerp,worldHit,type Faction,type Stance,type WeaponSlot} from './config';
import {advanceHipSpread} from './accuracy';
import {advanceLean} from './lean';
import {DEFAULT_PLAYER_NAME,sanitizePlayerName} from './names';

export interface Lobby {id:string;name:string;players:number;capacity:number;phase:'playing'|'ended';ping?:number}
export type WireActor=Omit<Actor,'ai'>&{ack:number;hipSpread:number};
export interface WireEvent extends Omit<Event,'shot'> {seq?:number;shot?:(Shot&{seq?:number})}
export interface WireSnapshot {type:'snapshot';tick:number;time:number;remaining:number;roundNumber:number;ended:boolean;winner:number|null;actors:WireActor[];events:WireEvent[]}
export interface NetworkInput extends Input {type:'input';seq:number;yaw:number;pitch:number;ads:boolean;stance:Stance;weapon:WeaponSlot;fire:boolean;reload:boolean;melee:boolean;shotTime:number}
interface PendingInput {input:NetworkInput;time:number}
export interface ChatMessage {id?:string;name:string;message:string}
export interface SocketLike {readyState:number;onopen:((event:any)=>void)|null;onmessage:((event:any)=>void)|null;onerror:((event:any)=>void)|null;onclose:((event:any)=>void)|null;send(data:string):void;close():void}
interface NetworkOptions {origin?:string;fetch?:typeof fetch;socket?:(url:string)=>SocketLike;storage?:Pick<Storage,'getItem'|'setItem'|'removeItem'>;now?:()=>number}
const EMPTY_INPUT:Input={forward:0,right:0,jump:false,walk:false,lean:0};
const TOKEN_KEY='bolts-multiplayer-session-v1';
const STEP=1/60,INTERPOLATION=.1;
const poseFields=['phase','crouch','prone','aim','speed','forward','sideways'] as const;
const timestampFields=['leftGroundAt','jumpStarted','landedAt','deadAt','lastShotTime','lastHurtTime','lastMeleeTime','switchStarted'] as const;
const actorNumericFields=['x','y','z','yaw','pitch','eyeHeight','hp','ammo','reserve','kills','deaths','shots','hits','cooldown','reload','reloadTotal','vy','landingSpeed','moving','lean','recoil','spawnSafe','switchDuration','deathYaw','ack','hipSpread',...timestampFields] as const;
const authoritativeRemoteFields=['spectator','name','faction','hp','ammo','reserve','kills','deaths','shots','hits','ping'] as const;

/** No device fingerprint or IP-derived identity. The server mints a random UUID
 * and an opaque bearer token, sent only over HTTPS / the first WebSocket frame. */
export class NetworkClient {
 readonly game:Game;
 onRoster=()=>{};onJoined=(_name:string)=>{};onStatus=(_text:string)=>{};onFailure=(_message:string)=>{};onChat=(_message:ChatMessage)=>{};onRound=()=>{};
 online=false;connected=false;ping=0;lobbyId='';lobbyName='';
 private origin:string;private fetcher:typeof fetch;private socketFactory:(url:string)=>SocketLike;private storage?:Pick<Storage,'getItem'|'setItem'|'removeItem'>;private now:()=>number;
 private socket:SocketLike|null=null;private token='';private actorId=-1;private ids:number[]=[];private seq=0;private pending:PendingInput[]=[];private snapshots:WireSnapshot[]=[];private predictedEffects=new Set<string>();
 private lastSnapshotAt=0;private latestTime=0;private lastMessageAt=0;private lastPingAt=0;private roundNumber=-1;private actions={fire:false,reload:false,melee:false};private desiredStance:Stance='stand';private desiredWeapon:WeaponSlot='rifle';private desiredADS=false;
 private presentationTime=0;private presentationAt=0;private clockReady=false;
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
 async lobbies():Promise<Lobby[]>{const began=this.now(),response=await this.fetcher(this.endpoint('/api/lobbies'),{cache:'no-store',signal:AbortSignal.timeout(8000)});if(!response.ok)throw new Error('Unable to load servers.');const body=await response.json();if(!Array.isArray(body.lobbies))throw new Error('Invalid server list.');const ping=Math.max(1,Math.round(this.now()-began));return body.lobbies.filter((l:Lobby)=>typeof l.id==='string'&&typeof l.name==='string'&&Number.isFinite(l.players)&&l.capacity===6).map((l:Lobby)=>({...l,ping}));}
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
  this.disconnect();this.online=true;this.profile={name:sanitizePlayerName(name),faction,spectator};this.lobbyId=lobbyId??'';this.reconnectAttempt=0;this.onStatus('Connecting…');const generation=this.generation;
  try{await this.authenticate();if(!this.online||generation!==this.generation)return;await this.openSocket();}catch(error){if(generation!==this.generation)return;this.disconnect();throw error;}
 }
 private openSocket():Promise<void>{
  const previous=this.socket;if(previous){previous.onclose=null;previous.onmessage=null;previous.onerror=null;previous.onopen=null;previous.close();}
  const generation=this.generation,url=new URL(this.endpoint('/api/ws'));url.protocol=url.protocol==='https:'?'wss:':'ws:';
  const socket=this.socketFactory(url.href);this.socket=socket;
  this.connectionPromise=new Promise((resolve,reject)=>{
   let joined=false,settled=false;const timeout=setTimeout(()=>{if(settled)return;settled=true;reject(new Error('Connection timed out.'));socket.close();},10000);
   const fail=(message:string)=>{if(!settled){settled=true;clearTimeout(timeout);reject(new Error(message));}};this.cancelOpening=()=>fail('Connection cancelled.');
   socket.onopen=()=>{if(generation===this.generation)this.send({type:'hello',version:1,token:this.token});};
   socket.onmessage=event=>{
    if(generation!==this.generation)return;let message:any;try{message=JSON.parse(String(event.data));}catch{return;}
    this.lastMessageAt=this.now();
    if(message.type==='welcome'){this.send({type:'join',...(this.lobbyId?{lobbyId:this.lobbyId}:{}),name:this.profile.name,faction:this.profile.faction,...(this.profile.spectator?{spectator:true}:{})});return;}
    if(message.type==='joined'){
     if(!Number.isSafeInteger(message.actorId)||typeof message.lobbyId!=='string'||typeof message.lobbyName!=='string'){fail('Invalid server response.');socket.close();return;}
     this.actorId=message.actorId;this.lobbyId=message.lobbyId;this.lobbyName=message.lobbyName;this.connected=true;this.reconnecting=false;this.reconnectAttempt=0;this.seq=0;this.pending=[];this.snapshots=[];this.ids=[];this.predictedEffects.clear();this.actions={fire:false,reload:false,melee:false};this.replaying=false;
     if(!this.receiveSnapshot(message.snapshot)){fail('Invalid game state.');socket.close();return;}
     joined=true;settled=true;clearTimeout(timeout);this.onStatus('');this.onJoined(this.lobbyName);if(this.profile.name!==this.game.player.name)this.send({type:'profile',name:this.profile.name});resolve();return;
    }
    if(message.type==='snapshot'&&joined){this.receiveSnapshot(message);return;}
    if(message.type==='chat'&&joined&&typeof message.text==='string'&&typeof message.name==='string'){this.onChat({id:typeof message.id==='string'?message.id:undefined,name:sanitizePlayerName(message.name),message:message.text.slice(0,2048)});return;}
    if(message.type==='pong'&&typeof message.nonce==='number'){const sent=this.pingSent.get(message.nonce);if(sent!==undefined){this.ping=Math.round(this.now()-sent);this.pingSent.delete(message.nonce);}return;}
    if(message.type==='error'){
     const text=typeof message.message==='string'?message.message:'Connection failed.';
     if(message.code==='session_replaced'||message.code==='unauthenticated'){if(message.code==='unauthenticated'){this.token='';try{this.storage?.removeItem(TOKEN_KEY);}catch{}}fail(text);this.fatal(text);return;}
     if(!joined){fail(text);socket.close();}else this.onStatus(text);
    }
   };
   socket.onerror=()=>{if(!joined)fail('Unable to connect.');};
   socket.onclose=event=>{
    clearTimeout(timeout);if(generation!==this.generation||!this.online)return;if(event?.code===4001){fail('Connected in another tab.');this.fatal('Connected in another tab.');return;}this.connected=false;this.pending=[];this.actions={fire:false,reload:false,melee:false};
    for(const actor of this.game.actors)actor.ping=null;
    if(!joined){fail('Connection closed.');return;}this.scheduleReconnect();
   };
  });return this.connectionPromise;
 }
 private scheduleReconnect(){
  if(!this.online||this.reconnectTimer)return;this.reconnecting=true;this.onStatus('Reconnecting…');
  if(this.reconnectAttempt>=5){this.fatal('Connection lost.');return;}
  const generation=this.generation,delay=Math.min(4000,500*2**this.reconnectAttempt++);
  this.reconnectTimer=setTimeout(()=>{this.reconnectTimer=null;if(generation!==this.generation||!this.online)return;void this.openSocket().catch(()=>this.scheduleReconnect());},delay);
 }
 private fatal(message:string){this.disconnect();this.onFailure(message);}
 disconnect(){
  this.generation++;this.cancelOpening?.();this.cancelOpening=null;this.online=false;this.connected=false;this.reconnecting=false;if(this.reconnectTimer)clearTimeout(this.reconnectTimer);this.reconnectTimer=null;if(this.profileTimer)clearTimeout(this.profileTimer);this.profileTimer=null;
  const socket=this.socket;this.socket=null;if(socket){socket.onclose=null;socket.onmessage=null;socket.onerror=null;socket.onopen=null;if(socket.readyState===1)try{socket.send(JSON.stringify({type:'leave'}));}catch{}socket.close();}
  this.pending=[];this.snapshots=[];this.predictedEffects.clear();this.actions={fire:false,reload:false,melee:false};this.ids=[];this.actorId=-1;this.replaying=false;this.uiPaused=false;this.pingSent.clear();this.clockReady=false;for(const actor of this.game.actors)actor.ping=null;
 }
 private send(message:unknown){if(this.socket?.readyState===1){this.socket.send(JSON.stringify(message));return true;}return false;}
 setName(name:string){const safe=sanitizePlayerName(name);if(this.profile.name===safe)return;this.profile.name=safe;if(this.profileTimer)clearTimeout(this.profileTimer);if(this.online)this.profileTimer=setTimeout(()=>{this.profileTimer=null;if(this.connected)this.send({type:'profile',name:this.profile.name});},450);}
 setFaction(faction:Faction){this.profile.faction=faction;this.profile.spectator=false;if(this.online)this.send({type:'loadout',faction});}
 spectate(){this.profile.spectator=true;this.desiredADS=false;this.actions={fire:false,reload:false,melee:false};this.pending=[];if(this.online)this.send({type:'spectate'});}
 chat(text:string){const clean=Array.from(text.trim()).slice(0,256).join('');if(clean&&this.connected)this.send({type:'chat',text:clean});}
 /** Drop unsent combat intent when focus moves to chat. Already acknowledged
  * actions remain authoritative; opening a text field never undoes a shot. */
 clearInput(){this.actions={fire:false,reload:false,melee:false};this.setADS(false);const p=this.game.player;if(p){this.desiredStance=p.stance;this.desiredWeapon=p.selectedWeapon;}}
 setPaused(paused:boolean){this.uiPaused=paused;if(paused){this.desiredADS=false;this.actions={fire:false,reload:false,melee:false};if(this.game.player)this.game.player.ads=false;}this.applyState();}
 toggleStance(stance:Stance){if(this.canInput())this.desiredStance=this.desiredStance===stance?'stand':stance;}
 selectWeapon(weapon:WeaponSlot){if(this.canInput())this.desiredWeapon=weapon;}
 setADS(ads:boolean){this.desiredADS=ads&&this.canInput()&&this.game.canADS();if(this.game.player)this.game.player.ads=this.desiredADS;}
 fire(melee=false){if(this.canInput())this.actions[melee?'melee':'fire']=true;}
 reload(){if(this.canInput())this.actions.reload=true;}
 private canInput(){return this.connected&&!this.uiPaused&&!this.replaying&&this.game.state==='playing'&&this.game.player?.alive&&!this.game.player.spectator&&!this.profile.spectator;}
 skipReplay(){if(this.replaying){this.replaying=false;this.game.replay=[];this.game.replayShots=[];this.applyState();}}
 private applyState(){if(!this.online||!this.game.player)return;const latest=this.snapshots.at(-1);this.game.state=latest?.ended?'ended':this.uiPaused?'paused':this.replaying?'killcam':'playing';}
 /** Wall-clock presentation is separate from the fixed input/prediction ticks.
  * Arrival jitter may slow the estimate slightly, but can never rewind a live
  * soldier's animation. Extrapolation stops after a quarter-second packet gap. */
 private advancePresentation(now:number){
  const elapsed=Math.max(0,(now-this.lastSnapshotAt)/1000),estimate=this.latestTime+Math.min(.25,elapsed);
  if(!this.clockReady){this.presentationTime=this.latestTime;this.clockReady=true;}
  else {
   const dt=Math.min(.25,Math.max(0,(now-this.presentationAt)/1000)),candidate=this.presentationTime+dt;
   const correction=clamp(estimate-candidate,-dt*.1,dt*.1);
   this.presentationTime=Math.max(this.presentationTime,this.latestTime,Math.min(this.latestTime+.25,candidate+correction));
  }
  this.presentationAt=now;this.game.time=this.presentationTime;
  const latest=this.snapshots.at(-1);if(latest)this.game.remaining=Math.max(0,latest.remaining-Math.max(0,this.presentationTime-latest.time));
 }
 /** Call once before each rendered frame, including frames between 60 Hz ticks. */
 present(){if(!this.online||!this.game.player||!this.snapshots.length)return;this.advancePresentation(this.now());this.interpolate();}
 /** Remote action timestamps use the same delayed clock as remote positions. */
 get remoteTime(){if(!this.snapshots.length)return this.game.time;return clamp(this.game.time-INTERPOLATION,this.snapshots[0].time,this.snapshots.at(-1)!.time);}
 /** Fixed 60 Hz local prediction. Never runs Game.update / AI or Game.damage. */
 update(dt:number,input:Input,enabled=true){
  if(!this.online||!this.game.player)return;const now=this.now();
  if(this.connected&&now-this.lastMessageAt>5000){this.socket?.close();return;}
  if(this.connected&&now-this.lastPingAt>3000){this.lastPingAt=now;this.pingSent.set(now,now);this.send({type:'ping',nonce:now});if(this.pingSent.size>4)this.pingSent.delete(this.pingSent.keys().next().value!);}
  const latest=this.snapshots.at(-1);if(!latest)return;
  this.advancePresentation(now);
  if(this.replaying&&!this.uiPaused){this.game.replayTime+=dt;if(this.game.replayTime>this.game.replayEnd+.65)this.skipReplay();}
  if(!this.connected){this.interpolate();return;}
  const active=enabled&&this.canInput(),p=this.game.player,movement=active?input:EMPTY_INPUT;
  const command:NetworkInput={type:'input',seq:++this.seq,...movement,yaw:p.yaw,pitch:p.pitch,ads:active&&this.desiredADS,stance:this.desiredStance,weapon:this.desiredWeapon,fire:active&&this.actions.fire,reload:active&&this.actions.reload,melee:active&&this.actions.melee,shotTime:Math.max(0,this.game.time-INTERPOLATION)};
  this.actions={fire:false,reload:false,melee:false};
  if(command.jump&&command.stance!=='stand')this.desiredStance='stand';
  if(this.send(command)){this.pending.push({input:command,time:this.game.time});if(this.pending.length>120)this.pending.shift();}
  if(active)this.predict(command,dt,true);else{p.moving=0;p.ads=false;}
  this.interpolate();this.applyState();
 }
 private predict(input:NetworkInput,dt:number,effects:boolean){
  const game=this.game,p=game.player;if(!p?.alive||p.spectator)return;const priorState=game.state;game.state='playing';p.yaw=input.yaw;p.pitch=input.pitch;p.stance=input.stance;
  // These are provisional presentation states. Every snapshot replaces them;
  // HP, hit detection, deaths, score and respawning have no prediction path.
  p.cooldown=Math.max(0,p.cooldown-dt);p.spawnSafe=Math.max(0,p.spawnSafe-dt);p.recoil*=Math.exp(-dt*4.2);
  if(p.reload>0){p.reload=Math.max(0,p.reload-dt);if(!p.reload){const amount=Math.min(WEAPONS[p.faction].capacity-p.ammo,p.reserve);p.ammo+=amount;p.reserve-=amount;}}
  const emit=(event:Event)=>{if(effects){game.events.push(event);this.predictedEffects.add(`${event.type}:${input.seq}`);}};
  if(input.weapon!==p.selectedWeapon&&!game.isSwitching(p)){p.switchFrom=p.selectedWeapon;p.selectedWeapon=input.weapon;p.switchStarted=game.time;p.switchDuration=WEAPON_SWITCH_SECONDS;p.reload=0;p.reloadTotal=0;p.ads=false;emit({type:'switch',actor:0,weapon:p.selectedWeapon});}
  let startedReload=false;
  if(input.reload&&p.selectedWeapon==='rifle'&&!game.isSwitching(p)&&!game.isMeleeRecovery(p)&&!p.reload&&p.ammo<WEAPONS[p.faction].capacity&&p.reserve>0){p.reloadTotal=WEAPONS[p.faction].reload*(p.faction==='british'&&p.ammo>=5?.66:1);p.reload=p.reloadTotal;p.ads=false;startedReload=true;}
  p.ads=input.ads&&game.canADS(p);
  const length=Math.max(1,Math.hypot(input.forward,input.right)),f=input.forward/length,r=input.right/length,walk=input.walk?.55:1;
  game.move(p,(Math.sin(p.yaw)*f-Math.cos(p.yaw)*r)*walk,(Math.cos(p.yaw)*f+Math.sin(p.yaw)*r)*walk,dt,input.jump);
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
  if(effects&&p.grounded&&p.moving>.2){game.stepClock+=dt*(p.stance==='stand'?1:.65);if(game.stepClock>.37){game.stepClock=0;game.events.push({type:'step',actor:0,value:p.moving});}}
  game.state=priorState;
 }
 private validSnapshot(value:unknown):value is WireSnapshot {
  const s=value as WireSnapshot;if(!s||!Array.isArray(s.actors)||s.actors.length<1||s.actors.length>6||!Array.isArray(s.events)||!Number.isFinite(s.time)||!Number.isFinite(s.remaining)||!Number.isSafeInteger(s.tick)||!Number.isSafeInteger(s.roundNumber))return false;
  const ids=new Set<number>();for(const a of s.actors){if(!Number.isSafeInteger(a.id)||ids.has(a.id)||!['british','russian','german'].includes(a.faction)||!['stand','crouch','prone'].includes(a.stance)||!['rifle','grenade'].includes(a.selectedWeapon)||!['rifle','grenade'].includes(a.switchFrom)||typeof a.name!=='string'||typeof a.spectator!=='boolean')return false;ids.add(a.id);if(actorNumericFields.some(key=>!Number.isFinite(a[key])))return false;if(a.ping!=null&&(!Number.isInteger(a.ping)||a.ping<0||a.ping>999))return false;if(a.pose&&(poseFields.some(key=>!Number.isFinite(a.pose![key]))||['crouch','prone','aim'].some(key=>a.pose![key as 'crouch']<0||a.pose![key as 'crouch']>1)||a.pose.speed<0||a.pose.speed>10||Math.abs(a.pose.forward)>1.001||Math.abs(a.pose.sideways)>1.001))return false;}
  return ids.has(this.actorId);
 }
 /** Public for deterministic protocol regression tests; rejects malformed frames. */
 receiveSnapshot(snapshot:unknown):boolean {
  if(!this.validSnapshot(snapshot))return false;const s=snapshot,last=this.snapshots.at(-1);if(last&&(s.tick<=last.tick||s.time<last.time))return false;
  const game=this.game,newIds=[this.actorId,...s.actors.filter(a=>a.id!==this.actorId).map(a=>a.id).sort((a,b)=>a-b)],rosterChanged=newIds.join(',')!==this.ids.join(',')||s.actors.some(a=>{const index=this.ids.indexOf(a.id);return index>=0&&game.actors[index]?.faction!==a.faction;});
  const oldIds=this.ids;const newRound=this.roundNumber!==s.roundNumber,oldPlayer=game.player,oldYaw=oldPlayer?.yaw,oldPitch=oldPlayer?.pitch,wasAlive=oldPlayer?.alive??false,wasSpectator=oldPlayer?.spectator??false;
  if(rosterChanged){this.ids=newIds;game.actors=newIds.map((id,index)=>{const a=s.actors.find(p=>p.id===id)!;return Object.assign(createActor(index,a.faction,a.name),a,{id:index,pose:a.pose?{...a.pose}:undefined});});game.history=[];game.shots=[];game.events=[];this.replaying=false;game.replay=[];game.replayShots=[];}
  const self=s.actors.find(a=>a.id===this.actorId)!;this.seq=Math.max(this.seq,self.ack);
  if(self.spectator&&!wasSpectator)game.spectator.enter(oldPlayer??self);
  if(!self.spectator&&wasSpectator)game.spectator.reset();
  Object.assign(game.player,self,{id:0,name:sanitizePlayerName(self.name),ping:self.ping??null,pose:self.pose?{...self.pose}:undefined});game.time=s.time;game.remaining=s.remaining;game.playerHipSpread=self.hipSpread;
  this.latestTime=s.time;this.lastSnapshotAt=this.now();this.roundNumber=s.roundNumber;
  this.advancePresentation(this.lastSnapshotAt);const renderTime=this.presentationTime;
  if(newRound||!wasAlive&&self.alive||wasSpectator!==self.spectator||rosterChanged){this.pending=[];this.actions={fire:false,reload:false,melee:false};this.desiredStance=self.stance;this.desiredWeapon=self.selectedWeapon;this.desiredADS=false;}
  this.pending=this.pending.filter(p=>p.input.seq>self.ack&&s.time-p.time<.5);
  if(!newRound&&wasAlive&&self.alive&&!self.spectator&&!rosterChanged){
   for(const pending of this.pending){game.time=pending.time;this.predict(pending.input,STEP,false);}
   if(oldYaw!==undefined){game.player.yaw=oldYaw;game.player.pitch=oldPitch!;}
  }
  game.time=renderTime;game.remaining=Math.max(0,s.remaining-Math.max(0,renderTime-s.time));if(newRound)this.snapshots=[];this.snapshots.push(s);if(this.snapshots.length>12)this.snapshots.shift();
  const mapActor=(a:WireActor)=>({...a,pose:a.pose?{...a.pose}:undefined,id:this.ids.indexOf(a.id),name:sanitizePlayerName(a.name)});
  const frame:Snapshot={time:s.time,actors:this.ids.map(id=>mapActor(s.actors.find(a=>a.id===id)!))};game.history.push(frame);while(game.history.length&&s.time-game.history[0].time>4.5)game.history.shift();
  // Never expose the newest remote position between a socket callback and the
  // next render. The same buffered sample is used on arrival and on every RAF.
  this.interpolate();
  if(newRound){this.replaying=false;game.replay=[];game.replayShots=[];game.shots=[];game.winner=null;this.onRound();}
  const mapId=(id:number)=>this.ids.indexOf(id);
  for(const source of s.events){
   const actor=mapId(source.actor);if(actor<0)continue;const victim=source.victim===undefined?undefined:mapId(source.victim);
   if(victim!==undefined&&victim<0)continue;
   const shot=source.shot?{...source.shot,actor:mapId(source.shot.actor),hit:source.shot.hit===null?null:mapId(source.shot.hit)}:undefined;
   const event:Event={...source,actor,victim,shot};
   if(shot){game.shots.push(shot);if(game.shots.length>200)game.shots.shift();}
   const effectKey=`${event.type}:${source.seq??source.shot?.seq??-1}`,predicted=actor===0&&this.predictedEffects.delete(effectKey);
   if(!predicted&&!(actor===0&&event.type==='step'))game.events.push(event);
   if(event.type==='kill'&&victim===0&&!self.spectator){game.killer=actor;game.replay=game.history.map(f=>({time:f.time,actors:f.actors.map(a=>({...a,pose:a.pose?{...a.pose}:undefined}))}));game.replayEnd=s.time;game.replayTime=Math.max(game.replay[0]?.time??0,s.time-3.3);game.replayShots=game.shots.filter(shot=>shot.time>=game.replayTime&&shot.time<=s.time);this.replaying=game.replay.length>1;this.desiredADS=false;}
   if(event.type==='spawn'&&actor===0){this.desiredStance=self.stance;this.desiredWeapon=self.selectedWeapon;this.desiredADS=false;this.replaying=false;}
  }
  if(this.predictedEffects.size>120)this.predictedEffects.clear();
  if(self.spectator){this.replaying=false;if(rosterChanged)game.spectator.remap(oldIds,this.ids,game.actors);game.spectator.sync(game.actors);}
  game.winner=s.winner===null?null:game.actors[mapId(s.winner)]??null;if(s.ended)this.replaying=false;this.applyState();if(rosterChanged)this.onRoster();return true;
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
