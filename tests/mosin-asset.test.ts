import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';

const root=new URL('../public/assets/imported-weapons/',import.meta.url);
const file=readFileSync(new URL('mosin.glb',root));
const manifest=JSON.parse(readFileSync(new URL('mosin-provenance.json',root),'utf8'));
const profile=JSON.parse(readFileSync(new URL('mosin-profile.json',root),'utf8'));
const jsonLength=file.readUInt32LE(12);
const doc=JSON.parse(file.subarray(20,20+jsonLength).toString());

test('detailed Mosin ships licensed authored PBR maps within the asset budget',()=>{
 assert.equal(manifest.author,'MaX3Dd');assert.equal(manifest.license,'CC BY 4.0');
 assert.equal(manifest.sourceSha256,'8183dc76e41d2544ae414a183ac7dc00c7e7da94dfd5dbcb08b5b95fb40e84a0');
 assert.equal(profile.sourceUid,'92ede39f23bd40c7982c727dfd7c4be0');
 assert.equal(manifest.outputSha256,createHash('sha256').update(file).digest('hex'));
 assert.equal(manifest.outputBytes,file.length);assert.ok(file.length<8_000_000);
 assert.equal(doc.images.length,3,'scope atlas is excluded; rifle atlas shared by wood and metal');
 assert.ok(manifest.embeddedTextures.every((image:{dimensions:number[]})=>image.dimensions[0]===2048&&image.dimensions[1]===2048));
 for(const material of doc.materials.filter((m:{name:string})=>m.name.includes('MaX3Dd'))){
  assert.ok(material.normalTexture&&material.occlusionTexture);
  assert.ok(material.pbrMetallicRoughness.baseColorTexture&&material.pbrMetallicRoughness.metallicRoughnessTexture);
  assert.equal(material.pbrMetallicRoughness.baseColorFactor,undefined,'authored wood/metal atlas keeps its original colors');
  for(const texture of [material.normalTexture,material.pbrMetallicRoughness.metallicRoughnessTexture]){
   const image=doc.images[doc.textures[texture.index].source],view=doc.bufferViews[image.bufferView];
   const png=file.subarray(28+jsonLength+view.byteOffset,28+jsonLength+view.byteOffset+view.byteLength);
   assert.equal(png.subarray(1,4).toString(),'PNG');assert.equal(png.readUInt32BE(16),2048);assert.equal(png.readUInt32BE(20),2048);
  }
 }
 const triangles=doc.meshes.reduce((sum:number,mesh:any)=>sum+mesh.primitives.reduce((n:number,p:any)=>n+doc.accessors[p.indices].count/3,0),0);
 assert.equal(triangles,manifest.triangles);assert.ok(triangles>=12_000&&triangles<=15_000);
});

test('infantry Mosin keeps a horizontal connected bolt shank and independent animated bolt',async()=>{
 const loader=new GLTFLoader();
 loader.register(()=>({name:'geometry-only-texture-decoder',loadTexture:()=>Promise.resolve(new THREE.Texture())}));
 const scene=(await loader.parseAsync(file.buffer.slice(file.byteOffset,file.byteOffset+file.byteLength) as ArrayBuffer,'')).scene;
 scene.updateMatrixWorld(true);
 const bolt=scene.getObjectByName('bolt'),furniture=scene.getObjectByName('furniture');
 assert.ok(bolt&&furniture&&bolt.parent===furniture.parent,'exact runtime group names survive source-name collisions');
 assert.ok(bolt.position.distanceTo(new THREE.Vector3(...profile.bolt.origin))<1e-7);
 const shank=scene.getObjectByName('infantry-straight-bolt-shank')!;
 assert.ok(shank&&shank.parent===bolt);
 const bounds=new THREE.Box3().setFromObject(shank,true),size=bounds.getSize(new THREE.Vector3());
 assert.ok(size.x>.03&&size.x<.04,'straight shank extends laterally toward the source knob');
 assert.ok(size.y<.01&&size.z<.01,'evaluated source transform prevents a detached vertical cylinder');
 const knob=bolt.localToWorld(new THREE.Vector3(...profile.bolt.knobLocal));
 assert.ok(Math.abs(bounds.max.x-knob.x)<1e-7,'shank reaches inside the knob');
 assert.ok(Math.abs(bounds.getCenter(new THREE.Vector3()).y-knob.y)<1e-7);
 assert.ok(Math.abs(bounds.getCenter(new THREE.Vector3()).z-knob.z)<1e-7);
 assert.equal(scene.getObjectByName('scope_M91_Scope_0'),undefined);assert.equal(scene.getObjectByName('bayonet_M91_0'),undefined);
 let woodenVertices=0;
 furniture.traverse(object=>{if(object instanceof THREE.Mesh&&/walnut/.test((object.material as THREE.Material).name))woodenVertices+=object.geometry.getAttribute('position').count;});
 assert.ok(woodenVertices>2000,'real stock and handguard remain available for skinned hand contact checks');
});
