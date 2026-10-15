import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';

let headTemplate:THREE.Group|null=null;
let loading:Promise<void>|null=null;

/** Load once before constructing the view. No network dependency after deployment. */
export function preloadHumanHead():Promise<void> {
 if(!loading)loading=new GLTFLoader().loadAsync(`${import.meta.env.BASE_URL}assets/makehuman/human-head.glb`).then(gltf=>{headTemplate=gltf.scene;});
 return loading;
}

/** Face +Z; chin near y=.022, scalp .289 m; capped neck extends to y=-.05. */
export function makeHumanHead():THREE.Group|null {
 if(!headTemplate)return null;
 const head=headTemplate.clone(true);head.name='anatomical-head';
 const geometryCopies=new Map<THREE.BufferGeometry,THREE.BufferGeometry>();
 const materialCopies=new Map<THREE.Material,THREE.Material>();
 const textureCopies=new Map<THREE.Texture,THREE.Texture>();
 const copyMaterial=(source:THREE.Material)=>{
  let material=materialCopies.get(source);
  if(!material){
   material=source.clone();materialCopies.set(source,material);
   if(material instanceof THREE.MeshStandardMaterial){
    for(const key of ['map','normalMap','roughnessMap','metalnessMap','aoMap','emissiveMap'] as const){
     const original=material[key];if(!original)continue;
     let texture=textureCopies.get(original);if(!texture){texture=original.clone();texture.anisotropy=4;texture.needsUpdate=true;textureCopies.set(original,texture);}material[key]=texture;
    }
   }
  }
  return material;
 };
 head.traverse(object=>{
  if(object instanceof THREE.Mesh){
   const sourceGeometry:THREE.BufferGeometry=object.geometry;
   const geometry=geometryCopies.get(sourceGeometry)??sourceGeometry.clone();geometryCopies.set(sourceGeometry,geometry);object.geometry=geometry;
   object.material=Array.isArray(object.material)?object.material.map(copyMaterial):copyMaterial(object.material);
   object.castShadow=object.receiveShadow=true;
  }
 });
 return head;
}
