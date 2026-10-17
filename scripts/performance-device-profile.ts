/** Run with npm run dev, open /scripts/performance-device-profile.html.
 * Intentionally outside src and excluded from the shipped application.
 * Renderer/effects A/B experiments: no UI, audio, network, or AI in timed loop.
 * No alleged hardware emulation. All results identify the actual GPU/browser.
 */
import * as THREE from 'three';
import {View} from '../src/renderer';
import {Game,createActor,type Shot} from '../src/engine';
import {FACTIONS,WEAPONS} from '../src/config';
import {loadHandAssets} from '../src/hands';
import {preloadHumanHead} from '../src/humanHead';
import {preloadSoldierMaterials} from '../src/soldier';
import {preloadModelDetails} from '../src/modelDetails';
import {preloadImportedWeapons} from '../src/importedWeapons';
import {preloadSurfaceAssets} from '../src/materials';

const progress=document.querySelector<HTMLElement>('#progress')!;
const output=document.querySelector<HTMLElement>('#results')!;
const summaryOutput=document.querySelector<HTMLElement>('#summary')!;
const buttons=Array.from(document.querySelectorAll<HTMLButtonElement>('button'));
const boot=performance.now(),startup:Record<string,number>={moduleStartAfterNavigationMs:boot};
const longTasks:{start:number;duration:number}[]=[];
try{new PerformanceObserver(list=>{for(const entry of list.getEntries())longTasks.push({start:entry.startTime,duration:entry.duration});}).observe({type:'longtask',buffered:true});}catch{}
const renderer=new THREE.WebGLRenderer({antialias:true,powerPreference:'high-performance'});
startup.contextMs=performance.now()-boot;
await Promise.all(Object.entries({hands:loadHandAssets,head:preloadHumanHead,soldierMaterials:preloadSoldierMaterials,details:preloadModelDetails,weapons:preloadImportedWeapons,surfaces:()=>preloadSurfaceAssets(renderer)}).map(async([name,load])=>{const start=performance.now();await load();startup[name+'Ms']=performance.now()-start;}));
startup.assetsReadyMs=performance.now()-boot;
const constructionStart=performance.now();
const view=new View(document.querySelector<HTMLElement>('#world')!,renderer);
startup.viewConstructionMs=performance.now()-constructionStart;
const prepStart=performance.now();await view.prepare();startup.prepareMs=performance.now()-prepStart;
const game=new Game();
game.actors=Array.from({length:6},(_,i)=>Object.assign(createActor(i,FACTIONS[i%3],`Benchmark ${i}`),{renderIdentity:`profile:${i}`}));
game.state='playing';view.setupActors(game);startup.postModuleReadyMs=performance.now()-boot;startup.navigationReadyMs=performance.now();
renderer.info.autoReset=false;
const gl=renderer.getContext() as WebGL2RenderingContext;
const timer=gl.getExtension('EXT_disjoint_timer_query_webgl2');
const debug=gl.getExtension('WEBGL_debug_renderer_info');
const stats=(values:number[])=>{const sorted=values.slice().sort((a,b)=>a-b);const at=(p:number)=>sorted[Math.min(sorted.length-1,Math.floor(sorted.length*p))]??0;return{n:values.length,mean:values.reduce((a,b)=>a+b,0)/Math.max(1,values.length),p50:at(.5),p95:at(.95),p99:at(.99),max:sorted.at(-1)??0};};
const resources=performance.getEntriesByType('resource').map(entry=>{const r=entry as PerformanceResourceTiming;return{path:new URL(r.name).pathname,duration:r.duration,transferBytes:r.transferSize,encodedBytes:r.encodedBodySize,decodedBytes:r.decodedBodySize};});
const report:any={method:'Deterministic six-actor renderer/effects only. 3s warmup + 9s measured per scenario. Pixel workloads, not device emulation. CPU times include submission, not GPU completion. Timer queries asynchronous. Cold startup is loopback development build with unknown browser disk-cache state. Effects, poses and camera repeat with identical elapsed-time script.',createdAt:new Date().toISOString(),environment:{userAgent:navigator.userAgent,hardwareConcurrency:navigator.hardwareConcurrency,deviceMemory:(navigator as any).deviceMemory,dpr:devicePixelRatio,renderer:debug?gl.getParameter(debug.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER),vendor:debug?gl.getParameter(debug.UNMASKED_VENDOR_WEBGL):gl.getParameter(gl.VENDOR),antialias:gl.getContextAttributes()?.antialias,gpuTimers:!!timer,extensions:gl.getSupportedExtensions()},startup,resources,startupLongTasks:longTasks.slice(),runs:[]};
type Scenario={name:string;width:number;height:number;ratio:number;quality:'high'|'medium'|'low';worldSize?:number;worldShadow?:boolean;weaponShadow?:boolean;freezeWorld?:boolean;hideSoldiers?:boolean};
const desktop={width:1280,height:720,ratio:1,quality:'medium' as const};
const scenarios:Scenario[]=[
 {name:'desktop-high-1.75',...desktop,quality:'high',ratio:1.75},
 {name:'desktop-high-1.5',...desktop,quality:'high',ratio:1.5},
 {name:'desktop-high-1',...desktop,quality:'high'},
 {name:'desktop-medium',...desktop},
 {name:'medium-world1024',...desktop,worldSize:1024},
 {name:'medium-world512',...desktop,worldSize:512},
 {name:'medium-no-world-shadow',...desktop,worldShadow:false},
 {name:'medium-no-weapon-shadow',...desktop,weaponShadow:false},
 {name:'medium-frozen-world-shadow-diagnostic',...desktop,freezeWorld:true},
 {name:'medium-no-soldiers-diagnostic',...desktop,hideSoldiers:true},
 {name:'desktop-low',...desktop,quality:'low'},
 {name:'phone-pixels-medium',...desktop,width:844,height:390},
 {name:'phone-pixels-medium-0.75',...desktop,width:844,height:390,ratio:.75},
 {name:'phone-pixels-medium-world1024',...desktop,width:844,height:390,worldSize:1024},
 {name:'phone-pixels-low',...desktop,width:844,height:390,quality:'low'},
 {name:'desktop-medium-repeat',...desktop},
];
function setShadowSize(light:THREE.DirectionalLight,size:number){if(light.shadow.mapSize.x!==size){light.shadow.map?.dispose();light.shadow.map=null;light.shadow.mapSize.set(size,size);}light.shadow.needsUpdate=true;}
function configure(s:Scenario){
 view.setQuality(s.quality);renderer.setPixelRatio(s.ratio);renderer.setSize(s.width,s.height,false);
 view.camera.aspect=view.weaponCamera.aspect=s.width/s.height;view.camera.updateProjectionMatrix();view.weaponCamera.updateProjectionMatrix();
 view.worldSun.castShadow=s.worldShadow!==false;view.weaponSun.castShadow=s.weaponShadow!==false;
 setShadowSize(view.worldSun,s.worldSize??2048);setShadowSize(view.weaponSun,s.quality==='high'?2048:1024);
 for(const a of game.actors)a.spectator=!!s.hideSoldiers&&a.id!==0;
 view.clearEffects();
}
function sample(t:number){
 game.time=t;game.remaining=300-t;
 for(const actor of game.actors){const i=actor.id,phase=(t+i*.7)%8;
  actor.x=i===0?0:(i-3)*2.5+Math.sin(t*.7+i)*.8;actor.z=i===0?-13:-5+(i%2)*5;actor.y=0;actor.yaw=i===0?Math.sin(t*.3)*.16:Math.PI+Math.sin(t*.6+i)*.5;actor.pitch=0;
  actor.moving=i===0?0:2.1;actor.stance=phase>5&&phase<7?'crouch':'stand';actor.eyeHeight=actor.stance==='crouch'?1.1:1.65;actor.ads=i===0&&phase>2&&phase<4;actor.reload=phase>4&&phase<6?6-phase:0;actor.reloadTotal=2;actor.lean=Math.sin(t+i)*.3;
  actor.lastShotTime=Math.floor((t+i*.2)/1.4)*1.4-i*.2;actor.recoil=Math.max(0,.06-(t-actor.lastShotTime)*.2);actor.cooldown=Math.max(0,WEAPONS[actor.faction].cycle-(t-actor.lastShotTime));
 }
}
let busy=false;
async function run(s:Scenario){
 configure(s);let start=0,previous=0,lastShot=-1,valid=!document.hidden,frameWorld=0,frameWeapon=0;
 const samples:Record<string,number[]>={frame:[],cpu:[],presentationCpu:[],worldSubmissionCpu:[],weaponSubmissionCpu:[],gpu:[],drawCalls:[],triangles:[]};
 const pending:WebGLQuery[]=[];let disjoints=0;
 const visibility=()=>{if(document.hidden)valid=false;},resize=()=>{valid=false;};document.addEventListener('visibilitychange',visibility);window.addEventListener('resize',resize);
 const originalRender=renderer.render;
 renderer.render=function(scene,camera){
  if(scene===view.scene&&s.freezeWorld&&start&&performance.now()-start>2500)view.worldSun.shadow.needsUpdate=false;
  const before=performance.now();originalRender.call(this,scene,camera);const elapsed=performance.now()-before;
  if(scene===view.scene)frameWorld+=elapsed;else frameWeapon+=elapsed;
 };
 const longTaskStart=longTasks.length;
 try{
  await new Promise<void>(resolve=>{
   function frame(now:number){
    if(!start)start=previous=now;const elapsed=now-start,t=elapsed/1000,dt=(now-previous)/1000;previous=now;
    if(elapsed>=12000){resolve();return;}
    sample(t);renderer.info.reset();frameWorld=frameWeapon=0;const before=performance.now();
    const shotIndex=Math.floor(t*3);if(shotIndex!==lastShot){lastShot=shotIndex;const actor=game.actors[shotIndex%6];const shot:Shot={time:t,actor:actor.id,origin:{x:actor.x,y:1.4,z:actor.z},end:{x:actor.x+1,y:1.2,z:actor.z+3},hit:shotIndex%2?null:1,headshot:false,kind:'shot'};view.effect(shot,actor.id===0);}
    let q:WebGLQuery|null=null;if(timer&&pending.length<8){q=gl.createQuery();if(q)gl.beginQuery(timer.TIME_ELAPSED_EXT,q);}
    view.render(game,dt,false,true);
    if(q){gl.endQuery(timer.TIME_ELAPSED_EXT);if(elapsed>=3000)pending.push(q);else gl.deleteQuery(q);}
    const cpu=performance.now()-before;
    if(elapsed>=3000){samples.frame.push(dt*1000);samples.cpu.push(cpu);samples.presentationCpu.push(cpu-frameWorld-frameWeapon);samples.worldSubmissionCpu.push(frameWorld);samples.weaponSubmissionCpu.push(frameWeapon);samples.drawCalls.push(renderer.info.render.calls);samples.triangles.push(renderer.info.render.triangles);}
    if(timer){const disjoint=gl.getParameter(timer.GPU_DISJOINT_EXT);if(disjoint){disjoints++;for(const query of pending)gl.deleteQuery(query);pending.length=0;}else while(pending.length&&gl.getQueryParameter(pending[0],gl.QUERY_RESULT_AVAILABLE)){const query=pending.shift()!;samples.gpu.push(Number(gl.getQueryParameter(query,gl.QUERY_RESULT))/1e6);gl.deleteQuery(query);}}
    if(Math.floor(elapsed/500)!==Math.floor((elapsed-dt*1000)/500))progress.textContent=`${s.name}: ${(elapsed/1000).toFixed(0)} / 12 seconds (${report.runs.length} completed)`;
    requestAnimationFrame(frame);
   }requestAnimationFrame(frame);
  });
 }finally{renderer.render=originalRender;document.removeEventListener('visibilitychange',visibility);window.removeEventListener('resize',resize);for(const q of pending)gl.deleteQuery(q);}
 const result={scenario:s,valid,disjoints,drawingBuffer:[gl.drawingBufferWidth,gl.drawingBufferHeight],metrics:Object.fromEntries(Object.entries(samples).map(([name,values])=>[name,stats(values)])),over16_7ms:samples.frame.filter(v=>v>16.7).length/samples.frame.length,over33_4ms:samples.frame.filter(v=>v>33.4).length/samples.frame.length,memory:{...renderer.info.memory,programs:renderer.info.programs?.length,jsHeapBytes:(performance as any).memory?.usedJSHeapSize},longTasks:longTasks.slice(longTaskStart)};
 report.runs.push(result);publish();
}
function publish(){
 output.textContent=JSON.stringify(report,null,2);
 void fetch('/__performance-results/renderer',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(report)}).catch(()=>{});
 summaryOutput.textContent=report.runs.map((r:any)=>`${r.valid?'OK':'INVALID'} ${r.scenario.name.padEnd(40)} frame p95 ${r.metrics.frame.p95.toFixed(1)} ms | CPU ${r.metrics.cpu.mean.toFixed(2)} ms | GPU ${r.metrics.gpu.n?r.metrics.gpu.mean.toFixed(2)+' ms':'unavailable'} | draws ${r.metrics.drawCalls.mean.toFixed(0)} | tris ${r.metrics.triangles.mean.toFixed(0)}`).join('\n');
}
async function matrix(selected:Scenario[]){if(busy)return;busy=true;buttons.forEach(b=>b.disabled=true);try{for(const s of selected)await run(s);progress.textContent='Complete';}catch(error){progress.textContent=String(error);throw error;}finally{busy=false;buttons.forEach(b=>b.disabled=false);}}
document.querySelector<HTMLButtonElement>('#run')!.onclick=()=>void matrix(scenarios);
document.querySelector<HTMLButtonElement>('#repeat')!.onclick=()=>void matrix([scenarios[4],scenarios[3],scenarios[8],scenarios[3],scenarios[6],scenarios[3],scenarios[7],scenarios[3]]);
document.querySelector<HTMLButtonElement>('#download')!.onclick=()=>{const url=URL.createObjectURL(new Blob([JSON.stringify(report,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='bolts-device-profile.json';a.click();URL.revokeObjectURL(url);};
configure(scenarios[0]);sample(0);view.render(game,1/60,false,true);publish();progress.textContent=`Ready · ${report.environment.renderer}`;buttons.forEach(b=>b.disabled=false);
