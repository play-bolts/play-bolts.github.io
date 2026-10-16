import test from 'node:test';
import assert from 'node:assert/strict';
import {AudioEnvironmentCache} from '../src/audioEnvironmentCache.ts';

test('concurrent actor cues share occlusion work; listener/emitter movement invalidates only relevant results',()=>{
 let rays=0;const cache=new AudioEnvironmentCache((origin,listener)=>{rays++;return{gain:origin.x===listener.x?1:.43,cutoff:1050};});
 const listener={x:1,y:2,z:3},actor={x:4,y:2,z:3};cache.setListener(listener);
 const first=cache.get(7,actor,false);for(let i=0;i<12;i++)assert.equal(cache.get(7,actor,false),first);assert.equal(rays,1,'shot, step and queued reload voices use one ray');
 cache.get(8,{...actor,x:5},false);cache.setListener({...listener});cache.get(7,actor,false);assert.equal(rays,2,'unchanged frame/rotation needs no new occlusion rays');
 actor.x=6;cache.get(7,actor,false);assert.equal(rays,3);cache.get(8,{x:5,y:2,z:3},false);assert.equal(rays,3,'other actors retain their result');
 assert.deepEqual(cache.get(7,actor,true),{gain:1,cutoff:20000});assert.equal(rays,3,'first-person cues bypass obstruction');
 cache.setListener({...listener,x:6});assert.equal(cache.get(7,actor,false).gain,1);assert.equal(rays,4,'listener movement recomputes correct path');
 cache.delete(7);cache.get(7,actor,false);assert.equal(rays,5);cache.clear();cache.get(7,actor,false);assert.equal(rays,6);
});
