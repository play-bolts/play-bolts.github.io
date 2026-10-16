import test from 'node:test';
import assert from 'node:assert/strict';
import {CommunityClient,validateFeedback,type Leaderboard} from '../src/community.ts';
import {UI} from '../src/ui.ts';

const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
test('feedback preserves meaningful Unicode and optional email while rejecting blank, oversize and malformed input',()=>{
 assert.deepEqual(validateFeedback('  Great game!  ','  '),{message:'Great game!'});
 assert.deepEqual(validateFeedback('More maps\nplease.','  player@example.org '),{message:'More maps\nplease.',email:'player@example.org'});
 assert.equal(Array.from(validateFeedback('🎮'.repeat(2000),'').message).length,2000);
 assert.throws(()=>validateFeedback('🎮'.repeat(2001),''),/2000/);
 assert.throws(()=>validateFeedback(' \n\t ',''),/Enter your feedback/);
 for(const email of ['player','a@b','@example.org','two people@example.org','a@b@c.org','x'.repeat(255)+'@example.org'])assert.throws(()=>validateFeedback('Feedback',email),/valid email/);
});
test('community API targets configured origin without creating an identity and submits only provided fields',async()=>{
 const calls:{url:string;options:RequestInit}[]=[];
 const fetcher=async(url:RequestInfo|URL,options:RequestInit={})=>{calls.push({url:String(url),options});if(String(url).endsWith('/api/status'))return json({online:3});if(String(url).endsWith('/api/leaderboard'))return json({allTime:[{name:'Alice',kills:5,deaths:2}],last24Hours:[{name:'Alice',kills:1,deaths:0}]});return json({id:'feedback-id'},201);};
 const client=new CommunityClient('https://api.example.org/path',fetcher as typeof fetch);
 assert.equal(await client.status(),3);assert.equal((await client.leaderboard()).last24Hours[0].kills,1);await client.feedback('  Useful feedback  ','');
 assert.deepEqual(calls.map(call=>call.url),['https://api.example.org/api/status','https://api.example.org/api/leaderboard','https://api.example.org/api/feedback']);
 assert.equal(calls[0].options.cache,'no-store');assert.equal(calls[1].options.cache,'no-store');assert.equal(calls[2].options.method,'POST');assert.deepEqual(JSON.parse(String(calls[2].options.body)),{message:'Useful feedback'});assert.ok(calls.every(call=>!call.options.credentials));
 await client.feedback('Message',' p@example.org ');assert.deepEqual(JSON.parse(String(calls.at(-1)!.options.body)),{message:'Message',email:'p@example.org'});
});
test('bad service responses cannot display invented counts or negative/unsafe leaderboard statistics',async()=>{
 for(const online of [null,-1,1.2,'5',Number.MAX_SAFE_INTEGER+1])await assert.rejects(new CommunityClient('https://api.example.org',async()=>json({online})).status(),/unavailable/);
 assert.equal(await new CommunityClient('https://api.example.org',async()=>json({online:0})).status(),0);
 for(const entry of [{name:'Alice',kills:-1,deaths:0},{name:'Alice',kills:2,deaths:'4'},{name:'',kills:2,deaths:0}])await assert.rejects(new CommunityClient('https://api.example.org',async()=>json({allTime:[entry],last24Hours:[]})).leaderboard(),/Unable to load/);
 await assert.rejects(new CommunityClient('https://api.example.org',async()=>json({allTime:[]})).leaderboard(),/Unable to load/);
 let called=false;const insecure=new CommunityClient('http://api.example.org',async()=>{called=true;return json({online:0});});await assert.rejects(insecure.status(),/secure/);assert.equal(called,false);
 assert.equal(await new CommunityClient('http://127.0.0.1:3000',async()=>json({online:1})).status(),1);
});
test('feedback errors are actionable and invalid input never sends a request',async()=>{
 let calls=0;const client=new CommunityClient('https://api.example.org',async()=>{calls++;return json({message:'Internal details'},429);});
 await assert.rejects(client.feedback('',''),/Enter your feedback/);assert.equal(calls,0);
 await assert.rejects(client.feedback('Hello',''),/Please wait/);assert.equal(calls,1);
 await assert.rejects(new CommunityClient('https://api.example.org',async()=>{throw new TypeError('Failed to fetch');}).feedback('Hello',''),/Unable to send feedback. Please try again/);
 await assert.rejects(new CommunityClient('https://api.example.org',async()=>json({},201)).feedback('Hello',''),/Unable to confirm/);
});

class Element {
 value='';textContent='';disabled=false;focused=false;tabIndex=0;dataset:Record<string,string>={};children:Element[]=[];attributes=new Map<string,string>();table:Element|null=null;
 focus(){this.focused=true;}append(...children:Element[]){this.children.push(...children);}replaceChildren(){this.children=[];}setAttribute(key:string,value:string){this.attributes.set(key,value);}querySelector(){return this.table;}
}
function fixture(){
 const ui=Object.create(UI.prototype) as UI;
 const el=Object.fromEntries(['feedback-message','feedback-email','feedback-status','feedback-submit','leaderboard-status','leaderboard-refresh','leaderboard-panel','leaderboard-rows','players-online'].map(id=>[id,new Element()]));el['leaderboard-panel'].table=new Element();
 Object.assign(ui,{el,feedbackBusy:false,leaderboardBusy:false,leaderboardStatus:'',leaderboardData:null,leaderboardPeriod:'allTime'});return{ui,el};
}
test('feedback form prevents duplicate submissions, retains failed drafts and only clears after persistence succeeds',async()=>{
 const{ui,el}=fixture();let reject!:(error:Error)=>void,calls=0;
 el['feedback-message'].value='Please fix the sights';el['feedback-email'].value='me@example.org';ui.feedbackSend=async()=>{calls++;await new Promise<void>((_resolve,rejectPromise)=>{reject=rejectPromise;});};
 const pending=ui.submitFeedback();assert.equal(calls,1);assert.equal(el['feedback-submit'].disabled,true);await ui.submitFeedback();assert.equal(calls,1);
 reject(new Error('Unable to send feedback. Please try again.'));await pending;
 assert.equal(el['feedback-message'].value,'Please fix the sights');assert.equal(el['feedback-email'].value,'me@example.org');assert.equal(el['feedback-submit'].disabled,false);assert.match(el['feedback-status'].textContent,/try again/);
 ui.feedbackSend=async(message,email)=>{assert.equal(message,'Please fix the sights');assert.equal(email,'me@example.org');};await ui.submitFeedback();assert.equal(el['feedback-message'].value,'');assert.equal(el['feedback-email'].value,'');assert.equal(el['feedback-status'].textContent,'Feedback sent. Thank you.');
 el['feedback-message'].value='  ';ui.feedbackSend=async()=>{throw new Error('must not send');};await ui.submitFeedback();assert.equal(el['feedback-message'].focused,true);assert.match(el['feedback-status'].textContent,/Enter your feedback/);
});
test('leaderboard renders names as literal text, supports 24-hour totals, and retains loading errors across tab changes',()=>{
 const previous=Object.getOwnPropertyDescriptor(globalThis,'document'),tabs=[Object.assign(new Element(),{dataset:{period:'allTime'}}),Object.assign(new Element(),{dataset:{period:'last24Hours'}})];
 Object.defineProperty(globalThis,'document',{configurable:true,value:{createElement:()=>new Element(),querySelectorAll:()=>tabs}});
 try{
  const{ui,el}=fixture();const data:Leaderboard={allTime:[{name:'<img onerror=alert(1)>',kills:10,deaths:5},{name:'Zero',kills:0,deaths:0}],last24Hours:[{name:'Zero',kills:0,deaths:0}]};
  ui.setLeaderboard(data);assert.equal(el['leaderboard-rows'].children.length,2);assert.equal(el['leaderboard-rows'].children[0].children[1].textContent,'<img onerror=alert(1)>');assert.equal(el['leaderboard-rows'].children[0].children[2].textContent,'10');assert.equal(tabs[0].attributes.get('aria-selected'),'true');
  ui.setLeaderboardStatus('Loading…',true);(ui as any).setLeaderboardPeriod('last24Hours');assert.equal(el['leaderboard-status'].textContent,'Loading…');assert.equal(el['leaderboard-refresh'].disabled,true);assert.equal(el['leaderboard-rows'].children.length,1);assert.equal(tabs[1].tabIndex,0);assert.equal(tabs[0].tabIndex,-1);
  ui.setLeaderboardStatus('Unable to load leaderboard.');(ui as any).setLeaderboardPeriod('allTime');assert.equal(el['leaderboard-status'].textContent,'Unable to load leaderboard.');assert.equal(el['leaderboard-refresh'].disabled,false);
  ui.setLeaderboard({allTime:[],last24Hours:[]});assert.equal(el['leaderboard-status'].textContent,'No players yet.');
 }finally{if(previous)Object.defineProperty(globalThis,'document',previous);else delete(globalThis as any).document;}
});
