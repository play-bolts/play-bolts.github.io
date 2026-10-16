import * as THREE from 'three';

type PreparingRenderer=Pick<THREE.WebGLRenderer,'initTexture'|'compileAsync'|'render'|'getRenderTarget'|'setRenderTarget'|'getViewport'|'setViewport'|'getScissor'|'setScissor'|'getScissorTest'|'setScissorTest'|'autoClear'>;

/** Resume in a task after the browser has had a chance to paint the loading UI. */
export function yieldLoadingPaint():Promise<void>{
 if(typeof requestAnimationFrame==='undefined')return Promise.resolve();
 return new Promise(resolve=>requestAnimationFrame(()=>setTimeout(resolve,0)));
}

/** Upload and compile actual retained scene resources while the loading screen
 * is visible. The temporary 4px target uploads geometry and depth/shadow
 * programs without replacing the canvas. All temporary presentation state is
 * restored even if compilation fails; real renderer errors are propagated. */
export async function prepareScenes(renderer:PreparingRenderer,scenes:readonly {scene:THREE.Scene;camera:THREE.Camera}[],onProgress?:(value:number)=>void){
 const target=renderer.getRenderTarget(),viewport=renderer.getViewport(new THREE.Vector4()),scissor=renderer.getScissor(new THREE.Vector4()),scissorTest=renderer.getScissorTest(),autoClear=renderer.autoClear;
 const temporary=new THREE.WebGLRenderTarget(4,4,{depthBuffer:true});
 const visibility=new Map<THREE.Object3D,{visible:boolean;frustumCulled:boolean}>(),textures=new Set<THREE.Texture>();
 const restoreOutput=()=>{renderer.setRenderTarget(target);renderer.setViewport(viewport);renderer.setScissor(scissor);renderer.setScissorTest(scissorTest);renderer.autoClear=autoClear;};
 try{
  onProgress?.(0);await yieldLoadingPaint();
  for(const {scene} of scenes)scene.traverse(object=>{
   visibility.set(object,{visible:object.visible,frustumCulled:object.frustumCulled});
   if(!(object instanceof THREE.Light))object.visible=true;
   object.frustumCulled=false;
   if(object instanceof THREE.Mesh||object instanceof THREE.Points||object instanceof THREE.Line||object instanceof THREE.Sprite){
    for(const material of Array.isArray(object.material)?object.material:[object.material]){
     for(const value of Object.values(material))if(value instanceof THREE.Texture)textures.add(value);
     if(material instanceof THREE.ShaderMaterial)for(const uniform of Object.values(material.uniforms))if(uniform.value instanceof THREE.Texture)textures.add(uniform.value);
    }
   }
  });
  let uploaded=0,batchStarted=performance.now();
  for(const texture of textures){
   renderer.initTexture(texture);onProgress?.(.35*++uploaded/textures.size);
   if(performance.now()-batchStarted>=8){await yieldLoadingPaint();batchStarted=performance.now();}
  }
  if(!textures.size)onProgress?.(.35);
  // Compile with the original output target/color space before the tiny draw.
  // All scene lights, fog and environments are the actual gameplay settings.
  for(const [index,{scene,camera}] of scenes.entries()){
   await yieldLoadingPaint();await renderer.compileAsync(scene,camera);onProgress?.(.35+.55*(index+1)/scenes.length);
  }
  if(!scenes.length)onProgress?.(.9);
  for(const [index,{scene,camera}] of scenes.entries()){
   await yieldLoadingPaint();
   try{renderer.autoClear=true;renderer.setRenderTarget(temporary);renderer.setScissorTest(false);renderer.render(scene,camera);}
   finally{restoreOutput();}
   onProgress?.(.9+.1*(index+1)/scenes.length);
  }
  if(!scenes.length)onProgress?.(1);
 }finally{
  for(const [object,state] of visibility){object.visible=state.visible;object.frustumCulled=state.frustumCulled;}
  restoreOutput();
  temporary.dispose();
 }
}
