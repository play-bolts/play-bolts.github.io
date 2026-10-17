/** Run with: node --import tsx scripts/performance-audio-synthesis.ts
 * CPU-only fallback synthesis probe; not a browser or audio-thread benchmark.
 */
import {writeFileSync, mkdirSync} from 'node:fs';
import {synthesizeRifle,synthesizeCombat,COMBAT_SOUNDS} from '../src/audioSynthesis';
import type {Faction} from '../src/config';

const rows=[];
for(const rate of [24000,48000]){
 for(const kind of ['british','russian','german',...COMBAT_SOUNDS] as const){
  const synth=()=>['british','russian','german'].includes(kind)
   ?synthesizeRifle(kind as Faction,rate)
   :synthesizeCombat(kind as typeof COMBAT_SOUNDS[number],rate);
  const start=performance.now(),data=synth(),firstMs=performance.now()-start;
  for(let i=0;i<3;i++)synth();
  const times=[];
  for(let i=0;i<12;i++){const before=performance.now();synth();times.push(performance.now()-before);}
  times.sort((a,b)=>a-b);
  rows.push({kind,rate,bytes:data.byteLength,firstMs,medianMs:times[6],p95Ms:times[11]});
 }
}
const report={environment:process.version,method:'Node CPU microbenchmark; one initial call per configuration, three warmup calls, twelve measured calls. Initial calls after the first may share already JIT-compiled code. Not browser/audio-thread profiling or device emulation.',rows};
mkdirSync('temp/performance-audit',{recursive:true});
writeFileSync('temp/performance-audit/audio-synthesis-microbench.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
