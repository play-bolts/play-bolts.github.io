import test from 'node:test';
import assert from 'node:assert/strict';
import {readSoundReviewPreferences,saveSoundReviewPreference,SOUND_REVIEW_PREFERENCES_KEY} from '../src/soundReviewPreferences.ts';

function fixture(initial:string|null=null){
 let value=initial;
 const storage={getItem(key:string){assert.equal(key,SOUND_REVIEW_PREFERENCES_KEY);return value;},setItem(key:string,next:string){assert.equal(key,SOUND_REVIEW_PREFERENCES_KEY);value=next;}};
 return{storage,replace:(next:unknown)=>{value=JSON.stringify(next);},saved:()=>JSON.parse(value!)};
}

test('review settings use game defaults and safely recover unavailable or malformed storage',()=>{
 for(const initial of [null,'invalid','null','[]','{"volume":"loud","killVoiceChance":"often"}']){
  assert.deepEqual(readSoundReviewPreferences(fixture(initial).storage),{volume:.6,killVoiceChance:.1});
 }
 const unavailable={getItem(){throw new Error('blocked');},setItem(){throw new Error('blocked');}};
 assert.deepEqual(readSoundReviewPreferences(unavailable),{volume:.6,killVoiceChance:.1});
 assert.equal(saveSoundReviewPreference(unavailable,'volume',.3),false);
});

test('standalone review saves only its changed preference and preserves the latest game settings',()=>{
 const f=fixture('{"playerName":"Chris","volume":0.8,"killVoiceChance":0.1,"quality":"high"}');
 assert.deepEqual(readSoundReviewPreferences(f.storage),{volume:.8,killVoiceChance:.1});
 // Another page can save a game setting after the reviewer has loaded.
 f.replace({playerName:'New name',volume:.4,killVoiceChance:.1,quality:'low',invert:true});
 assert.equal(saveSoundReviewPreference(f.storage,'killVoiceChance',.35),true);
 assert.deepEqual(f.saved(),{playerName:'New name',volume:.4,killVoiceChance:.35,quality:'low',invert:true});
 assert.equal(saveSoundReviewPreference(f.storage,'volume',.2),true);
 assert.equal(f.saved().killVoiceChance,.35);
 assert.equal(f.saved().playerName,'New name');
 assert.equal(f.saved().volume,.2);
});

test('review settings clamp gains and probabilities before use and persistence',()=>{
 const f=fixture('{"volume":2,"killVoiceChance":-4}');
 assert.deepEqual(readSoundReviewPreferences(f.storage),{volume:1,killVoiceChance:0});
 saveSoundReviewPreference(f.storage,'volume',-1);saveSoundReviewPreference(f.storage,'killVoiceChance',3);
 assert.deepEqual(readSoundReviewPreferences(f.storage),{volume:0,killVoiceChance:1});
 saveSoundReviewPreference(f.storage,'volume',Infinity);saveSoundReviewPreference(f.storage,'killVoiceChance',NaN);
 assert.deepEqual(readSoundReviewPreferences(f.storage),{volume:.6,killVoiceChance:.1});
});
