import * as THREE from 'three';

// The bolt has its own rearward travel, in addition to the whole rifle's
// recoil. Keep four centimetres beyond the weapon camera's near plane even
// when a hit adds recoil at the most rearward point of the cycle.
export const ADS_BOLT_NEAR_MARGIN=.04;
const boltMeshes=new WeakMap<THREE.Object3D,THREE.Mesh[]>();
const cameraFromMesh=new THREE.Matrix4(),cameraInverse=new THREE.Matrix4();
const bounds=new THREE.Box3(),position=new THREE.Vector3(),forward=new THREE.Vector3();

/** Presentation-only: constrain the animated source bolt, then move the
 * entire held item along the camera axis so its hands and muzzle stay attached.
 * Absolute poses are rebuilt each frame; no correction accumulates. Geometry
 * bounds are cached, so this inspects eight corners per mesh, not its vertices.
 */
export function keepADSBoltInFront(weapon:THREE.Object3D,rifle:THREE.Object3D,camera:THREE.PerspectiveCamera,ads:number):number {
 if(ads<=0)return 0;
 const bolt=rifle.getObjectByName('bolt');if(!bolt)return 0;
 let meshes=boltMeshes.get(bolt);
 if(!meshes){
  meshes=[];bolt.traverse(object=>{if(object instanceof THREE.Mesh){object.geometry.computeBoundingBox();meshes!.push(object);}});
  boltMeshes.set(bolt,meshes);
 }
 camera.updateWorldMatrix(true,false);cameraInverse.copy(camera.matrixWorld).invert();
 weapon.updateWorldMatrix(true,true);
 let rearZ=-Infinity;
 for(const mesh of meshes){
  if(!mesh.geometry.boundingBox)continue;
  cameraFromMesh.multiplyMatrices(cameraInverse,mesh.matrixWorld);
  rearZ=Math.max(rearZ,bounds.copy(mesh.geometry.boundingBox).applyMatrix4(cameraFromMesh).max.z);
 }
 const correction=Math.max(0,rearZ+camera.near+ADS_BOLT_NEAR_MARGIN);
 if(correction>0){
  position.setFromMatrixPosition(weapon.matrixWorld);
  forward.set(0,0,-1).transformDirection(camera.matrixWorld);
  position.addScaledVector(forward,correction);
  if(weapon.parent)weapon.parent.worldToLocal(position);
  weapon.position.copy(position);weapon.updateWorldMatrix(false,true);
 }
 return correction;
}
