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
 pointer(type:string,pointerId:number,x=50,y=50,pointerType='touch'){
  const event=new Event(type,{cancelable:true});
  Object.assign(event,{pointerId,clientX:x,clientY:y,pointerType});
  this.dispatchEvent(event);return event;
 }
}
function fixture(){
 const move=new Surface(),fire=new Surface(),look=new Surface();
 const callbacks={shots:0,releases:0,cancellations:[] as boolean[],resets:0,looks:[] as [number,number][]};
 const controls=new TouchControls({move:move as unknown as HTMLElement,fire:fire as unknown as HTMLElement,look:look as unknown as HTMLElement},{
  look:(dx,dy)=>callbacks.looks.push([dx,dy]),fire:()=>callbacks.shots++,fireReleased:cancelled=>{callbacks.releases++;callbacks.cancellations.push(cancelled);},reset:()=>callbacks.resets++,
 });
 controls.setEnabled(true);return {move,fire,look,controls,callbacks};
}
const close=(actual:number,expected:number)=>assert.ok(Math.abs(actual-expected)<1e-9,`${actual} should equal ${expected}`);

test('independent fingers own movement and fire until each owner releases',()=>{
 const {move,fire,controls,callbacks}=fixture();
 move.pointer('pointerdown',1,50,10);fire.pointer('pointerdown',2,90,50);
 assert.deepEqual(controls.movement,{forward:1,right:0});assert.equal(controls.firing,true);assert.equal(callbacks.shots,1);
 move.pointer('pointermove',2,10,50);move.pointer('pointerup',2);fire.pointer('pointerup',1);
 assert.deepEqual(controls.movement,{forward:1,right:0});assert.equal(controls.firing,true);
 fire.pointer('pointerdown',3);assert.equal(callbacks.shots,1,'another finger cannot steal a held fire stick');
 fire.pointer('pointerup',2);assert.equal(controls.firing,false);assert.deepEqual(controls.movement,{forward:1,right:0});
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

test('right stick look depends on elapsed time and holding fire does not repeat the tap callback',()=>{
 const one=fixture(),many=fixture();one.fire.pointer('pointerdown',1,90,50);many.fire.pointer('pointerdown',1,90,50);
 one.controls.update(1);for(let frame=0;frame<60;frame++)many.controls.update(1/60);
 close(one.callbacks.looks[0][0],850);close(many.callbacks.looks.reduce((sum,[dx])=>sum+dx,0),850);
 assert.equal(one.callbacks.shots,1);assert.equal(many.callbacks.shots,1);
 one.controls.setSensitivity(.5);one.controls.update(.1);close(one.callbacks.looks[1][0],42.5);
 const count=one.callbacks.looks.length;one.controls.update(NaN);one.controls.update(-1);one.controls.update(0);assert.equal(one.callbacks.looks.length,count);
});

test('free look uses only its owning finger and can aim without firing while movement continues',()=>{
 const {move,look,fire,controls,callbacks}=fixture();move.pointer('pointerdown',1,50,10);look.pointer('pointerdown',2,100,120);
 look.pointer('pointermove',3,800,900);look.pointer('pointerup',3);
 look.pointer('pointermove',2,110,115);assert.deepEqual(callbacks.looks,[[10,-5]]);assert.equal(callbacks.shots,0);
 assert.deepEqual(controls.movement,{forward:1,right:0});assert.equal(controls.firing,false);
 fire.pointer('pointerdown',2);assert.equal(controls.firing,false,'the same finger cannot own two surfaces');
 look.pointer('pointerup',2);look.pointer('pointermove',2,200,200);assert.equal(callbacks.looks.length,1);
 look.pointer('pointerdown',4,10,20,'pen');controls.setSensitivity(2);look.pointer('pointermove',4,15,25,'pen');
 assert.deepEqual(callbacks.looks[1],[10,10]);
});

test('cancel and unexpected capture loss immediately stop only the affected input',()=>{
 for(const type of ['pointercancel','lostpointercapture']){
  const {move,fire,look,controls,callbacks}=fixture();
  move.pointer('pointerdown',1,50,10);fire.pointer('pointerdown',2,90,50);look.pointer('pointerdown',3);
  fire.pointer(type,2);assert.equal(controls.firing,false);assert.equal(callbacks.releases,1);assert.deepEqual(callbacks.cancellations,[true]);
  controls.update(.1);assert.equal(callbacks.looks.length,0);
  assert.deepEqual(controls.movement,{forward:1,right:0});
  move.pointer(type,1);assert.deepEqual(controls.movement,{forward:0,right:0});
  look.pointer(type,3);look.pointer('pointermove',3,75,75);assert.equal(callbacks.looks.length,0);
 }
});

test('disable clears every input and queued fire once, then requires fresh touches',()=>{
 const {move,fire,look,controls,callbacks}=fixture();
 move.pointer('pointerdown',1,50,10);fire.pointer('pointerdown',2,90,50);look.pointer('pointerdown',3);
 controls.setEnabled(false);assert.deepEqual(controls.movement,{forward:0,right:0});assert.equal(controls.firing,false);
 assert.equal(callbacks.resets,1);assert.equal(callbacks.releases,1);assert.deepEqual(callbacks.cancellations,[true]);assert.equal(move.captured.size+fire.captured.size+look.captured.size,0);
 controls.clear();controls.setEnabled(false);assert.equal(callbacks.resets,1);assert.equal(callbacks.releases,1);
 move.pointer('pointerdown',4,50,10);fire.pointer('pointerdown',5);assert.deepEqual(controls.movement,{forward:0,right:0});assert.equal(callbacks.shots,1);
 controls.setEnabled(true);move.pointer('pointermove',1,50,10);fire.pointer('pointermove',2,90,50);assert.equal(controls.firing,false);
 fire.pointer('pointerdown',6);assert.equal(callbacks.shots,2);assert.equal(controls.firing,true);
});

test('mouse events are not consumed or converted into touch input',()=>{
 const {move,fire,look,controls,callbacks}=fixture();
 for(const surface of [move,fire,look])assert.equal(surface.pointer('pointerdown',1,50,10,'mouse').defaultPrevented,false);
 assert.deepEqual(controls.movement,{forward:0,right:0});assert.equal(controls.firing,false);assert.equal(callbacks.shots,0);
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
