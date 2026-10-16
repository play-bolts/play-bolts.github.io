/** Local CPU/payload comparison. Run: node --import tsx scripts/benchmark-codec.ts
 * Fixtures include six moving actors captured from the Rust simulation.
 * This isolates codec cost; it is not an end-to-end latency benchmark. */
import {mkdirSync,writeFileSync} from 'node:fs';
import {performance} from 'node:perf_hooks';
import fixture from '../shared/fixtures/codec-v3.json';
import fields from '../shared/actor-fields.json';
import {decodeMessage,encodeInput} from '../src/networkCodec.ts';
import type {NetworkInput} from '../src/network.ts';
const sample=fixture as any,input=sample.inputs[0].input as NetworkInput,binary=Buffer.from(sample.snapshotHex,'hex');
const oldState={...sample.snapshot,actorEncoding:'tuple-v1',actors:sample.snapshot.actors.map((actor:any)=>fields.map(key=>actor[key]??null))};
const json=JSON.stringify(oldState);
function oldDecode(text:string){const s=JSON.parse(text);s.actors=s.actors.map((tuple:unknown[])=>{const actor:Record<string,unknown>={};for(let i=0;i<fields.length;i++)actor[fields[i]]=tuple[i];return actor;});delete s.actorEncoding;return s;}
let sink:unknown;
function bench(action:()=>unknown,iterations=20000){for(let i=0;i<2000;i++)sink=action();const samples:number[]=[];for(let pass=0;pass<7;pass++){const start=performance.now();for(let i=0;i<iterations;i++)sink=action();samples.push((performance.now()-start)*1000/iterations);}samples.sort((a,b)=>a-b);return {medianMicroseconds:samples[3],minMicroseconds:samples[0],maxMicroseconds:samples[6],iterations,passes:7};}
const report={date:new Date().toISOString(),runtime:process.version,method:'Single process warmed 7-pass microbenchmark, six moving Rust actors. Actual implementation bytes, no TCP/TLS framing; isolated codec cost, not rendering or latency.',bytes:{inputJSON:Buffer.byteLength(JSON.stringify(input)),inputBinary:encodeInput(input).length,snapshotTupleJSON:Buffer.byteLength(json),snapshotBinary:binary.length},cpu:{inputJSONEncode:bench(()=>JSON.stringify(input)),inputBinaryEncode:bench(()=>encodeInput(input)),snapshotTupleJSONDecode:bench(()=>oldDecode(json)),snapshotBinaryDecode:bench(()=>decodeMessage(binary))}};
mkdirSync('temp/transport-audit',{recursive:true});writeFileSync('temp/transport-audit/codec-benchmark.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));void sink;
