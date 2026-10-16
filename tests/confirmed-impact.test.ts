import test from 'node:test';
import {decodeInput} from '../src/networkCodec.ts';
import assert from 'node:assert/strict';
import {Game,createActor,type Shot} from '../src/engine.ts';
import {NetworkClient,type SocketLike,type WireActor,type WireEvent,type WireSnapshot} from '../src/network.ts';

const idle={forward:0,right:0,jump:false,walk:false,lean:0};
function actor(id:number):WireActor{
 const {ai,...body}=createActor(id,'british',`Player ${id}`);
 const value={...body,x:13.5,z:id===42?0:1,ack:0,hipSpread:.08,spawnGeneration:1};
 for(const [key,number] of Object.entries(value))if(typeof number==='number'&&!Number.isFinite(number))(value as any)[key]=-1000;
 return value;
}
function snapshot(tick:number,events:WireEvent[]=[]):WireSnapshot{
 return{type:'snapshot',inputTiming:'tick-v2',tick,time:tick/60,remaining:300-tick/60,roundNumber:1,ended:false,winner:null,actors:[actor(7),actor(42)],events};
}
class Socket implements SocketLike{
 readyState=0;onopen:SocketLike['onopen']=null;onmessage:SocketLike['onmessage']=null;onerror:SocketLike['onerror']=null;onclose:SocketLike['onclose']=null;messages:any[]=[];
 send(raw:string|ArrayBuffer|ArrayBufferView<ArrayBuffer>){this.messages.push(typeof raw==='string'?JSON.parse(raw):decodeInput(raw));}close(){this.readyState=3;}
 receive(value:unknown){this.onmessage?.({data:JSON.stringify(value)});}
}
async function fixture(){
 const game=new Game(),socket=new Socket(),impacts:Shot[]=[];let now=0;
 const client=new NetworkClient(game,{origin:'https://impact.example.test',now:()=>now,storage:{getItem:()=>null,setItem:()=>{},removeItem:()=>{}},fetch:async()=>new Response(JSON.stringify({token:'test-only-session-with-twenty-characters'})),socket:()=>socket});
 client.onImpact=shot=>impacts.push(shot);
 const joining=client.join(undefined,'Local','british');await new Promise(resolve=>setImmediate(resolve));
 socket.readyState=1;socket.onopen?.({});socket.receive({type:'welcome',version:3});socket.receive({type:'joined',cueSeq:0,actorId:42,lobbyId:'impacts',lobbyName:'Impacts',snapshot:snapshot(0)});await joining;
 return{game,client,socket,impacts,setNow:(value:number)=>{now=value;}};
}
function confirmed(kind:Shot['kind'],seq:number,hit:number|null=7,source=42):WireEvent{
 return{type:'shot',actor:source,seq,shot:{time:1/60,actor:source,origin:{x:13.5,y:1.65,z:0},end:{x:13.5,y:1.65,z:1},kind,hit,headshot:false}};
}

for(const kind of ['shot','melee']as const)test(`a predicted ${kind} gets one confirmed impact without replaying the attack`,async()=>{
 const {client,game,socket,impacts,setNow}=await fixture();
 try{
  client.fire(kind==='melee');setNow(17);client.update(1/60,idle);
  const command=socket.messages.findLast(message=>message.type==='input');assert.ok(command);
  const attacks=game.events.filter(event=>event.type==='shot');assert.equal(attacks.length,1);assert.equal(attacks[0].shot?.kind,kind);assert.equal(attacks[0].shot?.hit,null);assert.equal(impacts.length,0);
  game.events=[];const frame=snapshot(command.tick,[confirmed(kind,command.seq)]);frame.actors[1].ack=command.seq;
  assert.equal(client.receiveSnapshot(frame),true);assert.equal(impacts.length,1);assert.equal(impacts[0].actor,0);assert.equal(impacts[0].hit,1);assert.equal(impacts[0].kind,kind);assert.deepEqual(impacts[0].end,{x:13.5,y:1.65,z:1});
  assert.equal(game.events.filter(event=>event.type==='shot').length,0,'confirmation cannot replay muzzle/report/recoil');
  assert.equal(client.receiveSnapshot(frame),false,'duplicate authority frame is ignored');assert.equal(impacts.length,1);
  assert.equal(client.receiveSnapshot(snapshot(command.tick+1)),true);assert.equal(impacts.length,1,'a subsequent snapshot does not replay contact');
 }finally{client.disconnect();}
});

for(const hit of [null,999]as const)test(`a predicted attack with ${hit===null?'a miss':'an unmapped target'} has no confirmed hit feedback`,async()=>{
 const {client,game,socket,impacts,setNow}=await fixture();
 try{
  client.fire();setNow(17);client.update(1/60,idle);const command=socket.messages.findLast(message=>message.type==='input');
  game.events=[];const frame=snapshot(command.tick,[confirmed('shot',command.seq,hit)]);frame.actors[1].ack=command.seq;
  assert.equal(client.receiveSnapshot(frame),true);assert.equal(impacts.length,0);assert.equal(game.events.filter(event=>event.type==='shot').length,0);
 }finally{client.disconnect();}
});

for(const source of [7,42])test(`${source===42?'unpredicted local':'remote'} hits retain their ordinary shot event without a separate impact`,async()=>{
 const {client,game,impacts}=await fixture();
 try{
  assert.equal(client.receiveSnapshot(snapshot(3,[confirmed('shot',9,source===42?7:42,source)])),true);
  assert.equal(impacts.length,0);const attacks=game.events.filter(event=>event.type==='shot');assert.equal(attacks.length,1);assert.equal(attacks[0].shot?.actor,source===42?0:1);assert.equal(attacks[0].shot?.hit,source===42?1:0);
 }finally{client.disconnect();}
});
