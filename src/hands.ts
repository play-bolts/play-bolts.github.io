import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {clone} from 'three/addons/utils/SkeletonUtils.js';
import {makeHandSkin} from './handSkin';
import {rememberLodGeometryClone} from './lodGeometryIdentity';

const assets:Partial<Record<'left'|'right',THREE.Group>>={};
// Immutable loaded asset identity, kept outside serializable/mutable userData.
// A replacement asset gets a new key; independently cloned rigs retain no
// reference to another actor's mutable bones or disposable geometry.
const handSources=new WeakMap<THREE.Group,THREE.Group>();
export const anatomicalHandSource=(hand:THREE.Group)=>handSources.get(hand);
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
   object.frustumCulled=false;const sourceGeometry=object.geometry;object.geometry=sourceGeometry.clone();rememberLodGeometryClone(sourceGeometry,object.geometry);
   const original=object.material as THREE.MeshStandardMaterial;
   const surface=object.geometry.getAttribute('_skin_detail');
   if(surface)object.geometry.setAttribute('skinDetail',surface);
   else object.geometry.setAttribute('skinDetail',new THREE.Float32BufferAttribute(new Float32Array(object.geometry.getAttribute('position').count*3),3));
   const material=makeHandSkin(original);
   object.material=material;object.castShadow=true;object.receiveShadow=true;
  }
 });
 group.userData.anatomical={bones,model,side};handSources.set(group,source);
 poseAnatomicalHand(group,0);
 return group;
}

/** Rifle poses use a point inside the curled fingers, not the wrapper origin.
 * Keep this frame separate from the carried grenade's existing hand frame.
 * The compact operating grip is opt-in for the first-person rifle; world hands
 * retain the canonical skin contacts shared with authoritative collision. */
export function configureRifleHand(hand:THREE.Group,closedActionGrip=false){
 const rig=hand.userData.anatomical as {model:THREE.Group;side:'left'|'right';bones:THREE.Bone[]}|undefined;if(!rig)return;
 if(rig.side==='right'){
  const rotation=new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,0,1),-.75);
  rig.model.position.applyQuaternion(rotation);rig.model.quaternion.premultiply(rotation);
  (hand.userData.wristLocal as THREE.Vector3).applyQuaternion(rotation);
  hand.userData.stockGrip=true;
  hand.updateMatrixWorld(true);
  const thumb=rig.bones.find(bone=>bone.name.replace(/[._]/g,'')==='thumb01R');
  if(thumb)thumb.userData.stockThumbAxis=new THREE.Vector3(0,0,1).applyQuaternion(thumb.getWorldQuaternion(new THREE.Quaternion()).invert());
  if(closedActionGrip){
   hand.userData.closedActionGrip=true;
   // Remove the source's finger fan and cup the shorter metacarpals. Keep
   // these targets separate from rest transforms so stock grips stay fitted.
   const closed=rig.model.getWorldQuaternion(new THREE.Quaternion()).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1,0,0),-Math.PI/2));
   for(const bone of rig.bones)if(/^f.*01R$/.test(bone.name.replace(/[._]/g,''))&&bone.parent){
    bone.userData.closedRestQuaternion=bone.parent.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(closed);
   }
   const palmTurn:Record<string,[number,number]>={palmindexR:[.07,0],palmmiddleR:[0,0],palmringR:[-.045,.07],palmpinkyR:[-.12,.25]};
   for(const bone of rig.bones){
    const angles=palmTurn[bone.name.replace(/[._]/g,'')];if(!angles||!bone.parent)continue;
    const frame=bone.parent.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(rig.model.getWorldQuaternion(new THREE.Quaternion()));
    const across=new THREE.Vector3(0,1,0).applyQuaternion(frame),bend=new THREE.Vector3(1,0,0).applyQuaternion(frame);
    bone.userData.closedRestQuaternion=new THREE.Quaternion().setFromAxisAngle(across,angles[0]).multiply(new THREE.Quaternion().setFromAxisAngle(bend,angles[1])).multiply(bone.userData.restQuaternion);
   }
  }
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
const INDEX_CURL=[.30,.5,.38],GRASP_CURL=[.72,1.02,.75],SUPPORT_CURL=[.54,.85,.7],PRESS_CURL=[.90,1.35,.95],THUMB_CURL=[.18,.32,.38],THUMB_PRESS=[-.15,.08,.12];
const STOCK_CURL={index:INDEX_CURL,pinky:[.15,.30,.20],ring:[.50,.50,.30],middle:[.65,.52,.38]};
// Fitted to the actual skinned fingertips around the bolt's palm contact.
// Per-digit bends and adduction keep adjacent fingers touching as they curl.
const BOLT_CURL={index:[.757,.873,.757],middle:[.72,1.02,.85],ring:[.6,.665,1.109],pinky:[.555,.289,.897]};
const BOLT_ADDUCTION={index:.337,middle:0,ring:-.216,pinky:-.344};
const BOLT_THUMB_CURL=[.3,.5,.4],adductionAxis=new THREE.Vector3(0,0,1);
type BonePoseInfo={sourceName:string;name:string;kind:'finger'|'thumb'|'other';segment:number;index:boolean;digit:'index'|'middle'|'ring'|'pinky';stock:readonly number[]};
const bonePoseInfo=new WeakMap<THREE.Bone,BonePoseInfo>();
function describeBone(bone:THREE.Bone){
 let info=bonePoseInfo.get(bone);if(info?.sourceName===bone.name)return info;
 const name=bone.name.replace(/[._]/g,''),index=name.startsWith('findex');
 info={sourceName:bone.name,name,kind:name.startsWith('f')?'finger':name.startsWith('thumb')?'thumb':'other',segment:name.includes('01')?0:name.includes('02')?1:2,index,digit:index?'index':name.startsWith('fmiddle')?'middle':name.startsWith('fring')?'ring':'pinky',stock:index?STOCK_CURL.index:name.startsWith('fpinky')?STOCK_CURL.pinky:name.startsWith('fring')?STOCK_CURL.ring:STOCK_CURL.middle};
 bonePoseInfo.set(bone,info);return info;
}
// Pose calls are synchronous. Scratch values never escape into a hand/pose and
// do not overlap the earlier finger-turn scratch quaternion.
const thumbParentInverse=new THREE.Quaternion(),thumbHandRotation=new THREE.Quaternion(),thumbSwing=new THREE.Quaternion();
const thumbFrom=new THREE.Vector3(),thumbBasePosition=new THREE.Vector3(),thumbTo=new THREE.Vector3();
export function poseAnatomicalHand(hand:THREE.Group,openness:number,grip:'rifle'|'cylinder'='rifle',press=0,grasp=0){
 const rig=hand.userData.anatomical as {bones:THREE.Bone[];side:'left'|'right'}|undefined;if(!rig)return;
 const open=THREE.MathUtils.clamp(openness,0,1);
 const closed=rig.side==='right'&&hand.userData.closedActionGrip&&grip==='rifle';
 // Fingers can uncurl to release the bolt/charger without fanning apart.
 const closedWeight=closed?THREE.MathUtils.clamp(grasp+press+open*3,0,1):0;
 const stockWeight=hand.userData.stockGrip&&grip==='rifle'?(1-press)*(1-grasp):0;
 let thumbBase:THREE.Bone|undefined,thumbTip:THREE.Bone|undefined;
 for(const bone of rig.bones){
  bone.quaternion.copy(bone.userData.restQuaternion);
  if(closed&&bone.userData.closedRestQuaternion)bone.quaternion.slerp(bone.userData.closedRestQuaternion,closedWeight);
  const info=describeBone(bone),{name,segment,index,digit}=info;
  if(name==='thumb01L'&&!thumbBase)thumbBase=bone;if(name==='thumb03L'&&!thumbTip)thumbTip=bone;
  if(info.kind==='finger'){
   const support=hand.userData.supportFingerCurl;
   let base=(rig.side==='right'?(index&&grip==='rifle'?INDEX_CURL:GRASP_CURL):(support?.[digit]??support??SUPPORT_CURL))[segment];
   if(rig.side==='right'&&index&&grip==='rifle')base=THREE.MathUtils.lerp(base,GRASP_CURL[segment],grasp);
   if(stockWeight>0){
    // A rifle's oval stock is wider than the bolt sphere. Relax each shorter
    // digit separately so its tip stays around the underside, not in wood.
    const stock=hand.userData.stockFingerCurl?.[digit]??info.stock;
    base=THREE.MathUtils.lerp(base,stock[segment],stockWeight);
   }
   if(closed)base=THREE.MathUtils.lerp(base,BOLT_CURL[digit][segment],grasp);
   const curl=THREE.MathUtils.lerp(base*(1-open*.85),closed?BOLT_CURL[digit][segment]:PRESS_CURL[segment],press);
   bone.quaternion.multiply(turn.setFromAxisAngle(axis,curl));
   if(closed&&segment===0)bone.quaternion.multiply(turn.setFromAxisAngle(adductionAxis,BOLT_ADDUCTION[digit]*closedWeight));
  }else if(info.kind==='thumb'){
   const restCurl=closed?THREE.MathUtils.lerp(THUMB_CURL[segment],BOLT_THUMB_CURL[segment],grasp):THUMB_CURL[segment],curl=THREE.MathUtils.lerp(restCurl,hand.userData.stockThumbCurl?.[segment]??restCurl,stockWeight);
   bone.quaternion.multiply(turn.setFromAxisAngle(axis,THREE.MathUtils.lerp(curl*(1-open*.65),THUMB_PRESS[segment],press)));
   if(bone.userData.supportThumbAxis)bone.quaternion.multiply(turn.setFromAxisAngle(bone.userData.supportThumbAxis,hand.userData.supportThumbTurn??.5));
   if(bone.userData.stockThumbAxis)bone.quaternion.multiply(turn.setFromAxisAngle(bone.userData.stockThumbAxis,(hand.userData.stockThumbTurn??-1.5)*stockWeight));
  }
 }
 const thumbAim=hand.userData.supportThumbDirection as THREE.Vector3|undefined;
 if(rig.side==='left'&&thumbAim){
  // Orient the proximal thumb toward the barrel instead of extending it
  // vertically beside the sights. Preserve the two distal joint curls.
  const base=thumbBase,tip=thumbTip;
  if(base&&tip&&base.parent){
   hand.updateMatrixWorld(true);
   const parentInverse=base.parent.getWorldQuaternion(thumbParentInverse).invert();
   const from=tip.getWorldPosition(thumbFrom).sub(base.getWorldPosition(thumbBasePosition)).normalize().applyQuaternion(parentInverse);
   const to=thumbTo.copy(thumbAim).normalize().applyQuaternion(hand.getWorldQuaternion(thumbHandRotation)).applyQuaternion(parentInverse);
   base.quaternion.premultiply(thumbSwing.setFromUnitVectors(from,to));
  }
 }
}
