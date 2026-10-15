import {sampleFirstPersonWeaponAnimation} from '../src/firstPersonWeaponAnimation.ts';
import test,{before} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {FACTIONS,WEAPONS} from '../src/config.ts';
import {loadImportedWeaponFromBuffer,loadImportedGrenadeFromBuffer,makeImportedWeapon,makeImportedGrenade,getImportedWeaponProfile,type ImportedWeaponProfile} from '../src/importedWeapons.ts';
import {getRifleVisuals,makeRifle} from '../src/rifle.ts';
import {makeAnatomicalHand,configureRifleHand} from '../src/hands.ts';
import {applyWeaponAnimation,applyGrenadePose,sampleGrenadeReadyPose} from '../src/weaponAnimation.ts';
import {makeStielhandgranate} from '../src/grenadeModel.ts';
import {defaultWeaponBodyMatrix,VIEWMODEL_HIP_POSITION,VIEWMODEL_SHOULDERS,VIEWMODEL_UPPER_ARM,VIEWMODEL_FOREARM} from '../src/viewmodelArms.ts';

const files={british:'enfield',russian:'mosin',german:'kar98k'};
const profiles={} as Record<typeof FACTIONS[number],ImportedWeaponProfile>;
const sourceHands={} as Record<'left'|'right',THREE.Group>;
const bytes=(path:string)=>{const file=readFileSync(new URL(path,import.meta.url));return file.buffer.slice(file.byteOffset,file.byteOffset+file.byteLength) as ArrayBuffer;};
function testLoader(){
 const loader=new GLTFLoader();
 // Decode-independent geometry validation: retain the real GLB material/map
 // assignments while image decoding itself is covered by the asset checks.
 loader.register(()=>({name:'test-texture-decoder',loadTexture:(index:number)=>{const texture=new THREE.Texture();texture.name=`source-texture-${index}`;return Promise.resolve(texture);}}));
 return loader;
}
before(async()=>{
 for(const faction of FACTIONS){
  const name=files[faction];profiles[faction]=JSON.parse(readFileSync(new URL(`../public/assets/imported-weapons/${name}-profile.json`,import.meta.url),'utf8'));
  await loadImportedWeaponFromBuffer(bytes(`../public/assets/imported-weapons/${name}.glb`),profiles[faction],testLoader());
 }
 for(const side of ['left','right'] as const)sourceHands[side]=(await testLoader().parseAsync(bytes(`../public/assets/arms/hand-${side==='left'?'l':'r'}.glb`),'' )).scene;
 await loadImportedGrenadeFromBuffer(bytes('../public/assets/models/imported-stielhandgranate.glb'),testLoader());
});

test('source grenade replaces its procedural furniture without moving the carried grip',async()=>{
 const source=makeImportedGrenade()!,world=makeStielhandgranate('british',false),view=makeStielhandgranate('british',true);
 const box=new THREE.Box3().setFromObject(world,true);assert.ok(Math.abs(box.min.y+.126)<1e-5&&Math.abs(box.max.y-.254)<1e-5);
 assert.equal(world.userData.importedWeapon,true);assert.equal(view.userData.importedWeapon,true);
 const meshes=(model:THREE.Object3D)=>{let count=0;model.traverse(object=>{if(object instanceof THREE.Mesh)count++;});return count;};
 assert.equal(meshes(source),meshes(world),'no duplicate procedural handle/canister');
 const pose=sampleGrenadeReadyPose();applyGrenadePose(view,pose);view.updateMatrixWorld(true);
 const rig=view.userData.grenadeRig;
 const relative=rig.grenade.position.clone().sub(rig.right.position).applyQuaternion(rig.right.quaternion.clone().invert());
 assert.ok(relative.distanceTo(new THREE.Vector3(...pose.grenadePosition).sub(new THREE.Vector3(...pose.right)))<1e-7,'the source grenade stays fixed inside the rotated cylinder grip');
 assert.equal(rig.left.visible,false);
 const invalid={asset:{version:'2.0'},scene:0,scenes:[{nodes:[0]}],nodes:[{name:'furniture'}]};
 await assert.rejects(loadImportedGrenadeFromBuffer(new TextEncoder().encode(JSON.stringify(invalid)).buffer as ArrayBuffer,testLoader()),/empty/);
 assert.equal(meshes(makeImportedGrenade()!),meshes(source),'a rejected source cannot erase the good cached grenade');
});

test('Kar98k sight vertices widen the notch and blade without shifting their alignment',async()=>{
 const source=(await testLoader().parseAsync(bytes('../public/assets/imported-weapons/kar98k.glb'),'')).scene;
 const fitted=makeImportedWeapon('german')!;
 const points=(root:THREE.Group)=>{
  root.updateMatrixWorld(true);const result:THREE.Vector3[]=[];
  root.getObjectByName('furniture')!.traverse(object=>{if(object instanceof THREE.Mesh){const position=object.geometry.getAttribute('position');for(let i=0;i<position.count;i++)result.push(new THREE.Vector3().fromBufferAttribute(position,i).applyMatrix4(object.matrixWorld));}});
  return result;
 };
 const before=points(source),after=points(fitted);let rear=0,front=0,unchanged=0;
 assert.equal(after.length,before.length);
 for(let i=0;i<before.length;i++){
  const a=before[i],b=after[i];assert.ok(Math.abs(a.y-b.y)<1e-7&&Math.abs(a.z-b.z)<1e-7,'height and fore/aft position unchanged');
  const isRear=a.z>-.489&&a.z<-.480&&a.y>.050&&Math.abs(a.x)<.0016;
  const isFront=a.z>-1.0045&&a.z<-.9898&&a.y>.050&&Math.abs(a.x)<.0018;
  if(isRear||isFront){assert.ok(Math.abs(b.x-a.x*1.4)<1e-7);if(isRear)rear++;if(isFront)front++;}
  else if(a.z>=-.480||a.z<=-1.0045||a.y<=.0462){assert.ok(Math.abs(a.x-b.x)<1e-7,'receiver, stock and barrel remain unchanged');unchanged++;}
 }
 assert.ok(rear>0&&front>0,'both real source sights are present');assert.ok(unchanged>100,'receiver, stock and barrel sampled');
 assert.deepEqual(points(makeImportedWeapon('german')!),after,'cloning never widens the sights twice');
});

function actualHands(rifle:THREE.Group){
 const rig=rifle.userData.handRig;
 for(const side of ['left','right'] as const){
  rifle.remove(rig[side]);const hand=makeAnatomicalHand(side,sourceHands[side])!;configureRifleHand(hand);rifle.add(hand);rig[side]=hand;
 }
 rig.rightFingers=[];rig.rightThumb=new THREE.Group();return rig;
}

test('source rifles retain their own geometry, sights and UV/PBR surfaces',()=>{
 assert.equal(WEAPONS.british.model,'SMLE Mk III');
 for(const faction of FACTIONS){
  const rifle=makeRifle(faction),profile=profiles[faction];
  assert.equal(rifle.userData.importedWeapon,true);assert.ok(rifle.getObjectByName('furniture'));assert.ok(rifle.getObjectByName('bolt'));
  assert.equal(rifle.getObjectByName('sights'),undefined,'procedural sight geometry is not added over imported sights');
  let vertices=0;
  rifle.traverse(object=>{if(object instanceof THREE.Mesh){
   const positions=object.geometry.getAttribute('position'),uv=object.geometry.getAttribute('uv');vertices+=positions.count;
   assert.ok(uv&&uv.count===positions.count,'source or author-adapted UVs survive runtime loading');
   for(const material of Array.isArray(object.material)?object.material:[object.material])assert.ok(material instanceof THREE.MeshStandardMaterial,'source PBR shading is preserved');
  }});
  assert.ok(vertices>500);
  const bounds=new THREE.Box3().setFromObject(rifle,true);
  assert.ok(bounds.min.distanceTo(new THREE.Vector3(...profile.bounds.min))<.01);assert.ok(bounds.max.distanceTo(new THREE.Vector3(...profile.bounds.max))<.01);
  assert.equal(makeRifle(faction,false,{source:'procedural'}).userData.importedWeapon,undefined,'explicit authored fallback remains available');
 }
});

test('ADS aligns the actual source rear and front sight points on the camera ray',()=>{
 for(const faction of FACTIONS){
  const profile=profiles[faction],visual=getRifleVisuals(faction);
  for(const point of [profile.rearSight,profile.frontSight]){
   const cameraPoint=new THREE.Vector3(...point).applyEuler(new THREE.Euler(...visual.adsRotation)).add(new THREE.Vector3(-visual.sightX,-visual.sightY,visual.adsZ));
   assert.ok(Math.hypot(cameraPoint.x,cameraPoint.y)<1e-7);assert.ok(cameraPoint.z<-.02,'actual sight geometry stays in front of the eye');
  }
  assert.deepEqual(makeRifle(faction).scale.toArray(),[1,1,1]);
  assert.deepEqual(visual.muzzle,profile.muzzle);assert.equal(visual.worldScale,profile.worldScale??.82);
 }
});

test('replacement Mosin sights align the post tip with the actual rear notch lip',()=>{
 const rifle=makeImportedWeapon('russian')!,profile=profiles.russian,points:THREE.Vector3[]=[];
 rifle.updateMatrixWorld(true);
 rifle.getObjectByName('furniture')!.traverse(object=>{if(object instanceof THREE.Mesh){const p=object.geometry.getAttribute('position');for(let i=0;i<p.count;i++)points.push(new THREE.Vector3().fromBufferAttribute(p,i).applyMatrix4(object.matrixWorld));}});
 const notch=points.filter(p=>p.z>-.447&&p.z<-.444&&p.y>.0539&&Math.abs(p.x)<.0015);
 assert.ok(notch.some(p=>p.x<0)&&notch.some(p=>p.x>0),'both edges of the source notch exist');
 const lip=notch.reduce((closest,p)=>p.z>closest.z?p:closest);
 assert.ok(Math.abs(profile.rearSight[1]-lip.y)<.00002&&Math.abs(profile.rearSight[2]-lip.z)<.00002,'aim goes across the top lip, not into the notch floor');
 const post=points.filter(p=>Math.abs(p.z-profile.frontSight[2])<.003&&Math.abs(p.x)<.0015&&p.y>.052&&p.y<.055);
 assert.ok(post.length>0);assert.ok(Math.abs(profile.frontSight[1]-Math.max(...post.map(p=>p.y)))<.00002,'aim uses the actual front-post tip');
});

test('reload sleeve is a fixed-length skinned arm attached to the body',()=>{
 for(const faction of FACTIONS){
  const rifle=makeRifle(faction,true),rig=actualHands(rifle);
  for(let i=0;i<=100;i++){
   const pose=sampleFirstPersonWeaponAnimation(faction,'reload',i/100,faction==='british');
   const body=defaultWeaponBodyMatrix(VIEWMODEL_HIP_POSITION.map((v,k)=>v+pose.position[k]),[pose.rotation[0],pose.rotation[1]-.035,pose.rotation[2]]);
   applyWeaponAnimation(rifle,pose,body);rifle.updateMatrixWorld(true);
   for(const side of ['left','right']as const){
    const arm=rig[side+'Arm'],joint=(bone:THREE.Bone)=>bone.getWorldPosition(new THREE.Vector3()).applyMatrix4(body);
    const shoulder=joint(arm.upper),elbow=joint(arm.lower),wrist=joint(arm.cuff);
    assert.ok(shoulder.distanceTo(VIEWMODEL_SHOULDERS[side])<1e-7,'shoulder stays fixed in camera space');
    assert.ok(Math.abs(shoulder.distanceTo(elbow)-VIEWMODEL_UPPER_ARM)<1e-7,'upper arm cannot stretch to hide an unreachable contact');
    assert.ok(Math.abs(elbow.distanceTo(wrist)-VIEWMODEL_FOREARM)<1e-7,'forearm has no loading-reach exemption');
    const actualWrist=rig[side].localToWorld(rig[side].userData.wristLocal.clone()).applyMatrix4(body);
    assert.ok(actualWrist.distanceTo(wrist)<1e-7,'physical cuff stays inside the actual skin wrist');
    assert.ok(arm.mesh instanceof THREE.SkinnedMesh&&arm.mesh.geometry.name==='continuous-anatomical-sleeve');
   }
  }
 }
});

test('imported bolt and charger contacts retain actual-hand wrist alignment and absolute scrubbing',()=>{
 for(const faction of FACTIONS){
  const rifle=makeRifle(faction,true),rig=actualHands(rifle),profile=profiles[faction];
  for(const action of ['idle','cycle','reload','melee'] as const)for(let i=0;i<=250;i++){
   const pose=sampleFirstPersonWeaponAnimation(faction,action,i/250,faction==='british');applyWeaponAnimation(rifle,pose);rifle.updateMatrixWorld(true);
   for(const side of ['right','left']as const){
    const arm=rig[side+'Arm'];
    assert.ok(arm.reachError<1e-7,`${faction}/${action}/${i/250} ${side} remains within physical reach`);
    assert.ok(arm.wristBend<35*Math.PI/180,`${faction}/${action}/${i/250} ${side} wrist stays within a comfortable working bend`);
   }
   if(pose.boltGrip>.999){
    const knob=rig.bolt.localToWorld(new THREE.Vector3(...profile.bolt.knobLocal));
    const grip=rig.right.localToWorld((rig.right.userData.gripLocal as THREE.Vector3).clone());
    assert.ok(knob.distanceTo(grip)<1e-6,'palm follows the actual imported moving bolt');
   }
   if(pose.clipVisible&&pose.thumbContact===1&&rig.rounds.visible){
    const {mesh,index}=rig.right.userData.thumbContact;mesh.skeleton.update();
    const thumb=mesh.localToWorld(mesh.applyBoneTransform(index,new THREE.Vector3().fromBufferAttribute(mesh.geometry.getAttribute('position'),index)));
    const cartridge=rig.clip.localToWorld(new THREE.Vector3(0,.058-pose.clipPress*.064,-.001));
    assert.ok(thumb.distanceTo(cartridge)<1e-6,`${faction}/${action}/${i/250} actual thumb contacts top cartridge (${thumb.distanceTo(cartridge)})`);
   }
  }
  const ready=sampleFirstPersonWeaponAnimation(faction,'idle',0);applyWeaponAnimation(rifle,ready);rifle.updateMatrixWorld(true);
  const leftBones=rig.left.userData.anatomical.bones as THREE.Bone[];
  const thumb=(name:string)=>leftBones.find(bone=>bone.name.replace(/[._]/g,'')===name)!.getWorldPosition(new THREE.Vector3());
  const thumbAxis=thumb('thumb03L').sub(thumb('thumb01L')).normalize();
  assert.ok(thumbAxis.z<-.8&&thumbAxis.y<.5,'support thumb follows the barrel below the sight line');
  const rightPalm=new THREE.Vector3(0,1,0).transformDirection(rig.right.userData.anatomical.model.matrixWorld);
  assert.ok(rightPalm.y>.9,'stock hand cups upward underneath the rifle');
  const pose=sampleFirstPersonWeaponAnimation(faction,'reload',.43,true);applyWeaponAnimation(rifle,pose);rifle.updateMatrixWorld(true);
  const transforms=[rig.right,rig.left,rig.rightForearm,rig.leftForearm].map(object=>object.matrix.clone());
  applyWeaponAnimation(rifle,sampleFirstPersonWeaponAnimation(faction,'cycle',.4));applyWeaponAnimation(rifle,pose);rifle.updateMatrixWorld(true);
  [rig.right,rig.left,rig.rightForearm,rig.leftForearm].forEach((object,index)=>object.matrix.elements.forEach((value,k)=>assert.ok(Math.abs(value-transforms[index].elements[k])<1e-12,'replay pose is absolute to floating-point precision')));
 }
});

test('source caches and other actors survive geometry, material and texture disposal',()=>{
 for(const faction of FACTIONS){
  const a=makeImportedWeapon(faction)!,b=makeImportedWeapon(faction)!;
  const meshes=(root:THREE.Group)=>{const list:THREE.Mesh[]=[];root.traverse(object=>{if(object instanceof THREE.Mesh)list.push(object);});return list;};
  const aa=meshes(a),bb=meshes(b);assert.equal(aa.length,bb.length);
  const original=bb[0].geometry.getAttribute('position').getX(0);
  for(let i=0;i<aa.length;i++){
   assert.notEqual(aa[i].geometry,bb[i].geometry);
   const am=Array.isArray(aa[i].material)?aa[i].material:[aa[i].material],bm=Array.isArray(bb[i].material)?bb[i].material:[bb[i].material];
   for(let j=0;j<am.length;j++){
    assert.notEqual(am[j],bm[j]);
    for(const [key,value] of Object.entries(am[j]))if(value instanceof THREE.Texture){assert.notEqual(value,(bm[j] as unknown as Record<string,unknown>)[key]);value.dispose();}
    am[j].dispose();
   }
   aa[i].geometry.dispose();
  }
  aa[0].geometry.getAttribute('position').setX(0,999);
  assert.equal(bb[0].geometry.getAttribute('position').getX(0),original);
  assert.equal(meshes(makeImportedWeapon(faction)!)[0].geometry.getAttribute('position').getX(0),original);
  assert.deepEqual(getImportedWeaponProfile(faction)?.muzzle,profiles[faction].muzzle);
 }
});

test('both imported-rifle hands contact the source wood without buried skin',()=>{
 for(const faction of FACTIONS){
  const rifle=makeRifle(faction,true),rig=actualHands(rifle);applyWeaponAnimation(rifle,sampleFirstPersonWeaponAnimation(faction,'melee',.48));rifle.updateMatrixWorld(true);
  const stocks:THREE.Mesh[]=[];
  rifle.getObjectByName('furniture')!.traverse(object=>{
   if(!(object instanceof THREE.Mesh))return;
   const materials=Array.isArray(object.material)?object.material:[object.material];
   // The Kar source uses one atlas for wood and metal, so its static action
   // surfaces are included as well; the movable bolt is a separate group.
   if(faction==='german'||materials.some(material=>/wood|walnut/i.test(material.name))){stocks.push(object);materials.forEach(material=>material.side=THREE.DoubleSide);}
  });
  assert.ok(stocks.length,'actual source stock surfaces are present');
  const bounds=new THREE.Box3();stocks.forEach(stock=>bounds.union(new THREE.Box3().setFromObject(stock)));
  const ray=new THREE.Raycaster(),direction=new THREE.Vector3(-1,0,0);
  for(const side of ['right','left'] as const){
   let skin:THREE.SkinnedMesh|undefined;rig[side].traverse((object:THREE.Object3D)=>{if(object instanceof THREE.SkinnedMesh)skin=object;});assert.ok(skin);skin.skeleton.update();
   const positions=skin.geometry.getAttribute('position'),detail=skin.geometry.getAttribute('skinDetail');let nearest=Infinity,palmClearance=Infinity;
   const fingerContact=new Map<string,number>(),vertical=new THREE.Raycaster(),palmPatch=new THREE.Box3();let palmContactPoints=0;
   for(let i=0;i<positions.count;i++){
    const point=skin.localToWorld(skin.applyBoneTransform(i,new THREE.Vector3().fromBufferAttribute(positions,i)));
    const bone=skin.skeleton.bones[skin.geometry.getAttribute('skinIndex').getX(i)].name;
    if((bone===`hand${side==='left'?'L':'R'}`||bone.startsWith('palm'))&&detail.getZ(i)>.6){
     vertical.set(new THREE.Vector3(point.x,bounds.max.y+.1,point.z),new THREE.Vector3(0,-1,0));
     const surfaces=vertical.intersectObjects(stocks);
     if(surfaces.length>=2){
      const underside=Math.min(...surfaces.map(surface=>surface.point.y)),gap=underside-point.y;
      assert.ok(gap>=-.001,`${faction}: palmar skin cannot enter the underside of the stock by more than 1 mm`);
      if(gap>=0){
       palmClearance=Math.min(palmClearance,gap);nearest=Math.min(nearest,gap);
       if(gap<.002){palmContactPoints++;palmPatch.expandByPoint(point);}
      }
     }
    }
    if(point.y<bounds.min.y||point.y>bounds.max.y||point.z<bounds.min.z||point.z>bounds.max.z)continue;
    ray.set(new THREE.Vector3(bounds.max.x+.1,point.y,point.z),direction);const hits=ray.intersectObjects(stocks);if(hits.length<2)continue;
    const xs=hits.map(hit=>hit.point.x),min=Math.min(...xs),max=Math.max(...xs);
    nearest=Math.min(nearest,Math.abs(point.x-min),Math.abs(point.x-max));
    if(new RegExp(`^f_.*03${side==='left'?'L':'R'}$`).test(bone))fingerContact.set(bone,Math.min(fingerContact.get(bone)??Infinity,Math.abs(point.x-min),Math.abs(point.x-max)));
    assert.ok(point.x<=min+.001||point.x>=max-.001,`${faction}/${side} skin vertex ${i} penetrates source stock by ${Math.min(point.x-min,max-point.x)}m`);
   }
   assert.ok(nearest<.003,`${faction}/${side} retains surface contact (${nearest}m)`);
   if(side==='right'){
    const thumbRoot=skin.skeleton.bones.find(bone=>bone.name==='thumb01R')!;
    const thumbTip=skin.skeleton.bones.find(bone=>bone.name==='thumb03R')!;
    const direction=thumbTip.getWorldPosition(new THREE.Vector3()).sub(thumbRoot.getWorldPosition(new THREE.Vector3())).normalize();
    assert.ok(direction.y<.5&&direction.z<-.35,`${faction}: firing thumb follows the stock instead of standing upright beside the sights`);
   }
   {
    assert.ok(palmClearance<.0012,`${faction}/${side}: actual palmar skin supports the underside (${palmClearance} m)`);
    const size=palmPatch.getSize(new THREE.Vector3());
    assert.ok(palmContactPoints>=8&&size.x>.005&&size.z>.005,`${faction}/${side}: a broad palm pad supports the stock, not just one vertex or thumb tip`);
    // The firing index remains at the trigger; the other digits wrap wood.
    for(const digit of side==='left'?['index','middle','ring','pinky']:['middle','ring','pinky']){
     const gap=fingerContact.get(`f_${digit}03${side==='left'?'L':'R'}`)??Infinity;
     assert.ok(gap<.003,`${faction}/${side}: ${digit} fingertip wraps within 3 mm of the wood (${gap} m)`);
    }
   }
  }
 }
});
