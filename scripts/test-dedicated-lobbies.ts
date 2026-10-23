/** Opt-in production smoke: three QA identities, all four local rooms, clean leave.
 * node --import tsx scripts/test-dedicated-lobbies.ts --remote-qa
 */
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {Game} from '../src/engine.ts';
import {NetworkClient} from '../src/network.ts';

if(process.argv.slice(2).join(' ')!=='--remote-qa')throw Error('Use --remote-qa to opt in.');
const origin='https://bolts-api.christopherkrapu.com',browser='https://play-bolts.github.io';
const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
const checks:string[]=[];
let passed=false;
const check=(label:string,fn:()=>void)=>{fn();checks.push(label);console.log(`PASS ${label}`);};
const fetcher:typeof fetch=async(url,init)=>{
 const headers=new Headers(init?.headers);headers.set('Origin',browser);
 const response=await fetch(url,{...init,headers});
 assert.equal(response.headers.get('access-control-allow-origin'),browser,'one CORS origin, including session success/error responses');
 return response;
};
const clients=Array.from({length:3},()=>{
 const storage=new Map<string,string>();
 return new NetworkClient(new Game(),{origin,fetch:fetcher,storage:{getItem:key=>storage.get(key)??null,setItem:(key,value)=>{storage.set(key,value);},removeItem:key=>{storage.delete(key);}}});
});
const failed:string[]=[];
clients.forEach(client=>{client.onFailure=message=>failed.push(message);});
const deadline=setTimeout(()=>{clients.forEach(client=>client.disconnect());process.exitCode=1;},60000);
try{
 const preflight=await fetch(origin+'/api/session',{method:'OPTIONS',headers:{Origin:browser,'Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'content-type'}});
 check('browser session preflight',()=>{assert.equal(preflight.status,204);assert.equal(preflight.headers.get('access-control-allow-origin'),browser);});
 const invalid=await fetcher(origin+'/api/session',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"token":"diagnostic-invalid-token"}'});
 check('expired credentials return a readable 401',()=>assert.equal(invalid.status,401));
 const rows=await clients[0].lobbies();
 check('four local rooms with the requested names and capacities',()=>{
  assert.deepEqual(rows.map(r=>[r.name,r.capacity]),[['Deathmatch',6],['1v1 Alpha',2],['1v1 Beta',2],['1v1 Delta',2]]);
  assert.ok(rows.every(r=>!r.managed&&r.location==='or'));
  assert.deepEqual(clients[0].locations,[]);
 });
 for(const room of rows){
  if(room.capacity===2)assert.equal(room.players,0,'duel smoke checks require empty rooms');
  else assert.ok(room.players<room.capacity,'Deathmatch needs an available spectator seat');
  await Promise.all(clients.map(client=>client.lobbies()));
  await clients[0].join(room.id,'QA Duels A','british',room.capacity===6);
  check(`${room.name}: joined with live snapshots`,()=>{assert.ok(clients[0].connected);assert.equal(clients[0].lobbyName,room.name);assert.ok(clients[0].game.history.length);});
  const start=clients[0].game.history.at(-1)!.time;
  await pause(250);
  check(`${room.name}: simulation advances`,()=>assert.ok(clients[0].game.history.at(-1)!.time>start));
  if(room.capacity===2){
   await clients[1].join(room.id,'QA Duels B','german');
   await pause(150);
   check(`${room.name}: two humans and no bots`,()=>{assert.equal(clients[0].game.actors.length,2);assert.equal(clients[1].game.actors.length,2);assert.ok(clients[0].game.actors.every(actor=>actor.name.startsWith('QA Duels ')));});
   await assert.rejects(clients[2].join(room.id,'QA Duels C','russian',true),/full/i);
   checks.push(`${room.name}: third seat rejected`);
   assert.ok(clients[0].connected&&clients[1].connected);
  }
  clients.forEach(client=>client.disconnect());
  await pause(300);
 }
 // Other players may arrive during QA; only our own clients must disconnect.
 await pause(5200);
 const after=await clients[0].lobbies();
 check('QA clients disconnected and lobby identities stayed stable',()=>{assert.deepEqual(after.map(r=>r.id),rows.map(r=>r.id));assert.ok(clients.every(client=>!client.online));assert.deepEqual(failed,[]);});
 passed=true;
}finally{
 clearTimeout(deadline);clients.forEach(client=>client.disconnect());
 await mkdir(new URL('../temp/dedicated-lobbies/',import.meta.url),{recursive:true});
 await writeFile(new URL('../temp/dedicated-lobbies/production-smoke.json',import.meta.url),JSON.stringify({passed,at:new Date().toISOString(),checks},null,2)+'\n');
}
