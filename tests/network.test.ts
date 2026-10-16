import test from 'node:test';
import assert from 'node:assert/strict';
import {Game,createActor} from '../src/engine.ts';
import {NetworkClient,type SocketLike,type WireActor,type WireSnapshot} from '../src/network.ts';
import {MELEE_SECONDS,WEAPONS,HEIGHTS} from '../src/config.ts';

class MockSocket implements SocketLike {
 readyState=0;onopen:SocketLike['onopen']=null;onmessage:SocketLike['onmessage']=null;onerror:SocketLike['onerror']=null;onclose:SocketLike['onclose']=null;messages:any[]=[];closed=false;
 send(raw:string){this.messages.push(JSON.parse(raw));}
 close(){this.closed=true;this.readyState=3;this.onclose?.({});}
 open(){this.readyState=1;this.onopen?.({});}
 receive(message:unknown){this.onmessage?.({data:JSON.stringify(message)});}
}
function actor(id:number,faction:WireActor['faction']='british'):WireActor {
 const {ai,...body}=createActor(id,faction,`Player ${id}`);
 const value={...body,ack:0,hipSpread:.08,x:12,z:id===42?0:4};
 for(const [key,v]of Object.entries(value))if(typeof v==='number'&&!Number.isFinite(v))(value as any)[key]=-1000;
 return value;
}
function snapshot(tick=1,time=0,actors=[actor(7,'german'),actor(42)]):WireSnapshot{return{type:'snapshot',tick,time,remaining:300-time,roundNumber:1,ended:false,winner:null,actors,events:[]};}
const idle={forward:0,right:0,jump:false,walk:false,lean:0};
async function fixture(spectator=false){
 const game=new Game(),sockets:MockSocket[]=[],urls:string[]=[],requests:{url:string;init?:RequestInit}[]=[],storage=new Map<string,string>();let now=0;
 const client=new NetworkClient(game,{origin:'https://multiplayer.example.test',now:()=>now,storage:{getItem:key=>storage.get(key)??null,setItem:(k,v)=>void storage.set(k,v),removeItem:k=>void storage.delete(k)},fetch:async(url,init)=>{requests.push({url:String(url),init});return new Response(JSON.stringify({playerId:'6e1b12b2-133f-407f-a882-53065c83139f',token:'opaque-session-token-at-least-twenty-characters'}),{status:200});},socket:url=>{urls.push(url);const ws=new MockSocket();sockets.push(ws);return ws;}});
 const joining=client.join(undefined,'^3Chris','british',spectator);await new Promise(resolve=>setImmediate(resolve));const socket=sockets[0];socket.open();socket.receive({type:'welcome',playerId:'6e1b12b2-133f-407f-a882-53065c83139f'});const initial=snapshot();if(spectator)Object.assign(initial.actors[1],{spectator:true,alive:false,hp:0});socket.receive({type:'joined',lobbyId:'room-one',lobbyName:'Rommel Alpha',actorId:42,snapshot:initial});await joining;
 return{client,game,socket,sockets,urls,requests,storage,setNow:(value:number)=>{now=value;}};
}
test('network authentication keeps opaque token out of URLs and maps self to actor zero',async()=>{
 const {client,game,socket,urls,requests,storage}=await fixture();
 try{
  assert.equal(urls[0],'wss://multiplayer.example.test/api/ws');assert.equal(requests[0].url,'https://multiplayer.example.test/api/session');assert.deepEqual(JSON.parse(String(requests[0].init?.body)),{});
  assert.deepEqual(socket.messages[0],{type:'hello',version:1,token:'opaque-session-token-at-least-twenty-characters'});assert.deepEqual(socket.messages[1],{type:'join',name:'^3Chris',faction:'british'});assert.equal(storage.size,1);
  assert.equal(game.player.id,0);assert.equal(game.player.name,'Player 42');assert.equal(game.actors[1].name,'Player 7');assert.equal(game.actors.length,2);assert.equal(game.state,'playing');
 }finally{client.disconnect();}
});
test('render identity follows server actors across roster reindexing and faction changes',async()=>{
 const {client,game}=await fixture();
 try{
  assert.equal(game.player.renderIdentity,'room-one:42');const existing=game.actors[1].renderIdentity;
  client.receiveSnapshot(snapshot(2,.05,[actor(3,'russian'),actor(7,'german'),actor(42)]));
  assert.equal(game.actors[2].renderIdentity,existing);assert.equal(game.actors[1].renderIdentity,'room-one:3');
  client.receiveSnapshot(snapshot(3,.1,[actor(7,'british'),actor(42)]));assert.equal(game.actors[1].renderIdentity,existing);assert.equal(game.actors[1].faction,'british');
 }finally{client.disconnect();}
});
test('prediction moves immediately, reconciles unacked inputs and never runs AI or client damage',async()=>{
 const {client,game,socket,setNow}=await fixture();
 try{
  game.update=()=>{throw new Error('Online must not run the local AI simulation');};game.damage=()=>{throw new Error('Online must not author damage');};
  const start=game.player.z;setNow(17);client.update(1/60,{...idle,forward:1});setNow(34);client.update(1/60,{...idle,forward:1});assert.ok(game.player.z>start+.15);
  const frames=socket.messages.filter(m=>m.type==='input');assert.equal(frames.length,2);
  const self=actor(42);self.ack=frames[0].seq;self.z=.05;client.receiveSnapshot(snapshot(2,.017,[actor(7,'german'),self]));assert.ok(Math.abs(game.player.z-.13)<1e-9,'unacknowledged movement is replayed once after correction');
  const victimHp=game.actors[1].hp;game.player.cooldown=0;client.fire();setNow(51);client.update(1/60,idle);assert.equal(game.actors[1].hp,victimHp);assert.equal(game.player.kills,0);assert.ok(game.events.some(event=>event.type==='shot'&&event.shot?.hit===null));
 }finally{client.disconnect();}
});
test('server-confirmed actions deduplicate predicted effects and own kills, deaths and killcam',async()=>{
 const {client,game,socket,setNow}=await fixture();
 try{
  client.fire();setNow(17);client.update(1/60,idle);const seq=socket.messages.findLast(m=>m.type==='input').seq;assert.equal(game.events.filter(e=>e.type==='shot').length,1);
  game.events=[];const s=snapshot(2,.05);s.actors[1].ack=seq;s.actors[0].hp=0;s.actors[0].alive=false;s.actors[0].deaths=1;s.actors[1].kills=1;
  s.events=[{type:'shot',actor:42,seq,shot:{seq,time:.02,actor:42,origin:{x:12,y:1.65,z:0},end:{x:12,y:1.65,z:4},kind:'shot',hit:7,headshot:true}},{type:'kill',actor:42,victim:7,weapon:'rifle',headshot:true}];
  client.receiveSnapshot(s);assert.equal(game.events.filter(e=>e.type==='shot').length,0);assert.equal(game.events.find(e=>e.type==='kill')?.victim,1);assert.equal(game.player.kills,1);assert.equal(game.actors[1].deaths,1);assert.equal(game.shots[0].hit,1);
  const death=snapshot(3,.1);death.actors[1].alive=false;death.actors[1].hp=0;death.actors[1].deaths=1;death.events=[{type:'kill',actor:7,victim:42,weapon:'rifle',headshot:true}];client.receiveSnapshot(death);
  assert.equal(game.state,'killcam');assert.equal(game.killer,1);assert.ok(game.replay.length>=2);client.skipReplay();assert.equal(game.state,'killcam');assert.equal(client.waitingForRespawn,true);assert.equal(game.player.alive,false,'skip does not grant a client-side respawn');
 }finally{client.disconnect();}
});
test('grenade fire predicts only a short melee pose and authoritative damage arrives separately',async()=>{
 const {client,game,socket,setNow}=await fixture();
 try{
  game.damage=()=>{throw new Error('Grenade prediction must not author damage');};
  client.selectWeapon('grenade');client.fire();setNow(17);client.update(1/60,idle);
  assert.equal(game.player.selectedWeapon,'grenade');assert.equal(game.events.filter(e=>e.type==='shot').length,0,'switching blocks the bash');
  const ready=snapshot(2,1);Object.assign(ready.actors[1],{selectedWeapon:'grenade',switchStarted:0,ammo:0,reserve:0,ack:socket.messages.findLast(m=>m.type==='input').seq});
  setNow(1000);client.receiveSnapshot(ready);game.events=[];
  client.fire();setNow(1017);client.update(1/60,idle);
  const seq=socket.messages.findLast(m=>m.type==='input').seq,shot=game.events.find(e=>e.type==='shot')!.shot!;
  assert.equal(shot.kind,'melee');assert.equal(shot.hit,null);assert.equal(shot.headshot,false);
  assert.ok(Math.hypot(shot.end.x-shot.origin.x,shot.end.y-shot.origin.y,shot.end.z-shot.origin.z)<=1.85+1e-9);
  assert.equal(game.player.cooldown,MELEE_SECONDS);assert.equal(game.player.lastMeleeTime,game.time);assert.equal(game.player.lastShotTime,-1000);
  assert.equal(game.player.ammo,0);assert.equal(game.player.reserve,0);assert.equal(game.player.recoil,0);assert.equal(game.actors[1].hp,100);
  client.fire(true);setNow(1034);client.update(1/60,idle);assert.equal(game.events.filter(e=>e.type==='shot').length,1,'primary and melee inputs share recovery');
  const confirmed=snapshot(3,1.05);Object.assign(confirmed.actors[1],{selectedWeapon:'grenade',switchStarted:0,ammo:0,reserve:0,cooldown:MELEE_SECONDS-.033,lastMeleeTime:1.017,ack:socket.messages.findLast(m=>m.type==='input').seq});confirmed.actors[0].hp=25;
  confirmed.events=[{type:'shot',actor:42,seq,shot:{...shot,actor:42,hit:7,time:1.017,seq}},{type:'hurt',actor:7,value:75}];
  game.events=[];setNow(1050);client.receiveSnapshot(confirmed);assert.equal(game.actors[1].hp,25);assert.equal(game.player.kills,0);assert.equal(game.events.filter(e=>e.type==='shot').length,0,'authority does not replay the predicted bash effect');
 }finally{client.disconnect();}
});
test('online menus send neutral input and still consume authoritative movement and scores',async()=>{
 const {client,game,socket,setNow}=await fixture();
 try{
  client.setPaused(true);client.fire();setNow(17);client.update(1/60,{...idle,forward:1,jump:true});const command=socket.messages.findLast(m=>m.type==='input');assert.equal(command.forward,0);assert.equal(command.jump,false);assert.equal(command.fire,false);assert.equal(command.ads,false);
  const s=snapshot(2,.05);s.actors[0].kills=3;s.actors[0].x=10;client.receiveSnapshot(s);assert.equal(game.actors[1].kills,3);assert.equal(game.state,'paused');assert.equal(game.remaining,299.95);client.setPaused(false);assert.equal(game.state,'playing');
 }finally{client.disconnect();}
});
test('chat focus clears queued combat and sends neutral input until text entry closes',async()=>{
 const {client,game,socket,setNow}=await fixture();
 try{
  client.setADS(true);client.fire();client.fire(true);client.reload();client.selectWeapon('grenade');client.toggleStance('crouch');client.clearInput();
  setNow(17);client.update(1/60,{forward:1,right:1,jump:true,walk:true,lean:1},false);
  const blocked=socket.messages.findLast(m=>m.type==='input');
  assert.deepEqual([blocked.forward,blocked.right,blocked.jump,blocked.walk,blocked.lean,blocked.fire,blocked.reload,blocked.melee,blocked.ads],[0,0,false,false,0,false,false,false,false]);
  assert.equal(blocked.weapon,'rifle');assert.equal(blocked.stance,'stand');assert.equal(game.state,'playing');assert.equal(game.player.ads,false);
  client.chat('<b>literal text</b>');assert.deepEqual(socket.messages.at(-1),{type:'chat',text:'<b>literal text</b>'});
  setNow(34);client.update(1/60,idle,true);const resumed=socket.messages.findLast(m=>m.type==='input');
  assert.equal(resumed.fire,false);assert.equal(resumed.reload,false);assert.equal(resumed.melee,false);assert.equal(game.events.filter(event=>['shot','reload','switch'].includes(event.type)).length,0);
 }finally{client.disconnect();}
});
test('scoreboard ping follows each server actor without interpolation or trusting local heartbeat timing',async()=>{
 const {client,game,setNow,socket}=await fixture();
 try{
  const first=snapshot(2,.1);first.actors[0].ping=174;first.actors[1].ping=12;client.receiveSnapshot(first);
  assert.equal(game.player.ping,12);assert.equal(game.actors[1].ping,174);
  setNow(3100);client.update(1/60,idle);socket.receive({type:'pong',nonce:3100});assert.equal(client.ping,0);
  assert.equal(game.player.ping,12,'self-reported/client-local timing never overwrites server RTT');
  const second=snapshot(3,.2);second.actors[0].ping=210;second.actors[1].ping=18;client.receiveSnapshot(second);client.present();
  assert.equal(game.actors[1].ping,210,'latest metadata is not interpolated with delayed poses');assert.equal(game.player.ping,18);
  for(const invalid of [-1,1000,1.5,NaN,Infinity,'20']){const bad=snapshot(4,.3);bad.actors[0].ping=invalid as number;assert.equal(client.receiveSnapshot(bad),false);}
  const stale=snapshot(4,.3);stale.actors.forEach(a=>a.ping=null);client.receiveSnapshot(stale);assert.equal(game.player.ping,null);assert.equal(game.actors[1].ping,null);
  const fresh=snapshot(5,.4);fresh.actors.forEach(a=>a.ping=40);client.receiveSnapshot(fresh);socket.onclose?.({});assert.ok(game.actors.every(a=>a.ping===null));client.present();assert.ok(game.actors.every(a=>a.ping===null),'buffered frames must not restore a disconnected reading');
 }finally{client.disconnect();}
});
test('roster remapping is contiguous, clears incompatible replay history and validates hostile frames',async()=>{
 const {client,game}=await fixture();
 try{
  let rebuilt=0;client.onRoster=()=>rebuilt++;const newcomer=actor(3,'german');client.receiveSnapshot(snapshot(2,.05,[newcomer,actor(42),actor(7,'german')]));assert.deepEqual(game.actors.map(a=>a.id),[0,1,2]);assert.deepEqual(game.actors.map(a=>a.name),['Player 42','Player 3','Player 7']);assert.equal(rebuilt,1);
  const previous=game.player.x,bad=snapshot(3,.1);bad.actors[1].x=NaN;assert.equal(client.receiveSnapshot(bad),false);assert.equal(game.player.x,previous);
  const departed=snapshot(4,.15,[actor(42)]);client.receiveSnapshot(departed);assert.equal(game.actors.length,1);assert.equal(game.history.length,1);assert.equal(rebuilt,2);
 }finally{client.disconnect();}
});
test('round rollover preserves connection and clears end-state presentation',async()=>{
 const {client,game}=await fixture();
 try{
  const end=snapshot(2,300);end.ended=true;end.remaining=0;end.winner=7;client.receiveSnapshot(end);assert.equal(game.state,'ended');assert.equal(game.winner?.id,1);
  const next=snapshot(3,308);next.roundNumber=2;next.remaining=300;client.receiveSnapshot(next);assert.equal(game.state,'playing');assert.equal(game.winner,null);assert.equal(client.connected,true);
 }finally{client.disconnect();}
});
test('leaving closes transport, cancels reconnect and local AI mode stays local',async()=>{
 const {client,game,socket}=await fixture();client.disconnect();assert.equal(socket.messages.at(-1).type,'leave');assert.equal(socket.closed,true);assert.equal(client.online,false);assert.equal(client.connected,false);
 game.start('german','recruit');const count=socket.messages.length;client.update(1/60,idle);game.update(1/60,idle);assert.equal(socket.messages.length,count);assert.equal(game.actors.length,6);assert.ok(game.time>0);
});
test('session replacement is terminal instead of reconnecting and fighting another tab',async()=>{
 const {client,socket}=await fixture();let failure='';client.onFailure=message=>{failure=message;};socket.onclose?.({code:4001});assert.equal(failure,'Connected in another tab.');assert.equal(client.online,false);assert.equal(socket.closed,true);
});
test('jump standing intent and ADS remain continuous through crouch transitions',async()=>{
 const {client,game,socket,setNow}=await fixture();
 try{
  client.setADS(true);client.toggleStance('crouch');setNow(17);client.update(1/60,idle);assert.equal(game.player.ads,true);assert.equal(game.player.stance,'crouch');assert.ok(game.player.eyeHeight<1.65&&game.player.eyeHeight>1.05);
  setNow(34);client.update(1/60,{...idle,jump:true});assert.equal(game.player.stance,'stand');assert.equal(game.player.grounded,true);assert.equal(game.player.ads,true);
  setNow(51);client.update(1/60,idle);assert.equal(socket.messages.findLast(m=>m.type==='input').stance,'stand');
  setNow(68);client.update(1/60,{...idle,jump:true});assert.equal(game.player.grounded,false);assert.equal(game.player.ads,false);
 }finally{client.disconnect();}
});
test('remote movement interpolates across authority frames without interpolating respawn teleports',async()=>{
 const {client,game,setNow}=await fixture();
 try{
  const first=snapshot(2,.1);first.actors[0].x=10;client.receiveSnapshot(first);
  const next=snapshot(3,.2);next.actors[0].x=11;client.receiveSnapshot(next);setNow(50);client.update(1/60,idle);assert.ok(Math.abs(game.actors[1].x-10.5)<1e-9);
  const respawn=snapshot(4,.3);respawn.actors[0].x=-12;client.receiveSnapshot(respawn);setNow(100);client.update(1/60,idle);assert.equal(game.actors[1].x,11,'respawns never sweep through walls');
 }finally{client.disconnect();}
});
test('remote jump and landing use event times inside a snapshot interval',async()=>{
 const {client,game,setNow}=await fixture();
 try{
  const before=snapshot(2,.1);Object.assign(before.actors[0],{y:1.4,ads:true});setNow(100);client.receiveSnapshot(before);
  const airborne=snapshot(3,.15);Object.assign(airborne.actors[0],{y:1.55,vy:4,grounded:false,leftGroundAt:.125,jumpStarted:.125,ads:false});setNow(150);client.receiveSnapshot(airborne);
  const present=(ms:number)=>{setNow(ms);client.present();return game.actors[1];};
  let remote=present(220);assert.equal(remote.grounded,true);assert.equal(remote.y,1.4);assert.equal(remote.vy,0);assert.equal(remote.jumpStarted,-1000);
  remote=present(230);assert.equal(remote.grounded,false);assert.equal(remote.jumpStarted,.125);assert.equal(remote.leftGroundAt,.125);assert.equal(remote.ads,false);assert.ok(Math.abs(remote.y-1.43)<1e-9);assert.ok(remote.vy>0);
  const falling=snapshot(4,.2);Object.assign(falling.actors[0],{y:1.5,vy:-3,grounded:false,leftGroundAt:.125,jumpStarted:.125});setNow(240);client.receiveSnapshot(falling);
  const ground=snapshot(5,.25);Object.assign(ground.actors[0],{y:1.4,vy:0,grounded:true,leftGroundAt:.125,jumpStarted:.125,landedAt:.225,landingSpeed:3.5});setNow(250);client.receiveSnapshot(ground);
  // Read at explicit buffered times without advancing prediction or modifying
  // the authority snapshots; this also covers landing on a raised crate.
  game.time=.32;client['interpolate']();remote=game.actors[1];assert.equal(remote.grounded,false);assert.equal(remote.landedAt,-1000);assert.ok(Math.abs(remote.y-1.42)<1e-9);assert.ok(remote.vy<0);
  game.time=.33;client['interpolate']();remote=game.actors[1];assert.equal(remote.grounded,true);assert.equal(remote.landedAt,.225);assert.equal(remote.landingSpeed,3.5);assert.equal(remote.y,1.4);assert.equal(remote.vy,0);
  assert.equal(airborne.actors[0].y,1.55);assert.equal(ground.actors[0].landedAt,.225,'presentation leaves recorded frames immutable');
 }finally{client.disconnect();}
});
test('remote landing followed by an immediate jump selects the most recent event',async()=>{
 const {client,game}=await fixture();
 try{
  const before=snapshot(2,.1);Object.assign(before.actors[0],{y:.05,vy:-3,grounded:false,leftGroundAt:.01,jumpStarted:.01});client.receiveSnapshot(before);
  const after=snapshot(3,.15);Object.assign(after.actors[0],{y:.08,vy:4,grounded:false,leftGroundAt:.135,jumpStarted:.135,landedAt:.115,landingSpeed:3.2});client.receiveSnapshot(after);
  game.time=.22;client['interpolate']();assert.equal(game.actors[1].grounded,true);assert.equal(game.actors[1].landedAt,.115);assert.equal(game.actors[1].jumpStarted,.01);
  game.time=.24;client['interpolate']();assert.equal(game.actors[1].grounded,false);assert.equal(game.actors[1].leftGroundAt,.135);assert.equal(game.actors[1].jumpStarted,.135);assert.equal(game.actors[1].landedAt,.115);
 }finally{client.disconnect();}
});
test('late snapshots never rewind the live clock or expose an unbuffered remote pose',async()=>{
 const {client,game,socket,setNow}=await fixture();
 try{
  setNow(100);const first=snapshot(2,.1);first.actors[0].x=10;first.actors[0].moving=4;client.receiveSnapshot(first);
  setNow(200);const second=snapshot(3,.2);second.actors[0].x=11;second.actors[0].moving=4;client.receiveSnapshot(second);
  setNow(240);client.present();assert.ok(Math.abs(game.actors[1].x-10.4)<1e-9);
  const beforeTime=game.time,beforeRemoteTime=client.remoteTime,beforeX=game.actors[1].x,inputCount=socket.messages.filter(m=>m.type==='input').length;
  const late=snapshot(4,.23);late.actors[0].x=11.3;late.actors[0].moving=4;late.actors[0].kills=3;late.actors[0].hp=80;
  client.receiveSnapshot(late);
  assert.ok(game.time>=beforeTime,'packet arrival must not reset the animation clock');
  assert.ok(client.remoteTime>=beforeRemoteTime);
  assert.ok(Math.abs(game.actors[1].x-beforeX)<1e-9,'socket callbacks must publish the buffered pose, not latest authority');
  assert.equal(game.actors[1].kills,3);assert.equal(game.actors[1].hp,80,'scores and damage still update immediately');
  assert.equal(game.history.at(-1)?.time,.23);assert.equal(game.history.at(-1)?.actors[1].x,11.3,'killcam history retains exact authority frames');
  setNow(247);client.present();const middle=game.actors[1].x;
  setNow(254);client.present();assert.ok(middle>beforeX&&game.actors[1].x>middle,'presentation advances on frames between fixed input ticks');
  assert.ok(game.time-beforeTime>.012&&game.time-beforeTime<.015,'clock correction is gradual');
  assert.equal(socket.messages.filter(m=>m.type==='input').length,inputCount,'render interpolation sends no extra inputs');
  const invalidTime=snapshot(5,.22);assert.equal(client.receiveSnapshot(invalidTime),false,'authority time may not run backwards');
 }finally{client.disconnect();}
});
test('remote reload progress and roster changes preserve the same delayed presentation timeline',async()=>{
 const {client,game,setNow}=await fixture();
 try{
  setNow(100);const first=snapshot(2,.1);Object.assign(first.actors[0],{x:10,reload:2,reloadTotal:3,cooldown:.5});client.receiveSnapshot(first);
  setNow(200);const next=snapshot(3,.2);Object.assign(next.actors[0],{x:11,reload:1.9,reloadTotal:3,cooldown:.4});client.receiveSnapshot(next);
  setNow(250);client.present();assert.ok(Math.abs(game.actors[1].reload-1.95)<1e-9);assert.ok(Math.abs(game.actors[1].cooldown-.45)<1e-9);
  const position=game.actors[1].x,clock=client.remoteTime;
  const newcomer=actor(3,'german'),joined=snapshot(4,.25,[newcomer,actor(42),actor(7,'german')]);Object.assign(joined.actors[2],{x:11.5,reload:1.85,reloadTotal:3,cooldown:.35});client.receiveSnapshot(joined);
  assert.equal(game.actors[2].name,'Player 7');assert.ok(Math.abs(game.actors[2].x-position)<1e-9,'joining players do not snap existing remote bodies to the latest packet');assert.equal(client.remoteTime,clock);
  setNow(1000);client.present();const frozen=client.remoteTime,pose=game.actors[2].x;setNow(2000);client.present();assert.equal(client.remoteTime,frozen);assert.equal(game.actors[2].x,pose,'packet gaps freeze the last remote pose instead of extrapolating through cover');
 }finally{client.disconnect();}
});

test('predicted melee cancels each rifle reload and replays unacknowledged cancellation without duplicate effects',async()=>{
 for(const faction of ['british','russian','german']as const){
  const {client,game,socket,setNow}=await fixture();
  try{
   game.damage=()=>{throw new Error('Reload cancellation must not predict damage');};
   const self=actor(42,faction);Object.assign(self,{ammo:1,reserve:17,reload:WEAPONS[faction].reload*.6,reloadTotal:WEAPONS[faction].reload});
   setNow(1000);client.receiveSnapshot(snapshot(2,1,[actor(7,'german'),self]));game.events=[];
   client.fire(true);setNow(1017);client.update(1/60,idle);
   const seq=socket.messages.findLast(m=>m.type==='input').seq,shot=game.events.find(event=>event.type==='shot')!.shot!;
   assert.equal(shot.kind,'melee');assert.equal(shot.hit,null);assert.equal(game.player.reload,0);assert.equal(game.player.reloadTotal,0);
   assert.equal(game.player.cooldown,MELEE_SECONDS);assert.equal(game.player.lastMeleeTime,game.time);
   assert.equal(game.player.ammo,1);assert.equal(game.player.reserve,17);assert.equal(game.actors[1].hp,100);
   // The authority has not consumed this input yet: reconciliation must
   // replay the cancellation as state, without replaying its sound/strike.
   setNow(1020);client.receiveSnapshot(snapshot(3,1.01,[actor(7,'german'),{...self,reload:self.reload-.01,ack:0}]));
   assert.equal(game.player.reload,0);assert.equal(game.player.reloadTotal,0);assert.equal(game.player.ammo,1);assert.equal(game.player.reserve,17);
   assert.equal(game.events.filter(event=>event.type==='shot').length,1);
   const accepted=snapshot(4,1.05,[actor(7,'german'),{...self,ack:seq,reload:0,reloadTotal:0,cooldown:MELEE_SECONDS-.033,lastMeleeTime:shot.time}]);
   accepted.events=[{type:'shot',actor:42,seq,shot:{...shot,actor:42,seq}}];
   setNow(1050);client.receiveSnapshot(accepted);
   assert.equal(game.events.filter(event=>event.type==='shot').length,1,'authoritative confirmation deduplicates the predicted strike');
   assert.equal(game.player.reload,0);assert.equal(game.player.ammo,1);assert.equal(game.player.reserve,17);
  }finally{client.disconnect();}
 }
});

test('coalesced online reload and melee inputs prioritize the strike and cannot reload over its recovery',async()=>{
 const {client,game,socket,setNow}=await fixture();
 try{
  game.player.ammo=3;game.player.reserve=17;game.events=[];
  client.reload();client.fire(true);setNow(17);client.update(1/60,idle);
  const command=socket.messages.findLast(m=>m.type==='input');assert.equal(command.reload,true);assert.equal(command.melee,true);
  assert.equal(game.player.reload,0);assert.equal(game.player.reloadTotal,0);assert.equal(game.player.ammo,3);assert.equal(game.player.reserve,17);
  assert.equal(game.events.filter(event=>event.type==='reload').length,0,'a same-tick cancelled reload has no provisional sound');
  assert.equal(game.events.filter(event=>event.type==='shot').length,1);assert.equal(game.events.find(event=>event.type==='shot')!.shot!.kind,'melee');
  client.reload();setNow(34);client.update(1/60,idle);
  assert.equal(game.player.reload,0);assert.equal(game.events.filter(event=>event.type==='reload').length,0,'R cannot hide an active melee animation');
 }finally{client.disconnect();}
});

test('prediction preserves reload when melee is blocked and preserves completed reload ammunition',async()=>{
 for(const blocked of ['cooldown','switching','crawling','rifle-fire']as const){
  const {client,game,setNow}=await fixture();
  try{
   const self=actor(42);Object.assign(self,{ammo:2,reserve:17,reload:2,reloadTotal:WEAPONS.british.reload});
   if(blocked==='cooldown')self.cooldown=.2;
   if(blocked==='switching')self.switchStarted=.9;
   if(blocked==='crawling'){self.stance='prone';self.eyeHeight=HEIGHTS.prone;}
   const ready=snapshot(2,1,[actor(7,'german'),self]);ready.roundNumber=2;
   setNow(1000);client.receiveSnapshot(ready);game.events=[];
   client.fire(blocked!=='rifle-fire');setNow(1017);client.update(1/60,blocked==='crawling'?{...idle,forward:1}:idle);
   assert.ok(Math.abs(game.player.reload-(2-1/60))<1e-9,blocked+' keeps loading');
   assert.equal(game.player.reloadTotal,WEAPONS.british.reload);assert.equal(game.player.ammo,2);assert.equal(game.player.reserve,17);
   assert.equal(game.events.some(event=>event.type==='shot'),false);assert.equal(game.player.lastMeleeTime,-1000);
  }finally{client.disconnect();}
 }
 const {client,game,setNow}=await fixture();
 try{
  Object.assign(game.player,{ammo:1,reserve:7,reload:.005,reloadTotal:WEAPONS.british.reload});
  client.fire(true);setNow(17);client.update(1/60,idle);
  assert.equal(game.player.ammo,8);assert.equal(game.player.reserve,0);assert.equal(game.player.reload,0);assert.equal(game.player.reloadTotal,0);
  assert.equal(game.events.find(event=>event.type==='shot')?.shot?.kind,'melee','a reload completed before this input is not rolled back');
 }finally{client.disconnect();}
});

test('coalesced R still begins loading when movement makes the requested melee ineligible',async()=>{
 const {client,game,setNow}=await fixture();
 try{
  game.player.ammo=2;game.player.reserve=17;client.toggleStance('prone');game.player.eyeHeight=HEIGHTS.prone;game.events=[];
  client.reload();client.fire(true);setNow(17);client.update(1/60,{...idle,forward:1});
  assert.ok(game.player.moving>.1);assert.ok(game.player.reload>0);assert.equal(game.player.lastMeleeTime,-1000);
  assert.equal(game.events.filter(event=>event.type==='reload').length,1);assert.equal(game.events.filter(event=>event.type==='shot').length,0);
  assert.equal(game.player.ammo,2);assert.equal(game.player.reserve,17);
 }finally{client.disconnect();}
});

test('a confirmed grenade bash kill retains the authoritative melee weapon label',async()=>{
 const {client,game,setNow}=await fixture();
 try{
  const killer=actor(42),victim=actor(7,'german');Object.assign(killer,{selectedWeapon:'grenade',switchFrom:'rifle',switchStarted:-1,kills:1});
  Object.assign(victim,{hp:0,alive:false,deaths:1,deadAt:1,deathHeadshot:false});
  const confirmed=snapshot(2,1,[victim,killer]);confirmed.events=[{type:'kill',actor:42,victim:7,weapon:'melee',headshot:false}];
  setNow(1000);client.receiveSnapshot(confirmed);
  assert.equal(game.player.selectedWeapon,'grenade');
  assert.deepEqual(game.events.find(event=>event.type==='kill'),{type:'kill',actor:0,victim:1,weapon:'melee',headshot:false,shot:undefined});
  assert.equal(game.player.kills,1);assert.equal(game.actors[1].deaths,1);
 }finally{client.disconnect();}
});


test('spectating is server-authoritative and suppresses all pending combat prediction',async()=>{
 const {client,game,socket,setNow}=await fixture();
 try{
  client.fire();client.reload();client.spectate();assert.equal(socket.messages.at(-1).type,'spectate');assert.equal(game.player.spectator,false,'request cannot manufacture authoritative mode');
  setNow(17);client.update(1/60,{...idle,forward:1,jump:true});let input=socket.messages.findLast(m=>m.type==='input');assert.equal(input.forward,0);assert.equal(input.fire,false);assert.equal(input.reload,false);
  const s=snapshot(2,.05);Object.assign(s.actors[1],{spectator:true,alive:false,hp:0,kills:4,deaths:2,ack:input.seq});client.receiveSnapshot(s);
  assert.equal(game.player.spectator,true);assert.equal(game.state,'playing');assert.equal(game.player.kills,4);assert.equal(game.player.deaths,2);
  const position={x:game.player.x,y:game.player.y,z:game.player.z};game.spectator.look(.7,.2);game.spectator.move(.1,{forward:1,right:1,up:1,fast:true});
  client.setADS(true);client.toggleStance('prone');client.selectWeapon('grenade');client.fire(true);client.reload();setNow(70);client.update(1/60,{...idle,forward:1,right:1,jump:true,lean:1});
  input=socket.messages.findLast(m=>m.type==='input');for(const field of ['forward','right','lean'])assert.equal(input[field],0);for(const field of ['fire','melee','reload','jump','ads'])assert.equal(input[field],false);
  assert.deepEqual({x:game.player.x,y:game.player.y,z:game.player.z},position);assert.equal(input.yaw,game.player.yaw);assert.notEqual(input.yaw,game.spectator.yaw);assert.ok(!game.events.some(e=>e.type==='shot'));
 }finally{client.disconnect();}
});

test('spectator follow remaps participants, skips departures and returns through normal loadout',async()=>{
 const {client,game,socket}=await fixture(true);
 try{
  assert.equal(socket.messages[1].spectator,true);assert.equal(game.player.spectator,true);assert.equal(game.viewedActor,null);
  game.spectator.cycle(game.actors,1);assert.equal(game.viewedActor?.name,'Player 7');
  const self=()=>Object.assign(actor(42),{spectator:true,alive:false,hp:0});
  client.receiveSnapshot(snapshot(2,.05,[actor(3),actor(7),self()]));assert.equal(game.spectator.targetId,2);assert.equal(game.viewedActor?.name,'Player 7');
  client.receiveSnapshot(snapshot(3,.1,[actor(3),self()]));assert.equal(game.viewedActor?.name,'Player 3');
  const next=snapshot(4,.15,[actor(3),self()]);next.roundNumber=2;client.receiveSnapshot(next);assert.equal(game.player.spectator,true);assert.equal(game.state,'playing');
  client.setFaction('german');assert.deepEqual(socket.messages.at(-1),{type:'loadout',faction:'german'});assert.equal(game.player.spectator,true,'only the server can return the player to combat');
  const joined=snapshot(5,.2,[actor(3),actor(42,'german')]);joined.roundNumber=2;joined.events=[{type:'spawn',actor:42}];client.receiveSnapshot(joined);
  assert.equal(game.player.spectator,false);assert.equal(game.player.alive,true);assert.equal(game.spectator.targetId,null);assert.equal(game.viewedActor,game.player);assert.equal(game.state,'playing');
 }finally{client.disconnect();}
});
