/** Emit original synthesized WAVs for offline spectral review; no reference media is required. */
import {writeFileSync,mkdirSync} from 'node:fs';
import {synthesizeRifle} from '../src/audioSynthesis.ts';
import {FACTIONS} from '../src/config.ts';
const directory=process.argv[2]??'artifacts/audio-reference';mkdirSync(directory,{recursive:true});
for(const faction of FACTIONS)for(let variant=0;variant<3;variant++){
 const rate=48000,samples=synthesizeRifle(faction,rate,0x51f15e+variant*7919),bytes=Buffer.alloc(44+samples.length*2);
 bytes.write('RIFF');bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);bytes.writeUInt32LE(rate,24);bytes.writeUInt32LE(rate*2,28);bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(samples.length*2,40);
 samples.forEach((sample,i)=>bytes.writeInt16LE(Math.round(Math.max(-1,Math.min(1,sample))*32767),44+i*2));
 writeFileSync(`${directory}/${faction}-synth${variant?`-v${variant}`:''}.wav`,bytes);
}
