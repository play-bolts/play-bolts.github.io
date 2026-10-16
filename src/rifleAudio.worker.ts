import {FACTIONS} from './config';
import {synthesizeRifle,synthesizeCombat,COMBAT_SOUNDS} from './audioSynthesis';

// All layers are baked off-thread into mono buffers, so playback needs only one
// spatial voice. Transferring buffers avoids another large PCM allocation.
self.onmessage=(event:MessageEvent<number>)=>{
 const sampleRate=event.data;
 for(const faction of FACTIONS)for(let variant=0;variant<3;variant++){
  const samples=synthesizeRifle(faction,sampleRate,0x51f15e+variant*7919);
  self.postMessage({faction,variant,samples},{transfer:[samples.buffer]});
 }
 for(const kind of COMBAT_SOUNDS)for(let variant=0;variant<3;variant++){
  const samples=synthesizeCombat(kind,sampleRate,0x71a9+variant*3571);
  self.postMessage({kind,variant,samples},{transfer:[samples.buffer]});
 }
 self.postMessage({done:true});
};
