import test from 'node:test';
import assert from 'node:assert/strict';
import fields from '../shared/actor-fields.json';
import {decodeSnapshot} from '../src/networkCodec.ts';

test('full actor tuples preserve floating point values, Unicode names, nullable fields and nested pose',()=>{
 const actor=Object.fromEntries(fields.map((name,index)=>[name,index+.123456789012345]));
 Object.assign(actor,{name:'^2Åлексей',ping:null,bot:false,pose:{phase:.987654321098765,crouch:0,prone:0,aim:1,speed:3.14159265358979,forward:1,sideways:0},inputTiming:{received:7,late:1,missing:2,arrivalLead:-2}});
 const full={type:'snapshot',inputTiming:'tick-v2',tick:123,time:2.05,actors:[actor],events:[]};
 const encoded={...full,actorEncoding:'tuple-v1',actors:[fields.map(field=>actor[field])]};
 const wire=JSON.parse(JSON.stringify(encoded));
 assert.deepEqual(decodeSnapshot(wire),full);
 assert.deepEqual(wire,encoded,'decoder does not mutate queued wire state');
});
test('each snapshot is independently decodable and joined object state passes through',()=>{
 const first={type:'snapshot',actorEncoding:'tuple-v1',tick:10,actors:[fields.map((_,index)=>index)]};
 const latest={...first,tick:1000,actors:[fields.map((_,index)=>index+1)]};
 assert.deepEqual((decodeSnapshot(latest) as any).actors[0],Object.fromEntries(fields.map((field,index)=>[field,index+1])));
 const joined={type:'snapshot',actors:[{id:1}]}; assert.equal(decodeSnapshot(joined),joined);
});
test('unknown schemas, oversized actors and malformed tuples fail closed',()=>{
 const valid={actorEncoding:'tuple-v1',actors:[fields.map(()=>0)]};
 for(const bad of [null,[],{...valid,actorEncoding:'tuple-v0'},{...valid,actors:[]},{...valid,actors:Array(7).fill(valid.actors[0])},{...valid,actors:[[]]},{...valid,actors:[{}]},{...valid,actors:[[...valid.actors[0],99]]}])assert.equal(decodeSnapshot(bad),null);
 assert.equal(new Set(fields).size,fields.length,'schema keys are unique');
});
