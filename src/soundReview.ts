import {FACTIONS,WEAPONS,type Faction,type Stance} from './config';
import {synthesizeRiflePreview,synthesizeCombat,type CombatSound} from './audioSynthesis';
import {synthesizeFootstep,FOOTSTEP_VARIANTS,FOOTSTEP_STANCES,FOOTSTEP_SIDES,MOVEMENT_PREVIEW_SPEED,footstepLevel,renderMovementPreview} from './movementAudio';
import {KILL_VOICE_LINES,KILL_VOICES_ENABLED,normalizeKillVoiceChance} from './killVoices';
import {SoundPreviewPlayer,previewBuffer,loadPreviewFile,type PreviewLoad,type PreviewState} from './soundPreview';
import {AUDIO_CANDIDATES,audioCandidatesFor,type AudioCandidate,type AudioCandidateGroup} from './audioCandidates';

const factionNames:Record<Faction,string>={british:'British',russian:'Russian',german:'German'};
const factionLanguages:Record<Faction,string>={british:'en',russian:'ru',german:'de'};
const stanceNames:Record<Stance,string>={stand:'Walking',crouch:'Crouching',prone:'Prone'};
const combatNames:Record<CombatSound,string>={swing:'Melee swing','shot-impact':'Bullet impact','melee-impact':'Melee impact'};
const escape=(value:string)=>value.replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]!));
const previewButton=(id:string,text:string,label:string)=>`<button type="button" data-sound-preview="${escape(id)}" aria-label="${escape(label)}" aria-pressed="false">${escape(text)}</button>`;
function candidateFamily(candidate:AudioCandidate):string {
 if(candidate.group==='rifle')return WEAPONS[candidate.sound as Faction]?.name??candidate.sound;
 if(candidate.group==='movement')return stanceNames[candidate.sound as Stance]??candidate.sound;
 if(candidate.group==='combat')return combatNames[candidate.sound as CombatSound]??candidate.sound;
 const line=KILL_VOICE_LINES.find(line=>line.id===candidate.sound);
 return line?`${factionNames[line.faction]} · ${line.text}`:candidate.sound;
}
async function loadCandidate(context:AudioContext,candidate:AudioCandidate,signal:AbortSignal):Promise<AudioBuffer> {
 const buffer=await loadPreviewFile(context,candidate.file,signal);
 if(signal.aborted)throw new Error('Preview cancelled');
 const stance=FOOTSTEP_STANCES.find(stance=>stance===candidate.sound);
 if(candidate.group==='movement'&&stance){
  // Candidate files match the unscaled source; apply the same stance gain as
  // current steps to this decoded preview only. Downloaded WAVs stay unchanged.
  const gain=footstepLevel(stance,MOVEMENT_PREVIEW_SPEED[stance]);
  for(let channel=0;channel<buffer.numberOfChannels;channel++){
   const samples=buffer.getChannelData(channel);for(let index=0;index<samples.length;index++)samples[index]*=gain;
  }
 }
 return buffer;
}
function candidateMarkup(group:AudioCandidateGroup,sound:string,family:string):string {
 const candidates=audioCandidatesFor(group,sound);if(!candidates.length)return'';
 return `<div class="sound-candidate-grid" role="group" aria-label="${escape(family)} AI candidates">${candidates.map(candidate=>`<article class="sound-candidate"><h5>${escape(candidate.label)}</h5><span class="sound-candidate-kind">${candidate.sourceInfluence===undefined?'AI-generated':'Source-based AI'} · ${escape(candidate.provider)}</span><p>${escape(candidate.description)}</p><span class="sound-candidate-details">${escape(candidate.model)} · ${candidate.duration.toFixed(1)} s</span>${candidate.reviewNote?`<p class="sound-candidate-review-note">${escape(candidate.reviewNote)}</p>`:''}<div class="sound-preview-buttons">${previewButton(`candidate:${candidate.id}`,'Play',`Play ${family}: ${candidate.label}`)}<a href="${escape(candidate.file)}" download aria-label="Download ${escape(family)}: ${escape(candidate.label)}">Download</a></div></article>`).join('')}</div>`;
}

export function soundReviewMarkup():string {
 return `<section id="tab-sounds" class="hidden" aria-labelledby="sound-review-title">
  <h2 id="sound-review-title">Sound review</h2><p class="sound-review-intro">Compare the current sounds with AI-generated alternatives. Candidates are for review only and do not replace sounds in the game. Previews use your Volume setting.</p>
  <nav class="sound-review-nav" aria-label="Sound categories"><a href="#sound-rifles-title">Rifles</a><a href="#sound-movement-title">Movement</a><a href="#sound-combat-title">Combat</a><a href="#sound-voices-title">Voices</a></nav>
  <div class="sound-preview-toolbar"><span id="sound-preview-status" role="status" aria-live="polite">Choose a sample to listen.</span><button id="sound-preview-stop" type="button" disabled>Stop</button></div>
  <section class="sound-review-section" aria-labelledby="sound-rifles-title"><h3 id="sound-rifles-title">Rifles</h3><p>The fuller candidate uses DSP for fuller EQ and saturation of the same report. It is for review only.</p>
   <div class="sound-rifle-list">${FACTIONS.map(faction=>`<section class="sound-family"><div class="sound-rifle-row"><h4>${escape(WEAPONS[faction].name)}</h4><div class="sound-preview-buttons">${previewButton(`rifle:${faction}:current`,'Current',`Play current ${WEAPONS[faction].name}`)}${previewButton(`rifle:${faction}:fuller`,'Fuller DSP candidate',`Play fuller DSP candidate ${WEAPONS[faction].name}`)}</div></div>${candidateMarkup('rifle',faction,WEAPONS[faction].name)}</section>`).join('')}</div>
  </section>
  <section class="sound-review-section" aria-labelledby="sound-movement-title"><h3 id="sound-movement-title">Movement</h3><p>Original procedural boot and cloth sounds. Play an eight-step sequence or an individual left (L) or right (R) variation. Current steps and AI candidates use the same stance volume for comparison.</p>
   <div class="sound-movement-grid">${FOOTSTEP_STANCES.map(stance=>`<section class="sound-movement-card" aria-labelledby="sound-movement-${stance}"><h4 id="sound-movement-${stance}">${stanceNames[stance]}</h4>${previewButton(`movement:${stance}:sequence`,'Play sequence',`Play ${stanceNames[stance].toLowerCase()} sequence`)}<div class="sound-variant-grid">${Array.from({length:FOOTSTEP_VARIANTS},(_,variant)=>FOOTSTEP_SIDES.map(side=>previewButton(`movement:${stance}:${variant}:${side}`,`${side==='left'?'L':'R'}${variant+1}`,`Play ${stanceNames[stance].toLowerCase()}, ${side}, variation ${variant+1}`)).join('')).join('')}</div></section>`).join('')}</div>
   ${FOOTSTEP_STANCES.filter(stance=>audioCandidatesFor('movement',stance).length).map(stance=>`<section class="sound-family"><h4>${stanceNames[stance]} candidates</h4>${candidateMarkup('movement',stance,stanceNames[stance])}</section>`).join('')}
  </section>
  <section class="sound-review-section" aria-labelledby="sound-combat-title"><h3 id="sound-combat-title">Combat</h3><p>Compare the current procedural swings and impacts with the available AI candidates.</p>
   ${Object.entries(combatNames).map(([kind,name])=>`<section class="sound-family"><div class="sound-rifle-row"><h4>${name}</h4>${previewButton(`combat:${kind}`,'Current',`Play current ${name.toLowerCase()}`)}</div>${candidateMarkup('combat',kind,name)}</section>`).join('')}
  </section>
  <section class="sound-review-section" aria-labelledby="sound-voices-title"><h3 id="sound-voices-title">Kill voice lines</h3><p>These character voices are AI-generated. Each line is shown in its original language with an English translation.</p>
   <label class="setting sound-voice-chance" for="kill-voice-chance">Chance after a kill <output id="kill-voice-chance-value" for="kill-voice-chance">${KILL_VOICES_ENABLED?'10%':'Disabled'}</output><input id="kill-voice-chance" type="range" min="0" max="100" step="1" value="${KILL_VOICES_ENABLED?10:0}" ${KILL_VOICES_ENABLED?'':'disabled'} aria-describedby="kill-voice-chance-help"></label><p id="kill-voice-chance-help" class="sound-review-hint">${KILL_VOICES_ENABLED?'Voice lines never overlap and have a short pause between them. Set to 0% to turn them off. This setting does not affect previews.':'Spoken kill lines are temporarily disabled in gameplay. Your saved chance is retained. Manual previews still work.'}</p>
   <div class="sound-voice-list">${KILL_VOICE_LINES.map(line=>`<article class="sound-voice-row"><div><span class="sound-voice-language">${factionNames[line.faction]} · ${escape(line.language)}</span><h4 class="sound-voice-original" lang="${factionLanguages[line.faction]}">${escape(line.text)}</h4><p class="sound-voice-translation" lang="en">${escape(line.translation)}</p></div>${previewButton(`voice:${line.id}`,'Current',`Play current ${factionNames[line.faction]} voice line: ${line.text}`)}${candidateMarkup('voice',line.id,`${factionNames[line.faction]} voice line: ${line.text}`)}</article>`).join('')}</div>
  </section>
 </section>`;
}

export class SoundReviewPanel {
 private player:SoundPreviewPlayer;
 private previews=new Map<string,{label:string;load:PreviewLoad}>();
 constructor(private root:HTMLElement,volume:()=>number,private chance:()=>number,changeChance:(value:number)=>void){
  this.player=new SoundPreviewPlayer(volume,state=>this.renderState(state));
  for(const faction of FACTIONS)for(const profile of ['current','fuller'] as const){
   this.previews.set(`rifle:${faction}:${profile}`,{label:`${WEAPONS[faction].name} · ${profile==='current'?'Current':'Fuller candidate'}`,load:context=>previewBuffer(context,synthesizeRiflePreview(faction,context.sampleRate,profile))});
  }
  for(const [kind,name] of Object.entries(combatNames))this.previews.set(`combat:${kind}`,{label:name,load:context=>previewBuffer(context,synthesizeCombat(kind as CombatSound,context.sampleRate,0x71a9))});
  for(const stance of FOOTSTEP_STANCES){
   this.previews.set(`movement:${stance}:sequence`,{label:`${stanceNames[stance]} sequence`,load:context=>previewBuffer(context,renderMovementPreview(stance,context.sampleRate))});
   for(let variant=0;variant<FOOTSTEP_VARIANTS;variant++)for(const side of FOOTSTEP_SIDES){
    this.previews.set(`movement:${stance}:${variant}:${side}`,{label:`${stanceNames[stance]} · ${side} ${variant+1}`,load:context=>previewBuffer(context,synthesizeFootstep(stance,context.sampleRate,variant,side),footstepLevel(stance,MOVEMENT_PREVIEW_SPEED[stance]))});
   }
  }
  for(const line of KILL_VOICE_LINES)this.previews.set(`voice:${line.id}`,{label:`${factionNames[line.faction]} · ${line.text}`,load:(context,signal)=>loadPreviewFile(context,line.file,signal)});
  for(const candidate of AUDIO_CANDIDATES)this.previews.set(`candidate:${candidate.id}`,{label:`${candidateFamily(candidate)} · ${candidate.label}`,load:(context,signal)=>loadCandidate(context,candidate,signal)});
  for(const button of root.querySelectorAll<HTMLButtonElement>('[data-sound-preview]'))button.onclick=()=>{const id=button.dataset.soundPreview!,preview=this.previews.get(id);if(preview)void this.player.play(id,preview.label,preview.load);};
  root.querySelector<HTMLButtonElement>('#sound-preview-stop')!.onclick=()=>this.stop();
  root.querySelector<HTMLInputElement>('#kill-voice-chance')!.oninput=event=>{if(!KILL_VOICES_ENABLED)return;const value=Number((event.currentTarget as HTMLInputElement).value);if(Number.isFinite(value)){changeChance(normalizeKillVoiceChance(value/100));this.refresh();}};
  document.addEventListener('visibilitychange',()=>{if(document.hidden)this.stop();});
  window.addEventListener('pagehide',()=>this.stop());this.refresh();
 }
 stop(){this.player.stop();}
 refresh(){
  const percent=KILL_VOICES_ENABLED?Math.round(normalizeKillVoiceChance(this.chance())*100):0,input=this.root.querySelector<HTMLInputElement>('#kill-voice-chance')!;
  input.value=String(percent);input.disabled=!KILL_VOICES_ENABLED;input.setAttribute('aria-valuetext',KILL_VOICES_ENABLED?`${percent} percent`:'Disabled');this.root.querySelector<HTMLOutputElement>('#kill-voice-chance-value')!.textContent=KILL_VOICES_ENABLED?`${percent}%`:'Disabled';this.player.refreshVolume();
 }
 private renderState(state:PreviewState){
  for(const button of this.root.querySelectorAll<HTMLButtonElement>('[data-sound-preview]'))button.setAttribute('aria-pressed',String((state.phase==='loading'||state.phase==='playing')&&button.dataset.soundPreview===state.id));
  this.root.querySelector<HTMLButtonElement>('#sound-preview-stop')!.disabled=state.phase!=='loading'&&state.phase!=='playing';
  this.root.querySelector<HTMLElement>('#sound-preview-status')!.textContent=state.phase==='loading'?`Loading ${state.label}…`:state.phase==='playing'?`Playing ${state.label}`:state.phase==='error'?'Unable to play this sample. Try again.':'Choose a sample to listen.';
 }
}
