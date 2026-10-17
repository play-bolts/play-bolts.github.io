import * as THREE from 'three';
import type {Faction} from './config';
import {lodGeometrySource} from './lodGeometryIdentity';

export interface LodSurface {key:string;fingerprint:string;levels:{offset:number;count:number;bytes:2|4;groups:THREE.BufferGeometry['groups']}[];}
export interface LodManifest {version:1;surfaces:LodSurface[];}
type Source={fingerprint:string;maxIndex:number;levels:{index:THREE.BufferAttribute;groups:THREE.BufferGeometry['groups']}[]};
const sources=new Map<string,Source>();
let validatedSources=new WeakMap<THREE.BufferGeometry,Map<string,{fingerprint:string;valid:boolean}>>();
const models=new WeakMap<THREE.Group,{level:number;meshes:{mesh:THREE.Mesh;geometries:THREE.BufferGeometry[]}[]}>();
let loading:Promise<void>|undefined;

/** Includes all attributes used by skinning/contact queries. An outdated bake
 * falls back to the original mesh instead of connecting incompatible vertices. */
export function geometryFingerprint(geometry:THREE.BufferGeometry){
 let hash=2166136261;
 const add=(value:number)=>{hash=Math.imul(hash^value,16777619)>>>0;};
 for(const name of Object.keys(geometry.attributes).sort()){
  for(const char of name)add(char.charCodeAt(0));
  const attribute=geometry.getAttribute(name);add(attribute.itemSize);add(attribute.count);
  // BufferAttribute and InterleavedBufferAttribute both expose logical values.
  const data=new Float32Array(attribute.count*attribute.itemSize);
  for(let i=0;i<attribute.count;i++)for(let j=0;j<attribute.itemSize;j++)data[i*attribute.itemSize+j]=attribute.getComponent(i,j);
  for(const byte of new Uint8Array(data.buffer))add(byte);
 }
 const index=geometry.index;
 if(index)for(let i=0;i<index.count;i++){const n=index.getX(i);add(n&255);add((n>>>8)&255);add((n>>>16)&255);add(n>>>24);}
 for(const group of geometry.groups){add(group.start);add(group.count);add(group.materialIndex??0);}
 return hash.toString(16).padStart(8,'0');
}

export function worldLodMeshes(model:THREE.Group,faction:Faction){
 const meshes:{key:string;mesh:THREE.Mesh}[]=[];let index=0;
 model.traverse(object=>{if(object instanceof THREE.Mesh)meshes.push({key:`${faction}/${index++}/${object.name}`,mesh:object});});
 return meshes;
}

/** Small index-only bake; positions, normals, UVs, bone weights and gameplay
 * contact vertices continue to use the original source buffers. */
export function loadWorldModelLods(buffer:ArrayBuffer){
 const view=new DataView(buffer);if(buffer.byteLength<8||view.getUint32(0,true)!==0x31444f4c)throw new Error('Invalid world LOD data');
 const jsonBytes=view.getUint32(4,true),start=8+jsonBytes;
 if(start>buffer.byteLength||start%4)throw new Error('Invalid world LOD header');
 const manifest=JSON.parse(new TextDecoder().decode(new Uint8Array(buffer,8,jsonBytes))) as LodManifest;
 if(manifest.version!==1||!Array.isArray(manifest.surfaces))throw new Error('Unsupported world LOD data');
 const next=new Map<string,Source>();
 for(const surface of manifest.surfaces){
  const levels=surface.levels.map(level=>{
   if(![2,4].includes(level.bytes)||!Number.isInteger(level.offset)||!Number.isInteger(level.count)||level.offset<0||level.offset%level.bytes||level.count<3||level.count%3||start+level.offset+level.count*level.bytes>buffer.byteLength)throw new Error('Invalid world LOD index range');
   const index=level.bytes===2?new THREE.Uint16BufferAttribute(new Uint16Array(buffer,start+level.offset,level.count),1):new THREE.Uint32BufferAttribute(new Uint32Array(buffer,start+level.offset,level.count),1);
   if(!Array.isArray(level.groups)||level.groups.some(group=>!Number.isInteger(group.start)||!Number.isInteger(group.count)||group.start<0||group.count<0||group.start+group.count>level.count))throw new Error('Invalid world LOD groups');
   return{index,groups:level.groups};
  });
  let maxIndex=0;for(const level of levels)for(let i=0;i<level.index.count;i++)maxIndex=Math.max(maxIndex,level.index.getX(i));
  next.set(surface.key,{fingerprint:surface.fingerprint,maxIndex,levels});
 }
 sources.clear();validatedSources=new WeakMap();for(const [key,value]of next)sources.set(key,value);
}
export function preloadWorldModelLods(){
 if(typeof window==='undefined')return Promise.resolve();
 // Detail reduction is optional: a missing/stale sidecar must not prevent play.
 return loading??=fetch(`${import.meta.env?.BASE_URL??'/'}assets/lod/world-models.bin`).then(async response=>{if(!response.ok)throw new Error('World LOD unavailable');loadWorldModelLods(await response.arrayBuffer());}).catch(error=>{console.warn('Using original world model detail:',error);});
}

export function prepareWorldModelLods(model:THREE.Group,faction:Faction){
 if(models.has(model))return;
 const meshes:{mesh:THREE.Mesh;geometries:THREE.BufferGeometry[]}[]=[];
 for(const {key,mesh}of worldLodMeshes(model,faction)){
  const source=sources.get(key),base=mesh.geometry;
  if(!source||Object.keys(base.morphAttributes).length||base.drawRange.start!==0||base.drawRange.count!==Infinity||Object.values(base.attributes).some(attribute=>attribute instanceof THREE.BufferAttribute&&attribute.usage!==THREE.StaticDrawUsage))continue;
  const original=lodGeometrySource(base),checks=original?(validatedSources.get(original)??new Map<string,{fingerprint:string;valid:boolean}>()):undefined;
  const layout=`${key}:${base.index?.count}:${base.getAttribute('position').count}:${Object.keys(base.attributes).sort().join(',')}`;
  const known=checks?.get(layout),valid=known?.fingerprint===source.fingerprint?known.valid:source.fingerprint===geometryFingerprint(base);
  if(original&&checks){checks.set(layout,{fingerprint:source.fingerprint,valid});validatedSources.set(original,checks);}
  if(!valid)continue;
  const vertexCount=base.getAttribute('position').count;
  if(source.maxIndex>=vertexCount)continue;
  const geometries=[base,...source.levels.map(level=>{
   const geometry=new THREE.BufferGeometry();
   for(const [name,attribute]of Object.entries(base.attributes))geometry.setAttribute(name,attribute);
   geometry.setIndex(level.index.clone());geometry.groups=level.groups.map(group=>({...group}));
   geometry.boundingBox=base.boundingBox?.clone()??null;geometry.boundingSphere=base.boundingSphere?.clone()??null;
   return geometry;
  })];
  meshes.push({mesh,geometries});
 }
 models.set(model,{level:0,meshes});
}

/** A zoomed-in opponent keeps close-range detail. Hysteresis prevents flicker
 * while a player or camera moves around a transition boundary. */
export function worldLodLevel(distance:number,fov:number,pixelHeight:number,quality:string,previous=0){
 const projectedDistance=distance*Math.tan(fov*Math.PI/360)/Math.tan(72*Math.PI/360)*720/Math.max(240,pixelHeight);
 const limits=quality==='low'?[8,18]:quality==='medium'?[12,26]:[18,38];
 let level=previous;
 while(level<2&&projectedDistance>limits[level]*1.1)level++;
 while(level>0&&projectedDistance<limits[level-1]*.9)level--;
 return level;
}
export function setWorldModelLod(model:THREE.Group,level:number){
 const data=models.get(model);if(!data||data.level===level)return false;
 data.level=level;for(const entry of data.meshes)entry.mesh.geometry=entry.geometries[Math.min(level,entry.geometries.length-1)];
 return data.meshes.length>0;
}
export function updateWorldModelLod(model:THREE.Group,distance:number,fov:number,pixelHeight:number,quality:string){
 const data=models.get(model);return data?setWorldModelLod(model,worldLodLevel(distance,fov,pixelHeight,quality,data.level)):false;
}
export function disposeWorldModelLods(model:THREE.Group){
 const data=models.get(model);if(!data)return;
 // Normal model disposal owns level zero; dispose every alternate even if it
 // is not currently attached, then restore the original geometry for cleanup.
 for(const entry of data.meshes){entry.mesh.geometry=entry.geometries[0];for(const geometry of entry.geometries.slice(1))geometry.dispose();}
 models.delete(model);
}
