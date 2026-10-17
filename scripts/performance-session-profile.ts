/** Local development instrumentation of the real main loop, UI and sound.
 * Open /scripts/performance-session-profile.html?visits=0 and click Run.
 * Six actors, real offline 120Hz simulation, fixed random seed after spawn. Player kept
 * spawn-safe and scripted to turn/fire; actual bots, events, HUD, audio/render.
 * The simulation follows wall time: runs are comparable, not deterministic replays.
 */
import {Game} from '../src/engine';
import {View} from '../src/renderer';
import {UI} from '../src/ui';
import {Sound} from '../src/audio';

let measuring=false;
const samples:Record<string,number[]>={simulation:[],renderer:[],hud:[],audioRouting:[],scriptedPlayerFire:[],frame:[]};
const longTasks:{start:number;duration:number}[]=[];
const routingHz=Number(new URLSearchParams(location.search).get('routingHz')??0);
const voiceCounts:number[]=[],audioStates:Record<string,number>={};let routingCalls=0,nextRoutingAt=0,audioClockStart:number|null=null,audioClockEnd:number|null=null,releases=0;
const originalRelease=(Sound.prototype as any).release;
(Sound.prototype as any).release=function(...args:unknown[]){if(measuring)releases++;return originalRelease.apply(this,args);};
const originalRouting=Sound.prototype.endSceneUpdate;
Sound.prototype.endSceneUpdate=function(){
 if(measuring){voiceCounts.push((this as any).voices.size);const state=this.ctx?.state??'uninitialized';audioStates[state]=(audioStates[state]??0)+1;if(this.ctx){audioClockStart??=this.ctx.currentTime;audioClockEnd=this.ctx.currentTime;}}
 if(routingHz>0){const now=performance.now(),period=1000/routingHz;if(now<nextRoutingAt){(this as any).updatingScene=false;return;}nextRoutingAt=now+period-(now-nextRoutingAt)%period;}
 if(measuring)routingCalls++;originalRouting.call(this);
};
try{new PerformanceObserver(list=>{if(measuring)for(const e of list.getEntries())longTasks.push({start:e.startTime,duration:e.duration});}).observe({type:'longtask',buffered:true});}catch{}
function wrap(target:any,key:string,label:string){const original=target[key];if(typeof original!=='function')return;target[key]=function(...args:unknown[]){if(!measuring)return original.apply(this,args);const start=performance.now();try{return original.apply(this,args);}finally{samples[label].push(performance.now()-start);}};}
wrap(Game.prototype,'update','simulation');wrap(View.prototype,'render','renderer');wrap(UI.prototype,'update','hud');wrap(Sound.prototype,'endSceneUpdate','audioRouting');
await import('../src/main');
const app=(window as any).__bolts as {game:Game;view:View;ui:UI;start:()=>void;leave:()=>void};
const panel=document.createElement('div');panel.style.cssText='position:fixed;top:5px;left:5px;z-index:20000;background:#17231fee;color:white;padding:12px;font:12px monospace;max-width:640px;max-height:65vh;overflow:auto;pointer-events:auto';
panel.innerHTML='<button id="profile-run">Run 30-second local session</button> <button id="profile-download" disabled>Download</button><p id="profile-status">Ready. Real main loop, six actors; this click requests audio. Clock progression is checked separately. Player spawn-safe; scripted turning and shooting.</p><pre id="profile-results"></pre>';document.body.append(panel);
const status=panel.querySelector<HTMLElement>('#profile-status')!,resultEl=panel.querySelector<HTMLElement>('#profile-results')!;
const runButton=panel.querySelector<HTMLButtonElement>('#profile-run')!,download=panel.querySelector<HTMLButtonElement>('#profile-download')!;
const stats=(values:number[])=>{const a=values.slice().sort((x,y)=>x-y),at=(p:number)=>a[Math.min(a.length-1,Math.floor(p*a.length))]??0;return{n:a.length,mean:a.reduce((x,y)=>x+y,0)/Math.max(1,a.length),p50:at(.5),p95:at(.95),p99:at(.99),max:a.at(-1)??0};};
let result:unknown;
runButton.onclick=()=>{
 runButton.disabled=download.disabled=true;
 const originalPreferences={...app.ui.prefs};
 Object.assign(app.ui.prefs,{quality:'medium',controlsMode:'mouse',faction:'british',difficulty:'regular',volume:.6});app.ui.settingsChanged();
 app.start();app.ui.selectLoadout();app.game.seed=51235;app.game.player.spawnSafe=600;
 const started=performance.now();let previous=started,lastShot=-1,lastReload=-1;
 const heapStart=(performance as any).memory?.usedJSHeapSize;
 const states:Record<string,number>={};
 let valid=!document.hidden;const visibility=()=>{if(document.hidden)valid=false;};document.addEventListener('visibilitychange',visibility);
 for(const a of Object.values(samples))a.length=0;longTasks.length=0;voiceCounts.length=0;routingCalls=0;nextRoutingAt=0;audioClockStart=audioClockEnd=null;releases=0;for(const key of Object.keys(audioStates))delete audioStates[key];
 function frame(now:number){
  const t=(now-started)/1000;const dt=now-previous;previous=now;
  if(t>=35){
   measuring=false;document.removeEventListener('visibilitychange',visibility);
   result={method:'Actual development main.ts loop; medium at native CSS viewport / DPR1, 5s warmup + 30s measured, singleplayer120Hz, real HUD/audio/effects/AI. British/regular/volume0.6. Scripted turning/fire/reload, resetting player spawnSafe after shots; no keyboard movement. Seed fixed after initial spawns. No network, GPU timer, or CPU throttle. Per-method samples are per-call, not per-frame. HUD covers UI.update only, audioRouting covers Sound.endSceneUpdate only, excluding event processing, voice creation, WebAudio DSP, other DOM updates and layout/paint.',valid:valid&&Object.keys(states).every(state=>state==='playing'),states,userAgent:navigator.userAgent,viewport:[innerWidth,innerHeight],drawingBuffer:[app.view.renderer.domElement.width,app.view.renderer.domElement.height],state:app.game.state,playerDeaths:app.game.player.deaths,actors:app.game.actors.length,simulationSeconds:app.game.time,measurementsMs:Object.fromEntries(Object.entries(samples).map(([key,a])=>[key,stats(a)])),longTasks,heapStartBytes:heapStart,heapEndBytes:(performance as any).memory?.usedJSHeapSize};
   const audioElapsed=audioClockStart!==null&&audioClockEnd!==null?audioClockEnd-audioClockStart:null;
   Object.assign(result as object,{audioDiagnostic:{routingHz:routingHz||'every frame',routingCalls,voices:stats(voiceCounts),contextStates:audioStates,audioClockStart,audioClockEnd,audioElapsedSeconds:audioElapsed,clockProgressValid:audioElapsed!==null&&audioElapsed>=28&&audioElapsed<=32,releases,note:routingHz?'Diagnostic spatial-control rate reduction only; acoustic equivalence not validated. New voice initial placement still runs immediately.':'Observed original update cadence.'}});
   resultEl.textContent=JSON.stringify(result,null,2);void fetch('/__performance-results/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(result)}).catch(()=>{});status.textContent='Complete';runButton.disabled=download.disabled=false;app.leave();Object.assign(app.ui.prefs,originalPreferences);app.ui.save();app.ui.settingsChanged();return;
  }
  if(t>=5){if(measuring)samples.frame.push(dt);measuring=true;states[app.game.state]=(states[app.game.state]??0)+1;}
  app.game.player.yaw=Math.sin(t*.22)*1.8;app.game.player.pitch=Math.sin(t*.35)*.035;
  const shot=Math.floor(t/1.4),reload=Math.floor(t/9);
  if(shot!==lastShot){lastShot=shot;const before=performance.now();app.game.fire(app.game.player);if(measuring)samples.scriptedPlayerFire.push(performance.now()-before);}
  if(reload!==lastReload){lastReload=reload;if(t>1)app.game.reload();}
  app.game.player.spawnSafe=600;
  if(Math.floor(t)!==Math.floor(t-dt/1000))status.textContent=`Profiling ${Math.floor(t)} / 35 s · state ${app.game.state}`;
  requestAnimationFrame(frame);
 }requestAnimationFrame(frame);
};
download.onclick=()=>{const url=URL.createObjectURL(new Blob([JSON.stringify(result,null,2)],{type:'application/json'}));const link=document.createElement('a');link.href=url;link.download='bolts-session-profile.json';link.click();URL.revokeObjectURL(url);};
