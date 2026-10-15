/** Export only the skin influences needed for exact palm/thumb contact FK.
 * node --import tsx scripts/generate-hand-collision-data.ts */
import fs from 'node:fs';
import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {loadHandAssetFromBuffer} from '../src/hands.ts';
import {makeSoldierHand} from '../src/soldierHands.ts';
const loader=new GLTFLoader();loader.register(()=>({name:'contact-data-textures',loadTexture:()=>Promise.resolve(new THREE.Texture())}));
const data:Record<string,unknown>={};
for(const side of ['left','right'] as const){
 const bytes=fs.readFileSync(`public/assets/arms/hand-${side[0]}.glb`);
 await loadHandAssetFromBuffer(side,bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),loader);
 const binding=makeSoldierHand(side)!;const parent=new THREE.Group();parent.add(binding.frame);parent.updateMatrixWorld(true);
 const nodes:THREE.Object3D[]=[];binding.frame.traverse(object=>nodes.push(object));
 const selected=[binding.palm,binding.hand.userData.thumbContact].filter(Boolean) as Array<{mesh:THREE.SkinnedMesh;index:number}>;
 // Retain ancestor paths only; no meshes, textures, or renderer resources.
 const needed=new Set<THREE.Object3D>();
 for(const {mesh,index}of selected){const ids=mesh.geometry.getAttribute('skinIndex'),weights=mesh.geometry.getAttribute('skinWeight');
  for(let i=0;i<4;i++)if(weights.getComponent(index,i)>0){let node:THREE.Object3D|null=mesh.skeleton.bones[ids.getComponent(index,i)];while(node&&node!==parent){needed.add(node);node=node.parent;}}
 }
 const chain=nodes.filter(node=>needed.has(node));
 const vertex=(selected:{mesh:THREE.SkinnedMesh;index:number}|undefined)=>{
  if(!selected)return undefined;const{mesh,index}=selected,ids=mesh.geometry.getAttribute('skinIndex'),weights=mesh.geometry.getAttribute('skinWeight');
  const point=new THREE.Vector3().fromBufferAttribute(mesh.geometry.getAttribute('position'),index).applyMatrix4(mesh.bindMatrix);
  return Array.from({length:4},(_,i)=>{const bone=ids.getComponent(index,i);return{node:chain.indexOf(mesh.skeleton.bones[bone]),point:point.clone().applyMatrix4(mesh.skeleton.boneInverses[bone]).toArray(),weight:weights.getComponent(index,i)};}).filter(v=>v.weight>0);
 };
 data[side]={normal:binding.normal.toArray(),stockGrip:!!binding.hand.userData.stockGrip,nodes:chain.map(node=>({parent:chain.indexOf(node.parent!),name:node instanceof THREE.Bone?node.name.replace(/[._]/g,''):'',position:node.position.toArray(),rotation:(node.userData.restQuaternion??node.quaternion).toArray(),scale:node.scale.toArray(),stockThumbAxis:node.userData.stockThumbAxis?.toArray(),supportThumbAxis:node.userData.supportThumbAxis?.toArray()})),palm:vertex(binding.palm),thumb:vertex(binding.hand.userData.thumbContact)};
}
fs.writeFileSync('src/generated/handCollisionData.json',JSON.stringify(data));
console.log('Wrote exact selected hand-contact transforms.');
