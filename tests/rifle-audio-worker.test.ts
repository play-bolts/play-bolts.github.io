import test from 'node:test';
import assert from 'node:assert/strict';
import {synthesizeRifle,synthesizeCombat,type CombatSound} from '../src/audioSynthesis.ts';
import type {Faction} from '../src/config.ts';

test('off-thread warmup transfers all 18 rifle, swing, and impact variants without changing samples',async()=>{
 const previous=Object.getOwnPropertyDescriptor(globalThis,'self');
 const messages:{faction?:Faction;kind?:CombatSound;variant?:number;samples?:Float32Array;done?:boolean}[]=[];
 const worker={onmessage:null as ((event:{data:number})=>void)|null,postMessage(message:typeof messages[number],options?:{transfer:ArrayBuffer[]}){
  messages.push(message);if(message.samples)assert.equal(options?.transfer[0],message.samples.buffer);
 }};
 Object.defineProperty(globalThis,'self',{configurable:true,value:worker});
 try{
  await import('../src/rifleAudio.worker.ts');worker.onmessage!({data:44100});
  assert.equal(messages.length,19);assert.deepEqual(messages.at(-1),{done:true});assert.equal(new Set(messages.slice(0,18).map(m=>`${m.faction??m.kind}:${m.variant}`)).size,18);
  for(const message of messages.slice(0,9))assert.deepEqual(message.samples,synthesizeRifle(message.faction!,44100,0x51f15e+message.variant!*7919));
  for(const message of messages.slice(9,18))assert.deepEqual(message.samples,synthesizeCombat(message.kind!,44100,0x71a9+message.variant!*3571));
 }finally{if(previous)Object.defineProperty(globalThis,'self',previous);else delete(globalThis as any).self;}
});
