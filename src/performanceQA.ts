import * as THREE from 'three';
import {View} from './renderer';
import {Game,createActor,type Shot} from './engine';
import {FACTIONS,WEAPONS} from './config';
import {loadHandAssets} from './hands';
import {preloadHumanHead} from './humanHead';
import {preloadSoldierMaterials} from './soldier';
import {preloadModelDetails} from './modelDetails';
import {preloadImportedWeapons} from './importedWeapons';
import {preloadSurfaceAssets} from './materials';

// Independent development entry: never imported by the shipped game.
const status=document.querySelector<HTMLElement>('#status')!,results=document.querySelector<HTMLElement>('#results')!;
const compressed=new URLSearchParams(location.search).get('compressed')==='1',graphics=compressed?new THREE.WebGLRenderer({antialias:true,powerPreference:'high-performance'}):undefined;
await Promise.all([loadHandAssets(),preloadHumanHead(),preloadSoldierMaterials(),preloadModelDetails(),preloadSurfaceAssets(graphics),preloadImportedWeapons()]);
const game=new Game(),view=new View(document.querySelector<HTMLElement>('#world')!,graphics);
await view.prepare();
const compressedMaps=new Set<string>();view.scene.traverse(object=>{if(object instanceof THREE.Mesh)for(const material of Array.isArray(object.material)?object.material:[object.material])for(const value of Object.values(material))if(value instanceof THREE.CompressedTexture)compressedMaps.add(value.name);});
game.actors=Array.from({length:6},(_,i)=>Object.assign(createActor(i,FACTIONS[i%3],`Benchmark ${i}`),{renderIdentity:`benchmark:${i}`}));
game.state='playing';view.setupActors(game);
view.renderer.setPixelRatio(1.75);view.renderer.setSize(1280,720,false);view.camera.aspect=view.weaponCamera.aspect=1280/720;view.camera.updateProjectionMatrix();view.weaponCamera.updateProjectionMatrix();view.intro.resize(1280/720);
view.renderer.info.autoReset=false;
const gl=view.renderer.getContext() as WebGL2RenderingContext,extension=gl.getExtension('EXT_disjoint_timer_query_webgl2');
const pending:WebGLQuery[]=[];let gpu:number[]=[];
const summary=(values:number[])=>{const sorted=[...values].sort((a,b)=>a-b),at=(p:number)=>sorted[Math.min(sorted.length-1,Math.floor(sorted.length*p))]??0;return{samples:values.length,meanMs:values.reduce((a,b)=>a+b,0)/Math.max(1,values.length),medianMs:at(.5),p95Ms:at(.95),p99Ms:at(.99)};};
function sample(t:number){
 game.time=t;game.remaining=300-t;
 for(const actor of game.actors){const i=actor.id,phase=(t+i*.7)%8;
  actor.x=i===0?0:(i-3)*2.5+Math.sin(t*.7+i)*.8;actor.z=i===0?-13:-5+(i%2)*5;actor.y=0;actor.yaw=i===0?Math.sin(t*.3)*.16:Math.PI+Math.sin(t*.6+i)*.5;actor.pitch=0;
  actor.moving=i===0?0:2.1;actor.stance=phase>5&&phase<7?'crouch':'stand';actor.eyeHeight=actor.stance==='crouch'?1.1:1.65;actor.ads=i===0&&phase>2&&phase<4;actor.reload=phase>4&&phase<6?6-phase:0;actor.reloadTotal=2;actor.lean=Math.sin(t+i)*.3;
  actor.lastShotTime=Math.floor((t+i*.2)/1.4)*1.4-i*.2;actor.recoil=Math.max(0,.06-(t-actor.lastShotTime)*.2);actor.cooldown=Math.max(0,WEAPONS[actor.faction].cycle-(t-actor.lastShotTime));
 }
}
let busy=false,runId=0;
async function run(mode:'combat'|'menu'){
 if(busy)return;busy=true;const id=++runId;for(const b of document.querySelectorAll<HTMLButtonElement>('button'))b.disabled=true;
 view.clearEffects();let start=0,previous=0,lastShot=-1,frames:number[]=[],cpu:number[]=[],draws:number[]=[],triangles:number[]=[];gpu=[];
 const warmup=4000,duration=16000;let interrupted=false;
 const onVisibility=()=>{if(document.hidden)interrupted=true;};document.addEventListener('visibilitychange',onVisibility);
 await new Promise<void>(resolve=>{
  function frame(now:number){
   if(!start)start=previous=now;const elapsed=now-start,t=elapsed/1000,dt=(now-previous)/1000;previous=now;
   if(elapsed>=duration){resolve();return;}
   sample(t);view.renderer.info.reset();const before=performance.now();
   if(mode==='combat'){const shotIndex=Math.floor(t*3);if(shotIndex!==lastShot){lastShot=shotIndex;const actor=game.actors[shotIndex%6];const shot:Shot={time:t,actor:actor.id,origin:{x:actor.x,y:1.4,z:actor.z},end:{x:actor.x+1,y:1.2,z:actor.z+3},hit:shotIndex%2?null:1,headshot:false,kind:'shot'};view.effect(shot,actor.id===0);}}
   let query:WebGLQuery|null=null;if(extension&&pending.length<8){query=gl.createQuery();if(query)gl.beginQuery(extension.TIME_ELAPSED_EXT,query);}
   view.render(game,dt,mode==='menu',true);
   if(query){gl.endQuery(extension!.TIME_ELAPSED_EXT);if(elapsed>=warmup)pending.push(query);else gl.deleteQuery(query);}
   if(elapsed>=warmup){frames.push(dt*1000);cpu.push(performance.now()-before);draws.push(view.renderer.info.render.calls);triangles.push(view.renderer.info.render.triangles);}
   if(extension){const disjoint=gl.getParameter(extension.GPU_DISJOINT_EXT);while(pending.length&&gl.getQueryParameter(pending[0],gl.QUERY_RESULT_AVAILABLE)){const ready=pending.shift()!;if(!disjoint)gpu.push(Number(gl.getQueryParameter(ready,gl.QUERY_RESULT))/1e6);gl.deleteQuery(ready);}if(disjoint){for(const q of pending)gl.deleteQuery(q);pending.length=0;}}
   status.textContent=`${mode} ${Math.round(elapsed/1000)} / ${duration/1000} s`;requestAnimationFrame(frame);
  }requestAnimationFrame(frame);
 });
 document.removeEventListener('visibilitychange',onVisibility);
 for(const q of pending)gl.deleteQuery(q);pending.length=0;
 const report={run:id,mode,compressed,compressedMaps:[...compressedMaps].sort(),valid:!interrupted,viewport:[1280,720],pixelRatio:view.renderer.getPixelRatio(),frame:summary(frames),cpu:summary(cpu),gpu:summary(gpu),drawCalls:summary(draws),triangles:summary(triangles),memory:view.renderer.info.memory};
 results.textContent=JSON.stringify(report,null,2);status.textContent=interrupted?'Invalid: tab was hidden during measurement.':'Complete';busy=false;for(const b of document.querySelectorAll<HTMLButtonElement>('button'))b.disabled=false;
}
document.querySelector<HTMLButtonElement>('#run')!.onclick=()=>void run('combat');
document.querySelector<HTMLButtonElement>('#menu')!.onclick=()=>void run('menu');
document.querySelector<HTMLButtonElement>('#roster')!.onclick=()=>{
 const original=game.actors.slice();const times:number[]=[];
 for(let i=0;i<4;i++){game.actors=i%2?original:original.slice(0,5);const start=performance.now();const sync=(view as unknown as {syncActors?:(g:Game)=>void}).syncActors;if(sync)sync.call(view,game);else view.setupActors(game);times.push(performance.now()-start);}
 game.actors=original;results.textContent=JSON.stringify({mode:'roster',cpu:summary(times),memory:view.renderer.info.memory},null,2);status.textContent='Complete';
};
sample(0);view.render(game,1/60,false);status.textContent=`Ready · ${compressedMaps.size} compressed maps`;for(const b of document.querySelectorAll<HTMLButtonElement>('button'))b.disabled=false;
