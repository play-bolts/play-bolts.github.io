import test,{before} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {FACTIONS} from '../src/config.ts';
import {loadHandAssetFromBuffer} from '../src/hands.ts';
import {loadSoldierModelFromBuffer} from '../src/soldierModelAssets.ts';
import {loadImportedWeaponFromBuffer,loadImportedGrenadeFromBuffer} from '../src/importedWeapons.ts';
import {makeSoldier} from '../src/soldier.ts';
import {loadWorldModelLods,prepareWorldModelLods,setWorldModelLod,disposeWorldModelLods,worldLodLevel,worldLodMeshes} from '../src/worldModelLod.ts';
const bytes=(path:string)=>{const data=readFileSync(`public/assets/${path}`);return data.buffer.slice(data.byteOffset,data.byteOffset+data.byteLength) as ArrayBuffer;};
const json=(path:string)=>JSON.parse(readFileSync(`public/assets/${path}`,'utf8'));
before(async()=>{
 const loader=new GLTFLoader();loader.register(()=>({name:'lod-test-textures',loadTexture:()=>Promise.resolve(new THREE.Texture())}));
 for(const side of ['left','right'] as const)await loadHandAssetFromBuffer(side,bytes(`arms/hand-${side[0]}.glb`),loader);
 await loadImportedGrenadeFromBuffer(bytes('models/imported-stielhandgranate.glb'),loader);
 for(const [faction,weapon]of Object.entries({british:'enfield',russian:'mosin',german:'kar98k'})){
  await loadImportedWeaponFromBuffer(bytes(`imported-weapons/${weapon}.glb`),json(`imported-weapons/${weapon}-profile.json`),loader);
  await loadSoldierModelFromBuffer(bytes(`imported-soldiers/${faction}.glb`),json(`imported-soldiers/${faction}-profile.json`),loader);
 }
 loadWorldModelLods(bytes('lod/world-models.bin'));
});
test('all factions reduce world triangles while preserving exact contact vertices, materials and skin attributes',()=>{
 for(const faction of FACTIONS){
  const model=makeSoldier(faction),meshes=worldLodMeshes(model,faction),originals=meshes.map(({mesh})=>({geometry:mesh.geometry,material:mesh.material,skeleton:mesh instanceof THREE.SkinnedMesh?mesh.skeleton:null}));
  const triangles=()=>meshes.reduce((sum,{mesh})=>sum+(mesh.geometry.index?.count??mesh.geometry.getAttribute('position').count)/3,0),full=triangles();
  prepareWorldModelLods(model,faction);
  for(const level of [1,2]){
   assert.equal(setWorldModelLod(model,level),true);assert.ok(triangles()<full*(level===1?.75:.5),`${faction} level ${level} is a real reduction`);
   for(const [{mesh},source]of meshes.map((entry,i)=>[entry,originals[i]] as const)){
    assert.equal(mesh.material,source.material);
    if(mesh instanceof THREE.SkinnedMesh)assert.equal(mesh.skeleton,source.skeleton);
    for(const name of Object.keys(source.geometry.attributes))assert.equal(mesh.geometry.getAttribute(name),source.geometry.getAttribute(name),'LOD shares the exact original positions, UVs, normals, skin weights and custom attributes');
    const count=mesh.geometry.getAttribute('position').count,index=mesh.geometry.index;
    if(index)for(let i=0;i<index.count;i++)assert.ok(index.getX(i)<count);
    if(mesh.geometry!==source.geometry)assert.equal(mesh.geometry.groups.reduce((sum,group)=>sum+group.count,0),index?.count??0);
   }
  }
  setWorldModelLod(model,0);assert.equal(triangles(),full);
  meshes.forEach(({mesh},i)=>assert.equal(mesh.geometry,originals[i].geometry));
 }
});
test('zoom preserves target detail, and transition hysteresis prevents distance flicker',()=>{
 assert.equal(worldLodLevel(25,72,720,'high',0),1);
 assert.equal(worldLodLevel(25,30,720,'high',0),0,'iron sights retain close-up geometry');
 assert.equal(worldLodLevel(19,72,720,'high',0),0);assert.equal(worldLodLevel(19,72,720,'high',1),1);
 assert.equal(worldLodLevel(15,72,720,'high',1),0);
 assert.equal(worldLodLevel(21,72,720,'low',0),2);
 assert.equal(worldLodLevel(21,72,1440,'low',0),1,'larger projected silhouette retains more detail');
});
test('stale mesh content safely keeps original detail and every alternate geometry is disposed',()=>{
 const model=makeSoldier('british'),meshes=worldLodMeshes(model,'british'),changed=meshes.find(({mesh})=>mesh.geometry.index!.count>1000)!.mesh;
 // A custom edited mesh has no immutable template identity.
 changed.geometry=changed.geometry.clone();changed.geometry.getAttribute('position').setX(0,123);const original=changed.geometry;
 prepareWorldModelLods(model,'british');setWorldModelLod(model,1);assert.equal(changed.geometry,original);
 const alternates=new Set<THREE.BufferGeometry>();
 for(const level of [1,2]){setWorldModelLod(model,level);for(const {mesh}of meshes)if(mesh!==changed)alternates.add(mesh.geometry);}
 let disposed=0;for(const geometry of alternates)geometry.addEventListener('dispose',()=>disposed++);
 disposeWorldModelLods(model);assert.ok(disposed>20);assert.equal(setWorldModelLod(model,1),false);
});
test('malformed LOD data is rejected without replacing valid loaded data',()=>{
 assert.throws(()=>loadWorldModelLods(new ArrayBuffer(12)),/Invalid/);
 const model=makeSoldier('german');prepareWorldModelLods(model,'german');assert.equal(setWorldModelLod(model,2),true);
});
