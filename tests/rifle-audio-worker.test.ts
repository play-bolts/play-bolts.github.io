import test from 'node:test';
import assert from 'node:assert/strict';
import {synthesizeRifle,synthesizeCombat,type CombatSound} from '../src/audioSynthesis.ts';
import type {Faction} from '../src/config.ts';
import {synthesizeFootstep,FOOTSTEP_STANCES,FOOTSTEP_SIDES,FOOTSTEP_VARIANTS,type FootSide} from '../src/movementAudio.ts';
import type {Stance} from '../src/config.ts';

test('off-thread warmup transfers all rifle, combat and movement variants without changing samples',async()=>{
 const previous=Object.getOwnPropertyDescriptor(globalThis,'self');
 const messages:{faction?:Faction;kind?:CombatSound;stance?:Stance;side?:FootSide;variant?:number;samples?:Float32Array;done?:boolean}[]=[];
 const worker={onmessage:null as ((event:{data:number})=>void)|null,postMessage(message:typeof messages[number],options?:{transfer:ArrayBuffer[]}){
  messages.push(message);if(message.samples)assert.equal(options?.transfer[0],message.samples.buffer);
 }};
 Object.defineProperty(globalThis,'self',{configurable:true,value:worker});
 try{
  await import('../src/rifleAudio.worker.ts');worker.onmessage!({data:44100});
  const movementCount=FOOTSTEP_STANCES.length*FOOTSTEP_SIDES.length*FOOTSTEP_VARIANTS;
  assert.equal(messages.length,19+movementCount);assert.deepEqual(messages.at(-1),{done:true});assert.equal(new Set(messages.slice(0,18).map(m=>`${m.faction??m.kind}:${m.variant}`)).size,18);
  for(const message of messages.slice(0,9))assert.deepEqual(message.samples,synthesizeRifle(message.faction!,44100,0x51f15e+message.variant!*7919));
  for(const message of messages.slice(9,18))assert.deepEqual(message.samples,synthesizeCombat(message.kind!,44100,0x71a9+message.variant!*3571));
  const footsteps=messages.slice(18,-1);assert.equal(new Set(footsteps.map(m=>`${m.stance}:${m.side}:${m.variant}`)).size,movementCount);
  for(const message of footsteps)assert.deepEqual(message.samples,synthesizeFootstep(message.stance!,44100,message.variant!,message.side!));
 }finally{if(previous)Object.defineProperty(globalThis,'self',previous);else delete(globalThis as any).self;}
});
