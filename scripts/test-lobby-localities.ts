/** Exercise the real NetworkClient against every production locality as a spectator.
 * Explicit opt-in: node --import tsx scripts/test-lobby-localities.ts --remote-qa
 * --probe-disabled-regions bypasses the browser release flag for diagnosis only;
 * it never changes AWS configuration or supplies a destination the API omits.
 * --timeout-ms=30000 bounds each attempt; use 630000 for a full cold-start check.
 * Results contain no credentials and go to temp/multiplayer-qa/.
 */
import {randomUUID} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {Game} from '../src/engine.ts';
import {NetworkClient} from '../src/network.ts';
import {EXTRA_LOBBIES_ENABLED,LOBBY_LOCATIONS,type LobbyLocation} from '../src/lobbies.ts';

const args=process.argv.slice(2);
if(!args.includes('--remote-qa')||args.some(arg=>arg!=='--remote-qa'&&arg!=='--probe-disabled-regions'&&!/^--timeout-ms=\d+$/.test(arg)))throw new Error('Use --remote-qa [--probe-disabled-regions] [--timeout-ms=30000].');
const timeoutMs=Number(args.find(arg=>arg.startsWith('--timeout-ms='))?.split('=')[1]??30000);
if(!Number.isSafeInteger(timeoutMs)||timeoutMs<5000||timeoutMs>630000)throw new Error('Timeout must be 5000–630000 ms.');
const probeDisabled=args.includes('--probe-disabled-regions');
const origin='https://bolts-api.christopherkrapu.com';
const started=Date.now(),name=`QA Regions ${randomUUID().slice(0,8)}`;
const storage=new Map<string,string>();
const results:Record<string,unknown>[]=[];
const output=new URL(`../temp/multiplayer-qa/localities-${started}.json`,import.meta.url);
const idle={forward:0,right:0,jump:false,walk:false,lean:0};
const delay=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
let active:NetworkClient|undefined,interrupted=false;
const stop=()=>{interrupted=true;active?.disconnect();};
process.once('SIGINT',stop);process.once('SIGTERM',stop);
function safeMessage(error:unknown){
 let message=error instanceof Error?error.message:String(error);
 for(const credential of storage.values())message=message.replaceAll(credential,'[redacted]');
 return message;
}

try{
 for(const location of Object.keys(LOBBY_LOCATIONS) as LobbyLocation[]){
  if(interrupted)break;
  const city=LOBBY_LOCATIONS[location].name,attempt=Date.now(),statuses:string[]=[];
  const game=new Game();let failed='',expired=false;
  const sockets:WebSocket[]=[];
  const client=new NetworkClient(game,{origin,extraLobbiesEnabled:EXTRA_LOBBIES_ENABLED||probeDisabled,
   storage:{getItem:key=>storage.get(key)??null,setItem:(key,value)=>{storage.set(key,value);},removeItem:key=>{storage.delete(key);}},
   socket:url=>{const socket=new WebSocket(url);sockets.push(socket);return socket;}});
  active=client;
  client.onStatus=status=>{if(status&&statuses.at(-1)!==status)statuses.push(status);};
  client.onFailure=message=>{failed=message;};
  const deadline=setTimeout(()=>{expired=true;client.disconnect();},timeoutMs);
  const ticks=setInterval(()=>{if(client.connected){client.update(1/60,idle);client.present();game.events=[];}},1000/60);
  let row:Record<string,unknown>={location,city};
  try{
   const rooms=await client.lobbies();
   if(interrupted)throw new Error('QA interrupted.');
   if(expired)throw new Error('Locality check deadline exceeded while loading servers.');
   const room=rooms.find(room=>(room.location??'or')===location&&room.players===0&&room.phase==='playing');
   if(location==='or'&&!room)throw new Error('No empty Oregon lobby is available for this spectator check.');
   if(location!=='or'&&!client.locations.includes(location))throw new Error('Locality is not available in the directory for this client.');
   console.log(`Checking ${city}…`);
   await client.join(room?.id??`new:${location}`,name,'british',true);
   if(expired)throw new Error(`No lobby joined within ${timeoutMs/1000} seconds.`);
   if(interrupted)throw new Error('QA interrupted.');
   if(failed)throw new Error(failed);
   if(!client.connected||!client.lobbyId||client.lobbyId.startsWith('new:'))throw new Error('No completed lobby handshake.');
   if(client.lobbyLocation!==location)throw new Error('Joined a different locality.');
   if(!game.player?.spectator||game.player.name!==name)throw new Error('Server did not confirm the requested spectator identity.');
   const firstTime=game.history.at(-1)?.time;
   if(firstTime===undefined)throw new Error('The initial authoritative snapshot was not retained.');
   while((game.history.at(-1)?.time??firstTime)<=firstTime&&!expired&&!failed&&client.connected)await delay(50);
   if(expired||failed||!client.connected||(game.history.at(-1)?.time??firstTime)<=firstTime)throw new Error(failed||'No advancing authoritative snapshots after joining.');
   const joinedId=client.lobbyId;
   let confirmed=false;
   while(!expired&&!failed&&client.connected){
    const rows=await client.lobbies();
    const listed=rows.find(room=>room.id===joinedId);
    if(listed){
     if((listed.location??'or')!==location||listed.managed!==(location!=='or'))throw new Error('The directory reports a different locality for the joined server.');
     confirmed=true;break;
    }
    await delay(500);
   }
   if(!confirmed||expired||failed||!client.connected)throw new Error(failed||'The directory did not confirm the joined server locality.');
   row={...row,passed:true,lobbyId:client.lobbyId,lobbyName:client.lobbyName,spectator:true,advancingSnapshots:true};
   console.log(`PASS ${city}: joined ${client.lobbyName}; live snapshots received.`);
  }catch(error){
   row={...row,passed:false,error:safeMessage(error)};
   console.error(`FAIL ${city}: ${row.error}`);
  }finally{
   clearTimeout(deadline);clearInterval(ticks);client.disconnect();active=undefined;
   const closeDeadline=Date.now()+3000;
   while(sockets.some(socket=>socket.readyState!==WebSocket.CLOSED)&&Date.now()<closeDeadline)await delay(50);
   row={...row,elapsedMs:Date.now()-attempt,statuses,socketsClosed:sockets.every(socket=>socket.readyState===WebSocket.CLOSED)};
   if(!row.socketsClosed)row.passed=false;
   results.push(row);
  }
 }
}finally{
 active?.disconnect();process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);
 const passed=!interrupted&&results.length===4&&results.every(row=>row.passed===true);
 await mkdir(new URL('.',output),{recursive:true});
 await writeFile(output,JSON.stringify({passed,endpoint:origin,startedAt:new Date(started).toISOString(),releaseExtraLobbiesEnabled:EXTRA_LOBBIES_ENABLED,probeDisabledRegions:probeDisabled,timeoutMs,interrupted,results},null,2)+'\n');
 console.log(`Locality report: ${fileURLToPath(output)}`);
 if(!passed)process.exitCode=1;
}
