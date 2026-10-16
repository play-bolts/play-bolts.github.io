/** Two real WebSocket clients against an isolated, local Rust server/database.
 * Build server/target/debug/bolts-server, then run:
 * node --import tsx scripts/test-spectator-lean.mjs
 * Deliberately has no remote-endpoint option: this regression creates no
 * production identities, membership events, or matches.
 */
import assert from 'node:assert/strict';
import {decodeMessage,decodeSnapshot,encodeInput,PROTOCOL_VERSION} from '../src/networkCodec.ts';
import {TestInputStream} from './test-input-stream.mjs';
import {DatabaseSync} from 'node:sqlite';
import {ARENA} from '../src/config.ts';
import {constrainLean,leanEye,LEAN_CAMERA_RADIUS} from '../src/lean.ts';
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
 async join(lobbyId,spectator=false){
  this.send({type:'join',name:this.name,faction:'british',spectator,...(lobbyId?{lobbyId}:{})});
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
 temporary=await mkdtemp(join(tmpdir(),'bolts-spectator-lean-'));
 const port=await unusedPort();base=`http://127.0.0.1:${port}`;
 backend=spawn(resolve(root,'server/target/debug/bolts-server'),[],{cwd:root,env:{...process.env,BOLTS_BIND:`127.0.0.1:${port}`,BOLTS_DB:join(temporary,'events.sqlite'),BOLTS_EMPTY_SECONDS:'2',BOLTS_RECONNECT_SECONDS:'1'},stdio:['ignore','pipe','pipe']});
 backend.stdout.on('data',chunk=>{diagnostics=(diagnostics+chunk).slice(-8000);});
 backend.stderr.on('data',chunk=>{diagnostics=(diagnostics+chunk).slice(-8000);});
 backend.on('error',error=>{diagnostics+=error.message;});
 await eventually(async()=>{try{return (await json('/api/health')).ok;}catch{return false;}},'health');
 for(const [name,spectator] of [['Active participant',false],['Spectator participant',true]]){
  const client=new Client(name);clients.push(client);await client.connect();await client.join(clients[0].lobbyId,spectator);
 }
 const [player,observer]=clients;
 await eventually(()=>clients.every(client=>client.snapshot?.actors.length===2),'two-participant snapshots');
 check('spectator joins the same lobby and consumes a participant seat',()=>{
  assert.notEqual(player.actorId,observer.actorId);
  for(const client of clients){assert.equal(client.actor(player.actorId).spectator,false);assert.equal(client.actor(player.actorId).alive,true);assert.equal(client.actor(observer.actorId).spectator,true);assert.equal(client.actor(observer.actorId).alive,false);}
 });
 const initial={...observer.actor()},ignored=observer.input({forward:1,right:1,jump:true,lean:1,fire:true,melee:true,reload:true,ads:true});
 await eventually(()=>clients.every(client=>client.actor(observer.actorId)?.ack>=ignored),'spectator intent acknowledged');
 check('spectator intent cannot move a body, fire, reload, or gain score',()=>{
  const a=observer.actor();for(const key of ['x','y','z','yaw','pitch','ammo','reserve','shots','kills','deaths'])assert.equal(a[key],initial[key],key);
  assert.equal(a.reload,0);assert.equal(a.cooldown,0);assert.equal(a.lean,0);
  assert.ok(clients.every(client=>!client.events().some(e=>e.actor===observer.actorId&&['shot','step','kill','spawn'].includes(e.type))));
 });
 observer.send({type:'chat',text:'Spectator chat'});
 await eventually(()=>clients.every(client=>client.messages.some(message=>message.type==='chat'&&message.text==='Spectator chat')),'spectator chat');
 check('spectators retain room chat',()=>assert.ok(true));

 // Follow normal movement intent from a known valid spawn to the closest wall.
 const a=player.actor();
 const candidates=[{axis:'x',sign:-1,d:a.x+ARENA.width/2,extent:ARENA.width/2},{axis:'x',sign:1,d:ARENA.width/2-a.x,extent:ARENA.width/2},{axis:'z',sign:-1,d:a.z+ARENA.depth/2,extent:ARENA.depth/2},{axis:'z',sign:1,d:ARENA.depth/2-a.z,extent:ARENA.depth/2}].sort((a,b)=>a.d-b.d);
 const wall=candidates[0],moveYaw=wall.axis==='x'?wall.sign*Math.PI/2:(wall.sign<0?Math.PI:0);
 const deadline=Date.now()+6000;
 while(wall.extent-wall.sign*player.actor()[wall.axis]>.315){
  assert.ok(Date.now()<deadline,'ordinary input reaches nearest boundary');player.input({forward:1,yaw:moveYaw,pitch:0});await delay(50);
 }
 const leanYaw=wall.axis==='x'?(wall.sign<0?0:Math.PI):(wall.sign<0?-Math.PI/2:Math.PI/2);
 let stable=[];
 for(let i=0;i<30;i++){player.input({lean:1,yaw:leanYaw,pitch:0});await delay(50);if(i>=15)stable.push(player.actor().lean);}
 const lastSeq=player.seq;
 await eventually(()=>clients.every(client=>client.actor(player.actorId)?.ack>=lastSeq),'lean replicated');
 check('wall lean remains partial and steady, with matching Rust/client camera clearance',()=>{
  assert.ok(stable.every(value=>value>0&&value<.7));assert.ok(Math.max(...stable)-Math.min(...stable)<1e-8);
  for(const client of clients){const actor=client.actor(player.actorId),eye=leanEye(actor);assert.ok(Math.abs(actor.lean-constrainLean(actor,1))<1e-8);assert.ok(Math.abs(eye[wall.axis])<=wall.extent-LEAN_CAMERA_RADIUS);assert.ok(Math.abs(actor.yaw-leanYaw)<1e-8||Math.abs(actor.yaw-leanYaw+2*Math.PI)<1e-8);}
 });
 player.input({yaw:leanYaw,pitch:0});
 await delay(3200);
 check('spectators never enter the ordinary death respawn cycle',()=>{assert.equal(observer.actor().spectator,true);assert.equal(observer.actor().alive,false);assert.equal(observer.actor().deaths,0);});

 observer.send({type:'loadout',faction:'german'});
 await eventually(()=>clients.every(client=>{const a=client.actor(observer.actorId);return a?.alive&&!a.spectator&&a.faction==='german';}),'spectator enters combat');
 check('loadout returns spectator to combat with normal spawn protection and no death',()=>{
  for(const client of clients){const a=client.actor(observer.actorId);assert.equal(a.ammo+a.reserve,150);assert.ok(a.spawnSafe>0);assert.equal(a.deaths,0);assert.equal(a.kills,0);}
 });
 observer.send({type:'spectate'});
 await eventually(()=>clients.every(client=>client.actor(observer.actorId)?.spectator===true),'combat participant enters spectator');
 check('spectate removes combat body without a kill or death notification',()=>{
  for(const client of clients){assert.equal(client.actor(observer.actorId).alive,false);assert.equal(client.actor(observer.actorId).deaths,0);assert.ok(client.events().every(event=>event.type!=='kill'));}
 });
 const db=new DatabaseSync(join(temporary,'events.sqlite'),{readOnly:true});
 try {
  check('mode changes are durable and create no combat records',()=>{
   assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');assert.equal(db.prepare('PRAGMA foreign_key_check').all().length,0);
   assert.equal(db.prepare("SELECT count(*) AS n FROM events WHERE event_type='player_enter' AND json_extract(data,'$.spectator')=1").get().n,1);
   assert.equal(db.prepare("SELECT count(*) AS n FROM events WHERE event_type='loadout_change' AND json_extract(data,'$.spectator')=1").get().n,1);
   assert.equal(db.prepare("SELECT count(*) AS n FROM events WHERE event_type='loadout_change' AND json_extract(data,'$.spectator')=0").get().n,1);
   assert.equal(db.prepare('SELECT count(*) AS n FROM combat_events').get().n,0);
  });
 }finally{db.close();}
 assert.ok(clients.every(client=>!client.messages.some(message=>message.type==='error')));
 console.log(`Spectator/lean WebSocket integration: ${checks} checks passed (two clients, isolated local server).`);
}catch(error){console.error(error.stack??String(error));if(diagnostics)console.error(diagnostics);process.exitCode=1;}
finally {
 for(const client of clients)client.close();
 if(backend){backend.kill('SIGINT');await Promise.race([new Promise(resolve=>backend.once('exit',resolve)),delay(2000)]);if(backend.exitCode===null)backend.kill('SIGKILL');}
 if(temporary)await rm(temporary,{recursive:true,force:true});
}
