import test from 'node:test';
import assert from 'node:assert/strict';
import {Sound} from '../src/audio.ts';

test('interrupting a reload cancels its queued sounds without stopping the melee sound',()=>{
 const sound=new Sound(),sources:{stops:number;delay:number}[]=[];
 const source=(delay=0)=>{const item={stops:0,delay,stop(){this.stops++;}};sources.push(item);return item;};
 sound.noiseBurst=(_volume,_duration,_frequency,delay=0)=>source(delay) as unknown as AudioBufferSourceNode;
 sound.tone=(_frequency,_duration,_volume,delay=0)=>source(delay) as unknown as OscillatorNode;
 sound.reload();const reload=[...sources];
 assert.ok(reload.some(item=>item.delay>1),'exercise the delayed cartridge sounds');
 sound.noiseBurst(.25,.15,1000);const melee=sources.at(-1)!;
 sound.cancelReload();
 assert.ok(reload.every(item=>item.stops===1));assert.equal(melee.stops,0);
 sound.cancelReload();assert.ok(reload.every(item=>item.stops===1),'cancellation is idempotent');
 sound.reload();const next=sources.slice(reload.length+1);assert.ok(next.every(item=>item.stops===0));
 sound.cancelReload();assert.ok(next.every(item=>item.stops===1),'a subsequent reload has its own cancellable sounds');
});
