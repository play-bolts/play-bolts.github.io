import {FACTIONS,WEAPONS,type Faction,type Stance} from './config';
import {synthesizeRiflePreview} from './audioSynthesis';
import {synthesizeFootstep,FOOTSTEP_VARIANTS,FOOTSTEP_STANCES,FOOTSTEP_SIDES,MOVEMENT_PREVIEW_SPEED,footstepLevel,renderMovementPreview} from './movementAudio';
import {KILL_VOICE_LINES,normalizeKillVoiceChance} from './killVoices';
import {SoundPreviewPlayer,previewBuffer,loadPreviewFile,type PreviewLoad,type PreviewState} from './soundPreview';

const factionNames:Record<Faction,string>={british:'British',russian:'Russian',german:'German'};
const factionLanguages:Record<Faction,string>={british:'en',russian:'ru',german:'de'};
const stanceNames:Record<Stance,string>={stand:'Walking',crouch:'Crouching',prone:'Prone'};
const escape=(value:string)=>value.replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]!));
const previewButton=(id:string,text:string,label:string)=>`<button type="button" data-sound-preview="${escape(id)}" aria-label="${escape(label)}" aria-pressed="false">${escape(text)}</button>`;

export function soundReviewMarkup():string {
 return `<section id="tab-sounds" class="hidden" aria-labelledby="sound-review-title">
  <h2 id="sound-review-title">Sound review</h2><p class="sound-review-intro">Listen to the rifle reports, movement sounds and voice lines. Previews use your Volume setting.</p>
  <div class="sound-preview-toolbar"><span id="sound-preview-status" role="status" aria-live="polite">Choose a sample to listen.</span><button id="sound-preview-stop" type="button" disabled>Stop</button></div>
  <section class="sound-review-section" aria-labelledby="sound-rifles-title"><h3 id="sound-rifles-title">Rifles</h3><p>The fuller candidate uses DSP for fuller EQ and saturation of the same report. It is for review only.</p>
   <div class="sound-rifle-list">${FACTIONS.map(faction=>`<div class="sound-rifle-row"><strong>${escape(WEAPONS[faction].name)}</strong><div class="sound-preview-buttons">${previewButton(`rifle:${faction}:current`,'Current',`Play current ${WEAPONS[faction].name}`)}${previewButton(`rifle:${faction}:fuller`,'Fuller candidate',`Play fuller candidate ${WEAPONS[faction].name}`)}</div></div>`).join('')}</div>
  </section>
  <section class="sound-review-section" aria-labelledby="sound-movement-title"><h3 id="sound-movement-title">Movement</h3><p>Original procedural boot and cloth sounds. Play an eight-step sequence or an individual left (L) or right (R) variation.</p>
   <div class="sound-movement-grid">${FOOTSTEP_STANCES.map(stance=>`<section class="sound-movement-card" aria-labelledby="sound-movement-${stance}"><h4 id="sound-movement-${stance}">${stanceNames[stance]}</h4>${previewButton(`movement:${stance}:sequence`,'Play sequence',`Play ${stanceNames[stance].toLowerCase()} sequence`)}<div class="sound-variant-grid">${Array.from({length:FOOTSTEP_VARIANTS},(_,variant)=>FOOTSTEP_SIDES.map(side=>previewButton(`movement:${stance}:${variant}:${side}`,`${side==='left'?'L':'R'}${variant+1}`,`Play ${stanceNames[stance].toLowerCase()}, ${side}, variation ${variant+1}`)).join('')).join('')}</div></section>`).join('')}</div>
  </section>
  <section class="sound-review-section" aria-labelledby="sound-voices-title"><h3 id="sound-voices-title">Kill voice lines</h3><p>These character voices are AI-generated. Each line is shown in its original language with an English translation.</p>
   <label class="setting sound-voice-chance" for="kill-voice-chance">Chance after a kill <output id="kill-voice-chance-value" for="kill-voice-chance">10%</output><input id="kill-voice-chance" type="range" min="0" max="100" step="1" value="10" aria-describedby="kill-voice-chance-help"></label><p id="kill-voice-chance-help" class="sound-review-hint">Voice lines never overlap and have a short pause between them. Set to 0% to turn them off. This setting does not affect previews.</p>
   <div class="sound-voice-list">${KILL_VOICE_LINES.map(line=>`<article class="sound-voice-row"><div><span class="sound-voice-language">${factionNames[line.faction]} · ${escape(line.language)}</span><p class="sound-voice-original" lang="${factionLanguages[line.faction]}">${escape(line.text)}</p><p class="sound-voice-translation" lang="en">${escape(line.translation)}</p></div>${previewButton(`voice:${line.id}`,'Play',`Play ${factionNames[line.faction]} voice line: ${line.text}`)}</article>`).join('')}</div>
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
  for(const stance of FOOTSTEP_STANCES){
   this.previews.set(`movement:${stance}:sequence`,{label:`${stanceNames[stance]} sequence`,load:context=>previewBuffer(context,renderMovementPreview(stance,context.sampleRate))});
   for(let variant=0;variant<FOOTSTEP_VARIANTS;variant++)for(const side of FOOTSTEP_SIDES){
    this.previews.set(`movement:${stance}:${variant}:${side}`,{label:`${stanceNames[stance]} · ${side} ${variant+1}`,load:context=>previewBuffer(context,synthesizeFootstep(stance,context.sampleRate,variant,side),footstepLevel(stance,MOVEMENT_PREVIEW_SPEED[stance]))});
   }
  }
  for(const line of KILL_VOICE_LINES)this.previews.set(`voice:${line.id}`,{label:`${factionNames[line.faction]} · ${line.text}`,load:(context,signal)=>loadPreviewFile(context,line.file,signal)});
  for(const button of root.querySelectorAll<HTMLButtonElement>('[data-sound-preview]'))button.onclick=()=>{const id=button.dataset.soundPreview!,preview=this.previews.get(id);if(preview)void this.player.play(id,preview.label,preview.load);};
  root.querySelector<HTMLButtonElement>('#sound-preview-stop')!.onclick=()=>this.stop();
  root.querySelector<HTMLInputElement>('#kill-voice-chance')!.oninput=event=>{const value=Number((event.currentTarget as HTMLInputElement).value);if(Number.isFinite(value)){changeChance(normalizeKillVoiceChance(value/100));this.refresh();}};
  document.addEventListener('visibilitychange',()=>{if(document.hidden)this.stop();});
  window.addEventListener('pagehide',()=>this.stop());this.refresh();
 }
 stop(){this.player.stop();}
 refresh(){
  const percent=Math.round(normalizeKillVoiceChance(this.chance())*100),input=this.root.querySelector<HTMLInputElement>('#kill-voice-chance')!;
  input.value=String(percent);input.setAttribute('aria-valuetext',`${percent} percent`);this.root.querySelector<HTMLOutputElement>('#kill-voice-chance-value')!.textContent=`${percent}%`;this.player.refreshVolume();
 }
 private renderState(state:PreviewState){
  for(const button of this.root.querySelectorAll<HTMLButtonElement>('[data-sound-preview]'))button.setAttribute('aria-pressed',String((state.phase==='loading'||state.phase==='playing')&&button.dataset.soundPreview===state.id));
  this.root.querySelector<HTMLButtonElement>('#sound-preview-stop')!.disabled=state.phase!=='loading'&&state.phase!=='playing';
  this.root.querySelector<HTMLElement>('#sound-preview-status')!.textContent=state.phase==='loading'?`Loading ${state.label}…`:state.phase==='playing'?`Playing ${state.label}`:state.phase==='error'?'Unable to play this sample. Try again.':'Choose a sample to listen.';
 }
}
