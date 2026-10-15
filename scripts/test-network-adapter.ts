/** Run against an explicitly selected local test server:
 * BOLTS_TEST_URL=http://127.0.0.1:8080 node --import tsx scripts/test-network-adapter.ts */
import assert from 'node:assert/strict';
import {Game} from '../src/engine.ts';
import {NetworkClient,type SocketLike} from '../src/network.ts';
const origin=process.env.BOLTS_TEST_URL;
if(!origin)throw new Error('Set BOLTS_TEST_URL to the test server.');
const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check:()=>boolean,label:string,timeout=5000){const start=performance.now();while(!check()){if(performance.now()-start>timeout)throw new Error(`Timed out: ${label}`);await pause(20);}}
const idle={forward:0,right:0,jump:false,walk:false,lean:0};
function user(name:string){
 const game=new Game(),store=new Map<string,string>(),sockets:SocketLike[]=[],chat:string[]=[],statuses:string[]=[];let joins=0;
 const network=new NetworkClient(game,{origin,storage:{getItem:key=>store.get(key)??null,setItem:(k,v)=>void store.set(k,v),removeItem:k=>void store.delete(k)},socket:url=>{const socket=new WebSocket(url);sockets.push(socket);return socket;}});
 network.onChat=line=>chat.push(line.message);network.onStatus=text=>statuses.push(text);network.onJoined=()=>joins++;network.onFailure=message=>{throw new Error(`${name}: ${message}`);};
 return{name,game,network,store,sockets,chat,statuses,get joins(){return joins;},input:{...idle}};
}
type TestUser=ReturnType<typeof user>;
const poseFields=['phase','crouch','prone','aim','speed','forward','sideways'] as const;
function sharedPose(a:TestUser,b:TestUser,name:string){
 const first=[...a.game.history].reverse().find(frame=>b.game.history.some(other=>Math.abs(other.time-frame.time)<1e-8));
 assert.ok(first,'both real clients retain a common authoritative tick');
 const second=b.game.history.find(frame=>Math.abs(frame.time-first.time)<1e-8)!;
 const leftId=a.game.actors.find(actor=>actor.name===name)!.id,rightId=b.game.actors.find(actor=>actor.name===name)!.id;
 const left=first.actors.find(actor=>actor.id===leftId)!,right=second.actors.find(actor=>actor.id===rightId)!;
 assert.ok(left.pose&&right.pose,'the server supplies complete animation state');
 for(const key of poseFields){assert.ok(Number.isFinite(left.pose[key]));assert.equal(left.pose[key],right.pose[key],`${name}: ${key} agrees at the same server time despite client ID remapping`);}
 assert.notEqual(left.pose,right.pose,'each browser owns independent snapshot state');
 return left.pose;
}
function remotePoseInterpolates(user:TestUser,name:string){
 user.network.present();const target=user.network.remoteTime,history=user.game.history;
 const after=history.find(frame=>frame.time>=target)??history.at(-1)!,index=history.indexOf(after),before=history[Math.max(0,index-1)];
 const shown=user.game.actors.find(actor=>actor.name===name)!,a=before.actors.find(actor=>actor.id===shown.id)!,b=after.actors.find(actor=>actor.id===shown.id)!;
 assert.ok(a.pose&&b.pose&&shown.pose);const alpha=Math.max(0,Math.min(1,(target-before.time)/(after.time-before.time||1)));
 for(const key of poseFields)assert.ok(Math.abs(shown.pose[key]-(a.pose[key]+(b.pose[key]-a.pose[key])*alpha))<1e-6,`${key}: remote rendering follows the buffered authoritative pose timeline`);
 assert.notEqual(shown.pose,a.pose,'presentation cannot mutate an earlier authoritative pose');
 assert.notEqual(shown.pose,b.pose,'presentation cannot mutate a later authoritative pose');
}
const a=user('Adapter Alpha'),b=user('Adapter Beta');let timer:ReturnType<typeof setInterval>|undefined;
try{
 await a.network.join(undefined,a.name,'british');await b.network.join(a.network.lobbyId,b.name,'german');
 timer=setInterval(()=>{a.network.update(1/60,a.input);b.network.update(1/60,b.input);},1000/60);
 await until(()=>a.game.actors.length===2&&b.game.actors.length===2&&a.game.history.some(frame=>b.game.history.some(other=>other.time===frame.time)),'both clients see the same roster and authoritative tick');
 assert.equal(a.game.player.name,a.name);assert.equal(b.game.player.name,b.name);assert.equal(a.game.actors[1].name,b.name);assert.equal(b.game.actors[1].name,a.name);
 const initialPose=sharedPose(a,b,a.name),frozenPose={...initialPose};
 const start={x:a.game.player.x,z:a.game.player.z};a.input.forward=1;await pause(650);
 const walkingPose=sharedPose(a,b,a.name);assert.ok(walkingPose.phase>frozenPose.phase+.1,'server advances the locomotion phase while moving');assert.ok(walkingPose.speed>0,'server provides movement speed for the shared gait');remotePoseInterpolates(b,a.name);
 assert.deepEqual(initialPose,frozenPose,'prediction/reconciliation cannot mutate retained history poses');
 a.input.forward=0;await pause(300);
 assert.ok(Math.hypot(a.game.player.x-start.x,a.game.player.z-start.z)>.2,'predicted player moved');
 const remote=b.game.actors.find(actor=>actor.name===a.name)!;assert.ok(Math.hypot(remote.x-a.game.player.x,remote.z-a.game.player.z)<.15,'remote view converged to server position');
 a.network.setADS(true);a.network.toggleStance('crouch');await pause(400);assert.equal(a.game.player.stance,'crouch');assert.equal(a.game.player.ads,true);assert.ok(Math.abs(a.game.player.eyeHeight-1.05)<.01);
 const crouchPose=sharedPose(a,b,a.name);assert.ok(crouchPose.crouch>.95&&crouchPose.prone<.01&&crouchPose.aim>.95,'both users see the authoritative crouched aiming pose');remotePoseInterpolates(b,a.name);
 a.network.fire();await until(()=>a.game.player.ammo===9,'server confirms shot ammunition');await pause(100);assert.ok(a.game.shots.some(shot=>shot.actor===0));assert.ok(b.game.shots.some(shot=>shot.actor===1));
 const ownShot=a.game.shots.find(shot=>shot.actor===0)!,otherShot=b.game.shots.find(shot=>shot.actor===1&&Math.abs(shot.time-ownShot.time)<1e-8)!;assert.ok(otherShot,'the same authoritative shot reaches both clients');
 assert.deepEqual(otherShot.origin,ownShot.origin);assert.deepEqual(otherShot.end,ownShot.end);assert.equal(otherShot.headshot,ownShot.headshot);assert.equal(otherShot.kind,ownShot.kind);
 assert.equal(otherShot.hit===null?null:b.game.actors[otherShot.hit]?.name,ownShot.hit===null?null:a.game.actors[ownShot.hit]?.name,'shot victim IDs map to the same player');
 a.network.reload();await until(()=>a.game.player.reload>0,'server confirms reload');await until(()=>a.game.player.reload===0&&a.game.player.ammo===10,'server finishes reload',5000);assert.equal(a.game.player.ammo+a.game.player.reserve,149);
 const chat='adapter chat <b>plain text</b>';a.network.chat(chat);await until(()=>a.chat.includes(chat)&&b.chat.includes(chat),'room chat delivered to both identities');
 const beforeTime=a.game.time;a.network.setPaused(true);a.input.forward=1;const stopped={x:a.game.player.x,z:a.game.player.z};await pause(250);assert.equal(a.game.state,'paused');assert.ok(a.game.time>beforeTime+.15);assert.ok(Math.hypot(a.game.player.x-stopped.x,a.game.player.z-stopped.z)<.1);a.input.forward=0;a.network.setPaused(false);
 const token=[...a.store.values()][0],joins=a.joins;a.sockets.at(-1)!.close();await until(()=>a.joins>joins,'automatic reconnection',7000);assert.equal([...a.store.values()][0],token);assert.equal(a.game.actors.length,2);assert.equal(a.game.player.ammo+a.game.player.reserve,149);
 const scores={kills:a.game.player.kills,deaths:a.game.player.deaths};a.network.spectate();
 await until(()=>a.game.player.spectator&&b.game.actors.find(actor=>actor.name===a.name)?.spectator===true,'both clients confirm spectator mode');
 assert.equal(a.game.player.alive,false);assert.equal(a.game.state,'playing');assert.deepEqual({kills:a.game.player.kills,deaths:a.game.player.deaths},scores);
 const spectatorBody={x:a.game.player.x,y:a.game.player.y,z:a.game.player.z,ammo:a.game.player.ammo,reserve:a.game.player.reserve};
 a.input.forward=1;a.network.fire();a.network.reload();a.network.setADS(true);a.network.selectWeapon('grenade');await pause(250);a.input.forward=0;
 assert.deepEqual({x:a.game.player.x,y:a.game.player.y,z:a.game.player.z,ammo:a.game.player.ammo,reserve:a.game.player.reserve},spectatorBody,'spectator controls cannot mutate combat state');
 a.game.spectator.cycle(a.game.actors,1);assert.equal(a.game.viewedActor?.name,b.name);
 b.network.setADS(true);await until(()=>a.game.viewedActor?.ads===true,'follow receives remote aiming');
 b.network.spectate();await until(()=>a.game.actors.find(actor=>actor.name===b.name)?.spectator===true,'follow target becomes spectator');a.game.spectator.sync(a.game.actors);assert.equal(a.game.spectator.following,false,'no eligible target falls back to free flight');
 b.network.setFaction('german');await until(()=>!b.game.player.spectator&&b.game.player.alive,'second user returns to combat');
 const spectatorJoins=a.joins;a.sockets.at(-1)!.close();await until(()=>a.joins>spectatorJoins,'spectator reconnect',7000);assert.equal(a.game.player.spectator,true,'reconnect keeps spectator mode');
 a.game.spectator.cycle(a.game.actors,1);assert.equal(a.game.viewedActor?.name,b.name);
 b.network.disconnect();await until(()=>a.game.actors.length===1,'departed player removed');assert.equal(a.game.spectator.following,false,'departure falls back to free flight');
 a.network.setFaction('british');await until(()=>!a.game.player.spectator&&a.game.player.alive,'loadout returns spectator to combat');assert.deepEqual({kills:a.game.player.kills,deaths:a.game.player.deaths},scores);assert.equal(a.game.player.ammo+a.game.player.reserve,150);

 a.network.disconnect();a.game.start('russian','regular');a.game.update(1/60,idle);assert.equal(a.game.actors.length,6);assert.equal(a.network.online,false);
 console.log('PASS: two actual NetworkClient users — identity, roster, prediction/reconciliation, remote movement, shared authoritative gait/stance/aim, independent pose history, pose interpolation, identical shot rays, crouch ADS, firing, reload, chat, live menu, reconnect, spectator inputs/follow/return, spectator reconnect, departure, local AI.');
}finally{if(timer)clearInterval(timer);a.network.disconnect();b.network.disconnect();}
