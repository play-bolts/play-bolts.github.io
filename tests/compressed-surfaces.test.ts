import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import * as THREE from 'three';
import {KTX2Loader} from 'three/addons/loaders/KTX2Loader.js';
import {read} from 'three/addons/libs/ktx-parse.module.js';
import {COMPRESSED_SURFACES,loadCompressedSurfaces,supportsHighQualityCompression} from '../src/compressedSurfaces.ts';

const root=new URL('../public/assets/materials/',import.meta.url);
const manifest=JSON.parse(readFileSync(new URL('compressed-provenance.json',root),'utf8'));
const sha=(data:Buffer)=>createHash('sha256').update(data).digest('hex');
const renderer=(formats:string[])=>({extensions:{has:(name:string)=>formats.includes(name),get:()=>({getSupportedProfiles:()=>['ldr']})}} as unknown as THREE.WebGLRenderer);

test('KTX2 surfaces preserve licensed source dimensions, orientation, color transfer and complete mip chains',()=>{
 assert.deepEqual(manifest.maps.map((map:{path:string})=>map.path.replace('.ktx2','')), [...COMPRESSED_SURFACES]);
 for(const map of manifest.maps){
  const bytes=readFileSync(new URL(map.path,root)),container=read(bytes);
  assert.equal(bytes.length,map.bytes);assert.equal(sha(bytes),map.sha256);assert.equal(sha(readFileSync(new URL(map.source,root))),map.source_sha256);
  assert.deepEqual([container.pixelWidth,container.pixelHeight],map.dimensions);
  assert.equal(container.levels.length,Math.log2(container.pixelWidth)+1,'all levels, through 1×1');
  assert.equal(container.levels.length,map.levels);
  assert.equal(container.keyValue.KTXorientation,'ru','physical flip matches the original JPEG upload');
  assert.equal(container.dataFormatDescriptor[0].transferFunction,map.transfer==='srgb'?2:1,'roughness must stay linear');
  assert.equal(container.dataFormatDescriptor[0].colorModel,166,'UASTC, preserving high-quality ASTC/BC7 transcodes');
  assert.equal(container.supercompressionScheme,2,'lossless Zstandard supercompression');
  assert.ok(map.decoded_rgb_psnr_db>=40);
 }
 assert.equal(manifest.rgba8_gpu_bytes,83_886_072);
 assert.equal(manifest.astc4x4_or_bc7_gpu_bytes,20_971_680);
 assert.ok(manifest.total_bytes<16_000_000);
});

test('unsupported high-quality compression uses JPEGs without downloading a transcoder',async t=>{
 t.mock.method(KTX2Loader.prototype,'loadAsync',()=>{throw Error('must not load');});
 assert.equal(supportsHighQualityCompression(renderer(['WEBGL_compressed_texture_s3tc'])),false);
 assert.equal(supportsHighQualityCompression(renderer(['WEBGL_compressed_texture_astc'])),true);
 assert.equal(supportsHighQualityCompression(renderer(['EXT_texture_compression_bptc'])),true);
 assert.equal((await loadCompressedSurfaces(renderer([]))).size,0);
});

test('one failed compressed asset falls back independently and releases the worker pool',async t=>{
 const requests:string[]=[],warnings:string[]=[];let disposed=0;
 t.mock.method(console,'warn',(message:string)=>warnings.push(message));
 t.mock.method(KTX2Loader.prototype,'loadAsync',async(url:string)=>{
  requests.push(url);if(url.endsWith('dirt/basecolor.ktx2'))throw Error('network failure');
  return new THREE.CompressedTexture([],1024,1024,THREE.RGBA_ASTC_4x4_Format);
 });
 t.mock.method(KTX2Loader.prototype,'dispose',()=>{disposed++;});
 const textures=await loadCompressedSurfaces(renderer(['WEBGL_compressed_texture_astc']));
 assert.equal(requests.length,6);assert.equal(new Set(requests).size,6);assert.equal(textures.size,5);
 assert.equal(textures.has('dirt/basecolor'),false);assert.equal(warnings.length,1);assert.equal(disposed,1);
 for(const texture of textures.values())texture.dispose();
});
