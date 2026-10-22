import test from 'node:test';
import assert from 'node:assert/strict';
import {gameEndpoint,locationLabel,LOBBY_LOCATIONS,probeLobby,lobbyBrowserRows,selectedBrowserLobby,type LobbyBrowserRow,type ProbeSocket} from '../src/lobbies.ts';
import {NetworkClient,type SocketLike} from '../src/network.ts';
import {Game} from '../src/engine.ts';

test('location labels map to the requested physical GameLift locations',()=>{
 assert.deepEqual(Object.values(LOBBY_LOCATIONS).map(v=>`${v.flag} ${v.abbreviation}`),['🇺🇸 OR','🇬🇧 LON','🇸🇬 SG','🇧🇷 SP']);
 assert.deepEqual(Object.values(LOBBY_LOCATIONS).map(v=>[v.name,v.aws]),[
  ['Oregon','us-west-2'],['London','eu-west-2'],['Singapore','ap-southeast-1'],['São Paulo','sa-east-1'],
 ]);
 assert.equal(locationLabel('sp')?.name,'São Paulo');assert.equal(locationLabel('toString'),undefined);assert.equal(locationLabel('ny'),undefined);
});
test('untrusted or insecure addresses never receive a probe or admission ticket',()=>{
 const base='https://bolts-api.example.com';
 assert.equal(gameEndpoint('wss://abc.us-west-1.amazongamelift.com:8080/api/ws',base).port,'8080');
 assert.equal(gameEndpoint('ws://127.0.0.1:9000/api/ws','http://localhost:5173').hostname,'127.0.0.1');
 for(const url of ['wss://evil.example/api/ws','ws://abc.amazongamelift.com/api/ws','wss://abc.amazongamelift.com.evil.example/api/ws','wss://x:y@abc.amazongamelift.com/api/ws','wss://abc.amazongamelift.com/api/ws?token=x','ws://127.0.0.1:9000/api/ws'])assert.throws(()=>gameEndpoint(url,base));
});
class Echo implements SocketLike {
 readyState=1;onopen:ProbeSocket['onopen']=null;onmessage:ProbeSocket['onmessage']=null;onerror:ProbeSocket['onerror']=null;onclose:ProbeSocket['onclose']=null;closed=false;calls=0;
 constructor(private advance:(n:number)=>void,private samples:number[]){queueMicrotask(()=>this.onopen?.({}));}
 send(raw:string){const p=JSON.parse(raw);this.advance(this.samples[this.calls++]);queueMicrotask(()=>this.onmessage?.({data:JSON.stringify({type:'pong',nonce:p.nonce})}));}
 close(){this.closed=true;}
}
test('ping excludes connection setup and uses a nonce-checked median of three RTTs',async()=>{
 let now=0;let socket:Echo|undefined;
 const measured=probeLobby('wss://host/api/ping',()=>{now+=900;return socket=new Echo(n=>now+=n,[52,140,49]);},()=>now);
 assert.equal(await measured,52);assert.equal(socket?.closed,true);assert.equal(socket?.calls,3);
 const abort=new AbortController();abort.abort();assert.equal(await probeLobby('',()=>{throw Error('must not connect');},()=>0,abort.signal),undefined);
 assert.equal(await probeLobby('',()=>({onopen:null,onmessage:null,onerror:null,onclose:null,send(){},close(){}}),()=>0,undefined,5),undefined);
});
test('every viewer sees every real lobby, with independently measured RTT and no starting probes',async()=>{
 const rows=[
  {id:'or',name:'Alpha',location:'or',players:2,capacity:6,phase:'playing',managed:true,ping:1,pingUrl:'wss://or.amazongamelift.com:8080/api/ping'},
  {id:'or2',name:'Bravo',location:'or',players:1,capacity:6,phase:'playing',managed:true,pingUrl:'wss://or.amazongamelift.com:8080/api/ping'},
  {id:'lon',name:'Charlie',location:'lon',players:1,capacity:6,phase:'playing',managed:true,pingUrl:'wss://lon.amazongamelift.com:8080/api/ping'},
  {id:'sg',name:'Delta',location:'sg',players:0,capacity:6,phase:'starting',managed:true},
 ];
 async function viewer(samples:Record<string,number>){const opened:string[]=[];
  // A per-socket clock makes deterministic concurrent probes independent.
  let active=0;const times=[0,0];
  const client=new NetworkClient(new Game(),{extraLobbiesEnabled:true,origin:'https://api.example.com',fetch:async()=>new Response(JSON.stringify({lobbies:rows})),now:()=>times[active],socket:url=>{const i=opened.length;opened.push(url);const delay=samples[new URL(url).hostname];const socket=new Echo(n=>{active=i;times[i]+=n},[delay,delay,delay]);socket.send=(raw:string)=>{const p=JSON.parse(raw);queueMicrotask(()=>{active=i;times[i]+=delay;socket.onmessage?.({data:JSON.stringify({type:'pong',nonce:p.nonce})});});};return socket;}});
  const all=await client.lobbies();assert.ok(all.every(r=>r.ping===undefined));const result=await client.measureLobbies(all);assert.equal(opened.length,2);return result;
 }
 const oregon=await viewer({'or.amazongamelift.com':20,'lon.amazongamelift.com':155});
 const europe=await viewer({'or.amazongamelift.com':160,'lon.amazongamelift.com':18});
 assert.deepEqual(oregon.map(r=>r.id),europe.map(r=>r.id));
 assert.deepEqual(oregon.map(r=>r.ping),[20,20,155,undefined]);
 assert.deepEqual(europe.map(r=>r.ping),[160,160,18,undefined]);
});
test('managed join cancellation cannot open a late WebSocket or lose the browser identity',async()=>{
 let resolveJoin:(r:Response)=>void=()=>{};let opened=0;const storage=new Map<string,string>();
 const client=new NetworkClient(new Game(),{extraLobbiesEnabled:true,origin:'https://api.example.com',storage:{getItem:k=>storage.get(k)??null,setItem:(k,v)=>void storage.set(k,v),removeItem:k=>void storage.delete(k)},fetch:async(url)=>String(url).endsWith('/lobbies')?new Response(JSON.stringify({version:2,lobbies:[],locations:['lon','sg','sp']})):String(url).endsWith('/session')?new Response(JSON.stringify({token:'a'.repeat(64)})):new Promise(r=>resolveJoin=r),socket:()=>{opened++;throw Error('late socket');}});
 assert.deepEqual(await client.lobbies(),[]);assert.deepEqual(client.locations,['lon','sg','sp']);const pending=client.join('new:sp','Alice','british');await new Promise(r=>setImmediate(r));client.disconnect();
 resolveJoin(new Response(JSON.stringify({lobbyId:'game',ticket:'short-lived',websocketUrl:'wss://abc.amazongamelift.com:8080/api/ws'})));
 await pending;assert.equal(opened,0);assert.equal(client.online,false);assert.equal(storage.size,1);
});
test('an idle listing row obtains managed admission even when no lobby is running',async()=>{
 const sent:any[]=[];const requests:string[]=[];
 const client=new NetworkClient(new Game(),{extraLobbiesEnabled:true,origin:'https://api.example.com',fetch:async(url,options)=>{
  if(String(url).endsWith('/lobbies'))return new Response(JSON.stringify({version:2,lobbies:[],locations:['lon','sg','sp']}));
  if(String(url).endsWith('/session'))return new Response(JSON.stringify({token:'a'.repeat(64)}));
  requests.push(JSON.parse(String(options?.body)).lobbyId);return new Response(JSON.stringify({lobbyId:'game-sp',ticket:'temporary-ticket-'.repeat(8),websocketUrl:'wss://sp.amazongamelift.com:8080/api/ws'}));
 },socket:()=>{const socket:SocketLike={readyState:1,onopen:null,onmessage:null,onerror:null,onclose:null,send(raw){sent.push(JSON.parse(String(raw)));},close(){}};queueMicrotask(()=>socket.onopen?.({}));return socket;}});
 const rows=lobbyBrowserRows(await client.lobbies(),client.locations);const idle=rows.find(row=>row.location==='sp')!;const joining=client.join(idle.id,'Alice','british');await new Promise(r=>setImmediate(r));
 assert.deepEqual(requests,['new:sp']);assert.equal(client.lobbyId,'game-sp');assert.equal(client.lobbyLocation,'sp','new location survives reservation changing the lobby ID');assert.equal(sent[0].token,'temporary-ticket-'.repeat(8));
 client.disconnect();await joining;
});
test('one listing keeps all four idle locations joinable without inventing live rooms or ping',()=>{
 const oregon:LobbyBrowserRow={id:'oregon-game',name:'Rommel Alpha',location:'or',players:0,capacity:6,ping:35,phase:'playing'};
 const rows=lobbyBrowserRows([oregon],['lon','sg','sp','lon']);
 assert.deepEqual(rows.map(row=>row.location),['or','lon','sg','sp']);assert.deepEqual(rows[0],oregon);
 assert.deepEqual(rows.slice(1).map(row=>row.id),['new:lon','new:sg','new:sp']);
 assert.ok(rows.slice(1).every(row=>row.name==='New lobby'&&row.players===0&&row.capacity===6&&row.ping===undefined&&row.phase===undefined));
 assert.deepEqual(lobbyBrowserRows([oregon],[]),[oregon]);assert.deepEqual(lobbyBrowserRows([],['or']),[]);
});
test('listing preserves every real lobby and adds capacity only where advertised games have no seats',()=>{
 const games:LobbyBrowserRow[]=[
  {id:'lon-full',name:'Alpha',location:'lon',players:6,capacity:6,phase:'playing'},
  {id:'lon-open',name:'Beta',location:'lon',players:2,capacity:6,phase:'playing'},
  {id:'sg-full',name:'Gamma',location:'sg',players:6,capacity:6,phase:'playing'},
  {id:'sp-starting',name:'Delta',location:'sp',players:0,capacity:6,phase:'starting'},
 ];
 assert.deepEqual(lobbyBrowserRows(games,['lon','sg','sp']).map(row=>row.id),['lon-full','lon-open','sg-full','new:sg','sp-starting']);
 assert.deepEqual(lobbyBrowserRows(games,['lon','sp']).map(row=>row.id),games.map(row=>row.id));
 assert.equal(games.length,4);
});
test('refresh keeps the selected city when idle and live entries replace one another',()=>{
 const idle=lobbyBrowserRows([],['lon','sg','sp']);const selected=idle.find(row=>row.location==='sg')!;
 const game:LobbyBrowserRow={id:'sg-live',name:'Moltke Delta',location:'sg',players:1,capacity:6,phase:'playing'};
 const live=lobbyBrowserRows([game],['lon','sg','sp']);
 assert.equal(selectedBrowserLobby(live,selected),'sg-live');assert.equal(selectedBrowserLobby(idle,game),'new:sg');
 assert.equal(selectedBrowserLobby(live,game),'sg-live');assert.equal(selectedBrowserLobby([],game),'');
 assert.equal(selectedBrowserLobby(lobbyBrowserRows([],['lon']),game),'new:lon');
});
test('ended servers disappear without placeholder rows; locations stay available',async()=>{
 let running=true;
 const client=new NetworkClient(new Game(),{extraLobbiesEnabled:true,origin:'https://api.example.com',fetch:async()=>new Response(JSON.stringify({version:2,locations:['lon','sg','sp','unknown','lon'],lobbies:running?[{id:'real',name:'Alpha',players:0,capacity:6,phase:'playing',managed:true,location:'lon'}]:[]}))});
 assert.deepEqual((await client.lobbies()).map(row=>row.id),['real']);running=false;assert.deepEqual(await client.lobbies(),[]);assert.deepEqual(client.locations,['lon','sg','sp']);
 await assert.rejects(client.join('new:unknown','Alice','british'),/location is unavailable/);
});
test('unavailable regions stay hidden and cannot silently reroute a location join',async()=>{
 let joinRequests=0;
 const client=new NetworkClient(new Game(),{extraLobbiesEnabled:true,origin:'https://api.example.com',fetch:async url=>{
  if(!String(url).endsWith('/lobbies'))joinRequests++;
  return new Response(JSON.stringify({version:2,locations:['lon'],lobbies:[]}));
 }});
 assert.deepEqual(await client.lobbies(),[]);assert.deepEqual(client.locations,['lon']);
 for(const location of ['or','ny','sg','sp'])await assert.rejects(client.join(`new:${location}`,'Alice','british'),/location is unavailable/);
 assert.equal(joinRequests,0);
});
test('legacy directories cannot route location joins or expose old sleeping placeholders',async()=>{
 const client=new NetworkClient(new Game(),{extraLobbiesEnabled:true,origin:'https://api.example.com',fetch:async()=>new Response(JSON.stringify({lobbies:[{id:'new:or',name:'Oregon',players:0,capacity:6,phase:'sleeping',managed:true}],locations:['or']}))});
 assert.deepEqual(await client.lobbies(),[]);assert.deepEqual(client.locations,[]);await assert.rejects(client.join('new:or','Alice','british'),/location is unavailable/);
});
test('managed sockets receive only the temporary ticket; empty tickets fail closed',async()=>{
 for(const ticket of ['signed-ticket-'.repeat(8),'']){
  const sent:any[]=[];let opened=0;
  const client=new NetworkClient(new Game(),{extraLobbiesEnabled:true,origin:'https://api.example.com',fetch:async(url)=>new Response(JSON.stringify(String(url).endsWith('/lobbies')?{lobbies:[{id:'game',name:'London',capacity:6,players:0,phase:'playing',managed:true}]}:String(url).endsWith('/session')?{token:'permanent-account-token-'.repeat(3)}:{lobbyId:'game',ticket,websocketUrl:'wss://lon.amazongamelift.com:8080/api/ws'})),socket:()=>{
   opened++;const socket:SocketLike={readyState:1,onopen:null,onmessage:null,onerror:null,onclose:null,send(raw){sent.push(JSON.parse(String(raw)));},close(){}};queueMicrotask(()=>socket.onopen?.({}));return socket;
  }});
  await client.lobbies();const joining=client.join('game','Alice','british');
  if(ticket){await new Promise(r=>setImmediate(r));assert.equal(sent[0]?.token,ticket);assert.ok(!JSON.stringify(sent).includes('permanent-account'));client.disconnect();await joining;}
  else {await assert.rejects(joining,/Invalid game reservation/);assert.equal(opened,0);}
 }
});


test('extra lobbies default off, including direct joins, while Oregon remains listed',async()=>{
 const requests:string[]=[];
 const client=new NetworkClient(new Game(),{origin:'https://api.example.com',fetch:async url=>{
  requests.push(String(url));return new Response(JSON.stringify({version:2,locations:['lon','sg','sp'],lobbies:[
   {id:'home',name:'Rommel Alpha',location:'or',players:0,capacity:6,phase:'playing'},
   ...['lon','sg','sp'].map(location=>({id:location,name:location,location,managed:true,players:0,capacity:6,phase:'playing'})),
  ]}));
 }});
 assert.deepEqual((await client.lobbies()).map(row=>row.id),['home']);assert.deepEqual(client.locations,[]);
 for(const location of ['lon','sg','sp'])for(const id of [location,`new:${location}`])await assert.rejects(client.join(id,'Alice','british'),/location is unavailable/);
 assert.equal(requests.length,1,'disabled joins cannot authenticate or request regional capacity');
});
