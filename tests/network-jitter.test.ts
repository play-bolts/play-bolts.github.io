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
 let now=rtt/2;const game=new Game(),socket=new Socket(),self=actor();self.ping=rtt;
 const client=new NetworkClient(game,{origin:'https://timing.example.test',now:()=>now,storage:{getItem:()=>null,setItem:()=>{},removeItem:()=>{}},fetch:async()=>new Response(JSON.stringify({token:'test-only-session-with-twenty-characters'})),socket:()=>socket});
 const joining=client.join(undefined,'Timing','british');await new Promise(resolve=>setImmediate(resolve));
 socket.readyState=1;socket.onopen?.({});socket.receive({type:'welcome',version:2});socket.receive({type:'joined',actorId:42,lobbyId:'timing',lobbyName:'Timing',snapshot:snapshot(0,[self])});await joining;
 return{game,client,socket,setNow:(value:number)=>{now=value;}};
}


async function remoteScenario(burst:number){
 const {game,client,socket,setNow}=await fixture(50);let now=0,eventId=0,lastDown=-Infinity,previous=0,prev:any=null;const events:{at:number;id:number;fn:()=>void}[]=[],deltas:number[]=[];
 const schedule=(at:number,fn:()=>void)=>events.push({at,id:eventId++,fn});
 for(let tick=3;tick<=108;tick+=3){const sent=tick*MS;const arrival=Math.max(lastDown+.000001,sent+25+(sent>=400&&sent<550?burst:0));lastDown=arrival;schedule(arrival,()=>{const peer=actor(7);peer.x=-13.5;peer.z=-5+4.8*tick*STEP;peer.moving=4.8;socket.receive(snapshot(tick,[{...actor(),ping:50},peer]));});}
 for(let n=1;n<=108;n++)schedule(25+n*MS,()=>{client.update(STEP,idle);client.present(0);const p=game.actors[1];if(p&&prev&&now>300&&now<1700)deltas.push(p.z-prev.z);if(p)prev={z:p.z};});
 while(events.length){events.sort((a,b)=>a.at-b.at||a.id-b.id);const e=events.shift()!;now=e.at;setNow(now);e.fn();}
 client.disconnect();return{burst,minDelta:Math.min(...deltas),maxDelta:Math.max(...deltas),frozenFrames:deltas.filter(d=>Math.abs(d)<1e-9).length,frames:deltas.length};
}
for(const burst of [0,50,100,150,250,400])test(`ordered ${burst}ms snapshot bursts never become a one-frame remote jump`,async(t)=>{
 const result=await remoteScenario(burst);
 t.diagnostic(JSON.stringify(result));
 assert.ok(result.minDelta>=-1e-8,'remote movement never reverses');
 assert.ok(result.maxDelta<=4.8/60*1.1+1e-8,`maximum remote step ${result.maxDelta}m`);
});

/** Deterministic event scheduler. The server scheduling rule is also tested
 * against the actual Rust Simulation in input_timing_tests.rs. Both sides use
 * map collision here; shared movement fixtures check TS/Rust physics parity. */
async function simulate(fps:number,rtt:number,jitter:number,hitch=false, burst=0, rttAfter=0, estimateAfter=0, stallStart=350, stallEnd=490, joinTransit=true, stallBlocksReceives=false,feedback=true){
 const {game,client,socket,setNow}=await fixture(rtt),authority=new Game();
 authority.state='playing';authority.actors=[Object.assign(createActor(42,'british','Authority'),actor())];
 let tick=0,ack=0,now=0,eventId=0,lastUp=-Infinity,lastDown=-Infinity,accumulator=0,previous=joinTransit?rtt/2:0,stopped:ReturnType<typeof position>|undefined;
 let rejected=0,emptyMoving=0,received=0,missing=0,arrivalLead=0,started=false,oldView:any=null,maxFrameGapMs=0;const cameraDeltas:number[]=[];const inputs=new Map<number,NetworkInput>(),events:{at:number;id:number;fn:()=>void}[]=[],corrections:number[]=[],samples:number[]=[],commands:NetworkInput[]=[];
 const schedule=(at:number,fn:()=>void)=>events.push({at,id:eventId++,fn});
 socket.onSend=message=>{
  if(message.type!=='input')return;const command=message as NetworkInput;commands.push(command);
  const offsets=[0,1,-1,.5,-.5,.8,-.8],arrival=Math.max(lastUp+.000001,now+Math.max(0,(now>=400&&rttAfter?rttAfter:rtt)/2+jitter*offsets[command.seq%offsets.length])+(now>400&&now<500?burst:0));lastUp=arrival;
  schedule(arrival,()=>{received++;arrivalLead=command.tick!-tick;if(command.tick!>tick&&command.tick!<=tick+30&&command.generation===1)inputs.set(command.tick!,command);else rejected++;});
 };
 for(let n=1;n<=108;n++)schedule(n*MS,()=>{
  tick++;authority.time=tick*STEP;
  const command=inputs.get(tick);inputs.delete(tick);if(command)started=true;else if(started)missing++;if(!command&&tick*MS>=200&&tick*MS<900)emptyMoving++;
  const p=authority.player,forward=command?.forward??0,right=command?.right??0,length=Math.max(1,Math.hypot(forward,right));
  if(command){ack=command.seq;p.yaw=command.yaw;p.pitch=command.pitch;p.stance=command.stance;p.ads=command.ads;}
  const f=forward/length,r=right/length,walk=command?.walk?.55:1;
  authority.move(p,(Math.sin(p.yaw)*f-Math.cos(p.yaw)*r)*walk,(Math.cos(p.yaw)*f+Math.sin(p.yaw)*r)*walk,STEP,command?.jump??false);
  if(tick%3===0){
   const s=snapshot(tick,[{...p,ack,hipSpread:.08,spawnGeneration:1,ping:now>=400&&estimateAfter?estimateAfter:rtt,...(feedback?{inputTiming:{received,late:rejected,missing,arrivalLead}}:{})}]);
   const downJitter=jitter*[0,.4,-.4,1,-1][Math.floor(tick/3)%5];
   let arrival=Math.max(lastDown+.000001,now+Math.max(0,(now>=400&&rttAfter?rttAfter:rtt)/2+downJitter));if(hitch&&stallBlocksReceives&&arrival>stallStart+(joinTransit?rtt/2:0)&&arrival<stallEnd+(joinTransit?rtt/2:0))arrival=stallEnd+(joinTransit?rtt/2:0);lastDown=arrival;
   schedule(arrival,()=>{const before=position(game.player);socket.receive(s);corrections.push(distance(before,game.player));});
  }
 });
 for(let n=1;n<=Math.ceil(1800/(1000/fps));n++){
  const at=(joinTransit?rtt/2:0)+n*1000/fps;if(hitch&&at>stallStart+(joinTransit?rtt/2:0)+1e-7&&at<stallEnd+(joinTransit?rtt/2:0)-1e-7)continue;
  schedule(at,()=>{
   maxFrameGapMs=Math.max(maxFrameGapMs,now-previous);accumulator+=Math.min((now-previous)/1000,.075);previous=now;
   const moving=now>=100-1e-7&&now<900-1e-7,input={...idle,forward:moving?1:0};
   while(accumulator+1e-10>=STEP){
    const before=position(game.player);client.update(STEP,input);accumulator-=STEP;
    if(!moving&&now>=900-1e-7){stopped??=position(game.player);}
   }
   client.present(Math.max(0,accumulator/STEP));const view=client.localPosition;if(oldView&&now>200&&now<850)cameraDeltas.push(view!.z-oldView.z);oldView=view&&{...view};if(stopped)samples.push(distance(stopped,game.player));
  });
 }
 while(events.length){events.sort((a,b)=>a.at-b.at||a.id-b.id);const event=events.shift()!;now=event.at;setNow(now);event.fn();}
 const diagnostics=client.diagnostics;client.disconnect();
 assert.ok(commands.length>60);for(let i=1;i<commands.length;i++)assert.ok(commands[i].tick!>commands[i-1].tick!);
 assert.ok(distance(game.player,authority.player)<1e-8,'client converges to the authoritative final position');

 const shotAges=commands.filter(c=>c.tick!*STEP>.4&&c.tick!*STEP<1.4).map(c=>(c.tick!*STEP-c.shotTime)*1000).sort((a,b)=>a-b);
 return{diagnostics,feedback,joinTransit,stallBlocksReceives,maxFrameGapMs,shotAgeMs:{min:shotAges[0],median:shotAges[Math.floor(shotAges.length/2)],max:shotAges.at(-1),over200:shotAges.filter(x=>x>200+1e-8).length,total:shotAges.length},fps,rtt,jitter,hitch,burst,rttAfter,estimateAfter,stallStart,stallEnd,rejected,emptyMoving,commandGaps:commands.slice(1).reduce((n,c,i)=>n+Math.max(0,c.tick!-commands[i].tick!-1),0),maxCameraBackwards:Math.max(0,-Math.min(...cameraDeltas)),maxCameraForward:Math.max(...cameraDeltas),maxCorrection:Math.max(...corrections),correctionsOver1cm:corrections.filter(x=>x>.01).length,displacement:game.player.z+5};
}


for(const rtt of [50,120,150])test(`realistic snapshot transit at ${rtt}ms RTT needs no movement corrections`,async()=>{
 const result=await simulate(60,rtt,0);assert.equal(result.rejected,0);assert.ok(result.maxCorrection<1e-8);assert.equal(result.diagnostics.inputLeadTicks,2);
});
for(const after of [100,150,250])test(`authority feedback reduces late inputs after RTT rises from 50 to ${after}ms`,async(t)=>{
 const baseline=await simulate(60,50,9,false,0,after,50,350,490,true,false,false);
 const adaptive=await simulate(60,50,9,false,0,after,50);
 t.diagnostic(JSON.stringify({rttAfter:after,baselineLate:baseline.rejected,adaptiveLate:adaptive.rejected,lead:adaptive.diagnostics.inputLeadTicks,maxCorrection:adaptive.maxCorrection,maxCameraBackwards:adaptive.maxCameraBackwards}));
 assert.ok(adaptive.rejected<baseline.rejected,`late inputs adaptive=${adaptive.rejected}, baseline=${baseline.rejected}`);
 assert.ok(adaptive.diagnostics.inputLeadTicks>=2&&adaptive.diagnostics.inputLeadTicks<=8);
 assert.ok(adaptive.displacement>=baseline.displacement-1e-8,'avoiding expired input restores movement instead of exceeding the server budget');
});
