import test from 'node:test';
import assert from 'node:assert/strict';
import {bindTouchAction} from '../src/touchActions.ts';

class Button extends EventTarget {
 disabled=false;captured:number[]=[];
 constructor(readonly ownerDocument:EventTarget){super();}
 setPointerCapture(pointer:number){this.captured.push(pointer);}
}
function fixture(){
 const document=new EventTarget(),button=new Button(document),other=new Button(document);
 let actions=0,otherActions=0;
 bindTouchAction(button as unknown as HTMLButtonElement,()=>actions++);
 bindTouchAction(other as unknown as HTMLButtonElement,()=>otherActions++);
 function send(target:Button,type:string,fields:Record<string,unknown>={}){
  const event=new Event(type,{cancelable:true});
  Object.assign(event,{pointerId:2,pointerType:'touch',button:0,isPrimary:false,clientX:100,clientY:120,detail:1,...fields});
  // EventTarget has no DOM hierarchy: run document capture before the target.
  document.dispatchEvent(event);if(!event.defaultPrevented)target.dispatchEvent(event);
  return event;
 }
 return {button,other,send,get actions(){return actions;},get otherActions(){return otherActions;}};
}

test('a non-primary finger activates on contact while another finger remains held',()=>{
 const f=fixture();
 const press=f.send(f.button,'pointerdown');assert.equal(press.defaultPrevented,true);assert.equal(f.actions,1);assert.deepEqual(f.button.captured,[2]);
 assert.equal(f.send(f.button,'pointerup',{pointerId:1}).defaultPrevented,false,'another finger is not consumed');
 assert.equal(f.send(f.button,'pointerup').defaultPrevented,true);
 assert.equal(f.send(f.button,'click').defaultPrevented,true);assert.equal(f.actions,1,'the compatibility click cannot repeat the action');
});

test('opening a menu cannot send the original touch release or click into its new buttons',()=>{
 const f=fixture();f.send(f.button,'pointerdown',{pointerType:'pen'});
 assert.equal(f.actions,1);
 assert.equal(f.send(f.other,'pointerup',{pointerType:'pen'}).defaultPrevented,true);
 assert.equal(f.send(f.other,'click',{pointerType:'pen'}).defaultPrevented,true);
 assert.equal(f.otherActions,0,'retargeting after the original control hides is still guarded');
 f.send(f.other,'pointerdown',{pointerId:3});assert.equal(f.otherActions,1,'a fresh finger gesture still activates the new menu');
});

test('MouseEvent compatibility clicks are suppressed without blocking keyboard or real mouse input',()=>{
 const f=fixture();f.send(f.button,'pointerdown');f.send(f.button,'pointerup');
 f.send(f.other,'click',{detail:0,pointerId:undefined,pointerType:undefined});assert.equal(f.otherActions,1,'keyboard activation works immediately');
 assert.equal(f.send(f.other,'click',{pointerId:undefined,pointerType:undefined}).defaultPrevented,true);assert.equal(f.otherActions,1);
 f.send(f.button,'pointerdown',{pointerId:3});f.send(f.button,'pointerup',{pointerId:3});
 f.send(f.other,'pointerdown',{pointerId:1,pointerType:'mouse'});
 f.send(f.other,'click',{pointerId:1,pointerType:'mouse'});assert.equal(f.otherActions,2,'a real mouse gesture at the same position is distinct');
});

test('cancelled contact never produces a second action and pointer IDs can be reused',()=>{
 const f=fixture();f.send(f.button,'pointerdown');f.send(f.button,'pointerdown');assert.equal(f.actions,1);
 assert.equal(f.send(f.button,'pointercancel').defaultPrevented,true);
 assert.equal(f.send(f.other,'click').defaultPrevented,true);assert.equal(f.otherActions,0);
 f.send(f.button,'pointerdown');assert.equal(f.actions,2);
});

test('disabled buttons and pen secondary buttons do not activate',()=>{
 const f=fixture();f.button.disabled=true;assert.equal(f.send(f.button,'pointerdown').defaultPrevented,false);f.send(f.button,'click',{detail:0});assert.equal(f.actions,0);
 f.button.disabled=false;f.send(f.button,'pointerdown',{pointerType:'pen',button:2});assert.equal(f.actions,0);
 f.send(f.button,'pointerdown',{pointerType:'mouse'});assert.equal(f.actions,0);f.send(f.button,'click',{pointerType:'mouse'});assert.equal(f.actions,1);
});
