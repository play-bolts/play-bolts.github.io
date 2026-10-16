/** Development-only Vite entry. Never imported or bundled by the game. */
import * as THREE from 'three';
import {WebGPURenderer} from 'three/webgpu';

const output=document.querySelector<HTMLPreElement>('#results')!;
const preview=document.querySelector<HTMLDivElement>('#preview')!;
const button=document.querySelector<HTMLButtonElement>('#run')!;
const frame=()=>new Promise<number>(resolve=>requestAnimationFrame(resolve));
const percentile=(values:number[],q:number)=>[...values].sort((a,b)=>a-b)[Math.floor((values.length-1)*q)];

async function measure(api:'WebGL'|'WebGPU') {
 const renderer=api==='WebGL'?new THREE.WebGLRenderer({antialias:true,powerPreference:'high-performance'}):new WebGPURenderer({antialias:true,powerPreference:'high-performance'});
 const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera(60,960/540,.1,100);
 const geometry=new THREE.BoxGeometry(.65,.65,.65);
 const materials=Array.from({length:6},(_,i)=>new THREE.MeshStandardMaterial({color:new THREE.Color().setHSL(i/6,.25,.45),roughness:.8}));
 try {
  renderer.setPixelRatio(1);renderer.setSize(960,540);renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.info.autoReset=false;
  renderer.toneMapping=THREE.ACESFilmicToneMapping;preview.replaceChildren(renderer.domElement);
  if(renderer instanceof WebGPURenderer){await renderer.init();if(!('isWebGPUBackend' in renderer.backend)||!renderer.backend.isWebGPUBackend)throw Error('WebGPU unavailable: Three selected its WebGL fallback.');}
  scene.background=new THREE.Color(0x171c23);scene.add(new THREE.HemisphereLight(0xffffff,0x30343e,2));
  const light=new THREE.DirectionalLight(0xffffff,3);light.position.set(4,10,8);scene.add(light);
  // Separate draw calls intentionally isolate the area where WebGPU may help.
  for(let i=0;i<600;i++){const mesh=new THREE.Mesh(geometry,materials[i%6]);mesh.position.set((i%30-14.5)*.8,(Math.floor(i/30)%10-4.5)*.8,Math.floor(i/300)*1.5);mesh.rotation.set(i*.071,i*.053,0);scene.add(mesh);}
  camera.position.set(0,0,18);camera.lookAt(0,0,0);
  await renderer.compileAsync(scene,camera);
  const submit:number[]=[],interval:number[]=[];let previous=await frame();
  for(let i=0;i<360;i++){
   const now=await frame();renderer.info.reset();const start=performance.now();renderer.render(scene,camera);const end=performance.now();
   if(i>=120){submit.push(end-start);interval.push(now-previous);}previous=now;
  }
  return {api,drawCalls:'drawCalls' in renderer.info.render?renderer.info.render.drawCalls:renderer.info.render.calls,triangles:renderer.info.render.triangles,samples:submit.length,
   cpuSubmissionMs:{median:percentile(submit,.5),p95:percentile(submit,.95)},presentedFrameIntervalMs:{median:percentile(interval,.5),p95:percentile(interval,.95)}};
 } finally {geometry.dispose();materials.forEach(material=>material.dispose());renderer.dispose();}
}

button.addEventListener('click',async()=>{
 button.disabled=true;const results:unknown[]=[];
 try {
  for(const api of ['WebGL','WebGPU'] as const){output.textContent=`Measuring ${api}…\n${JSON.stringify(results,null,2)}`;
   try{results.push(await measure(api));}catch(error){results.push({api,error:String(error)});}
  }
  output.textContent=JSON.stringify({scene:'600 independent stock-material cubes, 960×540, pixel ratio 1, 120 warmup + 240 measured frames per API',limitations:'CPU submission and presented intervals include browser scheduling; no GPU timestamp queries. This scene omits Bolts custom shaders, shadows, animation and networking; it is not a gameplay FPS claim.',results},null,2);
 } finally {button.disabled=false;}
});
