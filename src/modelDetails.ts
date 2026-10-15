import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {preloadSoldierModels} from './soldierModelAssets';

const meshes=new Map<string,THREE.BufferGeometry>();
let loading:Promise<void>|undefined;

function registerDetails(scene:THREE.Group) {
  scene.updateMatrixWorld(true);
  scene.traverse(object=>{
    if(!(object instanceof THREE.Mesh))return;
    const geometry=object.geometry.clone().applyMatrix4(object.matrixWorld);
    geometry.computeBoundingBox();geometry.computeBoundingSphere();meshes.get(object.name)?.dispose();meshes.set(object.name,geometry);
    object.geometry.dispose();
    for(const material of Array.isArray(object.material)?object.material:[object.material])material.dispose();
  });
}

/** The offline model validator uses the same parser and assembly as the app. */
export async function loadModelDetailsFromBuffer(buffer:ArrayBuffer):Promise<void> {
  const gltf=await new GLTFLoader().parseAsync(buffer,'');registerDetails(gltf.scene);
}

/** Geometry-only Blender details reuse loaded walnut, steel and cloth maps. */
export function preloadModelDetails():Promise<void> {
  if(typeof window==='undefined')return Promise.resolve();
  return loading??=Promise.all([new GLTFLoader().loadAsync(`${import.meta.env?.BASE_URL??'/'}assets/details/model-details.glb`).then(gltf=>registerDetails(gltf.scene)),preloadSoldierModels()]).then(()=>{});
}

/** Independent geometry copies keep per-actor batching/disposal safe. */
export function makeModelDetail(name:string,material:THREE.Material):THREE.Mesh|null {
  const source=meshes.get(name);if(!source)return null;
  const mesh=new THREE.Mesh(source.clone(),material);mesh.name=name;mesh.castShadow=mesh.receiveShadow=true;return mesh;
}
