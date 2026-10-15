import test,{before} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {FACTIONS} from '../src/config.ts';
import {makeSoldier} from '../src/soldier.ts';
import {loadSoldierModelFromBuffer,SOLDIER_BONES,type SoldierModelProfile} from '../src/soldierModelAssets.ts';
import {applySoldierPose,sampleSoldierPose,updateSoldier,type SoldierActor} from '../src/soldierAnimation.ts';

const profiles={} as Record<typeof FACTIONS[number],SoldierModelProfile>;
const actor=(patch:Partial<SoldierActor>={}):SoldierActor=>({id:1,x:0,y:0,z:0,yaw:0,pitch:0,stance:'stand',alive:true,moving:0,ads:false,recoil:0,cooldown:0,reload:0,reloadTotal:0,hp:100,deadAt:-Infinity,lastShotTime:-Infinity,lastHurtTime:-Infinity,lastMeleeTime:-Infinity,...patch});
const skins=(model:THREE.Group)=>{const result:THREE.SkinnedMesh[]=[];model.traverse(object=>{if(object instanceof THREE.SkinnedMesh)result.push(object);});return result;};
function skinBounds(model:THREE.Group){
 model.updateMatrixWorld(true);const bounds=new THREE.Box3();
 for(const skin of skins(model)){skin.skeleton.update();skin.computeBoundingBox();bounds.union(skin.boundingBox!);}
 return bounds;
}
before(async()=>{
 for(const faction of FACTIONS){
  const file=readFileSync(new URL(`../public/assets/imported-soldiers/${faction}.glb`,import.meta.url));
  profiles[faction]=JSON.parse(readFileSync(new URL(`../public/assets/imported-soldiers/${faction}-profile.json`,import.meta.url),'utf8'));
  const loader=new GLTFLoader();loader.register(()=>({name:'test-source-textures',loadTexture:(index:number)=>{const map=new THREE.Texture();map.name=`source-${index}`;return Promise.resolve(map);}}));
  await loadSoldierModelFromBuffer(file.buffer.slice(file.byteOffset,file.byteOffset+file.byteLength),profiles[faction],loader);
 }
});

test('shipped source adaptations match their provenance and stay within download budgets',()=>{
 let total=0;
 for(const faction of FACTIONS){
  const data=readFileSync(new URL(`../public/assets/imported-soldiers/${faction}.glb`,import.meta.url));
  const manifest=JSON.parse(readFileSync(new URL(`../public/assets/imported-soldiers/${faction}-provenance.json`,import.meta.url),'utf8'));
  assert.equal(manifest.outputSha256,createHash('sha256').update(data).digest('hex'));assert.equal(manifest.outputBytes,data.length);
  assert.ok(data.length<15_000_000);total+=data.length;
  assert.equal(manifest.license,'CC BY 4.0');assert.match(manifest.sourceSha256,/^[a-f\d]{64}$/);
  assert.ok(manifest.embeddedTextures.length>0&&manifest.embeddedTextures.every((image:{dimensions:number[]})=>Math.max(...image.dimensions)<=1024));
 }
 assert.ok(total<21_000_000,'three complete characters remain a bounded static download');
});

test('all factions use the actual continuous source surfaces, UVs and normalized skin weights',()=>{
 for(const faction of FACTIONS){
  const model=makeSoldier(faction);assert.equal(model.userData.importedSoldier,true);assert.equal(model.userData.soldierSource,profiles[faction].sourceUid);
  const source=skins(model);assert.ok(source.length>=3&&source.length<=24,'bounded source material surfaces');
  let blended=0,triangles=0;
  for(const skin of source){
   const {geometry}=skin,position=geometry.getAttribute('position'),normal=geometry.getAttribute('normal'),uv=geometry.getAttribute('uv'),weights=geometry.getAttribute('skinWeight'),indices=geometry.getAttribute('skinIndex');
   assert.ok(uv&&normal&&uv.count===position.count&&normal.count===position.count);assert.equal(skin.skeleton.bones.length,15);
   triangles+=(geometry.index?.count??position.count)/3;
   for(let i=0;i<position.count;i++){
    const sum=weights.getX(i)+weights.getY(i)+weights.getZ(i)+weights.getW(i);assert.ok(Math.abs(sum-1)<1e-5);
    if(weights.getY(i)>.005)blended++;
    for(let j=0;j<4;j++){assert.ok(indices.getComponent(i,j)>=0&&indices.getComponent(i,j)<15);assert.ok(Number.isFinite(position.getComponent(i,Math.min(j,2))));}
   }
   for(const material of Array.isArray(skin.material)?skin.material:[skin.material])assert.ok(material instanceof THREE.MeshStandardMaterial,'source PBR material retained');
  }
  assert.ok(blended>500,'continuous elbow/knee/shoulder gradients are present');assert.ok(triangles>20_000&&triangles<105_000);
  const bounds=new THREE.Box3();source.forEach(skin=>{skin.geometry.computeBoundingBox();bounds.union(skin.geometry.boundingBox!);});
  assert.ok(Math.abs(bounds.min.y)<.01);assert.ok(bounds.max.y>(faction==='german'?1.77:1.79)&&bounds.max.y<1.81,'adult proportions remain intact; removing German foliage lowers only the helmet dressing');
  assert.ok(bounds.getSize(new THREE.Vector3()).x>.35&&bounds.getSize(new THREE.Vector3()).x<.8);
 }
});

test('German helmet uses solid gray paint without recoloring the head or uniform',()=>{
 const surfaces=skins(makeSoldier('german'));
 assert.ok(!surfaces.some(mesh=>/scrimleaves|scrimwire/.test(mesh.name)),'separate camouflage dressing is removed');
 const helmet=surfaces.find(mesh=>mesh.name==='german-helmet-helmetm42_low_0')!;
 assert.ok(helmet,'the original helmet shell is retained');
 const material=helmet.material as THREE.MeshStandardMaterial;
 assert.equal(material.map,null,'camouflage base-color texture is not sampled');
 assert.equal(material.color.getHex(),0x626262);assert.equal(material.color.r,material.color.g);assert.equal(material.color.g,material.color.b);
 assert.ok(material.normalMap&&material.aoMap&&material.roughnessMap,'helmet surface detail still responds to lighting');
 for(const mesh of surfaces.filter(mesh=>mesh!==helmet))for(const other of Array.isArray(mesh.material)?mesh.material:[mesh.material]){
  assert.ok((other as THREE.MeshStandardMaterial).map,'uniform, skin and equipment retain their source color maps');
  assert.equal(other.userData.boltsSurfaceAdjustment,undefined);
 }
});

test('British eyeballs retain the original textured iris and pupil instead of blank white materials',()=>{
 const model=makeSoldier('british'),source=skins(model);
 for(const name of ['british-head-4','british-head-5']){
  const eye=source.find(mesh=>mesh.name===name)!;assert.ok(eye,'original eyeball geometry remains');
  const material=eye.material as THREE.MeshStandardMaterial;
  assert.ok(material.map,'the original iris/pupil map is present');assert.equal(material.transparent,false);assert.equal(material.metalness,0);
  assert.ok(eye.geometry.getAttribute('uv').count===eye.geometry.getAttribute('position').count,'the source eye UVs are retained');
 }
 const bytes=readFileSync(new URL('../public/assets/imported-soldiers/british.glb',import.meta.url));
 const jsonSize=bytes.readUInt32LE(12),document=JSON.parse(bytes.subarray(20,20+jsonSize).toString()),binary=bytes.subarray(28+jsonSize);
 const originalHashes=['8bd32bccc9b6698ec13c6c6c0fef91e8e6dc5b3470187f780c716c4a5aff9784','b46bc772eb26dec6aa5682459892fbc1bf3692900a4190135ab617db18b64e7c'];
 for(const[side,expected]of ['L','R'].map((side,i)=>[side,originalHashes[i]])){
  const material=document.materials.find((m:{name:string})=>m.name===`Std_Eye_${side}.001`),texture=document.textures[material.pbrMetallicRoughness.baseColorTexture.index],image=document.images[texture.source],view=document.bufferViews[image.bufferView];
  assert.equal(image.mimeType,'image/jpeg');assert.equal(createHash('sha256').update(binary.subarray(view.byteOffset,view.byteOffset+view.byteLength)).digest('hex'),expected,'iris image is byte-identical to the original licensed source');
 }
});

test('British trouser folds follow their connected leg without altering source surfaces',async()=>{
 const bytes=readFileSync(new URL('../public/assets/imported-soldiers/british.glb',import.meta.url));
 const loader=new GLTFLoader();loader.register(()=>({name:'trouser-weight-source-textures',loadTexture:()=>Promise.resolve(new THREE.Texture())}));
 const source=await loader.parseAsync(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),'');source.scene.updateMatrixWorld(true);
 const original=source.scene.getObjectByName('british-legs-31') as THREE.SkinnedMesh;
 original.normalizeSkinWeights(); // The normal actor factory applies the same normalization.
 const before=original.geometry.clone().applyMatrix4(original.matrixWorld),model=makeSoldier('british');
 const mesh=skins(model).find(mesh=>mesh.name==='british-legs-31')!,after=mesh.geometry;
 for(const attribute of ['position','normal','uv','skinWeight'])assert.deepEqual(after.getAttribute(attribute).array,before.getAttribute(attribute).array,`${attribute} remains authored`);
 assert.deepEqual(after.index!.array,before.index!.array,'all original triangles are retained');
 const originalIds=before.getAttribute('skinIndex'),ids=after.getAttribute('skinIndex'),weights=after.getAttribute('skinWeight'),position=after.getAttribute('position');
 let repaired=0;
 for(let i=0;i<position.count;i++){
  let changed=false;
  for(let j=0;j<4;j++)if(weights.getComponent(i,j)>1e-7){
   const old=SOLDIER_BONES.indexOf(original.skeleton.bones[originalIds.getComponent(i,j)].name as typeof SOLDIER_BONES[number]),current=ids.getComponent(i,j);
   if(old!==current){assert.ok(position.getY(i)<.82,'crotch and upper garment weights remain unchanged');assert.ok(old>=12&&old<=14&&current===old-3,'only mistaken right-leg attachment changes to corresponding left segment');changed=true;}
  }
  if(changed)repaired++;
 }
 assert.equal(repaired,322,'the bounded ambiguous left-leg fold is repaired');
 const problematic=[[5802,5803,5805]];
 for(const triangle of problematic)for(const vertex of triangle)for(let j=0;j<4;j++)if(weights.getComponent(vertex,j)>1e-7)assert.ok(ids.getComponent(vertex,j)>=9&&ids.getComponent(vertex,j)<=11,'all lower-fold vertices follow the left leg');
 // Moving just the other leg used to stretch these small triangles across
 // the gap. They must now remain exactly stationary, not merely less wide.
 model.updateMatrixWorld(true);mesh.skeleton.update();
 const sample=()=>problematic.flat().map(i=>mesh.getVertexPosition(i,new THREE.Vector3()).clone());
 const rest=sample();
 const oppositeKnee=model.getObjectByName('skin-calfR')!.parent!,oppositeThigh=model.getObjectByName('skin-thighR')!.parent!;
 oppositeThigh.rotation.z=.65;oppositeKnee.rotation.x=1.1;model.updateMatrixWorld(true);mesh.skeleton.update();
 sample().forEach((point,i)=>assert.ok(point.distanceTo(rest[i])<1e-9,'opposite knee cannot pull cloth across the legs'));
});

test('Soviet boot fitting reduces footprint while preserving soles, skinning and upper body',async()=>{
 const bytes=readFileSync(new URL('../public/assets/imported-soldiers/russian.glb',import.meta.url));
 const loader=new GLTFLoader();loader.register(()=>({name:'boot-fit-source-textures',loadTexture:()=>Promise.resolve(new THREE.Texture())}));
 const source=await loader.parseAsync(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),'');source.scene.updateMatrixWorld(true);
 const original=source.scene.getObjectByName('russian-uniform') as THREE.SkinnedMesh;
 const before=original.geometry.clone().applyMatrix4(original.matrixWorld),after=skins(makeSoldier('russian')).find(mesh=>mesh.name==='russian-uniform')!.geometry;
 assert.deepEqual(after.getAttribute('uv').array,before.getAttribute('uv').array);
 assert.deepEqual(after.index!.array,before.index!.array,'source garment topology is unchanged');
 const a=before.getAttribute('position'),b=after.getAttribute('position'),normals=after.getAttribute('normal');
 for(let i=0;i<a.count;i++){
  assert.equal(b.getY(i),a.getY(i),'sole height and shaft height do not change');
  if(a.getY(i)>=.40){assert.equal(b.getX(i),a.getX(i));assert.equal(b.getZ(i),a.getZ(i));}
  assert.ok(Math.abs(new THREE.Vector3().fromBufferAttribute(normals,i).length()-1)<1e-5);
  for(let j=0;j<4;j++)assert.ok(Math.abs(before.getAttribute('skinWeight').getComponent(i,j)-after.getAttribute('skinWeight').getComponent(i,j))<1e-7,'fitting preserves each skin influence');
 }
 for(const side of [-1,1]){
  const first=new THREE.Box3(),second=new THREE.Box3();
  for(let i=0;i<a.count;i++)if(a.getY(i)<.12&&a.getX(i)*side>0){first.expandByPoint(new THREE.Vector3().fromBufferAttribute(a,i));second.expandByPoint(new THREE.Vector3().fromBufferAttribute(b,i));}
  const oldSize=first.getSize(new THREE.Vector3()),newSize=second.getSize(new THREE.Vector3());
  assert.ok(Math.abs(newSize.x/oldSize.x-.78)<1e-6,'each boot is 22% narrower');
  assert.ok(Math.abs(newSize.z/oldSize.z-.80)<1e-6,'each boot is 20% shorter');
  assert.equal(first.min.y,second.min.y);
 }
});

test('actual skinned bodies remain finite and grounded across stance, gait, reload and death',()=>{
 for(const faction of FACTIONS){
  const model=makeSoldier(faction);
  for(const patch of [{},{stance:'crouch'},{stance:'prone'},{moving:4.5},{ads:true,pitch:.5},{reload:1.2,reloadTotal:3.2},{alive:false,deadAt:1}] as Partial<SoldierActor>[]){
   applySoldierPose(model,sampleSoldierPose(actor(patch),faction,2));const bounds=skinBounds(model),size=bounds.getSize(new THREE.Vector3());
   for(const value of [...bounds.min.toArray(),...bounds.max.toArray()])assert.ok(Number.isFinite(value));
   assert.ok(size.length()<3.5,'source skin does not explode when the articulated IK bends');
   assert.ok(bounds.min.y>-.10,'source garment volume stays near the floor during low/dead poses');
  }
  applySoldierPose(model,sampleSoldierPose(actor(),faction,0));const standing=skinBounds(model);
  assert.ok(Math.abs(standing.min.y)<.025,'resting source soles retain ground contact');
 }
});

test('source skeletons replay exact poses and actor disposal cannot damage other clones',()=>{
 for(const faction of FACTIONS){
  const one=makeSoldier(faction),two=makeSoldier(faction),pose=sampleSoldierPose(actor({stance:'crouch',ads:true}),faction,2);
  applySoldierPose(one,pose);one.updateMatrixWorld(true);const first=skins(one),second=skins(two);
  const capture=()=>first[0].skeleton.bones.flatMap(bone=>bone.matrixWorld.elements.slice());const exact=capture();
  updateSoldier(one,actor({alive:false,deadAt:3}),.016,4);applySoldierPose(one,pose);one.updateMatrixWorld(true);assert.deepEqual(capture(),exact,'rewinding restores the actual source skin skeleton');
  for(let i=0;i<first.length;i++){
   assert.notEqual(first[i].geometry,second[i].geometry);assert.notEqual(first[i].skeleton,second[i].skeleton);
   const aa=Array.isArray(first[i].material)?first[i].material:[first[i].material],bb=Array.isArray(second[i].material)?second[i].material:[second[i].material];
   aa.forEach((material,j)=>{assert.notEqual(material,bb[j]);for(const [key,value]of Object.entries(material))if(value instanceof THREE.Texture){assert.notEqual(value,(bb[j] as unknown as Record<string,unknown>)[key]);value.dispose();}material.dispose();});
   first[i].geometry.dispose();
  }
  first[0].skeleton.dispose();first[0].geometry.getAttribute('position').setX(0,999);
  assert.notEqual(second[0].geometry.getAttribute('position').getX(0),999);assert.notEqual(skins(makeSoldier(faction))[0].geometry.getAttribute('position').getX(0),999);
  assert.deepEqual(second[0].skeleton.bones.map(bone=>bone.name),SOLDIER_BONES.map(name=>`skin-${name}`));
 }
});
