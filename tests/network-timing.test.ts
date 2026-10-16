import test from 'node:test';
import assert from 'node:assert/strict';
import {Game,createActor,type Input} from '../src/engine.ts';
import {NetworkClient,type NetworkInput,type SocketLike,type WireActor,type WireSnapshot} from '../src/network.ts';

const STEP=1/60,MS=1000/60,idle:Input={forward:0,right:0,jump:false,walk:false,lean:0};
const position=(p:{x:number;y:number;z:number})=>({x:p.x,y:p.y,z:p.z});
const distance=(a:{x:number;y:number;z:number},b:{x:number;y:number;z:number})=>Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z);
const clone=<T>(value:T):T=>JSON.parse(JSON.stringify(value));
function actor(id=42):WireActor{
 const {ai,...body}=createActor(id,'british',`Player ${id}`);
 const result={...body,x:13.5,z:-5,yaw:0,ack:0,hipSpread:.08,spawnGeneration:1};
 for(const [key,value] of Object.entries(result))if(typeof value==='number'&&!Number.isFinite(value))(result as any)[key]=-1000;
 return result;
}
function snapshot(tick:number,actors:WireActor[]):WireSnapshot{return{type:'snapshot',inputTiming:'tick-v2',tick,time:tick*STEP,remaining:300-tick*STEP,roundNumber:1,ended:false,winner:null,actors:clone(actors),events:[]};}
class Socket implements SocketLike{
 readyState=0;onopen:SocketLike['onopen']=null;onmessage:SocketLike['onmessage']=null;onerror:SocketLike['onerror']=null;onclose:SocketLike['onclose']=null;
 messages:any[]=[];onSend=(message:any)=>{};
 send(raw:string){const message=JSON.parse(raw);this.messages.push(message);this.onSend(message);}
 close(){this.readyState=3;}
 receive(message:unknown){this.onmessage?.({data:JSON.stringify(message)});}
}
async function fixture(rtt=50){
 let now=0;const game=new Game(),socket=new Socket(),self=actor();self.ping=rtt;
 const client=new NetworkClient(game,{origin:'https://timing.example.test',now:()=>now,storage:{getItem:()=>null,setItem:()=>{},removeItem:()=>{}},fetch:async()=>new Response(JSON.stringify({token:'test-only-session-with-twenty-characters'})),socket:()=>socket});
 const joining=client.join(undefined,'Timing','british');await new Promise(resolve=>setImmediate(resolve));
 socket.readyState=1;socket.onopen?.({});socket.receive({type:'welcome',version:2});socket.receive({type:'joined',actorId:42,lobbyId:'timing',lobbyName:'Timing',snapshot:snapshot(0,[self])});await joining;
 return{game,client,socket,setNow:(value:number)=>{now=value;}};
}

/** Deterministic event scheduler. The server scheduling rule is also tested
 * against the actual Rust Simulation in input_timing_tests.rs. Both sides use
 * map collision here; shared movement fixtures check TS/Rust physics parity. */
async function simulate(fps:number,rtt:number,jitter:number,hitch=false){
 const {game,client,socket,setNow}=await fixture(rtt),authority=new Game();
 authority.state='playing';authority.actors=[Object.assign(createActor(42,'british','Authority'),actor())];
 let tick=0,ack=0,now=0,eventId=0,lastUp=-Infinity,lastDown=-Infinity,accumulator=0,previous=0,stopped:ReturnType<typeof position>|undefined;
 const inputs=new Map<number,NetworkInput>(),events:{at:number;id:number;fn:()=>void}[]=[],corrections:number[]=[],samples:number[]=[],commands:NetworkInput[]=[];
 const schedule=(at:number,fn:()=>void)=>events.push({at,id:eventId++,fn});
 socket.onSend=message=>{
  if(message.type!=='input')return;const command=message as NetworkInput;commands.push(command);
  const offsets=[0,1,-1,.5,-.5,.8,-.8],arrival=Math.max(lastUp+.000001,now+Math.max(0,rtt/2+jitter*offsets[command.seq%offsets.length]));lastUp=arrival;
  schedule(arrival,()=>{if(command.tick!>tick&&command.tick!<=tick+30&&command.generation===1)inputs.set(command.tick!,command);});
 };
 for(let n=1;n<=108;n++)schedule(n*MS,()=>{
  tick++;authority.time=tick*STEP;
  const command=inputs.get(tick);inputs.delete(tick);
  const p=authority.player,forward=command?.forward??0,right=command?.right??0,length=Math.max(1,Math.hypot(forward,right));
  if(command){ack=command.seq;p.yaw=command.yaw;p.pitch=command.pitch;p.stance=command.stance;p.ads=command.ads;}
  const f=forward/length,r=right/length,walk=command?.walk?.55:1;
  authority.move(p,(Math.sin(p.yaw)*f-Math.cos(p.yaw)*r)*walk,(Math.cos(p.yaw)*f+Math.sin(p.yaw)*r)*walk,STEP,command?.jump??false);
  if(tick%3===0){
   const s=snapshot(tick,[{...p,ack,hipSpread:.08,spawnGeneration:1,ping:rtt}]);
   const downJitter=jitter*[0,.4,-.4,1,-1][Math.floor(tick/3)%5];
   const arrival=Math.max(lastDown+.000001,now+Math.max(0,rtt/2+downJitter));lastDown=arrival;
   schedule(arrival,()=>{const before=position(game.player);socket.receive(s);corrections.push(distance(before,game.player));});
  }
 });
 for(let n=1;n<=Math.ceil(1800/(1000/fps));n++){
  const at=n*1000/fps;if(hitch&&at>350&&at<490)continue;
  schedule(at,()=>{
   accumulator+=Math.min((now-previous)/1000,.075);previous=now;
   const moving=now>=100-1e-7&&now<900-1e-7,input={...idle,forward:moving?1:0};
   while(accumulator+1e-10>=STEP){
    const before=position(game.player);client.update(STEP,input);accumulator-=STEP;
    if(!moving&&now>=900-1e-7){assert.ok(distance(before,game.player)<1e-9,'a neutral command causes no horizontal coasting');stopped??=position(game.player);}
   }
   client.present(Math.max(0,accumulator/STEP));if(stopped)samples.push(distance(stopped,game.player));
  });
 }
 while(events.length){events.sort((a,b)=>a.at-b.at||a.id-b.id);const event=events.shift()!;now=event.at;setNow(now);event.fn();}
 client.disconnect();
 assert.ok(commands.length>60);for(let i=1;i<commands.length;i++)assert.ok(commands[i].tick!>commands[i-1].tick!);
 assert.ok(distance(game.player,authority.player)<1e-8,'client converges to the authoritative final position');
 if(!hitch){assert.ok(Math.max(...corrections)<1e-8,`unexpected correction ${Math.max(...corrections)}m`);assert.ok(Math.max(...samples)<1e-8,'no snapshot moves the player after release');}
 return{corrections,commands};
}

for(const fps of [30,60,144])for(const rtt of [0,50,150])for(const jitter of [0,9]){
 test(`tick prediction stays exact through movement and release at ${fps} FPS, ${rtt}ms RTT, ±${jitter}ms jitter`,async()=>{await simulate(fps,rtt,jitter);});
}
test('a long rendering stall re-establishes input lead and converges without continuing after release',async()=>{await simulate(60,50,9,true);});
test('input lead accounts for high RTT without confusing it with the server queue bound',async()=>{await simulate(60,500,9);});
test('catch-up commands have distinct simulation times even when sampled in the same rendered frame',async()=>{
 const {client,game,socket,setNow}=await fixture();
 try{setNow(34);client.update(STEP,{...idle,forward:1});const time=game.time;client.update(STEP,{...idle,forward:1});const commands=socket.messages.filter(m=>m.type==='input');assert.equal(commands[1].tick,commands[0].tick+1);assert.ok(Math.abs(game.time-time-STEP)<1e-10);}
 finally{client.disconnect();}
});
test('excess updates cannot grow the input buffer toward the server safety limit',async()=>{
 const {client,game,socket,setNow}=await fixture();
 try{
  setNow(17);for(let n=0;n<90;n++)client.update(STEP,{...idle,forward:1});
  const commands=socket.messages.filter(m=>m.type==='input');
  assert.ok(commands.at(-1).tick<=Math.ceil((17+50)/MS)+6,'at most six buffered ticks beyond estimated arrival');
  const stopped=position(game.player);client.update(STEP,idle);assert.deepEqual(position(game.player),stopped);
  setNow(117);client.update(STEP,idle);assert.ok(socket.messages.filter(m=>m.type==='input').length>commands.length,'sending resumes as server time catches up');
 }finally{client.disconnect();}
});
test('another actor joining preserves unacknowledged movement and current look direction',async()=>{
 const {client,game,socket,setNow}=await fixture();
 try{
  for(let n=1;n<=3;n++){setNow(n*MS);client.update(STEP,{...idle,forward:1});}
  const commands=socket.messages.filter(m=>m.type==='input'),self=actor();self.ack=commands[0].seq;self.z+=.08;self.ping=50;
  const peer=actor(7);peer.x=-13.5;const before=position(game.player);game.player.yaw=.7;game.player.pitch=.2;
  socket.receive(snapshot(commands[0].tick,[self,peer]));
  assert.ok(distance(before,game.player)<1e-9);assert.equal(game.player.yaw,.7);assert.equal(game.player.pitch,.2);
  peer.faction='german';socket.receive(snapshot(commands[0].tick+1,[{...self,z:self.z+.08,ack:commands[1].seq},peer]));
  assert.ok(distance(before,game.player)<1e-9,'a remote loadout change also preserves local pending movement');
 }finally{client.disconnect();}
});
test('a new spawn generation resets prediction, camera smoothing and old look intent',async()=>{
 const {client,game,socket,setNow}=await fixture();
 try{
  setNow(17);client.update(STEP,{...idle,forward:1});client.present(.5);
  const self=actor();Object.assign(self,{spawnGeneration:2,x:-13.5,z:5,yaw:1,ping:50});socket.receive(snapshot(3,[self]));client.present(.5);
  assert.equal(game.player.x,-13.5);assert.equal(game.player.z,5);assert.equal(game.player.yaw,1);assert.deepEqual(client.localPosition,{x:-13.5,y:0,z:5});
  setNow(67);client.update(STEP,idle);assert.equal(socket.messages.findLast(m=>m.type==='input').generation,2);
 }finally{client.disconnect();}
});
test('legacy acknowledgements are not used to discard commands for future simulation ticks',async()=>{
 const {client,game,socket,setNow}=await fixture();
 try{
  setNow(17);client.update(STEP,{...idle,forward:1});const input=socket.messages.findLast(m=>m.type==='input'),before=position(game.player);
  const self=actor();self.ack=input.seq;self.ping=50;socket.receive(snapshot(input.tick-1,[self]));
  assert.ok(distance(game.player,before)<1e-9,'the snapshot tick, not a last-received sequence, defines the replay boundary');
 }finally{client.disconnect();}
});

for(const skip of [false,true])test(`${skip?'skipped':'finished'} short killcam stays in the death view until an authoritative respawn`,async()=>{
 const {client,game,socket,setNow}=await fixture();
 try{
  const self=actor(),peer=actor(7);peer.x=-13.5;
  setNow(50);client.receiveSnapshot(snapshot(3,[self,peer]));
  Object.assign(self,{alive:false,hp:0,deadAt:.1,deaths:1});const death=snapshot(6,[self,peer]);death.events=[{type:'shot',actor:7,shot:{time:.075,actor:7,origin:{x:peer.x,y:1.65,z:peer.z},end:{x:self.x,y:1.65,z:self.z},kind:'shot',hit:42,headshot:true}},{type:'kill',actor:7,victim:42}];
  setNow(100);client.receiveSnapshot(death);assert.equal(game.state,'killcam');assert.equal(game.killer,1);
  const recording=structuredClone(game.replay);assert.equal(game.replayShots.length,1);
  if(skip){client.skipReplay();assert.equal(game.replayShots.length,0,'seeking past the replay must not play all skipped shots at once');}
  for(let n=1;n<=175;n++){
   setNow(100+n*MS);
   if(n%3===0)client.receiveSnapshot(snapshot(6+n,[self,{...peer,z:peer.z+n*.01}]));
   client.fire();client.update(STEP,{...idle,forward:1,jump:true});client.present(.5);
   assert.equal(game.state,'killcam','never expose a dead player as normal gameplay');assert.equal(game.player.alive,false);assert.equal(client.localPosition,null);
   const input=socket.messages.findLast(m=>m.type==='input');assert.equal(input.forward,0);assert.equal(input.jump,false);assert.equal(input.fire,false);
  }
  assert.equal(client.waitingForRespawn,true);assert.equal(game.replayTime,game.replayEnd+.65);assert.deepEqual(game.replay,recording,'the held camera remains on the recorded killer');
  const spawned={...actor(),spawnGeneration:2,z:5,deaths:1},respawn=snapshot(186,[spawned,peer]);
  if(skip)respawn.events=[{type:'spawn',actor:42}];
  setNow(3100);client.receiveSnapshot(respawn);
  assert.equal(game.state,'playing');assert.equal(client.waitingForRespawn,false);assert.equal(game.replay.length,0);assert.equal(game.player.z,5);
  setNow(3100+MS);client.update(STEP,{...idle,forward:1});assert.ok(game.player.z>5,'movement resumes immediately with the authoritative life');
  assert.equal(socket.messages.findLast(m=>m.type==='input').generation,2);
 }finally{client.disconnect();}
});
test('missing death history and roster changes keep a waiting view, and spectator entry clears it',async()=>{
 const {client,game,setNow}=await fixture();
 try{
  const self={...actor(),alive:false,hp:0,deadAt:.1};
  setNow(100);client.receiveSnapshot(snapshot(6,[self]));assert.equal(game.state,'killcam');assert.equal(client.waitingForRespawn,true);assert.equal(game.replayFrame()!.actors[0].alive,false);
  setNow(150);client.receiveSnapshot(snapshot(9,[self,actor(7)]));assert.equal(game.state,'killcam');assert.equal(client.waitingForRespawn,true);
  setNow(200);client.receiveSnapshot(snapshot(12,[{...self,spectator:true,spawnGeneration:2},actor(7)]));assert.equal(game.state,'playing');assert.equal(client.waitingForRespawn,false);assert.equal(game.replay.length,0);
 }finally{client.disconnect();}
});
test('respawning while paused clears the old replay before resuming gameplay',async()=>{
 const {client,game,setNow}=await fixture();
 try{
  setNow(100);client.receiveSnapshot(snapshot(6,[{...actor(),alive:false,hp:0,deadAt:.1}]));
  client.setPaused(true);assert.equal(game.state,'paused');
  setNow(3100);client.receiveSnapshot(snapshot(186,[{...actor(),spawnGeneration:2}]));assert.equal(game.state,'paused');assert.equal(client.waitingForRespawn,false);
  client.setPaused(false);assert.equal(game.state,'playing');assert.equal(game.player.alive,true);
 }finally{client.disconnect();}
});
