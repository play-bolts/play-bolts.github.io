import features from '../shared/features.json';

export const EXTRA_LOBBIES_ENABLED=features.extraLobbies===true;
/** Unlabelled legacy rooms are Oregon; extra regions require an explicit release flag. */
export function lobbyLocationEnabled(location?:string,extraLobbiesEnabled=EXTRA_LOBBIES_ENABLED):boolean {
 return !location||location==='or'||extraLobbiesEnabled&&Object.hasOwn(LOBBY_LOCATIONS,location);
}
/** Location identifiers come from the global directory, never from the viewer. */
export const LOBBY_LOCATIONS = {
 or:{name:'Oregon',abbreviation:'OR',flag:'🇺🇸',country:'us',aws:'us-west-2'},
 lon:{name:'London',abbreviation:'LON',flag:'🇬🇧',country:'gb',aws:'eu-west-2'},
 sg:{name:'Singapore',abbreviation:'SG',flag:'🇸🇬',country:'sg',aws:'ap-southeast-1'},
 sp:{name:'São Paulo',abbreviation:'SP',flag:'🇧🇷',country:'br',aws:'sa-east-1'},
} as const;
export type LobbyLocation=keyof typeof LOBBY_LOCATIONS;
export interface Lobby {
 id:string;name:string;players:number;bots?:number;capacity:number;
 phase:'playing'|'ended'|'starting';location?:string;ping?:number;
 pingUrl?:string;managed?:boolean;
}
export function locationLabel(location?:string){
 return location&&Object.hasOwn(LOBBY_LOCATIONS,location)?LOBBY_LOCATIONS[location as LobbyLocation]:undefined;
}
/** Only first-party game endpoints may receive probes or admission tickets. */
export function gameEndpoint(value:string,controlOrigin:string):URL {
 const url=new URL(value),control=new URL(controlOrigin);
 const local=['localhost','127.0.0.1','[::1]'].includes(url.hostname);
 const secure=url.protocol==='wss:'||url.protocol==='https:';
 const sameHost=url.hostname===control.hostname&&url.port===control.port;
 const gameLift=/^[a-z0-9.-]+\.amazongamelift\.com$/.test(url.hostname);
 if(url.username||url.password||url.search||url.hash||(!secure&&!(local&&['ws:','http:'].includes(url.protocol)))||(!sameHost&&!gameLift&&!(['localhost','127.0.0.1','[::1]'].includes(control.hostname)&&local)))throw new Error('Invalid game server endpoint.');
 return url;
}

export interface ProbeSocket {
 onopen:((event:any)=>void)|null;onmessage:((event:any)=>void)|null;
 onerror:((event:any)=>void)|null;onclose:((event:any)=>void)|null;
 send(data:string):void;close():void;
}
/** Exclude DNS/TLS setup; take the median of three fresh application RTTs. */
export function probeLobby(url:string,socketFactory:(url:string)=>ProbeSocket,now:()=>number,signal?:AbortSignal,timeoutMs=2500):Promise<number|undefined> {
 return new Promise(resolve=>{
  if(signal?.aborted){resolve(undefined);return;}
  let socket:ProbeSocket|undefined,done=false,sent=0,nonce='',round=0;const samples:number[]=[];
  const finish=(value?:number)=>{if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);if(socket){socket.onopen=null;socket.onmessage=null;socket.onerror=null;socket.onclose=null;socket.close();}resolve(value);};
  const abort=()=>finish();const timer=setTimeout(()=>finish(),timeoutMs);
  const send=()=>{nonce=`${++round}:${Math.random().toString(36).slice(2)}`;sent=now();socket!.send(JSON.stringify({type:'ping',nonce}));};
  signal?.addEventListener('abort',abort,{once:true});
  try{
   socket=socketFactory(url);socket.onopen=()=>{try{send();}catch{finish();}};
   socket.onmessage=e=>{try{const message=JSON.parse(String(e.data));if(message.type!=='pong'||message.nonce!==nonce)return;const elapsed=now()-sent;if(!Number.isFinite(elapsed)||elapsed<0){finish();return;}samples.push(elapsed);if(samples.length===3){samples.sort((a,b)=>a-b);finish(Math.max(1,Math.round(samples[1])));}else send();}catch{finish();}};
   socket.onerror=()=>finish();socket.onclose=()=>finish();
  }catch{finish();}
 });
}
