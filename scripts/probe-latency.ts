/** Read-only WebSocket latency probe. Uses /api/ping; never creates a player or lobby. */
import {mkdir,writeFile} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';

const endpoint=new URL(process.argv[2]??'https://bolts-api.christopherkrapu.com');
endpoint.protocol=endpoint.protocol==='http:'?'ws:':endpoint.protocol==='https:'?'wss:':endpoint.protocol;
endpoint.pathname='/api/ping';endpoint.search='';endpoint.hash='';
if(!['ws:','wss:'].includes(endpoint.protocol)||endpoint.username||endpoint.password)throw new Error('Expected an HTTP(S) or WebSocket endpoint without credentials.');
const output=resolve(process.argv[3]??'temp/latency-probe.json');
const pause=(ms:number)=>new Promise(done=>setTimeout(done,ms));
const samples:{connection:number;sample:number;roundTripMs:number}[]=[];
const connections:{connection:number;connectMs:number}[]=[];
const failures:{connection:number;error:string}[]=[];
const startedAt=new Date().toISOString();
for(let connection=0;connection<12;connection++){
 const started=performance.now(),socket=new WebSocket(endpoint);
 try{
  await new Promise<void>((done,reject)=>{
   const timer=setTimeout(()=>reject(new Error('Connection timeout')),5000);
   socket.addEventListener('open',()=>{clearTimeout(timer);done();},{once:true});
   socket.addEventListener('error',()=>{clearTimeout(timer);reject(new Error('Connection failed'));},{once:true});
  });
  connections.push({connection,connectMs:performance.now()-started});
  for(let sample=0;sample<3;sample++){
   const nonce=`${connection}:${sample}`,sent=performance.now();
   await new Promise<void>((done,reject)=>{
    const timer=setTimeout(()=>{socket.removeEventListener('message',receive);reject(new Error('Ping timeout'));},3000);
    const receive=(event:MessageEvent)=>{
     try{
      const message=JSON.parse(String(event.data));
      if(message.type!=='pong'||message.nonce!==nonce)return;
      clearTimeout(timer);socket.removeEventListener('message',receive);
      samples.push({connection,sample,roundTripMs:performance.now()-sent});done();
     }catch{clearTimeout(timer);socket.removeEventListener('message',receive);reject(new Error('Invalid pong'));}
    };
    socket.addEventListener('message',receive);socket.send(JSON.stringify({type:'ping',nonce}));
   });
   if(sample<2)await pause(250);
  }
 }catch(error){failures.push({connection,error:String(error)});}finally{socket.close();}
 if(connection<11)await pause(1000);
}
const sorted=samples.map(sample=>sample.roundTripMs).sort((a,b)=>a-b);
const summary={count:sorted.length,minMs:sorted[0]??null,p50Ms:sorted[Math.floor((sorted.length-1)*.5)]??null,p95Ms:sorted[Math.floor((sorted.length-1)*.95)]??null,maxMs:sorted.at(-1)??null,over150Ms:sorted.filter(ms=>ms>150).length};
await mkdir(dirname(output),{recursive:true});
await writeFile(output,JSON.stringify({startedAt,finishedAt:new Date().toISOString(),endpoint:endpoint.href,note:'Measured from the machine running this script, without gameplay load; does not reproduce an individual player route or frame stalls.',summary,connections,samples,failures},null,2)+'\n');
console.log(JSON.stringify({output,summary,failures},null,2));
if(failures.length)process.exitCode=1;
