/** Tight hit-volume protocol regression with two real WebSocket clients against an isolated, local Rust server/database.
 * Build server/target/debug/bolts-server, then run:
 * node --import tsx scripts/test-hitboxes.mjs
 * Deliberately has no remote-endpoint option: this regression creates no
 * production identities, membership events, or matches.
 */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

import {ARENA,blocked,visible} from '../src/config.ts';
import {sampleHitVolumes,rayHitVolumes} from '../src/hitboxes.ts';
const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const clients=[];
let backend,temporary,base,diagnostics='',checks=0;
async function eventually(predicate,label,timeout=6000){
 const deadline=Date.now()+timeout;
 while(Date.now()<deadline){if(await predicate())return;await delay(25);}
 throw new Error(`Timed out: ${label}`);
}
function check(label,body){body();checks++;console.log(`PASS ${label}`);}
async function unusedPort(){
 const listener=createServer();
 await new Promise((resolve,reject)=>{listener.once('error',reject);listener.listen(0,'127.0.0.1',resolve);});
 const port=listener.address().port;await new Promise(resolve=>listener.close(resolve));return port;
}
async function json(path,body){
 const response=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(2000)});
 assert.equal(response.ok,true,`${path}: HTTP ${response.status}`);return response.json();
}
class Client {
 constructor(name){this.name=name;this.messages=[];this.seq=0;}
 send(message){this.socket.send(JSON.stringify(message));}
 async connect(){
  const session=await json('/api/session',{});
  this.socket=new WebSocket(base.replace(/^http/,'ws')+'/api/ws');
  this.socket.addEventListener('message',({data})=>{
   const message=JSON.parse(String(data));this.messages.push(message);
   if(message.type==='joined'){this.actorId=message.actorId;this.lobbyId=message.lobbyId;this.snapshot=message.snapshot;}
   if(message.type==='snapshot')this.snapshot=message;
  });
  await new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>reject(new Error('WebSocket open timed out')),5000);
   this.socket.addEventListener('open',()=>{clearTimeout(timer);resolve();},{once:true});
   this.socket.addEventListener('error',()=>{clearTimeout(timer);reject(new Error('WebSocket failed'));},{once:true});
  });
  this.send({type:'hello',version:1,token:session.token});
  await eventually(()=>this.messages.some(message=>message.type==='welcome'),'hello');
 }
 async join(lobbyId){
  this.send({type:'join',name:this.name,faction:'british',...(lobbyId?{lobbyId}:{})});
  await eventually(()=>this.actorId!==undefined,'join');
 }
 get self(){return this.actor();}
 actor(id=this.actorId){return this.snapshot?.actors.find(actor=>actor.id===id);}
 input(actions={}){
  const seq=++this.seq;
  this.send({type:'input',seq,forward:0,right:0,jump:false,walk:false,lean:0,yaw:0,pitch:1.3,ads:false,stance:'stand',weapon:'rifle',fire:false,reload:false,melee:false,...actions});
  return seq;
 }
 events(since=0){return this.messages.slice(since).flatMap(message=>message.events??[]);}
 close(){if(this.socket?.readyState===WebSocket.OPEN)this.socket.close();}
}

function routeToShot(shooter,target,actors){
 const step=.5,minX=-ARENA.width/2+.5,minZ=-ARENA.depth/2+.5,nx=Math.floor((ARENA.width-1)/step)+1,nz=Math.floor((ARENA.depth-1)/step)+1;
 const point=index=>({x:minX+(index%nx)*step,z:minZ+Math.floor(index/nx)*step});
 const index=(x,z)=>Math.round((z-minZ)/step)*nx+Math.round((x-minX)/step);
 const occupied=(x,z)=>blocked(x,z,0,.42)||actors.some(actor=>actor.id!==shooter.id&&actor.alive&&Math.hypot(x-actor.x,z-actor.z)<.82);
 const goal=p=>{const distance=Math.hypot(p.x-target.x,p.z-target.z);return distance>=3&&distance<=6&&visible({x:p.x,y:shooter.eyeHeight,z:p.z},{x:target.x,y:target.y+target.eyeHeight,z:target.z})&&visible({x:p.x,y:1.65,z:p.z},{x:target.x,y:.2,z:target.z})&&actors.every(actor=>{if(actor.id===shooter.id||actor.id===target.id||!actor.alive)return true;const dx=target.x-p.x,dz=target.z-p.z,t=Math.max(0,Math.min(1,((actor.x-p.x)*dx+(actor.z-p.z)*dz)/(dx*dx+dz*dz)));return Math.hypot(actor.x-(p.x+t*dx),actor.z-(p.z+t*dz))>.7;});};
 if(goal(shooter))return [];
 const start=index(shooter.x,shooter.z),queue=[start],previous=new Map([[start,null]]);let found;
 for(let cursor=0;cursor<queue.length;cursor++){
  const current=queue[cursor],p=point(current);if(goal(p)){found=current;break;}
  for(const [dx,dz] of [[1,0],[-1,0],[0,1],[0,-1],[1,1],[-1,1],[1,-1],[-1,-1]]){
   const gx=current%nx+dx,gz=Math.floor(current/nx)+dz;if(gx<0||gx>=nx||gz<0||gz>=nz)continue;const next=gz*nx+gx;if(previous.has(next))continue;const q=point(next);if(occupied(q.x,q.z)||(dx&&dz&&(occupied(p.x,q.z)||occupied(q.x,p.z))))continue;previous.set(next,current);queue.push(next);
  }
 }
 assert.notEqual(found,undefined,'a walkable firing position exists');const path=[];for(let at=found;at!==start;at=previous.get(at))path.push(point(at));return path.reverse();
}

try {
 temporary=await mkdtemp(join(tmpdir(),'bolts-hitboxes-'));
 const port=await unusedPort();base=`http://127.0.0.1:${port}`;
 backend=spawn(resolve(root,'server/target/debug/bolts-server'),[],{cwd:root,env:{...process.env,BOLTS_BIND:`127.0.0.1:${port}`,BOLTS_DB:join(temporary,'events.sqlite'),BOLTS_EMPTY_SECONDS:'2',BOLTS_RECONNECT_SECONDS:'1'},stdio:['ignore','pipe','pipe']});
 backend.stdout.on('data',chunk=>{diagnostics=(diagnostics+chunk).slice(-8000);});backend.stderr.on('data',chunk=>{diagnostics=(diagnostics+chunk).slice(-8000);});backend.on('error',error=>{diagnostics+=error.message;});
 await eventually(async()=>{try{return (await json('/api/health')).ok;}catch{return false;}},'health');
 for(const name of ['Volume shooter','Volume observer']){const c=new Client(name);clients.push(c);await c.connect();await c.join(clients[0].lobbyId);}
 const [shooter,target]=clients;await eventually(()=>clients.every(c=>c.snapshot?.actors.length===2),'two actual users');
 let path=routeToShot(shooter.self,target.self,shooter.snapshot.actors),best=Infinity,lastProgress=Date.now(),deadline=Date.now()+30000;
 while(path.length){
  assert.ok(Date.now()<deadline,'ordinary movement reaches clear low firing position');const a=shooter.self,p=path[0],distance=Math.hypot(p.x-a.x,p.z-a.z);
  if(distance<.28){path.shift();best=Infinity;lastProgress=Date.now();continue;}
  if(distance<best-.02){best=distance;lastProgress=Date.now();}
  if(Date.now()-lastProgress>1500){path=routeToShot(a,target.self,shooter.snapshot.actors);best=Infinity;lastProgress=Date.now();continue;}
  shooter.input({forward:Math.min(1,distance/.24),yaw:Math.atan2(p.x-a.x,p.z-a.z),pitch:0});await delay(50);
 }
 shooter.input({pitch:0});target.input({yaw:Math.atan2(shooter.self.x-target.self.x,shooter.self.z-target.self.z),pitch:0});await delay(2200);
 const head=()=>sampleHitVolumes(target.self,target.snapshot.time).find(v=>v.part==='head');
 const shootAt=async(point)=>{
  await eventually(()=>shooter.self.cooldown===0,'weapon recovery');
  const aim=()=>{const a=shooter.self;return{yaw:Math.atan2(point.x-a.x,point.z-a.z),pitch:Math.atan2(point.y-(a.y+a.eyeHeight),Math.hypot(point.x-a.x,point.z-a.z))-a.recoil,ads:true};};
  shooter.input(aim());await delay(120);const seq=shooter.input({...aim(),fire:true,shotTime:shooter.snapshot.time});
  await eventually(()=>clients.every(c=>c.events().some(e=>e.type==='shot'&&e.actor===shooter.actorId&&e.seq===seq)),'shot reaches both users');
  return clients.map(c=>c.events().find(e=>e.type==='shot'&&e.actor===shooter.actorId&&e.seq===seq).shot);
 };
 const h=head(),dx=target.self.x-shooter.self.x,dz=target.self.z-shooter.self.z,d=Math.hypot(dx,dz);
 const outside={x:h.center.x+dz/d*.15,y:h.center.y,z:h.center.z-dx/d*.15};
 const missShots=await shootAt(outside);
 check('a shot beside the actual head misses, instead of hitting the old36cm square',()=>{for(const shot of missShots){assert.equal(shot.hit,null);assert.equal(shot.headshot,false);}assert.equal(target.self.hp,100);});
 // Observe the visible gap below the hips using the same real replicated pose.
 // Find a thin horizontal ray gap, rather than assuming the animated legs are
 // symmetric at this gait phase. The server still traces the resulting shot.
 let gap;
 for(let y=.28;y<.56&&!gap;y+=.025){const point={x:target.self.x,y,z:target.self.z},o={x:shooter.self.x,y:shooter.self.y+shooter.self.eyeHeight,z:shooter.self.z},v={x:point.x-o.x,y:point.y-o.y,z:point.z-o.z},length=Math.hypot(v.x,v.y,v.z);for(const k of ['x','y','z'])v[k]/=length;if(!rayHitVolumes(o,v,sampleHitVolumes(target.self,target.snapshot.time)))gap=point;}
 assert.ok(gap,'replicated rig has a visible inter-leg ray gap');
 const gapShots=await shootAt(gap);check('a shot through the animated leg gap misses for both clients',()=>{for(const shot of gapShots)assert.equal(shot.hit,null);assert.equal(target.self.hp,100);});
 const stanceSeq=target.input({stance:'prone',pitch:0,yaw:Math.atan2(shooter.self.x-target.self.x,shooter.self.z-target.self.z)});
 await eventually(()=>target.self.ack>=stanceSeq&&target.self.pose.prone>.999,'prone transition settles');await delay(200);
 const proneHead=head();check('prone head is forward of the hips, matching the horizontal model',()=>{assert.ok(Math.hypot(proneHead.center.x-target.self.x,proneHead.center.z-target.self.z)>.45);assert.ok(proneHead.center.y<.65);});
 const shots=await shootAt(proneHead.center);await eventually(()=>target.self.deaths===1,'prone headshot kills');
 check('an actual prone headshot is an instant authoritative kill on both clients',()=>{for(const shot of shots){assert.equal(shot.hit,target.actorId);assert.equal(shot.headshot,true);}assert.equal(shooter.self.kills,1);assert.equal(target.self.hp,0);assert.equal(target.self.deaths,1);});
 console.log(`Hitbox WebSocket integration: ${checks} checks passed (two clients, normal movement, no teleports/test hooks).`);
}catch(error){console.error(error.stack??String(error));if(diagnostics)console.error(diagnostics);process.exitCode=1;}
finally {for(const c of clients)c.close();if(backend){backend.kill('SIGINT');await Promise.race([new Promise(resolve=>backend.once('exit',resolve)),delay(2000)]);if(backend.exitCode===null)backend.kill('SIGKILL');}if(temporary)await rm(temporary,{recursive:true,force:true});}
