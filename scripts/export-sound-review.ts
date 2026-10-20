/** Export the current shortened original one-shots for source-conditioned AI review. */
import {mkdirSync,writeFileSync,readFileSync,copyFileSync} from 'node:fs';
import {synthesizeRifle,synthesizeCombat,COMBAT_SOUNDS,synthesizeFootstep} from '../src/audioSynthesis.ts';
import {FACTIONS} from '../src/config.ts';
const directory='temp/stability-audio/sources';mkdirSync(directory,{recursive:true});
const rate=48000;
const sources:{group:string;sound:string;file:string;duration:number;text?:string;language?:string}[]=[];
function save(group:string,sound:string,samples:Float32Array){
 const bytes=Buffer.alloc(44+samples.length*2);
 bytes.write('RIFF');bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);bytes.writeUInt32LE(rate,24);bytes.writeUInt32LE(rate*2,28);bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(samples.length*2,40);
 samples.forEach((sample,i)=>bytes.writeInt16LE(Math.round(Math.max(-1,Math.min(1,sample))*32767),44+i*2));
 const file=`${directory}/${group}-${sound}.wav`;writeFileSync(file,bytes);sources.push({group,sound,file,duration:samples.length/rate});
}
for(const faction of FACTIONS)save('rifle',faction,synthesizeRifle(faction,rate));
for(const stance of ['stand','crouch','prone'] as const)save('movement',stance,synthesizeFootstep(stance,rate,0,'left'));
for(const kind of COMBAT_SOUNDS)save('combat',kind,synthesizeCombat(kind,rate));
for(const line of JSON.parse(readFileSync('shared/kill-voices.json','utf8'))){
 const file=`${directory}/voice-${line.id}.wav`;copyFileSync('public'+line.file,file);
 sources.push({group:'voice',sound:line.id,file,duration:0,text:line.text,language:line.language});
}
writeFileSync('temp/stability-audio/sources.json',JSON.stringify(sources,null,2)+'\n');
console.log(`Exported ${sources.length} current source sounds.`);
