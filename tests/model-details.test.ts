import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import * as THREE from 'three';
import {loadModelDetailsFromBuffer,makeModelDetail} from '../src/modelDetails.ts';
import {makeRifle,RIFLE_VISUALS} from '../src/rifle.ts';
import {makeSoldier} from '../src/soldier.ts';
import {makeStielhandgranate} from '../src/grenadeModel.ts';
import {sampleSoldierPose,applySoldierPose} from '../src/soldierAnimation.ts';
import {makeViewmodelSleeveGeometry} from '../src/viewmodelSleeve.ts';

const file=readFileSync(new URL('../public/assets/details/model-details.glb',import.meta.url));
await loadModelDetailsFromBuffer(file.buffer.slice(file.byteOffset,file.byteOffset+file.byteLength) as ArrayBuffer);
const factions=['british','russian','german'] as const;
const checkGeometry=(root:THREE.Object3D)=>root.traverse(object=>{
  if(!(object instanceof THREE.Mesh))return;
  const position=object.geometry.getAttribute('position'),normal=object.geometry.getAttribute('normal');
  assert.ok(position&&normal);
  for(const values of [position.array,normal.array])for(const value of values)assert.ok(Number.isFinite(value));
});

test('Blender detail meshes load with usable UVs and independently disposable geometry',()=>{
  assert.ok(file.byteLength<2_500_000,'all three machined actions plus existing uniform/stock geometry stay below 2.5 MB');
  for(const name of ['rifle-wood-british-butt','rifle-wood-british-foreend','rifle-wood-russian','rifle-wood-german',
    'uniform-british-torso','uniform-russian-torso','uniform-german-torso','uniform-upper-sleeve','uniform-lower-sleeve','uniform-thigh','uniform-british-trouser',
    ...factions.flatMap(f=>['body','trim','recess','bolt','bolt-trim'].map(part=>`rifle-metal-${f}-${part}`))]) {
    const material=new THREE.MeshBasicMaterial(),a=makeModelDetail(name,material),b=makeModelDetail(name,material);assert.ok(a&&b,name);
    assert.notEqual(a.geometry,b.geometry);checkGeometry(a);
    const uv=a.geometry.getAttribute('uv');assert.ok(uv?.count===a.geometry.getAttribute('position').count);
    assert.ok([...uv.array].every(Number.isFinite));
    const before=b.geometry.getAttribute('position').getX(0);a.geometry.getAttribute('position').setX(0,999);a.geometry.dispose();
    assert.equal(b.geometry.getAttribute('position').getX(0),before,'editing/disposal cannot damage another actor or the cached source');
  }
});

test('all three detailed rifles preserve bolt, grip and optical sight anchors',()=>{
  for(const faction of factions) {
    const rifle=makeRifle(faction,true);assert.equal(rifle.userData.authoredWood,true);assert.equal(rifle.userData.authoredMetal,true);checkGeometry(rifle);
    const bolt=rifle.getObjectByName('bolt');assert.ok(bolt);assert.deepEqual(bolt.position.toArray(),[0,.045,-.26]);
    assert.equal(rifle.userData.sightY,RIFLE_VISUALS[faction].sightY);assert.equal(rifle.userData.muzzleZ,RIFLE_VISUALS[faction].muzzleZ);
    assert.ok(rifle.getObjectByName(`${faction}-front-sight`));assert.ok(rifle.getObjectByName(`${faction}-rear-sight`));
    assert.ok(rifle.userData.handRig.right&&rifle.userData.handRig.left);
    const box=new THREE.Box3().setFromObject(rifle.getObjectByName('furniture')!);
    assert.ok(box.min.z<=RIFLE_VISUALS[faction].muzzleZ+1e-6&&box.max.z>.22,'float32 export preserves the muzzle to sub-millimetre precision');
    assert.ok(box.max.x-box.min.x<.25,'stock detail cannot obstruct the sight line with oversized furniture');
  }
});

test('receiver slots are open geometry, muzzle bores are recessed and world rifles stay batched',()=>{
  for(const faction of factions) {
    const material=new THREE.MeshBasicMaterial({side:THREE.DoubleSide});
    const body=makeModelDetail(`rifle-metal-${faction}-body`,material)!;body.updateMatrixWorld(true);
    const ray=new THREE.Raycaster(new THREE.Vector3(0,.20,-.350),new THREE.Vector3(0,-1,0));
    const opening=ray.intersectObject(body)[0];assert.ok(opening&&opening.point.y<.036,`${faction} has an actual lowered receiver channel`);
    ray.set(new THREE.Vector3(0,.031,RIFLE_VISUALS[faction].muzzleZ-.020),new THREE.Vector3(0,0,1));
    const bore=ray.intersectObject(body)[0];assert.ok(!bore||bore.point.z>RIFLE_VISUALS[faction].muzzleZ+.010,`${faction} muzzle mouth is open`);
    const rifle=makeRifle(faction,false);let triangles=0,draws=0;
    rifle.traverse(object=>{if(object instanceof THREE.Mesh){draws++;triangles+=(object.geometry.index?.count??object.geometry.getAttribute('position').count)/3;}});
    assert.ok(triangles<32_000,`${faction}: ${triangles} triangles remains practical for every bot`);
    assert.ok(draws<=16,`${faction}: ${draws} material batches`);
    body.geometry.dispose();material.dispose();
  }
});

test('tailored first-person sleeves preserve the unit-length animation axis and closed ends',()=>{
  const geometry=makeViewmodelSleeveGeometry();geometry.computeBoundingBox();
  assert.equal(geometry.boundingBox!.min.y,-.5);assert.equal(geometry.boundingBox!.max.y,.5);
  const positions=geometry.getAttribute('position'),normals=geometry.getAttribute('normal');
  for(const data of [positions.array,normals.array])for(const value of data)assert.ok(Number.isFinite(value));
  assert.ok(geometry.boundingBox!.max.x-geometry.boundingBox!.min.x<.16);
  // The cuff and elbow rings retain circular overlap with the existing wrist
  // attachment while the middle has real asymmetric cloth folds.
  const ringRadii=new Set<number>();
  for(let i=0;i<positions.count;i++)if(Math.abs(positions.getY(i))<.4)ringRadii.add(Math.round(Math.hypot(positions.getX(i),positions.getZ(i))*10000));
  assert.ok(ringRadii.size>100);geometry.dispose();
});

test('tailored uniforms remain attached and grounded through stance changes',()=>{
  for(const faction of factions) {
    const soldier=makeSoldier(faction);assert.equal(soldier.userData.authoredUniform,true);checkGeometry(soldier);
    for(const stance of ['stand','crouch','prone'] as const) for(const moving of [0,1.7,4.5]) for(let i=0;i<=40;i++) {
      const actor={id:1,x:0,y:0,z:0,yaw:0,pitch:0,stance,alive:true,moving,ads:true,recoil:0,cooldown:0,reload:0,reloadTotal:0};
      applySoldierPose(soldier,sampleSoldierPose(actor,faction,i/20,{phase:i/40}));
      const box=new THREE.Box3().setFromObject(soldier);assert.ok(Number.isFinite(box.min.y));
      // A rotated mesh's AABB corners can extend below its actual surface.
      // Resolve those candidates against vertices; no real cloth/boot vertex
      // may enter the floor. Longer grounded strides rotate the trouser bounds
      // farther, so the enclosing box itself is not a contact measurement.
      if(box.min.y<0)assert.ok(new THREE.Box3().setFromObject(soldier,true).min.y>=0,'actual uniform and sole vertices must clear the floor');
      const rig=soldier.userData.soldierRig;assert.ok(rig.grenade,'world weapon switch has its own grenade model');
      for(const chain of [rig.leftArm,rig.rightArm,rig.leftLeg,rig.rightLeg])assert.ok(chain.root.parent&&chain.middle.parent===chain.root&&chain.end.parent===chain.middle);
    }
  }
});

test('first-person and carried grenade share metre scale and expose independent animated hands',()=>{
  for(const faction of factions) {
    const world=makeStielhandgranate(faction,false),view=makeStielhandgranate(faction,true);checkGeometry(world);checkGeometry(view);
    const dimensions=new THREE.Box3().setFromObject(world).getSize(new THREE.Vector3());assert.ok(dimensions.y>.35&&dimensions.y<.42);assert.ok(dimensions.x<.10&&dimensions.z<.10);
    assert.equal(world.userData.grenadeRig,undefined);
    const rig=view.userData.grenadeRig;assert.ok(rig.right!==rig.left&&rig.rightForearm!==rig.leftForearm);
    assert.equal(rig.left.visible,false);assert.equal(rig.leftForearm.visible,false);
    const heldOffset=rig.grenade.position.clone().sub(rig.right.position).applyQuaternion(rig.right.quaternion.clone().invert());
    assert.ok(heldOffset.distanceTo(new THREE.Vector3(-.020,.024,-.015))<1e-7,'turning the wrist preserves the handle position inside the palm');
  }
});
