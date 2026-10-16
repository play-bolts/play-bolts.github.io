import {FACTIONS} from './config';
import {synthesizeRifle} from './audioSynthesis';

// Keep the original recipes, sample rate, and seeds. Only the execution thread
// changes; transferred sample buffers do not require a second large allocation.
self.onmessage=(event:MessageEvent<number>)=>{
 const sampleRate=event.data;
 for(const faction of FACTIONS)for(let variant=0;variant<3;variant++){
  const samples=synthesizeRifle(faction,sampleRate,0x51f15e+variant*7919);
  self.postMessage({faction,variant,samples},{transfer:[samples.buffer]});
 }
 self.postMessage({done:true});
};
