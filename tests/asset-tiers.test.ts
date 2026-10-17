import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import * as THREE from 'three';
import {AssetTierManager,assetTierForQuality,tieredAssetUrl,type AssetTier} from '../src/assetTiers.ts';

const root=new URL('../public/assets/',import.meta.url);
const manifest=JSON.parse(readFileSync(new URL('tiers/manifest.json',root),'utf8'));
function glb(bytes:Buffer){
 assert.equal(bytes.toString('ascii',0,4),'glTF');assert.equal(bytes.readUInt32LE(4),2);assert.equal(bytes.readUInt32LE(8),bytes.length);
 const jsonLength=bytes.readUInt32LE(12),document=JSON.parse(bytes.toString('utf8',20,20+jsonLength));
 return{document,binary:bytes.subarray(28+jsonLength)};
}
function imageSize(bytes:Buffer):[number,number]{
 if(bytes.toString('ascii',1,4)==='PNG')return[bytes.readUInt32BE(16),bytes.readUInt32BE(20)];
 assert.equal(bytes.readUInt16BE(0),0xffd8);
 for(let i=2;i<bytes.length;){
  assert.equal(bytes[i++],0xff);while(bytes[i]===0xff)i++;
  const marker=bytes[i++],length=bytes.readUInt16BE(i);
  if([0xc0,0xc1,0xc2].includes(marker))return[bytes.readUInt16BE(i+5),bytes.readUInt16BE(i+3)];
  assert.ok(length>=2);i+=length;
 }
 throw Error('Missing image dimensions');
}

test('download variants preserve every model, rig, sight, material and sampler field and all non-image bytes',()=>{
 assert.equal(manifest.assets.length,14);
 for(const asset of manifest.assets){
  const originalBytes=readFileSync(new URL(asset.path,root)),variantBytes=readFileSync(new URL(`tiers/${asset.tier}/${asset.path}`,root));
  assert.equal(createHash('sha256').update(originalBytes).digest('hex'),asset.sourceSha256);
  assert.equal(createHash('sha256').update(variantBytes).digest('hex'),asset.sha256);
  assert.equal(variantBytes.length,asset.bytes);assert.ok(variantBytes.length<originalBytes.length,asset.path);
  const original=glb(originalBytes),variant=glb(variantBytes);
  const canonical=(document:any)=>{
   const copy=structuredClone(document);
   copy.buffers.forEach((buffer:any)=>delete buffer.byteLength);
   copy.bufferViews.forEach((view:any)=>{delete view.byteOffset;delete view.byteLength;});
   copy.images.forEach((image:any)=>delete image.mimeType);
   return copy;
  };
  assert.deepEqual(canonical(variant.document),canonical(original.document),'only image encodings and buffer packing may change');
  const imageViews=new Set(original.document.images.map((image:any)=>image.bufferView));
  original.document.bufferViews.forEach((view:any,index:number)=>{
   const replacement=variant.document.bufferViews[index];
   assert.equal(replacement.byteOffset%4,0,'GLB alignment');
   if(!imageViews.has(index))assert.deepEqual(variant.binary.subarray(replacement.byteOffset,replacement.byteOffset+replacement.byteLength),original.binary.subarray(view.byteOffset,view.byteOffset+view.byteLength),'positions, UVs, normals, skin weights and indices remain byte-identical');
  });
  variant.document.images.forEach((image:any,index:number)=>{
   const view=variant.document.bufferViews[image.bufferView],bytes=variant.binary.subarray(view.byteOffset,view.byteOffset+view.byteLength),record=asset.images[index];
   assert.deepEqual(imageSize(bytes),record.dimensions);
   const family=asset.path.startsWith('imported-soldiers/')?'soldier':'weapon';
   assert.ok(Math.max(...record.dimensions)<=manifest.limits[asset.tier][family][record.role==='color'?0:1]);
   assert.equal(image.mimeType,record.mimeType);
   const oldImage=original.document.images[index],oldView=original.document.bufferViews[oldImage.bufferView];
   const oldBytes=original.binary.subarray(oldView.byteOffset,oldView.byteOffset+oldView.byteLength);
   if(oldImage.mimeType==='image/png'&&[4,6].includes(oldBytes[25]))assert.ok(image.mimeType==='image/png'&&[4,6].includes(bytes[25]),'source alpha channels survive resampling');
  });
 }
});

test('quality chooses a downloadable variant directly while high retains original URLs',()=>{
 for(const tier of ['low','medium','high'] as const){
  assert.equal(assetTierForQuality(tier),tier);
  assert.equal(tieredAssetUrl('imported-weapons/mosin.glb',tier),`/assets/${tier==='high'?'':`tiers/${tier}/`}imported-weapons/mosin.glb`);
 }
 assert.equal(assetTierForQuality('unknown'),'high');
});

function fakeImage(size:number){return{width:size,height:size,closed:0,close(){this.closed++;}};}
const texture=(size:number)=>new THREE.Texture(fakeImage(size));
function deferred<T>(){let resolve!:(value:T)=>void,reject!:(reason:Error)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};}

test('live switches preserve Source, UV transforms and material bindings, release GPU views and retire images',async()=>{
 const decoded:THREE.Texture[]=[];
 const manager=new AssetTierManager(async(_path,tier)=>{const next=texture(tier==='low'?256:512);decoded.push(next);return[next];});
 const source=texture(1024),oldImage=source.image,material=new THREE.MeshStandardMaterial({map:source.clone()});
 const geometry=new THREE.BoxGeometry(),scene=new THREE.Mesh(geometry,material);
 manager.register('test.glb',[source],scene);
 const view=material.map!,sharedSource=view.source;
 view.repeat.set(3,4);view.offset.set(.2,.7);view.rotation=.4;view.channel=1;view.anisotropy=4;view.wrapS=THREE.RepeatWrapping;view.colorSpace=THREE.SRGBColorSpace;
 let releases=0;view.addEventListener('dispose',()=>releases++);
 await manager.change('low');
 assert.equal(manager.getTier(),'low');assert.equal(view.source,sharedSource);assert.equal(view.image.width,256);assert.equal(source.image,view.image);
 assert.equal(oldImage.closed,1);assert.equal(releases,1);assert.equal(material.map,view);assert.equal(scene.geometry,geometry);
 assert.deepEqual(view.repeat.toArray(),[3,4]);assert.deepEqual(view.offset.toArray(),[.2,.7]);assert.equal(view.rotation,.4);assert.equal(view.channel,1);assert.equal(view.anisotropy,4);assert.equal(view.wrapS,THREE.RepeatWrapping);assert.equal(view.colorSpace,THREE.SRGBColorSpace);
 const later=source.clone();manager.track(later);const version=later.version;
 view.dispose();const disposedVersion=view.version;
 await manager.change('medium');
 assert.equal(later.image.width,512);assert.ok(later.version>version);assert.equal(view.version,disposedVersion,'disposed clones leave the upload registry');
 assert.equal(releases,2,'a disposed clone is not retained/released on subsequent switches');assert.equal(decoded[0].image.closed,1);
 assert.throws(()=>manager.setInitialTier('low'),/before preloading/);
});

test('a failed multi-asset batch leaves every live image and tier intact and releases successful siblings',async()=>{
 const temporary=texture(256);
 const manager=new AssetTierManager(async path=>{if(path==='b.glb')throw Error('network failure');return[temporary];});
 const a=texture(1024),b=texture(1024),aImage=a.image,bImage=b.image;
 manager.register('a.glb',[a]);manager.register('b.glb',[b]);
 await assert.rejects(manager.change('low'),/network failure/);
 assert.equal(manager.getTier(),'high');assert.equal(a.image,aImage);assert.equal(b.image,bImage);assert.equal(aImage.closed,0);assert.equal(bImage.closed,0);assert.equal(temporary.image.closed,1);
});

test('latest request wins without overlapping decoded batches or publishing a stale tier',async()=>{
 const first=deferred<THREE.Texture[]>(),calls:AssetTier[]=[];
 const manager=new AssetTierManager(async(_path,tier)=>{calls.push(tier);return tier==='low'?first.promise:[texture(512)];});
 const source=texture(1024);manager.register('test.glb',[source]);
 const low=manager.change('low');await Promise.resolve();await Promise.resolve();
 const medium=manager.change('medium'),stale=texture(256);
 assert.deepEqual(calls,['low']);first.resolve([stale]);await low;
 assert.equal(manager.getTier(),'high','stale result never becomes visible');assert.equal(stale.image.closed,1);
 await medium;assert.deepEqual(calls,['low','medium']);assert.equal(manager.getTier(),'medium');assert.equal(source.image.width,512);
});

test('selecting the current tier cancels an in-flight change without refetching current assets',async()=>{
 const pending=deferred<THREE.Texture[]>();let calls=0;
 const manager=new AssetTierManager(async()=>{calls++;return pending.promise;});
 const source=texture(1024);manager.register('test.glb',[source]);
 const low=manager.change('low');await Promise.resolve();await Promise.resolve();
 const high=manager.change('high'),stale=texture(256);pending.resolve([stale]);
 await Promise.all([low,high]);assert.equal(calls,1);assert.equal(manager.getTier(),'high');assert.equal(source.image.width,1024);assert.equal(stale.image.closed,1);
});
