import {normalizeKillVoiceChance} from './killVoices';

export const SOUND_REVIEW_PREFERENCES_KEY='bolts-preferences';
type PreferenceStorage=Pick<Storage,'getItem'|'setItem'>;
export interface SoundReviewPreferences {volume:number;killVoiceChance:number}
function storedPreferences(storage:PreferenceStorage):Record<string,unknown> {
 try{const saved:unknown=JSON.parse(storage.getItem(SOUND_REVIEW_PREFERENCES_KEY)??'{}');return saved&&typeof saved==='object'&&!Array.isArray(saved)?saved as Record<string,unknown>:{};}catch{return{};}
}
export function readSoundReviewPreferences(storage:PreferenceStorage):SoundReviewPreferences {
 const saved=storedPreferences(storage);
 return{volume:typeof saved.volume==='number'&&Number.isFinite(saved.volume)?Math.max(0,Math.min(1,saved.volume)):.6,killVoiceChance:normalizeKillVoiceChance(saved.killVoiceChance)};
}
/** Merge the latest saved record so reviewing audio cannot erase game settings. */
export function saveSoundReviewPreference(storage:PreferenceStorage,key:keyof SoundReviewPreferences,value:number):boolean {
 const next=key==='killVoiceChance'?normalizeKillVoiceChance(value):Number.isFinite(value)?Math.max(0,Math.min(1,value)):.6;
 try{storage.setItem(SOUND_REVIEW_PREFERENCES_KEY,JSON.stringify({...storedPreferences(storage),[key]:next}));return true;}catch{return false;}
}
