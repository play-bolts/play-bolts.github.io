import {readFileSync} from 'node:fs';
import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {makeSoldier} from '../src/soldier';
import {loadSoldierModelFromBuffer} from '../src/soldierModelAssets';
import {applySoldierPose,sampleSoldierPose,type SoldierActor,type SoldierRig} from '../src/soldierAnimation';
import {groundGait} from '../src/soldierGait';

const loader=new GLTFLoader();loader.register(()=>({name:'leg-review-textures',loadTexture:()=>Promise.resolve(new THREE.Texture())}));
const round=(v:number)=>Math.round(v*1000)/1000;
for(const faction of ['british','russian','german'] as const){
 const bytes=readFileSync(`public/assets/imported-soldiers/${faction}.glb`);
 const profile=JSON.parse(readFileSync(`public/assets/imported-soldiers/${faction}-profile.json`,'utf8'));
 await loadSoldierModelFromBuffer(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength) as ArrayBuffer,profile,loader);
 const model=makeSoldier(faction),rig=model.userData.soldierRig as SoldierRig;
 const bounds=[new THREE.Box3(),new THREE.Box3()];
 model.traverse(mesh=>{if(mesh instanceof THREE.SkinnedMesh){const p=mesh.geometry.getAttribute('position');for(let i=0;i<p.count;i++)if(p.getY(i)<.12)bounds[p.getX(i)<0?0:1].expandByPoint(new THREE.Vector3().fromBufferAttribute(p,i));}});
 const cases=[];
 for(const [stance,speed] of [['stand',0],['stand',1.7],['stand',4.5],['crouch',0],['crouch',1.3],['crouch',2.82]] as const){
  const actor:SoldierActor={id:0,x:0,y:0,z:0,yaw:0,pitch:0,stance,moving:speed,grounded:true,alive:true,ads:false,recoil:0,cooldown:0,reload:0,reloadTotal:0};
  const frames=[];
  for(let i=0;i<100;i++){
   const phase=i/100,pose=sampleSoldierPose(actor,faction,2,{phase});applySoldierPose(model,pose);model.updateMatrixWorld(true);
   const hip=rig.leftLeg.root.getWorldPosition(new THREE.Vector3()),knee=rig.leftLeg.middle.getWorldPosition(new THREE.Vector3()),ankle=rig.leftLeg.end.getWorldPosition(new THREE.Vector3());
   const lower=ankle.clone().sub(knee),upper=knee.clone().sub(hip);
   const tibia=lower.clone().negate().applyQuaternion(rig.leftLeg.end.getWorldQuaternion(new THREE.Quaternion()).invert());
   const kneeFlex=upper.angleTo(lower)*180/Math.PI,ankleFlex=Math.atan2(-tibia.z,tibia.y)*180/Math.PI;
   frames.push({phase,support:groundGait(speed,Number(stance==='crouch'),phase,1,0).left.support,kneeFlex,ankleFlex,hipY:hip.y,kneeY:knee.y,foot:ankle.toArray()});
  }
  const range=(key:'kneeFlex'|'ankleFlex'|'hipY'|'kneeY',supportOnly=false)=>{const values=frames.filter(f=>!supportOnly||f.support).map(f=>f[key]);return [round(Math.min(...values)),round(Math.max(...values))];};
  cases.push({stance,speed,knee:range('kneeFlex'),supportKnee:range('kneeFlex',true),ankle:range('ankleFlex'),hip:range('hipY'),kneeY:range('kneeY'),frames:frames.filter((_,i)=>i%10===0).map(f=>({...f,kneeFlex:round(f.kneeFlex),ankleFlex:round(f.ankleFlex),foot:f.foot.map(round)}))});
 }
 console.log(JSON.stringify({faction,bootSize:bounds.map(box=>box.getSize(new THREE.Vector3()).toArray().map(round)),cases}));
}
