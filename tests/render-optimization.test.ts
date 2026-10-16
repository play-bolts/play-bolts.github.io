import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {batchArenaMeshes,reconcileActorModels,soldierContributesToView,SOLDIER_RENDER_RADIUS,type ActorModelEntry} from '../src/renderOptimization.ts';
import {weatherSurface} from '../src/surfaceWeathering.ts';

test('spatial arena batches preserve world geometry, normals, UVs and materials',()=>{
 const scene=new THREE.Scene(),material=weatherSurface(new THREE.MeshStandardMaterial(),'wood');
 const expected:{position:THREE.Vector3;normal:THREE.Vector3;uv:number[]}[]=[],sources:THREE.Mesh[]=[];
 for(let i=0;i<5;i++){
  const parent=new THREE.Group();parent.position.set(i*.7,.2,i*.3);parent.rotation.y=i*.1;scene.add(parent);
  const mesh=new THREE.Mesh(new THREE.BoxGeometry(1,.3,2),material);mesh.position.set(.1,.5,.2);mesh.rotation.z=i*.15;mesh.castShadow=mesh.receiveShadow=true;mesh.userData.arenaStaticBatch=true;parent.add(mesh);sources.push(mesh);
 }
 scene.updateMatrixWorld(true);
 let disposed=0;for(const mesh of sources){
  mesh.geometry.addEventListener('dispose',()=>disposed++);
  const p=mesh.geometry.getAttribute('position'),n=mesh.geometry.getAttribute('normal'),uv=mesh.geometry.getAttribute('uv'),normalMatrix=new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld);
  for(let i=0;i<p.count;i++)expected.push({position:new THREE.Vector3().fromBufferAttribute(p,i).applyMatrix4(mesh.matrixWorld),normal:new THREE.Vector3().fromBufferAttribute(n,i).applyMatrix3(normalMatrix).normalize(),uv:[uv.getX(i),uv.getY(i)]});
 }
 assert.deepEqual(batchArenaMeshes(scene),{before:5,after:1});assert.equal(disposed,5);
 const batch=scene.getObjectByName('arena-static-batch') as THREE.Mesh;assert.equal(batch.material,material);assert.equal(batch.castShadow,true);assert.equal(batch.receiveShadow,true);
 const p=batch.geometry.getAttribute('position'),n=batch.geometry.getAttribute('normal'),uv=batch.geometry.getAttribute('uv');
 expected.forEach((point,i)=>{assert.ok(new THREE.Vector3().fromBufferAttribute(p,i).distanceTo(point.position)<1e-6);assert.ok(new THREE.Vector3().fromBufferAttribute(n,i).distanceTo(point.normal)<1e-6);assert.deepEqual([uv.getX(i),uv.getY(i)],point.uv);});
 assert.equal(batch.geometry.index!.count,5*36);assert.ok(batch.geometry.boundingSphere);assert.equal(batch.matrixAutoUpdate,false);
});

test('canvas local-coordinate weathering, contact transparency and distant cells remain separate',()=>{
 const scene=new THREE.Scene(),canvas=weatherSurface(new THREE.MeshStandardMaterial(),'canvas',[1,2,3]),trim=new THREE.MeshStandardMaterial(),contact=new THREE.MeshBasicMaterial({transparent:true});
 const add=(material:THREE.Material,x:number)=>{const mesh=new THREE.Mesh(new THREE.BoxGeometry(),material);mesh.position.x=x;mesh.userData.arenaStaticBatch=true;scene.add(mesh);return mesh;};
 const cloth=[add(canvas,0),add(canvas,1)],shadows=[add(contact,0),add(contact,1)];
 add(trim,1);add(trim,2);const remote=add(trim,30);
 assert.deepEqual(batchArenaMeshes(scene),{before:3,after:2});
 for(const source of [...cloth,...shadows,remote])assert.equal(source.parent,scene,'local or transparent shading keeps its original draw');
 for(const mesh of cloth)assert.deepEqual(mesh.geometry.getAttribute('position').array,new THREE.BoxGeometry().getAttribute('position').array);
});

test('batching does not dispose a source geometry still owned by an unbatched mesh',()=>{
 const root=new THREE.Group(),geometry=new THREE.BoxGeometry(),material=new THREE.MeshStandardMaterial();let disposed=0;geometry.addEventListener('dispose',()=>disposed++);
 for(let i=0;i<3;i++){const mesh=new THREE.Mesh(geometry,material);mesh.position.x=i;mesh.userData.arenaStaticBatch=i<2;root.add(mesh);}
 assert.deepEqual(batchArenaMeshes(root),{before:2,after:1});assert.equal(disposed,0);
});

test('roster changes retain surviving animation/resource identity and replace only changed factions',()=>{
 type Actor={faction:string;renderIdentity?:string;name:string};
 const make=(id:string,faction='british'):Actor=>({faction,renderIdentity:`lobby/connection/${id}`,name:'Same name'});
 let serial=0;const removed:number[]=[];const create=()=>({id:++serial,state:{phase:4.2},geometry:new THREE.BoxGeometry()});
 let entries:ActorModelEntry<Actor,ReturnType<typeof create>>[]=[];
 entries=reconcileActorModels(entries,[make('a'),make('b'),make('c')],create,model=>{removed.push(model.id);model.geometry.dispose();});
 const original=[...entries],survivingGeometry=entries[2].model.geometry;let survivorDisposed=false;survivingGeometry.addEventListener('dispose',()=>survivorDisposed=true);
 entries=reconcileActorModels(entries,[make('a'),make('c'),make('d')],create,model=>{removed.push(model.id);model.geometry.dispose();});
 assert.equal(entries[0].model,original[0].model);assert.equal(entries[1].model,original[2].model);assert.equal(entries[1].model.state.phase,4.2);assert.deepEqual(removed,[2]);assert.equal(serial,4);assert.equal(survivorDisposed,false);
 entries=reconcileActorModels(entries,[make('a'),make('c','german'),make('d')],create,model=>{removed.push(model.id);model.geometry.dispose();});
 assert.equal(entries[0].model,original[0].model);assert.deepEqual(removed,[2,3]);assert.equal(serial,5);
 const local:Actor={name:'Same name',faction:'british'};let localEntries=reconcileActorModels([], [local],create,()=>{});const old=localEntries[0].model;
 localEntries=reconcileActorModels(localEntries,[local],create,()=>{});assert.equal(localEntries[0].model,old);
 localEntries=reconcileActorModels(localEntries,[{...local}],create,()=>{});assert.notEqual(localEntries[0].model,old,'a new local match starts a new rig lifetime');
});

function cameraFrustum(){const camera=new THREE.PerspectiveCamera(50,1,.05,100);camera.position.set(0,1.5,0);camera.lookAt(0,1.5,-10);camera.updateMatrixWorld();return new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix,camera.matrixWorldInverse));}
test('animation culling retains view-edge limbs and offscreen soldiers whose shadows cross the view',()=>{
 const frustum=cameraFrustum();
 assert.equal(soldierContributesToView(frustum,{x:0,y:0,z:-8},null),true);
 assert.equal(soldierContributesToView(frustum,{x:4.5,y:0,z:-8},null),true,'large animation envelope preserves a partly visible rifle/limb');
 const caster={x:8,y:0,z:-8};assert.equal(soldierContributesToView(frustum,caster,null),false);
 assert.equal(soldierContributesToView(frustum,caster,new THREE.Vector3(-2,-1,0).normalize()),true,'shadow reaches the image even though body is offscreen');
 assert.equal(soldierContributesToView(frustum,{x:35,y:0,z:8},new THREE.Vector3(.6,-1,-.4).normalize()),false);
 // The swept-sphere bound encloses all actual downward projections of the
 // full animation envelope, including airborne casters and low receivers.
 const light=new THREE.Vector3(.6,-1,-.4).normalize();
 for(let x=-12;x<=12;x+=2)for(let z=-20;z<=10;z+=3)for(const y of [0,2,5]){
  const actor={x,y,z},center=new THREE.Vector3(x,y+.9,z);let projectedVisible=false;
  for(let i=0;i<20;i++){const theta=i*Math.PI/10,point=center.clone().add(new THREE.Vector3(Math.cos(theta),Math.sin(theta),Math.sin(theta*3)).normalize().multiplyScalar(SOLDIER_RENDER_RADIUS));
   if(point.y>=-.05){point.addScaledVector(light,(point.y+.05)/-light.y);if(frustum.containsPoint(point))projectedVisible=true;}}
  if(projectedVisible)assert.equal(soldierContributesToView(frustum,actor,light),true,'no visible projected sample can be culled');
 }
});
