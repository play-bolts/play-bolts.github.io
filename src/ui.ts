import {WEAPONS,type Difficulty,type Faction} from './config';
import {CROSSHAIR_DISPLAY_SCALE,crosshairDisplayGapPixels} from './accuracy';
import {weaponIcon} from './weaponIcons';
import {damageFlashOpacity} from './damageFeedback';
import type {Actor,Game} from './engine';
import {DEFAULT_PLAYER_NAME,PLAYER_NAME_PREFERENCE_VERSION,MAX_NAME_RAW_LENGTH,playerNameHTML,sanitizePlayerName,restorePlayerNamePreference} from './names';
const closeIcon='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="m6 6 12 12M6 18 18 6"/></svg>';
const controls=[['W A S D','Move'],['Mouse','Look'],['LMB','Fire / grenade bash'],['RMB','Iron sights'],['1 / 2','Rifle / grenade'],['Wheel','Switch weapon'],['R','Reload'],['Space','Jump / stand'],['C','Crouch'],['Ctrl','Prone'],['Q / E','Lean'],['Shift','Melee'],['Alt','Walk'],['Tab','Scoreboard'],['T / Enter','Chat'],['M','Change team'],['Esc','Menu / leave follow'],['LMB / RMB','Spectator: next / previous'],['Space / Ctrl','Spectator: up / down'],['Shift','Spectator: faster']];
export interface Preferences {faction:Faction;difficulty:Difficulty;playerName:string;playerNameVersion:number;sensitivity:number;volume:number;aim:'toggle'|'hold';quality:string;invert:boolean}
export interface LobbyRow {id:string;name:string;players:number;capacity:number;ping?:number}
export interface ChatLine {id?:string;name?:string;message:string;system?:boolean}
export function scoreboardRows(actors:readonly Actor[],online:boolean){
 return [...actors].sort((a,b)=>Number(a.spectator)-Number(b.spectator)||b.kills-a.kills||a.deaths-b.deaths).map((a,i)=>`<tr class="${a.id===0?'player-row':''}"><td>${a.spectator?'—':i+1}</td><td><span class="flag ${a.faction}">${a.faction==='russian'?'★':''}</span><strong>${playerNameHTML(a.name)}</strong>${a.spectator?'<span class=score-spectator>Spectator</span>':''}</td><td>${a.kills}</td><td>${a.deaths}</td>${online?`<td class="score-ping">${typeof a.ping==='number'&&Number.isInteger(a.ping)&&a.ping>=0&&a.ping<=999?a.ping:'—'}</td>`:''}</tr>`).join('');
}
export class UI {
 menuStage:'main'|'team'|'weapon'='main';selectionOpen=false;ready=false;menuChanged=()=>{};
 private inGame=false;private spectating=false;private spectatorSelection=false;
 online=false;lobbyOpen=false;chatOpen=false;
 private lobbyRows:LobbyRow[]=[];private selectedLobby='';private lobbyBusy=false;
 private chatIds=new Set<string>();
 private chatKeys=new Set<string>();
 multiplayer=()=>{};refreshLobbies=()=>{};joinLobby=(_id:string)=>{};lobbyBack=()=>this.closeLobbies();
 chatSend=(_text:string)=>{};chatOpened=()=>{};chatClosed=()=>{};
 private modalReturnFocus:HTMLElement|null=null;
 prefs:Preferences={faction:'british',difficulty:'regular',playerName:DEFAULT_PLAYER_NAME,playerNameVersion:PLAYER_NAME_PREFERENCE_VERSION,sensitivity:1,volume:.6,aim:'toggle',quality:'high',invert:false};
 selectLoadout=()=>{};selectSpectator=()=>{};selectTeam=()=>{};selectWeapon=()=>{};cancelSelection=()=>{};
 start=()=>{};resume=()=>{};pause=()=>{};leave=()=>{};settingsChanged=()=>{};skip=()=>{};
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
   this.prefs.invert=!!saved.invert;
   if(saved.playerName==='Player'&&this.prefs.playerName!==saved.playerName)localStorage.setItem('bolts-preferences',JSON.stringify({...saved,playerName:this.prefs.playerName,playerNameVersion:PLAYER_NAME_PREFERENCE_VERSION}));
  }catch{}
  document.querySelector('#app')!.innerHTML=`
  <div id="world" aria-label="3D arena"></div><div class="film-grain"></div><div class="vignette"></div>
  <div id="menu" class="screen menu intro-active">    <section id="menu-main" class="intro-menu" aria-label="Main menu">
     <h1>BOLTS</h1>
     <div class="main-choices"><button id="start" class="classic-choice">Single player</button><button id="multiplayer" class="classic-choice">Multiplayer</button><button class="classic-choice settings-button">Options</button><button class="classic-choice controls-button">Controls</button></div>
    </section>
  <section id="lobby-window" class="classic-window lobby-window hidden" aria-labelledby="lobby-title">
   <header class="lobby-heading"><h2 id="lobby-title">Join game</h2></header>
   <div class="lobby-list"><table aria-label="Available games"><thead><tr><th scope="col">Name</th><th scope="col">Players</th><th scope="col">Ping</th></tr></thead><tbody id="lobby-rows"></tbody></table><div id="lobby-status" role="status" aria-live="polite"></div></div>
   <nav class="lobby-actions" aria-label="Lobby actions"><button id="lobby-back">Back</button><button id="lobby-refresh">Refresh</button><button id="lobby-join" disabled>Join</button></nav>
  </section>
<main id="selection-window" class="classic-window hidden" aria-label="Bolts multiplayer menu">
   <nav class="selection-tabs" aria-label="Menu"><button id="selection-close">Back</button><button data-menu-tab="team">Team</button><button data-menu-tab="weapon">Weapon</button><button class="settings-button">Options</button><button class="controls-button">Controls</button></nav>
   <div class="selection-body">
    <section id="menu-team" class="menu-pane hidden" aria-label="Select team">
     <div class="team-choices" role="group" aria-label="Team"><button class="classic-choice" data-faction="british" aria-pressed="false">British</button><button class="classic-choice" data-faction="russian" aria-pressed="false">Russian</button><button class="classic-choice" data-faction="german" aria-pressed="false">German</button><button id="choose-spectator" class="classic-choice" aria-pressed="false">Spectator</button></div>
    </section>
    <section id="menu-weapon" class="menu-pane weapon-pane hidden" aria-label="Select weapon">
     <div class="weapon-choices"><button id="choose-weapon" class="classic-choice" aria-label="Select rifle and enter game"><span id="weapon-choice-name">Lee–Enfield</span></button></div>
     <div class="weapon-details"><canvas id="weapon-preview" aria-label="Selected rifle preview"></canvas><h2 id="weapon-title">Lee–Enfield</h2></div>
    </section>
   </div>
  </main></div>
  <div id="hud" class="screen hidden">
   <div id="match-clock">05:00</div><button id="hud-menu" aria-label="Pause and open menu">Esc · Menu</button><div id="killfeed"></div><div id="network-status" class="hidden" role="status"></div>
   <div id="chat" class="chat hidden"><div id="chat-log" role="log" aria-label="Game chat" aria-live="polite" aria-relevant="additions"></div><form id="chat-form" class="hidden" autocomplete="off"><label for="chat-input">Say:</label><input id="chat-input" type="text" maxlength="512" autocomplete="off" spellcheck="false" aria-label="Chat message"></form></div>
   <div id="crosshair" style="--tick-length:${6*CROSSHAIR_DISPLAY_SCALE}px"><i></i><i></i><i></i><i></i></div><div id="damage-flash"></div><div id="hit-confirm" class="hidden">×</div><div id="spawn-protection" class="hidden">Spawn protection</div>
   <div class="compass-wrap"><div class="compass"><div id="compass-rose"><span class="north">N</span><span class="east">E</span><span class="south">S</span><span class="west">W</span><i class="needle"></i></div><i class="compass-pointer"></i></div></div>
   <div id="spectator-status" class="hidden" role="status"></div><div id="spectator-help" class="hidden"></div><div id="status-message"></div><div id="kill-message" class="hidden" role="status"></div>
   <div class="ammo-hud"><div id="weapon-slot"></div><div class="ammo-line"><strong id="ammo">10</strong><span class="ammo-divider">/</span><span id="reserve">60</span></div><div id="round-icons"></div><div class="health-row"><span>✚</span><div class="health-track"><i id="health-fill"></i></div><b id="health">100</b></div></div>
   <div id="killcam" class="hidden"><div class="killcam-top"><span>Killcam</span><span id="killer-name"></span></div><div class="killcam-bottom"><button id="skip-killcam">Skip <kbd>Space</kbd></button></div></div>
  </div>
  <div id="pause" class="overlay hidden"><div class="dialog pause-card"><h2 id="pause-title">Paused</h2><button id="resume" class="start-button">Resume</button><button id="open-team" class="secondary-button">Select team</button><button id="open-weapon" class="secondary-button">Select weapon</button><button id="pause-score" class="secondary-button">Scoreboard</button><button class="secondary-button settings-button">Options</button><button class="secondary-button controls-button">Controls</button><button id="leave" class="secondary-button">Main menu</button></div></div>
  <div id="scoreboard" class="overlay hidden"><div class="score-card"><button id="score-close" class="icon-button" aria-label="Close scoreboard">${closeIcon}</button><div class="score-heading"><span id="score-time">05:00</span></div><h2 id="score-title">Scoreboard</h2><p id="score-winner" class="hidden"></p><table><thead><tr><th>#</th><th>Player</th><th>Kills</th><th>Deaths</th><th id="score-ping" class="hidden" aria-label="Ping in milliseconds">Ping</th></tr></thead><tbody id="score-rows"></tbody></table><div id="end-actions" class="hidden"><button id="again" class="start-button">Play again</button><button id="end-leave" class="secondary-button">Main menu</button></div></div></div>
  <div id="modal" class="overlay hidden"><div class="dialog manual"><button id="modal-close" class="icon-button" aria-label="Close dialog">${closeIcon}</button><div class="modal-tabs"><button data-tab="settings" class="active">Options</button><button data-tab="controls">Controls</button><button data-tab="credits">Credits</button></div>
   <div id="tab-credits" class="hidden asset-credits">
    <p>Weapon models · <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener">CC BY 4.0</a></p>
    <ul><li><a href="https://sketchfab.com/3d-models/lee-enfield-mkiii-f6a2160daf134071a84e3cae5f831875" target="_blank" rel="noopener">Lee Enfield MKIII</a> — Moony_State</li><li><a href="https://sketchfab.com/3d-models/mosin-nagant-m91-92ede39f23bd40c7982c727dfd7c4be0" target="_blank" rel="noopener">Mosin Nagant M91</a> — MaX3Dd</li><li><a href="https://sketchfab.com/3d-models/kar98k-96b7387fe49b4dd491cc8277f765527a" target="_blank" rel="noopener">Kar98k</a> — Ecler</li><li><a href="https://sketchfab.com/3d-models/stielhandgranate-german-grenade-c49ce26939d64641afac1175a8d62338" target="_blank" rel="noopener">Stielhandgranate</a> — Janovich</li></ul>
    <p>Adapted for Bolts: scale, moving parts, hand contacts and texture optimization.</p>
    <p>Full-body soldier models · CC BY 4.0</p>
    <ul><li><a href="https://sketchfab.com/3d-models/wwii-british-soldier-9af571fa416546f08dfc2ba95e604083" target="_blank" rel="noopener">WWII British Soldier</a> — patromes</li><li><a href="https://sketchfab.com/3d-models/ww2-panzergrenadier-fbx-tpose-cc0-99ae9a9deb2c46c5956342b3bf9de7a2" target="_blank" rel="noopener">WW2 Panzergrenadier</a> — britdawgmasterfunk</li><li><a href="https://sketchfab.com/3d-models/ww2-soviet-uniform-f85a4ed8c33a43eca1a7caa45f7acf99" target="_blank" rel="noopener">WW2 Soviet Uniform</a> — tnnv</li></ul>
    <p>Adapted with continuous body skinning, neutral bind poses, material response and optimized textures.</p>
    <p>CC0: Mesh2Motion / Quaternius motion; para / MakeHuman hands; MakeHuman head; ambientCG and Poly Haven materials.</p>
   </div>
   <div id="tab-controls" class="hidden"><div class="controls-grid">${controls.map(([key,label])=>`<div><kbd>${key}</kbd><span>${label}</span></div>`).join('')}</div></div>
   <div id="tab-settings">
    <label id="difficulty-setting" class="setting select-setting hidden">Difficulty<select id="difficulty"><option value="recruit">Recruit</option><option value="regular">Regular</option><option value="veteran">Veteran</option></select></label>
    <div class="name-setting"><label for="player-name">Player name</label><input id="player-name" type="text" maxlength="${MAX_NAME_RAW_LENGTH}" autocomplete="off" spellcheck="false" aria-describedby="name-color-help"><div class="name-preview-row"><div id="player-name-preview" aria-label="Name preview"></div><small id="name-color-help">^0–^9</small></div></div>
    <label class="setting">Mouse sensitivity <output id="sensitivity-value">1.0</output><input id="sensitivity" type="range" min="0.2" max="2.5" step="0.1" value="1"></label>
    <label class="setting">Volume <output id="volume-value">60%</output><input id="volume" type="range" min="0" max="1" step="0.05" value=".6"></label>
    <label class="setting select-setting">Iron sights<select id="aim-mode"><option value="toggle">Toggle</option><option value="hold">Hold</option></select></label>
    <label class="setting select-setting">Visual quality<select id="quality"><option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option></select></label>
    <label class="setting select-setting">Invert mouse Y<input id="invert" type="checkbox"></label><button id="fullscreen" class="text-button">Fullscreen</button>
   </div>
  </div></div><div id="toast" role="status" class="hidden"></div><div id="loading" class="overlay loading-overlay" role="status" aria-live="polite"><div class="loading-content"><div id="loading-label">Loading</div><progress id="loading-progress" max="100" value="0" aria-labelledby="loading-label"></progress></div></div><div id="load-error" class="overlay hidden"></div>`;
  for(const e of document.querySelectorAll<HTMLElement>('[id]'))this.el[e.id]=e;
  document.querySelectorAll<HTMLButtonElement>('[data-faction]').forEach(b=>b.onclick=()=>{this.spectatorSelection=false;this.prefs.faction=b.dataset.faction as Faction;this.refreshSelection();this.setMenuStage('weapon');});
  (this.el.difficulty as HTMLSelectElement).onchange=()=>{this.prefs.difficulty=(this.el.difficulty as HTMLSelectElement).value as Difficulty;this.save();};
  this.el.start.onclick=()=>this.start();this.el.resume.onclick=()=>this.resume();this.el.leave.onclick=()=>this.leave();this.el.again.onclick=()=>this.start();this.el['end-leave'].onclick=()=>this.leave();this.el['skip-killcam'].onclick=()=>this.skip();this.el['hud-menu'].onclick=()=>this.pause();
  this.el.multiplayer.onclick=()=>this.multiplayer();this.el['lobby-refresh'].onclick=()=>this.refreshLobbies();this.el['lobby-join'].onclick=()=>{if(this.selectedLobby&&!this.lobbyBusy)this.joinLobby(this.selectedLobby);};this.el['lobby-back'].onclick=()=>this.lobbyBack();
  this.el['chat-form'].onsubmit=event=>{event.preventDefault();this.submitChat();};
  (this.el['chat-input'] as HTMLInputElement).oninput=()=>{const input=this.el['chat-input'] as HTMLInputElement,points=Array.from(input.value);if(points.length>256)input.value=points.slice(0,256).join('');};
  document.querySelectorAll<HTMLButtonElement>('[data-menu-tab]').forEach(b=>b.onclick=()=>this.setMenuStage(b.dataset.menuTab as typeof this.menuStage));
  this.el['open-team'].onclick=()=>this.selectTeam();this.el['open-weapon'].onclick=()=>this.selectWeapon();this.el['selection-close'].onclick=()=>this.cancelSelection();
  this.el['choose-spectator'].onclick=()=>{if(this.ready){this.spectatorSelection=true;this.refreshSelection();this.selectSpectator();}};
  this.el['choose-weapon'].onclick=()=>{if(this.ready)this.selectLoadout();};
  document.querySelectorAll<HTMLElement>('.settings-button').forEach(b=>b.onclick=()=>this.openModal('settings'));
  document.querySelectorAll<HTMLElement>('.controls-button').forEach(b=>b.onclick=()=>this.openModal('controls'));
  this.el['pause-score'].onclick=()=>{this.scoreHeld=true;};this.el['score-close'].onclick=()=>{this.scoreHeld=false;};this.el['modal-close'].onclick=()=>this.closeModal();this.el.modal.onclick=e=>{if(e.target===this.el.modal)this.closeModal();};
  document.querySelectorAll<HTMLElement>('[data-tab]').forEach(b=>b.onclick=()=>this.openModal(b.dataset.tab!));
  this.el.fullscreen.onclick=()=>{if(document.fullscreenElement)void document.exitFullscreen();else void document.documentElement.requestFullscreen().catch(()=>this.toast('Fullscreen unavailable.'));};
  const nameInput=this.el['player-name'] as HTMLInputElement;
  nameInput.oninput=()=>{this.prefs.playerName=sanitizePlayerName(nameInput.value);this.el['player-name-preview'].innerHTML=playerNameHTML(this.prefs.playerName);this.save();};
  nameInput.onblur=()=>{nameInput.value=this.prefs.playerName;};
  for(const key of ['sensitivity','volume'] as const){const e=this.el[key] as HTMLInputElement;e.oninput=()=>{this.prefs[key]=Number(e.value);this.refreshSettings();this.save();};}
  (this.el['aim-mode'] as HTMLSelectElement).onchange=()=>{this.prefs.aim=(this.el['aim-mode'] as HTMLSelectElement).value as 'toggle'|'hold';this.save();};
  (this.el.quality as HTMLSelectElement).onchange=()=>{this.prefs.quality=(this.el.quality as HTMLSelectElement).value;this.save();};
  (this.el.invert as HTMLInputElement).onchange=()=>{this.prefs.invert=(this.el.invert as HTMLInputElement).checked;this.save();};
  this.refreshSelection();this.refreshSettings();this.setReady(false);
 }
 save(){try{localStorage.setItem('bolts-preferences',JSON.stringify(this.prefs));}catch{}this.settingsChanged();}
 showLobbies(rows:LobbyRow[],status=''){
  this.lobbyRows=rows.map(row=>({...row}));
  if(!rows.some(row=>row.id===this.selectedLobby))this.selectedLobby=rows.find(row=>row.players<row.capacity)?.id??rows[0]?.id??'';
  const opening=!this.lobbyOpen;this.lobbyOpen=true;this.menuStage='main';this.el.menu.classList.remove('hidden','intro-active');this.el['menu-main'].classList.add('hidden');this.el['selection-window'].classList.add('hidden');this.el['lobby-window'].classList.remove('hidden');
  this.el['lobby-rows'].replaceChildren();
  for(const row of this.lobbyRows){
   const tr=document.createElement('tr'),name=document.createElement('td'),players=document.createElement('td'),ping=document.createElement('td'),button=document.createElement('button');
   tr.dataset.lobby=row.id;button.type='button';button.textContent=row.name;button.setAttribute('aria-label',row.name);button.setAttribute('aria-pressed',String(row.id===this.selectedLobby));name.append(button);
   players.textContent=`${row.players} / ${row.capacity}`;ping.textContent=typeof row.ping==='number'&&Number.isFinite(row.ping)?String(Math.max(0,Math.round(row.ping))):'—';
   tr.classList.toggle('selected',row.id===this.selectedLobby);tr.classList.toggle('full',row.players>=row.capacity);tr.append(name,players,ping);
   tr.onclick=()=>this.selectLobbyRow(row.id);tr.ondblclick=()=>{if(!this.lobbyBusy&&row.players<row.capacity)this.joinLobby(row.id);};
   this.el['lobby-rows'].append(tr);
  }
  this.setLobbyStatus(status||(!rows.length?'No games': ''),false);this.menuChanged();if(opening)(this.el['lobby-rows'].querySelector<HTMLButtonElement>('tr.selected button')??this.el['lobby-refresh']).focus();
 }
 private selectLobbyRow(id:string){this.selectedLobby=id;for(const row of this.el['lobby-rows'].children){const active=(row as HTMLElement).dataset.lobby===id;row.classList.toggle('selected',active);row.querySelector('button')?.setAttribute('aria-pressed',String(active));}this.refreshLobbyButtons();}
 private refreshLobbyButtons(){const selected=this.lobbyRows.find(row=>row.id===this.selectedLobby);(this.el['lobby-join'] as HTMLButtonElement).disabled=this.lobbyBusy||!selected||selected.players>=selected.capacity;(this.el['lobby-refresh'] as HTMLButtonElement).disabled=this.lobbyBusy;for(const button of this.el['lobby-rows'].querySelectorAll('button'))button.disabled=this.lobbyBusy;}
 setLobbyStatus(text:string,busy=false){this.lobbyBusy=busy;this.el['lobby-status'].textContent=text;this.el['lobby-window'].setAttribute('aria-busy',String(busy));this.refreshLobbyButtons();}
 closeLobbies(){this.lobbyOpen=false;this.el['lobby-window'].classList.add('hidden');this.setMenuStage('main');}
 setOnline(online:boolean,_lobbyName=''){
  this.online=online;this.el.hud.classList.toggle('online',online);this.el.chat.classList.toggle('hidden',!online);this.el['pause-title'].textContent=online?'Menu':'Paused';this.el['hud-menu'].setAttribute('aria-label',online?'Open menu':'Pause and open menu');this.el['difficulty-setting'].classList.toggle('hidden',!this.inGame||online);
  this.el['score-ping'].classList.toggle('hidden',!online);
  if(!online){this.closeChat();this.chatIds.clear();this.el['chat-log'].replaceChildren();this.setNetworkStatus('');if(this.lobbyOpen)this.closeLobbies();}
 }
 setNetworkStatus(text:string){this.el['network-status'].textContent=text;this.el['network-status'].classList.toggle('hidden',!text);}
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
 private updateChat(now:number){for(const line of this.el['chat-log'].children)(line as HTMLElement).classList.toggle('hidden',!this.chatOpen&&now>Number((line as HTMLElement).dataset.until));}
 refreshSelection(){document.querySelectorAll<HTMLElement>('[data-faction]').forEach(b=>{const active=!this.spectatorSelection&&b.dataset.faction===this.prefs.faction;b.classList.toggle('selected',active);b.setAttribute('aria-pressed',String(active));});
  this.el['choose-spectator'].classList.toggle('selected',this.spectatorSelection);this.el['choose-spectator'].setAttribute('aria-pressed',String(this.spectatorSelection));
  const weapon=WEAPONS[this.prefs.faction];
  this.el['weapon-choice-name'].textContent=weapon.name;this.el['weapon-title'].textContent=weapon.name;
  this.el['choose-weapon'].setAttribute('aria-label',`Select ${weapon.name} and enter game`);this.el['weapon-preview'].setAttribute('aria-label',`${weapon.name} rifle preview`);
 }
 setLoadingProgress(value:number){const progress=this.el['loading-progress'] as HTMLProgressElement;progress.value=Math.max(progress.value,Math.min(100,Math.max(0,value*100)));}
 setReady(ready:boolean){this.ready=ready;(this.el.start as HTMLButtonElement).disabled=!ready;(this.el.multiplayer as HTMLButtonElement).disabled=!ready;(this.el['choose-weapon'] as HTMLButtonElement).disabled=!ready;this.el.menu.inert=!ready;this.el.menu.setAttribute('aria-busy',String(!ready));if(ready)this.setLoadingProgress(1);this.el.loading.classList.toggle('hidden',ready);}
 setMenuStage(stage:typeof this.menuStage,focus=true){this.lobbyOpen=false;this.el['lobby-window'].classList.add('hidden');this.menuStage=stage;this.el.menu.classList.toggle('intro-active',stage==='main');this.el['selection-window'].classList.toggle('hidden',stage==='main');
  for(const name of ['main','team','weapon'])this.el['menu-'+name].classList.toggle('hidden',name!==stage);
  document.querySelectorAll<HTMLElement>('[data-menu-tab]').forEach(b=>{const active=b.dataset.menuTab===stage;b.classList.toggle('active',active);if(active)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current');});
  this.menuChanged();
  if(focus){const target=stage==='main'?this.el.multiplayer:stage==='weapon'?this.el['choose-weapon']:document.querySelector<HTMLElement>(`[data-faction="${this.prefs.faction}"]`);if(target instanceof HTMLButtonElement&&target.disabled)document.querySelector<HTMLElement>(`[data-menu-tab="${stage}"]`)?.focus();else target?.focus();}
 }
 handleMenuKey(event:KeyboardEvent){
  if(!this.ready||this.modalOpen||event.repeat||event.ctrlKey||event.altKey||event.metaKey)return;
  if(this.lobbyOpen){
   if(event.code==='Escape'){event.preventDefault();this.lobbyBack();return;}
   if(event.code==='ArrowUp'||event.code==='ArrowDown'){event.preventDefault();if(this.lobbyRows.length&&!this.lobbyBusy){const index=this.lobbyRows.findIndex(row=>row.id===this.selectedLobby),next=(index+(event.code==='ArrowDown'?1:-1)+this.lobbyRows.length)%this.lobbyRows.length;this.selectLobbyRow(this.lobbyRows[next].id);const button=this.el['lobby-rows'].children[next]?.querySelector('button');button?.focus();button?.scrollIntoView({block:'nearest'});}return;}
   if((event.code==='Enter'||event.code==='NumpadEnter')&&this.el['lobby-rows'].contains(event.target as Node)){event.preventDefault();(this.el['lobby-join'] as HTMLButtonElement).click();}return;
  }
  const digit=event.code.match(/^(?:Digit|Numpad)([0-4])$/)?.[1];
  if(event.code==='Escape'||digit==='0'){if(this.selectionOpen){event.preventDefault();this.selectionBack();}return;}
  if(this.menuStage==='team'&&digit==='4'){event.preventDefault();(this.el['choose-spectator'] as HTMLButtonElement).click();return;}
  if(this.menuStage==='team'&&digit&&digit!=='0'){event.preventDefault();document.querySelector<HTMLButtonElement>(`[data-faction="${(['british','russian','german'] as const)[Number(digit)-1]}"]`)?.click();return;}
  if(this.menuStage==='weapon'&&digit==='1'){event.preventDefault();(this.el['choose-weapon'] as HTMLButtonElement).click();return;}
  if(event.code==='Enter'&&this.menuStage==='main'&&!(event.target instanceof HTMLButtonElement)){event.preventDefault();(this.el.multiplayer as HTMLButtonElement).click();}
  if(event.code==='Slash'){event.preventDefault();this.openModal('controls');}
 }
 openSelection(stage:'team'|'weapon'){this.spectatorSelection=this.spectating;this.selectionOpen=true;this.closeChat();this.closeModal();this.scoreHeld=false;this.el.menu.classList.remove('hidden');for(const id of ['hud','pause','scoreboard'])this.el[id].classList.add('hidden');this.refreshSelection();this.setMenuStage(stage);}
 closeSelection(){this.selectionOpen=false;this.el.menu.classList.add('hidden');this.el.hud.classList.remove('hidden');this.setMenuStage('main',false);}
 selectionBack(){if(this.menuStage==='weapon')this.setMenuStage('team');else this.cancelSelection();}
 refreshSettings(){(this.el.difficulty as HTMLSelectElement).value=this.prefs.difficulty;(this.el['player-name'] as HTMLInputElement).value=this.prefs.playerName;this.el['player-name-preview'].innerHTML=playerNameHTML(this.prefs.playerName);(this.el.sensitivity as HTMLInputElement).value=String(this.prefs.sensitivity);(this.el.volume as HTMLInputElement).value=String(this.prefs.volume);this.el['sensitivity-value'].textContent=this.prefs.sensitivity.toFixed(1);this.el['volume-value'].textContent=Math.round(this.prefs.volume*100)+'%';(this.el['aim-mode'] as HTMLSelectElement).value=this.prefs.aim;(this.el.quality as HTMLSelectElement).value=this.prefs.quality;(this.el.invert as HTMLInputElement).checked=this.prefs.invert;}
 openModal(tab:string){this.el['difficulty-setting'].classList.toggle('hidden',!this.inGame||this.online);const selected=tab==='controls'||tab==='credits'?tab:'settings';if(!this.modalOpen)this.modalReturnFocus=document.activeElement instanceof HTMLElement?document.activeElement:null;this.modalOpen=true;this.closeChat();for(const id of ['menu','hud','pause','scoreboard'])this.el[id].inert=true;this.el.modal.classList.remove('hidden');document.querySelectorAll<HTMLElement>('[data-tab]').forEach(b=>b.classList.toggle('active',b.dataset.tab===selected));for(const t of ['controls','settings','credits'])this.el['tab-'+t].classList.toggle('hidden',t!==selected);this.el['modal-close'].focus();}
 closeModal(){this.modalOpen=false;this.el.modal.classList.add('hidden');for(const id of ['menu','hud','pause','scoreboard'])this.el[id].inert=false;this.modalReturnFocus?.focus();this.modalReturnFocus=null;}
 handleModalKey(event:KeyboardEvent){if(event.code!=='Tab')return;
  const buttons=[...this.el.modal.querySelectorAll<HTMLElement>('button,input,select,a[href],[tabindex]')].filter(e=>!e.closest('.hidden')&&!e.hasAttribute('disabled')&&e.tabIndex>=0),first=buttons[0],last=buttons.at(-1);
  if(!first)return;
  if(event.shiftKey&&(document.activeElement===first||!this.el.modal.contains(document.activeElement))){event.preventDefault();last?.focus();}
  else if(!event.shiftKey&&(document.activeElement===last||!this.el.modal.contains(document.activeElement))){event.preventDefault();first.focus();}
 }
 toast(message:string){this.el.toast.textContent=message;this.el.toast.classList.remove('hidden');setTimeout(()=>this.el.toast.classList.add('hidden'),4000);}
 showDamage(lethal=false){this.damageStarted=performance.now();this.damageLethal=lethal;this.damageUntil=this.damageStarted+(lethal?1100:620);}
 showKill(victimName:string){this.killUntil=performance.now()+3000;this.el['kill-message'].innerHTML=`You killed ${playerNameHTML(victimName)}`;this.el['kill-message'].style.opacity='1';this.el['kill-message'].classList.remove('hidden');}
 showMenu(){this.spectating=this.spectatorSelection=false;this.inGame=false;this.selectionOpen=false;this.setOnline(false);this.el.menu.classList.remove('hidden');for(const id of ['hud','pause','scoreboard'])this.el[id].classList.add('hidden');this.feed=[];this.killUntil=0;this.setMenuStage('main');}
 begin(){this.inGame=true;this.closeSelection();this.closeModal();this.damageStarted=-Infinity;this.damageUntil=0;this.feed=[];this.killUntil=0;this.scoreHeld=false;this.el['kill-message'].classList.add('hidden');this.el.menu.classList.add('hidden');this.el.pause.classList.add('hidden');this.el.scoreboard.classList.add('hidden');this.el.hud.classList.remove('hidden');}
 update(game:Game){
  if(!game.player)return;const replayActor=game.state==='killcam'?game.replayFrame()?.actors[game.killer]:null;const p=replayActor?{...game.actors[game.killer],...replayActor}:game.viewedActor??game.player,now=performance.now();
  const spectating=game.player.spectator,followed=spectating?game.spectator.target(game.actors):null;
  this.el.hud.classList.toggle('spectator-free',spectating&&!followed);this.el['spectator-status'].classList.toggle('hidden',!spectating);
  this.el['spectator-help'].classList.toggle('hidden',!spectating);this.el['spectator-help'].textContent=followed?'LMB / RMB · Player    Esc · Free fly':'WASD · Fly    Space / Ctrl · Up / down    Shift · Fast    LMB / RMB · Follow';
  this.el['spectator-status'].innerHTML=spectating?`Spectating: ${followed?playerNameHTML(followed.name):'Free fly'}`:'';
  this.el['open-team'].textContent=spectating?'Join game':'Select team';this.el['open-weapon'].classList.toggle('hidden',spectating);
  this.spectating=spectating;
  this.el.pause.classList.toggle('hidden',game.state!=='paused'||this.scoreHeld||this.modalOpen||this.selectionOpen);this.el.scoreboard.classList.toggle('hidden',this.selectionOpen||!(this.scoreHeld||game.state==='ended'));
  this.el.killcam.classList.toggle('hidden',game.state!=='killcam');this.el.hud.classList.toggle('killcam-active',game.state==='killcam');this.el['killer-name'].innerHTML=playerNameHTML(game.actors[game.killer]?.name??DEFAULT_PLAYER_NAME);
  this.el.crosshair.classList.toggle('hidden',spectating||p.ads||!game.player.grounded||game.state!=='playing'||p.reload>0||game.isSwitching(game.player)||p.selectedWeapon==='grenade');
  // Follow the physical spread state, with presentation-only reticle scaling.
  this.el.crosshair.style.setProperty('--spread',`${crosshairDisplayGapPixels(game.playerHipSpread,window.innerHeight)}px`);
  this.el['damage-flash'].style.opacity=String(spectating?0:damageFlashOpacity(now-this.damageStarted,this.damageLethal));
  this.el['hit-confirm'].classList.toggle('hidden',spectating||now>this.hitUntil);
  this.el['kill-message'].classList.toggle('hidden',spectating||now>=this.killUntil||game.state!=='playing');this.el['kill-message'].style.opacity=String(Math.min(1,Math.max(0,(this.killUntil-now)/600)));
  this.el['spawn-protection'].classList.toggle('hidden',spectating||p.spawnSafe<=0||game.state!=='playing');
  this.el['compass-rose'].style.transform=`rotate(${(spectating&&!followed?game.spectator.yaw:p.yaw)*180/Math.PI}deg)`;
  this.el['status-message'].textContent=spectating?'':p.selectedWeapon==='grenade'||p.reload>0?'':p.ammo===0&&p.reserve===0?'Out of ammunition':p.cooldown>.3?'':p.ammo<=2?'R · Reload':'';
  if(now-this.lastHud<100)return;this.lastHud=now;this.updateChat(now);
  const clock=`${Math.floor(game.remaining/60).toString().padStart(2,'0')}:${Math.floor(game.remaining%60).toString().padStart(2,'0')}`;
  this.el['match-clock'].textContent=clock;this.el['score-time'].textContent=clock;this.el.ammo.textContent=String(p.ammo);this.el.reserve.textContent=p.selectedWeapon==='grenade'?'':String(p.reserve);this.el.ammo.parentElement?.classList.toggle('hidden',p.selectedWeapon==='grenade');this.el.health.textContent=String(p.hp);this.el['health-fill'].style.width=p.hp+'%';this.el['health-fill'].style.background=p.hp<35?'#b34c3c':'#93a872';
  this.el['round-icons'].classList.toggle('hidden',p.selectedWeapon==='grenade');this.el['round-icons'].innerHTML=Array.from({length:WEAPONS[p.faction].capacity},(_,i)=>`<i class="${i<p.ammo?'loaded':''}"></i>`).join('');
  this.el['weapon-slot'].innerHTML=`<span>${p.selectedWeapon==='grenade'?'2':'1'}</span>${weaponIcon(p.faction,p.selectedWeapon)}<span>${p.selectedWeapon==='grenade'?'Stielhandgranate':WEAPONS[p.faction].name}</span>`;
  this.feed=this.feed.filter(f=>now-f.time<6500);this.el.killfeed.innerHTML=this.feed.map(f=>`<div>${f.text}</div>`).join('');
  if(this.scoreHeld||game.state==='ended'){
   this.el['score-rows'].innerHTML=scoreboardRows(game.actors,this.online);
   const ended=game.state==='ended';this.el['score-close'].classList.toggle('hidden',ended);this.el['end-actions'].classList.toggle('hidden',!ended);this.el.again.classList.toggle('hidden',this.online);this.el['score-title'].textContent=ended?(game.winner?.id===0?'Victory':'Round complete'):'Scoreboard';this.el['score-winner'].classList.toggle('hidden',!ended);this.el['score-winner'].innerHTML=ended&&game.winner?`${playerNameHTML(game.winner.name)} wins`:'';
  }
 }
}
