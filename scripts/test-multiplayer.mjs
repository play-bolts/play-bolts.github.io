/** Real HTTP/WebSocket integration against the Rust server. Node 22.13+.
 * BOLTS_TEST_URL=https://host runs the same client checks against a deployment.
 * With no URL, build server/target/debug/bolts-server first; an isolated DB and
 * short idle/reconnection timeouts are used. No simulation or teleport hooks.
 */
import assert from 'node:assert/strict';
import {decodeMessage,decodeSnapshot,encodeInput,PROTOCOL_VERSION} from '../src/networkCodec.ts';
import {TestInputStream} from './test-input-stream.mjs';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createServer} from 'node:net';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {ARENA,blocked,visible} from '../src/config.ts';

const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const external=!!process.env.BOLTS_TEST_URL;
const clients=[];
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let backend,temporary,dbPath,base=(process.env.BOLTS_TEST_URL??'').replace(/\/$/,'');
let serverOutput='';let assertions=0;
function check(label,fn){fn();assertions++;console.log(`PASS ${label}`);}
async function eventually(fn,timeout=5000,label='condition',interval=60){
 const end=Date.now()+timeout;let last;
 do{try{const result=await fn();if(result)return result;}catch(error){last=error;}await delay(interval);}while(Date.now()<end);
 throw new Error(`Timed out: ${label}${last?` (${last.message})`:''}`);
}
async function json(path,body){const response=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:body===undefined?{}:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(8000)});const value=await response.json();if(!response.ok)throw new Error(`${path}: HTTP ${response.status}`);return value;}
async function lobbies(){return (await json('/api/lobbies')).lobbies;}
async function unusedPort(){const server=createServer();await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;}

class Client {
 constructor(session,label){this.session=session;this.label=label;this.messages=[];this.waiters=[];this.seq=0;this.joined=false;this.controls=new TestInputStream(message=>this.send(message),()=>this.self);}
 async connect(){
  // The isolated server models distinct viewer IPs through its trusted proxy setting.
  const socketOptions=external?[]:{headers:{'x-forwarded-for':`192.0.2.${Number(this.label.replace(/\D/g,''))}`}};
  this.socket=new WebSocket(base.replace(/^http/,'ws')+'/api/ws',socketOptions);this.socket.binaryType='arraybuffer';
  this.socket.addEventListener('message',event=>{const raw=decodeMessage(event.data),message=raw.type==='snapshot'?decodeSnapshot(raw):raw;if(!message)return;this.messages.push(message);if(message.type==='snapshot')this.snapshot=message;if(message.type==='joined'){this.snapshot=message.snapshot;this.actorId=message.actorId;this.lobbyId=message.lobbyId;this.joined=true;}if(message.type==='snapshot'||message.type==='joined')this.controls.observe(this.snapshot);for(const waiter of [...this.waiters])if(waiter.predicate(message)){clearTimeout(waiter.timer);this.waiters.splice(this.waiters.indexOf(waiter),1);waiter.resolve(message);}});
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error(`${this.label}: socket open timed out`)),8000);this.socket.addEventListener('open',()=>{clearTimeout(timer);resolve();},{once:true});this.socket.addEventListener('error',()=>{clearTimeout(timer);reject(new Error(`${this.label}: socket connection failed`));},{once:true});});
  const welcome=this.wait(message=>message.type==='welcome');this.send({type:'hello',version:PROTOCOL_VERSION,token:this.session.token});const message=await welcome;assert.equal(message.playerId,this.session.playerId);this.heartbeat=setInterval(()=>{if(this.socket.readyState===WebSocket.OPEN)this.send({type:'ping',nonce:Date.now()});},5000);this.socket.addEventListener('close',()=>{clearInterval(this.heartbeat);this.controls.close();},{once:true});return this;
 }
 wait(predicate,timeout=5000){return new Promise((resolve,reject)=>{const waiter={predicate,resolve,timer:setTimeout(()=>{this.waiters.splice(this.waiters.indexOf(waiter),1);reject(new Error(`${this.label}: expected message timed out`));},timeout)};this.waiters.push(waiter);});}
 send(message){assert.equal(this.socket.readyState,WebSocket.OPEN,`${this.label}: socket not open`);this.socket.send(message.type==='input'?encodeInput(message):JSON.stringify(message));}
 async join(lobbyId){const result=this.wait(message=>message.type==='joined'||message.type==='error');this.send({type:'join',...(lobbyId?{lobbyId}:{}),name:`^${(Number(this.label.replace(/\D/g,''))%6)+1}${this.label}`,faction:'british'});return result;}
 input(overrides={}){return this.controls.input(overrides);}
 get self(){return this.snapshot?.actors.find(actor=>actor.id===this.actorId);}
 async leave(){if(!this.joined||this.socket.readyState!==WebSocket.OPEN)return;const left=this.wait(message=>message.type==='left');this.send({type:'leave'});await left;this.joined=false;this.controls.close();}
 close(){this.controls.close();clearInterval(this.heartbeat);if(this.socket?.readyState===WebSocket.OPEN||this.socket?.readyState===WebSocket.CONNECTING)this.socket.close();}
}

// A grid search produces only ordinary forward/yaw input. The server remains
// responsible for movement, world/player collision, aim, damage and ammunition.
function routeToShot(shooter,target,actors){
 const step=.5,minX=-ARENA.width/2+.5,minZ=-ARENA.depth/2+.5,nx=Math.floor((ARENA.width-1)/step)+1,nz=Math.floor((ARENA.depth-1)/step)+1;
 const point=index=>({x:minX+(index%nx)*step,z:minZ+Math.floor(index/nx)*step});
 const index=(x,z)=>Math.round((z-minZ)/step)*nx+Math.round((x-minX)/step);
 const occupied=(x,z)=>blocked(x,z,0,.42)||actors.some(actor=>actor.id!==shooter.id&&actor.alive&&Math.hypot(x-actor.x,z-actor.z)<.82);
 const goal=p=>{const distance=Math.hypot(p.x-target.x,p.z-target.z);return distance>=2.5&&distance<=7&&visible({x:p.x,y:shooter.eyeHeight,z:p.z},{x:target.x,y:target.y+target.eyeHeight,z:target.z})&&actors.every(actor=>{if(actor.id===shooter.id||actor.id===target.id||!actor.alive)return true;const dx=target.x-p.x,dz=target.z-p.z,t=Math.max(0,Math.min(1,((actor.x-p.x)*dx+(actor.z-p.z)*dz)/(dx*dx+dz*dz)));return Math.hypot(actor.x-(p.x+t*dx),actor.z-(p.z+t*dz))>.7;});};
 if(goal(shooter))return [];
 const start=index(shooter.x,shooter.z),queue=[start],previous=new Map([[start,null]]);let found;
 for(let cursor=0;cursor<queue.length;cursor++){
  const current=queue[cursor],p=point(current);if(goal(p)){found=current;break;}
  for(const [dx,dz] of [[1,0],[-1,0],[0,1],[0,-1],[1,1],[-1,1],[1,-1],[-1,-1]]){
   const gx=current%nx+dx,gz=Math.floor(current/nx)+dz;if(gx<0||gx>=nx||gz<0||gz>=nz)continue;const next=gz*nx+gx;if(previous.has(next))continue;const q=point(next);if(occupied(q.x,q.z)||(dx&&dz&&(occupied(p.x,q.z)||occupied(q.x,p.z))))continue;previous.set(next,current);queue.push(next);
  }
 }
 assert.notEqual(found,undefined,'a walkable firing position exists');const path=[];for(let at=found;at!==start;at=previous.get(at))path.push(point(at));return path.reverse();
}
async function legitKill(shooter,victim){
 await eventually(()=>shooter.self&&victim.self,5000,'actors');
 const deadline=Date.now()+25000;let path=routeToShot(shooter.self,victim.self,shooter.snapshot.actors),lastProgress=Date.now(),best=Infinity;
 while(path.length){
  assert.ok(Date.now()<deadline,'navigation reaches a firing position within 25s');const a=shooter.self,p=path[0],distance=Math.hypot(p.x-a.x,p.z-a.z);
  if(distance<.28){path.shift();best=Infinity;lastProgress=Date.now();continue;}
  if(distance<best-.02){best=distance;lastProgress=Date.now();}
  if(Date.now()-lastProgress>1500){path=routeToShot(a,victim.self,shooter.snapshot.actors);best=Infinity;lastProgress=Date.now();continue;}
  shooter.input({forward:Math.min(1,distance/.24),yaw:Math.atan2(p.x-a.x,p.z-a.z),stance:'stand'});await delay(50);
 }
 shooter.input({stance:'stand'});await delay(350);const deaths=victim.self.deaths;
 for(let attempt=0;attempt<5&&victim.self.deaths===deaths;attempt++){
  const a=shooter.self,b=victim.self,yaw=Math.atan2(b.x-a.x,b.z-a.z),pitch=Math.atan2(b.y+b.eyeHeight-(a.y+a.eyeHeight),Math.hypot(b.x-a.x,b.z-a.z));
  shooter.input({yaw,pitch,ads:true});await delay(100);shooter.input({yaw,pitch,ads:true,fire:true,shotTime:shooter.snapshot.time});await delay(80);shooter.input({yaw,pitch,ads:true});await delay(1100);
 }
 check('legitimate movement, ADS shot, authoritative kill and score',()=>{assert.equal(victim.self.deaths,deaths+1);assert.ok(shooter.self.kills>=1);const event=shooter.messages.flatMap(message=>message.events??[]).find(event=>event.type==='kill'&&event.actor===shooter.actorId&&event.victim===victim.actorId);assert.ok(event);assert.equal(event.headshot,true);});
 shooter.input();
}

try {
 if(!external){
  temporary=await mkdtemp(join(tmpdir(),'bolts-network-'));dbPath=join(temporary,'events.sqlite');const port=await unusedPort();base=`http://127.0.0.1:${port}`;
  backend=spawn(resolve(root,'server/target/debug/bolts-server'),[],{cwd:root,env:{...process.env,BOLTS_BIND:`127.0.0.1:${port}`,BOLTS_DB:dbPath,BOLTS_EMPTY_SECONDS:'2',BOLTS_RECONNECT_SECONDS:'1',BOLTS_ORIGINS:'http://127.0.0.1:5173',BOLTS_TRUST_PROXY:'true',BOLTS_ADMIN_API_KEY:''},stdio:['ignore','pipe','pipe']});
  backend.stdout.on('data',chunk=>{serverOutput=(serverOutput+chunk).slice(-12000);});backend.stderr.on('data',chunk=>{serverOutput=(serverOutput+chunk).slice(-12000);});backend.on('error',error=>{serverOutput+=error.message;});
 }
 await eventually(async()=>(await json('/api/health')).ok,15000,'server health');
 const invalid=await fetch(base+'/api/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:'0'.repeat(64)})});check('unknown session credential rejected',()=>assert.equal(invalid.status,401));
 const sessions=[];for(let i=0;i<7;i++)sessions.push(await json('/api/session',{}));
 check('seven independent persistent UUIDs and secret credentials',()=>{assert.equal(new Set(sessions.map(s=>s.playerId)).size,7);assert.equal(new Set(sessions.map(s=>s.token)).size,7);for(const session of sessions){assert.match(session.playerId,/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i);assert.ok(session.token.length>=32);assert.notEqual(session.token,session.playerId);}});
 const recovered=await json('/api/session',{token:sessions[0].token});check('session credential restores same UUID',()=>assert.equal(recovered.playerId,sessions[0].playerId));
 const firstList=await lobbies(),empty=firstList.find(lobby=>lobby.players===0&&lobby.capacity===6);assert.ok(empty,'an empty six-player lobby is available for isolated integration checks');
 const again=await lobbies();check('refresh does not create redundant empty lobbies',()=>assert.deepEqual(again.map(l=>l.id).sort(),firstList.map(l=>l.id).sort()));
 for(let i=0;i<7;i++){const client=await new Client(sessions[i],`Net tester ${i+1}`).connect();clients.push(client);}
 for(let i=0;i<6;i++){const result=await clients[i].join(empty.id);assert.equal(result.type,'joined',`player ${i+1} joins first room`);assert.equal(result.lobbyId,empty.id);}
 await eventually(()=>clients[0].snapshot?.actors.length===6,5000,'six-player snapshot');
 const full=await clients[6].join(empty.id);check('explicit join rejects seventh player',()=>{assert.equal(full.type,'error');assert.equal(full.code,'lobby_full');});
 const overflow=await clients[6].join();check('quick join creates a six-slot overflow Deathmatch',()=>{assert.equal(overflow.type,'joined');assert.notEqual(overflow.lobbyId,empty.id);assert.equal(overflow.lobbyName,'Deathmatch 2');});
 const populated=await lobbies();check('all lobbies enforce their advertised capacity',()=>{assert.ok(populated.every(lobby=>[2,6].includes(lobby.capacity)&&lobby.players<=lobby.capacity));assert.equal(populated.find(l=>l.id===empty.id)?.players,6);assert.equal(populated.find(l=>l.id===overflow.lobbyId)?.players,1);});
 check('snapshots reveal no persistent UUIDs or session credentials',()=>{for(const client of clients){const wire=JSON.stringify(client.snapshot);for(const session of sessions){assert.ok(!wire.includes(session.playerId));assert.ok(!wire.includes(session.token));}}});

 const literal='<img src=x onerror=alert(1)> ^1literal chat',roomAMarks=clients.map(client=>client.messages.length);
 const chats=clients.slice(0,6).map(client=>client.wait(message=>message.type==='chat'&&message.text===literal));clients[0].send({type:'chat',text:literal});const chatMessages=await Promise.all(chats);await delay(250);
 check('chat broadcasts within the room and preserves markup as plain text',()=>{assert.equal(new Set(chatMessages.map(m=>m.id)).size,1);assert.ok(chatMessages.every(message=>message.text===literal&&message.actorId===clients[0].actorId));assert.ok(!clients[6].messages.slice(roomAMarks[6]).some(message=>message.type==='chat'&&message.text===literal));});
 const otherText='Other room only',secondChat=clients[6].wait(message=>message.type==='chat'&&message.text===otherText);clients[6].send({type:'chat',text:otherText});await secondChat;await delay(250);check('chat isolation works in both directions',()=>assert.ok(clients.slice(0,6).every(client=>!client.messages.some(message=>message.type==='chat'&&message.text===otherText))));

 const authority=clients[0],initialAmmo=authority.self.ammo,duplicate=authority.input({fire:true,ads:true});for(let i=0;i<8;i++)authority.send(duplicate);
 await eventually(()=>authority.self.ack>=duplicate.seq,5000,'first input acknowledgement');await delay(1250);authority.send(duplicate);await delay(250);
 check('replayed input sequence cannot fire twice',()=>assert.equal(authority.self.ammo,initialAmmo-1));
 const before={...authority.self};authority.socket.send(JSON.stringify({...duplicate,seq:-1,forward:-100000,x:1e9,y:1e9,z:1e9,hp:100000}));await delay(100);authority.input({forward:100000,right:-100000,lean:100000,fire:false});await delay(320);authority.input();await delay(300);
 check('malformed input cannot teleport, modify health, or bypass speed bounds',()=>{const actor=authority.self;for(const key of ['x','y','z','yaw','pitch','hp'])assert.ok(Number.isFinite(actor[key]),key);assert.ok(Math.hypot(actor.x-before.x,actor.z-before.z)<=2.2);assert.ok(Math.abs(actor.x)<=ARENA.width/2&&Math.abs(actor.z)<=ARENA.depth/2);assert.equal(actor.hp,before.hp);});
 authority.input({forward:1});await delay(400);const stopped={...authority.self};await delay(350);check('stale input expires and motion stops',()=>assert.ok(Math.hypot(authority.self.x-stopped.x,authority.self.z-stopped.z)<.06));

 await legitKill(clients[0],clients[1]);
 const old=clients[3],oldActor=old.actorId;old.close();await delay(120);const reconnected=await new Client(sessions[3],'Net tester 4').connect();clients[3]=reconnected;const resumed=await reconnected.join();check('reconnect retains UUID, lobby and actor during grace',()=>{assert.equal(resumed.type,'joined');assert.equal(resumed.lobbyId,empty.id);assert.equal(resumed.actorId,oldActor);});
 await clients[4].leave();await clients[6].leave();const replacement=await clients[6].join(empty.id);check('explicit leave immediately releases a seat',()=>{assert.equal(replacement.type,'joined');assert.equal(replacement.lobbyId,empty.id);});
 const disconnected=clients[5];disconnected.close();await eventually(async()=>((await lobbies()).find(l=>l.id===empty.id)?.players??0)===5,external?36000:5000,'disconnected seat released',external?650:150);disconnected.joined=false;
 const rejoin=await clients[4].join(empty.id);check('disconnect timeout frees a seat',()=>assert.equal(rejoin.type,'joined'));
 await Promise.all(clients.map(client=>client.leave()));for(const client of clients)client.close();
 if(!external){await delay(2200);const idle=await lobbies();check('overflow expires while the four base lobbies persist',()=>{assert.deepEqual(idle.map(l=>l.id).sort(),firstList.map(l=>l.id).sort());assert.ok(idle.every(l=>l.players===0));});}

 if(!external){
  await delay(150);const db=new DatabaseSync(dbPath,{readOnly:true});
  try{
   check('database integrity and foreign keys',()=>{assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');assert.equal(db.prepare('PRAGMA foreign_key_check').all().length,0);});
   check('all human test identities persisted with hashed credentials',()=>{const rows=db.prepare('SELECT id,credential_hash FROM players WHERE is_bot=0').all();assert.equal(rows.length,7);for(const session of sessions){const row=rows.find(row=>row.id===session.playerId);assert.ok(row);assert.notEqual(row.credential_hash,session.token);assert.match(row.credential_hash,/^[a-f0-9]{64}$/);}});
   check('chat records link to typed events and preserve the literal body',()=>{const rows=db.prepare("SELECT c.body,e.event_type,c.player_id,e.actor_player_id FROM chat_messages c JOIN events e ON e.id=c.id").all();assert.equal(rows.length,2);assert.ok(rows.some(row=>row.body===literal));assert.ok(rows.every(row=>row.event_type==='chat'&&row.player_id===row.actor_player_id));});
   check('each membership has exactly one enter and leave event',()=>{const rows=db.prepare("SELECT m.id,m.left_at,(SELECT count(*) FROM events e WHERE e.event_type='player_enter' AND json_extract(e.data,'$.membershipId')=m.id) AS enters,(SELECT count(*) FROM events e WHERE e.event_type='player_leave' AND json_extract(e.data,'$.membershipId')=m.id) AS leaves FROM memberships m").all();assert.ok(rows.length>=9);assert.ok(rows.every(row=>row.left_at!==null&&row.enters===1&&row.leaves===1));});
   check('kill and death events form one durable linked combat record',()=>{const rows=db.prepare("SELECT c.*,k.event_type AS kill_type,d.event_type AS death_type,k.actor_player_id AS killer,d.actor_player_id AS victim FROM combat_events c JOIN events k ON k.id=c.kill_event_id JOIN events d ON d.id=c.death_event_id").all();assert.ok(rows.some(row=>row.killer===sessions[0].playerId&&row.victim===sessions[1].playerId&&row.kill_type==='player_kill'&&row.death_type==='player_death'&&row.headshot===1));});
   check('reconnection and dedicated room identities are durable',()=>{assert.ok(db.prepare("SELECT count(*) AS n FROM events WHERE event_type='player_reconnect'").get().n>=1);assert.equal(db.prepare('SELECT count(*) AS n FROM lobbies WHERE closed_at IS NULL').get().n,4);});
  }finally{db.close();}
 }
 console.log(`Multiplayer integration: ${assertions} checks passed (${external?'deployed server':'isolated local server'}).`);
}catch(error){console.error(error.stack??String(error));if(serverOutput)console.error('Server diagnostics:\n'+serverOutput);process.exitCode=1;}
finally{
 for(const client of clients)client.close();
 if(backend){backend.kill('SIGINT');await Promise.race([new Promise(resolve=>backend.once('exit',resolve)),delay(2000)]);if(backend.exitCode===null)backend.kill('SIGKILL');}
 if(temporary)await rm(temporary,{recursive:true,force:true});
}
