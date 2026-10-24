import test from 'node:test';
import assert from 'node:assert/strict';
import {UI} from '../src/ui.ts';

class Element {
 children:Element[]=[];dataset:Record<string,string>={};textContent='';disabled=false;classes=new Set<string>();attributes=new Map<string,string>();
 classList={add:(...names:string[])=>names.forEach(name=>this.classes.add(name)),remove:(...names:string[])=>names.forEach(name=>this.classes.delete(name)),toggle:(name:string,force:boolean)=>{if(force)this.classes.add(name);else this.classes.delete(name);}};
 constructor(readonly tag='div'){}
 append(...children:Element[]){this.children.push(...children);}
 replaceChildren(){this.children=[];}
 setAttribute(name:string,value:string){this.attributes.set(name,value);}
 querySelectorAll(selector:string):Element[]{return this.children.flatMap(child=>[...(selector==='button'&&child.tag==='button'?[child]:[]),...child.querySelectorAll(selector)]);}
 querySelector(selector:string){return this.querySelectorAll(selector)[0]??null;}
 focus(){}
}

test('loading and connection failures retain idle-city rows until a directory explicitly removes them',()=>{
 const previous=Object.getOwnPropertyDescriptor(globalThis,'document');
 Object.defineProperty(globalThis,'document',{configurable:true,value:{activeElement:null,createElement:(tag:string)=>new Element(tag),createTextNode:(text:string)=>Object.assign(new Element('text'),{textContent:text})}});
 try{
  const ui=Object.create(UI.prototype) as UI,el=Object.fromEntries(['menu','menu-main','selection-window','lobby-window','lobby-rows','lobby-refresh','lobby-join','lobby-status'].map(id=>[id,new Element()]));
  Object.assign(ui,{el,lobbyLocations:[],lobbyRows:[],selectedLobby:'',lobbyBusy:false,lobbyOpen:false,refreshOnlineCountVisibility(){}});
  ui.showLobbies([],'',['lon','sg','sp']);const choices=()=>el['lobby-rows'].children.map(row=>row.dataset.lobby);
  assert.deepEqual(choices(),['new:lon','new:sg','new:sp']);assert.equal(el['lobby-join'].disabled,false);
  for(const status of ['Connection lost.','Loading…','Unable to load servers.']){
   ui.showLobbies([],status);assert.deepEqual(choices(),['new:lon','new:sg','new:sp']);assert.equal(el['lobby-join'].disabled,false);
  }
  ui.showLobbies([],'',[]);assert.deepEqual(choices(),[]);assert.equal(el['lobby-join'].disabled,true);
 }finally{if(previous)Object.defineProperty(globalThis,'document',previous);else delete (globalThis as any).document;}
});
