import assert from 'node:assert/strict';
import test from 'node:test';
import {playCombatSound,playImpactSound} from '../src/combatAudio';
import type {Shot} from '../src/engine';
import type {SoundEmitter} from '../src/audio';

const actors=[{faction:'british' as const},{faction:'german' as const}];
const shot:Shot={time:1,actor:0,origin:{x:0,y:1.5,z:0},end:{x:0,y:1.5,z:12},hit:1,headshot:false,kind:'shot'};
function fixture(){
 const events:{type:string;emitter:SoundEmitter}[]=[];
 const sound={shot:(emitter:SoundEmitter)=>events.push({type:'shot',emitter}),melee:(emitter:SoundEmitter)=>events.push({type:'swing',emitter}),impact:(emitter:SoundEmitter,kind:'shot'|'melee'='shot')=>events.push({type:`${kind}-impact`,emitter})};
 return {sound,events};
}
test('local rifle report is centered but its distant contact is placed at the victim',()=>{
 const {sound,events}=fixture();playCombatSound(sound,shot,actors,0);
 assert.deepEqual(events.map(e=>e.type),['shot','shot-impact']);
 assert.equal(events[0].emitter.local,true);assert.deepEqual(events[0].emitter.position,shot.origin);
 assert.deepEqual(events[1].emitter,{actor:1,position:shot.end,local:false,faction:'german'});
});
test('melee has one swing and one confirmed contact; misses have only the swing',()=>{
 const {sound,events}=fixture();playCombatSound(sound,{...shot,kind:'melee'},actors,1);
 assert.deepEqual(events.map(e=>e.type),['swing','melee-impact']);assert.equal(events[1].emitter.local,true);
 events.length=0;playCombatSound(sound,{...shot,kind:'melee',hit:null},actors,0);
 assert.deepEqual(events.map(e=>e.type),['swing']);
});
test('confirmed predicted hits add contact without repeating gunfire and ignore absent victims',()=>{
 const {sound,events}=fixture();playImpactSound(sound,shot,actors,0);
 assert.deepEqual(events.map(e=>e.type),['shot-impact']);
 for(const hit of [null,-1,2])playImpactSound(sound,{...shot,hit},actors,0);
 assert.equal(events.length,1);
});
