import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import * as THREE from 'three';
import {makeSurfaceMaterial,preloadSurfaceAssets,type SurfaceKind} from '../src/materials.ts';

type MapRecord={path:string;role:string;source_url:string;source_md5?:string;sha256:string;bytes:number;dimensions:[number,number];normal_convention?:string};
const root=new URL('../public/assets/materials/',import.meta.url);
const manifest=JSON.parse(readFileSync(new URL('provenance.json',root),'utf8')) as {
  assets:{kind:SurfaceKind;license:string;maps:MapRecord[]}[];total_bytes:number;map_count:number;estimated_rgba8_gpu_bytes_with_mipmaps:number;
};
const maps=manifest.assets.flatMap(asset=>asset.maps);

function jpegDimensions(bytes:Buffer):[number,number] {
  assert.equal(bytes.readUInt16BE(0),0xffd8,'JPEG start marker');
  for(let offset=2;offset<bytes.length;){
    assert.equal(bytes[offset++],0xff,'JPEG marker prefix');
    while(bytes[offset]===0xff)offset++;
    const marker=bytes[offset++];
    assert.ok(marker!==0xda&&marker!==0xd9,'dimensions precede image data');
    const length=bytes.readUInt16BE(offset);
    assert.ok(length>=2&&offset+length<=bytes.length,'complete JPEG segment');
    if([0xc0,0xc1,0xc2].includes(marker))return[bytes.readUInt16BE(offset+5),bytes.readUInt16BE(offset+3)];
    offset+=length;
  }
  throw Error('Missing JPEG dimensions');
}

test('shipped material images retain verified source hashes, dimensions and a bounded download budget',()=>{
  assert.equal(new Set(maps.map(map=>map.path)).size,maps.length);
  for(const asset of manifest.assets){
    assert.equal(asset.license,'CC0-1.0');
    for(const map of asset.maps){
      const bytes=readFileSync(new URL(map.path,root));
      assert.equal(bytes.length,map.bytes,map.path);
      assert.equal(createHash('sha256').update(bytes).digest('hex'),map.sha256,map.path);
      if(map.source_md5)assert.equal(createHash('md5').update(bytes).digest('hex'),map.source_md5,'original Poly Haven source bytes');
      assert.deepEqual(jpegDimensions(bytes),map.dimensions,map.path);
      assert.ok([1024,2048].includes(map.dimensions[0]));
      assert.ok(map.source_url.startsWith('https://'));
      if(map.role==='normal')assert.equal(map.normal_convention,'OpenGL');
    }
  }
  assert.equal(maps.length,manifest.map_count);
  assert.equal(maps.reduce((sum,map)=>sum+map.bytes,0),manifest.total_bytes);
  assert.ok(manifest.total_bytes<25_000_000,'original image payload stays below 25 MB');
  assert.ok(manifest.estimated_rgba8_gpu_bytes_with_mipmaps<=210*1024*1024,'selective resolution bounds base surface GPU storage');
  assert.ok(maps.filter(map=>map.dimensions[0]===2048).length>=6,'visible color and weapon detail use genuine 2K sources');
});

test('materials can be constructed without a browser or image requests',async()=>{
  await preloadSurfaceAssets();
  for(const {kind} of manifest.assets){
    const material=makeSurfaceMaterial(kind);
    assert.equal(material.map,null);assert.equal(material.normalMap,null);assert.equal(material.roughnessMap,null);assert.equal(material.aoMap,null);
    material.dispose();
  }
});

test('PBR maps share decoded sources, align AO on UV0 and dispose independent material views',async t=>{
  const windowDescriptor=Object.getOwnPropertyDescriptor(globalThis,'window');
  const documentDescriptor=Object.getOwnPropertyDescriptor(globalThis,'document');
  Object.defineProperty(globalThis,'window',{value:{},configurable:true});
  Object.defineProperty(globalThis,'document',{value:{},configurable:true});
  t.after(()=>{
    for(const [key,descriptor] of [['window',windowDescriptor],['document',documentDescriptor]] as const){
      if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);
    }
  });
  const requests:string[]=[];
  t.mock.method(THREE.TextureLoader.prototype,'load',(url:string,onLoad?:(texture:THREE.Texture)=>void)=>{
    requests.push(url);
    const path=url.split('/assets/materials/')[1],record=maps.find(map=>map.path===path);
    assert.ok(record,'loader only requests a shipped, licensed map');
    const texture=new THREE.Texture({width:record.dimensions[0],height:record.dimensions[1]});
    queueMicrotask(()=>{texture.needsUpdate=true;onLoad?.(texture);});
    return texture;
  });
  const a=makeSurfaceMaterial('stone',{repeat:[2,1],offset:[.2,.4],rotation:.3,aoIntensity:.8});
  const initialVersion=a.aoMap!.version;
  await preloadSurfaceAssets(undefined,{includeLegacy:false});
  assert.ok(requests.every(url=>!url.includes('/steel/')),'production preloading skips legacy procedural steel');
  assert.equal(requests.length,maps.filter(map=>!map.path.startsWith('steel/')).length);
  await preloadSurfaceAssets();
  assert.ok(a.aoMap!.version>initialVersion,'views created before load are marked for upload when it finishes');
  assert.equal(requests.length,maps.length);
  assert.equal(new Set(requests).size,requests.length,'each image is fetched once');
  const b=makeSurfaceMaterial('stone',{repeat:[5,3]});
  assert.notEqual(a.map,b.map);assert.equal(a.map!.source,b.map!.source,'material views share decoded image storage');
  assert.notEqual(a.map!.repeat,b.map!.repeat);
  assert.deepEqual(b.map!.repeat.toArray(),[5,3]);
  assert.equal(a.aoMapIntensity,.8);
  const materialViews=[a.map!,a.normalMap!,a.roughnessMap!,a.aoMap!];
  for(const texture of materialViews){
    assert.equal(texture.channel,0,'AO and all other maps use the existing UV attribute');
    assert.deepEqual(texture.repeat.toArray(),[2,1]);
    assert.deepEqual(texture.offset.toArray(),[.2,.4]);assert.equal(texture.rotation,.3);
    assert.equal(texture.colorSpace,texture===a.map?THREE.SRGBColorSpace:THREE.NoColorSpace);
    texture.updateMatrix();assert.deepEqual(texture.matrix.elements,a.map!.matrix.elements);
  }
  for(const {kind,maps:assetMaps} of manifest.assets){
    const material=makeSurfaceMaterial(kind);
    assert.equal(!!material.aoMap,assetMaps.some(map=>map.role==='ao'));
    assert.equal(material.normalMapType,THREE.TangentSpaceNormalMap);
    material.dispose();
  }
  let disposed=0,otherDisposed=0;
  for(const texture of materialViews)texture.addEventListener('dispose',()=>disposed++);
  b.aoMap!.addEventListener('dispose',()=>otherDisposed++);
  a.dispose();assert.equal(disposed,4,'disposing a material releases its AO view too');assert.equal(otherDisposed,0);
  assert.equal(b.map!.source,a.map!.source,'the surviving view still has its decoded source');
  b.dispose();
  await preloadSurfaceAssets();assert.equal(requests.length,maps.length,'reuse never fetches duplicate images');
});
