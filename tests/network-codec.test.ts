import test from 'node:test';
import assert from 'node:assert/strict';
import {encode} from '@msgpack/msgpack';
import fields from '../shared/actor-fields.json';
import schema from '../shared/wire-schema.json';
import fixture from '../shared/fixtures/codec-v3.json';
import {decodeMessage,decodeInput,encodeInput,decodeSnapshot,MAX_INPUT_BYTES,MAX_SNAPSHOT_BYTES,PROTOCOL_VERSION} from '../src/networkCodec.ts';
import type {NetworkInput} from '../src/network.ts';

const snapshot=()=>structuredClone((fixture as any).snapshot);
function tuple(state:any):unknown[]{return [3,1,...schema.snapshotFields.map(field=>field==='actors'?state.actors.map((actor:any)=>fields.map(key=>key==='pose'?(actor.pose?schema.poseFields.map(f=>actor.pose[f]):null):key==='inputTiming'?schema.timingFields.map(f=>actor.inputTiming[f]):actor[key])):state[field])];}
const input:NetworkInput={type:'input',seq:12345,tick:67890,generation:3,forward:.75,right:-.25,jump:true,walk:false,lean:-.416,yaw:1.2345678901234567,pitch:-.1234567890123456,ads:true,stance:'crouch',weapon:'rifle',fire:true,reload:false,melee:false,shotTime:123.45678901234567};

test('protocol schema and every actor key are unique',()=>{
 assert.equal(PROTOCOL_VERSION,3);assert.equal(new Set(fields).size,fields.length);assert.equal(fields.length,50);
 for(const key of ['inputFields','snapshotFields','poseFields','timingFields'] as const)assert.equal(new Set(schema[key]).size,schema[key].length);
});
test('Rust binary fixture decodes to exact named state, Unicode, empty optionals and f64 values',()=>{
 const data=Buffer.from((fixture as any).snapshotHex,'hex');const expected=snapshot();
 assert.deepEqual(decodeMessage(data),expected);
 assert.deepEqual(decodeMessage(data.buffer.slice(data.byteOffset,data.byteOffset+data.byteLength)),expected);
 const padded=Buffer.concat([Buffer.from([99]),data,Buffer.from([99])]);assert.deepEqual(decodeMessage(new DataView(padded.buffer,padded.byteOffset+1,data.byteLength)),expected);
 assert.equal(expected.actors[1].pose,undefined);assert.equal(expected.actors[1].ping,null);assert.equal(expected.winner,null);
});
test('full snapshots need no preceding baseline and named joined state remains supported',()=>{
 const state=snapshot(),latest={...state,tick:900000,time:15000};
 assert.deepEqual(decodeSnapshot(tuple(latest)),latest);
 assert.deepEqual(decodeMessage(encode(tuple(latest))),latest);
 assert.equal(decodeSnapshot(state),state);assert.deepEqual(decodeMessage(JSON.stringify({type:'joined',snapshot:state})),{type:'joined',snapshot:state});
});
test('input encoding is lossless, bounded and substantially smaller than named JSON',()=>{
 const encoded=encodeInput(input);assert.deepEqual(decodeInput(encoded),input);
 assert.ok(encoded.length<Buffer.byteLength(JSON.stringify(input))*.5,`${encoded.length} vs ${Buffer.byteLength(JSON.stringify(input))}`);
 for(const value of [.12345678901234567,Number.MIN_VALUE,Number.MAX_VALUE,-0,-1234567.987654321])assert.ok(Object.is(decodeInput(encodeInput({...input,yaw:value})).yaw,value));
 const max={...input,seq:Number.MAX_SAFE_INTEGER,tick:Number.MAX_SAFE_INTEGER,generation:Number.MAX_SAFE_INTEGER};assert.deepEqual(decodeInput(encodeInput(max)),max);
 for(const sample of (fixture as any).inputs){assert.equal(Buffer.from(encodeInput(sample.input)).toString('hex'),sample.hex);assert.deepEqual(decodeInput(Buffer.from(sample.hex,'hex')),sample.input);}
});
test('malformed snapshots, oversized messages, maps, extensions and trailing bytes fail closed',()=>{
 const valid=tuple(snapshot());
 for(const bad of [null,[],{actorEncoding:'tuple-v1'},[2,...valid.slice(1)],[3,0,...valid.slice(2)],valid.slice(0,-1),[...valid,0],[...valid.slice(0,10),[]],[...valid.slice(0,10),Array(7).fill((valid[10] as any[])[0])],[...valid.slice(0,10),[[]]]])assert.equal(decodeSnapshot(bad),null);
 for(const bad of [new Uint8Array(),new Uint8Array(MAX_SNAPSHOT_BYTES+1),encode({type:'snapshot'}),encode(new Date()),Uint8Array.from([...encode(valid),0]),Uint8Array.from([0xdd,255,255,255,255]),Uint8Array.from([...Array(1000).fill(0x91),0])])assert.throws(()=>decodeMessage(bad));
 const broken=structuredClone(valid);(broken[10] as any[])[0][fields.indexOf('pose')]=[0];assert.throws(()=>decodeMessage(encode(broken)));
 const nested=structuredClone(valid);(nested[10] as any[])[0][fields.indexOf('inputTiming')]=Array(7).fill([0]);assert.throws(()=>decodeMessage(encode(nested)));
});
test('malformed inputs reject bad lengths, booleans, enums, unsafe and nonfinite numbers',()=>{
 for(const override of [{seq:-1},{seq:2**53},{stance:'jump'},{weapon:'pistol'},{yaw:NaN},{pitch:Infinity},{reload:1},{tick:null}])assert.throws(()=>encodeInput({...input,...override} as NetworkInput));
 const encoded=encodeInput(input);for(let size=0;size<encoded.length;size++)assert.throws(()=>decodeInput(encoded.subarray(0,size)));
 for(const bytes of [new Uint8Array(MAX_INPUT_BYTES+1),Uint8Array.from([...encoded,0]),encode([]),encode([3,0,...Array(17).fill(null)]),Uint8Array.from([...Array(200).fill(0x91),0])])assert.throws(()=>decodeInput(bytes));
});


test('managed ARN lobby IDs preserve the admitted 512-byte bound without widening player names',()=>{
 const sample=fixture as any,expected={...snapshot(),lobbyId:sample.managedLobbyId};
 assert.ok(expected.lobbyId.length>128);assert.deepEqual(decodeMessage(Buffer.from(sample.managedSnapshotHex,'hex')),expected);
 const full={...snapshot(),lobbyId:'🙂'.repeat(128)};assert.deepEqual(decodeMessage(encode(tuple(full))),full);
 assert.throws(()=>decodeMessage(encode(tuple({...full,lobbyId:full.lobbyId+'x'}))));
 const state=snapshot();state.actors[0].name='🙂'.repeat(64);assert.deepEqual(decodeMessage(encode(tuple(state))),state);
 state.actors[0].name+='x';assert.throws(()=>decodeMessage(encode(tuple(state))));
});
