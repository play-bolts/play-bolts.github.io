/// <reference types="vite/client" />
import './style.css';
import {DefaultLoadingManager,WebGLRenderer} from 'three';
import {UI} from './ui';
import {Game,createActor,type Input} from './engine';
import {View} from './renderer';
import {Sound} from './audio';
import {playCombatSound,playImpactSound} from './combatAudio';
import {RULES,SPAWNS,clamp} from './config';
import {playerNameHTML} from './names';
import {weaponIcon} from './weaponIcons';
import {preloadSoldierModels} from './soldierModelAssets';
import {preloadImportedWeapons} from './importedWeapons';
import {loadHandAssets} from './hands';
import {preloadSurfaceAssets} from './materials';
import {NetworkClient,type Lobby} from './network';
import {readLaunchAction} from './launch';
import {CommunityClient} from './community';
import {AdaptiveResolution} from './adaptiveResolution';
import {PointerCapture} from './pointerCapture';
import {TouchControls} from './touchControls';
import {yieldLoadingPaint} from './scenePreparation';
import {startVisitorTracking} from './visitors';
import {assetTierForQuality,setInitialAssetTier,changeAssetTier} from './assetTiers';
import {preloadWorldModelLods} from './worldModelLod';
startVisitorTracking();
const ui=new UI(),game=new Game(),sound=new Sound(),network=new NetworkClient(game),community=new CommunityClient();
const touchMedia=matchMedia('(pointer: coarse)');
const mobileDevice=()=>navigator.maxTouchPoints>0&&touchMedia.matches;
const wantsTouch=()=>ui.prefs.controlsMode==='touch'||ui.prefs.controlsMode==='auto'&&mobileDevice();
let launchAction=readLaunchAction(location.search);
// Resource counts exclude the expensive scene/GPU work. Give assets less than
// half the bar, then advance through the actual preparation steps below.
DefaultLoadingManager.onProgress=(_url,loaded,total)=>{if(total>0)ui.setLoadingProgress(.35*loaded/total);};
let graphics:WebGLRenderer;
try{graphics=new WebGLRenderer({antialias:true,powerPreference:'high-performance'});}catch(error){ui.hideLoading();ui.el['load-error'].classList.remove('hidden');ui.el['load-error'].textContent='WebGL 2 required';throw error;}
try{
 setInitialAssetTier(assetTierForQuality(ui.prefs.quality));
 const resources=[loadHandAssets(),preloadSoldierModels(),preloadSurfaceAssets(graphics,{includeLegacy:false}),preloadImportedWeapons(),preloadWorldModelLods()];let completed=0;
 await Promise.all(resources.map(resource=>resource.then(()=>ui.setLoadingProgress(.45*++completed/resources.length))));
}catch(error){ui.hideLoading();ui.el['load-error'].classList.remove('hidden');ui.el['load-error'].innerHTML='<div class="dialog"><h2>Unable to load models</h2><button onclick="location.reload()">Retry</button></div>';throw error;}finally{DefaultLoadingManager.onProgress=()=>{};}
let view:View;
try{await yieldLoadingPaint();view=new View(ui.el.world,graphics);view.setQuality(ui.prefs.quality,wantsTouch());ui.setLoadingProgress(.5);await view.prepare(progress=>ui.setLoadingProgress(.5+.48*progress));}catch(error){ui.hideLoading();ui.el['load-error'].classList.remove('hidden');ui.el['load-error'].innerHTML='<div class="dialog"><h2>Unable to initialize graphics</h2><button class="start-button" onclick="location.reload()">Reload</button></div>';throw error;}
const keys=new Set<string>();let menu=true,previous=performance.now(),accumulator=0,resumeState:'playing'|'killcam'='playing',dragging=false,previousX=0,previousY=0,jump=false,endingReleased=false,lastReplaySound=-1;
const mouseCapture=new PointerCapture(view.renderer.domElement,document);let lastPointerUnlock=-Infinity;
let touchEnabled=wantsTouch(),mobilePortrait=innerHeight>=innerWidth,mobileResumeRequired=false,touchLife='',touchTap=false,touchWasActive=false;
const touch=new TouchControls({move:ui.el['touch-move'],fire:ui.el['touch-fire'],look:ui.el['touch-look']},{
 look:(dx,dy)=>{if(canTouchPlay())look(dx,dy,1);},
 fire:()=>{if(canTouchPlay()&&!game.player.spectator){sound.init();touchTap=true;}},
 jump:()=>{if(canTouchPlay()&&!game.player.spectator)jump=true;},
 fireReleased:cancelled=>{network.clearFire(cancelled);if(cancelled)touchTap=false;},
 reset:()=>{touchTap=false;jump=false;network.clearInput();if(game.player)game.player.ads=false;},
});
let appliedQuality:string|undefined;
let requestedTextureQuality=ui.prefs.quality,textureRequest=0;
const resolution=new AdaptiveResolution();
let qaLean:number|null=null,joining=false,equipRifle=false,onlineEntered=false,lobbyFetchBusy=false,lobbyFetchTime=0;
let lobbyRequest=0,onlineSelection=false;let requestedLobby:string|undefined;let lobbyRows:Lobby[]=[];
let lobbyProbe:AbortController|null=null;let lobbyListingGeneration=0;
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
function syncSettings(){
 const enabled=wantsTouch();if(enabled!==touchEnabled){clearTouchInput();touchEnabled=enabled;mobileResumeRequired=false;releaseMouse();}
 touch.setSensitivity(ui.prefs.touchSensitivity);
 game.difficulty=ui.prefs.difficulty;sound.setVolume(ui.prefs.volume);const quality=`${ui.prefs.quality}:${touchEnabled}`;
 if(appliedQuality!==quality){view.setQuality(ui.prefs.quality,touchEnabled);resolution.setBase(view.renderer.getPixelRatio(),.75);appliedQuality=quality;}
 if(requestedTextureQuality!==ui.prefs.quality){
  requestedTextureQuality=ui.prefs.quality;const request=++textureRequest;ui.el['quality-status'].textContent='Loading texture quality…';
  void changeAssetTier(assetTierForQuality(ui.prefs.quality)).then(()=>{if(request===textureRequest)ui.el['quality-status'].textContent='';}).catch(()=>{
   if(request===textureRequest)ui.el['quality-status'].textContent='Texture quality could not be loaded. Select a quality to try again.';
  });
 }
 game.setPlayerName(ui.prefs.playerName);network.setName(ui.prefs.playerName);if(menu)view.setFaction(ui.prefs.faction);updateTouchViewport();
}
ui.settingsChanged=syncSettings;syncSettings();
function capture(){if(!touchEnabled&&!document.hidden&&document.hasFocus())mouseCapture.request();}
function releaseMouse(){dragging=false;mouseCapture.release();}
function start(){clearTouchInput();mobileResumeRequired=false;sound.resetScene();network.disconnect();onlineEntered=false;onlineSelection=false;ui.setOnline(false);equipRifle=false;sound.init();sound.click();game.start(ui.prefs.faction,ui.prefs.difficulty,ui.prefs.playerName);view.setupActors(game);menu=false;joining=true;resumeState='playing';game.state='paused';ui.begin();keys.clear();jump=false;endingReleased=false;accumulator=0;ui.openSelection();syncTouchState();}
function pause(){clearTouchInput();if(game.state==='playing'||game.state==='killcam'){resumeState=game.state;if(network.online)network.setPaused(true);else game.state='paused';keys.clear();jump=false;if(game.player)game.player.ads=false;}releaseMouse();}
function resume(){if(touchEnabled&&mobilePortrait){mobileResumeRequired=true;syncTouchState();return;}clearTouchInput();mobileResumeRequired=false;sound.init();if(network.online)network.setPaused(false);else game.state=resumeState;ui.closeModal();keys.clear();jump=false;capture();syncTouchState();}
function leave(){clearTouchInput();mobileResumeRequired=false;sound.resetScene();game.spectator.reset();network.disconnect();onlineEntered=false;onlineSelection=false;requestedLobby=undefined;lobbyRequest++;menu=true;joining=false;equipRifle=false;game.state='menu';releaseMouse();ui.closeModal();ui.showMenu();keys.clear();for(const s of view.soldiers)s.visible=false;syncTouchState();}
ui.start=start;ui.resume=resume;ui.pause=pause;ui.leave=leave;ui.skip=()=>network.online?network.skipReplay():game.skipReplay();
ui.captureMouse=()=>{if(!menu&&!ui.selectionOpen&&!ui.modalOpen&&!ui.chatOpen&&(game.state==='playing'||game.state==='killcam'))capture();};
function selectInGame(){
 if(menu||game.state==='ended')return;pause();ui.prefs.faction=game.player.faction;ui.openSelection();
}
ui.selectTeam=selectInGame;
ui.cancelSelection=()=>{ui.prefs.faction=game.player.faction;ui.refreshSelection();ui.save();if(joining){leave();return;}ui.closeSelection();};
function joinOnline(spectator=false){
 if(network.online||!landscapeReady())return;clearTouchInput();const request=lobbyRequest;ui.setSelectionBusy(true);ui.save();
 void network.join(requestedLobby,ui.prefs.playerName,ui.prefs.faction,spectator).catch(error=>{if(request!==lobbyRequest)return;leave();lobbyFetchTime=performance.now();ui.showLobbies(lobbyRows,error instanceof Error?error.message:'Unable to connect.',network.locations);}).finally(()=>{if(request===lobbyRequest){ui.setSelectionBusy(false);ui.refreshSelection();}});
}
ui.selectSpectator=()=>{
 if(!landscapeReady())return;clearTouchInput();
 if(onlineSelection){joinOnline(true);return;}
 if(network.online)network.spectate();else game.spectate();
 sound.resetScene();resumeState='playing';joining=false;equipRifle=false;ui.damageUntil=0;ui.damageStarted=-Infinity;ui.closeSelection();resume();
};
ui.selectLoadout=()=>{
 if(!landscapeReady())return;clearTouchInput();
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
function clearTouchInput(){touch.clear();touchTap=false;keys.clear();jump=false;network.clearInput();if(game.player)game.player.ads=false;}
function canTouchPlay(){return touchEnabled&&!mobilePortrait&&!mobileResumeRequired&&!menu&&!ui.selectionOpen&&!ui.modalOpen&&!ui.chatOpen&&!ui.scoreHeld&&!document.hidden&&document.hasFocus()&&game.state==='playing'&&!!game.player&&(game.player.alive||game.player.spectator)&&(!network.online||network.connected);}
function syncTouchState(){
 if(touchEnabled&&mobilePortrait&&!menu&&!ui.selectionOpen&&(game.state==='playing'||game.state==='killcam')){mobileResumeRequired=true;pause();}
 const player=game.player,life=player?`${player.renderIdentity??''}:${player.deaths}:${player.faction}:${player.spectator}`:'';
 if(touchEnabled&&life!==touchLife)clearTouchInput();touchLife=life;
 const active=canTouchPlay();if(touchWasActive&&!active)clearTouchInput();touchWasActive=active;touch.setEnabled(active);
 ui.setTouchState({enabled:touchEnabled,mobile:mobileDevice(),controls:active,rotate:ui.ready&&touchEnabled&&!menu&&game.state!=='ended'&&mobilePortrait,resume:touchEnabled&&!menu&&!ui.selectionOpen&&!ui.modalOpen&&!mobilePortrait&&mobileResumeRequired&&game.state==='paused',spectator:!!player?.spectator,following:game.spectator.following,ads:!!player?.ads,stance:player?.stance??'stand',weapon:player?.selectedWeapon??'rifle'});
}
function updateTouchViewport(){
 // A soft keyboard can change viewport orientation without rotating the phone.
 if(!(document.activeElement instanceof HTMLElement&&document.activeElement.matches('input,textarea,select')))mobilePortrait=innerHeight>=innerWidth;
 syncTouchState();
}
function landscapeReady(){updateTouchViewport();return !touchEnabled||!mobilePortrait;}
window.addEventListener('resize',updateTouchViewport);
window.addEventListener('resize',()=>{appliedQuality=undefined;syncSettings();});
window.addEventListener('orientationchange',()=>{clearTouchInput();updateTouchViewport();});
touchMedia.addEventListener('change',syncSettings);
ui.mobileResume=resume;ui.mobileBack=leave;
ui.touchAction=action=>{
 if(!canTouchPlay())return;
 if(action==='menu'){pause();return;}
 if(action==='score'){clearTouchInput();ui.scoreHeld=true;syncTouchState();return;}
 if(action==='chat'){clearTouchInput();ui.openChat();return;}
 if(action==='team'){selectInGame();return;}
 const player=game.player;
 if(player.spectator){
  if(action==='next'||action==='previous')game.spectator.cycle(game.actors,action==='next'?1:-1);
  if(action==='unfollow')game.spectator.free(game.actors);
  if((action==='up'||action==='down')&&!game.spectator.following)game.spectator.position.y=clamp(game.spectator.position.y+(action==='up'?1:-1),.15,24);
  syncTouchState();return;
 }
 sound.init();
 if(action==='aim'&&game.canADS())setADS(!player.ads);
 if(action==='reload')reload();
 if(action==='crouch'||action==='prone')setStance(action);
};
async function refreshLobbies(){
 if(lobbyFetchBusy)return;lobbyFetchBusy=true;lobbyFetchTime=performance.now();const request=lobbyRequest;
 try{const rows=await network.lobbies();if(request===lobbyRequest&&ui.lobbyOpen&&!network.online){lobbyRows=rows;ui.showLobbies(rows,'',network.locations);lobbyProbe?.abort();const probe=new AbortController();lobbyProbe=probe;const listing=++lobbyListingGeneration;void network.measureLobbies(rows,probe.signal).then(measured=>{if(!probe.signal.aborted&&listing===lobbyListingGeneration&&request===lobbyRequest&&ui.lobbyOpen&&!network.online){lobbyRows=measured;ui.showLobbies(measured,'',network.locations);}});}}
 catch(error){if(request===lobbyRequest&&ui.lobbyOpen&&!network.online)ui.setLobbyStatus(error instanceof Error?error.message:'Unable to load servers.');}
 finally{lobbyFetchBusy=false;}
}
ui.multiplayer=()=>{sound.init();sound.click();ui.showLobbies([],'Loading…');void refreshLobbies();};
ui.refreshLobbies=()=>void refreshLobbies();ui.lobbyBack=()=>{lobbyProbe?.abort();lobbyRequest++;if(!onlineEntered)network.disconnect();ui.closeLobbies();};
ui.playLocation=id=>ui.joinLobby(`new:${id}`);
ui.joinLobby=id=>{
 if(network.online||onlineSelection)return;clearTouchInput();mobileResumeRequired=false;lobbyProbe?.abort();sound.init();onlineSelection=true;requestedLobby=id;menu=false;joining=true;keys.clear();jump=false;accumulator=0;
 // Choose the initial loadout before joining the server. This is a stationary
 // arena backdrop: no AI, live player, reserved seat, or vulnerable spawn.
 const actor=createActor(0,ui.prefs.faction,ui.prefs.playerName);Object.assign(actor,SPAWNS[0]);actor.yaw=Math.atan2(-actor.x,-actor.z);
 game.actors=[actor];game.time=0;game.remaining=RULES.roundSeconds;game.state='paused';game.events=[];game.history=[];game.replay=[];game.replayShots=[];game.shots=[];game.winner=null;
 view.setupActors(game);ui.closeLobbies();ui.setOnline(true);ui.begin();ui.openSelection();syncTouchState();
};
network.onRoster=()=>{sound.resetScene();view.syncActors(game);};
network.onJoined=name=>{
 clearTouchInput();ui.setOnline(true,name,network.lobbyLocation);ui.setNetworkStatus('');if(onlineEntered){syncTouchState();return;}
 onlineEntered=true;onlineSelection=false;menu=false;joining=false;resumeState='playing';keys.clear();jump=false;endingReleased=false;accumulator=0;equipRifle=false;ui.closeLobbies();ui.begin();network.setPaused(false);syncTouchState();capture();
};
network.onStatus=text=>{if(network.online&&!network.connected)clearTouchInput();if(onlineEntered)ui.setNetworkStatus(text);else if(ui.selectionOpen)ui.setSelectionStatus(text);else if(ui.lobbyOpen)ui.setLobbyStatus(text,!!text&&network.online);};
network.onFailure=message=>{leave();lobbyFetchTime=performance.now();ui.showLobbies(lobbyRows,message);};
network.onChat=message=>ui.addChat(message);
network.onImpact=shot=>{if(game.state==='killcam')return;ui.showHit(shot);view.effect(shot,false,0,true,game.time);playImpactSound(sound,shot,game.actors,game.viewedActor?.id);};
network.onRound=()=>{if(touchEnabled)clearTouchInput();sound.resetScene();endingReleased=false;ui.feed=[];ui.hitUntil=0;ui.killUntil=0;ui.damageUntil=0;ui.damageStarted=-Infinity;lastReplaySound=-1;};
ui.chatSend=text=>network.chat(text);
ui.chatOpened=()=>{clearTouchInput();releaseMouse();};
ui.chatClosed=()=>{keys.clear();jump=false;updateTouchViewport();if(network.online&&!menu&&!ui.selectionOpen&&!ui.modalOpen&&game.state==='playing')capture();};
window.addEventListener('pagehide',()=>{clearTouchInput();network.disconnect();});
function spectatorExit(source:'key'|'unlock'){
 if(!game.player?.spectator||game.state!=='playing'||!game.spectator.handleExit(source,performance.now(),game.actors))return false;
 keys.clear();jump=false;dragging=false;return true;
}
document.addEventListener('pointerlockchange',()=>{
 const lost=mouseCapture.changed();dragging=false;if(!lost)return;lastPointerUnlock=performance.now();
 if(touchEnabled||menu||game.state==='ended'||ui.chatOpen||ui.selectionOpen||ui.modalOpen)return;
 if(spectatorExit('unlock'))return;pause();
});
document.addEventListener('pointerlockerror',()=>mouseCapture.error());
function loseFocus(){clearTouchInput();ui.scoreHeld=false;if(!menu)pause();else releaseMouse();syncTouchState();}
document.addEventListener('visibilitychange',()=>{if(document.hidden)loseFocus();});
window.addEventListener('blur',loseFocus);
document.addEventListener('contextmenu',e=>{if(!menu)e.preventDefault();});
function look(dx:number,dy:number,sensitivity=ui.prefs.sensitivity){if(!game.player||game.state!=='playing'||ui.chatOpen||ui.selectionOpen||ui.modalOpen)return;const a=game.player,scale=.0018*sensitivity*(!a.spectator&&a.ads?.68:1);if(a.spectator){game.spectator.look(-dx*scale,-dy*scale*(ui.prefs.invert?-1:1));return;}a.yaw-=dx*scale;a.pitch=clamp(a.pitch-dy*scale*(ui.prefs.invert?-1:1),-1.43,1.43);}
document.addEventListener('mousemove',e=>{if(touchEnabled)return;if(mouseCapture.locked)look(e.movementX,e.movementY);else if(game.player?.spectator&&!game.spectator.following&&e.target===view.renderer.domElement)look(e.movementX,e.movementY);else if(mouseCapture.fallback&&dragging)look(e.clientX-previousX,e.clientY-previousY);previousX=e.clientX;previousY=e.clientY;});
view.renderer.domElement.addEventListener('mousedown',e=>{
 if(touchEnabled||menu||ui.selectionOpen||ui.modalOpen||ui.chatOpen)return;if(game.state==='paused'){resume();return;}if(game.state!=='playing'&&game.state!=='killcam')return;if(e.button!==0&&e.button!==2)return;
 if(game.state==='playing'&&game.player.spectator){game.spectator.cycle(game.actors,e.button===0?1:-1);if(!mouseCapture.locked)capture();return;}
 if(!mouseCapture.locked){
  // A previous failure must never disable the next user-gesture retry.
  // Keep drag look available while the browser is unable to capture.
  const fallback=mouseCapture.fallback;dragging=e.button===0;previousX=e.clientX;previousY=e.clientY;capture();if(!fallback)return;
 }
 if(game.state!=='playing')return;
 sound.init();if(e.button===0){fire();dragging=true;previousX=e.clientX;previousY=e.clientY;}if(e.button===2&&game.canADS())setADS(ui.prefs.aim==='hold'?true:!game.player.ads);
});
view.renderer.domElement.addEventListener('wheel',e=>{if(menu||ui.selectionOpen||ui.modalOpen||ui.chatOpen||game.state!=='playing'||game.player.spectator)return;e.preventDefault();if(Math.abs(e.deltaY)>.01)selectWeapon(game.player.selectedWeapon==='rifle'?'grenade':'rifle');},{passive:false});
document.addEventListener('mouseup',e=>{if(touchEnabled)return;if(e.button===0)dragging=false;if(e.button===2&&ui.prefs.aim==='hold'&&game.player)setADS(false);});
document.addEventListener('keydown',e=>{
 if(!ui.el['mobile-rotate'].classList.contains('hidden')||!ui.el['mobile-resume'].classList.contains('hidden'))return;
 if(ui.handleChatKey(e))return;
 if(e.code==='Escape'&&ui.modalOpen){ui.closeModal();return;}
 if(ui.modalOpen){ui.handleModalKey(e);return;}
 if((e.target as HTMLElement).matches('input,textarea,select'))return;
 if(menu||ui.selectionOpen){ui.handleMenuKey(e);return;}
 if(touchEnabled&&(mobilePortrait||mobileResumeRequired))return;
 if(['Space','Tab','AltLeft','AltRight','ControlLeft','ControlRight','ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.code))e.preventDefault();
 if(e.code==='KeyM'&&!e.repeat&&game.state!=='ended'){selectInGame();return;}
 if(e.code==='Tab'){ui.scoreHeld=true;return;}
 if(e.code==='Escape'){if(e.repeat||spectatorExit('key'))return;if(game.state==='paused'){if(performance.now()-lastPointerUnlock>=300)resume();}else pause();return;}
 if(game.state==='killcam'&&e.code==='Space'){ui.skip();return;}
 if(game.state!=='playing'||ui.modalOpen)return;keys.add(e.code);if(game.player.spectator){if(!e.repeat&&!game.spectator.following&&!mouseCapture.locked&&['KeyW','KeyA','KeyS','KeyD','Space','ControlLeft','ControlRight'].includes(e.code))capture();return;}if(e.repeat)return;
 if(e.code==='Digit1'||e.code==='Numpad1')selectWeapon('rifle');if(e.code==='Digit2'||e.code==='Numpad2')selectWeapon('grenade');
 // Space also stands up from crouch/prone. The simulation clears ADS only if
 // this input actually leaves the ground, preserving aim through stance changes.
 if(e.code==='Space')jump=true;if(e.code==='KeyR')reload();if(e.code==='KeyC')setStance('crouch');if(e.code==='ControlLeft'||e.code==='ControlRight')setStance('prone');if(e.code==='ShiftLeft'||e.code==='ShiftRight')fire(true);
});
document.addEventListener('keyup',e=>{ui.releaseChatKey(e.code);keys.delete(e.code);if(e.code==='Tab'){ui.scoreHeld=false;e.preventDefault();}});
function updateAudioScene(){
 sound.beginSceneUpdate();
 const replayFrame=game.state==='killcam'?game.replayFrame():null;
 const viewed=game.state==='killcam'?game.actors[game.killer]:game.viewedActor;
 const replay=replayFrame?.actors[game.killer];
 const listener=replay?{...viewed!,...replay}:viewed;
 sound.updateListener(listener?game.eye(listener):game.spectator.position,listener?.yaw??game.spectator.yaw,listener?listener.pitch+listener.recoil:game.spectator.pitch);
 for(const actor of game.actors){
  const recorded=replayFrame?.actors[actor.id],source=recorded?{...actor,...recorded}:actor;
  if(source.spectator||game.state==='killcam'&&!recorded){sound.stopActor(actor.id);continue;}
  sound.updateEmitter({actor:actor.id,position:game.eye(source),local:actor.id===viewed?.id,faction:actor.faction});
  const reloading=network.online&&game.state!=='killcam'?network.reloadAudioActive(actor.id):source.reload>0;
  if(!source.alive||!reloading||game.state==='menu'||game.state==='ended')sound.cancelReload(actor.id);
 }
 sound.endSceneUpdate();
}
function processEvents(){
 updateAudioScene();const viewed=game.viewedActor;
 for(const event of game.events){const a=game.actors[event.actor];
  if(event.type==='kill'){
   const victim=game.actors[event.victim!],actorName=event.actorName??a?.name,victimName=event.victimName??victim?.name,faction=event.actorFaction??a?.faction;
   if(actorName&&victimName&&faction){ui.feed.push({text:`${playerNameHTML(actorName)}${weaponIcon(faction,event.weapon??'rifle',!!event.headshot)}${playerNameHTML(victimName)}`,time:performance.now()});if(ui.feed.length>5)ui.feed.shift();if(event.actor===0&&event.victim!==0&&!game.player.spectator)ui.showKill(victimName);}
  }
  if(!a)continue;
  const emitter={actor:a.id,position:game.eye(a),local:a.id===viewed?.id,faction:a.faction};
  if(game.state!=='killcam'){
   if(event.type==='shot'&&event.shot){ui.showHit(event.shot);view.effect(event.shot,emitter.local,0,false,network.online?game.time:event.shot.time);playCombatSound(sound,event.shot,game.actors,viewed?.id);}
   if(event.type==='bolt')sound.bolt(emitter);if(event.type==='reload')sound.reload(emitter);if(event.type==='step')sound.step(event.value??3,emitter);
   if(event.type==='switch')sound.switch(emitter);
  }
  if(event.type==='hurt'&&event.actor===0&&!game.player.spectator)ui.showDamage(event.lethal??!game.player.alive);
  if(event.type==='spawn'&&event.actor===0){if(touchEnabled)clearTouchInput();ui.damageUntil=0;ui.damageStarted=-Infinity;ui.hitUntil=0;view.setFaction(game.player.faction);}
 }
 game.events=[];
}
let previousCpuMs=0;
function frame(now:number){
 const cpuStart=performance.now();
 const frameMs=now-previous,dt=Math.min(frameMs/1000,.075);previous=now;
 syncTouchState();
 const ratio=resolution.sample(frameMs,!document.hidden&&!menu&&!ui.selectionOpen&&!ui.modalOpen&&game.state==='playing',previousCpuMs);if(ratio!==null){view.renderer.setPixelRatio(ratio);view.resize();}
 if(!menu){
  const movement=touch.movement;
  const input:Input={forward:clamp(Number(keys.has('KeyW'))-Number(keys.has('KeyS'))+movement.forward,-1,1),right:clamp(Number(keys.has('KeyD'))-Number(keys.has('KeyA'))+movement.right,-1,1),jump,walk:keys.has('AltLeft')||keys.has('AltRight'),lean:import.meta.env.DEV&&qaLean!==null?qaLean:Number(keys.has('KeyE'))-Number(keys.has('KeyQ'))};
  if(equipRifle&&game.state==='playing'&&!game.isSwitching()){game.selectWeapon('rifle');equipRifle=false;}
  if(game.state==='playing'){look((Number(keys.has('ArrowRight'))-Number(keys.has('ArrowLeft')))*dt*850,(Number(keys.has('ArrowDown'))-Number(keys.has('ArrowUp')))*dt*650);}
  const step=network.online?1/60:1/120;accumulator+=dt;while(accumulator>=step){
   // A touch press is one trigger pull, even when held through a bolt cycle.
   if(touchTap&&canTouchPlay()&&!game.player.spectator){if(network.online)network.fireOnce();else fire();touchTap=false;}
   if(network.online)network.update(step,input,!ui.chatOpen&&!ui.modalOpen&&!ui.selectionOpen&&(!touchEnabled||canTouchPlay()));else game.update(step,input);
   input.jump=false;jump=false;accumulator-=step;
  }
  if(network.online)network.present(accumulator/step);if(game.player.spectator){game.spectator.sync(game.actors);if(game.state==='playing'&&!ui.chatOpen&&!ui.modalOpen&&!ui.selectionOpen)game.spectator.move(dt,{forward:input.forward,right:input.right,up:Number(keys.has('Space'))-Number(keys.has('ControlLeft')||keys.has('ControlRight')),fast:keys.has('ShiftLeft')||keys.has('ShiftRight')});}
  processEvents();if(game.state==='killcam'){if(lastReplaySound<0)lastReplaySound=game.replayTime;for(const shot of game.replayShots)if(shot.time>lastReplaySound&&shot.time<=game.replayTime)playCombatSound(sound,shot,game.actors,game.killer);lastReplaySound=game.replayTime;}else lastReplaySound=-1;
  ui.update(game,network.online&&network.waitingForRespawn);syncTouchState();ui.setMouseCapture(!touchEnabled&&!document.hidden&&document.hasFocus()&&!mouseCapture.locked&&(game.state==='playing'||game.state==='killcam')&&!ui.chatOpen&&!ui.modalOpen&&!ui.selectionOpen&&!ui.scoreHeld,mouseCapture.fallback);
  if(game.state==='ended'&&!endingReleased){endingReleased=true;releaseMouse();keys.clear();jump=false;equipRifle=false;}
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
 previousCpuMs=performance.now()-cpuStart;requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
// Development-only inspection surface for deterministic browser QA; Vite removes it from production.
if(import.meta.env.DEV)Object.assign(window,{__bolts:{game,view,ui,network,start,leave}});
if(import.meta.env.DEV&&new URLSearchParams(location.search).get('qa')==='1')void import('./qa').then(({mountQA})=>mountQA(game,value=>{qaLean=value;}));
