import test from 'node:test';
import assert from 'node:assert/strict';
import {TouchControls} from '../src/touchControls.ts';

class Surface extends EventTarget {
 writes=0;
 captured=new Set<number>();
 properties=new Map<string,string>();
 classes=new Set<string>();
 dataset:Record<string,string>={};
 style={setProperty:(name:string,value:string)=>{this.writes++;this.properties.set(name,value);}};
 classList={toggle:(name:string,enabled:boolean)=>enabled?this.classes.add(name):this.classes.delete(name)};
 getBoundingClientRect(){return {left:0,top:0,width:100,height:100};}
 setPointerCapture(pointer:number){this.captured.add(pointer);}
 hasPointerCapture(pointer:number){return this.captured.has(pointer);}
 releasePointerCapture(pointer:number){this.captured.delete(pointer);this.pointer('lostpointercapture',pointer);}
 pointer(type:string,pointerId:number,x=50,y=50,pointerType='touch',timeStamp?:number){
  const event=new Event(type,{cancelable:true});
  Object.assign(event,{pointerId,clientX:x,clientY:y,pointerType});
  if(timeStamp!==undefined)Object.defineProperty(event,'timeStamp',{value:timeStamp});
  this.dispatchEvent(event);return event;
 }
}
function fixture(){
 const move=new Surface(),fire=new Surface(),look=new Surface();
 const callbacks={shots:0,jumps:0,releases:0,cancellations:[] as boolean[],resets:0,looks:[] as [number,number][]};
 const controls=new TouchControls({move:move as unknown as HTMLElement,fire:fire as unknown as HTMLElement,look:look as unknown as HTMLElement},{
  look:(dx,dy)=>callbacks.looks.push([dx,dy]),fire:()=>callbacks.shots++,fireReleased:cancelled=>{callbacks.releases++;callbacks.cancellations.push(cancelled);},jump:()=>callbacks.jumps++,reset:()=>callbacks.resets++,
 });
 controls.setEnabled(true);return {move,fire,look,controls,callbacks};
}
const close=(actual:number,expected:number)=>assert.ok(Math.abs(actual-expected)<1e-9,`${actual} should equal ${expected}`);

test('independent fingers own movement and fire until each owner releases',()=>{
 const {move,fire,controls,callbacks}=fixture();
 move.pointer('pointerdown',1,50,10);fire.pointer('pointerdown',2,90,50);
 assert.deepEqual(controls.movement,{forward:1,right:0});assert.equal(fire.dataset.active,'true');assert.equal(callbacks.shots,1);
 move.pointer('pointermove',2,10,50);move.pointer('pointerup',2);fire.pointer('pointerup',1);
 assert.deepEqual(controls.movement,{forward:1,right:0});assert.equal(fire.dataset.active,'true');
 fire.pointer('pointerdown',3);assert.equal(callbacks.shots,1,'another finger cannot steal a held fire control');
 fire.pointer('pointermove',2,104,43);assert.deepEqual(callbacks.looks,[[14,-7]]);
 assert.deepEqual(controls.movement,{forward:1,right:0},'fire dragging preserves movement');
 fire.pointer('pointerup',2);assert.equal(fire.dataset.active,'false');assert.deepEqual(controls.movement,{forward:1,right:0});
 assert.equal(callbacks.releases,1,'synchronous lost capture does not duplicate release');assert.deepEqual(callbacks.cancellations,[false]);assert.equal(callbacks.resets,0);
 move.pointer('pointerup',1);assert.deepEqual(controls.movement,{forward:0,right:0});
 assert.equal(move.properties.get('--stick-y'),'0px');assert.equal(move.dataset.active,'false');
});

test('movement has a radial deadzone, preserves analog strength and clamps diagonal speed',()=>{
 const {move,controls}=fixture();move.pointer('pointerdown',1,54,50);
 assert.deepEqual(controls.movement,{forward:0,right:0});
 move.pointer('pointermove',1,72.4,50);close(controls.movement.right,.5);
 move.pointer('pointermove',1,90,10);close(Math.hypot(controls.movement.forward,controls.movement.right),1);
 close(controls.movement.forward,Math.SQRT1_2);close(controls.movement.right,Math.SQRT1_2);
 move.pointer('pointermove',1,50,50);assert.deepEqual(controls.movement,{forward:0,right:0});
});

test('holding Fire shoots once and stationary contact never turns the camera',()=>{
 const {fire,callbacks}=fixture();fire.pointer('pointerdown',1,90,50,'touch',0);
 for(let second=1;second<=60;second++)fire.pointer('pointermove',1,90,50,'touch',second*1000);
 fire.pointer('pointerdown',1,90,50,'touch',61000);
 assert.equal(callbacks.shots,1);assert.deepEqual(callbacks.looks,[]);
 fire.pointer('pointerup',1,90,50,'touch',62000);
 assert.equal(callbacks.shots,1,'releasing Fire does not shoot again');
 fire.pointer('pointerdown',2,90,50,'touch',63000);
 assert.equal(callbacks.shots,2,'a fresh press shoots once more');
});

test('Fire dragging uses the same pixel displacement and sensitivity as free look',()=>{
 const shot=fixture(),free=fixture();
 shot.controls.setSensitivity(.5);free.controls.setSensitivity(.5);
 shot.fire.pointer('pointerdown',1,90,50);free.look.pointer('pointerdown',1,90,50);
 for(const surface of [shot.fire,free.look]){
  surface.pointer('pointermove',2,800,900);
  surface.pointer('pointermove',1,110,45);
  surface.pointer('pointermove',1,100,75);
 }
 assert.deepEqual(shot.callbacks.looks,[[10,-2.5],[-5,15]]);
 assert.deepEqual(shot.callbacks.looks,free.callbacks.looks);
 assert.equal(shot.callbacks.shots,1);assert.equal(free.callbacks.shots,0);
 shot.controls.setSensitivity(2);shot.fire.pointer('pointermove',1,105,70);
 assert.deepEqual(shot.callbacks.looks[2],[10,-10]);
});

test('free look uses only its owning finger and can aim without firing while movement continues',()=>{
 const {move,look,fire,controls,callbacks}=fixture();move.pointer('pointerdown',1,50,10);look.pointer('pointerdown',2,100,120);
 look.pointer('pointermove',3,800,900);look.pointer('pointerup',3);
 look.pointer('pointermove',2,110,115);assert.deepEqual(callbacks.looks,[[10,-5]]);assert.equal(callbacks.shots,0);
 assert.deepEqual(controls.movement,{forward:1,right:0});assert.equal(fire.dataset.active,'false');
 fire.pointer('pointerdown',2);assert.equal(fire.dataset.active,'false','the same finger cannot own two surfaces');
 look.pointer('pointerup',2);look.pointer('pointermove',2,200,200);assert.equal(callbacks.looks.length,1);
 look.pointer('pointerdown',4,10,20,'pen');controls.setSensitivity(2);look.pointer('pointermove',4,15,25,'pen');
 assert.deepEqual(callbacks.looks[1],[10,10]);
});

test('crossing Fire during a free-look drag cannot shoot or take over the pointer',()=>{
 const {look,fire,callbacks}=fixture();look.pointer('pointerdown',1,10,20);
 look.pointer('pointermove',1,50,50);
 fire.pointer('pointerenter',1,50,50);fire.pointer('pointermove',1,55,60);
 assert.equal(callbacks.shots,0);assert.equal(fire.dataset.active,'false');
 assert.deepEqual(callbacks.looks,[[40,30]]);assert.equal(look.captured.has(1),true);
 look.pointer('pointermove',1,55,60);look.pointer('pointerup',1,55,60);
 assert.deepEqual(callbacks.looks,[[40,30],[5,10]]);assert.equal(callbacks.shots,0);
 fire.pointer('pointerdown',2,55,60);fire.pointer('pointermove',2,150,160);
 assert.equal(callbacks.shots,1,'only a fresh contact beginning on Fire shoots');
 assert.deepEqual(callbacks.looks[2],[95,100],'captured Fire drags can leave the button');
});

test('cancel and unexpected capture loss immediately stop only the affected input',()=>{
 for(const type of ['pointercancel','lostpointercapture']){
  const {move,fire,look,controls,callbacks}=fixture();
  move.pointer('pointerdown',1,50,10);fire.pointer('pointerdown',2,90,50);look.pointer('pointerdown',3);
  fire.pointer(type,2);assert.equal(fire.dataset.active,'false');assert.equal(callbacks.releases,1);assert.deepEqual(callbacks.cancellations,[true]);
  fire.pointer('pointermove',2,100,60);fire.pointer('pointerup',2);
  assert.equal(callbacks.looks.length,0);assert.equal(callbacks.shots,1);assert.equal(callbacks.releases,1);
  assert.deepEqual(controls.movement,{forward:1,right:0});
  move.pointer(type,1);assert.deepEqual(controls.movement,{forward:0,right:0});
  look.pointer(type,3);look.pointer('pointermove',3,75,75);assert.equal(callbacks.looks.length,0);
 }
});

test('disable clears every input and queued fire once, then requires fresh touches',()=>{
 const {move,fire,look,controls,callbacks}=fixture();
 move.pointer('pointerdown',1,50,10);fire.pointer('pointerdown',2,90,50);look.pointer('pointerdown',3);
 controls.setEnabled(false);assert.deepEqual(controls.movement,{forward:0,right:0});assert.equal(fire.dataset.active,'false');
 assert.equal(callbacks.resets,1);assert.equal(callbacks.releases,1);assert.deepEqual(callbacks.cancellations,[true]);assert.equal(move.captured.size+fire.captured.size+look.captured.size,0);
 controls.clear();controls.setEnabled(false);assert.equal(callbacks.resets,1);assert.equal(callbacks.releases,1);
 move.pointer('pointerdown',4,50,10);fire.pointer('pointerdown',5);assert.deepEqual(controls.movement,{forward:0,right:0});assert.equal(callbacks.shots,1);
 controls.setEnabled(true);move.pointer('pointermove',1,50,10);fire.pointer('pointermove',2,90,50);assert.equal(fire.dataset.active,'false');assert.deepEqual(callbacks.looks,[]);
 fire.pointer('pointerdown',6);assert.equal(callbacks.shots,2);assert.equal(fire.dataset.active,'true');
});

test('mouse events are not consumed or converted into touch input',()=>{
 const {move,fire,look,controls,callbacks}=fixture();
 for(const surface of [move,fire,look])assert.equal(surface.pointer('pointerdown',1,50,10,'mouse').defaultPrevented,false);
 assert.deepEqual(controls.movement,{forward:0,right:0});assert.equal(fire.dataset.active,'false');assert.equal(callbacks.shots,0);
 assert.equal(move.pointer('pointerdown',2,50,10).defaultPrevented,true);
});

test('repeated enabled state updates do not reset input or rewrite inactive pads',()=>{
 const {move,fire,controls,callbacks}=fixture();
 move.pointer('pointerdown',1,50,10);const activeWrites=move.writes+fire.writes;
 controls.setEnabled(true);controls.setEnabled(true);
 assert.deepEqual(controls.movement,{forward:1,right:0});assert.equal(move.writes+fire.writes,activeWrites);
 controls.setEnabled(false);const inactiveWrites=move.writes+fire.writes;
 for(let frame=0;frame<120;frame++)controls.setEnabled(false);
 assert.equal(move.writes+fire.writes,inactiveWrites);assert.equal(callbacks.resets,1);
});

test('a short stationary movement-stick tap jumps once on release while another finger fires',()=>{
 const {move,fire,controls,callbacks}=fixture();
 fire.pointer('pointerdown',2,90,50,'touch',90);
 move.pointer('pointerdown',1,50,50,'touch',100);
 assert.equal(callbacks.jumps,0,'jump waits for a confirmed tap');
 move.pointer('pointermove',1,54,53,'touch',180);
 move.pointer('pointerup',1,54,53,'touch',250);
 assert.equal(callbacks.jumps,1,'small finger jitter is allowed');
 assert.deepEqual(controls.movement,{forward:0,right:0});assert.equal(fire.dataset.active,'true');
 move.pointer('pointerup',1,54,53,'touch',260);fire.pointer('pointerup',2,90,50,'touch',270);
 assert.equal(callbacks.jumps,1,'duplicate release, capture loss, and fire release cannot jump');
});

test('movement drags and long holds never become a jump',()=>{
 for(const gesture of ['drag-return','release-displaced','hold']){
  const {move,callbacks}=fixture();
  move.pointer('pointerdown',1,50,50,'touch',100);
  if(gesture==='drag-return'){
   move.pointer('pointermove',1,50,10,'touch',150);
   move.pointer('pointermove',1,50,50,'touch',180);
  }
  move.pointer('pointerup',1,gesture==='release-displaced'?61:50,50,'touch',gesture==='hold'?351:200);
  assert.equal(callbacks.jumps,0,gesture);
 }
});

test('interrupted movement taps and releases from another finger cannot jump',()=>{
 for(const interruption of ['pointercancel','lostpointercapture','clear','disable']){
  const {move,controls,callbacks}=fixture();move.pointer('pointerdown',1,50,50,'touch',100);
  move.pointer('pointerup',2,50,50,'touch',150);assert.equal(callbacks.jumps,0,'foreign pointer cannot release a tap');
  if(interruption==='clear')controls.clear();
  else if(interruption==='disable')controls.setEnabled(false);
  else move.pointer(interruption,1,50,50,'touch',180);
  controls.setEnabled(true);move.pointer('pointerup',1,50,50,'touch',200);
  assert.equal(callbacks.jumps,0,interruption);
  move.pointer('pointerdown',3,50,50,'touch',300);move.pointer('pointerup',3,50,50,'touch',400);
  assert.equal(callbacks.jumps,1,'a fresh touch can jump after interruption');
 }
});
