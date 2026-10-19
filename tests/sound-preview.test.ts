import test from 'node:test';
import assert from 'node:assert/strict';
import {SoundPreviewPlayer,type PreviewState} from '../src/soundPreview.ts';

function deferred<T>(){let resolve!:(value:T)=>void,reject!:(reason?:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};}
const settle=()=>new Promise<void>(resolve=>setImmediate(resolve));
function fixture(resume=()=>Promise.resolve()){
 const states:PreviewState[]=[],sources:{buffer:AudioBuffer|null;onended:(()=>void)|null;started:boolean;stopped:boolean;disconnected:boolean;connect:()=>void;start:()=>void;stop:()=>void;disconnect:()=>void}[]=[];
 let contexts=0,volume=.6;const gain={gain:{value:0},connect(){}};
 const context={resume,destination:{},createGain:()=>gain,createBufferSource(){
  const source={buffer:null as AudioBuffer|null,onended:null as (()=>void)|null,started:false,stopped:false,disconnected:false,connect(){},start(){this.started=true;},stop(){this.stopped=true;},disconnect(){this.disconnected=true;}};
  sources.push(source);return source;
 }} as unknown as AudioContext;
 const player=new SoundPreviewPlayer(()=>volume,state=>states.push(state),()=>{contexts++;return context;});
 return{player,states,sources,gain,contexts:()=>contexts,setVolume:(value:number)=>volume=value};
}

test('previews create audio lazily, obey volume, and stop the prior source before replacement',async()=>{
 const f=fixture(),buffer={} as AudioBuffer;assert.equal(f.contexts(),0);
 await f.player.play('first','First',()=>buffer);assert.equal(f.contexts(),1);assert.equal(f.gain.gain.value,.6);assert.equal(f.sources[0].started,true);
 const oldEnded=f.sources[0].onended!;f.setVolume(.25);
 await f.player.play('second','Second',()=>buffer);assert.equal(f.contexts(),1);assert.equal(f.gain.gain.value,.25);
 assert.equal(f.sources[0].stopped,true);assert.equal(f.sources[0].disconnected,true);assert.equal(f.sources[1].started,true);
 oldEnded();assert.deepEqual(f.states.at(-1),{phase:'playing',id:'second',label:'Second'});
 f.player.stop();assert.equal(f.sources[1].stopped,true);assert.equal(f.sources[1].disconnected,true);assert.deepEqual(f.states.at(-1),{phase:'idle'});
});

test('Stop aborts pending loading and a late decode cannot start playback',async()=>{
 const f=fixture(),decoded=deferred<AudioBuffer>();let signal:AbortSignal|undefined;
 const playing=f.player.play('voice','Voice',(_context,currentSignal)=>{signal=currentSignal;return decoded.promise;});
 await settle();assert.equal(signal?.aborted,false);f.player.stop();assert.equal(signal?.aborted,true);
 decoded.resolve({} as AudioBuffer);await playing;assert.equal(f.sources.length,0);assert.deepEqual(f.states.at(-1),{phase:'idle'});
});

test('a stale decode cannot replace a newer preview or overwrite its playing state',async()=>{
 const f=fixture(),old=deferred<AudioBuffer>(),fresh=deferred<AudioBuffer>();
 const first=f.player.play('old','Old',()=>old.promise);await settle();
 const second=f.player.play('fresh','Fresh',()=>fresh.promise);await settle();
 const latestBuffer={} as AudioBuffer;fresh.resolve(latestBuffer);await second;
 old.resolve({} as AudioBuffer);await first;
 assert.equal(f.sources.length,1);assert.equal(f.sources[0].buffer,latestBuffer);assert.deepEqual(f.states.at(-1),{phase:'playing',id:'fresh',label:'Fresh'});
});

test('closing while AudioContext is resuming cancels even the subsequent load',async()=>{
 const resumed=deferred<void>(),f=fixture(()=>resumed.promise);let loads=0;
 const playing=f.player.play('voice','Voice',()=>{loads++;return{} as AudioBuffer;});
 f.player.stop();resumed.resolve();await playing;assert.equal(loads,0);assert.equal(f.sources.length,0);
});

test('failed audio remains stopped and retries can play successfully',async()=>{
 const f=fixture();await f.player.play('voice','Voice',async()=>{throw new Error('decode failed');});
 assert.equal(f.sources.length,0);assert.deepEqual(f.states.at(-1),{phase:'error',id:'voice',label:'Voice'});
 await f.player.play('retry','Retry',()=>({} as AudioBuffer));assert.equal(f.sources.length,1);assert.equal(f.sources[0].started,true);
 f.sources[0].onended!();assert.equal(f.sources[0].disconnected,true);assert.deepEqual(f.states.at(-1),{phase:'idle'});
});
