import test from 'node:test';
import assert from 'node:assert/strict';
import {VisitorTracker,VISITOR_STORAGE_KEY,VISITOR_HEARTBEAT_MS,readVisitorId,visitorPrivacyOptOut,visitorTrackingAllowed,type VisitorStorage,type VisitorTrackerOptions} from '../src/visitors.ts';

const ID='15c96e6a-dd7f-4c64-86dc-ffcd84508424';
const OTHER_ID='8c72c6fd-e992-4d56-ada6-01c3b91e6a65';
const flush=async()=>{for(let i=0;i<5;i++)await Promise.resolve();};
class Storage implements VisitorStorage {
 values=new Map<string,string>();reads:string[]=[];writes:string[]=[];
 getItem(key:string){this.reads.push(key);return this.values.get(key)??null;}
 setItem(key:string,value:string){this.writes.push(key);this.values.set(key,value);}
}
class Page extends EventTarget {
 hidden=false;
 visibility(hidden:boolean){this.hidden=hidden;this.dispatchEvent(new Event('visibilitychange'));}
}
class Clock {
 now=0;next=0;timers=new Map<number,{at:number;callback:()=>void}>();
 set=(callback:()=>void,delay:number)=>{const id=++this.next;this.timers.set(id,{at:this.now+delay,callback});return id;};
 clear=(id:number)=>{this.timers.delete(id);};
 async advance(ms:number){
  await flush();const end=this.now+ms;
  for(;;){
   const next=[...this.timers].filter(([,timer])=>timer.at<=end).sort((a,b)=>a[1].at-b[1].at||a[0]-b[0])[0];
   if(!next)break;this.now=next[1].at;this.timers.delete(next[0]);next[1].callback();await flush();
  }
  this.now=end;await flush();
 }
}
function fixture(overrides:Partial<VisitorTrackerOptions>={}){
 const storage=new Storage(),document=new Page(),window=new EventTarget(),clock=new Clock();
 const calls:{url:string;options:RequestInit;time:number}[]=[];let ids=0;
 const options:VisitorTrackerOptions={enabled:true,origin:'https://api.example.org/ignored?private=discarded',storage,document,window,
  randomUUID:()=>{ids++;return ID;},now:()=>clock.now,setTimer:clock.set,clearTimer:clock.clear,
  fetcher:async(url,options)=>{calls.push({url,options,time:clock.now});return {ok:true};},...overrides};
 const tracker=new VisitorTracker(options);
 return{tracker,options,storage,document,window,clock,calls,idCount:()=>ids};
}

test('visitor ID persists across tabs/reloads without reading player credentials or names',()=>{
 const storage=new Storage();storage.values.set('bolts-player-token','private credential');storage.values.set('bolts-preferences','{"playerName":"Private name"}');let created=0;
 assert.equal(readVisitorId(storage,()=>{created++;return ID;}),ID);
 assert.equal(readVisitorId(storage,()=>{created++;return OTHER_ID;}),ID);
 assert.equal(created,1);assert.deepEqual(storage.writes,[VISITOR_STORAGE_KEY]);assert.ok(storage.reads.every(key=>key===VISITOR_STORAGE_KEY));
 assert.equal(storage.values.get('bolts-player-token'),'private credential');assert.equal(storage.values.get('bolts-preferences'),'{"playerName":"Private name"}');
});

test('invalid IDs are replaced with random UUIDv4; blocked or nonpersistent storage skips counting',()=>{
 for(const invalid of ['Player','15c96e6a-dd7f-1c64-86dc-ffcd84508424','15c96e6a-dd7f-4c64-06dc-ffcd84508424','']){
  const storage=new Storage();storage.values.set(VISITOR_STORAGE_KEY,invalid);assert.equal(readVisitorId(storage,()=>ID),ID);
 }
 assert.equal(readVisitorId({getItem:()=>{throw new Error('Blocked');},setItem:()=>{}},()=>ID),null);
 assert.equal(readVisitorId({getItem:()=>null,setItem:()=>{throw new Error('Quota');}},()=>ID),null);
 assert.equal(readVisitorId({getItem:()=>null,setItem:()=>{}},()=>ID),null);
 assert.equal(readVisitorId(new Storage(),()=>{throw new Error('No randomUUID');}),null);
 assert.equal(readVisitorId(new Storage(),()=>'<not an ID>'),null);
});

test('production visits are enabled, while dev, inspectors and QA are disabled by default',()=>{
 const base={production:true,pathname:'/',search:''};assert.equal(visitorTrackingAllowed(base),true);
 assert.equal(visitorTrackingAllowed({...base,production:false}),false);
 for(const pathname of ['/inspector.html','/nested/inspector.html','/performance.html','/audio-qa.html','/webgpu-probe.html'])assert.equal(visitorTrackingAllowed({...base,pathname}),false);
 for(const search of ['?qa=1','?qa=0','?inspector=1','?visits=0'])assert.equal(visitorTrackingAllowed({...base,search}),false);
 assert.equal(visitorTrackingAllowed({...base,production:false,search:'?qa=1&visits=1'}),true);
 assert.equal(visitorTrackingAllowed({...base,search:'?visits=1',globalPrivacyControl:true}),false);
});

test('GPC and standard or legacy Do Not Track signals override QA opt-in',()=>{
 for(const privacy of [{globalPrivacyControl:true},{doNotTrack:'1'},{doNotTrack:'yes'},{doNotTrack:'YES'},{windowDoNotTrack:'1'},{msDoNotTrack:1}]){
  assert.equal(visitorPrivacyOptOut(privacy),true);
  assert.equal(visitorTrackingAllowed({production:true,pathname:'/',search:'?visits=1',...privacy}),false);
 }
 for(const privacy of [{},{globalPrivacyControl:false},{doNotTrack:'0'},{doNotTrack:'unspecified'}])assert.equal(visitorPrivacyOptOut(privacy),false);
});

test('initial POST contains only visitorId, omits credentials/referrer, and does not wait for a response',()=>{
 const f=fixture();f.tracker.start();f.tracker.start();assert.equal(f.calls.length,1);assert.equal(f.idCount(),1);
 const request=f.calls[0];assert.equal(request.url,'https://api.example.org/api/visits');
 assert.equal(request.options.method,'POST');assert.deepEqual(JSON.parse(String(request.options.body)),{visitorId:ID});
 assert.deepEqual(request.options.headers,{'Content-Type':'application/json'});assert.equal(request.options.credentials,'omit');assert.equal(request.options.referrerPolicy,'no-referrer');
 assert.equal(request.options.cache,'no-store');assert.equal(request.options.redirect,'error');assert.equal(request.options.keepalive,false);assert.ok(request.options.signal instanceof AbortSignal);
 f.tracker.stop();
});

test('disabled, opted-out, unconfigured, insecure and blocked-storage tracking creates no ID or network request',()=>{
 for(const change of [{enabled:false},{origin:''},{origin:'not a URL'},{origin:'http://api.example.org'},{origin:'https://name:password@api.example.org'},{privacyOptOut:()=>true},{privacyOptOut:()=>{throw new Error('No privacy access');}}]){
  const f=fixture(change);f.tracker.start();assert.equal(f.calls.length,0);assert.equal(f.storage.reads.length,0);assert.equal(f.idCount(),0);assert.equal(f.clock.timers.size,0);
 }
 const f=fixture({storage:{getItem:()=>{throw new Error('Blocked');},setItem:()=>{}}});f.tracker.start();assert.equal(f.calls.length,0);assert.equal(f.clock.timers.size,0);
 const local=fixture({origin:'http://127.0.0.1:3000'});local.tracker.start();assert.equal(local.calls[0].url,'http://127.0.0.1:3000/api/visits');local.tracker.stop();
});

test('heartbeats run once per visible minute and hidden tabs produce no interval traffic',async()=>{
 const f=fixture();f.tracker.start();await f.clock.advance(15_000);f.document.visibility(true);
 assert.equal(f.calls.length,2);assert.equal(f.calls[1].options.keepalive,true);
 await f.clock.advance(180_000);assert.equal(f.calls.length,2);assert.equal(f.clock.timers.size,0);
 f.document.visibility(false);assert.equal(f.calls.length,3);assert.equal(f.calls[2].time,195_000);
 await f.clock.advance(VISITOR_HEARTBEAT_MS-1);assert.equal(f.calls.length,3);
 await f.clock.advance(1);assert.equal(f.calls.length,4);assert.equal(f.calls[3].options.keepalive,false);f.tracker.stop();
});

test('an initially background tab records its opening once without starting background heartbeats',async()=>{
 const f=fixture();f.document.hidden=true;f.tracker.start();assert.equal(f.calls.length,1);
 await f.clock.advance(180_000);assert.equal(f.calls.length,1);assert.equal(f.clock.timers.size,0);
 f.document.visibility(false);assert.equal(f.calls.length,2);f.tracker.stop();
});

test('hidden/pagehide and quick visibility changes coalesce; BFCache pages resume on pageshow',async()=>{
 const f=fixture();f.tracker.start();await f.clock.advance(10_000);
 f.document.visibility(true);f.window.dispatchEvent(new Event('pagehide'));assert.equal(f.calls.length,2);
 await f.clock.advance(70_000);f.document.visibility(false);assert.equal(f.calls.length,2,'pagehide stays suspended until pageshow');
 f.window.dispatchEvent(new Event('pageshow'));assert.equal(f.calls.length,3);
 f.document.visibility(true);f.document.visibility(false);f.window.dispatchEvent(new Event('pageshow'));assert.equal(f.calls.length,3,'no lifecycle burst');
 await f.clock.advance(VISITOR_HEARTBEAT_MS);assert.equal(f.calls.length,4);
 await f.clock.advance(100);f.document.visibility(true);assert.equal(f.calls.length,4,'final ping coalesces with the just-sent heartbeat');f.tracker.stop();
});

test('simultaneous tabs serialize first ID creation and reuse the same browser ID',async()=>{
 const storage=new Storage();let chain=Promise.resolve<string|null>(null),created=0;
 const identityLock=(read:()=>string|null)=>{const result=chain.then(read);chain=result;return result;};
 const first=fixture({storage,identityLock,randomUUID:()=>{created++;return ID;}});
 const second=fixture({storage,identityLock,randomUUID:()=>{created++;return OTHER_ID;}});
 first.tracker.start();second.tracker.start();await flush();
 assert.equal(created,1);assert.equal(first.calls.length,1);assert.equal(second.calls.length,1);
 assert.equal(first.calls[0].options.body,second.calls[0].options.body);first.tracker.stop();second.tracker.stop();
});

test('timeouts abort stalled requests and failures do not cause retries or block the next minute',async()=>{
 const signals:AbortSignal[]=[];let attempts=0;
 const f=fixture({fetcher:(_url,options)=>{attempts++;signals.push(options.signal as AbortSignal);return new Promise(()=>{});}});
 f.tracker.start();assert.equal(attempts,1);await f.clock.advance(6_000);assert.equal(signals[0].aborted,true);
 await f.clock.advance(54_000);assert.equal(attempts,2);f.tracker.stop();assert.equal(signals[1].aborted,true);assert.equal(f.clock.timers.size,0);
 for(const fetcher of [()=>Promise.reject(new Error('Offline')),()=>{throw new Error('Blocked');},()=>Promise.resolve({ok:false,status:429})]){
  let count=0;const failed=fixture({fetcher:()=>{count++;return fetcher();}});assert.doesNotThrow(()=>failed.tracker.start());
  await failed.clock.advance(59_999);assert.equal(count,1);await failed.clock.advance(1);assert.equal(count,2);failed.tracker.stop();
 }
});

test('stop removes lifecycle listeners and prevents a pending identity lock from sending',async()=>{
 const f=fixture();f.tracker.start();f.tracker.stop();await f.clock.advance(120_000);
 f.document.visibility(true);f.document.visibility(false);f.window.dispatchEvent(new Event('pageshow'));assert.equal(f.calls.length,1);assert.equal(f.clock.timers.size,0);
 let release!:(id:string|null)=>void;const pending=fixture({identityLock:()=>new Promise(resolve=>{release=resolve;})});
 pending.tracker.start();pending.tracker.stop();release(ID);await flush();assert.equal(pending.calls.length,0);assert.equal(pending.clock.timers.size,0);
});

test('a newly enabled privacy signal stops subsequent visits and clears timers',async()=>{
 let optedOut=false;const f=fixture({privacyOptOut:()=>optedOut});f.tracker.start();await f.clock.advance(10_000);optedOut=true;
 f.document.visibility(true);await flush();assert.equal(f.calls.length,1);assert.equal(f.clock.timers.size,0);
 f.document.visibility(false);await f.clock.advance(120_000);assert.equal(f.calls.length,1);
});

test('privacy changes or stop while waiting for an identity lock prevent storage writes',async()=>{
 for(const cancel of ['privacy','stop']){
  let optedOut=false,release!:()=>void;
  const f=fixture({privacyOptOut:()=>optedOut,identityLock:read=>new Promise(resolve=>{release=()=>resolve(read());})});
  f.tracker.start();if(cancel==='privacy')optedOut=true;else f.tracker.stop();release();await flush();
  assert.equal(f.storage.reads.length,0);assert.equal(f.storage.writes.length,0);assert.equal(f.calls.length,0);assert.equal(f.clock.timers.size,0);
 }
});
