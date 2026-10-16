/** Two real WebSocket clients against an isolated, local Rust server/database.
 * Build server/target/debug/bolts-server, then run:
 * node scripts/test-reload-melee.mjs
 * Deliberately has no remote-endpoint option: this regression creates no
 * production identities, membership events, or matches.
 */
import assert from 'node:assert/strict';
import {decodeMessage,decodeSnapshot,encodeInput,PROTOCOL_VERSION} from '../src/networkCodec.ts';
import {TestInputStream} from './test-input-stream.mjs';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const clients=[];
let backend,temporary,base,diagnostics='',checks=0;
async function eventually(predicate,label,timeout=6000){
 const deadline=Date.now()+timeout;
 while(Date.now()<deadline){if(await predicate())return;await delay(25);}
 throw new Error(`Timed out: ${label}`);
}
function check(label,body){body();checks++;console.log(`PASS ${label}`);}
async function unusedPort(){
 const listener=createServer();
 await new Promise((resolve,reject)=>{listener.once('error',reject);listener.listen(0,'127.0.0.1',resolve);});
 const port=listener.address().port;await new Promise(resolve=>listener.close(resolve));return port;
}
async function json(path,body){
 const response=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(2000)});
 assert.equal(response.ok,true,`${path}: HTTP ${response.status}`);return response.json();
}
class Client {
 constructor(name){this.name=name;this.messages=[];this.seq=0;this.controls=new TestInputStream(message=>this.send(message),()=>this.actor());}
 send(message){this.socket.send(message.type==='input'?encodeInput(message):JSON.stringify(message));}
 async connect(){
  const session=await json('/api/session',{});
  this.socket=new WebSocket(base.replace(/^http/,'ws')+'/api/ws');this.socket.binaryType='arraybuffer';
  this.socket.addEventListener('message',({data})=>{
   const message=decodeMessage(data);this.messages.push(message);
   if(message.type==='joined'){this.actorId=message.actorId;this.lobbyId=message.lobbyId;this.snapshot=message.snapshot;}
   if(message.type==='snapshot')this.snapshot=decodeSnapshot(message);
   if(message.type==='snapshot'||message.type==='joined')this.controls.observe(this.snapshot);
  });
  await new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>reject(new Error('WebSocket open timed out')),5000);
   this.socket.addEventListener('open',()=>{clearTimeout(timer);resolve();},{once:true});
   this.socket.addEventListener('error',()=>{clearTimeout(timer);reject(new Error('WebSocket failed'));},{once:true});
  });
  this.send({type:'hello',version:PROTOCOL_VERSION,token:session.token});
  await eventually(()=>this.messages.some(message=>message.type==='welcome'),'hello');
 }
 async join(lobbyId){
  this.send({type:'join',name:this.name,faction:'british',...(lobbyId?{lobbyId}:{})});
  await eventually(()=>this.actorId!==undefined,'join');
 }
 actor(id=this.actorId){return this.snapshot?.actors.find(actor=>actor.id===id);}
 input(actions={}){
  return this.controls.input({yaw:0,pitch:1.3,stance:'stand',weapon:'rifle',...actions}).seq;
 }
 events(since=0){return this.messages.slice(since).flatMap(message=>message.events??[]);}
 close(){this.controls.close();if(this.socket?.readyState===WebSocket.OPEN)this.socket.close();}
}

try {
 temporary=await mkdtemp(join(tmpdir(),'bolts-reload-melee-'));
 const port=await unusedPort();base=`http://127.0.0.1:${port}`;
 backend=spawn(resolve(root,'server/target/debug/bolts-server'),[],{cwd:root,env:{...process.env,BOLTS_BIND:`127.0.0.1:${port}`,BOLTS_DB:join(temporary,'events.sqlite'),BOLTS_EMPTY_SECONDS:'2',BOLTS_RECONNECT_SECONDS:'1'},stdio:['ignore','pipe','pipe']});
 backend.stdout.on('data',chunk=>{diagnostics=(diagnostics+chunk).slice(-8000);});
 backend.stderr.on('data',chunk=>{diagnostics=(diagnostics+chunk).slice(-8000);});
 backend.on('error',error=>{diagnostics+=error.message;});
 await eventually(async()=>{try{return (await json('/api/health')).ok;}catch{return false;}},'health');
 for(const name of ['Reload striker','Reload observer']){const client=new Client(name);clients.push(client);await client.connect();await client.join(clients[0].lobbyId);}
 const [striker,observer]=clients;
 await eventually(()=>clients.every(client=>client.snapshot?.actors.length===2),'two-player snapshots');
 check('two independent clients share the authoritative lobby',()=>assert.notEqual(striker.actorId,observer.actorId));

 // Ordinary accepted skyward shot creates a partial magazine without a test hook.
 await eventually(()=>striker.actor().cooldown===0,'spawn recovery');
 const shotSeq=striker.input({fire:true,ads:true});
 await eventually(()=>striker.actor()?.ack>=shotSeq&&striker.actor().ammo===9,'initial rifle shot');
 await eventually(()=>striker.actor().cooldown===0,'rifle recovery');
 const initial={ammo:striker.actor().ammo,reserve:striker.actor().reserve};
 const reloadSeq=striker.input({reload:true});
 await eventually(()=>clients.every(client=>client.actor(striker.actorId)?.ack>=reloadSeq&&client.actor(striker.actorId).reload>0),'reload visible to both clients');
 await delay(200);
 const marks=clients.map(client=>client.messages.length),meleeSeq=striker.input({melee:true});
 await eventually(()=>clients.every(client=>{const a=client.actor(striker.actorId);return a?.ack>=meleeSeq&&a.reload===0&&a.reloadTotal===0&&a.cooldown>0;}),'melee cancels reload on both clients');
 check('reload interruption preserves magazine/reserve and broadcasts melee',()=>{
  for(const [index,client] of clients.entries()){
   const a=client.actor(striker.actorId);assert.equal(a.ammo,initial.ammo);assert.equal(a.reserve,initial.reserve);
   const shot=client.events(marks[index]).find(event=>event.type==='shot'&&event.actor===striker.actorId&&event.seq===meleeSeq);
   assert.equal(shot?.shot.kind,'melee');assert.ok(a.lastMeleeTime>0);
  }
 });
 const blockedSeq=striker.input({reload:true});
 await eventually(()=>striker.actor().ack>=blockedSeq,'reload during melee recovery acknowledged');
 check('reload cannot replace the active melee recovery',()=>{
  assert.equal(striker.actor().reload,0);assert.equal(striker.actor().ammo,initial.ammo);assert.equal(striker.actor().reserve,initial.reserve);
 });

 await eventually(()=>striker.actor().cooldown===0,'melee recovery');
 const coalescedMarks=clients.map(client=>client.messages.length),coalescedSeq=striker.input({reload:true,fire:true,melee:true});
 await eventually(()=>clients.every(client=>client.actor(striker.actorId)?.ack>=coalescedSeq),'coalesced action acknowledged');
 check('simultaneous reload/fire/melee sends one strike and no reload cue to either client',()=>{
  for(const [index,client] of clients.entries()){
   const events=client.events(coalescedMarks[index]).filter(event=>event.actor===striker.actorId&&event.seq===coalescedSeq);
   assert.equal(events.filter(event=>event.type==='shot'&&event.shot.kind==='melee').length,1);
   assert.ok(events.every(event=>event.type!=='reload'));
   const a=client.actor(striker.actorId);assert.equal(a.reload,0);assert.equal(a.reloadTotal,0);assert.equal(a.ammo,initial.ammo);assert.equal(a.reserve,initial.reserve);
  }
 });

 await eventually(()=>striker.actor().cooldown===0,'second melee recovery');
 const secondReload=striker.input({reload:true});
 await eventually(()=>striker.actor().ack>=secondReload&&striker.actor().reload>0,'second reload');
 const fireSeq=striker.input({fire:true});
 await eventually(()=>striker.actor().ack>=fireSeq,'normal rifle fire acknowledged');
 check('normal rifle fire does not cancel reload or consume a round',()=>{
  assert.ok(striker.actor().reload>0);assert.equal(striker.actor().ammo,initial.ammo);assert.equal(striker.actor().reserve,initial.reserve);
  assert.ok(striker.events().every(event=>event.type!=='shot'||event.actor!==striker.actorId||event.seq!==fireSeq));
 });
 await eventually(()=>clients.every(client=>client.actor(striker.actorId)?.reload===0&&client.actor(striker.actorId).ammo===10),'reload completes after recovery');
 check('subsequent completed reload transfers exactly one round',()=>{
  for(const client of clients){const a=client.actor(striker.actorId);assert.equal(a.ammo,10);assert.equal(a.reserve,initial.reserve-1);assert.equal(a.ammo+a.reserve,initial.ammo+initial.reserve);}
  assert.ok(clients.every(client=>!client.messages.some(message=>message.type==='error')));
 });
 console.log(`Reload/melee WebSocket integration: ${checks} checks passed (two clients, isolated local server).`);
}catch(error){console.error(error.stack??String(error));if(diagnostics)console.error(diagnostics);process.exitCode=1;}
finally {
 for(const client of clients)client.close();
 if(backend){backend.kill('SIGINT');await Promise.race([new Promise(resolve=>backend.once('exit',resolve)),delay(2000)]);if(backend.exitCode===null)backend.kill('SIGKILL');}
 if(temporary)await rm(temporary,{recursive:true,force:true});
}
