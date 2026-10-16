/** Isolated protocol-3 transport benchmark, using real NetworkClient adapters.
 * Build a current Rust binary, then run with loopback bind permission:
 * BOLTS_BENCH_BINARY=/path/to/bolts-server node --import tsx scripts/measure-transport.ts [20]
 * Never contacts deployed endpoints. Outputs: temp/transport-audit-v3/.
 */
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createServer} from 'node:net';
import {mkdir,mkdtemp,readFile,rm,writeFile,copyFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Game,type Input} from '../src/engine.ts';
import {NetworkClient} from '../src/network.ts';
import {decodeMessage,decodeInput} from '../src/networkCodec.ts';
import actorFields from '../shared/actor-fields.json';

const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const output=join(root,'temp/transport-audit-v3');
const binary=resolve(process.env.BOLTS_BENCH_BINARY??join(root,'server/target/debug/bolts-server'));
const duration=Number(process.argv[2]??20);
assert.ok(Number.isFinite(duration)&&duration>=5&&duration<=120);
if(process.env.BOLTS_TEST_URL)throw new Error('Only isolated loopback servers are allowed; unset BOLTS_TEST_URL.');
const delay=(ms:number)=>new Promise(done=>setTimeout(done,ms));
const jsonBytes=(value:unknown)=>Buffer.byteLength(JSON.stringify(value));
const summary=(values:number[])=>{
 const sorted=[...values].sort((a,b)=>a-b),total=values.reduce((sum,value)=>sum+value,0);
 return{count:values.length,total,mean:total/Math.max(1,values.length),p50:sorted[Math.floor((sorted.length-1)*.5)]??0,p95:sorted[Math.floor((sorted.length-1)*.95)]??0,min:sorted[0]??0,max:sorted.at(-1)??0};
};
/** Reconstruct the previous transport of precisely the same logical state.
 * No movement quantization, hypothetical compression, or baseline deltas.
 */
function previousJSON(message:any){
 if(message.type==='input')return message;
 if(message.type==='snapshot')return{...message,actorEncoding:'tuple-v1',actors:message.actors.map((actor:any)=>actorFields.map(field=>actor[field]??null))};
 return message;
}
type Raw={direction:'up'|'down';client:number;wire:string|Buffer;at:number};
type Sample={direction:'up'|'down';client:number;type:string;at:number;bytes:number;framedBytes:number;sameStateV2JSONBytes:number;binary:boolean;events:number;actorCount?:number};
type SnapshotArrival={atMs:number;tick:number;time:number};
let backend:ReturnType<typeof spawn>|undefined,timer:ReturnType<typeof setInterval>|undefined,temporary='',base='',serverOutput='';
let measuring=false,scenarioStart=0,rawRecords:Raw[]=[];
let stallCapture:SnapshotArrival[]|undefined,stallEpoch=0;
const users:ReturnType<typeof user>[]=[];
function decode(wire:string|Buffer,direction:'up'|'down'):any{
 return typeof wire==='string'?decodeMessage(wire):direction==='up'?decodeInput(wire):decodeMessage(wire);
}
function copyWire(data:any):string|Buffer{
 if(typeof data==='string')return data;
 if(data instanceof ArrayBuffer)return Buffer.from(new Uint8Array(data));
 if(ArrayBuffer.isView(data))return Buffer.from(new Uint8Array(data.buffer,data.byteOffset,data.byteLength));
 throw new Error('Expected text or binary websocket payload');
}
function record(direction:'up'|'down',client:number,wire:string|Buffer,message?:any){
 const now=performance.now();
 if(stallCapture&&direction==='down'&&client===0&&message?.type==='snapshot')stallCapture.push({atMs:now-stallEpoch,tick:message.tick,time:message.time});
 if(measuring)rawRecords.push({direction,client,wire,at:now-scenarioStart});
}
function user(index:number){
 const game=new Game(),storage=new Map<string,string>();let actorId=-1,lastSnapshot:any;
 const network=new NetworkClient(game,{origin:base,storage:{getItem:key=>storage.get(key)??null,setItem:(key,value)=>void storage.set(key,value),removeItem:key=>void storage.delete(key)},socket:url=>{
  const socket=new WebSocket(url),send=socket.send.bind(socket);socket.binaryType='arraybuffer';
  socket.send=data=>{record('up',index,copyWire(data));send(data);};
  socket.addEventListener('message',({data})=>{
   const wire=copyWire(data),message=decode(wire,'down');
   if(message.type==='joined'){actorId=message.actorId;lastSnapshot=message.snapshot;}
   if(message.type==='snapshot')lastSnapshot=message;
   record('down',index,wire,message);
  });return socket;
 }});
 const failures:string[]=[];network.onFailure=message=>failures.push(message);
 return{game,network,failures,index,lastFire:-1,lastReload:-1,lastStance:-1,lastJump:-1,get actorId(){return actorId;},get snapshot(){return lastSnapshot;}};
}
async function until(predicate:()=>Promise<boolean>|boolean,label:string){const end=Date.now()+10000;while(Date.now()<end){if(await predicate())return;await delay(25);}throw new Error(`Timed out: ${label}`);}
async function unusedPort(){const server=createServer();await new Promise<void>((done,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',done);});const port=(server.address() as {port:number}).port;await new Promise<void>(done=>server.close(()=>done()));return port;}
async function pauseServer(milliseconds:number){
 assert.ok(backend?.pid,'only the child process owned by this probe may be stopped');
 stallCapture=[];stallEpoch=performance.now();await delay(300);
 const stoppedAtMs=performance.now()-stallEpoch;
 backend.kill('SIGSTOP');let resumedAtMs:number;
 try{await delay(milliseconds);}finally{resumedAtMs=performance.now()-stallEpoch;backend.kill('SIGCONT');}
 await delay(700);
 const snapshots=stallCapture;stallCapture=undefined;
 const after=snapshots.filter(snapshot=>snapshot.atMs>=resumedAtMs);
 const intervals=after.slice(1).map((snapshot,index)=>snapshot.atMs-after[index].atMs);
 const result={kind:'Only the owned local server process paused; no packet-loss emulation',requestedPauseMs:milliseconds,stoppedAtMs,resumedAtMs,actualPauseMs:resumedAtMs-stoppedAtMs,snapshots,postResumeIntervalsMs:summary(intervals),noNearAdjacentSnapshots:intervals.every(gap=>gap>=10),diagnostics:users.map(user=>user.network.diagnostics)};
 await writeFile(join(output,`stall-${milliseconds}ms.json`),JSON.stringify(result,null,2)+'\n');
 assert.ok(result.noNearAdjacentSnapshots,`Historical snapshots burst after ${milliseconds} ms stall`);
 return result;
}
const reports:any[]=[];
try{
 await mkdir(output,{recursive:true});
 // Preserve the earlier audit and its synthesis; all new captures live elsewhere.
 for(const [source,destination] of [['measurements.json','baseline-v2.json'],['audit.md','baseline-v2-audit.md']]){
  try{await copyFile(join(root,'temp/transport-audit',source),join(output,destination));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 }
 temporary=await mkdtemp(join(output,'db-'));
 const port=await unusedPort();base=`http://127.0.0.1:${port}`;
 backend=spawn(binary,[],{cwd:root,env:{...process.env,BOLTS_BIND:`127.0.0.1:${port}`,BOLTS_DB:join(temporary,'events.sqlite'),BOLTS_EMPTY_SECONDS:'1',BOLTS_RECONNECT_SECONDS:'1',RUST_LOG:'warn'},stdio:['ignore','pipe','pipe']});
 backend.stdout!.on('data',data=>serverOutput+=String(data));backend.stderr!.on('data',data=>serverOutput+=String(data));
 await until(async()=>{try{return(await fetch(base+'/api/health')).ok;}catch{return false;}},'isolated backend health');
 for(const count of [1,3,6]){
  users.length=0;rawRecords=[];let lobby:string|undefined;
  for(let i=0;i<count;i++){const u=user(i);users.push(u);await u.network.join(lobby,`Audit ${i+1}`,(['british','russian','german'] as const)[i%3]);lobby=u.network.lobbyId;}
  await until(()=>users.every(u=>u.snapshot?.actors.length===(count===1?3:count)),'expected actor population');
  const start=performance.now();let last=start,accumulator=0,simulationTime=0;
  timer=setInterval(()=>{
   const now=performance.now();accumulator+=Math.min(.1,(now-last)/1000);last=now;
   while(accumulator>=1/60){accumulator-=1/60;simulationTime+=1/60;
    for(const u of users){
     const t=simulationTime+u.index*.37,p=u.game.player;
     if(!p)continue;if(!p.alive)u.network.skipReplay();
     p.yaw=Math.sin(t*.29+u.index)*2.8;p.pitch=.4+.15*Math.sin(t*.71);
     u.network.setADS(Math.floor(t/2)%2===0);
     const fire=Math.floor(t/1.35),reload=Math.floor(t/9),stance=Math.floor(t/3.5),jump=Math.floor(t/5.5);
     if(fire!==u.lastFire){u.lastFire=fire;u.network.fireOnce();}
     if(reload!==u.lastReload){u.lastReload=reload;if(reload>0)u.network.reload();}
     if(stance!==u.lastStance){u.lastStance=stance;u.network.toggleStance(stance%3===2?'prone':'crouch');}
     const input:Input={forward:Math.sin(t*.5)>.2?1:0,right:Math.cos(t*.4)>.3?1:Math.cos(t*.4)<-.3?-1:0,jump:jump!==u.lastJump,walk:Math.floor(t/4)%3===0,lean:Math.sin(t*.33)>.6?1:0};u.lastJump=jump;
     u.network.update(1/60,input);
    }
   }
   for(const u of users)u.network.present();
  },8);
  await delay(2000);scenarioStart=performance.now();measuring=true;
  await delay(duration*1000);measuring=false;const elapsed=(performance.now()-scenarioStart)/1000;
  const steadyDiagnostics=users.map(u=>({client:u.index,...u.network.diagnostics,failures:[...u.failures]}));
  const stallExperiments=count===3?[await pauseServer(101),await pauseServer(500)]:[];
  assert.ok(users.every(user=>user.failures.length===0&&user.network.online),'All clients remain connected after stall probes');
  clearInterval(timer);timer=undefined;
  // Decoding for byte comparisons and serialization happen after the live loop.
  const samples:Sample[]=[],capture:string[]=[],eventCounts:Record<string,number>={},fieldBytes:Record<string,number>={};let snapshotActors=0;
  for(const {direction,client,wire,at} of rawRecords){
   const message=decode(wire,direction);if(['hello','welcome','joined'].includes(message.type))continue;
   const n=typeof wire==='string'?Buffer.byteLength(wire):wire.byteLength;
   samples.push({direction,client,type:message.type,at,bytes:n,framedBytes:n+(n<126?2:n<=65535?4:10)+(direction==='up'?4:0),sameStateV2JSONBytes:jsonBytes(previousJSON(message)),binary:typeof wire!=='string',events:message.events?.length??0,actorCount:message.actors?.length});
   if(client===0){
    capture.push(JSON.stringify({direction,at,wireBytes:n,binary:typeof wire!=='string',message}));
    if(message.type==='events'||message.type==='cues')for(const event of message.events)eventCounts[event.type]=(eventCounts[event.type]??0)+1;
    if(message.type==='snapshot')for(const actor of message.actors){snapshotActors++;for(const field of actorFields)fieldBytes[field]=(fieldBytes[field]??0)+jsonBytes(actor[field]??null);}
   }
  }
  rawRecords=[];
  const types=[...new Set(samples.map(sample=>`${sample.direction}:${sample.type}`))];
  const groups=Object.fromEntries(types.map(type=>{const subset=samples.filter(sample=>`${sample.direction}:${sample.type}`===type);return[type,{...summary(subset.map(s=>s.bytes)),binaryMessages:subset.filter(sample=>sample.binary).length,perClientMessagesPerSecond:subset.length/elapsed/count,aggregateBytesPerSecond:subset.reduce((n,s)=>n+s.bytes,0)/elapsed}];}));
  const totals=Object.fromEntries((['up','down'] as const).map(direction=>{const subset=samples.filter(s=>s.direction===direction);return[direction,{payloadBytesPerSecond:subset.reduce((n,s)=>n+s.bytes,0)/elapsed,framedBytesPerSecond:subset.reduce((n,s)=>n+s.framedBytes,0)/elapsed,perClientPayloadBytesPerSecond:subset.reduce((n,s)=>n+s.bytes,0)/elapsed/count}];}));
  const sameStateComparisons=Object.fromEntries(['input','snapshot'].map(type=>{const subset=samples.filter(s=>s.type===type),actual=summary(subset.map(s=>s.bytes)),previous=summary(subset.map(s=>s.sameStateV2JSONBytes));return[type,{actualProtocol3:actual,reconstructedProtocol2JSON:previous,reductionFraction:1-actual.total/previous.total}];}));
  const report={humans:count,actors:users[0].snapshot.actors.length,seconds:elapsed,groups,totals,sameStateComparisons,eventCountsForOneRecipient:eventCounts,meanFieldValueBytesPerActor:Object.fromEntries(Object.entries(fieldBytes).map(([key,n])=>[key,n/snapshotActors]).sort((a,b)=>Number(b[1])-Number(a[1]))),diagnostics:steadyDiagnostics,stallExperiments};reports.push(report);
  assert.ok(steadyDiagnostics.every(diagnostic=>diagnostic.failures.length===0),'Client connection failures');
  assert.ok(groups['up:input'].binaryMessages>0&&groups['down:snapshot'].binaryMessages>0,'Must measure the actual binary protocol');
  await writeFile(join(output,`capture-${count}-humans.ndjson`),capture.join('\n')+'\n');
  console.log(JSON.stringify({humans:count,actors:report.actors,totals,sameStateComparisons,stallExperiments:stallExperiments.map(({requestedPauseMs,actualPauseMs,postResumeIntervalsMs,noNearAdjacentSnapshots})=>({requestedPauseMs,actualPauseMs,postResumeIntervalsMs,noNearAdjacentSnapshots}))}));
  for(const u of users)u.network.disconnect();await delay(1600);
 }
 const report={measuredAt:new Date().toISOString(),commit:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),workingTreeDirty:!!execFileSync('git',['status','--porcelain'],{cwd:root,encoding:'utf8'}).trim(),binarySha256:createHash('sha256').update(await readFile(binary)).digest('hex'),methodology:{localOnly:true,protocolVersion:3,client:'Actual NetworkClient and Game adapters;60Hz accumulated ordinary controls;no renderer;isolated authoritative Rust debug server and fresh DB.',durationSecondsPerScenario:duration,warmupSeconds:2,movement:'Changing yaw/pitch,movement/strafe,ADS,jumps,crouch/prone,shots every1.35s,reload every9s;no teleports/authority edits;deaths auto-respawn.',actorCaveat:'One human has two bot-fill actors;three/six humans have no bots.',wireCaveat:'Actual application message byte lengths, including binary frames;calculated uncompressed WebSocket framing excludes handshake,controlframes,TCP/IP,ACKs,TLS,retransmission.',comparison:'Previous protocol2JSON rebuilt from precisely the same decoded inputs/snapshots;outer50field actor tuples with named nested pose/inputTiming. Actual binary codec used end-to-end;no lossy quantization,compression or guessed byte-size oracle.',stall:'101ms and500ms SIGSTOP/SIGCONT affect only spawned server;excluded from steady traffic and diagnostics;not simulated packet loss.',representativeness:'Short scripted loopback/debug workload;not Internet/mobile/TLS/renderer performance or server capacity benchmark.'},scenarios:reports};
 await writeFile(join(output,'measurements.json'),JSON.stringify(report,null,2)+'\n');
}finally{
 if(timer)clearInterval(timer);for(const u of users)u.network.disconnect();
 if(backend){backend.kill('SIGCONT');backend.kill('SIGINT');await Promise.race([new Promise(done=>backend!.once('exit',done)),delay(2000)]);if(backend.exitCode===null)backend.kill('SIGKILL');}
 if(temporary)await rm(temporary,{recursive:true,force:true});
 if(serverOutput)await writeFile(join(output,'server.log'),serverOutput);
}
