import {readFileSync} from 'node:fs';
import * as THREE from 'three';
import {loadModelDetailsFromBuffer} from '../src/modelDetails.ts';
import {makeSoldier} from '../src/soldier.ts';
import {sampleSoldierPose,applySoldierPose} from '../src/soldierAnimation.ts';
const bytes=readFileSync('public/assets/details/model-details.glb');
await loadModelDetailsFromBuffer(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength));
const rows=[];
for(const faction of ['british','russian','german'] as const){
 const model=makeSoldier(faction);let lowest=0;
 for(const stance of ['stand','crouch','prone'] as const)for(const speed of [0,1.7,4.5])for(let i=0;i<=80;i++){
  const actor={id:1,x:0,y:0,z:0,yaw:0,pitch:0,stance,alive:true,moving:speed,ads:true,recoil:0,cooldown:0,reload:0,reloadTotal:0};
  applySoldierPose(model,sampleSoldierPose(actor,faction,i/40,{phase:i/80}));
  const conservative=new THREE.Box3().setFromObject(model).min.y;
  if(conservative<0){
   const precise=new THREE.Box3().setFromObject(model,true).min.y;
   if(precise<lowest){lowest=precise;let objectName='';
    model.traverse(object=>{if(object instanceof THREE.Mesh&&new THREE.Box3().setFromObject(object,true).min.y<=precise+1e-8)objectName=object.name;});
    rows.push({faction,stance,speed,phase:i/80,conservative,precise,objectName});
   }
  }
 }
}
console.log(JSON.stringify(rows,null,2));
