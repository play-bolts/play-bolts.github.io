import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import * as THREE from 'three';
import {makeSoldierMaterials,preloadSoldierMaterials} from '../src/soldierMaterials.ts';

const root=new URL('../public/assets/',import.meta.url);
const provenance=JSON.parse(readFileSync(new URL('soldier/provenance.json',root),'utf8'));

test('soldier leather retains the original licensed files and a bounded payload',()=>{
  assert.equal(provenance.license,'CC0-1.0');assert.equal(provenance.tile_metres,.4);
  assert.deepEqual(provenance.maps.map((map:any)=>map.role),['color','normal','roughness']);
  let total=0;
  for(const map of provenance.maps){
    const data=readFileSync(new URL(`soldier/${map.path}`,root));total+=data.length;
    assert.equal(data.length,map.bytes);
    assert.equal(createHash('sha256').update(data).digest('hex'),map.sha256);
    assert.equal(createHash('md5').update(data).digest('hex'),map.source_md5,'unchanged original Poly Haven file');
    assert.equal(data.readUInt16BE(0),0xffd8);
  }
  assert.ok(total<2_100_000,'three useful 1K maps add less than 2.1 MB');
});

test('soldier material construction supports Node and shares cached paint sources',async()=>{
  await preloadSoldierMaterials();
  const a=makeSoldierMaterials('british'),b=makeSoldierMaterials('german');
  assert.notEqual(a.helmetMat.map,b.helmetMat.map);assert.equal(a.helmetMat.map!.source,b.helmetMat.map!.source);
  for(const material of [...Object.values(a),...Object.values(b)])material.dispose();
});

test('local soldier maps preload once and disposing one soldier preserves another',async t=>{
  const descriptors=['window','document'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)] as const);
  for(const [key] of descriptors)Object.defineProperty(globalThis,key,{value:{},configurable:true});
  t.after(()=>{for(const [key,descriptor] of descriptors)if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);});
  const requests:string[]=[];
  t.mock.method(THREE.TextureLoader.prototype,'load',(url:string,onLoad?:(texture:THREE.Texture)=>void)=>{
    const relative=url.split('/assets/')[1];assert.ok(relative);
    assert.ok(readFileSync(new URL(relative,root)).length>1000,'every requested image ships locally');
    requests.push(url);
    const texture=new THREE.Texture({width:1024,height:1024});
    queueMicrotask(()=>{texture.needsUpdate=true;onLoad?.(texture);});return texture;
  });
  await Promise.all([preloadSoldierMaterials(),preloadSoldierMaterials()]);
  assert.equal(requests.length,9);assert.equal(new Set(requests).size,9);
  const a=makeSoldierMaterials('british'),b=makeSoldierMaterials('russian');
  for(const key of ['wool','shade','web','leather','leatherEdge','helmetMat'] as const){
    const one=a[key],two=b[key];
    assert.notEqual(one.map,two.map);assert.equal(one.map!.source,two.map!.source);
    assert.equal(one.map!.colorSpace,THREE.SRGBColorSpace);
    assert.equal(one.normalMap!.colorSpace,THREE.NoColorSpace);assert.equal(one.roughnessMap!.colorSpace,THREE.NoColorSpace);
    assert.equal(one.normalMapType,THREE.TangentSpaceNormalMap);
    let released=0,survivorReleased=0;
    for(const texture of [one.map!,one.normalMap!,one.roughnessMap!])texture.addEventListener('dispose',()=>released++);
    two.map!.addEventListener('dispose',()=>survivorReleased++);
    one.dispose();assert.equal(released,3);assert.equal(survivorReleased,0);
    two.dispose();
  }
  a.metal.dispose();b.metal.dispose();await preloadSoldierMaterials();assert.equal(requests.length,9);
});

test('uniform shading samples color, normal and roughness on the same physical surface plane',()=>{
  for(const faction of ['british','russian','german'] as const){
    const materials=makeSoldierMaterials(faction);
    for(const key of ['wool','web','leather','helmetMat'] as const){
      const material=materials[key],shader={uniforms:{},vertexShader:THREE.ShaderLib.standard.vertexShader,fragmentShader:THREE.ShaderLib.standard.fragmentShader};
      material.onBeforeCompile(shader as any,{} as THREE.WebGLRenderer);
      const uniforms=shader.uniforms as Record<string,{value:any}>;
      assert.ok(uniforms.soldierTile.value>=.12&&uniforms.soldierTile.value<=.4);
      assert.ok(!shader.fragmentShader.includes('vNormalMapUv'),'normal derivatives use the same projection as diffuse');
      assert.ok(!shader.fragmentShader.includes('vRoughnessMapUv'));
      assert.ok(shader.fragmentShader.includes('texture2D(map,soldierUv)'));
      assert.ok(shader.fragmentShader.includes('#include <lights_physical_fragment>'),'physical lighting remains intact');
      assert.ok(shader.fragmentShader.includes('#include <tonemapping_fragment>'));
      const range=uniforms.soldierRoughness.value;
      assert.ok(range.x>0&&range.y<=1&&range.x<=range.y);
      if(key==='wool'||key==='web')assert.ok(range.x>=.85,'textile cannot become glossy under reflections');
    }
    for(const material of Object.values(materials))material.dispose();
  }
});
