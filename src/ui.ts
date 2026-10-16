import {WEAPONS,type Difficulty,type Faction} from './config';
import {CROSSHAIR_DISPLAY_SCALE,crosshairDisplayGapPixels} from './accuracy';
import {weaponIcon} from './weaponIcons';
import {damageFlashOpacity} from './damageFeedback';
import type {Actor,Game} from './engine';
import {FEEDBACK_MESSAGE_LIMIT,FEEDBACK_EMAIL_LIMIT,validateFeedback,type Leaderboard,type LeaderboardPeriod} from './community';
import {DEFAULT_PLAYER_NAME,PLAYER_NAME_PREFERENCE_VERSION,MAX_NAME_RAW_LENGTH,playerNameHTML,sanitizePlayerName,restorePlayerNamePreference} from './names';
import {HudMarkup,hudClass,hudStyle,hudText} from './hudUpdates';
import {locationLabel,type Lobby,type LobbyLocation} from './lobbies';
import {bindTouchAction} from './touchActions';
const closeIcon='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="m6 6 12 12M6 18 18 6"/></svg>';
const controls=[['W A S D','Move'],['Mouse','Look'],['LMB','Fire / grenade bash'],['RMB','Iron sights'],['1 / 2','Rifle / grenade'],['Wheel','Switch weapon'],['R','Reload'],['Space','Jump / stand'],['C','Crouch'],['Ctrl','Prone'],['Q / E','Lean'],['Shift','Melee'],['Alt','Walk'],['Tab','Scoreboard'],['T / Enter','Chat'],['M','Change team'],['Esc','Menu / leave follow'],['LMB / RMB','Spectator: next / previous'],['Space / Ctrl','Spectator: up / down'],['Shift','Spectator: faster']];
export interface Preferences {faction:Faction;difficulty:Difficulty;playerName:string;playerNameVersion:number;sensitivity:number;volume:number;aim:'toggle'|'hold';quality:string;invert:boolean;controlsMode:'auto'|'touch'|'mouse';touchSensitivity:number;touchSize:number}
export type TouchAction='aim'|'reload'|'jump'|'crouch'|'weapon'|'melee'|'prone'|'team'|'score'|'chat'|'menu'|'up'|'down'|'next'|'previous'|'unfollow';
export interface TouchState {enabled:boolean;mobile:boolean;controls:boolean;rotate:boolean;resume:boolean;spectator:boolean;following:boolean;ads:boolean;weapon:'rifle'|'grenade'}
export type LobbyRow=Pick<Lobby,'id'|'name'|'players'|'capacity'|'ping'|'location'> & Partial<Pick<Lobby,'phase'>>;
export interface ChatLine {id?:string;name?:string;message:string;system?:boolean}
export function scoreboardRows(actors:readonly Actor[],online:boolean){
 return [...actors].sort((a,b)=>Number(a.spectator)-Number(b.spectator)||b.kills-a.kills||a.deaths-b.deaths).map((a,i)=>`<tr class="${a.id===0?'player-row':''}"><td>${a.spectator?'—':i+1}</td><td><span class="flag ${a.faction}">${a.faction==='russian'?'★':''}</span><strong>${playerNameHTML(a.name)}</strong>${a.spectator?'<span class=score-spectator>Spectator</span>':''}</td><td>${a.kills}</td><td>${a.deaths}</td>${online?`<td class="score-ping">${typeof a.ping==='number'&&Number.isInteger(a.ping)&&a.ping>=0&&a.ping<=999?a.ping:'—'}</td>`:''}</tr>`).join('');
}
export class UI {
 menuStage:'main'|'team'='main';selectionOpen=false;ready=false;private selectionBusy=false;
 private inGame=false;private spectating=false;private spectatorSelection=false;
 online=false;lobbyOpen=false;chatOpen=false;
 private lobbyRows:LobbyRow[]=[];private selectedLobby='';private lobbyBusy=false;
 private lobbyLocations:readonly LobbyLocation[]=[];private selectedLocation:LobbyLocation='ca';
 private chatIds=new Set<string>();
 private chatKeys=new Set<string>();
 private hudMarkup=new HudMarkup();
 private loadingProgress=0;private loadingCompletion:ReturnType<typeof setTimeout>|undefined;
 private touchStateKey='';private touchEnabled=false;
 private mobileGate:'rotate'|'resume'|null=null;private mobileReturnFocus:HTMLElement|null=null;
 multiplayer=()=>{};refreshLobbies=()=>{};joinLobby=(_id:string)=>{};playLocation=(_location:LobbyLocation)=>{};lobbyBack=()=>this.closeLobbies();
 chatSend=(_text:string)=>{};chatOpened=()=>{};chatClosed=()=>{};
 private modalReturnFocus:HTMLElement|null=null;
 private feedbackBusy=false;private leaderboardBusy=false;private leaderboardStatus='';private leaderboardData:Leaderboard|null=null;private leaderboardPeriod:LeaderboardPeriod='allTime';
 feedbackSend=async(_message:string,_email:string)=>{};leaderboardLoad=()=>{};
 prefs:Preferences={faction:'british',difficulty:'regular',playerName:DEFAULT_PLAYER_NAME,playerNameVersion:PLAYER_NAME_PREFERENCE_VERSION,sensitivity:1,volume:.6,aim:'toggle',quality:'high',invert:false,controlsMode:'auto',touchSensitivity:1,touchSize:1};
 touchAction=(_action:TouchAction)=>{};mobileResume=()=>{};mobileBack=()=>{};
 selectLoadout=()=>{};selectSpectator=()=>{};selectTeam=()=>{};cancelSelection=()=>{};
 start=()=>{};resume=()=>{};pause=()=>{};leave=()=>{};settingsChanged=()=>{};skip=()=>{};captureMouse=()=>{};
 feed:{text:string;time:number}[]=[];hitUntil=0;damageUntil=0;damageStarted=-Infinity;damageLethal=false;killUntil=0;scoreHeld=false;modalOpen=false;lastHud=0;
 el:Record<string,HTMLElement>={};
 constructor(){
  try{
   const saved=JSON.parse(localStorage.getItem('bolts-preferences')??'{}');
   if(['british','russian','german'].includes(saved.faction))this.prefs.faction=saved.faction;
   if(['recruit','regular','veteran'].includes(saved.difficulty))this.prefs.difficulty=saved.difficulty;
   this.prefs.playerName=restorePlayerNamePreference(saved.playerName,saved.playerNameVersion);
   for(const k of ['sensitivity','volume'] as const)if(typeof saved[k]==='number')this.prefs[k]=saved[k];
   if(['hold','toggle'].includes(saved.aim))this.prefs.aim=saved.aim;
   if(['high','medium','low'].includes(saved.quality))this.prefs.quality=saved.quality;
   else if(navigator.maxTouchPoints>0&&window.matchMedia('(pointer: coarse)').matches)this.prefs.quality='medium';
   if(['auto','touch','mouse'].includes(saved.controlsMode))this.prefs.controlsMode=saved.controlsMode;
   if(typeof saved.touchSensitivity==='number'&&Number.isFinite(saved.touchSensitivity))this.prefs.touchSensitivity=Math.max(.5,Math.min(2,saved.touchSensitivity));
   if(typeof saved.touchSize==='number'&&Number.isFinite(saved.touchSize))this.prefs.touchSize=Math.max(.8,Math.min(1.25,saved.touchSize));
   this.prefs.invert=!!saved.invert;
   if(saved.playerName==='Player'&&this.prefs.playerName!==saved.playerName)localStorage.setItem('bolts-preferences',JSON.stringify({...saved,playerName:this.prefs.playerName,playerNameVersion:PLAYER_NAME_PREFERENCE_VERSION}));
  }catch{}
  document.querySelector('#app')!.innerHTML=`
  <div id="world" aria-label="3D arena"></div><div class="film-grain"></div><div class="vignette"></div>
  <div id="menu" class="screen menu intro-active">    <section id="menu-main" class="intro-menu" aria-label="Main menu">
     <h1>BOLTS</h1>
     <div class="main-choices"><button id="start" class="classic-choice">Single player</button><button id="multiplayer" class="classic-choice">Multiplayer</button><button id="leaderboard-open" class="classic-choice">Leaderboard</button><button id="feedback-open" class="classic-choice">Feedback</button><button class="classic-choice settings-button">Options</button><button class="classic-choice controls-button">Controls</button><button id="credits-open" class="classic-choice">Credits</button></div>
     <p id="mobile-notice" class="hidden"><strong>Best experienced on a PC.</strong><span>On mobile, rotate to landscape and use the touch controls.</span></p>
    </section><div id="players-online" role="status" aria-live="polite">— players online</div>
  <section id="lobby-window" class="classic-window lobby-window hidden" aria-labelledby="lobby-title">
   <header class="lobby-heading"><h2 id="lobby-title">Join game</h2></header>
   <div id="lobby-location-controls" class="lobby-location-controls hidden"><div class="lobby-location-picker" role="group" aria-labelledby="lobby-location-label"><span id="lobby-location-label">Location</span><div id="lobby-locations"></div></div><button id="lobby-play" aria-describedby="lobby-location-hint">Play</button><p id="lobby-location-hint"></p></div>
   <div class="lobby-list"><table aria-label="Available games"><thead><tr><th scope="col">Name</th><th scope="col">Location</th><th scope="col">Players</th><th scope="col" title="Your round-trip time to this server">Ping</th></tr></thead><tbody id="lobby-rows"></tbody></table><div id="lobby-status" role="status" aria-live="polite"></div></div>
   <nav class="lobby-actions" aria-label="Lobby actions"><button id="lobby-back">Back</button><button id="lobby-refresh">Refresh</button><button id="lobby-join" disabled>Join</button></nav>
  </section>
<main id="selection-window" class="classic-window hidden" aria-label="Bolts multiplayer menu">
   <nav class="selection-tabs" aria-label="Menu"><button id="selection-close">Back</button><button data-menu-tab="team">Team</button><button class="settings-button">Options</button><button class="controls-button">Controls</button></nav>
   <div class="selection-body">
    <section id="menu-team" class="menu-pane hidden" aria-label="Select team">
     <div class="team-choices" role="group" aria-label="Team"><button class="classic-choice" data-faction="british" aria-pressed="false">British</button><button class="classic-choice" data-faction="russian" aria-pressed="false">Russian</button><button class="classic-choice" data-faction="german" aria-pressed="false">German</button><button id="choose-spectator" class="classic-choice" aria-pressed="false">Spectator</button></div>
     <div id="selection-status" class="hidden" role="status" aria-live="polite"></div>
    </section>
   </div>
  </main></div>
  <div id="hud" class="screen hidden">
   <div id="match-clock">05:00</div><button id="hud-menu" aria-label="Pause and open menu">Esc · Menu</button><div id="killfeed"></div><div id="network-status" class="hidden" role="status"></div>
   <button id="mouse-capture" class="hidden">Click to enable mouse look<span id="mouse-capture-help" class="hidden">You can also hold the left mouse button and drag to look.</span></button>
   <div id="chat" class="chat hidden"><div id="chat-log" role="log" aria-label="Game chat" aria-live="polite" aria-relevant="additions"></div><form id="chat-form" class="hidden" autocomplete="off"><label for="chat-input">Say:</label><input id="chat-input" type="text" maxlength="512" autocomplete="off" spellcheck="false" aria-label="Chat message"></form></div>
   <div id="crosshair" style="--tick-length:${6*CROSSHAIR_DISPLAY_SCALE}px"><i></i><i></i><i></i><i></i></div><div id="damage-flash"></div><div id="hit-confirm" class="hidden">×</div><div id="spawn-protection" class="hidden">Spawn protection</div>
   <div class="compass-wrap"><div class="compass"><div id="compass-rose"><span class="north">N</span><span class="east">E</span><span class="south">S</span><span class="west">W</span><i class="needle"></i></div><i class="compass-pointer"></i></div></div>
   <div id="spectator-status" class="hidden" role="status"></div><div id="spectator-help" class="hidden"></div><div id="status-message"></div><div id="kill-message" class="hidden" role="status"></div>
   <div class="ammo-hud"><div id="weapon-slot"></div><div class="ammo-line"><strong id="ammo">10</strong><span class="ammo-divider">/</span><span id="reserve">60</span></div><div id="round-icons"></div><div class="health-row"><span>✚</span><div class="health-track"><i id="health-fill"></i></div><b id="health">100</b></div></div>
   <div id="killcam" class="hidden"><div class="killcam-top"><span>Killcam</span><span id="killer-name"></span></div><div class="killcam-bottom"><button id="skip-killcam">Skip <kbd>Space</kbd></button><span id="respawn-wait" class="hidden" role="status">Waiting to respawn…</span></div></div>
   <div id="touch-controls" class="hidden" aria-label="Touch controls">
    <div id="touch-look" aria-label="Drag to look without firing"></div>
    <div id="touch-move" class="touch-pad" role="group" aria-label="Movement joystick"><span class="touch-knob" aria-hidden="true"></span><span class="touch-label">Move</span></div>
    <div id="touch-fire" class="touch-pad" role="group" aria-label="Aim and fire joystick"><span class="touch-knob" aria-hidden="true"></span><span class="touch-label">Aim / Fire</span></div>
    <div class="touch-utility"><button type="button" data-touch-action="menu">Menu</button><button type="button" data-touch-action="score">Score</button><button id="touch-chat" type="button" data-touch-action="chat">Chat</button></div>
    <div id="touch-player-actions" class="touch-actions"><button id="touch-aim" type="button" data-touch-action="aim" aria-pressed="false">Sights</button><button type="button" data-touch-action="reload">Reload</button><button type="button" data-touch-action="jump">Jump</button><button type="button" data-touch-action="crouch">Crouch</button><button id="touch-weapon" type="button" data-touch-action="weapon">Grenade</button><button type="button" data-touch-action="melee">Melee</button></div>
    <div id="touch-spectator-actions" class="touch-spectator-actions hidden"><button type="button" data-touch-action="previous" aria-label="Follow previous player">Previous</button><button type="button" data-touch-action="next" aria-label="Follow next player">Next</button><button id="touch-unfollow" type="button" data-touch-action="unfollow">Free fly</button><button id="touch-up" type="button" data-touch-action="up">Rise</button><button id="touch-down" type="button" data-touch-action="down">Lower</button><button type="button" data-touch-action="team">Join game</button></div>
   </div>
  </div>
  <div id="mobile-rotate" class="overlay mobile-orientation hidden" role="dialog" aria-modal="true" aria-labelledby="mobile-rotate-title"><div class="dialog mobile-card"><svg class="rotate-phone" viewBox="0 0 100 90" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="37" y="19" width="29" height="53" rx="4" transform="rotate(33 51 46)"/><path d="M46 23h10M36 72c-17-7-23-24-16-39m-9 2 9-3 5 9m42-22c17 7 23 24 16 39m9-2-9 3-5-9"/></svg><h2 id="mobile-rotate-title">Rotate your phone to landscape to play</h2><p>Best experienced on a PC.</p><p class="mobile-match-note">In multiplayer, the match continues while this screen is open.</p><button id="mobile-rotate-back" type="button" class="secondary-button">Back to menu</button></div></div>
  <div id="mobile-resume" class="overlay mobile-orientation hidden" role="dialog" aria-modal="true" aria-labelledby="mobile-resume-title"><div class="dialog mobile-card"><h2 id="mobile-resume-title">Ready to play?</h2><p>Left joystick to move. Right joystick to aim and fire. Drag elsewhere on the right to look.</p><button id="mobile-resume-button" type="button" class="start-button">Resume</button><button id="mobile-resume-back" type="button" class="secondary-button">Back to menu</button></div></div>
  <div id="pause" class="overlay hidden"><div class="dialog pause-card"><h2 id="pause-title">Paused</h2><button id="resume" class="start-button">Resume</button><button id="open-team" class="secondary-button">Select team</button><button id="pause-score" class="secondary-button">Scoreboard</button><button class="secondary-button settings-button">Options</button><button class="secondary-button controls-button">Controls</button><button id="leave" class="secondary-button">Main menu</button></div></div>
  <div id="scoreboard" class="overlay hidden"><div class="score-card"><button id="score-close" class="icon-button" aria-label="Close scoreboard">${closeIcon}</button><div class="score-heading"><span id="score-time">05:00</span></div><h2 id="score-title">Scoreboard</h2><p id="score-winner" class="hidden"></p><table><thead><tr><th>#</th><th>Player</th><th>Kills</th><th>Deaths</th><th id="score-ping" class="hidden" aria-label="Ping in milliseconds">Ping</th></tr></thead><tbody id="score-rows"></tbody></table><div id="end-actions" class="hidden"><button id="again" class="start-button">Play again</button><button id="end-leave" class="secondary-button">Main menu</button></div></div></div>
  <div id="modal" class="overlay hidden"><div id="modal-dialog" class="dialog manual" role="dialog" aria-modal="true" aria-label="Options"><button id="modal-close" class="icon-button" aria-label="Close dialog">${closeIcon}</button><div id="options-tabs" class="modal-tabs"><button data-tab="settings" class="active">Options</button><button data-tab="controls">Controls</button></div>
   <section id="tab-feedback" class="hidden" aria-labelledby="feedback-title">
    <h2 id="feedback-title">Feedback</h2><p id="feedback-prompt">Share your opinions, requests, and any other info that can help us improve your experience!</p>
    <form id="feedback-form" novalidate>
     <label for="feedback-message">Feedback</label><textarea id="feedback-message" required rows="6" maxlength="${FEEDBACK_MESSAGE_LIMIT*2}" aria-describedby="feedback-prompt feedback-status"></textarea>
     <label for="feedback-email">Email (optional)</label><input id="feedback-email" type="email" maxlength="${FEEDBACK_EMAIL_LIMIT}" autocomplete="email" aria-describedby="feedback-status">
     <div class="community-actions"><span id="feedback-status" role="status" aria-live="polite"></span><button id="feedback-submit" type="submit">Submit</button></div>
    </form>
   </section>
   <section id="tab-leaderboard" class="hidden" aria-labelledby="leaderboard-title">
    <h2 id="leaderboard-title">Leaderboard</h2><div class="leaderboard-tabs" role="tablist" aria-label="Leaderboard period"><button id="leaderboard-alltime" role="tab" aria-selected="true" aria-controls="leaderboard-panel" data-period="allTime">All time</button><button id="leaderboard-recent" role="tab" aria-selected="false" aria-controls="leaderboard-panel" tabindex="-1" data-period="last24Hours">Last 24 hours</button></div>
    <div id="leaderboard-panel" class="leaderboard-list" role="tabpanel" aria-labelledby="leaderboard-alltime" tabindex="0"><table aria-label="All-time kills and deaths"><thead><tr><th scope="col">#</th><th scope="col">Player</th><th scope="col">Kills</th><th scope="col">Deaths</th></tr></thead><tbody id="leaderboard-rows"></tbody></table><div id="leaderboard-status" role="status" aria-live="polite"></div></div>
    <div class="community-actions"><button id="leaderboard-refresh" type="button">Refresh</button></div>
   </section>
   <section id="tab-credits" class="hidden asset-credits" aria-labelledby="credits-title">
    <h2 id="credits-title">Credits</h2>
    <p>Weapon models · <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener">CC BY 4.0</a></p>
    <ul><li><a href="https://sketchfab.com/3d-models/lee-enfield-mkiii-f6a2160daf134071a84e3cae5f831875" target="_blank" rel="noopener">Lee Enfield MKIII</a> — Moony_State</li><li><a href="https://sketchfab.com/3d-models/mosin-nagant-m91-92ede39f23bd40c7982c727dfd7c4be0" target="_blank" rel="noopener">Mosin Nagant M91</a> — MaX3Dd</li><li><a href="https://sketchfab.com/3d-models/kar98k-96b7387fe49b4dd491cc8277f765527a" target="_blank" rel="noopener">Kar98k</a> — Ecler</li><li><a href="https://sketchfab.com/3d-models/stielhandgranate-german-grenade-c49ce26939d64641afac1175a8d62338" target="_blank" rel="noopener">Stielhandgranate</a> — Janovich</li></ul>
    <p>Adapted for Bolts: scale, moving parts, hand contacts and texture optimization.</p>
    <p>Full-body soldier models · CC BY 4.0</p>
    <ul><li><a href="https://sketchfab.com/3d-models/wwii-british-soldier-9af571fa416546f08dfc2ba95e604083" target="_blank" rel="noopener">WWII British Soldier</a> — patromes</li><li><a href="https://sketchfab.com/3d-models/ww2-panzergrenadier-fbx-tpose-cc0-99ae9a9deb2c46c5956342b3bf9de7a2" target="_blank" rel="noopener">WW2 Panzergrenadier</a> — britdawgmasterfunk</li><li><a href="https://sketchfab.com/3d-models/ww2-soviet-uniform-f85a4ed8c33a43eca1a7caa45f7acf99" target="_blank" rel="noopener">WW2 Soviet Uniform</a> — tnnv</li></ul>
    <p>Adapted with continuous body skinning, neutral bind poses, material response and optimized textures.</p>
    <p>CC0: Mesh2Motion / Quaternius motion; para / MakeHuman hands; MakeHuman head; ambientCG and Poly Haven materials.</p>
    <p>Title font: <a href="https://github.com/google/fonts/tree/main/ofl/alfaslabone" target="_blank" rel="noopener">Alfa Slab One</a> — JM Solé · <a href="./assets/fonts/alfa-slab-one/OFL.txt" target="_blank" rel="noopener">SIL OFL 1.1</a></p>
    <p>Visit counts use a random browser ID. <a href="https://github.com/play-bolts/play-bolts.github.io/blob/main/research/user-analytics.md" target="_blank" rel="noopener">Privacy and analytics</a></p>
   </section>
   <div id="tab-controls" class="hidden"><div class="touch-controls-help"><h2>Touch controls</h2><p>Play in landscape. Use the left joystick to move; release it to stop.</p><p>Drag the right joystick to aim. Tap for one shot or hold to fire as the rifle cycles. Drag the open right side of the screen to look without firing.</p><p>Tap Sights to toggle aiming. Use the buttons above the sticks to reload, jump, crouch, switch weapons or melee.</p><p>Change sensitivity and control size in Options. Returning from an interruption clears held inputs; tap Resume to continue.</p><p>Best experienced on a PC.</p></div><div class="controls-grid keyboard-controls">${controls.map(([key,label])=>`<div><kbd>${key}</kbd><span>${label}</span></div>`).join('')}</div></div>
   <div id="tab-settings">
    <label id="difficulty-setting" class="setting select-setting hidden">Difficulty<select id="difficulty"><option value="recruit">Recruit</option><option value="regular">Regular</option><option value="veteran">Veteran</option></select></label>
    <div class="name-setting"><label for="player-name">Player name</label><input id="player-name" type="text" maxlength="${MAX_NAME_RAW_LENGTH}" autocomplete="off" spellcheck="false" aria-describedby="name-color-help"><div class="name-preview-row"><div id="player-name-preview" aria-label="Name preview"></div><small id="name-color-help">^0–^9</small></div></div>
    <label class="setting select-setting">Controls<select id="controls-mode"><option value="auto">Automatic</option><option value="touch">Touch</option><option value="mouse">Mouse and keyboard</option></select></label>
    <div class="touch-settings"><label class="setting">Touch sensitivity <output id="touch-sensitivity-value">1.0</output><input id="touch-sensitivity" type="range" min="0.5" max="2" step="0.1" value="1"></label><label class="setting">Control size <output id="touch-size-value">100%</output><input id="touch-size" type="range" min="0.8" max="1.25" step="0.05" value="1"></label></div>
    <label class="setting">Mouse sensitivity <output id="sensitivity-value">1.0</output><input id="sensitivity" type="range" min="0.2" max="2.5" step="0.1" value="1"></label>
    <label class="setting">Volume <output id="volume-value">60%</output><input id="volume" type="range" min="0" max="1" step="0.05" value=".6"></label>
    <label class="setting select-setting">Iron sights<select id="aim-mode"><option value="toggle">Toggle</option><option value="hold">Hold</option></select></label>
    <label class="setting select-setting">Visual quality<select id="quality"><option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option></select></label>
    <label class="setting select-setting">Invert mouse Y<input id="invert" type="checkbox"></label><button id="fullscreen" class="text-button">Fullscreen</button>
   </div>
  </div></div><div id="toast" role="status" class="hidden"></div><div id="loading" class="overlay loading-overlay" role="status" aria-live="polite"><div class="loading-content"><div id="loading-label">Loading</div><div id="loading-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" aria-labelledby="loading-label"><div id="loading-fill"></div></div></div></div><div id="load-error" class="overlay hidden"></div>`;
  for(const e of document.querySelectorAll<HTMLElement>('[id]'))this.el[e.id]=e;
  document.querySelectorAll<HTMLButtonElement>('[data-faction]').forEach(b=>b.onclick=()=>{if(!this.ready||this.selectionBusy)return;this.spectatorSelection=false;this.prefs.faction=b.dataset.faction as Faction;this.refreshSelection();this.selectLoadout();});
  (this.el.difficulty as HTMLSelectElement).onchange=()=>{this.prefs.difficulty=(this.el.difficulty as HTMLSelectElement).value as Difficulty;this.save();};
  this.el.start.onclick=()=>this.start();this.el.resume.onclick=()=>this.resume();this.el.leave.onclick=()=>this.leave();this.el.again.onclick=()=>this.start();this.el['end-leave'].onclick=()=>this.leave();this.el['skip-killcam'].onclick=()=>this.skip();this.el['hud-menu'].onclick=()=>this.pause();
  this.el['mouse-capture'].onclick=()=>this.captureMouse();
  document.querySelectorAll<HTMLButtonElement>('[data-touch-action]').forEach(button=>bindTouchAction(button,()=>this.touchAction(button.dataset.touchAction as TouchAction)));
  this.el['mobile-resume-button'].onclick=()=>this.mobileResume();this.el['mobile-rotate-back'].onclick=this.el['mobile-resume-back'].onclick=()=>this.mobileBack();
  this.el['feedback-open'].onclick=()=>this.openModal('feedback');this.el['leaderboard-open'].onclick=()=>this.openModal('leaderboard');this.el['credits-open'].onclick=()=>this.openModal('credits');
  this.el['feedback-form'].onsubmit=event=>{event.preventDefault();void this.submitFeedback();};
  this.el['leaderboard-refresh'].onclick=()=>this.leaderboardLoad();
  document.querySelectorAll<HTMLButtonElement>('[data-period]').forEach(button=>{button.onclick=()=>this.setLeaderboardPeriod(button.dataset.period as LeaderboardPeriod);button.onkeydown=event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.code))return;event.preventDefault();const period=event.code==='Home'?'allTime':event.code==='End'?'last24Hours':this.leaderboardPeriod==='allTime'?'last24Hours':'allTime';this.setLeaderboardPeriod(period);this.el[period==='allTime'?'leaderboard-alltime':'leaderboard-recent'].focus();};});
  this.el.multiplayer.onclick=()=>this.multiplayer();this.el['lobby-refresh'].onclick=()=>this.refreshLobbies();this.el['lobby-join'].onclick=()=>{if(this.selectedLobby&&!this.lobbyBusy)this.joinLobby(this.selectedLobby);};this.el['lobby-back'].onclick=()=>this.lobbyBack();
  this.el['lobby-play'].onclick=()=>{if(!this.lobbyBusy&&this.lobbyLocations.includes(this.selectedLocation))this.playLocation(this.selectedLocation);};
  this.el['chat-form'].onsubmit=event=>{event.preventDefault();this.submitChat();};
  (this.el['chat-input'] as HTMLInputElement).oninput=()=>{const input=this.el['chat-input'] as HTMLInputElement,points=Array.from(input.value);if(points.length>256)input.value=points.slice(0,256).join('');};
  document.querySelectorAll<HTMLButtonElement>('[data-menu-tab]').forEach(b=>b.onclick=()=>this.setMenuStage(b.dataset.menuTab as typeof this.menuStage));
  this.el['open-team'].onclick=()=>this.selectTeam();this.el['selection-close'].onclick=()=>this.cancelSelection();
  this.el['choose-spectator'].onclick=()=>{if(this.ready&&!this.selectionBusy){this.spectatorSelection=true;this.refreshSelection();this.selectSpectator();}};
  document.querySelectorAll<HTMLElement>('.settings-button').forEach(b=>b.onclick=()=>this.openModal('settings'));
  document.querySelectorAll<HTMLElement>('.controls-button').forEach(b=>b.onclick=()=>this.openModal('controls'));
  this.el['pause-score'].onclick=()=>{this.scoreHeld=true;};this.el['score-close'].onclick=()=>{this.scoreHeld=false;};this.el['modal-close'].onclick=()=>this.closeModal();this.el.modal.onclick=e=>{if(e.target===this.el.modal)this.closeModal();};
  document.querySelectorAll<HTMLElement>('[data-tab]').forEach(b=>b.onclick=()=>this.openModal(b.dataset.tab!));
  this.el.fullscreen.onclick=()=>{if(document.fullscreenElement)void document.exitFullscreen();else void document.documentElement.requestFullscreen().catch(()=>this.toast('Fullscreen unavailable.'));};
  const nameInput=this.el['player-name'] as HTMLInputElement;
  nameInput.oninput=()=>{this.prefs.playerName=sanitizePlayerName(nameInput.value);this.el['player-name-preview'].innerHTML=playerNameHTML(this.prefs.playerName);this.save();};
  nameInput.onblur=()=>{nameInput.value=this.prefs.playerName;};
  for(const key of ['sensitivity','volume'] as const){const e=this.el[key] as HTMLInputElement;e.oninput=()=>{this.prefs[key]=Number(e.value);this.refreshSettings();this.save();};}
  (this.el['controls-mode'] as HTMLSelectElement).onchange=()=>{this.prefs.controlsMode=(this.el['controls-mode'] as HTMLSelectElement).value as Preferences['controlsMode'];this.refreshSettings();this.save();};
  for(const [id,key,min,max] of [['touch-sensitivity','touchSensitivity',.5,2],['touch-size','touchSize',.8,1.25]] as const){const input=this.el[id] as HTMLInputElement;input.oninput=()=>{const value=Number(input.value);if(!Number.isFinite(value))return;this.prefs[key]=Math.max(min,Math.min(max,value));this.refreshSettings();this.save();};}
  (this.el['aim-mode'] as HTMLSelectElement).onchange=()=>{this.prefs.aim=(this.el['aim-mode'] as HTMLSelectElement).value as 'toggle'|'hold';this.save();};
  (this.el.quality as HTMLSelectElement).onchange=()=>{this.prefs.quality=(this.el.quality as HTMLSelectElement).value;this.save();};
  (this.el.invert as HTMLInputElement).onchange=()=>{this.prefs.invert=(this.el.invert as HTMLInputElement).checked;this.save();};
  this.refreshSelection();this.refreshSettings();this.setReady(false);
 }
 save(){try{localStorage.setItem('bolts-preferences',JSON.stringify(this.prefs));}catch{}this.settingsChanged();}
 setTouchState(state:TouchState){
  const key=JSON.stringify([state,this.online,this.prefs.touchSize]);if(key===this.touchStateKey)return;this.touchStateKey=key;this.touchEnabled=state.enabled;
  hudClass(document.documentElement,'touch-mode',state.enabled);hudClass(document.documentElement,'mobile-device',state.mobile);
  hudStyle(document.documentElement,'--touch-scale',String(this.prefs.touchSize));
  hudClass(this.el['mobile-notice'],'hidden',!state.mobile);
  hudClass(this.el['touch-controls'],'hidden',!state.enabled||!state.controls);
  hudClass(this.el['mobile-rotate'],'hidden',!state.rotate);hudClass(this.el['mobile-resume'],'hidden',!state.resume);
  const gate=state.rotate?'rotate':state.resume?'resume':null;
  if(gate!==this.mobileGate){
   if(!this.mobileGate&&gate)this.mobileReturnFocus=document.activeElement instanceof HTMLElement&&document.activeElement!==document.body?document.activeElement:null;
   this.mobileGate=gate;this.refreshBackgroundInert();
   if(gate)this.el[gate==='rotate'?'mobile-rotate-back':'mobile-resume-button'].focus({preventScroll:true});
   else{
    const previous=this.mobileReturnFocus;this.mobileReturnFocus=null;
    if(previous?.isConnected&&!previous.closest('.hidden,[hidden],[inert]')&&!previous.hasAttribute('disabled')&&previous.getClientRects().length)previous.focus({preventScroll:true});
    else if(this.modalOpen)this.el['modal-close'].focus({preventScroll:true});
   }
  }
  hudClass(this.el['touch-player-actions'],'hidden',state.spectator);hudClass(this.el['touch-spectator-actions'],'hidden',!state.spectator);
  hudClass(this.el['touch-move'],'hidden',state.spectator&&state.following);hudClass(this.el['touch-fire'],'hidden',state.spectator);
  hudClass(this.el['touch-unfollow'],'hidden',!state.following);hudClass(this.el['touch-up'],'hidden',state.following);hudClass(this.el['touch-down'],'hidden',state.following);
  hudClass(this.el['touch-chat'],'hidden',!this.online);hudClass(this.el['touch-aim'],'hidden',state.weapon==='grenade');
  this.el['touch-aim'].setAttribute('aria-pressed',String(state.ads));hudText(this.el['touch-weapon'],state.weapon==='rifle'?'Grenade':'Rifle');
  // Keep the normal menu button available during killcams, when the sticks hide.
  hudText(this.el['hud-menu'],state.enabled?'Menu':'Esc · Menu');
  this.refreshTouchSettings();
 }
 private refreshBackgroundInert(){
  for(const id of ['menu','hud','pause','scoreboard'])this.el[id].inert=!!this.mobileGate||this.modalOpen||id==='menu'&&!this.ready;
  this.el.modal.inert=!!this.mobileGate;
 }
 private refreshTouchSettings(){
  (this.el['controls-mode'] as HTMLSelectElement).value=this.prefs.controlsMode;
  for(const [id,key] of [['touch-sensitivity','touchSensitivity'],['touch-size','touchSize']] as const)(this.el[id] as HTMLInputElement).value=String(this.prefs[key]);
  hudText(this.el['touch-sensitivity-value'],this.prefs.touchSensitivity.toFixed(1));hudText(this.el['touch-size-value'],`${Math.round(this.prefs.touchSize*100)}%`);
  hudStyle(document.documentElement,'--touch-scale',String(this.prefs.touchSize));
 }
 showLobbies(rows:LobbyRow[],status='',locations:readonly LobbyLocation[]=[]){
  const focusedLobby=document.activeElement?.closest<HTMLTableRowElement>('[data-lobby]')?.dataset.lobby;
  this.lobbyRows=rows.map(row=>({...row}));
  this.el['lobby-location-controls'].classList.toggle('hidden',!locations.length);
  if(locations.join()!==this.lobbyLocations.join()){
   this.lobbyLocations=[...locations];if(!locations.includes(this.selectedLocation))this.selectedLocation=locations[0]??'ca';this.el['lobby-locations'].replaceChildren();
   for(const id of locations){const label=locationLabel(id)!;const button=document.createElement('button'),flag=document.createElement('img');button.type='button';button.dataset.location=id;button.title=label.name;button.setAttribute('aria-label',label.name);flag.className='lobby-flag';flag.src=`${import.meta.env?.BASE_URL??'/'}flags/${label.country}.svg`;flag.alt='';button.append(flag,document.createTextNode(` ${label.abbreviation}`));button.onclick=()=>{this.selectedLocation=id;this.refreshLobbyButtons();};this.el['lobby-locations'].append(button);}
  }
  if(!rows.some(row=>row.id===this.selectedLobby))this.selectedLobby=rows.find(row=>row.players<row.capacity)?.id??rows[0]?.id??'';
  const opening=!this.lobbyOpen;this.lobbyOpen=true;this.menuStage='main';this.el.menu.classList.remove('hidden','intro-active');this.el['menu-main'].classList.add('hidden');this.el['selection-window'].classList.add('hidden');this.el['lobby-window'].classList.remove('hidden');this.el['players-online'].classList.add('hidden');
  this.el['lobby-rows'].replaceChildren();
  for(const row of this.lobbyRows){
   const tr=document.createElement('tr'),name=document.createElement('td'),location=document.createElement('td'),players=document.createElement('td'),ping=document.createElement('td'),button=document.createElement('button');
   tr.dataset.lobby=row.id;button.type='button';button.textContent=row.name;button.setAttribute('aria-label',row.name);button.setAttribute('aria-pressed',String(row.id===this.selectedLobby));name.append(button);
   const label=locationLabel(row.location);location.className='lobby-location';location.title=label?.name??'Location unavailable';location.setAttribute('aria-label',location.title);
   if(label){const flag=document.createElement('img');flag.className='lobby-flag';flag.src=`${import.meta.env?.BASE_URL??'/'}flags/${label.country}.svg`;flag.alt='';location.append(flag,document.createTextNode(` ${label.abbreviation}`));}else location.textContent='—';
   players.textContent=`${row.players} / ${row.capacity}`;ping.textContent=typeof row.ping==='number'&&Number.isFinite(row.ping)?`${Math.max(0,Math.round(row.ping))} ms`:'—';ping.title=row.phase==='starting'?'Server is starting':row.ping===undefined?'Ping unavailable':'Your round-trip time to this server';
   if(row.phase==='starting'){const hint=document.createElement('span');hint.className='lobby-starting';hint.textContent='Starting…';button.append(hint);}
   tr.classList.toggle('selected',row.id===this.selectedLobby);tr.classList.toggle('full',row.players>=row.capacity);tr.append(name,location,players,ping);
   tr.onclick=()=>this.selectLobbyRow(row.id);tr.ondblclick=()=>{if(!this.lobbyBusy&&row.players<row.capacity)this.joinLobby(row.id);};
   this.el['lobby-rows'].append(tr);
  }
  this.setLobbyStatus(status||(!rows.length?(locations.length?'No active games. Choose a location and press Play.':'No games'):rows.every(row=>row.players>=row.capacity)&&locations.length?'All games are full. Choose a location and press Play.':''),false);if(opening)(this.el['lobby-rows'].querySelector<HTMLButtonElement>('tr.selected button')??(locations.length?this.el['lobby-locations'].querySelector<HTMLButtonElement>('button'):null)??this.el['lobby-refresh']).focus();
  else if(focusedLobby)Array.from(this.el['lobby-rows'].querySelectorAll<HTMLTableRowElement>('tr')).find(row=>row.dataset.lobby===focusedLobby)?.querySelector('button')?.focus({preventScroll:true});
 }
 private selectLobbyRow(id:string){this.selectedLobby=id;for(const row of this.el['lobby-rows'].children){const active=(row as HTMLElement).dataset.lobby===id;row.classList.toggle('selected',active);row.querySelector('button')?.setAttribute('aria-pressed',String(active));}this.refreshLobbyButtons();}
 private refreshLobbyButtons(){
  const selected=this.lobbyRows.find(row=>row.id===this.selectedLobby);(this.el['lobby-join'] as HTMLButtonElement).disabled=this.lobbyBusy||!selected||selected.players>=selected.capacity;(this.el['lobby-refresh'] as HTMLButtonElement).disabled=this.lobbyBusy;for(const button of this.el['lobby-rows'].querySelectorAll('button'))button.disabled=this.lobbyBusy;
  for(const button of this.el['lobby-locations'].querySelectorAll<HTMLButtonElement>('button')){button.disabled=this.lobbyBusy;button.setAttribute('aria-pressed',String(button.dataset.location===this.selectedLocation));}
  (this.el['lobby-play'] as HTMLButtonElement).disabled=this.lobbyBusy||!this.lobbyLocations.includes(this.selectedLocation);
  const games=this.lobbyRows.filter(row=>row.location===this.selectedLocation),city=locationLabel(this.selectedLocation)?.name??'';
  this.el['lobby-location-hint'].textContent=games.some(row=>row.players<row.capacity)?`Play joins an open lobby in ${city}.`:`Play starts ${games.length?'another':'a'} lobby in ${city}. Startup may take a few minutes.`;
 }
 setLobbyStatus(text:string,busy=false){this.lobbyBusy=busy;this.el['lobby-status'].textContent=text;this.el['lobby-window'].setAttribute('aria-busy',String(busy));this.refreshLobbyButtons();}
 closeLobbies(){this.lobbyOpen=false;this.el['lobby-window'].classList.add('hidden');this.setMenuStage('main');}
 setOnline(online:boolean,_lobbyName=''){
  this.online=online;this.el.hud.classList.toggle('online',online);this.el.chat.classList.toggle('hidden',!online);this.el['pause-title'].textContent=online?'Menu':'Paused';this.el['hud-menu'].setAttribute('aria-label',online?'Open menu':'Pause and open menu');this.el['difficulty-setting'].classList.toggle('hidden',!this.inGame||online);
  this.el['score-ping'].classList.toggle('hidden',!online);
  if(!online){this.closeChat();this.chatIds.clear();this.el['chat-log'].replaceChildren();this.setNetworkStatus('');if(this.lobbyOpen)this.closeLobbies();}
 }
 setNetworkStatus(text:string){this.el['network-status'].textContent=text;this.el['network-status'].classList.toggle('hidden',!text);}
 setMouseCapture(visible:boolean,fallback=false){hudClass(this.el['mouse-capture'],'hidden',!visible);hudClass(this.el['mouse-capture-help'],'hidden',!fallback);}
 openChat(){if(!this.online||!this.inGame||this.chatOpen)return;this.chatOpen=true;this.scoreHeld=false;this.el['chat-form'].classList.remove('hidden');this.el.chat.classList.add('typing');this.chatOpened();this.updateChat(performance.now());(this.el['chat-input'] as HTMLInputElement).focus();}
 closeChat(){if(!this.chatOpen)return;this.chatOpen=false;this.el['chat-form'].classList.add('hidden');this.el.chat.classList.remove('typing');const input=this.el['chat-input'] as HTMLInputElement;input.value='';input.blur();this.updateChat(performance.now());this.chatClosed();}
 private submitChat(){const text=Array.from((this.el['chat-input'] as HTMLInputElement).value.replace(/[\u0000-\u001f\u007f-\u009f]/gu,' ').trim()).slice(0,256).join('');if(text)this.chatSend(text);this.closeChat();}
 releaseChatKey(code:string){this.chatKeys.delete(code);}
 handleChatKey(event:KeyboardEvent){
  // A held key from text entry must not become a gameplay command when chat
  // closes (especially a repeating Escape opening the pause menu).
  if(!this.chatOpen&&event.repeat&&this.chatKeys.has(event.code)){event.preventDefault();event.stopPropagation();return true;}
  if(!event.repeat)this.chatKeys.delete(event.code);
  if(this.chatOpen){this.chatKeys.add(event.code);if(!event.isComposing&&(event.code==='Escape'||event.code==='Enter'||event.code==='NumpadEnter')){event.preventDefault();if(event.code==='Escape')this.closeChat();else if(!event.repeat)this.submitChat();}event.stopPropagation();return true;}
  if(!this.online||!this.inGame||this.modalOpen||this.selectionOpen||this.lobbyOpen||!this.el.pause.classList.contains('hidden')||event.repeat||event.ctrlKey||event.altKey||event.metaKey||event.isComposing)return false;
  if(event.code==='KeyT'||event.code==='Enter'||event.code==='NumpadEnter'){this.chatKeys.add(event.code);event.preventDefault();event.stopPropagation();this.openChat();return true;}return false;
 }
 addChat(line:ChatLine){
  if(line.id&&this.chatIds.has(line.id))return;if(line.id){this.chatIds.add(line.id);if(this.chatIds.size>100)this.chatIds.delete(this.chatIds.values().next().value!);}
  const item=document.createElement('div');item.className=line.system?'chat-line chat-system':'chat-line';item.dataset.until=String(performance.now()+12000);
  if(line.name){const name=document.createElement('span');name.className='chat-name';name.innerHTML=playerNameHTML(line.name);item.append(name,document.createTextNode(': '));}
  item.append(document.createTextNode(Array.from(line.message).slice(0,256).join('')));this.el['chat-log'].append(item);while(this.el['chat-log'].children.length>8)this.el['chat-log'].firstElementChild?.remove();this.updateChat(performance.now());
 }
 private updateChat(now:number){for(const line of this.el['chat-log'].children)hudClass(line,'hidden',!this.chatOpen&&now>Number((line as HTMLElement).dataset.until));}
 refreshSelection(){document.querySelectorAll<HTMLElement>('[data-faction]').forEach(b=>{const active=!this.spectatorSelection&&b.dataset.faction===this.prefs.faction;b.classList.toggle('selected',active);b.setAttribute('aria-pressed',String(active));});
  this.el['choose-spectator'].classList.toggle('selected',this.spectatorSelection);this.el['choose-spectator'].setAttribute('aria-pressed',String(this.spectatorSelection));
 }
 setSelectionBusy(busy:boolean){this.selectionBusy=busy;document.querySelectorAll<HTMLButtonElement>('[data-faction],#choose-spectator').forEach(button=>{button.disabled=!this.ready||busy;});this.el['menu-team'].setAttribute('aria-busy',String(busy));this.setSelectionStatus(busy?'Connecting…':'');}
 setSelectionStatus(text:string){this.el['selection-status'].textContent=text;this.el['selection-status'].classList.toggle('hidden',!text);}
 setLoadingProgress(value:number){
  if(!Number.isFinite(value))return;
  const progress=Math.max(this.loadingProgress,Math.min(1,Math.max(0,value)));
  if(progress===this.loadingProgress)return;this.loadingProgress=progress;
  this.el['loading-fill'].style.transform=`scaleX(${progress})`;
  this.el['loading-progress'].setAttribute('aria-valuenow',String(Math.round(progress*1000)/10));
 }
 setReady(ready:boolean){
  this.ready=ready;(this.el.start as HTMLButtonElement).disabled=!ready;(this.el.multiplayer as HTMLButtonElement).disabled=!ready;this.setSelectionBusy(this.selectionBusy);this.refreshBackgroundInert();this.el.menu.setAttribute('aria-busy',String(!ready));
  clearTimeout(this.loadingCompletion);
  if(ready){
   // Let the final fill finish before fading, without holding game startup.
   this.setLoadingProgress(1);this.el.loading.classList.add('loading-complete');
   this.loadingCompletion=setTimeout(()=>this.el.loading.classList.add('hidden'),500);
  }else{
   this.loadingProgress=0;this.el['loading-fill'].style.transform='scaleX(0)';this.el['loading-progress'].setAttribute('aria-valuenow','0');
   this.el.loading.classList.remove('hidden','loading-complete');
  }
 }
 setMenuStage(stage:typeof this.menuStage,focus=true){this.lobbyOpen=false;this.el['lobby-window'].classList.add('hidden');this.menuStage=stage;this.el['players-online'].classList.toggle('hidden',stage!=='main');this.el.menu.classList.toggle('intro-active',stage==='main');this.el['selection-window'].classList.toggle('hidden',stage==='main');
  for(const name of ['main','team'])this.el['menu-'+name].classList.toggle('hidden',name!==stage);
  document.querySelectorAll<HTMLElement>('[data-menu-tab]').forEach(b=>{const active=b.dataset.menuTab===stage;b.classList.toggle('active',active);if(active)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current');});
  if(focus){const target=stage==='main'?this.el.multiplayer:document.querySelector<HTMLElement>(`[data-faction="${this.prefs.faction}"]`);if(target instanceof HTMLButtonElement&&target.disabled)document.querySelector<HTMLElement>(`[data-menu-tab="${stage}"]`)?.focus();else target?.focus();}
 }
 handleMenuKey(event:KeyboardEvent){
  if(!this.ready||this.modalOpen||event.repeat||event.ctrlKey||event.altKey||event.metaKey)return;
  if(this.lobbyOpen){
   if(event.code==='Escape'){event.preventDefault();this.lobbyBack();return;}
   if((event.code==='ArrowUp'||event.code==='ArrowDown')&&this.el['lobby-rows'].contains(event.target as Node)){event.preventDefault();if(this.lobbyRows.length&&!this.lobbyBusy){const index=this.lobbyRows.findIndex(row=>row.id===this.selectedLobby),next=(index+(event.code==='ArrowDown'?1:-1)+this.lobbyRows.length)%this.lobbyRows.length;this.selectLobbyRow(this.lobbyRows[next].id);const button=this.el['lobby-rows'].children[next]?.querySelector('button');button?.focus();button?.scrollIntoView({block:'nearest'});}return;}
   if((event.code==='Enter'||event.code==='NumpadEnter')&&this.el['lobby-rows'].contains(event.target as Node)){event.preventDefault();(this.el['lobby-join'] as HTMLButtonElement).click();}return;
  }
  const digit=event.code.match(/^(?:Digit|Numpad)([0-4])$/)?.[1];
  if(event.code==='Escape'||digit==='0'){if(this.selectionOpen){event.preventDefault();this.cancelSelection();}return;}
  if(this.menuStage==='team'&&digit==='4'){event.preventDefault();(this.el['choose-spectator'] as HTMLButtonElement).click();return;}
  if(this.menuStage==='team'&&digit&&digit!=='0'){event.preventDefault();document.querySelector<HTMLButtonElement>(`[data-faction="${(['british','russian','german'] as const)[Number(digit)-1]}"]`)?.click();return;}
  if(event.code==='Enter'&&this.menuStage==='main'&&!(event.target instanceof HTMLButtonElement)){event.preventDefault();(this.el.multiplayer as HTMLButtonElement).click();}
  if(event.code==='Slash'){event.preventDefault();this.openModal('controls');}
 }
 openSelection(){this.setSelectionBusy(false);this.spectatorSelection=this.spectating;this.selectionOpen=true;this.closeChat();this.closeModal();this.scoreHeld=false;this.el.menu.classList.remove('hidden');for(const id of ['hud','pause','scoreboard'])this.el[id].classList.add('hidden');this.refreshSelection();this.setMenuStage('team');}
 closeSelection(){this.selectionOpen=false;this.el.menu.classList.add('hidden');this.el.hud.classList.remove('hidden');this.setMenuStage('main',false);}
 refreshSettings(){(this.el.difficulty as HTMLSelectElement).value=this.prefs.difficulty;(this.el['player-name'] as HTMLInputElement).value=this.prefs.playerName;this.el['player-name-preview'].innerHTML=playerNameHTML(this.prefs.playerName);(this.el.sensitivity as HTMLInputElement).value=String(this.prefs.sensitivity);(this.el.volume as HTMLInputElement).value=String(this.prefs.volume);this.el['sensitivity-value'].textContent=this.prefs.sensitivity.toFixed(1);this.el['volume-value'].textContent=Math.round(this.prefs.volume*100)+'%';(this.el['aim-mode'] as HTMLSelectElement).value=this.prefs.aim;(this.el.quality as HTMLSelectElement).value=this.prefs.quality;(this.el.invert as HTMLInputElement).checked=this.prefs.invert;this.refreshTouchSettings();}
 openModal(tab:string){
  this.el['difficulty-setting'].classList.toggle('hidden',!this.inGame||this.online);const selected=['controls','credits','feedback','leaderboard'].includes(tab)?tab:'settings';
  if(!this.modalOpen)this.modalReturnFocus=document.activeElement instanceof HTMLElement?document.activeElement:null;
  this.modalOpen=true;this.closeChat();this.refreshBackgroundInert();
  this.el.modal.classList.remove('hidden');const community=selected==='feedback'||selected==='leaderboard';this.el['modal-dialog'].classList.toggle('community-dialog',community);this.el['modal-dialog'].classList.toggle('leaderboard-dialog',selected==='leaderboard');this.el['modal-dialog'].setAttribute('aria-label',selected==='settings'?'Options':selected[0].toUpperCase()+selected.slice(1));this.el['options-tabs'].classList.toggle('hidden',selected!=='settings'&&selected!=='controls');
  document.querySelectorAll<HTMLElement>('[data-tab]').forEach(b=>b.classList.toggle('active',b.dataset.tab===selected));for(const t of ['controls','settings','credits','feedback','leaderboard'])this.el['tab-'+t].classList.toggle('hidden',t!==selected);
  if(selected==='feedback')(this.feedbackBusy?this.el['modal-close']:this.el['feedback-message']).focus();else this.el['modal-close'].focus();
  if(selected==='leaderboard')this.leaderboardLoad();
 }
 setOnlineCount(count:number|null){this.el['players-online'].textContent=count===null?'— players online':`${count} ${count===1?'player':'players'} online`;this.el['players-online'].title=count===null?'Online count unavailable':'';}
 async submitFeedback(){
  if(this.feedbackBusy)return;const message=this.el['feedback-message'] as HTMLTextAreaElement,email=this.el['feedback-email'] as HTMLInputElement,status=this.el['feedback-status'],submit=this.el['feedback-submit'] as HTMLButtonElement;
  try{validateFeedback(message.value,email.value);}catch(error){status.textContent=error instanceof Error?error.message:'Enter your feedback.';(status.textContent.includes('email')?email:message).focus();return;}
  this.feedbackBusy=true;submit.disabled=true;message.disabled=true;email.disabled=true;status.textContent='Sending…';
  try{await this.feedbackSend(message.value,email.value);message.value='';email.value='';status.textContent='Feedback sent. Thank you.';}
  catch(error){status.textContent=error instanceof Error?error.message:'Unable to send feedback. Please try again.';}
  finally{this.feedbackBusy=false;submit.disabled=false;message.disabled=false;email.disabled=false;}
 }
 setLeaderboardStatus(text:string,busy=false){this.leaderboardBusy=busy;this.leaderboardStatus=text;this.el['leaderboard-status'].textContent=text;(this.el['leaderboard-refresh'] as HTMLButtonElement).disabled=busy;this.el['leaderboard-panel'].setAttribute('aria-busy',String(busy));}
 setLeaderboard(data:Leaderboard){this.leaderboardData=data;this.setLeaderboardStatus('');this.renderLeaderboard();}
 private setLeaderboardPeriod(period:LeaderboardPeriod){this.leaderboardPeriod=period;this.renderLeaderboard();}
 private renderLeaderboard(){
  const recent=this.leaderboardPeriod==='last24Hours';document.querySelectorAll<HTMLButtonElement>('[data-period]').forEach(button=>{const selected=button.dataset.period===this.leaderboardPeriod;button.setAttribute('aria-selected',String(selected));button.tabIndex=selected?0:-1;});
  this.el['leaderboard-panel'].setAttribute('aria-labelledby',recent?'leaderboard-recent':'leaderboard-alltime');this.el['leaderboard-panel'].querySelector('table')?.setAttribute('aria-label',recent?'Kills and deaths in the last 24 hours':'All-time kills and deaths');
  this.el['leaderboard-rows'].replaceChildren();if(!this.leaderboardData)return;
  const rows=this.leaderboardData[this.leaderboardPeriod];rows.forEach((entry,index)=>{const row=document.createElement('tr');for(const value of [String(index+1),entry.name,String(entry.kills),String(entry.deaths)]){const cell=document.createElement('td');cell.textContent=value;row.append(cell);}this.el['leaderboard-rows'].append(row);});
  this.el['leaderboard-status'].textContent=this.leaderboardStatus||(!rows.length&&!this.leaderboardBusy?'No players yet.':'');
 }

 closeModal(){this.modalOpen=false;this.el.modal.classList.add('hidden');this.refreshBackgroundInert();if(!this.mobileGate)this.modalReturnFocus?.focus();this.modalReturnFocus=null;}
 handleModalKey(event:KeyboardEvent){if(event.code!=='Tab')return;
  const buttons=[...this.el.modal.querySelectorAll<HTMLElement>('button,input,textarea,select,a[href],[tabindex]')].filter(e=>!e.closest('.hidden')&&!e.hasAttribute('disabled')&&e.tabIndex>=0),first=buttons[0],last=buttons.at(-1);
  if(!first)return;
  if(event.shiftKey&&(document.activeElement===first||!this.el.modal.contains(document.activeElement))){event.preventDefault();last?.focus();}
  else if(!event.shiftKey&&(document.activeElement===last||!this.el.modal.contains(document.activeElement))){event.preventDefault();first.focus();}
 }
 toast(message:string){this.el.toast.textContent=message;this.el.toast.classList.remove('hidden');setTimeout(()=>this.el.toast.classList.add('hidden'),4000);}
 showDamage(lethal=false){this.damageStarted=performance.now();this.damageLethal=lethal;this.damageUntil=this.damageStarted+(lethal?1100:620);}
 showKill(victimName:string){this.killUntil=performance.now()+3000;this.el['kill-message'].innerHTML=`You killed ${playerNameHTML(victimName)}`;this.el['kill-message'].style.opacity='1';this.el['kill-message'].classList.remove('hidden');}
 showMenu(){this.setSelectionBusy(false);this.spectating=this.spectatorSelection=false;this.inGame=false;this.selectionOpen=false;this.setOnline(false);this.el.menu.classList.remove('hidden');for(const id of ['hud','pause','scoreboard'])this.el[id].classList.add('hidden');this.feed=[];this.killUntil=0;this.setMenuStage('main');}
 begin(){this.inGame=true;this.closeSelection();this.closeModal();this.damageStarted=-Infinity;this.damageUntil=0;this.feed=[];this.killUntil=0;this.scoreHeld=false;this.el['kill-message'].classList.add('hidden');this.el.menu.classList.add('hidden');this.el.pause.classList.add('hidden');this.el.scoreboard.classList.add('hidden');this.el.hud.classList.remove('hidden');}
 update(game:Game,waitingForRespawn=false){
  if(!game.player)return;const replayActor=game.state==='killcam'?game.replayFrame()?.actors[game.killer]:null;const p=replayActor?{...game.actors[game.killer],...replayActor}:game.viewedActor??game.player,now=performance.now();
  const markup=this.hudMarkup;
  const spectating=game.player.spectator,followed=spectating?game.spectator.target(game.actors):null;
  hudClass(this.el.hud,'spectator-free',spectating&&!followed);hudClass(this.el['spectator-status'],'hidden',!spectating);
  hudClass(this.el['spectator-help'],'hidden',!spectating);hudText(this.el['spectator-help'],this.touchEnabled?(followed?'Previous / Next · Change player    Free fly · Leave follow':'Move · Fly    Drag right side · Look    Rise / Lower · Height'):(followed?'LMB / RMB · Player    Esc · Free fly':'WASD · Fly    Space / Ctrl · Up / down    Shift · Fast    LMB / RMB · Follow'));
  markup.set(this.el['spectator-status'],JSON.stringify([spectating,followed?.name]),()=>spectating?`Spectating: ${followed?playerNameHTML(followed.name):'Free fly'}`:'');
  hudText(this.el['open-team'],spectating?'Join game':'Select team');
  this.spectating=spectating;
  hudClass(this.el.pause,'hidden',game.state!=='paused'||this.scoreHeld||this.modalOpen||this.selectionOpen);hudClass(this.el.scoreboard,'hidden',this.selectionOpen||!(this.scoreHeld||game.state==='ended'));
  hudClass(this.el.killcam,'hidden',game.state!=='killcam');hudClass(this.el.hud,'killcam-active',game.state==='killcam');const killerName=game.actors[game.killer]?.name??DEFAULT_PLAYER_NAME;markup.set(this.el['killer-name'],killerName,()=>playerNameHTML(killerName));
  hudClass(this.el['skip-killcam'],'hidden',waitingForRespawn);hudClass(this.el['respawn-wait'],'hidden',!waitingForRespawn);
  hudClass(this.el.crosshair,'hidden',spectating||p.ads||!game.player.grounded||game.state!=='playing'||p.reload>0||game.isSwitching(game.player)||p.selectedWeapon==='grenade');
  // Follow the physical spread state, with presentation-only reticle scaling.
  hudStyle(this.el.crosshair,'--spread',`${crosshairDisplayGapPixels(game.playerHipSpread,window.innerHeight)}px`);
  hudStyle(this.el['damage-flash'],'opacity',String(spectating?0:damageFlashOpacity(now-this.damageStarted,this.damageLethal)));
  hudClass(this.el['hit-confirm'],'hidden',spectating||now>this.hitUntil);
  hudClass(this.el['kill-message'],'hidden',spectating||now>=this.killUntil||game.state!=='playing');hudStyle(this.el['kill-message'],'opacity',String(Math.min(1,Math.max(0,(this.killUntil-now)/600))));
  hudClass(this.el['spawn-protection'],'hidden',spectating||p.spawnSafe<=0||game.state!=='playing');
  hudStyle(this.el['compass-rose'],'transform',`rotate(${(spectating&&!followed?game.spectator.yaw:p.yaw)*180/Math.PI}deg)`);
  hudText(this.el['status-message'],spectating?'':p.selectedWeapon==='grenade'||p.reload>0?'':p.ammo===0&&p.reserve===0?'Out of ammunition':p.cooldown>.3?'':p.ammo<=2?(this.touchEnabled?'Tap Reload':'R · Reload'):'');
  if(now-this.lastHud<100)return;this.lastHud=now;this.updateChat(now);
  const clock=`${Math.floor(game.remaining/60).toString().padStart(2,'0')}:${Math.floor(game.remaining%60).toString().padStart(2,'0')}`;
  hudText(this.el['match-clock'],clock);hudText(this.el['score-time'],clock);hudText(this.el.ammo,String(p.ammo));hudText(this.el.reserve,p.selectedWeapon==='grenade'?'':String(p.reserve));if(this.el.ammo.parentElement)hudClass(this.el.ammo.parentElement,'hidden',p.selectedWeapon==='grenade');hudText(this.el.health,String(p.hp));hudStyle(this.el['health-fill'],'width',p.hp+'%');hudStyle(this.el['health-fill'],'background',p.hp<35?'rgb(179, 76, 60)':'rgb(147, 168, 114)');
  const rounds=this.el['round-icons'],capacity=WEAPONS[p.faction].capacity;
  hudClass(rounds,'hidden',p.selectedWeapon==='grenade');markup.set(rounds,String(capacity),()=>'<i></i>'.repeat(capacity));
  for(let i=0;i<rounds.children.length;i++)hudClass(rounds.children[i],'loaded',i<p.ammo);
  markup.set(this.el['weapon-slot'],`${p.faction}:${p.selectedWeapon}`,()=>`<span>${p.selectedWeapon==='grenade'?'2':'1'}</span>${weaponIcon(p.faction,p.selectedWeapon)}<span>${p.selectedWeapon==='grenade'?'Stielhandgranate':WEAPONS[p.faction].name}</span>`);
  for(let i=this.feed.length-1;i>=0;i--)if(now-this.feed[i].time>=6500)this.feed.splice(i,1);
  const feedKey=JSON.stringify(this.feed.map(f=>[f.time,f.text]));markup.set(this.el.killfeed,feedKey,()=>this.feed.map(f=>`<div>${f.text}</div>`).join(''));
  if(this.scoreHeld||game.state==='ended'){
   const scoreKey=JSON.stringify([this.online,game.actors.map(a=>[a.id,a.spectator,a.faction,a.name,a.kills,a.deaths,this.online?a.ping:null])]);markup.set(this.el['score-rows'],scoreKey,()=>scoreboardRows(game.actors,this.online));
   const ended=game.state==='ended';hudClass(this.el['score-close'],'hidden',ended);hudClass(this.el['end-actions'],'hidden',!ended);hudClass(this.el.again,'hidden',this.online);hudText(this.el['score-title'],ended?(game.winner?.id===0?'Victory':'Round complete'):'Scoreboard');hudClass(this.el['score-winner'],'hidden',!ended);markup.set(this.el['score-winner'],JSON.stringify([ended,game.winner?.name]),()=>ended&&game.winner?`${playerNameHTML(game.winner.name)} wins`:'');
  }
 }
}
