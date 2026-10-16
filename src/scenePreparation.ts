import * as THREE from 'three';

type PreparingRenderer=Pick<THREE.WebGLRenderer,'initTexture'|'compileAsync'|'render'|'getRenderTarget'|'setRenderTarget'|'getViewport'|'setViewport'|'getScissor'|'setScissor'|'getScissorTest'|'setScissorTest'|'autoClear'>;

/** Upload and compile actual retained scene resources while the loading screen
 * is visible. The temporary 4px target uploads geometry and depth/shadow
 * programs without replacing the canvas. All temporary presentation state is
 * restored even if compilation fails; real renderer errors are propagated. */
export async function prepareScenes(renderer:PreparingRenderer,scenes:readonly {scene:THREE.Scene;camera:THREE.Camera}[]){
 const target=renderer.getRenderTarget(),viewport=renderer.getViewport(new THREE.Vector4()),scissor=renderer.getScissor(new THREE.Vector4()),scissorTest=renderer.getScissorTest(),autoClear=renderer.autoClear;
 const temporary=new THREE.WebGLRenderTarget(4,4,{depthBuffer:true});
 const visibility=new Map<THREE.Object3D,{visible:boolean;frustumCulled:boolean}>(),textures=new Set<THREE.Texture>();
 try{
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
  for(const texture of textures)renderer.initTexture(texture);
  // Compile with the original output target/color space before the tiny draw.
  // All scene lights, fog and environments are the actual gameplay settings.
  for(const {scene,camera} of scenes)await renderer.compileAsync(scene,camera);
  renderer.autoClear=true;renderer.setRenderTarget(temporary);renderer.setScissorTest(false);
  for(const {scene,camera} of scenes)renderer.render(scene,camera);
 }finally{
  for(const [object,state] of visibility){object.visible=state.visible;object.frustumCulled=state.frustumCulled;}
  renderer.setRenderTarget(target);renderer.setViewport(viewport);renderer.setScissor(scissor);renderer.setScissorTest(scissorTest);renderer.autoClear=autoClear;
  temporary.dispose();
 }
}
