/// <reference types="vite/client" />
import type {SinglePlayerEvent,SinglePlayerStopReason} from './analytics';

export const VISITOR_STORAGE_KEY='bolts.visitor.v1';
export const VISITOR_HEARTBEAT_MS=60_000;
const REQUEST_TIMEOUT_MS=6_000;
const MIN_SEND_GAP_MS=1_000;
const UUID_V4=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface VisitorStorage {getItem(key:string):string|null;setItem(key:string,value:string):void}
export interface VisitorPrivacy {globalPrivacyControl?:boolean;doNotTrack?:unknown;windowDoNotTrack?:unknown;msDoNotTrack?:unknown}
export function visitorPrivacyOptOut(privacy:VisitorPrivacy):boolean {
 return privacy.globalPrivacyControl===true||[privacy.doNotTrack,privacy.windowDoNotTrack,privacy.msDoNotTrack].some(value=>value===1||typeof value==='string'&&['1','yes'].includes(value.toLowerCase()));
}
export function visitorTrackingAllowed(options:VisitorPrivacy&{production:boolean;pathname:string;search:string}):boolean {
 if(visitorPrivacyOptOut(options))return false;
 const query=new URLSearchParams(options.search),override=query.get('visits');
 if(override==='0')return false;
 if(override==='1')return true;
 return options.production&&!query.has('qa')&&!query.has('inspector')&&!/(?:^|\/)(?:inspector|performance|webgpu-probe|audio-qa)\.html$/i.test(options.pathname);
}

/** Persist a random ID independently of player identities. If persistence is
 * blocked, omit the visit rather than count a new identity on every reload. */
export function readVisitorId(storage:VisitorStorage,randomUUID:()=>string):string|null {
 try{
  const existing=storage.getItem(VISITOR_STORAGE_KEY);
  if(existing&&UUID_V4.test(existing))return existing.toLowerCase();
  const created=randomUUID();if(!UUID_V4.test(created))return null;
  storage.setItem(VISITOR_STORAGE_KEY,created.toLowerCase());
  const persisted=storage.getItem(VISITOR_STORAGE_KEY);
  return persisted&&UUID_V4.test(persisted)?persisted.toLowerCase():null;
 }catch{return null;}
}

interface VisitorDocument extends EventTarget {readonly hidden:boolean}
interface SessionEvent {event:SinglePlayerEvent;sessionId:string;reason?:SinglePlayerStopReason}
export interface VisitorTrackerOptions {
 enabled:boolean;
 origin:string;
 storage:VisitorStorage;
 randomUUID:()=>string;
 document:VisitorDocument;
 window:EventTarget;
 fetcher:(url:string,options:RequestInit)=>Promise<unknown>;
 now:()=>number;
 setTimer:(callback:()=>void,delay:number)=>number;
 clearTimer:(timer:number)=>void;
 privacyOptOut?:()=>boolean;
 /** Web Locks serialize the first ID creation across simultaneous tabs. */
 identityLock?:(read:()=>string|null)=>Promise<string|null>;
}

function visitEndpoint(origin:string):string|null {
 try{
  const parsed=new URL(origin);
  if(parsed.username||parsed.password)return null;
  if(parsed.protocol!=='https:'&&!(parsed.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(parsed.hostname)))return null;
  return new URL('/api/visits',parsed).href;
 }catch{return null;}
}

/** Small, independent lifecycle: neither fetch failures nor response parsing
 * can delay graphics, local play, multiplayer, or loading-error presentation. */
export class VisitorTracker {
 private running=false;private generation=0;private visitorId:string|null=null;
 private endpoint:string|null;private heartbeat:number|null=null;private lastAttempt=-Infinity;
 private active=false;private pageHidden=false;
 private singlePlayerRequested=false;private singlePlayerId:string|null=null;
 private pendingEvents:SessionEvent[]=[];
 private requests=new Map<AbortController,number>();
 constructor(private options:VisitorTrackerOptions){this.endpoint=visitEndpoint(options.origin);}
 start():void {
  if(this.running||!this.endpoint||!this.permitted())return;
  this.running=true;const generation=++this.generation;
  this.active=false;this.pageHidden=false;
  // The identity lock can outlive navigation. Keep the queued game boundaries
  // and page suspension accurate while waiting for another tab's storage read.
  this.options.document.addEventListener('visibilitychange',this.visibilityChanged);
  this.options.window.addEventListener('pagehide',this.pageHide);
  this.options.window.addEventListener('pageshow',this.pageShow);
  const read=()=>this.running&&generation===this.generation&&this.permitted()?readVisitorId(this.options.storage,this.options.randomUUID):null;
  const activate=(id:string|null)=>{
   if(!this.running||generation!==this.generation)return;
   if(!id||!this.permitted()){this.stop();return;}
   this.visitorId=id;this.active=!this.options.document.hidden&&!this.pageHidden;
   this.send(false);
   for(const event of this.pendingEvents.splice(0))this.sendSessionEvent(event);
   this.schedule();
  };
  try{
   if(this.options.identityLock)void this.options.identityLock(read).then(activate).catch(()=>{if(generation===this.generation)this.stop();});
   else activate(read());
  }catch{this.stop();}
 }
 stop():void {
  this.running=false;this.generation++;this.cancelHeartbeat();
  this.options.document.removeEventListener('visibilitychange',this.visibilityChanged);
  this.options.window.removeEventListener('pagehide',this.pageHide);
  this.options.window.removeEventListener('pageshow',this.pageShow);
  for(const[controller,timer]of this.requests){this.options.clearTimer(timer);controller.abort();}
  this.requests.clear();this.visitorId=null;this.singlePlayerRequested=false;this.singlePlayerId=null;this.pendingEvents=[];
 }
 /** A session includes pause/team menus. Call only once local play actually
  * begins, then stop on leaving or finishing the round. */
 startSinglePlayer():void {
  if(this.singlePlayerRequested)return;
  this.singlePlayerRequested=true;this.openSinglePlayer();
 }
 stopSinglePlayer(reason:SinglePlayerStopReason='quit'):void {
  this.singlePlayerRequested=false;this.closeSinglePlayer(reason);
 }
 private openSinglePlayer(){
  if(!this.running||!this.permitted()||this.pageHidden||this.singlePlayerId)return;
  try{
   const id=this.options.randomUUID();if(!UUID_V4.test(id))return;
   this.singlePlayerId=id.toLowerCase();this.queueSessionEvent({event:'single_player_start',sessionId:this.singlePlayerId});
  }catch{/* Missing browser crypto cannot block local play. */}
 }
 private closeSinglePlayer(reason:SinglePlayerStopReason){
  if(!this.singlePlayerId)return;
  const sessionId=this.singlePlayerId;this.singlePlayerId=null;
  this.queueSessionEvent({event:'single_player_stop',sessionId,reason});
 }
 private queueSessionEvent(event:SessionEvent){
  if(!this.running||!this.permitted())return;
  if(this.visitorId)this.sendSessionEvent(event);
  else if(this.pendingEvents.length<32)this.pendingEvents.push(event);
 }
 private sendSessionEvent(event:SessionEvent){
  // Session boundaries bypass the one-second heartbeat gap. A quick match
  // start/exit still produces both events, even next to a page-open receipt.
  this.request(event,event.event==='single_player_stop');
 }
 private permitted():boolean {try{return this.options.enabled&&!this.options.privacyOptOut?.();}catch{return false;}}
 private cancelHeartbeat(){if(this.heartbeat!==null){this.options.clearTimer(this.heartbeat);this.heartbeat=null;}}
 private schedule(){
  this.cancelHeartbeat();
  if(!this.running||!this.active||this.pageHidden||this.options.document.hidden)return;
  const delay=Math.max(MIN_SEND_GAP_MS,VISITOR_HEARTBEAT_MS-(this.options.now()-this.lastAttempt));
  this.heartbeat=this.options.setTimer(()=>{this.heartbeat=null;if(this.active&&!this.pageHidden&&!this.options.document.hidden)this.send(false);this.schedule();},delay);
 }
 private visibilityChanged=()=>{if(this.options.document.hidden)this.suspend();else if(!this.pageHidden)this.resume();};
 private pageHide=()=>{this.pageHidden=true;this.closeSinglePlayer('page_exit');this.suspend();};
 private pageShow=()=>{this.pageHidden=false;if(this.singlePlayerRequested)this.openSinglePlayer();if(!this.options.document.hidden)this.resume();};
 private suspend(){
  this.cancelHeartbeat();
  if(this.active){this.active=false;this.send(true);}
 }
 private resume(){
  if(!this.running||!this.visitorId)return;this.active=true;
  if(this.options.now()-this.lastAttempt>=VISITOR_HEARTBEAT_MS)this.send(false);
  this.schedule();
 }
 private send(final:boolean){
  if(!this.running||!this.visitorId||!this.endpoint)return;
  if(!this.permitted()){this.stop();return;}
  const now=this.options.now();if(now-this.lastAttempt<MIN_SEND_GAP_MS)return;
  this.lastAttempt=now;
  this.request({},final);
 }
 private request(payload:Partial<SessionEvent>,final:boolean){
  if(!this.running||!this.visitorId||!this.endpoint||this.requests.size>=32)return;
  if(!this.permitted()){this.stop();return;}
  const controller=new AbortController(),timeout=this.options.setTimer(()=>{controller.abort();this.requests.delete(controller);},REQUEST_TIMEOUT_MS);
  this.requests.set(controller,timeout);
  const finish=()=>{this.options.clearTimer(timeout);this.requests.delete(controller);};
  try{
   void Promise.resolve(this.options.fetcher(this.endpoint,{
    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({visitorId:this.visitorId,...payload}),
    credentials:'omit',referrerPolicy:'no-referrer',cache:'no-store',redirect:'error',mode:'cors',
    keepalive:final,signal:controller.signal,
   })).catch(()=>{}).finally(finish);
  }catch{finish();}
 }
}

/** Called before UI/WebGL construction; deliberately never awaited. */
export function startVisitorTracking():VisitorTracker|null {
 try{
  const nav=navigator as Navigator&{globalPrivacyControl?:boolean;msDoNotTrack?:string};
  const privacy=():VisitorPrivacy=>({globalPrivacyControl:nav.globalPrivacyControl,doNotTrack:nav.doNotTrack,windowDoNotTrack:(window as Window&{doNotTrack?:string}).doNotTrack,msDoNotTrack:nav.msDoNotTrack});
  if(!visitorTrackingAllowed({production:import.meta.env?.PROD??false,pathname:location.pathname,search:location.search,...privacy()}))return null;
  const tracker=new VisitorTracker({
   enabled:true,origin:import.meta.env?.VITE_MULTIPLAYER_URL??'',storage:window.localStorage,randomUUID:()=>crypto.randomUUID(),
   document,window,fetcher:fetch.bind(globalThis),now:()=>performance.now(),
   setTimer:(callback,delay)=>window.setTimeout(callback,delay),clearTimer:timer=>window.clearTimeout(timer),
   privacyOptOut:()=>visitorPrivacyOptOut(privacy()),
   identityLock:nav.locks?read=>nav.locks.request(VISITOR_STORAGE_KEY,read):undefined,
  });
  tracker.start();return tracker;
 }catch{return null;}
}
