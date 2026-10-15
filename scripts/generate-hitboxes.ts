/** Bake actual imported skin/IK poses into a compact CPU-only collision atlas.
 * Run after changing soldier geometry, motion, weapon contacts, or world IK.
 * node --import tsx scripts/generate-hitboxes.ts
 */
import fs from 'node:fs';
import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {loadSoldierModelFromBuffer,SOLDIER_BONES,type SoldierModelProfile} from '../src/soldierModelAssets.ts';
import {loadImportedWeaponFromBuffer} from '../src/importedWeapons.ts';
import {loadHandAssetFromBuffer} from '../src/hands.ts';
import {makeSoldier} from '../src/soldier.ts';
import {SOURCE_JOINTS,SOURCE_BIND,SOURCE_CLIPS} from '../src/generated/mesh2motionData.ts';
import {sampleWeaponAnimation} from '../src/weaponAnimation.ts';
import {sampleSoldierPose,applySoldierPose,type SoldierActor} from '../src/soldierAnimation.ts';
import {WEAPONS,MELEE_SECONDS,type Faction} from '../src/config.ts';
const factions=['british','russian','german'] as const;
const loader=new GLTFLoader();loader.register(()=>({name:'collision-atlas-textures',loadTexture:()=>Promise.resolve(new THREE.Texture())}));
const buffer=(path:string)=>{const b=fs.readFileSync(path);return b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength);};
for(const side of ['left','right'] as const)await loadHandAssetFromBuffer(side,buffer(`public/assets/arms/hand-${side[0]}.glb`),loader);
const data:any={version:2,bones:SOLDIER_BONES,shapes:{},rigs:{},weaponControls:{},motions:{joints:SOURCE_JOINTS,bind:SOURCE_BIND,clips:SOURCE_CLIPS}};
const round=(n:number)=>Math.round(n*1e6)/1e6;
const tuple=(v:THREE.Vector3)=>v.toArray().map(round);
const quant=(v:number[],q:number)=>v.slice().sort((a,b)=>a-b)[Math.min(v.length-1,Math.floor(q*v.length))];
for(const faction of factions){
 const weapon={british:'enfield',russian:'mosin',german:'kar98k'}[faction];
 await loadImportedWeaponFromBuffer(buffer(`public/assets/imported-weapons/${weapon}.glb`),JSON.parse(fs.readFileSync(`public/assets/imported-weapons/${weapon}-profile.json`,'utf8')),loader);
 const profile:SoldierModelProfile=JSON.parse(fs.readFileSync(`public/assets/imported-soldiers/${faction}-profile.json`,'utf8'));
 await loadSoldierModelFromBuffer(buffer(`public/assets/imported-soldiers/${faction}.glb`),profile,loader);
 const model=makeSoldier(faction);data.rigs[faction]={bonePositions:profile.bonePositions,solePoints:model.userData.soldierRig.solePoints,weaponProfile:JSON.parse(fs.readFileSync(`public/assets/imported-weapons/${weapon}-profile.json`,'utf8'))};
 const points:{bone:number;p:THREE.Vector3;surface:string}[]=[];
 model.traverse(object=>{
  if(!(object instanceof THREE.SkinnedMesh)||!object.skeleton.bones.some(b=>b.name==='skin-pelvis'))return;
  if(process.env.DEBUG_HITBOX)console.log(object.name,object.geometry.getAttribute('position').count);
  // Clothing and skin count; helmets, straps, pouches and carried equipment do
  // not. In particular a broad helmet brim must never enlarge the face hitbox.
  const keep=faction==='british'?/^british-(head-11|torso-19|legs-31|foot-2[4-7]|hand-9)$/.test(object.name):faction==='russian'?/^russian-(body|uniform)$/.test(object.name):/^(?:german-)?main_Material003_0(?:_[12])?$/.test(object.name);
  if(!keep)return;
  const pos=object.geometry.getAttribute('position'),idx=object.geometry.getAttribute('skinIndex'),w=object.geometry.getAttribute('skinWeight');
  const used=new Set<number>(object.geometry.index?Array.from(object.geometry.index.array):Array.from({length:pos.count},(_,i)=>i));
  for(const i of used){let bone=0,weight=-1;for(let j=0;j<4;j++)if(w.getComponent(i,j)>weight){weight=w.getComponent(i,j);bone=idx.getComponent(i,j);}points.push({bone,p:new THREE.Vector3().fromBufferAttribute(pos,i),surface:object.name});}
 });
 const shapes:any[]=[];
 function shape(name:string,part:string,bone:number,p:THREE.Vector3[],limits?:{y:[number,number];x?:number;rx?:number;rz?:number}){
  const origin=new THREE.Vector3(...profile.bonePositions[SOLDIER_BONES[bone]]);
  let accepted=p;if(limits)accepted=p.filter(p=>p.y>=limits.y[0]&&p.y<=limits.y[1]&&(limits.x===undefined||Math.abs(p.x-origin.x)<limits.x));
  if(accepted.length<8)throw new Error(`Too few fit vertices ${faction} ${name}: ${accepted.length}`);
  const min=new THREE.Vector3(...[0,1,2].map(axis=>quant(accepted.map(p=>p.getComponent(axis)),.01))),max=new THREE.Vector3(...[0,1,2].map(axis=>quant(accepted.map(p=>p.getComponent(axis)),.99)));
  if(limits){min.y=limits.y[0];max.y=limits.y[1];}
  const center=min.clone().add(max).multiplyScalar(.5),half=max.clone().sub(min).multiplyScalar(.5);
  // The source surface cross-section is elliptical. Small overlap along the
  // long axis joins neighboring body sections without filling spaces between
  // limbs or adding square corners around the mesh.
  half.y*=1.15;half.x=Math.min(limits?.rx??Infinity,half.x);half.z=Math.min(limits?.rz??Infinity,half.z);
  shapes.push({name,part,bone,center:tuple(center.sub(origin)),halfSize:tuple(half)});
 }
 const pts=(bone:number)=>points.filter(p=>p.bone===bone).map(p=>p.p);
 const body=points.filter(p=>p.bone<3).map(p=>p.p);
 shape('head','head',2,points.filter(p=>p.bone===2&&(faction==='british'?p.surface==='british-head-11':faction==='russian'?p.surface==='russian-body':/main_Material003_0_2$/.test(p.surface))).map(p=>p.p),{y:[1.535,1.765],x:.14,rx:.105,rz:.115});
 shape('neck','torso',2,body,{y:[1.465,1.56],x:.075,rx:.066,rz:.065});
 shape('chest','torso',1,body,{y:[1.205,1.47],x:.212,rx:.207,rz:faction==='russian'?.150:.14});
 shape('abdomen','lowerTorso',1,body,{y:[.99,1.22],x:.19,rx:.185,rz:.13});
 shape('pelvis','lowerTorso',0,body,{y:[.84,1.035],x:.21,rx:.192,rz:.135});
 for(const [start,side]of [[3,'L'],[6,'R']] as const){
  const upper=profile.bonePositions[SOLDIER_BONES[start]][1],elbow=profile.bonePositions[SOLDIER_BONES[start+1]][1],wrist=profile.bonePositions[SOLDIER_BONES[start+2]][1];
  shape(`upperArm${side}`,'limb',start,pts(start),{y:[elbow-.02,upper+.015],x:.11,rx:.076,rz:.082});
  shape(`forearm${side}`,'limb',start+1,pts(start+1),{y:[wrist-.012,elbow+.02],x:.09,rx:.062,rz:.068});
  shapes.push({name:`hand${side}`,part:'extremity',bone:start+2,center:[0,-.060,0],halfSize:[.038,.072,.032]});
 }
 for(const [start,side]of [[9,'L'],[12,'R']] as const){
  const hip=profile.bonePositions[SOLDIER_BONES[start]][1],knee=profile.bonePositions[SOLDIER_BONES[start+1]][1],ankle=profile.bonePositions[SOLDIER_BONES[start+2]][1];
  shape(`thigh${side}`,'limb',start,pts(start),{y:[knee-.02,hip+.04],x:.14,rx:.105,rz:.115});
  shape(`calf${side}`,'lowerLimb',start+1,pts(start+1),{y:[ankle-.012,knee+.03],x:.12,rx:.083,rz:.09});
  shape(`foot${side}`,'extremity',start+2,pts(start+2),{y:[.005,.16],x:.11,rx:.082,rz:.148});
 }
 data.shapes[faction]=shapes;
 const base:SoldierActor={id:0,x:0,y:0,z:0,yaw:0,pitch:0,stance:'stand',alive:true,moving:0,ads:false,recoil:0,cooldown:0,reload:0,reloadTotal:0};
 // Calibrate the support contact against the actual imported stock underside.
 applySoldierPose(model,sampleSoldierPose(base,faction,0));
 const controls:any={};data.weaponControls[faction]=controls;
 const thresholds=[0,.025,.06,.07,.08,.12,.13,.16,.17,.18,.22,.24,.25,.27,.28,.29,.30,.31,.32,.34,.35,.38,.40,.44,.46,.47,.52,.54,.56,.65,.68,.7,.70,.71,.72,.73,.735,.755,.76,.77,.79,.80,.84,.85,.87,.88,.91,1];
 for(const count of [1,2])for(let clip=0;clip<count;clip++)for(const key of [0,.07,.28,.29,.38,.70,.71,.72,.84,.85,1])thresholds.push(.35+(clip+key)/count*.385);
 const phases=[...new Set([...Array.from({length:801},(_,i)=>i/800),...thresholds,...SOURCE_CLIPS.Pistol_Reload.frames.map((_,i)=>i/(SOURCE_CLIPS.Pistol_Reload.frames.length-1))])].sort((a,b)=>a-b);
 const extract=(pose:ReturnType<typeof sampleWeaponAnimation>)=>({position:pose.position,rotation:pose.rotation,right:pose.right,fingerOpen:pose.fingerOpen,thumbContact:pose.thumbContact,boltGrip:pose.boltGrip});
 for(const mode of ['idle','cycle','reload','reloadPartial','melee'] as const){const samples=mode==='idle'?[0,1]:phases;controls[mode]={phases:samples,frames:samples.map(phase=>extract(sampleWeaponAnimation(faction,mode==='reloadPartial'?'reload':mode,phase,mode==='reload')))};}
 const rig=model.userData.soldierRig;data.rigs[faction].rifle={position:rig.rifle.position.toArray(),rotation:rig.rifle.quaternion.toArray(),scale:rig.rifle.scale.toArray()};data.rigs[faction].stockContacts=rig.stockContacts;
 console.log(`${faction}: fitted ${shapes.length} body volumes and ${phases.length} action-control phases`);
}
fs.writeFileSync('src/generated/hitboxData.json',JSON.stringify(data));
console.log(`Wrote ${fs.statSync('src/generated/hitboxData.json').size} bytes`);
