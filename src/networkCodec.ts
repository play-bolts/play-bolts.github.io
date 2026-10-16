import {Decoder,Encoder} from '@msgpack/msgpack';
import actorFields from '../shared/actor-fields.json';
import schema from '../shared/wire-schema.json';
import type {NetworkInput} from './network';

/** Full snapshots remain independently decodable; no rounding or delta baseline. */
export const PROTOCOL_VERSION=schema.version;
export const MAX_INPUT_BYTES=256,MAX_SNAPSHOT_BYTES=8192;
const stances=['stand','crouch','prone'] as const,weapons=['rifle','grenade'] as const;
const encoder=new Encoder({maxDepth:5,forceFloat32:false});
const decoder=new Decoder({maxStrLength:512,maxBinLength:0,maxArrayLength:50,maxMapLength:0,maxExtLength:0});
const utf8=new TextEncoder();
function withinBytes(value:string,maximum:number){return value.length<=maximum&&(value.length*3<=maximum||utf8.encode(value).length<=maximum);}
const finite=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v);
const integer=(v:unknown):v is number=>finite(v)&&Number.isSafeInteger(v)&&v>=0;
const bytes=(value:ArrayBuffer|ArrayBufferView)=>value instanceof ArrayBuffer?new Uint8Array(value):new Uint8Array(value.buffer,value.byteOffset,value.byteLength);
function unpack(value:ArrayBuffer|ArrayBufferView,maximum:number):unknown {
 const data=bytes(value);if(!data.length||data.length>maximum)throw new Error('Invalid binary message size');
 return decoder.decode(data); // decode() rejects trailing objects; collection sizes are bounded.
}
function record(fields:readonly string[],values:unknown[]):Record<string,unknown>{
 const result:Record<string,unknown>={};for(let i=0;i<fields.length;i++)result[fields[i]]=values[i];return result;
}
function inputTuple(input:NetworkInput):unknown[]{
 const stance=stances.indexOf(input.stance),weapon=weapons.indexOf(input.weapon);
 const tuple=[PROTOCOL_VERSION,schema.inputKind,...schema.inputFields.map(field=>field==='stance'?stance:field==='weapon'?weapon:input[field as keyof NetworkInput])];
 validateInput(tuple);return tuple;
}
function validateInput(tuple:unknown):asserts tuple is unknown[]{
 if(!Array.isArray(tuple)||tuple.length!==19||tuple[0]!==PROTOCOL_VERSION||tuple[1]!==schema.inputKind)throw new Error('Invalid input tuple');
 for(const index of [2,3,4])if(!integer(tuple[index]))throw new Error('Invalid input sequence');
 for(const index of [5,6,9,10,11,18])if(!finite(tuple[index]))throw new Error('Invalid input number');
 for(const index of [7,8,12,15,16,17])if(typeof tuple[index]!=='boolean')throw new Error('Invalid input flag');
 if(!Number.isInteger(tuple[13])||!(Number(tuple[13])>=0&&Number(tuple[13])<stances.length)||!Number.isInteger(tuple[14])||!(Number(tuple[14])>=0&&Number(tuple[14])<weapons.length))throw new Error('Invalid input enum');
}
export function encodeInput(input:NetworkInput):Uint8Array<ArrayBuffer> {
 const tuple=inputTuple(input);
 // MessagePack's default integer optimization normalizes -0. Preserve it in
 // the rare command that contains it, without forcing every integer to f64.
 if(tuple.some(value=>Object.is(value,-0))){
  const output=new Uint8Array(MAX_INPUT_BYTES),view=new DataView(output.buffer);output.set([0xdc,0,19]);let offset=3;
  for(const value of tuple){if(Object.is(value,-0)){output[offset++]=0xcb;view.setFloat64(offset,-0);offset+=8;}else{const encoded=encoder.encodeSharedRef(value);output.set(encoded,offset);offset+=encoded.length;}}
  return output.slice(0,offset);
 }
 return encoder.encode(tuple) as Uint8Array<ArrayBuffer>; // Encoder allocates an ordinary ArrayBuffer.
}
/** Primarily useful to protocol probes; the server validates the same tuple. */
export function decodeInput(value:ArrayBuffer|ArrayBufferView):NetworkInput {
 const tuple=unpack(value,MAX_INPUT_BYTES);validateInput(tuple);
 const input=record(schema.inputFields,tuple.slice(2));input.type='input';input.stance=stances[Number(input.stance)];input.weapon=weapons[Number(input.weapon)];
 return input as unknown as NetworkInput;
}
export function decodeMessage(value:string|ArrayBuffer|ArrayBufferView):unknown {
 if(typeof value==='string')return JSON.parse(value);
 const snapshot=decodeSnapshot(unpack(value,MAX_SNAPSHOT_BYTES));if(!snapshot)throw new Error('Invalid binary snapshot');return snapshot;
}
export function decodeSnapshot(value:unknown):unknown {
 // Joining carries one named JSON state; normal traffic is binary protocol 3.
 if(value&&typeof value==='object'&&!Array.isArray(value))return 'actorEncoding' in value?null:value;
 if(!Array.isArray(value)||value.length!==11||value[0]!==PROTOCOL_VERSION||value[1]!==schema.snapshotKind)return null;
 const snapshot=record(schema.snapshotFields,value.slice(2));
 if(typeof snapshot.lobbyId!=='string'||!withinBytes(snapshot.lobbyId,512)||!integer(snapshot.eventSeq)||!integer(snapshot.tick)||!finite(snapshot.time)||!finite(snapshot.remaining)||!integer(snapshot.roundNumber)||typeof snapshot.ended!=='boolean'||snapshot.winner!==null&&!integer(snapshot.winner)||!Array.isArray(snapshot.actors)||snapshot.actors.length<1||snapshot.actors.length>6)return null;
 const actors:Record<string,unknown>[]=[];
 for(const tuple of snapshot.actors){
  if(!Array.isArray(tuple)||tuple.length!==actorFields.length)return null;
  const actor=record(actorFields,tuple);
  if(typeof actor.name!=='string'||!withinBytes(actor.name,256))return null;
  if(actor.pose!==null){if(!Array.isArray(actor.pose)||actor.pose.length!==schema.poseFields.length||!actor.pose.every(finite))return null;actor.pose=record(schema.poseFields,actor.pose);}
  else delete actor.pose; // Actor.pose is optional in named snapshots.
  if(!Array.isArray(actor.inputTiming)||actor.inputTiming.length!==schema.timingFields.length||!actor.inputTiming.every(finite))return null;
  actor.inputTiming=record(schema.timingFields,actor.inputTiming);
  actors.push(actor);
 }
 return {...snapshot,type:'snapshot',inputTiming:'tick-v2',actors,events:[]};
}
