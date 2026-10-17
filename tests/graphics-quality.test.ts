import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {graphicsBudget,qualityPixelRatio} from '../src/graphicsQuality.ts';
import {View} from '../src/renderer.ts';

test('quality budgets cap high-DPI drawing buffers without changing camera or CSS dimensions',()=>{
 for(const quality of ['low','medium','high'])for(const [width,height,dpr]of [[1280,720,1],[1920,1080,2],[3840,2160,2],[844,390,3]]){
  const ratio=qualityPixelRatio(quality,dpr,width,height);
  assert.ok(width*height*ratio*ratio<=graphicsBudget(quality).pixels+1e-6);
  assert.ok(ratio<=dpr);assert.ok(ratio<=graphicsBudget(quality).ratio);
 }
 assert.equal(qualityPixelRatio('high',3,844,390,true),1);
 assert.equal(qualityPixelRatio('medium',.8,1280,720),.8);
});
test('both shadow targets resize safely when switching quality and can be restored',()=>{
 Object.assign(globalThis,{devicePixelRatio:2,innerWidth:1280,innerHeight:720});
 const worldSun=new THREE.DirectionalLight(),weaponSun=new THREE.DirectionalLight();let disposed=0,ratio=0,resized=0;
 const target=()=>{const value=new THREE.WebGLRenderTarget(4,4);value.addEventListener('dispose',()=>disposed++);return value;};
 for(const light of [worldSun,weaponSun]){light.shadow.mapSize.set(2048,2048);light.shadow.map=target();light.shadow.mapPass=target();}
 const fake={worldSun,weaponSun,renderer:{setPixelRatio:(n:number)=>{ratio=n;},shadowMap:{enabled:true}},resize:()=>resized++,quality:'high'};
 const set=(quality:string)=>View.prototype.setQuality.call(fake as unknown as View,quality);
 set('medium');assert.equal(disposed,4);assert.equal(ratio,1);
 for(const light of [worldSun,weaponSun]){assert.equal(light.shadow.mapSize.x,1024);assert.equal(light.shadow.map,null);assert.equal(light.shadow.mapPass,null);assert.equal(light.shadow.needsUpdate,true);}
 set('medium');assert.equal(disposed,4,'unchanged sizes do not churn targets');
 set('low');assert.equal(fake.renderer.shadowMap.enabled,false);
 set('high');assert.equal(fake.renderer.shadowMap.enabled,true);assert.equal(worldSun.shadow.mapSize.x,2048);assert.equal(weaponSun.shadow.mapSize.x,2048);assert.equal(ratio,1.75);assert.equal(resized,4);
});
