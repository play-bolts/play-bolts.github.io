/// <reference types="vite/client" />
import './style.css';
import {DefaultLoadingManager,WebGLRenderer} from 'three';
import {UI} from './ui';
import {Game,createActor,type Input} from './engine';
import {View} from './renderer';
import {Sound} from './audio';
import {RULES,SPAWNS,clamp} from './config';
import {playerNameHTML} from './names';
import {weaponIcon} from './weaponIcons';
import {preloadModelDetails} from './modelDetails';
import {preloadImportedWeapons} from './importedWeapons';
import {loadHandAssets} from './hands';
import {preloadHumanHead} from './humanHead';
import {preloadSoldierMaterials} from './soldier';
import {preloadSurfaceAssets} from './materials';
import {NetworkClient,type Lobby} from './network';
import {readLaunchAction} from './launch';
import {CommunityClient} from './community';
import {AdaptiveResolution} from './adaptiveResolution';
import {startVisitorTracking} from './visitors';
startVisitorTracking();
const ui=new UI(),game=new Game(),sound=new Sound(),network=new NetworkClient(game),community=new CommunityClient();
let launchAction=readLaunchAction(location.search);
// Keep progress tied to completed asset requests, reserving the last step for
// scene construction and the first rendered frame.
DefaultLoadingManager.onProgress=(_url,loaded,total)=>ui.setLoadingProgress(.85*loaded/total);
let graphics:WebGLRenderer;
try{graphics=new WebGLRenderer({antialias:true,powerPreference:'high-performance'});}catch(error){ui.el.loading.classList.add('hidden');ui.el['load-error'].classList.remove('hidden');ui.el['load-error'].textContent='WebGL 2 required';throw error;}
try{await Promise.all([loadHandAssets(),preloadHumanHead(),preloadSoldierMaterials(),preloadSurfaceAssets(graphics),preloadModelDetails(),preloadImportedWeapons()]);ui.setLoadingProgress(.9);}catch(error){ui.el.loading.classList.add('hidden');ui.el['load-error'].classList.remove('hidden');ui.el['load-error'].innerHTML='<div class="dialog"><h2>Unable to load models</h2><button onclick="location.reload()">Retry</button></div>';throw error;}finally{DefaultLoadingManager.onProgress=()=>{};}
let view:View;
try{view=new View(ui.el.world,graphics);view.setQuality(ui.prefs.quality);ui.setLoadingProgress(.95);await view.prepare();}catch(error){ui.el.loading.classList.add('hidden');ui.el['load-error'].classList.remove('hidden');ui.el['load-error'].innerHTML='<div class="dialog"><h2>Unable to initialize graphics</h2><button class="start-button" onclick="location.reload()">Reload</button></div>';throw error;}
const keys=new Set<string>();let menu=true,previous=performance.now(),accumulator=0,resumeState:'playing'|'killcam'='playing',dragMode=false,dragging=false,previousX=0,previousY=0,jump=false,endingReleased=false,lastReplaySound=-1;
let appliedQuality:string|undefined;
const resolution=new AdaptiveResolution();
let qaLean:number|null=null,joining=false,equipRifle=false,onlineEntered=false,lobbyFetchBusy=false,lobbyFetchTime=0;
let lobbyRequest=0,onlineSelection=false;let requestedLobby:string|undefined;let lobbyRows:Lobby[]=[];
let communityStatusBusy=false,communityStatusTime=-Infinity,leaderboardBusy=false;
async function refreshOnlineCount(){
 if(communityStatusBusy)return;communityStatusBusy=true;communityStatusTime=performance.now();
 try{ui.setOnlineCount(await community.status());}catch{ui.setOnlineCount(null);}finally{communityStatusBusy=false;}
}
ui.feedbackSend=(message,email)=>community.feedback(message,email);
ui.leaderboardLoad=()=>{
 if(leaderboardBusy)return;leaderboardBusy=true;ui.setLeaderboardStatus('Loading…',true);
 void community.leaderboard().then(data=>ui.setLeaderboard(data)).catch(()=>ui.setLeaderboardStatus('Unable to load leaderboard.')).finally(()=>{leaderboardBusy=false;});
};
function syncSettings(){game.difficulty=ui.prefs.difficulty;sound.setVolume(ui.prefs.volume);if(appliedQuality!==ui.prefs.quality){view.setQuality(ui.prefs.quality);resolution.setBase(view.renderer.getPixelRatio());appliedQuality=ui.prefs.quality;}game.setPlayerName(ui.prefs.playerName);network.setName(ui.prefs.playerName);if(menu)view.setFaction(ui.prefs.faction);}
ui.settingsChanged=syncSettings;syncSettings();
function capture(){const canvas=view.renderer.domElement;try{const promise=canvas.requestPointerLock();if(promise)promise.catch(()=>{dragMode=true;ui.toast('Drag or arrow keys to look.');});}catch{dragMode=true;ui.toast('Drag or arrow keys to look.');}}
function start(){sound.resetScene();network.disconnect();onlineEntered=false;onlineSelection=false;ui.setOnline(false);equipRifle=false;sound.init();sound.click();game.start(ui.prefs.faction,ui.prefs.difficulty,ui.prefs.playerName);view.setupActors(game);menu=false;joining=true;resumeState='playing';game.state='paused';ui.begin();keys.clear();jump=false;endingReleased=false;accumulator=0;ui.openSelection();}
function pause(){if(game.state==='playing'||game.state==='killcam'){resumeState=game.state;if(network.online)network.setPaused(true);else game.state='paused';keys.clear();jump=false;if(game.player)game.player.ads=false;}}
function resume(){sound.init();if(network.online)network.setPaused(false);else game.state=resumeState;ui.closeModal();keys.clear();jump=false;capture();}
function leave(){sound.resetScene();game.spectator.reset();network.disconnect();onlineEntered=false;onlineSelection=false;requestedLobby=undefined;lobbyRequest++;menu=true;joining=false;equipRifle=false;game.state='menu';document.exitPointerLock();ui.closeModal();ui.showMenu();keys.clear();for(const s of view.soldiers)s.visible=false;}
ui.start=start;ui.resume=resume;ui.pause=()=>{pause();document.exitPointerLock();};ui.leave=leave;ui.skip=()=>network.online?network.skipReplay():game.skipReplay();
function selectInGame(){
 if(menu||game.state==='ended')return;pause();document.exitPointerLock();ui.prefs.faction=game.player.faction;ui.openSelection();
}
ui.selectTeam=selectInGame;
ui.cancelSelection=()=>{ui.prefs.faction=game.player.faction;ui.refreshSelection();ui.save();if(joining){leave();return;}ui.closeSelection();};
function joinOnline(spectator=false){
 if(network.online)return;const request=lobbyRequest;ui.setSelectionBusy(true);ui.save();
 void network.join(requestedLobby,ui.prefs.playerName,ui.prefs.faction,spectator).catch(error=>{if(request!==lobbyRequest)return;leave();lobbyFetchTime=performance.now();ui.showLobbies(lobbyRows,error instanceof Error?error.message:'Unable to connect.');}).finally(()=>{if(request===lobbyRequest){ui.setSelectionBusy(false);ui.refreshSelection();}});
}
ui.selectSpectator=()=>{
 if(onlineSelection){joinOnline(true);return;}
 if(network.online)network.spectate();else game.spectate();
 sound.resetScene();resumeState='playing';joining=false;equipRifle=false;ui.damageUntil=0;ui.damageStarted=-Infinity;ui.closeSelection();resume();
};
ui.selectLoadout=()=>{
 if(onlineSelection){joinOnline();return;}
 if(network.online){network.setFaction(ui.prefs.faction);ui.save();ui.closeSelection();joining=false;resume();network.selectWeapon('rifle');return;}
 const changed=game.changePlayerFaction(ui.prefs.faction);
 if(changed){view.syncActors(game);resumeState='playing';}
 ui.save();ui.closeSelection();joining=false;resume();equipRifle=game.state==='playing'&&game.player.selectedWeapon!=='rifle';
};
function fire(melee=false){if(network.online)network.fire(melee);else game.fire(game.player,melee);}
function reload(){if(network.online)network.reload();else game.reload();}
function setStance(stance:'crouch'|'prone'){if(network.online)network.toggleStance(stance);else game.setStance(stance);}
function selectWeapon(weapon:'rifle'|'grenade'){if(network.online)network.selectWeapon(weapon);else game.selectWeapon(weapon);}
function setADS(ads:boolean){if(network.online)network.setADS(ads);else game.player.ads=ads;}
async function refreshLobbies(){
 if(lobbyFetchBusy)return;lobbyFetchBusy=true;lobbyFetchTime=performance.now();const request=lobbyRequest;
 try{const rows=await network.lobbies();if(request===lobbyRequest&&ui.lobbyOpen&&!network.online){lobbyRows=rows;ui.showLobbies(rows);}}
 catch(error){if(request===lobbyRequest&&ui.lobbyOpen&&!network.online)ui.setLobbyStatus(error instanceof Error?error.message:'Unable to load servers.');}
 finally{lobbyFetchBusy=false;}
}
ui.multiplayer=()=>{sound.init();sound.click();ui.showLobbies([],'Loading…');void refreshLobbies();};
ui.refreshLobbies=()=>void refreshLobbies();ui.lobbyBack=()=>{lobbyRequest++;if(!onlineEntered)network.disconnect();ui.closeLobbies();};
ui.joinLobby=id=>{
 if(network.online||onlineSelection)return;sound.init();onlineSelection=true;requestedLobby=id;menu=false;joining=true;keys.clear();jump=false;accumulator=0;
 // Choose the initial loadout before joining the server. This is a stationary
 // arena backdrop: no AI, live player, reserved seat, or vulnerable spawn.
 const actor=createActor(0,ui.prefs.faction,ui.prefs.playerName);Object.assign(actor,SPAWNS[0]);actor.yaw=Math.atan2(-actor.x,-actor.z);
 game.actors=[actor];game.time=0;game.remaining=RULES.roundSeconds;game.state='paused';game.events=[];game.history=[];game.replay=[];game.replayShots=[];game.shots=[];game.winner=null;
 view.setupActors(game);ui.closeLobbies();ui.setOnline(true);ui.begin();ui.openSelection();
};
network.onRoster=()=>{sound.resetScene();view.syncActors(game);};
network.onJoined=name=>{
 ui.setOnline(true,name);ui.setNetworkStatus('');if(onlineEntered)return;
 onlineEntered=true;onlineSelection=false;menu=false;joining=false;resumeState='playing';keys.clear();jump=false;endingReleased=false;accumulator=0;equipRifle=false;ui.closeLobbies();ui.begin();network.setPaused(false);capture();
};
network.onStatus=text=>{if(onlineEntered)ui.setNetworkStatus(text);else if(ui.lobbyOpen)ui.setLobbyStatus(text,!!text&&network.online);};
network.onFailure=message=>{leave();lobbyFetchTime=performance.now();ui.showLobbies(lobbyRows,message);};
network.onChat=message=>ui.addChat(message);
network.onRound=()=>{sound.resetScene();endingReleased=false;ui.feed=[];ui.killUntil=0;ui.damageUntil=0;ui.damageStarted=-Infinity;lastReplaySound=-1;};
ui.chatSend=text=>network.chat(text);
ui.chatOpened=()=>{keys.clear();jump=false;dragging=false;network.clearInput();document.exitPointerLock();};
ui.chatClosed=()=>{keys.clear();jump=false;if(network.online&&!menu&&!ui.selectionOpen&&!ui.modalOpen&&game.state==='playing')capture();};
window.addEventListener('pagehide',()=>network.disconnect());
function spectatorExit(source:'key'|'unlock'){
 if(!game.player?.spectator||game.state!=='playing'||!game.spectator.handleExit(source,performance.now(),game.actors))return false;
 keys.clear();jump=false;dragging=false;return true;
}
document.addEventListener('pointerlockchange',()=>{
 if(document.pointerLockElement){dragMode=false;return;}
 if(menu||game.state==='ended'||dragMode||ui.chatOpen||ui.selectionOpen||ui.modalOpen)return;
 if(spectatorExit('unlock'))return;pause();
});
document.addEventListener('visibilitychange',()=>{if(document.hidden&&!menu){pause();document.exitPointerLock();}});
window.addEventListener('blur',()=>{keys.clear();if(!menu){pause();document.exitPointerLock();}});
document.addEventListener('contextmenu',e=>{if(!menu)e.preventDefault();});
function look(dx:number,dy:number){if(!game.player||game.state!=='playing'||ui.chatOpen||ui.selectionOpen||ui.modalOpen)return;const a=game.player,scale=.0018*ui.prefs.sensitivity*(!a.spectator&&a.ads?.68:1);if(a.spectator){game.spectator.look(-dx*scale,-dy*scale*(ui.prefs.invert?-1:1));return;}a.yaw-=dx*scale;a.pitch=clamp(a.pitch-dy*scale*(ui.prefs.invert?-1:1),-1.43,1.43);}
document.addEventListener('mousemove',e=>{if(document.pointerLockElement)look(e.movementX,e.movementY);else if(game.player?.spectator&&!game.spectator.following&&e.target===view.renderer.domElement)look(e.movementX,e.movementY);else if(dragMode&&dragging)look(e.clientX-previousX,e.clientY-previousY);previousX=e.clientX;previousY=e.clientY;});
view.renderer.domElement.addEventListener('mousedown',e=>{
 if(menu||ui.selectionOpen||ui.modalOpen||ui.chatOpen)return;if(game.state==='paused'){resume();return;}if(game.state!=='playing')return;if(game.player.spectator){if(e.button===0||e.button===2){game.spectator.cycle(game.actors,e.button===0?1:-1);if(!document.pointerLockElement&&!dragMode)capture();}return;}if(!document.pointerLockElement&&!dragMode){capture();return;}
 sound.init();if(e.button===0){fire();dragging=true;previousX=e.clientX;previousY=e.clientY;}if(e.button===2&&game.canADS())setADS(ui.prefs.aim==='hold'?true:!game.player.ads);
});
view.renderer.domElement.addEventListener('wheel',e=>{if(menu||ui.selectionOpen||ui.modalOpen||ui.chatOpen||game.state!=='playing'||game.player.spectator)return;e.preventDefault();if(Math.abs(e.deltaY)>.01)selectWeapon(game.player.selectedWeapon==='rifle'?'grenade':'rifle');},{passive:false});
document.addEventListener('mouseup',e=>{if(e.button===0)dragging=false;if(e.button===2&&ui.prefs.aim==='hold'&&game.player)setADS(false);});
document.addEventListener('keydown',e=>{
 if(ui.handleChatKey(e))return;
 if(e.code==='Escape'&&ui.modalOpen){ui.closeModal();return;}
 if(ui.modalOpen){ui.handleModalKey(e);return;}
 if((e.target as HTMLElement).matches('input,textarea,select'))return;
 if(menu||ui.selectionOpen){ui.handleMenuKey(e);return;}
 if(['Space','Tab','AltLeft','AltRight','ControlLeft','ControlRight','ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.code))e.preventDefault();
 if(e.code==='KeyM'&&!e.repeat&&game.state!=='ended'){selectInGame();return;}
 if(e.code==='Tab'){ui.scoreHeld=true;return;}
 if(e.code==='Escape'){if(spectatorExit('key'))return;if(game.state==='paused')resume();else{pause();document.exitPointerLock();}return;}
 if(game.state==='killcam'&&e.code==='Space'){ui.skip();return;}
 if(game.state!=='playing'||ui.modalOpen)return;keys.add(e.code);if(game.player.spectator){if(!e.repeat&&!game.spectator.following&&!document.pointerLockElement&&['KeyW','KeyA','KeyS','KeyD','Space','ControlLeft','ControlRight'].includes(e.code))capture();return;}if(e.repeat)return;
 if(e.code==='Digit1'||e.code==='Numpad1')selectWeapon('rifle');if(e.code==='Digit2'||e.code==='Numpad2')selectWeapon('grenade');
 // Space also stands up from crouch/prone. The simulation clears ADS only if
 // this input actually leaves the ground, preserving aim through stance changes.
 if(e.code==='Space')jump=true;if(e.code==='KeyR')reload();if(e.code==='KeyC')setStance('crouch');if(e.code==='ControlLeft'||e.code==='ControlRight')setStance('prone');if(e.code==='ShiftLeft'||e.code==='ShiftRight')fire(true);
});
document.addEventListener('keyup',e=>{ui.releaseChatKey(e.code);keys.delete(e.code);if(e.code==='Tab'){ui.scoreHeld=false;e.preventDefault();}});
function updateAudioScene(){
 sound.beginSceneUpdate();
 const viewed=game.state==='killcam'?game.actors[game.killer]:game.viewedActor;
 const replay=game.state==='killcam'?game.replayFrame()?.actors[game.killer]:null;
 const listener=replay?{...viewed!,...replay}:viewed;
 sound.updateListener(listener?game.eye(listener):game.spectator.position,listener?.yaw??game.spectator.yaw,listener?listener.pitch+listener.recoil:game.spectator.pitch);
 for(const actor of game.actors){
  if(actor.spectator){sound.stopActor(actor.id);continue;}
  sound.updateEmitter({actor:actor.id,position:game.eye(actor),local:actor.id===viewed?.id,faction:actor.faction});
  if(!actor.alive||!actor.reload||game.state==='menu'||game.state==='ended')sound.cancelReload(actor.id);
 }
 sound.endSceneUpdate();
}
function processEvents(){
 updateAudioScene();const viewed=game.viewedActor;
 for(const event of game.events){const a=game.actors[event.actor];if(!a)continue;
  const emitter={actor:a.id,position:game.eye(a),local:a.id===viewed?.id,faction:a.faction};
  if(event.type==='shot'&&event.shot){view.effect(event.shot,emitter.local);if(event.shot.kind==='shot')sound.shot({...emitter,position:event.shot.origin});else sound.melee(emitter);}
  if(event.type==='bolt')sound.bolt(emitter);if(event.type==='reload')sound.reload(emitter);if(event.type==='step')sound.step(event.value??3,emitter);
  if(event.type==='hurt'&&event.actor===0&&!game.player.spectator){ui.showDamage(!game.player.alive);sound.hit();}
  if(event.type==='switch')sound.switch(emitter);
  if(event.type==='kill'){const victim=game.actors[event.victim!];if(!victim)continue;ui.feed.push({text:`${playerNameHTML(a.name)}${weaponIcon(a.faction,event.weapon??'rifle',!!event.headshot)}${playerNameHTML(victim.name)}`,time:performance.now()});if(ui.feed.length>5)ui.feed.shift();if(a.id===0&&victim.id!==0&&!game.player.spectator)ui.showKill(victim.name);}
  if(event.type==='spawn'&&event.actor===0){ui.damageUntil=0;ui.damageStarted=-Infinity;ui.hitUntil=0;view.setFaction(game.player.faction);}
 }
 game.events=[];
}
function frame(now:number){
 const frameMs=now-previous,dt=Math.min(frameMs/1000,.075);previous=now;
 const ratio=resolution.sample(frameMs,!document.hidden&&!menu&&!ui.selectionOpen&&!ui.modalOpen&&game.state==='playing');if(ratio!==null){view.renderer.setPixelRatio(ratio);view.resize();}
 if(!menu){
  const input:Input={forward:Number(keys.has('KeyW'))-Number(keys.has('KeyS')),right:Number(keys.has('KeyD'))-Number(keys.has('KeyA')),jump,walk:keys.has('AltLeft')||keys.has('AltRight'),lean:import.meta.env.DEV&&qaLean!==null?qaLean:Number(keys.has('KeyE'))-Number(keys.has('KeyQ'))};
  if(equipRifle&&game.state==='playing'&&!game.isSwitching()){game.selectWeapon('rifle');equipRifle=false;}
  if(game.state==='playing'){look((Number(keys.has('ArrowRight'))-Number(keys.has('ArrowLeft')))*dt*850,(Number(keys.has('ArrowDown'))-Number(keys.has('ArrowUp')))*dt*650);}
  const step=network.online?1/60:1/120;accumulator+=dt;while(accumulator>=step){if(network.online)network.update(step,input,!ui.chatOpen&&!ui.modalOpen&&!ui.selectionOpen);else game.update(step,input);input.jump=false;jump=false;accumulator-=step;}
  if(network.online)network.present(accumulator/step);if(game.player.spectator){game.spectator.sync(game.actors);if(game.state==='playing'&&!ui.chatOpen&&!ui.modalOpen&&!ui.selectionOpen)game.spectator.move(dt,{forward:input.forward,right:input.right,up:Number(keys.has('Space'))-Number(keys.has('ControlLeft')||keys.has('ControlRight')),fast:keys.has('ShiftLeft')||keys.has('ShiftRight')});}
  processEvents();if(game.state==='killcam'){if(lastReplaySound<0)lastReplaySound=game.replayTime;for(const shot of game.replayShots)if(shot.time>lastReplaySound&&shot.time<=game.replayTime&&shot.kind==='shot')sound.shot({actor:shot.actor,position:shot.origin,local:shot.actor===game.killer,faction:game.actors[shot.actor]?.faction});lastReplaySound=game.replayTime;}else lastReplaySound=-1;
  ui.update(game,network.online&&network.waitingForRespawn);if(game.state==='ended'&&!endingReleased){endingReleased=true;document.exitPointerLock();keys.clear();jump=false;dragging=false;equipRifle=false;}
 }
 if(menu&&!document.hidden&&now-communityStatusTime>15000)void refreshOnlineCount();
 if(menu&&ui.lobbyOpen&&!network.online&&!lobbyFetchBusy&&now-lobbyFetchTime>5000)void refreshLobbies();
 view.render(game,dt,menu||ui.selectionOpen,menu,network.online?network.remoteTime:game.time,network.online?network.localPosition:null);
 if(!ui.ready){
  ui.setReady(true);
  if(launchAction){
   const action=launchAction;launchAction=null;
   const address=new URL(location.href);address.searchParams.delete('launch');history.replaceState(null,'',address);
   if(action==='singleplayer')start();else if(action==='multiplayer')ui.multiplayer();else ui.openModal(action==='options'?'settings':'controls');
  }
 }
 requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
// Development-only inspection surface for deterministic browser QA; Vite removes it from production.
if(import.meta.env.DEV)Object.assign(window,{__bolts:{game,view,ui,network,start,leave}});
if(import.meta.env.DEV&&new URLSearchParams(location.search).get('qa')==='1')void import('./qa').then(({mountQA})=>mountQA(game,value=>{qaLean=value;}));
