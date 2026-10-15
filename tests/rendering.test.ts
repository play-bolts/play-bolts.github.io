import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {createOutdoorSkyTexture} from '../src/outdoorLighting.ts';
import {makeSurfaceMaterial} from '../src/materials.ts';
import {weatherSurface} from '../src/surfaceWeathering.ts';

test('generated reflection sky follows Three equirectangular axes and retains HDR cloud lighting',()=>{
  const texture=createOutdoorSkyTexture(),{width,height,data}=texture.image as {width:number;height:number;data:Uint16Array};
  const sample=(direction:THREE.Vector3)=>{
    direction.normalize();
    const x=Math.min(width-1,Math.floor((Math.atan2(direction.z,direction.x)/(Math.PI*2)+.5)*width));
    const y=Math.min(height-1,Math.floor((Math.asin(direction.y)/Math.PI+.5)*height));
    return THREE.DataUtils.fromHalfFloat(data[(y*width+x)*4]);
  };
  assert.equal(texture.colorSpace,THREE.LinearSRGBColorSpace);
  assert.equal(texture.mapping,THREE.EquirectangularReflectionMapping);
  assert.ok(sample(new THREE.Vector3(0,1,0))>sample(new THREE.Vector3(0,-1,0))*4,'upper hemisphere reflects sky, not ground');
  const towardSun=sample(new THREE.Vector3(-24,40,16)),awayFromSun=sample(new THREE.Vector3(24,40,-16));
  assert.ok(towardSun>2&&towardSun>awayFromSun*2,'reflection highlight agrees with the directional sun');
  for(const value of data)assert.ok(Number.isFinite(THREE.DataUtils.fromHalfFloat(value))&&THREE.DataUtils.fromHalfFloat(value)>=0);
  texture.dispose();
});

test('weathering composes with the installed Three PBR shader while material uniforms stay independent',()=>{
  const a=weatherSurface(makeSurfaceMaterial('canvas'),'canvas',[2,3,4]);
  const b=weatherSurface(makeSurfaceMaterial('canvas'),'canvas',[5,1,2]);
  const compile=(material:THREE.MeshStandardMaterial)=>{
    const shader={uniforms:THREE.UniformsUtils.clone(THREE.ShaderLib.standard.uniforms),vertexShader:THREE.ShaderLib.standard.vertexShader,fragmentShader:THREE.ShaderLib.standard.fragmentShader};
    material.onBeforeCompile(shader,{} as THREE.WebGLRenderer);return shader;
  };
  const sa=compile(a),sb=compile(b);
  assert.deepEqual(sa.uniforms.boltsHalfSize.value.toArray(),[1,1.5,2]);
  assert.deepEqual(sb.uniforms.boltsHalfSize.value.toArray(),[2.5,.5,1]);
  assert.notEqual(sa.uniforms.boltsHalfSize.value,sb.uniforms.boltsHalfSize.value);
  assert.deepEqual(sa.uniforms.boltsRoughnessRange.value.toArray(),[.82,.98]);
  for(const token of ['#include <normal_fragment_maps>','#include <lights_fragment_begin>','#include <tonemapping_fragment>'])assert.ok(sa.fragmentShader.includes(token),'normal maps, physical light and tone mapping remain in the standard shader');
  assert.ok(sa.vertexShader.includes('vBoltsWorld=(modelMatrix*vec4(transformed,1.0)).xyz'),'the current Three projection hook is available');
  assert.ok(sa.fragmentShader.includes('roughnessFactor=mix('),'the current Three roughness hook is available');
  assert.equal(a.customProgramCacheKey(),b.customProgramCacheKey(),'same shader can be shared across different sized crates');
  a.dispose();b.dispose();
});
