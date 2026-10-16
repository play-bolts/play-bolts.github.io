/** Three actual frontend adapters validate lobby fill, observe reciprocal combat,
 * and exercise community APIs through a Rust server.
 * Build the debug backend, then: node --import tsx scripts/test-multiplayer-clients.ts
 * Explicitly authorized production QA: append --remote-qa. This only targets
 * the Bolts backend below, requires an empty room, and disconnects if a real
 * player enters. It creates durable QA events. No teleports or authority edits.
 */
import assert from 'node:assert/strict';
import {decodeSnapshot} from '../src/networkCodec.ts';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {createServer,createConnection,type Socket,type Server} from 'node:net';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {Game,type Input} from '../src/engine.ts';
import {NetworkClient,type WireActor,type WireSnapshot} from '../src/network.ts';
import {ARENA,blocked,visible,type Vec,type Faction} from '../src/config.ts';
import {sampleHitVolumes,rayHitVolumes} from '../src/hitboxes.ts';
import {CommunityClient} from '../src/community.ts';

if(process.env.BOLTS_TEST_URL)throw new Error('Unset BOLTS_TEST_URL; use --remote-qa only for the explicitly authorized Bolts endpoint.');
const remote=process.argv.slice(2).includes('--remote-qa');
if(process.argv.slice(2).some(arg=>arg!=='--remote-qa'))throw new Error('Only --remote-qa is supported; the remote endpoint cannot be overridden.');
const remoteOrigin='https://bolts-api.christopherkrapu.com';
const root=resolve(fileURLToPath(new URL('..',import.meta.url))),started=Date.now(),idle:Input={forward:0,right:0,jump:false,walk:false,lean:0};
const delay=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
const checks:string[]=[],combat:any[]=[],latencyEvidence:{observer:string;alphaMs:number;betaMs:number;observerMs:number}[]=[],users:ReturnType<typeof user>[]=[];
const netcodeEvidence:Record<string,unknown>={};
const authoritativeEffects:{observer:string;actor:string;type:'shot'|'reload';serverTime?:number}[]=[];
const backendPath=resolve(process.env.BOLTS_TEST_SERVER??join(root,'server/target/debug/bolts-server'));
let relayBurst={up:0,down:0};
let base=remote?remoteOrigin:'',temporary='',dbPath='',diagnostics='',isolationError='',qaLobbyId='',backend:ReturnType<typeof spawn>|undefined,timer:ReturnType<typeof setInterval>|undefined,relay:Server|undefined;
let inventoryBefore:unknown,inventoryAfter:unknown;
const relaySockets=new Set<Socket>(),relayTimers=new Set<ReturnType<typeof setTimeout>>();
async function until(predicate:()=>boolean|Promise<boolean>,label:string,timeout=6000){const end=Date.now()+timeout;while(Date.now()<end){if(isolationError)throw new Error(isolationError);if(await predicate())return;await delay(20);}throw new Error(`Timed out: ${label}`);}
async function lobbyInventory(){const response=await fetch(base+'/api/lobbies',{signal:AbortSignal.timeout(8000)});assert.equal(response.ok,true,'lobby inventory is available');return (await response.json()).lobbies as {id:string;name:string;players:number;bots:number;capacity:number;phase:string}[];}
function protectRoom(snapshot:WireSnapshot){if(remote&&snapshot.actors.some(actor=>actor.bot!==true&&!users.some(u=>u.name===actor.name&&(u.actorId<0||u.actorId===actor.id)))){isolationError='A non-QA participant appeared; all QA clients disconnected before continuing.';for(const u of users)u.network.disconnect();}}
function check(label:string,assertions:()=>void){assertions();checks.push(label);console.log(`PASS ${label}`);}
async function unusedPort(){const server=createServer();await new Promise<void>((done,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',done);});const port=(server.address() as {port:number}).port;await new Promise<void>(done=>server.close(()=>done()));return port;}
async function delayRelay(serverPort:number){
 relay=createServer(client=>{
  const upstream=createConnection({host:'127.0.0.1',port:serverPort});
  for(const [source,target]of [[client,upstream],[upstream,client]]){
   let lastDelivery=0;
   const schedule=(fn:()=>void)=>{const now=performance.now(),extra=source===client?relayBurst.up:relayBurst.down;lastDelivery=Math.max(lastDelivery,now+80+extra);const timer=setTimeout(()=>{relayTimers.delete(timer);fn();},Math.max(0,lastDelivery-now));relayTimers.add(timer);};
   relaySockets.add(source);source.on('close',()=>relaySockets.delete(source));source.on('error',()=>target.destroy());
   source.on('data',bytes=>schedule(()=>{if(!target.destroyed)target.write(bytes);}));source.on('end',()=>schedule(()=>target.end()));
  }
 });
 await new Promise<void>((done,reject)=>{relay!.once('error',reject);relay!.listen(0,'127.0.0.1',done);});return (relay.address() as {port:number}).port;
}
function user(name:string,faction:Faction,relayPort?:number){
 const game=new Game(),storage=new Map<string,string>(),messages:any[]=[],chat:string[]=[],failures:string[]=[];
 let actorId=-1,snapshot:WireSnapshot|undefined;
 const network=new NetworkClient(game,{origin:base,storage:{getItem:k=>storage.get(k)??null,setItem:(k,v)=>void storage.set(k,v),removeItem:k=>void storage.delete(k)},socket:url=>{
  const destination=new URL(url);if(relayPort)destination.port=String(relayPort);
  const socket=new WebSocket(destination);socket.addEventListener('message',({data})=>{const message=JSON.parse(String(data));messages.push(message);if(message.type==='joined'){actorId=message.actorId;snapshot=message.snapshot;protectRoom(snapshot!);}if(message.type==='snapshot'){snapshot=decodeSnapshot(message) as WireSnapshot;protectRoom(snapshot!);}});return socket;
 }});
 network.onChat=message=>chat.push(message.message);network.onFailure=message=>failures.push(message);
 return{name,faction,game,network,storage,messages,chat,failures,input:{...idle},get actorId(){return actorId;},get snapshot(){assert.ok(snapshot);return snapshot;},get authority(){assert.ok(snapshot);return snapshot.actors.find(actor=>actor.id===actorId)!;}};
}
type User=ReturnType<typeof user>;
function events(user:User,after=0){return user.messages.slice(after).flatMap(message=>message.events??[]);}
function actorOn(user:User,name:string){const actor=user.game.actors.find(actor=>actor.name===name);assert.ok(actor);return actor;}
function route(shooter:WireActor,target:WireActor,actors:WireActor[]){
 const step=.5,minX=-ARENA.width/2+.5,minZ=-ARENA.depth/2+.5,nx=Math.floor((ARENA.width-1)/step)+1,nz=Math.floor((ARENA.depth-1)/step)+1;
 const point=(index:number)=>({x:minX+(index%nx)*step,z:minZ+Math.floor(index/nx)*step});
 const index=(x:number,z:number)=>Math.round((z-minZ)/step)*nx+Math.round((x-minX)/step);
 const occupied=(x:number,z:number)=>blocked(x,z,0,.42)||actors.some(actor=>actor.id!==shooter.id&&!actor.spectator&&actor.alive&&Math.hypot(x-actor.x,z-actor.z)<.82);
 const goal=(p:{x:number;z:number})=>{const distance=Math.hypot(p.x-target.x,p.z-target.z);return distance>=3.5&&distance<=6&&visible({x:p.x,y:1.65,z:p.z},{x:target.x,y:target.y+target.eyeHeight,z:target.z})&&visible({x:p.x,y:1.65,z:p.z},{x:target.x,y:target.y+.25,z:target.z});};
 if(goal(shooter))return [];
 const start=index(shooter.x,shooter.z),queue=[start],previous=new Map<number,number|null>([[start,null]]);let found:number|undefined;
 for(let cursor=0;cursor<queue.length;cursor++){
  const current=queue[cursor],p=point(current);if(goal(p)){found=current;break;}
  for(const [dx,dz]of [[1,0],[-1,0],[0,1],[0,-1],[1,1],[-1,1],[1,-1],[-1,-1]]){
   const gx=current%nx+dx,gz=Math.floor(current/nx)+dz;if(gx<0||gx>=nx||gz<0||gz>=nz)continue;const next=gz*nx+gx;if(previous.has(next))continue;const q=point(next);
   if(occupied(q.x,q.z)||(dx&&dz&&(occupied(p.x,q.z)||occupied(q.x,p.z))))continue;previous.set(next,current);queue.push(next);
  }
 }
 assert.notEqual(found,undefined,'ordinary movement can reach a clear firing position');const path=[];for(let at=found!;at!==start;at=previous.get(at)!)path.push(point(at));return path.reverse();
}
async function navigate(shooter:User,target:User){
 shooter.network.skipReplay();shooter.network.setADS(false);shooter.input={...idle};
 let path=route(shooter.authority,target.authority,shooter.snapshot.actors),best=Infinity,lastProgress=Date.now();const deadline=Date.now()+35000,start={x:shooter.authority.x,z:shooter.authority.z};
 while(path.length){
  if(isolationError)throw new Error(isolationError);
  assert.ok(Date.now()<deadline,'input-only navigation completes within 35 seconds');const a=shooter.authority,p=path[0],distance=Math.hypot(p.x-a.x,p.z-a.z);
  if(distance<(path.length===1?.04:.20)){path.shift();best=Infinity;lastProgress=Date.now();continue;}
  if(distance<best-.02){best=distance;lastProgress=Date.now();}
  if(Date.now()-lastProgress>1500){path=route(a,target.authority,shooter.snapshot.actors);best=Infinity;lastProgress=Date.now();continue;}
  // Yaw/pitch and input are the same controls a real browser submits.
  const predictedDistance=Math.hypot(p.x-shooter.game.player.x,p.z-shooter.game.player.z);
  shooter.game.player.yaw=Math.atan2(p.x-shooter.game.player.x,p.z-shooter.game.player.z);shooter.game.player.pitch=0;shooter.input.forward=Math.min(1,Math.min(distance,predictedDistance)/.24);await delay(40);
 }
 shooter.input={...idle};await delay(400);
 check(`${shooter.name} reaches line of sight by moving through the map`,()=>{assert.ok(Math.hypot(shooter.authority.x-start.x,shooter.authority.z-start.z)>.2);assert.ok(visible(shooter.game.eye(shooter.game.player),{x:target.authority.x,y:target.authority.y+.3,z:target.authority.z}));});
}
function aimPoint(shooter:User,target:User,part:'head'|'leg'){
 shooter.network.present();const shown=actorOn(shooter,target.name),volumes=sampleHitVolumes(shown,shooter.network.remoteTime),origin=shooter.game.eye(shooter.game.player);
 for(const volume of volumes.filter(v=>part==='head'?v.part==='head':['lowerLimb','limb'].includes(v.part)&&/calf|thigh/i.test(v.name))){
  const point=volume.center,v={x:point.x-origin.x,y:point.y-origin.y,z:point.z-origin.z},length=Math.hypot(v.x,v.y,v.z),direction={x:v.x/length,y:v.y/length,z:v.z/length},hit=rayHitVolumes(origin,direction,volumes);
  if(hit&&visible(origin,point)&&(part==='head'?hit.part==='head':['limb','lowerLimb','extremity'].includes(hit.part)))return point;
 }
 throw new Error(`No clear ${part} ray to ${target.name}`);
}
function aim(shooter:User,point:Vec){const p=shooter.game.player,eye=shooter.game.eye(p);p.yaw=Math.atan2(point.x-eye.x,point.z-eye.z);p.pitch=Math.atan2(point.y-eye.y,Math.hypot(point.x-eye.x,point.z-eye.z))-p.recoil;shooter.network.setADS(true);}
async function shoot(shooter:User,target:User,part:'head'|'leg'){
 await until(()=>shooter.authority.cooldown===0&&target.authority.spawnSafe===0,'weapon recovery and spawn protection');
 aim(shooter,aimPoint(shooter,target,part));await until(()=>shooter.authority.ads&&shooter.authority.moving<.01&&target.authority.moving<.01,'stationary authoritative ADS');await delay(500);const intended=aimPoint(shooter,target,part);aim(shooter,intended);
 const observer=users.find(u=>u!==shooter&&u!==target&&u.authority.spectator);assert.ok(observer,'an independent spectator observes authoritative effects');
 const effectMark=observer.game.events.length,shownShooter=actorOn(observer,shooter.name),shownTarget=actorOn(observer,target.name);
 const marks=users.map(u=>u.messages.length),ammo=shooter.authority.ammo;shooter.network.fire();
 await until(()=>users.every((u,i)=>events(u,marks[i]).some(e=>e.type==='shot'&&e.actor===shooter.actorId)),`${shooter.name} shot delivered to all three adapters`);
 const shots=users.map((u,i)=>events(u,marks[i]).find(e=>e.type==='shot'&&e.actor===shooter.actorId).shot);
 // Raw delivery alone cannot prove that the strict adapter accepted the event.
 // A spectator generates no predicted attacks, so this observes the actual
 // application effect queue consumed by graphics/audio in the browser.
 const renderedShots=()=>observer.game.events.slice(effectMark).filter(event=>event.type==='shot'&&event.actor===shownShooter.id&&event.shot?.time===shots[0].time);
 await until(()=>renderedShots().length>0,`${shooter.name} authoritative shot reaches spectator game.events`);
 check(`${shooter.name} ${part} shot reaches the frontend effect queue exactly once`,()=>{
  assert.equal(observer.game.player.spectator,true);assert.notEqual(shownShooter.id,0);
  assert.equal(renderedShots().length,1);assert.deepEqual(renderedShots()[0].shot,{...shots[0],actor:shownShooter.id,hit:shownTarget.id});
  assert.equal(renderedShots()[0].actorName,shooter.name);
 });
 authoritativeEffects.push({observer:observer.name,actor:shooter.name,type:'shot',serverTime:shots[0].time});
 await until(()=>shooter.authority.ammo===ammo-1,'authoritative ammunition consumption');
 if(shots[0].hit!==target.actorId)console.error('Shot geometry mismatch',JSON.stringify({intended,shot:shots[0],shooter:{position:shooter.game.eye(shooter.authority),yaw:shooter.authority.yaw,pitch:shooter.authority.pitch,ads:shooter.authority.ads},target:{id:target.authority.id,x:target.authority.x,y:target.authority.y,z:target.authority.z,yaw:target.authority.yaw,pose:target.authority.pose}},null,2));
 check(`${shooter.name} ${part} shot agrees on all three connections`,()=>{for(const shot of shots)assert.deepEqual(shots[0],shot);assert.equal(shots[0].hit,target.actorId);assert.equal(shots[0].headshot,part==='head');assert.equal(shooter.authority.ammo,ammo-1);});
 combat.push({shooter:shooter.name,victim:target.name,part,serverTime:shots[0].time,headshot:shots[0].headshot});
}
async function reloadObserved(shooter:User,target:User){
 const observer=users.find(u=>u!==shooter&&u!==target&&u.authority.spectator);assert.ok(observer);
 await until(()=>shooter.authority.cooldown===0,'bolt recovery before reload');
 const actor=actorOn(observer,shooter.name),mark=observer.game.events.length,ammo=shooter.authority.ammo,total=ammo+shooter.authority.reserve;
 shooter.network.setADS(false);shooter.network.reload();
 const reloads=()=>observer.game.events.slice(mark).filter(event=>event.type==='reload'&&event.actor===actor.id);
 await until(()=>reloads().length>0&&users.every(u=>actorOn(u,shooter.name).reload>0),`${shooter.name} authoritative reload reaches spectator game.events`);
 check(`${shooter.name} reload reaches the frontend effect queue exactly once`,()=>{
  assert.equal(observer.game.player.spectator,true);assert.notEqual(actor.id,0);assert.equal(reloads().length,1);assert.equal(reloads()[0].actorName,shooter.name);
 });
 await until(()=>shooter.authority.reload===0&&shooter.authority.ammo>ammo,`${shooter.name} reload completes authoritatively`,8000);
 check(`${shooter.name} reload transfers ammunition without duplicate effects`,()=>{assert.equal(shooter.authority.ammo+shooter.authority.reserve,total);assert.equal(reloads().length,1);});
 authoritativeEffects.push({observer:observer.name,actor:shooter.name,type:'reload'});
}
async function fight(shooter:User,target:User){
 await navigate(shooter,target);const deaths=target.authority.deaths,kills=shooter.authority.kills;
 await shoot(shooter,target,'leg');
 await until(()=>users.every(u=>actorOn(u,target.name).hp>0&&actorOn(u,target.name).hp<100),'all adapters show nonfatal damage');
 check(`${target.name} survives limb damage with matching health`,()=>{assert.equal(actorOn(shooter,target.name).hp,target.game.player.hp);assert.equal(target.authority.alive,true);assert.equal(target.authority.deaths,deaths);assert.equal(shooter.authority.kills,kills);});
 await reloadObserved(shooter,target);
 await shoot(shooter,target,'head');
 await until(()=>users.every(u=>actorOn(u,target.name).deaths===deaths+1&&!actorOn(u,target.name).alive&&actorOn(u,shooter.name).kills===kills+1),'all adapters agree on death and scores');
 check(`${target.name} death, killer score and killcam are authoritative`,()=>{for(const u of users){assert.equal(actorOn(u,target.name).hp,0);assert.ok(events(u).some(e=>e.type==='kill'&&e.actor===shooter.actorId&&e.victim===target.actorId));}assert.equal(target.game.state,'killcam');});
 target.network.skipReplay();
 check(`${target.name} waits in the killcam after skipping`,()=>{assert.equal(target.game.state,'killcam');assert.equal(target.network.waitingForRespawn,true);assert.equal(target.game.player.alive,false);});
 await until(()=>{if(!target.authority.alive)assert.equal(target.game.state,'killcam','a dead client never returns to normal gameplay before respawn');return users.every(u=>actorOn(u,target.name).alive&&actorOn(u,target.name).hp===100);},'all adapters observe automatic respawn',6000);
 check(`${target.name} respawns with 150 rounds and retained scores`,()=>{for(const u of users){const actor=actorOn(u,target.name);assert.equal(actor.ammo+actor.reserve,150);assert.equal(actor.deaths,deaths+1);assert.equal(actorOn(u,shooter.name).kills,kills+1);}});
}

try{
 let relayPort:number|undefined;
 if(!remote){
  temporary=await mkdtemp(join(tmpdir(),'bolts-real-clients-'));dbPath=join(temporary,'events.sqlite');const port=await unusedPort();base=`http://127.0.0.1:${port}`;
  backend=spawn(backendPath,[],{cwd:root,env:{...process.env,BOLTS_BIND:`127.0.0.1:${port}`,BOLTS_DB:dbPath,BOLTS_EMPTY_SECONDS:'2',BOLTS_RECONNECT_SECONDS:'1'},stdio:['ignore','pipe','pipe']});
  backend.stdout!.on('data',chunk=>{diagnostics=(diagnostics+chunk).slice(-12000);});backend.stderr!.on('data',chunk=>{diagnostics=(diagnostics+chunk).slice(-12000);});backend.on('error',error=>{diagnostics+=error.message;});
  relayPort=await delayRelay(port);
 }
 await until(async()=>{try{return (await fetch(base+'/api/health',{signal:AbortSignal.timeout(remote?5000:1000)})).ok;}catch{return false;}},'server health');
 if(remote){
  const rows=await lobbyInventory();inventoryBefore=rows;const empty=rows.find(row=>row.players===0&&row.capacity===6&&row.phase==='playing');assert.ok(empty,'remote QA requires an empty playing lobby; never quick-join an occupied room');qaLobbyId=empty.id;
  const fresh=await lobbyInventory();assert.equal(fresh.find(row=>row.id===qaLobbyId)?.players,0,'selected QA lobby is still empty immediately before joining');
  check('production QA selected and rechecked an empty six-player lobby',()=>assert.ok(qaLobbyId));
 }
 const tag=Date.now().toString(36).slice(-5),a=user(remote?`QA Alpha ${tag}`:'Combat Alpha','british'),b=user(remote?`QA Beta ${tag}`:'Combat Beta','german',relayPort),observer=user(remote?`QA Observer ${tag}`:'Combat Observer','russian');users.push(a,b,observer);
 const community=new CommunityClient(base),onlineBefore=await community.status();
 await a.network.join(qaLobbyId||undefined,a.name,a.faction,true);qaLobbyId=a.network.lobbyId;
 if(remote)assert.ok(a.snapshot.remaining>90,'enough round time remains for isolated reciprocal combat');
 check('one human receives two server AI with spectator safety',()=>{assert.equal(a.snapshot.actors.filter(actor=>actor.bot===true).length,2);assert.equal(a.snapshot.actors.filter(actor=>actor.bot!==true).length,1);assert.equal(a.authority.spectator,true);for(const bot of a.snapshot.actors.filter(actor=>actor.bot))assert.equal(bot.ping,null);});
 const firstRoom=(await lobbyInventory()).find(room=>room.id===qaLobbyId)!;
 check('lobby inventory counts the human separately from two AI seats',()=>{assert.equal(firstRoom.players,1);assert.equal(firstRoom.bots,2);assert.equal(firstRoom.capacity,6);});
 const onlineOne=await community.status();check('online count includes the first connected human and excludes bots',()=>{if(!remote)assert.equal(onlineOne,onlineBefore+1);else assert.ok(onlineOne>=1);});
 await b.network.join(qaLobbyId,b.name,b.faction,true);
 check('two humans retain exactly two server AI',()=>{assert.equal(b.snapshot.actors.filter(actor=>actor.bot===true).length,2);assert.equal(b.snapshot.actors.filter(actor=>actor.bot!==true).length,2);});
 await observer.network.join(qaLobbyId,observer.name,observer.faction,true);
 timer=setInterval(()=>{for(const u of users){u.network.update(1/60,u.input);u.network.present();}},1000/60);
 await until(()=>users.every(u=>u.snapshot.actors.length===3&&u.snapshot.actors.every(actor=>actor.bot!==true)&&u.game.actors.length===3),'third human removes both AI from all three adapters');
 check('three independent human sessions replace AI with correctly remapped IDs',()=>{for(const u of users){assert.equal(u.network.lobbyId,qaLobbyId);assert.equal(u.game.player.id,0);for(const peer of users)assert.equal(actorOn(u,peer.name).name,peer.name);}assert.equal(new Set(users.map(u=>[...u.storage.values()][0])).size,3,'independent browsers receive distinct credentials');});
 const fullRoom=(await lobbyInventory()).find(room=>room.id===qaLobbyId)!;check('three-human lobby no longer advertises any AI',()=>{assert.equal(fullRoom.players,3);assert.equal(fullRoom.bots,0);});
 const onlineThree=await community.status();check('online count includes all three connected humans',()=>{if(!remote)assert.equal(onlineThree,onlineBefore+3);else assert.ok(onlineThree>=3);});
 await until(()=>users.every(u=>u.game.actors.every(actor=>Number.isInteger(actor.ping))),'server-measured ping on all three humans',10000);
 check(remote?'all production clients receive bounded server-measured human RTTs':'each scoreboard row has its own server-measured RTT across a delayed connection',()=>{for(const u of users){const fast=actorOn(u,a.name).ping!,slow=actorOn(u,b.name).ping!,observerPing=actorOn(u,observer.name).ping!;for(const ping of [fast,slow,observerPing])assert.ok(ping>=0&&ping<=999);if(!remote){assert.ok(slow>=140);assert.ok(slow-fast>100,'the remote delayed row cannot reuse the local connection ping');}latencyEvidence.push({observer:u.name,alphaMs:fast,betaMs:slow,observerMs:observerPing});}});
 if(!remote){
  // Exercise the real HTTP/SQLite path while clients continue receiving ticks.
  // Spectators keep combat out of the measurement; this never touches live DBs.
  await community.leaderboard();
  const locker=new DatabaseSync(dbPath);locker.exec('BEGIN IMMEDIATE');
  const mark=a.messages.length,startTick=a.snapshot.tick,start=performance.now();let finished=false;
  const visit=fetch(base+'/api/visits',{method:'POST',headers:{'content-type':'application/json',origin:'http://127.0.0.1:5173'},body:JSON.stringify({visitorId:crypto.randomUUID()})}).then(response=>{finished=true;return response;});
  try{
   await delay(300);
   const frames=a.messages.slice(mark).filter(m=>m.type==='snapshot');
   check('SQLite writer contention does not stop authoritative snapshots',()=>{assert.equal(finished,false,'visitor waits for persistence');assert.ok(frames.length>=3,`received ${frames.length} snapshots during writer lock`);assert.ok(a.snapshot.tick-startTick>=9,'authority continues advancing fixed ticks');});
   netcodeEvidence.storageLock={milliseconds:performance.now()-start,snapshots:frames.length,ticks:a.snapshot.tick-startTick};
  }finally{locker.exec('ROLLBACK');locker.close();}
  assert.equal((await visit).status,204);
  // Ordered TCP stalls in each direction, followed by normal traffic. This is
  // separate from the unit clock tests and exercises actual browser adapters.
  relayBurst={up:100,down:150};await delay(200);relayBurst={up:0,down:0};await delay(1200);
  check('all adapters recover after asymmetric ordered delivery stalls',()=>{for(const u of users){assert.equal(u.network.connected,true);assert.deepEqual(u.failures,[]);}assert.ok(b.network.diagnostics.remoteBufferedMs<500,'playback does not retain a growing stale-state backlog');});
  netcodeEvidence.afterOrderedStall=users.map(u=>({name:u.name,...u.network.diagnostics}));
 }
 a.network.setFaction(a.faction);b.network.setFaction(b.faction);await until(()=>users.every(u=>!actorOn(u,a.name).spectator&&!actorOn(u,b.name).spectator&&actorOn(u,observer.name).spectator),'two combatants leave spectator mode and third remains observing');
 const bodies=remote?[`${a.name}: temporary QA <b>literal</b> ^3hello`,`${b.name}: temporary QA reply`]:['Alpha says <b>literal</b> ^3hello','Beta replies after joining'];
 a.network.chat(bodies[0]);b.network.chat(bodies[1]);await until(()=>users.every(u=>bodies.every(body=>u.chat.includes(body))),'bidirectional chat');
 check('chat from both combatants arrives verbatim for all three players',()=>{for(const u of users)assert.deepEqual([...u.chat].sort(),[...bodies].sort());});
 await fight(a,b);await fight(b,a);
 check('spectator application effects contain four authoritative shots and two reloads',()=>{assert.equal(authoritativeEffects.filter(event=>event.type==='shot').length,4);assert.equal(authoritativeEffects.filter(event=>event.type==='reload').length,2);});
 check('all three clients agree on the final reciprocal combat totals',()=>{for(const u of users)for(const name of [a.name,b.name]){const actor=actorOn(u,name);assert.equal(actor.kills,1);assert.equal(actor.deaths,1);assert.equal(actor.shots,2);assert.equal(actor.hits,2);}});
 const board=await community.leaderboard();
 check('both leaderboard periods match combat totals and omit default and AI names',()=>{for(const rows of [board.allTime,board.last24Hours]){for(const name of [a.name,b.name]){const row=rows.find(row=>row.name===name);assert.ok(row);assert.equal(row.kills,1);assert.equal(row.deaths,1);}const watching=rows.find(row=>row.name===observer.name);assert.ok(watching);assert.equal(watching.kills,0);assert.equal(watching.deaths,0);assert.ok(rows.every(row=>row.name.toLowerCase()!=='unknown soldier'));if(!remote)assert.ok(rows.every(row=>!row.name.startsWith('[AI]')));}});
 let feedbackId:string|undefined;const feedbackMessage='Multiplayer QA: menu feedback <b>stays literal</b>.',feedbackEmail='qa@example.invalid';
 if(!remote){
  const invalid=await fetch(base+'/api/feedback',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:'   '})});assert.equal(invalid.status,400);
  const feedback=await fetch(base+'/api/feedback',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:feedbackMessage,email:feedbackEmail})});assert.equal(feedback.status,201);feedbackId=(await feedback.json()).id;assert.ok(feedbackId);
  check('feedback API validates required text and accepts optional email',()=>assert.ok(feedbackId));
 }
 // Make every human a spectator before disconnecting so momentarily restored
 // AI cannot add combat while the three leave frames travel separately.
 a.network.spectate();b.network.spectate();await until(()=>users.every(u=>u.snapshot.actors.filter(actor=>actor.bot!==true).every(actor=>actor.spectator)),'combatants safely return to spectators');
 for(const u of users)u.network.disconnect();if(timer){clearInterval(timer);timer=undefined;}
 await delay(350);
 const onlineAfter=await community.status();check('online count drops after QA disconnects',()=>{if(!remote)assert.equal(onlineAfter,onlineBefore);else assert.ok(onlineAfter>=0);});
 let persisted:any;
 if(!remote){const db=new DatabaseSync(dbPath,{readOnly:true});
 try{
  check('SQLite integrity and foreign keys remain valid',()=>{assert.equal(db.prepare('PRAGMA integrity_check').get()!.integrity_check,'ok');assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);});
  check('all three human identities have exactly one durable enter and leave event',()=>{const rows=db.prepare("SELECT m.id,m.left_at,(SELECT count(*) FROM events e WHERE e.event_type='player_enter' AND json_extract(e.data,'$.membershipId')=m.id) enters,(SELECT count(*) FROM events e WHERE e.event_type='player_leave' AND json_extract(e.data,'$.membershipId')=m.id) leaves FROM memberships m JOIN players p ON p.id=m.player_id WHERE p.is_bot=0").all();assert.equal(rows.length,3);for(const row of rows){assert.ok(row.left_at);assert.equal(row.enters,1);assert.equal(row.leaves,1);}});
  check('both chat bodies are linked to typed events and the sending identities',()=>{const rows=db.prepare("SELECT c.body,c.player_id,e.actor_player_id,e.event_type FROM chat_messages c JOIN events e ON e.id=c.id").all();assert.equal(rows.length,2);assert.deepEqual(rows.map(row=>row.body).sort(),[...bodies].sort());for(const row of rows){assert.equal(row.event_type,'chat');assert.equal(row.player_id,row.actor_player_id);}});
  check('reciprocal kills and deaths form two durable linked combat records',()=>{const rows=db.prepare("SELECT k.display_name killer,v.display_name victim,c.headshot,ke.event_type kill_type,de.event_type death_type,ke.actor_player_id,de.actor_player_id victim_actor,c.killer_id,c.victim_id FROM combat_events c JOIN players k ON k.id=c.killer_id JOIN players v ON v.id=c.victim_id JOIN events ke ON ke.id=c.kill_event_id JOIN events de ON de.id=c.death_event_id WHERE k.is_bot=0 AND v.is_bot=0").all();assert.equal(rows.length,2);assert.deepEqual(rows.map(row=>`${row.killer}->${row.victim}`).sort(),['Combat Alpha->Combat Beta','Combat Beta->Combat Alpha']);for(const row of rows){assert.equal(row.headshot,1);assert.equal(row.kill_type,'player_kill');assert.equal(row.death_type,'player_death');assert.equal(row.actor_player_id,row.killer_id);assert.equal(row.victim_actor,row.victim_id);}});
  persisted=db.prepare('SELECT m.name,m.kills,m.deaths,m.shots,m.hits FROM match_players m JOIN players p ON p.id=m.player_id WHERE p.is_bot=0 ORDER BY name').all();
  check('durable human statistics match combat and the spectator stays unscored',()=>{assert.equal(persisted.length,3);for(const row of persisted){const watching=row.name===observer.name;assert.equal(row.kills,watching?0:1);assert.equal(row.deaths,watching?0:1);assert.equal(row.shots,watching?0:2);assert.equal(row.hits,watching?0:2);}});
  check('bot identities persist without browser connections and close every membership',()=>{assert.equal(db.prepare('SELECT count(*) n FROM players WHERE is_bot=1').get()!.n,2);assert.equal(db.prepare('SELECT count(*) n FROM connections c JOIN players p ON p.id=c.player_id WHERE p.is_bot=1').get()!.n,0);const rows=db.prepare("SELECT m.left_at,(SELECT count(*) FROM events e WHERE e.event_type='player_enter' AND json_extract(e.data,'$.membershipId')=m.id) enters,(SELECT count(*) FROM events e WHERE e.event_type='player_leave' AND json_extract(e.data,'$.membershipId')=m.id) leaves FROM memberships m JOIN players p ON p.id=m.player_id WHERE p.is_bot=1").all();assert.ok(rows.length>=2);for(const row of rows){assert.ok(row.left_at);assert.equal(row.enters,1);assert.equal(row.leaves,1);}});
  check('feedback text and optional email persist with one linked submitted event',()=>{const rows=db.prepare('SELECT f.id,f.message,f.email,e.event_type FROM feedback_requests f JOIN feedback_events e ON e.request_id=f.id').all();assert.equal(rows.length,1);assert.equal(rows[0].id,feedbackId);assert.equal(rows[0].message,feedbackMessage);assert.equal(rows[0].email,feedbackEmail);assert.equal(rows[0].event_type,'submitted');});
 }finally{db.close();}}
 else{
  await until(async()=>{const rows=await lobbyInventory();inventoryAfter=rows;const room=rows.find(row=>row.id===qaLobbyId);return !room||(room.players===0&&room.bots===0);},'production QA room has no remaining participants',10000);
  check('production QA clients disconnected and their room is empty',()=>assert.ok(inventoryAfter));
 }
 check('none of the three adapters experienced a connection failure',()=>{for(const u of users)assert.deepEqual(u.failures,[]);});
 const report={passed:true,mode:remote?'production QA':'isolated local',endpoint:base,lobbyId:qaLobbyId,startedAt:new Date(started).toISOString(),durationSeconds:(Date.now()-started)/1000,...(!remote?{backendSha256:createHash('sha256').update(await readFile(backendPath)).digest('hex')}:{inventoryBefore,inventoryAfter}),delayRelayMsEachDirection:remote?0:80,latencyEvidence,netcodeEvidence,authoritativeEffects,online:{before:onlineBefore,oneHuman:onlineOne,threeHumans:onlineThree,after:onlineAfter},checks,combat,persisted};
 const reportPath=remote?'artifacts/multiplayer-remote-e2e.json':'artifacts/multiplayer-client-e2e.json';
 await mkdir(resolve(root,'artifacts'),{recursive:true});await writeFile(resolve(root,reportPath),JSON.stringify(report,null,2)+'\n');
 console.log(`Multiplayer adapter combat: ${checks.length} checks passed; report ${reportPath}.`);
}catch(error){console.error(error);if(diagnostics)console.error(diagnostics);process.exitCode=1;}
finally{
 if(timer)clearInterval(timer);for(const u of users)u.network.disconnect();
 for(const timeout of relayTimers)clearTimeout(timeout);for(const socket of relaySockets)socket.destroy();if(relay)await new Promise<void>(done=>relay!.close(()=>done()));
 if(backend){backend.kill('SIGINT');await Promise.race([new Promise(done=>backend!.once('exit',done)),delay(2000)]);if(backend.exitCode===null)backend.kill('SIGKILL');}
 if(temporary)await rm(temporary,{recursive:true,force:true});
}
