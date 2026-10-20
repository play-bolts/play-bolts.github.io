import './style.css';
import './soundReview.css';
import {SoundReviewPanel,soundReviewMarkup} from './soundReview';
import {readSoundReviewPreferences,saveSoundReviewPreference,SOUND_REVIEW_PREFERENCES_KEY,type SoundReviewPreferences} from './soundReviewPreferences';

// Storage may be unavailable in a private or embedded browser; previews still work.
const storage={getItem:(key:string)=>localStorage.getItem(key),setItem:(key:string,value:string)=>localStorage.setItem(key,value)};
let preferences=readSoundReviewPreferences(storage);
const fileReview=location.protocol==='file:';
const page=document.querySelector<HTMLElement>('#sound-review-page')!;
page.innerHTML=`<header class="review-page-header"><h1>BOLTS</h1><a id="review-return" href="${fileReview?'http://127.0.0.1:5173/':'./'}">Return to game</a></header>
 <main class="review-page-card">
  <div class="review-page-settings"><label class="setting" for="review-volume">Volume <output id="review-volume-value" for="review-volume">60%</output><input id="review-volume" type="range" min="0" max="100" step="1" value="60" aria-describedby="review-preferences-status"></label><p id="review-preferences-status" role="status">${fileReview?'Settings apply to this review file and are separate from the game.':'Volume is shared with the game on this browser.'}</p></div>
  ${soundReviewMarkup()}
 </main>`;
const panelRoot=page.querySelector<HTMLElement>('#tab-sounds')!;panelRoot.classList.remove('hidden');
const status=page.querySelector<HTMLElement>('#review-preferences-status')!;
function save(key:keyof SoundReviewPreferences,value:number){
 preferences[key]=value;
 status.textContent=saveSoundReviewPreference(storage,key,value)?fileReview?'Saved for this review file. Game settings are separate.':'Saved for this browser. The game will use this setting when next opened.':'This change applies here, but browser storage is unavailable.';
}
const panel=new SoundReviewPanel(panelRoot,()=>preferences.volume,()=>preferences.killVoiceChance,value=>save('killVoiceChance',value));
const volume=page.querySelector<HTMLInputElement>('#review-volume')!,volumeValue=page.querySelector<HTMLOutputElement>('#review-volume-value')!;
function refresh(){const percent=Math.round(preferences.volume*100);volume.value=String(percent);volume.setAttribute('aria-valuetext',`${percent} percent`);volumeValue.textContent=`${percent}%`;panel.refresh();}
volume.oninput=()=>{const value=Number(volume.value);if(Number.isFinite(value)){save('volume',Math.max(0,Math.min(1,value/100)));refresh();}};
page.querySelector<HTMLAnchorElement>('#review-return')!.onclick=()=>panel.stop();
document.addEventListener('keydown',event=>{if(event.code==='Escape'){event.preventDefault();panel.stop();}});
window.addEventListener('storage',event=>{if(event.key===SOUND_REVIEW_PREFERENCES_KEY||event.key===null){preferences=readSoundReviewPreferences(storage);refresh();}});
refresh();
