import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {ModelPool} from '../src/modelPool.ts';
import {prepareScenes} from '../src/scenePreparation.ts';
import {View} from '../src/renderer.ts';

test('warm model pool preserves ownership, resets leases, and bounds each faction reserve',()=>{
 let serial=0;const disposed:number[]=[];
 const pool=new ModelPool((faction:string)=>({id:++serial,faction,phase:0}),model=>{model.phase=0;},model=>disposed.push(model.id));
 const british=pool.acquire('british'),otherBritish=pool.acquire('british'),german=pool.acquire('german');
 assert.notEqual(british,otherBritish,'active actors never share mutable rig state');
 british.phase=20;pool.release(british);pool.release(otherBritish);pool.release(german);
 assert.equal(pool.retained,2);assert.deepEqual(disposed,[otherBritish.id]);
 const reused=pool.acquire('british');assert.equal(reused,british);assert.equal(reused.phase,0);
 assert.throws(()=>pool.release(otherBritish),/not leased/,'an overflow disposal cannot later be leased twice');
 pool.clearIdle();assert.deepEqual(disposed,[otherBritish.id,german.id]);assert.equal(pool.retained,0);
 assert.ok(!disposed.includes(reused.id),'clearing reserves cannot dispose an active player');
 pool.release(reused);assert.throws(()=>pool.release(reused),/not leased/);pool.clearIdle();assert.deepEqual(disposed,[otherBritish.id,german.id,british.id]);
});

function fixture(fail=false){
 const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera(),group=new THREE.Group(),texture=new THREE.Texture(),material=new THREE.MeshStandardMaterial({map:texture}),mesh=new THREE.Mesh(new THREE.BoxGeometry(),material);
 group.visible=false;mesh.visible=false;scene.add(group);group.add(mesh);
 const shader=new THREE.Mesh(new THREE.PlaneGeometry(),new THREE.ShaderMaterial({uniforms:{sharedMap:{value:texture}}}));scene.add(shader);
 const light=new THREE.DirectionalLight();light.visible=false;scene.add(light);
 let target:THREE.WebGLRenderTarget|null=null,viewport=new THREE.Vector4(1,2,100,200),scissor=new THREE.Vector4(3,4,50,60),scissorTest=true;
 const uploads:THREE.Texture[]=[],renders:THREE.Scene[]=[],compiles:THREE.Scene[]=[];
 const renderer={autoClear:false,
  initTexture(value:THREE.Texture){uploads.push(value);},
  async compileAsync(value:THREE.Scene){compiles.push(value);assert.equal(target,null,'compile for the original canvas color space');assert.equal(group.visible,true);assert.equal(mesh.visible,true);assert.equal(mesh.frustumCulled,false);assert.equal(light.visible,false,'actual hidden lighting stays hidden');if(fail)throw new Error('shader failure');return scene;},
  render(value:THREE.Scene){assert.ok(target);assert.equal(target!.width,4);assert.equal(target!.height,4);assert.equal(scissorTest,false);renders.push(value);},
  getRenderTarget:()=>target,setRenderTarget:(value:THREE.WebGLRenderTarget|null)=>{target=value;},
  getViewport:(value:THREE.Vector4)=>value.copy(viewport),setViewport:(value:THREE.Vector4)=>{viewport.copy(value);},
  getScissor:(value:THREE.Vector4)=>value.copy(scissor),setScissor:(value:THREE.Vector4)=>{scissor.copy(value);},
  getScissorTest:()=>scissorTest,setScissorTest:(value:boolean)=>{scissorTest=value;},
 };
 let resourceDisposals=0;for(const resource of [mesh.geometry,material,texture])resource.addEventListener('dispose',()=>resourceDisposals++);
 return{scene,camera,group,mesh,texture,renderer,uploads,renders,compiles,verify(){assert.equal(target,null);assert.deepEqual(viewport.toArray(),[1,2,100,200]);assert.deepEqual(scissor.toArray(),[3,4,50,60]);assert.equal(scissorTest,true);assert.equal(renderer.autoClear,false);assert.equal(group.visible,false);assert.equal(mesh.visible,false);assert.equal(mesh.frustumCulled,true);assert.equal(resourceDisposals,0,'prepared models/materials/textures stay alive');assert.equal(group.parent,scene);}};
}

test('scene warmup uploads shared textures once and restores output/visibility without disposing retained resources',async()=>{
 const f=fixture();await prepareScenes(f.renderer as unknown as THREE.WebGLRenderer,[{scene:f.scene,camera:f.camera}]);
 assert.deepEqual(f.uploads,[f.texture]);assert.deepEqual(f.compiles,[f.scene]);assert.deepEqual(f.renders,[f.scene]);f.verify();
});

test('warmup restores renderer and scene state while propagating shader failures',async()=>{
 const f=fixture(true);await assert.rejects(prepareScenes(f.renderer as unknown as THREE.WebGLRenderer,[{scene:f.scene,camera:f.camera}]),/shader failure/);
 assert.equal(f.renders.length,0);f.verify();
});

test('first-person faction changes retain each warmed pair and never dispose the previous faction',()=>{
 const view=Object.create(View.prototype) as View;
 const pairs=new Map(['british','russian','german'].map(faction=>[faction,{rifle:new THREE.Group(),grenade:new THREE.Group()}]));
 Object.assign(view,{firstPersonModels:pairs,weapon:new THREE.Group(),rifle:null,grenade:null,faction:'british',muzzle:new THREE.Group(),flash:new THREE.PointLight()});
 for(const pair of pairs.values())pair.rifle.add(new THREE.Mesh(new THREE.BoxGeometry(),new THREE.MeshBasicMaterial()));
 let disposals=0;for(const pair of pairs.values())(pair.rifle.children[0] as THREE.Mesh).geometry.addEventListener('dispose',()=>disposals++);
 view.setFaction('british');const initial=view.rifle;
 view.setFaction('german');assert.equal(initial!.parent,null);assert.equal(view.rifle,pairs.get('german')!.rifle);
 view.setFaction('british');assert.equal(view.rifle,initial);assert.equal(view.grenade,pairs.get('british')!.grenade);assert.equal(view.rifle!.visible,true);assert.equal(view.grenade!.visible,false);assert.equal(disposals,0);
});
