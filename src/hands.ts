import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {clone} from 'three/addons/utils/SkeletonUtils.js';
import {makeHandSkin} from './handSkin';

const assets:Partial<Record<'left'|'right',THREE.Group>>={};
let loading:Promise<void>|undefined;
export async function loadHandAssetFromBuffer(side:'left'|'right',buffer:ArrayBuffer,loader=new GLTFLoader()){
 const source=(await loader.parseAsync(buffer,'')).scene;
 let hasSkin=false;source.traverse(object=>{if(object instanceof THREE.SkinnedMesh)hasSkin=true;});
 if(!hasSkin)throw new Error(`${side} hand source has no skinned surface`);
 assets[side]=source;
}
export function loadHandAssets(){
 return loading??=(async()=>{
  const loader=new GLTFLoader();
  const models=await Promise.all(['l','r'].map(side=>loader.loadAsync(`/assets/arms/hand-${side}.glb`)));
  for(let i=0;i<models.length;i++)assets[i===0?'left':'right']=models[i].scene;
 })();
}

/** The original hand has continuous knuckles, fingernails, UV skin and 20 bones.
 * Each rifle gets its own skeleton; shared immutable source assets stay cached. */
export function makeAnatomicalHand(side:'left'|'right',source=assets[side]){
 if(!source)return null;
 const group=new THREE.Group();group.name=`${side}-hand`;
 const model=clone(source);group.add(model);model.scale.setScalar(.82);
 if(side==='right') model.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(new THREE.Vector3(0,0,-1),new THREE.Vector3(-1,0,0),new THREE.Vector3(0,1,0)));
 else model.rotation.set(0,-Math.PI/2,0);
 model.position.set(side==='right'?.018:-.082,side==='right'?.074:.003,side==='right'?.010:.020);
 group.userData.wristLocal=model.position.clone().add(side==='right'?new THREE.Vector3(0,.018,0):new THREE.Vector3(-.018,0,0));
 const bones:THREE.Bone[]=[];
 model.traverse(object=>{
  if(object instanceof THREE.Bone){object.userData.restQuaternion=object.quaternion.clone();bones.push(object);}
  if(object instanceof THREE.SkinnedMesh){
   object.frustumCulled=false;object.geometry=object.geometry.clone();
   const original=object.material as THREE.MeshStandardMaterial;
   const surface=object.geometry.getAttribute('_skin_detail');
   if(surface)object.geometry.setAttribute('skinDetail',surface);
   else object.geometry.setAttribute('skinDetail',new THREE.Float32BufferAttribute(new Float32Array(object.geometry.getAttribute('position').count*3),3));
   const material=makeHandSkin(original);
   object.material=material;object.castShadow=true;object.receiveShadow=true;
  }
 });
 group.userData.anatomical={bones,model,side};
 poseAnatomicalHand(group,0);
 return group;
}

/** Rifle poses use a point inside the curled fingers, not the wrapper origin.
 * Keep this frame separate from the carried grenade's existing hand frame. */
export function configureRifleHand(hand:THREE.Group){
 const rig=hand.userData.anatomical as {model:THREE.Group;side:'left'|'right';bones:THREE.Bone[]}|undefined;if(!rig)return;
 if(rig.side==='right'){
  const rotation=new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,0,1),-.75);
  rig.model.position.applyQuaternion(rotation);rig.model.quaternion.premultiply(rotation);
  (hand.userData.wristLocal as THREE.Vector3).applyQuaternion(rotation);
  hand.userData.stockGrip=true;
  hand.updateMatrixWorld(true);
  const thumb=rig.bones.find(bone=>bone.name.replace(/[._]/g,'')==='thumb01R');
  if(thumb)thumb.userData.stockThumbAxis=new THREE.Vector3(0,0,1).applyQuaternion(thumb.getWorldQuaternion(new THREE.Quaternion()).invert());
 }
 if(rig.side==='left'){
  hand.updateMatrixWorld(true);
  const thumb=rig.bones.find(bone=>bone.name.replace(/[._]/g,'')==='thumb01L');
  if(thumb)thumb.userData.supportThumbAxis=new THREE.Vector3(0,0,1).applyQuaternion(thumb.getWorldQuaternion(new THREE.Quaternion()).invert());
 }
 rig.model.updateMatrix();
 configureHandWristFrame(hand);
 hand.userData.gripLocal=new THREE.Vector3(0,rig.side==='right'?.032:.038,-.108).applyMatrix4(rig.model.matrix);
 let contact:{mesh:THREE.SkinnedMesh;index:number}|undefined,distance=Infinity;
 if(rig.side==='right')rig.model.traverse(object=>{
  if(!(object instanceof THREE.SkinnedMesh))return;
  const positions=object.geometry.getAttribute('position'),target=new THREE.Vector3(.065,.058,-.114),point=new THREE.Vector3();
  for(let i=0;i<positions.count;i++){
   const d=point.fromBufferAttribute(positions,i).distanceToSquared(target);
   if(d<distance){distance=d;contact={mesh:object,index:i};}
  }
 });
 hand.userData.thumbContact=contact;
}

/** Actual source wrist-cap plane, including every nested grip transform.
 * This is shared by rifle and grenade grips instead of guessing a cuff center
 * from each wrapper's Euler angles. */
export function configureHandWristFrame(hand:THREE.Group){
 const rig=hand.userData.anatomical as {model:THREE.Group}|undefined;if(!rig)return;
 hand.updateMatrixWorld(true);
 const modelToHand=hand.matrixWorld.clone().invert().multiply(rig.model.matrixWorld);
 const axis=new THREE.Vector3(0,0,1).transformDirection(modelToHand);
 const skin=new THREE.Vector3(0,0,.025).applyMatrix4(modelToHand);
 hand.userData.wristAxisLocal=axis;
 hand.userData.wristWidthLocal=new THREE.Vector3(1,0,0).transformDirection(modelToHand);
 hand.userData.wristSkinLocal=skin;
 hand.userData.wristLocal=skin.clone().addScaledVector(axis,.006);
}

/** Sample an actual skinned thumb pad when loading; its anchor follows finger
 * bending and every nested model transform. All other grips use the palm cup. */
export function handContactLocal(hand:THREE.Group,thumbWeight=0){
 const contact=((hand.userData.gripLocal as THREE.Vector3|undefined)?.clone()??new THREE.Vector3());
 const marker=hand.userData.thumbContact as {mesh:THREE.SkinnedMesh;index:number}|undefined;
 if(marker&&thumbWeight>0){
  hand.updateMatrixWorld(true);marker.mesh.skeleton.update();
  const point=new THREE.Vector3().fromBufferAttribute(marker.mesh.geometry.getAttribute('position'),marker.index);
  marker.mesh.applyBoneTransform(marker.index,point);marker.mesh.localToWorld(point);hand.worldToLocal(point);
  contact.lerp(point,THREE.MathUtils.clamp(thumbWeight,0,1));
 }
 return contact;
}

const turn=new THREE.Quaternion(),axis=new THREE.Vector3(1,0,0);
export function poseAnatomicalHand(hand:THREE.Group,openness:number,grip:'rifle'|'cylinder'='rifle',press=0,grasp=0){
 const rig=hand.userData.anatomical as {bones:THREE.Bone[];side:'left'|'right'}|undefined;if(!rig)return;
 const open=THREE.MathUtils.clamp(openness,0,1);
 const stockWeight=hand.userData.stockGrip&&grip==='rifle'?(1-press)*(1-grasp):0;
 for(const bone of rig.bones){
  bone.quaternion.copy(bone.userData.restQuaternion);
  const name=bone.name.replace(/[._]/g,'');
  if(name.startsWith('f')){
   const segment=name.includes('01')?0:name.includes('02')?1:2;
   const index=name.startsWith('findex');
   const digit=index?'index':name.startsWith('fmiddle')?'middle':name.startsWith('fring')?'ring':'pinky';
   const support=hand.userData.supportFingerCurl;
   let base=(rig.side==='right'?(index&&grip==='rifle'?[.30,.5,.38]:[.72,1.02,.75]):(support?.[digit]??support??[.54,.85,.7]))[segment];
   if(rig.side==='right'&&index&&grip==='rifle')base=THREE.MathUtils.lerp(base,[.72,1.02,.75][segment],grasp);
   if(stockWeight>0){
    // A rifle's oval stock is wider than the bolt sphere. Relax each shorter
    // digit separately so its tip stays around the underside, not in wood.
    const stock=hand.userData.stockFingerCurl?.[digit]??(index?[.30,.50,.38]:name.startsWith('fpinky')?[.15,.30,.20]:name.startsWith('fring')?[.50,.50,.30]:[.65,.52,.38]);
    base=THREE.MathUtils.lerp(base,stock[segment],stockWeight);
   }
   const curl=THREE.MathUtils.lerp(base*(1-open*.85),[.90,1.35,.95][segment],press);
   bone.quaternion.multiply(turn.setFromAxisAngle(axis,curl));
  }else if(name.startsWith('thumb')){
   const segment=name.includes('01')?0:name.includes('02')?1:2;
   const restCurl=[.18,.32,.38][segment],curl=THREE.MathUtils.lerp(restCurl,hand.userData.stockThumbCurl?.[segment]??restCurl,stockWeight);
   bone.quaternion.multiply(turn.setFromAxisAngle(axis,THREE.MathUtils.lerp(curl*(1-open*.65),name.includes('01')?-.15:name.includes('02')?.08:.12,press)));
   if(bone.userData.supportThumbAxis)bone.quaternion.multiply(turn.setFromAxisAngle(bone.userData.supportThumbAxis,hand.userData.supportThumbTurn??.5));
   if(bone.userData.stockThumbAxis)bone.quaternion.multiply(turn.setFromAxisAngle(bone.userData.stockThumbAxis,(hand.userData.stockThumbTurn??-1.5)*stockWeight));
  }
 }
 const thumbAim=hand.userData.supportThumbDirection as THREE.Vector3|undefined;
 if(rig.side==='left'&&thumbAim){
  // Orient the proximal thumb toward the barrel instead of extending it
  // vertically beside the sights. Preserve the two distal joint curls.
  const base=rig.bones.find(bone=>bone.name.replace(/[._]/g,'')==='thumb01L');
  const tip=rig.bones.find(bone=>bone.name.replace(/[._]/g,'')==='thumb03L');
  if(base&&tip&&base.parent){
   hand.updateMatrixWorld(true);
   const parentInverse=base.parent.getWorldQuaternion(new THREE.Quaternion()).invert();
   const from=tip.getWorldPosition(new THREE.Vector3()).sub(base.getWorldPosition(new THREE.Vector3())).normalize().applyQuaternion(parentInverse);
   const to=thumbAim.clone().normalize().applyQuaternion(hand.getWorldQuaternion(new THREE.Quaternion())).applyQuaternion(parentInverse);
   base.quaternion.premultiply(new THREE.Quaternion().setFromUnitVectors(from,to));
  }
 }
}
