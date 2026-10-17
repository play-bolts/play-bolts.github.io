/**
 * Reproduce the CPU animation microbenchmark:
 *   node --import tsx scripts/performance-animation-audit.ts
 *
 * Loads the shipped meshes and real animation code, but replaces GLTF image
 * decoding with empty THREE.Texture instances. Runs in Node/V8 without a DOM,
 * WebGL uploads, rendering, AI, audio or networking. These are synchronous CPU
 * microbenchmarks, NOT browser frame times, GPU times, or device FPS estimates.
 * Run without other benchmarks competing for CPU. First-use/JIT and GC tails
 * remain visible; compare repeated runs and corroborate in a browser trace.
 * Results are written to temp/performance-audit/animation-node-microbenchmark.json.
 */
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {loadHandAssetFromBuffer} from '../src/hands.ts';
import {loadSoldierModelFromBuffer} from '../src/soldierModelAssets.ts';
import {loadImportedWeaponFromBuffer,loadImportedGrenadeFromBuffer} from '../src/importedWeapons.ts';
import {makeSoldier} from '../src/soldier.ts';
import {updateSoldier,type SoldierActor} from '../src/soldierAnimation.ts';
import type {Faction} from '../src/config.ts';

const root=new URL('../',import.meta.url);
const bytes=(path:string)=>{
 const buffer=readFileSync(new URL(`public/assets/${path}`,root));
 return buffer.buffer.slice(buffer.byteOffset,buffer.byteOffset+buffer.byteLength) as ArrayBuffer;
};
const json=(path:string)=>JSON.parse(readFileSync(new URL(`public/assets/${path}`,root),'utf8'));
const loader=new GLTFLoader();
loader.register(()=>({name:'profile-image-stubs',loadTexture:()=>Promise.resolve(new THREE.Texture())}));
for(const side of ['left','right'] as const)await loadHandAssetFromBuffer(side,bytes(`arms/hand-${side[0]}.glb`),loader);
await loadImportedGrenadeFromBuffer(bytes('models/imported-stielhandgranate.glb'),loader);
for(const [faction,weapon] of Object.entries({british:'enfield',russian:'mosin',german:'kar98k'})){
 await loadImportedWeaponFromBuffer(bytes(`imported-weapons/${weapon}.glb`),json(`imported-weapons/${weapon}-profile.json`),loader);
 await loadSoldierModelFromBuffer(bytes(`imported-soldiers/${faction}.glb`),json(`imported-soldiers/${faction}-profile.json`),loader);
}
const stats=(values:number[])=>{
 const sorted=[...values].sort((a,b)=>a-b);
 return {mean:values.reduce((a,b)=>a+b,0)/values.length,p50:sorted[Math.floor(sorted.length*.5)],p95:sorted[Math.floor(sorted.length*.95)],p99:sorted[Math.floor(sorted.length*.99)],max:sorted.at(-1)};
};
const results=[];
for(const faction of ['british','russian','german'] as Faction[])for(let repeat=0;repeat<3;repeat++){
 const start=performance.now(),model=makeSoldier(faction),construction=performance.now()-start;
 const actor:SoldierActor={id:1,x:0,y:0,z:0,yaw:0,pitch:0,stance:'stand',alive:true,moving:2,ads:false,recoil:0,cooldown:0,reload:0,reloadTotal:2,selectedWeapon:'rifle',hp:100};
 const run=(frames:number,applyPose:boolean,offset:number)=>{
  const times:number[]=[];
  for(let i=0;i<frames;i++){
   // Root movement is included in every phase. The settled phase keeps the
   // root moving to isolate repeated local corpse-pose work from root updates.
   actor.x+=.01;const before=performance.now();
   updateSoldier(model,actor,1/60,offset+i/60,applyPose);
   times.push(performance.now()-before);
  }
  return stats(times);
 };
 run(200,true,0);
 const alive=run(600,true,4),hidden=run(600,false,14);
 actor.alive=false;actor.hp=0;actor.moving=0;actor.deadAt=25;
 const deathFrames:number[]=[];
 for(let i=0;i<100;i++){
  const before=performance.now();updateSoldier(model,actor,1/60,25+i/60,true);
  deathFrames.push(performance.now()-before);
 }
 const settled=run(600,true,27);
 const geometries=new Set<THREE.BufferGeometry>(),materials=new Set<THREE.Material>();
 let triangles=0,meshes=0,drawGroups=0;
 model.traverse(object=>{
  if(!(object instanceof THREE.Mesh))return;
  geometries.add(object.geometry);
  for(const material of Array.isArray(object.material)?object.material:[object.material])materials.add(material);
  meshes++;drawGroups+=Math.max(1,object.geometry.groups.length);
  triangles+=(object.geometry.index?.count??object.geometry.attributes.position.count)/3;
 });
 const bufferBytes=[...geometries].reduce((sum,geometry)=>sum+(geometry.index?.array.byteLength??0)+Object.values(geometry.attributes).reduce((sum,attribute)=>sum+attribute.array.byteLength,0),0);
 // allChildren includes invisible props; drawGroups is source group count,
 // not observed draw calls. It cannot be compared directly to renderer.info.
 results.push({faction,repeat,constructionMs:construction,alive,hidden,firstDeathFirst100:stats(deathFrames),firstDeathWorstFrame:deathFrames.indexOf(Math.max(...deathFrames)),settled,allChildren:{meshes,drawGroups,triangles,geometries:geometries.size,materials:materials.size,bufferBytes}});
}
const report={method:'Node/V8 CPU microbenchmark, actual rigs and source geometry, image textures stubbed, no browser or GPU, 200 warmup frames, 600 measurement frames; not end-to-end FPS',node:process.version,results};
const output=new URL('temp/performance-audit/',root);mkdirSync(output,{recursive:true});
writeFileSync(new URL('animation-node-microbenchmark.json',output),JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
