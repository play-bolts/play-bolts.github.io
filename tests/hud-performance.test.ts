import test from 'node:test';
import assert from 'node:assert/strict';
import {UI} from '../src/ui.ts';
import {HudMarkup} from '../src/hudUpdates.ts';
import {Game,createActor} from '../src/engine.ts';

/** Count actual DOM mutations, not just markup comparisons. */
class Element {
 private text='';private html='';writes=0;children:Element[]=[];parentElement:Element|null=null;
 classes=new Set<string>();values=new Map<string,string>();
 classList={contains:(key:string)=>this.classes.has(key),toggle:(key:string,on:boolean)=>{this.writes++;if(on)this.classes.add(key);else this.classes.delete(key);}};
 style={getPropertyValue:(key:string)=>this.values.get(key)??'',setProperty:(key:string,value:string)=>{this.writes++;this.values.set(key,value);}};
 get textContent(){return this.text;}set textContent(value:string){this.writes++;this.text=value;}
 get innerHTML(){return this.html;}set innerHTML(value:string){this.writes++;this.html=value;this.children=[...value.matchAll(/<i><\/i>/g)].map(()=>new Element());}
}
function fixture(){
 const ids=['hud','spectator-status','spectator-help','open-team','open-weapon','pause','scoreboard','killcam','killer-name','skip-killcam','respawn-wait','crosshair','damage-flash','hit-confirm','kill-message','spawn-protection','compass-rose','status-message','chat-log','match-clock','score-time','ammo','reserve','health','health-fill','round-icons','weapon-slot','killfeed','score-rows','score-close','end-actions','again','score-title','score-winner'];
 const el=Object.fromEntries(ids.map(id=>[id,new Element()]));el.ammo.parentElement=new Element();
 const ui=Object.create(UI.prototype) as UI;
 Object.assign(ui,{el,hudMarkup:new HudMarkup(),online:true,feed:[],lastHud:0,damageStarted:-Infinity,damageLethal:false,hitUntil:0,killUntil:0,scoreHeld:true,modalOpen:false,selectionOpen:false,chatOpen:false});
 const game=new Game();game.state='playing';game.actors=[createActor(0,'british','Local'),createActor(1,'german','Remote')];
 const writes=()=>Object.values(el).reduce((total,e)=>total+e.writes+e.children.reduce((n,c)=>n+c.writes,0),el.ammo.parentElement!.writes);
 return{ui,game,el,writes};
}

test('the completed online killcam shows a respawn wait message until gameplay resumes',()=>{
 const window=Object.getOwnPropertyDescriptor(globalThis,'window');Object.defineProperty(globalThis,'window',{configurable:true,value:{innerHeight:900}});
 try{
  const {ui,game,el}=fixture();game.player.alive=false;game.state='killcam';ui.update(game);
  assert.equal(el['skip-killcam'].classes.has('hidden'),false);assert.equal(el['respawn-wait'].classes.has('hidden'),true);
  ui.update(game,true);assert.equal(el.killcam.classes.has('hidden'),false);assert.equal(el.hud.classes.has('killcam-active'),true);
  assert.equal(el['skip-killcam'].classes.has('hidden'),true);assert.equal(el['respawn-wait'].classes.has('hidden'),false);
  game.player.alive=true;game.state='playing';ui.update(game);
  assert.equal(el.killcam.classes.has('hidden'),true);assert.equal(el.hud.classes.has('killcam-active'),false);assert.equal(el['respawn-wait'].classes.has('hidden'),true);
 }finally{if(window)Object.defineProperty(globalThis,'window',window);else Reflect.deleteProperty(globalThis,'window');}
});

test('unchanged HUD retains ammo, weapon, feed and scoreboard nodes without DOM mutations',()=>{
 const now=Object.getOwnPropertyDescriptor(globalThis,'performance'),window=Object.getOwnPropertyDescriptor(globalThis,'window');let clock=1000;
 Object.defineProperty(globalThis,'performance',{configurable:true,value:{now:()=>clock}});Object.defineProperty(globalThis,'window',{configurable:true,value:{innerHeight:900}});
 try{
  const {ui,game,el,writes}=fixture();ui.feed.push({text:'Local → Remote',time:1000});ui.update(game);
  const rounds=el['round-icons'].children.slice(),before=writes(),html=el['score-rows'].innerHTML;
  for(let i=0;i<20;i++){clock+=100;ui.update(game);}
  assert.equal(writes(),before,'stationary HUD does not mutate DOM at 10 Hz or frame rate');assert.deepEqual(el['round-icons'].children,rounds);assert.equal(el['score-rows'].innerHTML,html);
  game.player.ammo--;clock+=100;ui.update(game);assert.deepEqual(el['round-icons'].children,rounds,'firing preserves cartridge nodes');assert.equal(rounds.at(-1)!.classes.has('loaded'),false);assert.equal(el.ammo.textContent,'9');
  game.actors[1].kills++;game.actors[1].ping=23;clock+=100;ui.update(game);assert.notEqual(el['score-rows'].innerHTML,html);assert.match(el['score-rows'].innerHTML,/>23<\/td>/);
  game.player.faction='german';clock+=100;ui.update(game);assert.equal(el['round-icons'].children.length,5);assert.match(el['weapon-slot'].innerHTML,/Kar98k/);
  clock=7501;ui.update(game);assert.equal(el.killfeed.innerHTML,'','kill feed expires on its original schedule');
 }finally{if(now)Object.defineProperty(globalThis,'performance',now);if(window)Object.defineProperty(globalThis,'window',window);else delete(globalThis as any).window;}
});

test('crosshair, compass, damage fade and visibility still update between stats ticks',()=>{
 const now=Object.getOwnPropertyDescriptor(globalThis,'performance'),window=Object.getOwnPropertyDescriptor(globalThis,'window');let clock=1000;
 Object.defineProperty(globalThis,'performance',{configurable:true,value:{now:()=>clock}});Object.defineProperty(globalThis,'window',{configurable:true,value:{innerHeight:900}});
 try{
  const {ui,game,el}=fixture();ui.damageStarted=950;ui.update(game);
  const spread=el.crosshair.values.get('--spread'),flash=el['damage-flash'].values.get('opacity');
  clock+=16;game.player.yaw=.3;game.playerHipSpread*=1.2;game.player.ammo=4;ui.update(game);
  assert.notEqual(el.crosshair.values.get('--spread'),spread);assert.notEqual(el['damage-flash'].values.get('opacity'),flash);assert.notEqual(el['compass-rose'].values.get('transform'),'rotate(0deg)');assert.equal(el.ammo.textContent,'10','stats keep their original 10 Hz cadence');
  clock+=16;game.player.grounded=false;ui.update(game);assert.ok(el.crosshair.classes.has('hidden'),'jump visibility updates immediately');
 }finally{if(now)Object.defineProperty(globalThis,'performance',now);if(window)Object.defineProperty(globalThis,'window',window);else delete(globalThis as any).window;}
});
