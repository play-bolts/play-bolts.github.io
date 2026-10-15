import test,{before} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {loadHandAssetFromBuffer} from '../src/hands.ts';
import {makeStielhandgranate} from '../src/grenadeModel.ts';
import {applyGrenadePose,sampleGrenadeMelee} from '../src/weaponAnimation.ts';
import {defaultWeaponBodyMatrix,VIEWMODEL_GRENADE_POSITION,VIEWMODEL_SHOULDERS,VIEWMODEL_UPPER_ARM,VIEWMODEL_FOREARM} from '../src/viewmodelArms.ts';

before(async()=>{
 const loader=new GLTFLoader();loader.register(()=>({name:'test-textures',loadTexture:()=>Promise.resolve(new THREE.Texture())}));
 for(const side of ['left','right']as const){const bytes=readFileSync(new URL(`../public/assets/arms/hand-${side[0]}.glb`,import.meta.url));await loadHandAssetFromBuffer(side,bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength)as ArrayBuffer,loader);}
});

test('grenade bash has continuous cloth from a fixed shoulder to the actual skin wrist',()=>{
 const item=makeStielhandgranate('german',true),rig=item.userData.grenadeRig,arm=rig.rightArm;
 const positions=arm.mesh.geometry.getAttribute('position'),lastY=VIEWMODEL_UPPER_ARM+VIEWMODEL_FOREARM;
 const cuffVertices:number[]=[];for(let i=0;i<positions.count;i++)if(Math.abs(positions.getY(i)-lastY)<1e-6)cuffVertices.push(i);
 // Open garment ends are outside the visible skin: no forearm cap can appear
 // as a detached disc when the bash brings the elbow into the viewport.
 const indices=arm.mesh.geometry.index!;for(let i=0;i<indices.count;i+=3){
  const ys=[0,1,2].map(k=>positions.getY(indices.getX(i+k)));
  assert.ok(!ys.every(y=>Math.abs(y-lastY)<1e-6)&&!ys.every(y=>Math.abs(y)<1e-6),'continuous sleeve has no cut-off end cap');
 }
 let referenceGrip:THREE.Matrix4|undefined;
 for(let i=0;i<=100;i++){
  const pose=sampleGrenadeMelee(i/100),body=defaultWeaponBodyMatrix(VIEWMODEL_GRENADE_POSITION.map((v,k)=>v+pose.position[k]),pose.rotation);
  applyGrenadePose(item,pose,body);item.updateMatrixWorld(true);arm.mesh.skeleton.update();
  const joint=(bone:THREE.Bone)=>bone.getWorldPosition(new THREE.Vector3()).applyMatrix4(body);
  const shoulder=joint(arm.upper),elbow=joint(arm.lower),wrist=joint(arm.cuff);
  assert.ok(shoulder.distanceTo(VIEWMODEL_SHOULDERS.right)<1e-7,'body anchor does not follow the weapon swing');
  assert.ok(Math.abs(shoulder.distanceTo(elbow)-VIEWMODEL_UPPER_ARM)<1e-7);
  assert.ok(Math.abs(elbow.distanceTo(wrist)-VIEWMODEL_FOREARM)<1e-7);
  const skinWrist=rig.right.localToWorld(rig.right.userData.wristLocal.clone()).applyMatrix4(body);
  assert.ok(wrist.distanceTo(skinWrist)<1e-7,'skin and physical sleeve meet through the whole bash');
  assert.ok(arm.wristBend<32*Math.PI/180,'handle grip has no folded wrist');
  const centroid=new THREE.Vector3();
  // The UV seam duplicates one rim vertex; omit the duplicate for an exact
  // center rather than biasing the average toward the cloth seam.
  for(const vertex of cuffVertices.slice(0,-1))centroid.add(arm.mesh.localToWorld(arm.mesh.applyBoneTransform(vertex,new THREE.Vector3().fromBufferAttribute(positions,vertex))));
  centroid.divideScalar(cuffVertices.length-1).applyMatrix4(body);
  assert.ok(centroid.distanceTo(wrist)<1e-6,'actual deformed cloth rim stays centered on the wrist');
  const relative=rig.right.matrixWorld.clone().invert().multiply(rig.grenade.matrixWorld);
  if(!referenceGrip)referenceGrip=relative;else relative.elements.forEach((v:number,k:number)=>assert.ok(Math.abs(v-referenceGrip!.elements[k])<1e-7,'handle never slips in the fingers'));
 }
 const pose=sampleGrenadeMelee(.23);applyGrenadePose(item,pose);item.updateMatrixWorld(true);
 const objects=[rig.right,rig.grenade,...arm.mesh.skeleton.bones],transforms=objects.map((object:THREE.Object3D)=>object.matrix.toArray());
 applyGrenadePose(item,sampleGrenadeMelee(.5));applyGrenadePose(item,pose);item.updateMatrixWorld(true);
 objects.forEach((object:THREE.Object3D,i:number)=>assert.deepEqual(object.matrix.toArray(),transforms[i],'scrubbing restores the exact complete arm pose'));
});
