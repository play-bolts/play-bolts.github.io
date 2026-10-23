import test from 'node:test';
import assert from 'node:assert/strict';
import {startBackgroundGame,type PreparedGame} from '../src/startup.ts';
import type {UI} from '../src/ui.ts';

function deferred<T>(){let resolve!:(value:T)=>void,reject!:(reason:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
function fixture(){
 const events:string[]=[],listeners=new Set<unknown>(),paint=deferred<void>(),loaded=deferred<void>();
 const classes=new Set(['hidden']);
 const ui={
  ready:false,selectionOpen:false,lobbyOpen:false,modalOpen:false,busy:false,progress:null as number|null,status:'',
  el:{'load-error':{innerHTML:'',classList:{contains:(name:string)=>classes.has(name),remove:(name:string)=>classes.delete(name)}}},
  start:()=>{},multiplayer:()=>{},selectLoadout:()=>{},selectSpectator:()=>{},cancelSelection:()=>{},lobbyBack:()=>{},
  openSelection(){this.selectionOpen=true;events.push('selection');},
  showLobbies(_rows:unknown[],status:string){this.lobbyOpen=true;this.status=status;events.push('lobbies');},
  showMenu(){this.selectionOpen=this.lobbyOpen=this.busy=false;events.push('menu');},
  setReady(ready:boolean,complete:boolean){this.ready=ready;assert.equal(complete,false);},
  setStartupProgress(value:number|null){this.progress=value;},
  setSelectionBusy(value:boolean){this.busy=value;},setSelectionStatus(value:string){this.status=value;},
  handleModalKey(){},closeModal(){this.modalOpen=false;},handleMenuKey(){},hideLoading(){},
 };
 const game:PreparedGame={start:()=>events.push('start'),multiplayer:()=>events.push('multiplayer'),selectLoadout:()=>events.push('loadout'),selectSpectator:()=>events.push('spectator'),cancelSelection:()=>events.push('cancel-runtime')};
 const previous=Object.getOwnPropertyDescriptor(globalThis,'document');
 Object.defineProperty(globalThis,'document',{configurable:true,value:{addEventListener:(_name:string,listener:unknown)=>listeners.add(listener),removeEventListener:(_name:string,listener:unknown)=>listeners.delete(listener)}});
 let requests=0;
 const loading=startBackgroundGame(ui as unknown as UI,async()=>{requests++;await loaded.promise;Object.assign(ui,game);return game;},()=>paint.promise);
 return {ui,game,events,listeners,paint,loaded,loading,requests:()=>requests,errorClasses:classes,restore(){if(previous)Object.defineProperty(globalThis,'document',previous);else Reflect.deleteProperty(globalThis,'document');}};
}

test('menu and team choice work before runtime download; queued choice waits for preparation',async()=>{
 const f=fixture();try{
  assert.equal(f.ui.ready,true);assert.equal(f.requests(),0,'download cannot precede the first menu paint');assert.equal(f.ui.progress,0);
  f.ui.start();f.ui.selectLoadout();assert.equal(f.ui.selectionOpen,true);assert.equal(f.ui.busy,true);assert.deepEqual(f.events,['selection']);
  f.paint.resolve();await Promise.resolve();assert.equal(f.requests(),1);assert.deepEqual(f.events,['selection'],'asset stall cannot enter gameplay');
  f.loaded.resolve();await f.loading;assert.deepEqual(f.events,['selection','start','loadout']);assert.equal(f.ui.progress,null);assert.equal(f.listeners.size,0);
 }finally{f.restore();}
});

test('cancelling a queued early game never starts it when assets finish',async()=>{
 const f=fixture();try{
  f.ui.start();f.ui.selectSpectator();f.ui.cancelSelection();f.paint.resolve();f.loaded.resolve();await f.loading;
  assert.deepEqual(f.events,['selection','menu']);assert.equal(f.ui.start,f.game.start);assert.equal(f.ui.selectLoadout,f.game.selectLoadout);
 }finally{f.restore();}
});

test('preparation finishing preserves early selection and options until the next user choice',async()=>{
 const f=fixture();try{
  f.ui.start();f.ui.modalOpen=true;f.paint.resolve();f.loaded.resolve();await f.loading;
  assert.deepEqual(f.events,['selection']);assert.equal(f.ui.modalOpen,true);
  f.ui.selectSpectator();assert.deepEqual(f.events,['selection','start','spectator']);assert.equal(f.ui.selectLoadout,f.game.selectLoadout);assert.equal(f.ui.cancelSelection,f.game.cancelSelection);
 }finally{f.restore();}
});

test('cancelling selection after preparation restores ordinary runtime actions',async()=>{
 const f=fixture();try{
  f.ui.start();f.paint.resolve();f.loaded.resolve();await f.loading;f.ui.cancelSelection();
  assert.deepEqual(f.events,['selection','menu']);assert.equal(f.ui.selectLoadout,f.game.selectLoadout);
  f.ui.start();assert.deepEqual(f.events,['selection','menu','start']);
 }finally{f.restore();}
});

test('multiplayer request continues after preparation but returning to menu cancels it',async()=>{
 for(const cancel of [false,true]){
  const f=fixture();try{
   f.ui.multiplayer();if(cancel)f.ui.lobbyBack();f.paint.resolve();f.loaded.resolve();await f.loading;
   assert.deepEqual(f.events,cancel?['lobbies','menu']:['lobbies','multiplayer']);
  }finally{f.restore();}
 }
});

test('failed runtime import shows retry UI and removes bootstrap keyboard handling',async()=>{
 const f=fixture();try{
  const rejected=assert.rejects(f.loading,/download failed/);f.paint.resolve();f.loaded.reject(new Error('download failed'));await rejected;
  assert.equal(f.errorClasses.has('hidden'),false);assert.match(f.ui.el['load-error'].innerHTML,/Retry/);assert.equal(f.ui.progress,null);assert.equal(f.listeners.size,0);
 }finally{f.restore();}
});
