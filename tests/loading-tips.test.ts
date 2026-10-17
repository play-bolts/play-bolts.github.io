import test from 'node:test';
import assert from 'node:assert/strict';
import {LOADING_TIPS,LoadingTips,LOADING_TIP_INTERVAL_MS,LOADING_TIP_FADE_MS} from '../src/loadingTips.ts';

function fixture(t:import('node:test').TestContext,reduced=false,random=()=>0){
 t.mock.timers.enable({apis:['setTimeout']});
 const changes:{text:string;fading:boolean;announce:boolean}[]=[];
 const tips=new LoadingTips((text,fading,announce)=>changes.push({text,fading,announce}),()=>reduced,random);
 const shown=()=>changes.filter(change=>!change.fading).at(-1)!;
 t.after(()=>tips.stop());return{tips,changes,shown,tick:(ms:number)=>t.mock.timers.tick(ms)};
}

test('loading immediately shows a shuffled tip and arrows traverse every tip reversibly',t=>{
 const f=fixture(t,true);f.tips.start();const first=f.shown().text;
 assert.notEqual(first,LOADING_TIPS[0],'initial shuffle can select a different first tip');
 f.tips.move(1);const next=f.shown().text;assert.notEqual(next,first);assert.equal(f.shown().announce,true);
 f.tips.move(-1);assert.equal(f.shown().text,first);
 const seen=new Set([first]);for(let i=1;i<LOADING_TIPS.length;i++){f.tips.move(1);seen.add(f.shown().text);}
 assert.equal(seen.size,LOADING_TIPS.length);f.tips.move(1);assert.equal(f.shown().text,first);
 f.tips.move(-1);assert.notEqual(f.shown().text,first,'previous wraps at the start');
});

test('automatic rotation waits ten seconds, fades quickly, and never announces automatically',t=>{
 const f=fixture(t);f.tips.start();const first=f.shown().text;
 f.tick(LOADING_TIP_INTERVAL_MS-1);assert.equal(f.changes.length,1);
 f.tick(1);assert.equal(f.changes.at(-1)!.fading,true);assert.equal(f.shown().text,first);
 f.tick(LOADING_TIP_FADE_MS);assert.notEqual(f.shown().text,first);assert.equal(f.shown().announce,false);
});

test('manual navigation resets the ten-second timer and rapid arrows cannot publish stale tips',t=>{
 const f=fixture(t);f.tips.start();const first=f.shown().text;
 f.tick(9900);f.tips.move(1);f.tick(60);f.tips.move(-1);f.tick(LOADING_TIP_FADE_MS);
 assert.equal(f.shown().text,first);assert.equal(f.shown().announce,true);
 const count=f.changes.length;f.tick(LOADING_TIP_INTERVAL_MS-LOADING_TIP_FADE_MS-1);assert.equal(f.changes.length,count);
 f.tick(1);assert.equal(f.changes.at(-1)!.fading,true);
});

test('focus, hover or hidden-page pause suppresses automatic rotation while arrows still work',t=>{
 const f=fixture(t,true);f.tips.start();f.tips.setPaused(true);const first=f.shown().text;
 f.tick(30000);assert.equal(f.changes.length,1);
 f.tips.move(1);assert.notEqual(f.shown().text,first);const count=f.changes.length;
 f.tick(30000);assert.equal(f.changes.length,count);
 f.tips.setPaused(false);f.tick(9999);assert.equal(f.changes.length,count);f.tick(1);assert.equal(f.changes.length,count+1);
});

test('completion or failure cancels pending fades and future rotation, and restart has one timer',t=>{
 const f=fixture(t);f.tips.start();f.tips.move(1);f.tips.stop();const count=f.changes.length;
 f.tick(30000);f.tips.move(1);assert.equal(f.changes.length,count);
 f.tips.start();f.tips.start();const restarted=f.changes.length;
 f.tick(10000);assert.equal(f.changes.length,restarted+1);f.tick(120);assert.equal(f.changes.length,restarted+2);
});

test('reduced motion changes tips immediately without a fade timeout',t=>{
 const f=fixture(t,true);f.tips.start();f.tips.move(1);const count=f.changes.length;
 assert.ok(f.changes.every(change=>!change.fading));f.tick(120);assert.equal(f.changes.length,count);
});
