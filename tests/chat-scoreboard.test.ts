import test from 'node:test';
import assert from 'node:assert/strict';
import {UI,scoreboardRows} from '../src/ui.ts';
import {createActor} from '../src/engine.ts';

// Only the small DOM surface touched by chat is substituted. The actual UI
// methods, key routing, escaping, limits and scoreboard markup run unchanged.
class Element {
 value='';innerHTML='';textContent='';className='';dataset:Record<string,string>={};focused=false;
 scrollTop=0;scrollHeight=0;clientHeight=100;
 children:Element[]=[];parent:Element|null=null;classes=new Set<string>();
 classList={add:(name:string)=>this.classes.add(name),remove:(name:string)=>this.classes.delete(name),contains:(name:string)=>this.classes.has(name),toggle:(name:string,force?:boolean)=>{const add=force??!this.classes.has(name);if(add)this.classes.add(name);else this.classes.delete(name);return add;}};
 setAttribute(_name:string,_value:string){}
 replaceChildren(){this.children=[];}
 focus(){this.focused=true;}blur(){this.focused=false;}
 append(...children:Element[]){children.forEach(child=>{child.parent=this;this.children.push(child);});}
 get firstElementChild(){return this.children[0]??null;}
 remove(){if(this.parent)this.parent.children=this.parent.children.filter(child=>child!==this);}
}
function fixture(){
 const ui=Object.create(UI.prototype) as UI;
 const el=Object.fromEntries(['pause','chat-form','chat-input','chat','chat-log'].map(id=>[id,new Element()]));el.pause.classes.add('hidden');el['chat-form'].classes.add('hidden');
 const sent:string[]=[];let opens=0,closes=0;
 Object.assign(ui,{el,online:true,inGame:true,chatOpen:false,scoreHeld:true,modalOpen:false,selectionOpen:false,lobbyOpen:false,chatKeys:new Set<string>(),chatIds:new Set<string>(),chatSend:(text:string)=>sent.push(text),chatOpened:()=>opens++,chatClosed:()=>closes++});
 return{ui,el,sent,opens:()=>opens,closes:()=>closes};
}
function key(code:string,extra:Partial<KeyboardEvent>={}){
 let prevented=false,stopped=false;const event={code,repeat:false,isComposing:false,ctrlKey:false,altKey:false,metaKey:false,...extra,preventDefault:()=>{prevented=true;},stopPropagation:()=>{stopped=true;}} as unknown as KeyboardEvent;
 return{event,prevented:()=>prevented,stopped:()=>stopped};
}
test('T focuses chat, Enter sends once, and Escape discards without a following gameplay key repeat',()=>{
 const {ui,el,sent,opens,closes}=fixture();const t=key('KeyT');
 assert.equal(ui.handleChatKey(t.event),true);assert.ok(t.prevented()&&t.stopped());assert.equal(ui.chatOpen,true);assert.equal(ui.scoreHeld,false);assert.equal(el['chat-input'].focused,true);assert.equal(opens(),1);
 ui.releaseChatKey('KeyT');el['chat-input'].value='  <b>hello</b>  ';
 const enter=key('Enter');assert.equal(ui.handleChatKey(enter.event),true);assert.deepEqual(sent,['<b>hello</b>']);assert.equal(ui.chatOpen,false);assert.equal(el['chat-input'].value,'');assert.equal(closes(),1);
 assert.equal(ui.handleChatKey(key('Enter',{repeat:true}).event),true);assert.equal(ui.chatOpen,false);assert.equal(sent.length,1);
 ui.releaseChatKey('Enter');ui.handleChatKey(key('KeyT').event);el['chat-input'].value='discard';ui.handleChatKey(key('KeyW').event);
 const escape=key('Escape');assert.equal(ui.handleChatKey(escape.event),true);assert.equal(ui.chatOpen,false);assert.deepEqual(sent,['<b>hello</b>']);
 assert.equal(ui.handleChatKey(key('Escape',{repeat:true}).event),true,'holding cancel cannot open pause');
 assert.equal(ui.handleChatKey(key('KeyW',{repeat:true}).event),true,'typing movement keys cannot become held movement after chat closes');
 ui.releaseChatKey('Escape');assert.equal(ui.handleChatKey(key('Escape').event),false,'a fresh Escape returns to ordinary menu handling');
 ui.releaseChatKey('KeyW');assert.equal(ui.handleChatKey(key('KeyW').event),false);
});
test('chat isolates gameplay keys, preserves IME commit, and is unavailable in local/menu/modal screens',()=>{
 const {ui,el,sent}=fixture();
 for(const flag of ['online','inGame'] as const){(ui as any)[flag]=false;assert.equal(ui.handleChatKey(key('KeyT').event),false);(ui as any)[flag]=true;}
 for(const flag of ['modalOpen','selectionOpen','lobbyOpen'] as const){ui[flag]=true;assert.equal(ui.handleChatKey(key('KeyT').event),false);ui[flag]=false;}
 el.pause.classes.delete('hidden');assert.equal(ui.handleChatKey(key('KeyT').event),false);el.pause.classes.add('hidden');
 assert.equal(ui.handleChatKey(key('KeyT',{ctrlKey:true}).event),false);
 ui.handleChatKey(key('KeyT').event);el['chat-input'].value='日本語';
 const composition=key('Enter',{isComposing:true});assert.equal(ui.handleChatKey(composition.event),true);assert.equal(composition.prevented(),false);assert.equal(ui.chatOpen,true);assert.equal(sent.length,0);
 for(const code of ['KeyR','ShiftLeft','Digit2','Space','Tab','KeyC']){const event=key(code);assert.equal(ui.handleChatKey(event.event),true);assert.ok(event.stopped());assert.equal(ui.scoreHeld,false);}
 ui.releaseChatKey('Enter');ui.handleChatKey(key('Enter').event);assert.deepEqual(sent,['日本語']);
});
test('chat escapes markup and retains the complete session, including replay deduplication',()=>{
 const previous=Object.getOwnPropertyDescriptor(globalThis,'document');
 Object.defineProperty(globalThis,'document',{configurable:true,value:{createElement:()=>new Element(),createTextNode:(text:string)=>Object.assign(new Element(),{textContent:text})}});
 try{
  const {ui,el}=fixture();ui.addChat({id:'one',name:'^1<svg>',message:'<img src=x onerror=alert(1)>'});ui.addChat({id:'one',name:'duplicate',message:'ignored'});
  assert.equal(el['chat-log'].children.length,1);const line=el['chat-log'].children[0];assert.match(line.children[0].innerHTML,/&lt;svg&gt;/);assert.doesNotMatch(line.children[0].innerHTML,/<svg/);assert.equal(line.children.at(-1)!.textContent,'<img src=x onerror=alert(1)>');assert.equal(line.children.at(-1)!.innerHTML,'');
  for(let i=0;i<150;i++)ui.addChat({id:String(i),message:'a'.repeat(300)});
  ui.addChat({id:'one',message:'old replay'});
  assert.equal(el['chat-log'].children.length,151);assert.ok(el['chat-log'].children.slice(1).every(item=>item.children.at(-1)!.textContent.length===256));
 }finally{if(previous)Object.defineProperty(globalThis,'document',previous);else delete (globalThis as any).document;}
});
test('multiplayer scoreboard shows individual bounded RTTs while local rows contain only kills and deaths',()=>{
 const one=createActor(0,'british','^3<svg>'),two=createActor(1,'german','Second');one.ping=12;two.ping=174;two.kills=2;
 const online=scoreboardRows([one,two],true);assert.equal((online.match(/<td/g)??[]).length,10);assert.match(online,/<td class="score-ping">174<\/td>/);assert.match(online,/<td class="score-ping">12<\/td>/);assert.ok(online.indexOf('Second')<online.indexOf('&lt;svg&gt;'));assert.doesNotMatch(online,/<svg/);
 const local=scoreboardRows([one,two],false);assert.equal((local.match(/<td/g)??[]).length,8);assert.doesNotMatch(local,/score-ping/);
 for(const missing of [undefined,null,-1,1000,NaN,1.5]){one.ping=missing;assert.match(scoreboardRows([one],true),/<td class="score-ping">—<\/td>/);}
 one.ping=0;assert.match(scoreboardRows([one],true),/<td class="score-ping">0<\/td>/);
});


test('multiplayer status and scoreboard retain literal lobby names and region, then clear on leave',()=>{
 const {ui,el}=fixture();
 for(const id of ['hud','pause-title','hud-menu','difficulty-setting','score-ping','match-lobby','score-lobby','network-status'])el[id]=new Element();
 ui.setOnline(true,'Rommel <Alpha>','or');
 for(const id of ['match-lobby','score-lobby']){assert.equal(el[id].textContent,'Rommel <Alpha> · Oregon (OR)');assert.equal(el[id].innerHTML,'');assert.equal(el[id].classes.has('hidden'),false);}
 ui.setOnline(true,'New match','sp');assert.equal(el['score-lobby'].textContent,'New match · São Paulo (SP)');
 ui.setOnline(false);for(const id of ['match-lobby','score-lobby']){assert.equal(el[id].textContent,'');assert.equal(el[id].classes.has('hidden'),true);}
});

test('chat history scrolls with keys and incoming messages preserve an older reading position',()=>{
 const previous=Object.getOwnPropertyDescriptor(globalThis,'document');
 Object.defineProperty(globalThis,'document',{configurable:true,value:{createElement:()=>new Element(),createTextNode:(text:string)=>Object.assign(new Element(),{textContent:text})}});
 try{
  const {ui,el}=fixture(),log=el['chat-log'];log.scrollHeight=1000;log.scrollTop=400;
  ui.openChat();ui.addChat({id:'new',message:'hello'});assert.equal(log.scrollTop,400);
  const up=key('PageUp');ui.handleChatKey(up.event);assert.equal(log.scrollTop,315);assert.ok(up.prevented()&&up.stopped());
  ui.handleChatKey(key('Home',{ctrlKey:true}).event);assert.equal(log.scrollTop,0);
  ui.handleChatKey(key('End',{ctrlKey:true}).event);assert.equal(log.scrollTop,1000);
  log.scrollTop=900;ui.addChat({id:'latest',message:'world'});assert.equal(log.scrollTop,1000);
  ui.closeChat();assert.equal(log.children.length,2);assert.ok(log.children.every(line=>!line.classes.has('hidden')));
 }finally{if(previous)Object.defineProperty(globalThis,'document',previous);else delete (globalThis as any).document;}
});
