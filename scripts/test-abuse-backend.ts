/** Bounded, opt-in production tests of per-IP sockets, seats and directory limits.
 * node --import tsx scripts/test-abuse-backend.ts --remote-qa
 * Requires empty lobbies, uses spectators, never sends combat/chat/feedback.
 * At most 13 simultaneous sockets, five QA identities, 125 directory requests.
 */
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {request} from 'node:https';
import type {Socket} from 'node:net';
import {mkdir,writeFile} from 'node:fs/promises';
import {Game} from '../src/engine.ts';
import {NetworkClient} from '../src/network.ts';

if(process.argv.slice(2).join(' ')!=='--remote-qa')throw Error('Use --remote-qa to test production explicitly.');
const origin='https://bolts-api.christopherkrapu.com',browser='https://play-bolts.github.io';
const lifetime=new AbortController();
const pause=async(ms:number)=>{await new Promise<void>(resolve=>setTimeout(resolve,ms));lifetime.signal.throwIfAborted();};
const checks:Record<string,unknown>[]=[];
const rawSockets=new Set<Socket>(),clients:NetworkClient[]=[];
const started=Date.now();let passed=false,failure='';
const check=(label:string,details:Record<string,unknown>={})=>{checks.push({label,...details});console.log(`PASS ${label}`);};
const cleanup=()=>{clients.forEach(client=>client.disconnect());for(const socket of rawSockets)socket.destroy();rawSockets.clear();};
const deadline=setTimeout(()=>{lifetime.abort(new Error('QA deadline exceeded'));cleanup();},150000);
const fetcher:typeof fetch=async(url,init)=>{
 const headers=new Headers(init?.headers);headers.set('Origin',browser);
 return fetch(url,{...init,headers,signal:AbortSignal.any([lifetime.signal,AbortSignal.timeout(8000),...(init?.signal?[init.signal]:[])])});
};
async function handshake(){
 return new Promise<{status:number;socket?:Socket;retryAfter?:string}>((resolve,reject)=>{
  const req=request(origin+'/api/ws',{signal:lifetime.signal,headers:{Origin:browser,Connection:'Upgrade',Upgrade:'websocket','Sec-WebSocket-Version':'13','Sec-WebSocket-Key':randomBytes(16).toString('base64')},timeout:5000});
  req.on('timeout',()=>req.destroy(new Error('Handshake timed out.')));req.on('error',reject);
  req.on('upgrade',(response,socket)=>{rawSockets.add(socket);socket.on('error',()=>{});socket.on('close',()=>rawSockets.delete(socket));resolve({status:response.statusCode!,socket});});
  req.on('response',response=>{response.resume();resolve({status:response.statusCode!,retryAfter:response.headers['retry-after'] as string|undefined});});
  req.end();
 });
}
try{
 const listing=await fetcher(origin+'/api/lobbies');assert.equal(listing.status,200);
 const catalog=await listing.json();assert.deepEqual(catalog.locations,[]);
 assert.equal(catalog.lobbies.length,4);assert.ok(catalog.lobbies.every((room:any)=>room.players===0),'Production tests require every human seat to be empty.');
 check('normal directory and disabled overseas regions');
 // Open together so all remain within the five-second unauthenticated timeout.
 const pending=await Promise.allSettled(Array.from({length:12},()=>handshake()));
 const sockets=pending.map(result=>{if(result.status==='rejected')throw result.reason;return result.value;});
 assert.ok(sockets.every(result=>result.status===101&&result.socket&&!result.socket.destroyed));
 const excess=await handshake();assert.equal(excess.status,429);
 check('13th simultaneous socket from this IP rejected',{accepted:12,status:excess.status});
 cleanup();await pause(350);
 const replacement=await handshake();assert.equal(replacement.status,101);cleanup();
 check('socket capacity released after disconnect');
 for(let index=0;index<5;index++){
  const storage=new Map<string,string>();
  const client=new NetworkClient(new Game(),{origin,fetch:fetcher,storage:{getItem:key=>storage.get(key)??null,setItem:(key,value)=>{storage.set(key,value);},removeItem:key=>{storage.delete(key);}}});
  clients.push(client);
 }
 const roomIds=catalog.lobbies.map((room:any)=>room.id);
 for(let i=0;i<4;i++){
  await clients[i].lobbies();await clients[i].join(roomIds[i],`QA Protection ${i+1}`,'british',true);
  assert.ok(clients[i].connected&&clients[i].game.player.spectator);
 }
 check('four legitimate spectator identities join across different lobbies');
 await clients[4].lobbies();
 await assert.rejects(clients[4].join(roomIds[0],'QA Protection 5','british',true),/network|address|limit|many|seat/i);
 assert.ok(clients.slice(0,4).every(client=>client.connected));
 check('fifth seat from the same IP rejected without disconnecting existing players');
 clients[0].disconnect();await pause(350);
 await clients[4].join(roomIds[0],'QA Protection 5','british',true);assert.ok(clients[4].connected);
 check('explicit leave immediately releases the IP seat quota');
 cleanup();await pause(600);
 const cleaned=await fetcher(origin+'/api/status');assert.equal(cleaned.status,200);assert.equal((await cleaned.json()).online,0);
 check('all QA spectator seats released');
 let throttled=false,requests=0,retryAfter='';
 for(;requests<125;requests++){
  const response=await fetcher(origin+'/api/lobbies');
  if(response.status===429){assert.notEqual(response.headers.get('x-bolts-rate-limit'),'edge');throttled=true;retryAfter=response.headers.get('retry-after')??'';await response.arrayBuffer();requests++;break;}
  assert.equal(response.status,200);await response.arrayBuffer();await pause(100);
 }
 assert.ok(throttled,'Expected the directory rate limit before 125 requests.');assert.ok(Number(retryAfter)>0);
 check('directory excess rejected with retry guidance',{requests,status:429,retryAfter});
 const health=await fetcher(origin+'/api/health');assert.equal(health.status,200);
 assert.equal(health.headers.get('access-control-allow-origin'),browser);
 const status=await fetcher(origin+'/api/status');assert.equal(status.status,200);
 check('directory throttling does not exhaust independent health/status limits');
 passed=true;
}catch(error){failure=error instanceof Error?error.message:String(error);process.exitCode=1;console.error(failure);}
finally{
 clearTimeout(deadline);cleanup();
 const folder=new URL('../temp/abuse-protection/',import.meta.url);await mkdir(folder,{recursive:true});
 await writeFile(new URL('backend-live-tests.json',folder),JSON.stringify({passed,startedAt:new Date(started).toISOString(),durationMs:Date.now()-started,checks,...(failure?{error:failure}:{})},null,2)+'\n');
}
