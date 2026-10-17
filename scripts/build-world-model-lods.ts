/** Bake index-only world LODs from the final fitted rigs. Run after source mesh
 * or fitting changes: node --import tsx scripts/build-world-model-lods.ts
 * meshoptimizer 0.22 is pinned as a build-only dependency; never shipped to the game. */
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {MeshoptSimplifier} from 'meshoptimizer';
import {loadHandAssetFromBuffer} from '../src/hands.ts';
import {loadSoldierModelFromBuffer} from '../src/soldierModelAssets.ts';
import {loadImportedWeaponFromBuffer,loadImportedGrenadeFromBuffer} from '../src/importedWeapons.ts';
import {makeSoldier} from '../src/soldier.ts';
import {geometryFingerprint,worldLodMeshes,type LodManifest} from '../src/worldModelLod.ts';
import {FACTIONS} from '../src/config.ts';
const bytes=(path:string)=>{const file=readFileSync(`public/assets/${path}`);return file.buffer.slice(file.byteOffset,file.byteOffset+file.byteLength) as ArrayBuffer;};
const json=(path:string)=>JSON.parse(readFileSync(`public/assets/${path}`,'utf8'));
const loader=new GLTFLoader();loader.register(()=>({name:'lod-image-stubs',loadTexture:()=>Promise.resolve(new THREE.Texture())}));
for(const side of ['left','right'] as const)await loadHandAssetFromBuffer(side,bytes(`arms/hand-${side[0]}.glb`),loader);
await loadImportedGrenadeFromBuffer(bytes('models/imported-stielhandgranate.glb'),loader);
for(const [faction,weapon]of Object.entries({british:'enfield',russian:'mosin',german:'kar98k'})){
 await loadImportedWeaponFromBuffer(bytes(`imported-weapons/${weapon}.glb`),json(`imported-weapons/${weapon}-profile.json`),loader);
 await loadSoldierModelFromBuffer(bytes(`imported-soldiers/${faction}.glb`),json(`imported-soldiers/${faction}-profile.json`),loader);
}
await MeshoptSimplifier.ready;MeshoptSimplifier.useExperimentalFeatures=true;
const manifest:LodManifest={version:1,surfaces:[]},chunks:Uint8Array[]=[],stored=new Map<string,number>(),report:{key:string;triangles:number[];errors:number[]}[]=[];let offset=0;
for(const faction of FACTIONS)for(const {key,mesh}of worldLodMeshes(makeSoldier(faction),faction)){
 const geometry=mesh.geometry,position=geometry.getAttribute('position');if(!geometry.index||geometry.index.count<600)continue;
 const positions=new Float32Array(position.count*3);for(let i=0;i<position.count;i++)positions.set([position.getX(i),position.getY(i),position.getZ(i)],i*3);
 const skin=geometry.getAttribute('skinIndex'),weights=geometry.getAttribute('skinWeight'),uv=geometry.getAttribute('uv'),normal=geometry.getAttribute('normal');
 const bones=mesh instanceof THREE.SkinnedMesh?mesh.skeleton.bones.length:0,stride=5+bones;
 if(stride>32)throw new Error(`Too many skin attributes: ${key}`);
 const attributes=new Float32Array(position.count*stride);
 for(let i=0;i<position.count;i++){
  if(normal)attributes.set([normal.getX(i),normal.getY(i),normal.getZ(i)],i*stride);
  if(uv)attributes.set([uv.getX(i),uv.getY(i)],i*stride+3);
  if(skin&&weights)for(let j=0;j<4;j++)attributes[i*stride+5+skin.getComponent(i,j)]+=weights.getComponent(i,j);
 }
 const attributeWeights=[.01,.01,.01,.05,.05,...Array(bones).fill(1)];
 const groups=geometry.groups.length?geometry.groups:[{start:0,count:geometry.index.count,materialIndex:0}];
 const levels:LodManifest['surfaces'][number]['levels']=[],errors:number[]=[],triangles=[geometry.index.count/3];
 for(const [fraction,error]of [[.55,.003],[.28,.009]]){
  const selected:number[]=[],selectedGroups:THREE.BufferGeometry['groups']=[];let worst=0;
  for(const group of groups){
   const indices=new Uint32Array(group.count);for(let i=0;i<group.count;i++)indices[i]=geometry.index.getX(group.start+i);
   const [simplified,actual]=MeshoptSimplifier.simplifyWithAttributes(indices,positions,3,attributes,stride,attributeWeights,null,Math.max(3,Math.floor(group.count*fraction/3)*3),error,['LockBorder']);
   selectedGroups.push({start:selected.length,count:simplified.length,materialIndex:group.materialIndex});for(const index of simplified)selected.push(index);worst=Math.max(worst,actual);
  }
  const data=position.count<=65535?new Uint16Array(selected):new Uint32Array(selected),bytes=data.BYTES_PER_ELEMENT as 2|4,raw=new Uint8Array(data.buffer),hash=createHash('sha256').update(raw).digest('hex');
  let location=stored.get(hash);
  if(location===undefined){const padding=(4-offset%4)%4;if(padding){chunks.push(new Uint8Array(padding));offset+=padding;}location=offset;chunks.push(raw);offset+=raw.byteLength;stored.set(hash,location);}
  levels.push({offset:location,count:data.length,bytes,groups:selectedGroups});triangles.push(data.length/3);errors.push(worst);
 }
 manifest.surfaces.push({key,fingerprint:geometryFingerprint(geometry),levels});report.push({key,triangles,errors});
}
let header=JSON.stringify(manifest);header+=' '.repeat((4-new TextEncoder().encode(header).length%4)%4);
const encoded=new TextEncoder().encode(header),buffer=Buffer.alloc(8+encoded.length+offset);buffer.writeUInt32LE(0x31444f4c,0);buffer.writeUInt32LE(encoded.length,4);buffer.set(encoded,8);let cursor=8+encoded.length;
for(const chunk of chunks){buffer.set(chunk,cursor);cursor+=chunk.byteLength;}
mkdirSync('public/assets/lod',{recursive:true});writeFileSync('public/assets/lod/world-models.bin',buffer);
mkdirSync('temp/performance-implementation',{recursive:true});writeFileSync('temp/performance-implementation/world-lod-build.json',JSON.stringify({bytes:buffer.length,surfaces:report,totals:[0,1,2].map(level=>report.reduce((sum,surface)=>sum+surface.triangles[level],0))},null,2)+'\n');
console.log(JSON.stringify({bytes:buffer.length,surfaces:report.length,triangles:[0,1,2].map(level=>report.reduce((sum,surface)=>sum+surface.triangles[level],0))}));
