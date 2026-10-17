import test from 'node:test';
import assert from 'node:assert/strict';
import {bindGameplayZoomGuard} from '../src/touchGestures.ts';

function fixture(){
 const root=new EventTarget(),button={},menu={};let playing=true;
 const controls={classList:{contains:()=>!playing},contains:(target:unknown)=>target===button};
 const unbind=bindGameplayZoomGuard(root as HTMLElement,controls as unknown as HTMLElement);
 const send=(type:string,ids:number[],target:unknown=menu,cancelable=true)=>{
  const event=new Event(type,{cancelable});
  Object.defineProperty(event,'target',{value:target});
  Object.assign(event,{changedTouches:ids.map(identifier=>({identifier}))});root.dispatchEvent(event);return event;
 };
 return {button,menu,send,unbind,set playing(value:boolean){playing=value;}};
}

test('rapid taps on both controls and empty gameplay space cannot trigger native zoom',()=>{
 const f=fixture();
 for(const target of [f.button,f.menu])for(let i=0;i<8;i++){
  assert.equal(f.send('touchstart',[1],target).defaultPrevented,false,'pointer actions remain independent');
  assert.equal(f.send('touchend',[1],target).defaultPrevented,true);
 }
});

test('a gameplay touch stays guarded when opening a menu before release',()=>{
 const f=fixture();f.send('touchstart',[1],f.button);f.playing=false;
 assert.equal(f.send('touchend',[1],f.menu).defaultPrevented,true);
 // Pointerdown can open the menu before Safari dispatches touchstart.
 f.send('touchstart',[2],f.button);
 assert.equal(f.send('touchend',[2],f.menu).defaultPrevented,true);
});

test('fresh menu gestures retain native clicks, scrolling and pinch zoom',()=>{
 const f=fixture();f.playing=false;
 for(const ids of [[1],[1,2]]){
  assert.equal(f.send('touchstart',ids).defaultPrevented,false);
  assert.equal(f.send('touchend',ids).defaultPrevented,false);
 }
 // Resuming the game midway through a menu gesture cannot steal its release.
 f.send('touchstart',[3]);f.playing=true;
 assert.equal(f.send('touchend',[3]).defaultPrevented,false);
});

test('multiple fingers release independently and cancelled touches do not leak into menus',()=>{
 const f=fixture();f.send('touchstart',[1,2]);
 assert.equal(f.send('touchend',[3]).defaultPrevented,false);
 assert.equal(f.send('touchend',[1]).defaultPrevented,true);
 assert.equal(f.send('touchcancel',[2]).defaultPrevented,false);
 f.playing=false;f.send('touchstart',[2]);
 assert.equal(f.send('touchend',[2]).defaultPrevented,false);
});

test('non-cancelable releases and disposal clear touch ownership',()=>{
 const f=fixture();f.send('touchstart',[1]);
 assert.equal(f.send('touchend',[1],f.button,false).defaultPrevented,false);
 assert.equal(f.send('touchend',[1]).defaultPrevented,false);
 f.send('touchstart',[2]);f.unbind();
 assert.equal(f.send('touchend',[2]).defaultPrevented,false);
 f.send('touchstart',[3]);assert.equal(f.send('touchend',[3]).defaultPrevented,false);
});
