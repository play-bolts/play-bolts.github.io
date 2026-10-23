/** Six-room HTTP/WebSocket smoke, with spectator joins and acknowledged cleanup.
 * node --import tsx scripts/test-dedicated-lobbies.ts --remote-qa
 * node --import tsx scripts/test-dedicated-lobbies.ts --local-url=http://127.0.0.1:8080
 * Uses three identities, at most two occupied seats, and no combat/chat/feedback.
 */
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {Game} from '../src/engine.ts';
import {NetworkClient} from '../src/network.ts';
import {decodeMessage} from '../src/networkCodec.ts';

const args=process.argv.slice(2),remote=args.length===1&&args[0]==='--remote-qa';
let origin='https://bolts-api.christopherkrapu.com';
if(!remote){
 if(args.length!==1||!args[0].startsWith('--local-url='))throw Error('Use --remote-qa or --local-url=http://127.0.0.1:PORT.');
 const local=new URL(args[0].slice('--local-url='.length));
 if(local.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(local.hostname)||local.username||local.password||local.pathname!=='/'||local.search||local.hash)throw Error('Local QA requires a loopback HTTP origin.');
 origin=local.origin;
}
const browser=remote?'https://play-bolts.github.io':'http://localhost:5173';
const expected=[['Deathmatch 1',6],['Deathmatch 2',6],['Deathmatch 3',6],['1v1 Alpha',2],['1v1 Beta',2],['1v1 Delta',2]];
const lifetime=new AbortController();
const pause=async(ms:number)=>{await new Promise<void>(resolve=>setTimeout(resolve,ms));lifetime.signal.throwIfAborted();};
const checks:string[]=[],failed:string[]=[],sockets:(WebSocket|undefined)[]=[];
const started=Date.now();let passed=false,failure='';
const check=(label:string,fn:()=>void)=>{fn();checks.push(label);console.log(`PASS ${label}`);};
const fetcher:typeof fetch=async(url,init)=>{
 const headers=new Headers(init?.headers);headers.set('Origin',browser);
 const response=await fetch(url,{...init,headers,signal:AbortSignal.any([lifetime.signal,AbortSignal.timeout(8000),...(init?.signal?[init.signal]:[])])});
 assert.equal(response.headers.get('access-control-allow-origin'),browser,'one CORS origin, including session success/error responses');
 return response;
};
const clients=Array.from({length:3},(_,index)=>{
 const storage=new Map<string,string>();
 const client=new NetworkClient(new Game(),{origin,fetch:fetcher,socket:url=>{lifetime.signal.throwIfAborted();return sockets[index]=new WebSocket(url);},storage:{getItem:key=>storage.get(key)??null,setItem:(key,value)=>{storage.set(key,value);},removeItem:key=>{storage.delete(key);}}});
 client.onFailure=message=>failed.push(message);return client;
});
const cleanup=()=>clients.forEach(client=>client.disconnect());
const deadline=setTimeout(()=>{lifetime.abort(new Error('QA deadline exceeded'));cleanup();},60000);
async function leave(index:number){
 const client=clients[index],socket=sockets[index];
 if(!client.connected){client.disconnect();return;}
 try{
  lifetime.signal.throwIfAborted();assert.ok(socket&&socket.readyState===WebSocket.OPEN,'joined socket remains open until leave');
  await new Promise<void>((resolve,reject)=>{
   const finish=(error?:Error)=>{clearTimeout(timer);socket.removeEventListener('message',message);socket.removeEventListener('close',closed);lifetime.signal.removeEventListener('abort',aborted);error?reject(error):resolve();};
   const message=(event:MessageEvent)=>{const value=decodeMessage(event.data);if(value&&typeof value==='object'&&'type' in value&&value.type==='left')finish();};
   const closed=()=>finish(new Error('Socket closed before acknowledging leave.'));
   const aborted=()=>finish(new Error('QA deadline exceeded during leave.'));
   const timer=setTimeout(()=>finish(new Error('Server did not acknowledge leave.')),3000);
   socket.addEventListener('message',message);socket.addEventListener('close',closed);lifetime.signal.addEventListener('abort',aborted,{once:true});
   socket.send(JSON.stringify({type:'leave'}));
  });
 }finally{client.disconnect();}
}
try{
 const preflight=await fetcher(origin+'/api/session',{method:'OPTIONS',headers:{'Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'content-type'}});
 check('browser session preflight',()=>{assert.ok(remote?preflight.status===204:[200,204].includes(preflight.status),`successful preflight status (${preflight.status})`);assert.match(preflight.headers.get('access-control-allow-methods')??'',/POST/i);assert.match(preflight.headers.get('access-control-allow-headers')??'',/content-type/i);});
 const invalid=await fetcher(origin+'/api/session',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"token":"diagnostic-invalid-token"}'});
 check('expired credentials return a readable 401',()=>assert.equal(invalid.status,401));
 const rows=await clients[0].lobbies();
 check('three six-seat Deathmatches and three two-seat duels',()=>{
  assert.deepEqual(rows.map(row=>[row.name,row.capacity]),expected);
  assert.equal(new Set(rows.map(row=>row.id)).size,6);
  assert.ok(rows.every(row=>row.id&&!row.managed&&(row.location==='or'||!remote&&row.location===undefined)));
  assert.deepEqual(clients[0].locations,[]);
 });
 for(const room of rows){
  const current=await clients[0].lobbies(),listed=current.find(row=>row.id===room.id);
  assert.ok(listed,`${room.name} remains listed`);
  if(room.capacity===2)assert.equal(listed.players,0,'duel smoke checks require empty rooms');
  else assert.ok(listed.players<room.capacity,`${room.name} needs an available spectator seat`);
  await clients[0].join(room.id,'QA Lobbies A','british',true);
  check(`${room.name}: spectator joined with live snapshots`,()=>{assert.ok(clients[0].connected);assert.equal(clients[0].lobbyId,room.id);assert.equal(clients[0].lobbyName,room.name);assert.ok(clients[0].game.player.spectator);assert.ok(clients[0].game.history.length);});
  const start=clients[0].game.history.at(-1)!.time;
  await pause(250);
  check(`${room.name}: simulation advances`,()=>assert.ok(clients[0].game.history.at(-1)!.time>start));
  if(room.capacity===2){
   await clients[1].lobbies();await clients[1].join(room.id,'QA Lobbies B','german',true);
   await pause(150);
   check(`${room.name}: two spectators and no bots`,()=>{assert.equal(clients[0].game.actors.length,2);assert.equal(clients[1].game.actors.length,2);assert.ok(clients[0].game.actors.every(actor=>actor.name.startsWith('QA Lobbies ')&&actor.spectator));});
   await clients[2].lobbies();
   await assert.rejects(clients[2].join(room.id,'QA Lobbies C','russian',true),/full/i);
   check(`${room.name}: third seat rejected without disrupting joined clients`,()=>assert.ok(clients[0].connected&&clients[1].connected));
  }
  const leaves=await Promise.allSettled(clients.map((_,index)=>leave(index)));
  check(`${room.name}: server acknowledged every occupied seat leaving`,()=>{for(const result of leaves)if(result.status==='rejected')throw result.reason;assert.ok(clients.every(client=>!client.online));});
 }
 const after=await clients[0].lobbies();
 check('all six permanent lobby identities remain after QA cleanup',()=>{
  for(const room of rows){const listed=after.find(row=>row.id===room.id);assert.ok(listed);assert.equal(listed.name,room.name);assert.equal(listed.capacity,room.capacity);}
  assert.ok(clients.every(client=>!client.online));assert.deepEqual(failed,[]);
 });
 passed=true;
}catch(error){failure=error instanceof Error?error.message:String(error);process.exitCode=1;console.error(error);}
finally{
 clearTimeout(deadline);cleanup();
 const folder=new URL('../temp/dedicated-lobbies/',import.meta.url);await mkdir(folder,{recursive:true});
 await writeFile(new URL(remote?'production-smoke.json':'local-smoke.json',folder),JSON.stringify({passed,origin,startedAt:new Date(started).toISOString(),durationMs:Date.now()-started,checks,...(failure?{error:failure}:{})},null,2)+'\n');
}
