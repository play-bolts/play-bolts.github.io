/** Explicit production QA; never runs without --remote-qa.
 * One browser identity visits Oregon, London, Singapore and São Paulo as a
 * spectator. A separate directory-only browser checks shared lobby visibility.
 * Uses real admissions and leaves durable identity / enter / leave records.
 * Run only after confirming the regional directory is live:
 *   node --import tsx scripts/test-regional-identity.ts --remote-qa
 */
import {randomUUID} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Game,type Input} from '../src/engine.ts';
import {NetworkClient,type WireSnapshot} from '../src/network.ts';
import {decodeMessage,decodeSnapshot} from '../src/networkCodec.ts';
import {gameEndpoint,LOBBY_LOCATIONS,type Lobby,type LobbyLocation} from '../src/lobbies.ts';
import {PLAYER_NAME_PREFERENCE_VERSION,restorePlayerNamePreference} from '../src/names.ts';

const args=process.argv.slice(2);
if(args.length!==1||args[0]!=='--remote-qa')throw new Error('Only an explicit --remote-qa is supported; there are no endpoint or location overrides.');
if(Object.keys(process.env).some(key=>/^(?:BOLTS_.*(?:URL|ORIGIN|ENDPOINT|SERVER)|VITE_MULTIPLAYER_URL)$/.test(key)&&process.env[key]))throw new Error('Unset endpoint / server override environment variables before running production QA.');

const origin='https://bolts-api.christopherkrapu.com';
const locations=['or','lon','sg','sp'] as const;
const root=fileURLToPath(new URL('..',import.meta.url)),started=Date.now(),runId=randomUUID();
const reportPath=resolve(root,`temp/multiplayer-qa/regional-identity-${started}-${runId}.json`);
const name=`QA Identity ${runId.slice(0,8)}`;
const idle:Input={forward:0,right:0,jump:false,walk:false,lean:0};
const delay=(milliseconds:number)=>new Promise<void>(done=>setTimeout(done,milliseconds));
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sharedStorage=new Map<string,string>([['bolts-preferences',JSON.stringify({playerName:name,playerNameVersion:PLAYER_NAME_PREFERENCE_VERSION})]]),readerStorage=new Map<string,string>();
const clients=new Set<ReturnType<typeof browser>>(),secrets=new Set<string>();
const checks:string[]=[],stages:Record<string,unknown>[]=[],directories:Record<string,unknown>[]=[];
let permanentId='',permanentCredential='',initialStorage:[string,string][]|undefined,fatal='',active:ReturnType<typeof browser>|undefined;

function requireCondition(condition:unknown,message:string):asserts condition{if(!condition)throw new Error(message);}
function abort(message:string){if(!fatal)fatal=message;for(const client of clients)client.network.disconnect();}
function healthy(){if(fatal)throw new Error(fatal);}
function check(message:string){healthy();checks.push(message);console.log(`PASS ${message}`);}
function safeError(error:unknown){let message=error instanceof Error?error.message:'Unknown QA failure';for(const value of secrets)message=message.replaceAll(value,'[redacted]');return message;}
function storedCredentialUnchanged(){
 requireCondition(!!initialStorage,'The first browser session persisted its credential.');
 const entries=[...sharedStorage];
 requireCondition(entries.length===initialStorage.length&&entries.every(([key,value],index)=>key===initialStorage![index][0]&&value===initialStorage![index][1]),'The browser credential changed while switching regions.');
}
async function until(predicate:()=>boolean|Promise<boolean>,label:string,timeout=25000){
 const deadline=Date.now()+timeout;
 while(Date.now()<deadline){healthy();if(await predicate()){healthy();return;}await delay(500);}
 throw new Error(`Timed out: ${label}`);
}
function atLocation(row:Lobby,location:LobbyLocation){return row.location===location&&row.managed===(location!=='or');}
function directoryShape(rows:Lobby[]){
 return rows.map(({id,name,location,managed,capacity,players,bots,phase})=>({id,name,location,managed:managed===true,capacity,players,...(bots===undefined?{}:{bots}),phase})).sort((a,b)=>a.id.localeCompare(b.id));
}
function browser(storage:Map<string,string>,directoryOnly=false){
 const preferences=JSON.parse(storage.get('bolts-preferences')??'{}');
 const restoredName=restorePlayerNamePreference(preferences.playerName,preferences.playerNameVersion);
 if(!directoryOnly)requireCondition(restoredName===name,'The browser did not restore the saved QA player name.');
 const game=new Game();let actorId=-1,snapshot:WireSnapshot|undefined,welcomeId='',sessionId='',sessionCount=0,socket:WebSocket|undefined;
 let network:NetworkClient;
 const fetcher:typeof fetch=async(input,init)=>{
  healthy();
  const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);
  requireCondition(url.origin===origin&&!url.search&&!url.hash&&['/api/lobbies','/api/session','/api/join'].includes(url.pathname),'QA refused an untrusted control-plane request.');
  requireCondition(!directoryOnly||url.pathname==='/api/lobbies','The directory-only browser must never create an identity or join a game.');
  if(url.pathname==='/api/session'&&permanentCredential){
   const request=typeof init?.body==='string'?JSON.parse(init.body):{};
   requireCondition(request.token===permanentCredential,'A regional browser did not reuse the saved credential.');
  }
  const response=await fetch(input,{...init,redirect:'error'});
  if(url.pathname==='/api/session'){
   // app.rs returns {playerId, token}. Reject a failed authentication here so
   // the adapter cannot silently replace this QA identity with a fresh one.
   requireCondition(response.ok,'The permanent browser session was not accepted.');
   const body=await response.clone().json();
   if(typeof body.token==='string')secrets.add(body.token);
   requireCondition(typeof body.playerId==='string'&&uuid.test(body.playerId)&&typeof body.token==='string'&&/^[0-9a-f]{64}$/i.test(body.token),'The session response did not contain a valid UUID and credential.');
   if(permanentId){requireCondition(body.playerId===permanentId&&body.token===permanentCredential,'The permanent UUID or credential changed between regional sessions.');}
   else{permanentId=body.playerId;permanentCredential=body.token;}
   sessionId=body.playerId;sessionCount++;
  }else if(url.pathname==='/api/join'&&response.ok){
   const body=await response.clone().json();if(typeof body.ticket==='string')secrets.add(body.ticket);
  }else if(url.pathname==='/api/lobbies'&&response.ok){
   const body=await response.clone().json();requireCondition(body.version===2,'The regional directory is not live (version 2 is required).');
  }
  healthy();return response;
 };
 network=new NetworkClient(game,{origin,fetch:fetcher,storage:{getItem:key=>storage.get(key)??null,setItem:(key,value)=>{secrets.add(value);storage.set(key,value);},removeItem:key=>{storage.delete(key);}},socket:value=>{
  requireCondition(!directoryOnly,'The directory-only browser must never open a game socket.');
  const endpoint=gameEndpoint(value,origin);
  requireCondition(endpoint.protocol==='wss:'&&endpoint.pathname==='/api/ws','QA refused an unexpected game socket endpoint.');
  socket=new WebSocket(endpoint);socket.binaryType='arraybuffer';
  socket.addEventListener('message',event=>{
   try{
    healthy();const message=decodeMessage(event.data) as any;
    if(message.type==='welcome'){
     requireCondition(message.playerId===permanentId,'The regional worker authenticated a different permanent UUID.');welcomeId=message.playerId;
    }
    if(message.type==='joined'){
     requireCondition(Number.isSafeInteger(message.actorId),'The server returned an invalid QA actor ID.');actorId=message.actorId;snapshot=message.snapshot;
    }else if(message.type==='snapshot')snapshot=decodeSnapshot(message) as WireSnapshot;
    else return;
    requireCondition(snapshot&&Array.isArray(snapshot.actors),'The server returned an invalid QA snapshot.');
    // This listener runs before NetworkClient's message handler. Disconnecting
    // also changes its generation, so an unsafe join cannot proceed downstream.
    requireCondition(snapshot.actors.every(actor=>actor.bot===true||(actor.id===actorId&&actor.name===restoredName)),'A non-QA human appeared; QA disconnected immediately.');
    const own=snapshot.actors.find(actor=>actor.id===actorId);
    requireCondition(own?.spectator===true,'The QA actor is not a spectator; QA disconnected immediately.');
   }catch(error){event.stopImmediatePropagation();abort(safeError(error));}
  });
  return socket;
 }});
 network.onFailure=()=>abort('A QA network adapter failed; all QA clients disconnected.');
 const client={network,game,name:restoredName,get actorId(){return actorId;},get snapshot(){return snapshot;},get welcomeId(){return welcomeId;},get sessionId(){return sessionId;},get sessionCount(){return sessionCount;},get socketClosed(){return !socket||socket.readyState===WebSocket.CLOSED;}};
 clients.add(client);return client;
}

/** Warm the five-second server cache, then compare two independent adapters in
 * parallel. Every stage gets a new baseline: legitimate new rooms from previous
 * admissions must not be mistaken for browser-specific directory filtering.
 * Retry a short pair that straddled refresh/invalidation; never accept different
 * catalogs merely because one is a subset of the other.
 */
async function matchingDirectories(primary:ReturnType<typeof browser>,reader:ReturnType<typeof browser>,stage:string){
 for(let attempt=1;attempt<=4;attempt++){
  const baseline=await primary.network.lobbies(),before=performance.now();
  const [left,right]=await Promise.all([primary.network.lobbies(),reader.network.lobbies()]);
  const elapsedMs=performance.now()-before;
  healthy();
  const leftRows=directoryShape(left),rightRows=directoryShape(right);
  const leftLocations=[...primary.network.locations].sort(),rightLocations=[...reader.network.locations].sort();
  if(elapsedMs<5000&&JSON.stringify(leftRows)===JSON.stringify(rightRows)&&JSON.stringify(leftLocations)===JSON.stringify(rightLocations)){
   directories.push({stage,attempt,elapsedMs,baseline:directoryShape(baseline),rows:leftRows,locations:leftLocations});
   check(`${stage}: independent browsers see the same complete directory within its cache window`);return left;
  }
  await delay(250);
 }
 throw new Error(`${stage}: independent browser directory views did not agree within the five-second cache window.`);
}

const reader=browser(readerStorage,true);
const tick=setInterval(()=>{try{healthy();if(active?.network.connected){active.network.update(1/60,idle);active.network.present();active.game.events=[];}}catch(error){abort(safeError(error));}},1000/60);
const deadline=setTimeout(()=>abort('Regional identity QA exceeded its 35-minute overall limit.'),35*60*1000);deadline.unref();
const interrupted=()=>abort('QA interrupted; all clients disconnected.');
process.once('SIGINT',interrupted);process.once('SIGTERM',interrupted);
let passed=false,errorMessage='';
try{
 for(const location of locations){
  const city=LOBBY_LOCATIONS[location].name,client=browser(sharedStorage);active=client;
  let rows=await matchingDirectories(client,reader,`${city} before join`);
  if(location!=='or')requireCondition(client.network.locations.includes(location),`${city} is not advertised as available.`);
  let room=rows.find(row=>atLocation(row,location)&&row.players===0&&row.capacity===6&&row.phase==='playing');
  if(room){
   // Recheck immediately before admission. Cached counts can still race another
   // admission, so the spectator snapshot guard remains the final safety check.
   const refreshed=await client.network.lobbies();room=refreshed.find(row=>row.id===room!.id&&atLocation(row,location)&&row.players===0&&row.capacity===6&&row.phase==='playing');
  }
  requireCondition(!!room||location!=='or','Oregon QA requires a real empty Oregon lobby.');
  const requestedRoom=room?.id??`new:${location}`;
  console.log(`Joining ${city} as an isolated QA spectator…`);
  await client.network.join(requestedRoom,client.name,'british',true);healthy();
  requireCondition(client.network.connected&&client.network.lobbyId!==''&&!client.network.lobbyId.startsWith('new:'),'The adapter did not receive an actual lobby.');
  requireCondition(client.sessionCount===1&&client.sessionId===permanentId&&client.welcomeId===permanentId,'The session API and regional worker did not agree on the permanent UUID.');
  if(!initialStorage){initialStorage=[...sharedStorage];requireCondition(initialStorage.length===2&&sharedStorage.get('bolts-multiplayer-session-v1')===permanentCredential,'The first browser did not persist the expected credential alongside its preferences.');}
  storedCredentialUnchanged();
  const actualRoomId=client.network.lobbyId;
  let actual:Lobby|undefined;
  await until(async()=>{
   rows=await client.network.lobbies();actual=rows.find(row=>row.id===actualRoomId);
   if(actual)requireCondition(atLocation(actual,location),`The admitted room is not in ${city}.`);
   return !!actual&&actual.players===1&&actual.phase==='playing';
  },`${city} actual room is advertised with the QA spectator`);
  requireCondition(client.snapshot?.actors.filter(actor=>actor.bot!==true).length===1,'The room is not isolated to the QA spectator.');
  await matchingDirectories(client,reader,`${city} after join`);
  storedCredentialUnchanged();
  const authoritativeName=client.snapshot!.actors.find(actor=>actor.id===client.actorId)?.name;
  requireCondition(authoritativeName===client.name&&authoritativeName===name,'The authoritative player name differs from the restored browser preference.');
  stages.push({location,city,lobbyId:actualRoomId,lobbyName:actual!.name,playerId:permanentId,name:authoritativeName,actorId:client.actorId,spectator:true,namePreferenceUnchanged:true,credentialUnchanged:true,sessionApiVerified:true,workerIdentityVerified:true});
  check(`${city}: session API and worker retain the same permanent UUID, name and stored credential`);
  client.network.disconnect();active=undefined;
  await until(()=>client.socketClosed,`${city} QA socket closes`,5000);
  await until(async()=>{const catalog=await reader.network.lobbies(),left=catalog.find(row=>row.id===actualRoomId);return !left||left.players===0;},`${city} QA room has no remaining human participants`);
  clients.delete(client);check(`${city}: QA spectator disconnected and its room is empty`);
 }
 storedCredentialUnchanged();
 requireCondition(readerStorage.size===0,'Directory-only checks unexpectedly created an identity.');
 requireCondition(stages.length===locations.length,'Not all four locations were verified.');
 passed=true;
}catch(error){errorMessage=safeError(error);process.exitCode=1;console.error(errorMessage);}
finally{
 clearInterval(tick);clearTimeout(deadline);for(const client of clients)client.network.disconnect();
 process.removeListener('SIGINT',interrupted);process.removeListener('SIGTERM',interrupted);
 await mkdir(resolve(root,'temp/multiplayer-qa'),{recursive:true});
 await writeFile(reportPath,JSON.stringify({passed,mode:'production spectator identity QA',endpoint:origin,startedAt:new Date(started).toISOString(),durationSeconds:(Date.now()-started)/1000,name,playerId:permanentId||undefined,checks,stages,directories,...(errorMessage?{error:errorMessage}:{})},null,2)+'\n');
 console.log(`Regional identity QA ${passed?'passed':'failed'}; report ${reportPath}`);
}
