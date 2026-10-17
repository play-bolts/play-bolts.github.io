/** Local diagnostic entry: /scripts/performance-animation-profile.html.
 * Real browser GLTF/image decoding. Measures synchronous animation CPU time,
 * not renderer or GPU time. The death phase also records rAF intervals, which
 * include untimed rendering and are not attributable solely to animation.
 * All heavy initialization and work require explicit button clicks.
 */
import * as THREE from 'three';
import {ConvexHull} from 'three/addons/math/ConvexHull.js';
import {FACTIONS,type Faction} from '../src/config';
import {loadHandAssets} from '../src/hands';
import {preloadSoldierModels} from '../src/soldierModelAssets';
import {preloadImportedWeapons} from '../src/importedWeapons';
import {makeSoldier} from '../src/soldier';
import {updateSoldier,type SoldierActor} from '../src/soldierAnimation';
import {ModelPool} from '../src/modelPool';
import {prepareScenes} from '../src/scenePreparation';

const progress=document.querySelector<HTMLElement>('#progress')!;
const output=document.querySelector<HTMLElement>('#results')!;
const summaryOutput=document.querySelector<HTMLElement>('#summary')!;
const initializeButton=document.querySelector<HTMLButtonElement>('#initialize')!;
const runButton=document.querySelector<HTMLButtonElement>('#run')!;
const downloadButton=document.querySelector<HTMLButtonElement>('#download')!;
const nextFrame=()=>new Promise<number>(resolve=>requestAnimationFrame(resolve));
const stats=(values:number[])=>{
 const sorted=values.slice().sort((a,b)=>a-b),at=(p:number)=>sorted[Math.min(sorted.length-1,Math.floor(sorted.length*p))]??0;
 return {n:values.length,mean:values.reduce((a,b)=>a+b,0)/Math.max(1,values.length),p50:at(.5),p95:at(.95),p99:at(.99),max:sorted.at(-1)??0};
};
let renderer:THREE.WebGLRenderer,scene:THREE.Scene,camera:THREE.PerspectiveCamera,busy=false;
const report:{method:string;environment:Record<string,unknown>;startupMs?:number;runs:any[]}={
 method:'Browser CPU animation microbenchmark with shipped GLTFs and real decoded images. No AI, network, audio, or UI in timed pose calls. 200 alive warmup poses; 300 alive samples in batches of 20; 100 first-death frames at simulation dt=1/60, one per rAF; 300 settled samples in batches of 20. Render outside pose timer. Fresh model then two actual ModelPool reuses per faction. Standing rifle death only. ConvexHull timing wrapper adds two clock reads per hull; hull traversal/setup is included in full pose time but not the hull-only timer. rAF death intervals include rendering and display refresh.',
 environment:{userAgent:navigator.userAgent,hardwareConcurrency:navigator.hardwareConcurrency,deviceMemory:(navigator as any).deviceMemory,dpr:devicePixelRatio},runs:[],
};
function dispose(group:THREE.Group){
 const geometries=new Set<THREE.BufferGeometry>(),materials=new Set<THREE.Material>(),textures=new Set<THREE.Texture>(),skeletons=new Set<THREE.Skeleton>();
 group.traverse(object=>{if(object instanceof THREE.SkinnedMesh)skeletons.add(object.skeleton);if(object instanceof THREE.Mesh){geometries.add(object.geometry);for(const material of Array.isArray(object.material)?object.material:[object.material]){materials.add(material);for(const value of Object.values(material))if(value instanceof THREE.Texture)textures.add(value);}}});
 geometries.forEach(x=>x.dispose());materials.forEach(x=>x.dispose());textures.forEach(x=>x.dispose());skeletons.forEach(x=>x.dispose());
}
const pool=new ModelPool<Faction,THREE.Group>(makeSoldier,model=>{
 delete model.userData.soldierState;delete model.userData.animationPose;delete model.userData.animationStage;delete model.userData.lastShadowTime;
 model.visible=false;model.position.set(0,0,0);model.rotation.set(0,0,0);model.scale.set(1,1,1);
},dispose);
function publish(){
 output.textContent=JSON.stringify(report,null,2);
 void fetch('/__performance-results/animation',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(report)}).catch(()=>{});
 summaryOutput.textContent=report.runs.map(run=>`${run.valid?'OK':'HIDDEN/INVALID'} ${run.faction} ${run.mode}: alive p50 ${run.alive.p50.toFixed(3)} ms | death max ${run.death.max.toFixed(3)} ms (frame ${run.worstDeathFrame}) | hulls ${run.hulls.length} | settled p50 ${run.settled.p50.toFixed(3)} ms`).join('\n');
}
initializeButton.onclick=()=>void(async()=>{
 if(busy)return;busy=true;initializeButton.disabled=true;progress.textContent='Loading actual hands, rifles, grenade, and soldier assets…';
 const start=performance.now();
 try{
  renderer=new THREE.WebGLRenderer({antialias:true,powerPreference:'high-performance'});renderer.setPixelRatio(1);renderer.setSize(800,450);renderer.toneMapping=THREE.ACESFilmicToneMapping;
  document.querySelector('#world')!.appendChild(renderer.domElement);
  scene=new THREE.Scene();scene.background=new THREE.Color(0x4b5555);scene.add(new THREE.HemisphereLight(0xffffff,0x666655,2));
  const sun=new THREE.DirectionalLight(0xfff2dd,3);sun.position.set(-3,5,4);scene.add(sun);
  camera=new THREE.PerspectiveCamera(45,800/450,.05,30);camera.position.set(2,1.6,3);camera.lookAt(0,.8,0);
  const floor=new THREE.Mesh(new THREE.PlaneGeometry(20,20),new THREE.MeshStandardMaterial({color:0x636552,roughness:1}));floor.rotation.x=-Math.PI/2;scene.add(floor);
  await Promise.all([loadHandAssets(),preloadSoldierModels(),preloadImportedWeapons()]);
  const gl=renderer.getContext(),debug=gl.getExtension('WEBGL_debug_renderer_info');
  Object.assign(report.environment,{renderer:debug?gl.getParameter(debug.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER),vendor:debug?gl.getParameter(debug.UNMASKED_VENDOR_WEBGL):gl.getParameter(gl.VENDOR)});
  report.startupMs=performance.now()-start;publish();renderer.render(scene,camera);
  runButton.disabled=false;progress.textContent='Ready. Run creates fresh rigs, then reuses each twice.';
 }catch(error){progress.textContent=`Initialization failed: ${String(error)}`;initializeButton.disabled=false;throw error;}
 finally{busy=false;}
})();

async function audit(faction:Faction,mode:'fresh'|'pooled-1'|'pooled-2'){
 progress.textContent=`${faction} / ${mode}: construction and shader warmup`;
 const constructStart=performance.now(),model=pool.acquire(faction),constructionMs=performance.now()-constructStart;
 scene.add(model);model.visible=true;
 // Warm shader, texture and geometry work only; no death pose is sampled.
 await prepareScenes(renderer,[{scene,camera}]);
 let valid=!document.hidden;const onHidden=()=>{if(document.hidden)valid=false;};document.addEventListener('visibilitychange',onHidden);
 const actor:SoldierActor={id:1,x:0,y:0,z:0,yaw:0,pitch:0,stance:'stand',alive:true,moving:2,ads:false,recoil:0,cooldown:0,reload:0,reloadTotal:2,selectedWeapon:'rifle',hp:100};
 let time=0,phase='warmup',deathFrame=-1;
 const hulls:{phase:string;deathFrame:number;points:number;cpuMs:number}[]=[];
 const originalHull=ConvexHull.prototype.setFromPoints;
 ConvexHull.prototype.setFromPoints=function(points:THREE.Vector3[]){const start=performance.now();const result=originalHull.call(this,points);hulls.push({phase,deathFrame,points:points.length,cpuMs:performance.now()-start});return result;};
 const batch=async(count:number)=>{
  const values:number[]=[];
  for(let i=0;i<count;i++){
   time+=1/60;const start=performance.now();updateSoldier(model,actor,1/60,time,true);values.push(performance.now()-start);
   if(i%20===19){renderer.render(scene,camera);await nextFrame();}
  }
  return values;
 };
 try{
  await batch(200);phase='alive';progress.textContent=`${faction} / ${mode}: alive pose samples`;const alive=await batch(300);
  phase='first-death';actor.alive=false;actor.hp=0;actor.moving=0;actor.deadAt=time;
  progress.textContent=`${faction} / ${mode}: first death release`;
  const death:number[]=[],deathIntervals:number[]=[];let previous=await nextFrame();
  for(deathFrame=0;deathFrame<100;deathFrame++){
   const now=await nextFrame();deathIntervals.push(now-previous);previous=now;
   time=actor.deadAt+deathFrame/60;const start=performance.now();updateSoldier(model,actor,1/60,time,true);death.push(performance.now()-start);
   renderer.render(scene,camera);
  }
  phase='settled';progress.textContent=`${faction} / ${mode}: settled corpse samples`;const settled=await batch(300);
  report.runs.push({faction,mode,modelUuid:model.uuid,valid,constructionMs,alive:stats(alive),death:stats(death),deathFramesMs:death,worstDeathFrame:death.indexOf(Math.max(...death)),deathRafIntervals:stats(deathIntervals),settled:stats(settled),hulls});publish();
 }finally{ConvexHull.prototype.setFromPoints=originalHull;document.removeEventListener('visibilitychange',onHidden);model.removeFromParent();pool.release(model);}
}
runButton.onclick=()=>void(async()=>{
 if(busy)return;busy=true;runButton.disabled=downloadButton.disabled=true;
 // Clearing reserves ensures repeated button clicks start from fresh rigs.
 pool.clearIdle();report.runs.length=0;publish();
 try{for(const faction of FACTIONS)for(const mode of ['fresh','pooled-1','pooled-2'] as const)await audit(faction,mode);progress.textContent='Complete. CPU-only pose timings above; real device browser/GPU identified in JSON.';}
 catch(error){progress.textContent=`Run failed: ${String(error)}`;throw error;}
 finally{busy=false;runButton.disabled=downloadButton.disabled=false;}
})();
downloadButton.onclick=()=>{const url=URL.createObjectURL(new Blob([JSON.stringify(report,null,2)],{type:'application/json'}));const anchor=document.createElement('a');anchor.href=url;anchor.download='bolts-animation-profile.json';anchor.click();URL.revokeObjectURL(url);};
