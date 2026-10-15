import test,{before} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {FACTIONS,HEIGHTS,WEAPONS,clamp,lerp,rayBox,type Faction,type Vec} from '../src/config.ts';
import {loadSoldierModelFromBuffer,SOLDIER_BONES} from '../src/soldierModelAssets.ts';
import {loadImportedWeaponFromBuffer} from '../src/importedWeapons.ts';
import {loadHandAssetFromBuffer} from '../src/hands.ts';
import {makeSoldier} from '../src/soldier.ts';
import {sampleSoldierPose,applySoldierPose} from '../src/soldierAnimation.ts';
import {sampleHitVolumes,rayHitVolumes,type HitActor,type HitVolume} from '../src/hitboxes.ts';
import {initialMotion} from '../src/soldierMotionState.ts';

// These tests load the same complete GLBs as the renderer. They do not compare
// the atlas to another copy of its interpolation equations or a proxy mesh.
const models={} as Record<Faction,THREE.Group>;
const atlas=JSON.parse(readFileSync(new URL('../src/generated/hitboxData.json',import.meta.url),'utf8'));
const bytes=(path:string)=>{const b=readFileSync(new URL(path,import.meta.url));return b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength);};
before(async()=>{
 const loader=new GLTFLoader();loader.register(()=>({name:'geometry-audit-textures',loadTexture:()=>Promise.resolve(new THREE.Texture())}));
 for(const side of ['left','right'] as const)await loadHandAssetFromBuffer(side,bytes(`../public/assets/arms/hand-${side[0]}.glb`),loader);
 for(const faction of FACTIONS){
  const weapon={british:'enfield',russian:'mosin',german:'kar98k'}[faction];
  await loadImportedWeaponFromBuffer(bytes(`../public/assets/imported-weapons/${weapon}.glb`),JSON.parse(readFileSync(new URL(`../public/assets/imported-weapons/${weapon}-profile.json`,import.meta.url),'utf8')),loader);
  await loadSoldierModelFromBuffer(bytes(`../public/assets/imported-soldiers/${faction}.glb`),JSON.parse(readFileSync(new URL(`../public/assets/imported-soldiers/${faction}-profile.json`,import.meta.url),'utf8')),loader);
  models[faction]=makeSoldier(faction);
 }
});

function actor(faction:Faction,patch:Partial<HitActor>={},time=10):HitActor{
 const a:HitActor={id:2,faction,x:0,y:0,z:0,yaw:0,pitch:0,stance:'stand',ads:false,moving:0,lean:0,alive:true,grounded:true,vy:0,jumpStarted:-1e6,landedAt:-1e6,landingSpeed:0,lastShotTime:-1e6,lastHurtTime:-1e6,lastMeleeTime:-1e6,reload:0,reloadTotal:0,recoil:0,selectedWeapon:'rifle',...patch};
 a.pose??=initialMotion(a,time);return a;
}
function pose(a:HitActor,time=10){
 const model=models[a.faction];model.position.set(0,0,0);model.quaternion.identity();model.updateMatrixWorld(true);
 applySoldierPose(model,sampleSoldierPose({...a,recoil:a.recoil??0,cooldown:0},a.faction,time,a.pose));
 model.position.set(a.x,a.y,a.z);model.rotation.y=a.yaw;model.updateMatrixWorld(true);
 model.traverse(object=>{if(object instanceof THREE.SkinnedMesh)object.skeleton.update();});
 return model;
}
const vector=(p:Vec)=>new THREE.Vector3(p.x,p.y,p.z);
const directions=Array.from({length:80},(_,i)=>{const y=1-2*(i+.5)/80,r=Math.sqrt(1-y*y),angle=i*2.399963229728653;return new THREE.Vector3(Math.cos(angle)*r,y,Math.sin(angle)*r);});
function surfaceError(model:THREE.Group,a:HitActor,volumes:HitVolume[]){
 return volumes.map(volume=>{
  const shape=atlas.shapes[a.faction].find((s:{name:string})=>s.name===volume.name);
  const bone=model.getObjectByName(`skin-${SOLDIER_BONES[shape.bone]}`)!.parent!,center=bone.localToWorld(new THREE.Vector3(...shape.center));
  const q=bone.getWorldQuaternion(new THREE.Quaternion()),predicted=new THREE.Quaternion(...volume.rotation),offset=center.sub(vector(volume.center));
  const radii=new THREE.Vector3(...shape.halfSize);
  const radius=(n:THREE.Vector3,rotation:THREE.Quaternion)=>n.clone().applyQuaternion(rotation.clone().invert()).multiply(radii).length();
  // Compare ellipsoid support planes, not corresponding local points: an
  // ellipsoid rotated180 degrees can be the same shape, not a large error.
  const error=Math.max(...directions.map(n=>Math.abs(offset.dot(n))+Math.abs(radius(n,q)-radius(n,predicted))));
  return{name:volume.name,error};
 });
}

function bodyMeshes(model:THREE.Group,faction:Faction){
 const result:THREE.SkinnedMesh[]=[];
 model.traverse(object=>{
  if(!(object instanceof THREE.SkinnedMesh))return;
  const body=object.skeleton.bones.some(b=>b.name==='skin-pelvis');
  // Count skin/uniform and articulated hands. Equipment, straps, rifles and
  // helmet brims are visible decoration, intentionally not damageable flesh.
  const keep=!body|| (faction==='british'?/^british-(head-11|torso-19|legs-31|foot-2[4-7]|hand-9)$/.test(object.name):faction==='russian'?/^russian-(body|uniform)$/.test(object.name):/^(?:german-)?main_Material003_0(?:_[12])?$/.test(object.name));
  if(keep)result.push(object);
 });return result;
}
type Projection={u:0|1|2;v:0|1|2;axis:0|1|2;label:string};
const front:Projection={u:0,v:1,axis:2,label:'front'},side:Projection={u:2,v:1,axis:0,label:'side'},top:Projection={u:0,v:2,axis:1,label:'top'};
const PIXEL=.0125,MIN=-1.35,MAX=2.05,SIZE=Math.ceil((MAX-MIN)/PIXEL);
function silhouette(model:THREE.Group,faction:Faction,projection:Projection){
 const mask=new Uint8Array(SIZE*SIZE),{u,v}=projection;
 const p=new THREE.Vector3();
 for(const mesh of bodyMeshes(model,faction)){
  const position=mesh.geometry.getAttribute('position'),index=mesh.geometry.index;
  const points=new Float64Array(position.count*2);
  for(let i=0;i<position.count;i++){
   mesh.getVertexPosition(i,p).applyMatrix4(mesh.matrixWorld);
   points[i*2]=(p.getComponent(u)-MIN)/PIXEL;points[i*2+1]=(p.getComponent(v)-MIN)/PIXEL;
  }
  for(let i=0;i<(index?.count??position.count);i+=3){
   const ia=index?index.getX(i):i,ib=index?index.getX(i+1):i+1,ic=index?index.getX(i+2):i+2;
   const ax=points[ia*2],ay=points[ia*2+1],bx=points[ib*2],by=points[ib*2+1],cx=points[ic*2],cy=points[ic*2+1];
   const area=(bx-ax)*(cy-ay)-(by-ay)*(cx-ax);if(Math.abs(area)<1e-9)continue;
   const xmin=Math.max(0,Math.ceil(Math.min(ax,bx,cx)-.5)),xmax=Math.min(SIZE-1,Math.floor(Math.max(ax,bx,cx)-.5));
   const ymin=Math.max(0,Math.ceil(Math.min(ay,by,cy)-.5)),ymax=Math.min(SIZE-1,Math.floor(Math.max(ay,by,cy)-.5));
   for(let y=ymin;y<=ymax;y++)for(let x=xmin;x<=xmax;x++){
    const dx=x+.5-ax,dy=y+.5-ay,s=(dx*(cy-ay)-dy*(cx-ax))/area,t=((bx-ax)*dy-(by-ay)*dx)/area;
    if(s>=0&&t>=0&&s+t<=1)mask[y*SIZE+x]=1;
   }
  }
 }return mask;
}
function oldHit(a:HitActor,origin:Vec,direction:Vec){
 // The previous production damage bands, kept only as a comparison baseline.
 const h=HEIGHTS[a.stance],r=lerp(.43,.29,clamp((h-HEIGHTS.prone)/(HEIGHTS.crouch-HEIGHTS.prone),0,1));
 for(const[low,high,radius]of [[h-.16,h+.18,.18],[h*.63,h-.16,r],[h*.43,h*.63,r],[h*.25,h*.43,r],[h*.075,h*.25,r],[0,h*.075,r]]){
  const n=rayBox(origin,direction,{min:{x:a.x-radius,y:a.y+low,z:a.z-radius},max:{x:a.x+radius,y:a.y+high,z:a.z+radius}});if(Number.isFinite(n))return true;
 }return false;
}
function compareSilhouette(a:HitActor,projection:Projection){
 const model=pose(a),mask=silhouette(model,a.faction,projection),volumes=sampleHitVolumes(a,10),direction=new THREE.Vector3().setComponent(projection.axis,1),origin=new THREE.Vector3();
 let body=0,inside=0,interior=0,interiorHits=0,oldFalse=0,newFalse=0,newHits=0,oldHits=0,farFalse=0;
 for(let y=0;y<SIZE;y++)for(let x=0;x<SIZE;x++){
  origin.set(0,0,0).setComponent(projection.axis,-3).setComponent(projection.u,MIN+(x+.5)*PIXEL).setComponent(projection.v,MIN+(y+.5)*PIXEL);
  const o={x:origin.x,y:origin.y,z:origin.z},d={x:direction.x,y:direction.y,z:direction.z};
  const old=oldHit(a,o,d),current=Boolean(rayHitVolumes(o,d,volumes)),actual=Boolean(mask[y*SIZE+x]);
  if(actual){body++;if(current)inside++;let surrounded=true;for(let oy=-2;oy<=2&&surrounded;oy++)for(let ox=-2;ox<=2;ox++){if(ox*ox+oy*oy>4)continue;const xx=x+ox,yy=y+oy;if(xx<0||xx>=SIZE||yy<0||yy>=SIZE||!mask[yy*SIZE+xx]){surrounded=false;break;}}if(surrounded){interior++;if(current)interiorHits++;}}if(old)oldHits++;if(current)newHits++;
  if(!actual){if(old)oldFalse++;if(current){newFalse++;let nearby=false;for(let oy=-2;oy<=2&&!nearby;oy++)for(let ox=-2;ox<=2;ox++){if(ox*ox+oy*oy>4)continue;const xx=x+ox,yy=y+oy;if(xx>=0&&xx<SIZE&&yy>=0&&yy<SIZE&&mask[yy*SIZE+xx]){nearby=true;break;}}if(!nearby)farFalse++;}}
 }
 return{body,coverage:inside/body,interiorCoverage:interiorHits/interior,oldFalse,newFalse,oldHits,newHits,farFalse};
}

test('collision volumes follow actual imported posed bones through stance, aim and action changes',t=>{
 const failures:string[]=[];let worst=0;
 for(const faction of FACTIONS){
  const total=WEAPONS[faction].reload;
  const cases:Partial<HitActor>[]=[];
  for(const stance of ['stand','crouch','prone'] as const)for(const pitch of [0,-.7,.4,1.45])cases.push({stance,pitch,ads:true});
  for(const stance of ['stand','crouch','prone'] as const)cases.push({stance,lean:1,pitch:.4,ads:true},{stance,reload:total*.45,reloadTotal:total},{stance,lastShotTime:10-WEAPONS[faction].cycle*.4},{stance,lastHurtTime:9.8});
  cases.push({pose:{...initialMotion(actor(faction),10),crouch:.5}},{pose:{...initialMotion(actor(faction),10),prone:.5}},{moving:2.6},{x:2,y:.3,z:-4,yaw:.7,lean:-.85,pitch:.5,ads:true},{grounded:false,jumpStarted:9.73,y:1.1,vy:2.5},{landedAt:9.91,landingSpeed:6.4},{switchStarted:9.75,switchDuration:.56,switchFrom:'rifle',selectedWeapon:'grenade'});
  for(const patch of cases){const a=actor(faction,patch),errors=surfaceError(pose(a),a,sampleHitVolumes(a,10));for(const e of errors){worst=Math.max(worst,e.error);if(e.error>1e-7)failures.push(`${faction} ${JSON.stringify(patch)} ${e.name}: ${(e.error*1000).toFixed(6)}mm`);}}
 }
 t.diagnostic(`maximum posed-volume boundary error ${worst}m`);assert.equal(failures.length,0,`collision solve must stay within 0.1 micrometres of the actual posed body volume:\n${failures.slice(0,20).join('\n')}`);
});

test('body volumes reduce empty-space hits against actual source silhouettes',t=>{
 const failures:string[]=[];let oldFalse=0,newFalse=0,lowestCoverage=1,lowestInterior=1,highestEmpty=0;
 for(const faction of FACTIONS)for(const stance of ['stand','crouch','prone'] as const)for(const projection of [front,side,top]){
  const a=actor(faction,{stance}),m=compareSilhouette(a,projection);
  const label=`${faction} ${stance} ${projection.label}`;
  assert.ok(m.body>100,'actual triangle projection has a body silhouette');
  if(m.coverage<.80)failures.push(`${label}: ${(100*m.coverage).toFixed(1)}% raw body coverage <80%`);
  if(m.interiorCoverage<.90)failures.push(`${label}: ${(100*m.interiorCoverage).toFixed(1)}% interior body coverage <90%`);
  if(m.newFalse>=m.oldFalse*.5)failures.push(`${label}: empty-space hits ${m.newFalse} did not halve old ${m.oldFalse}`);
  if(m.farFalse/m.newHits>.025)failures.push(`${label}: more than 2.5% of accepted rays are over 25 mm outside rendered flesh/uniform`);
  oldFalse+=m.oldFalse;newFalse+=m.newFalse;lowestCoverage=Math.min(lowestCoverage,m.coverage);lowestInterior=Math.min(lowestInterior,m.interiorCoverage);highestEmpty=Math.max(highestEmpty,m.farFalse/m.newHits);
 }
 t.diagnostic(`27 source silhouettes: empty-space hits ${oldFalse}→${newFalse}; minimum coverage ${(lowestCoverage*100).toFixed(1)}% raw /${(lowestInterior*100).toFixed(1)}% interior; worst distant-empty rate ${(highestEmpty*100).toFixed(2)}%`);
 assert.equal(failures.length,0,failures.join('\n'));
});

test('shots through the rendered gap between separated lower legs miss',()=>{
 for(const faction of FACTIONS){
  const a=actor(faction),model=pose(a),mask=silhouette(model,faction,front),volumes=sampleHitVolumes(a,10);
  let clearRays=0;
  for(let y=.18;y<.62;y+=.025){
   const origin={x:0,y,z:-3},ix=Math.floor((origin.x-MIN)/PIXEL),iy=Math.floor((y-MIN)/PIXEL);
   if(mask[iy*SIZE+ix])continue;
   assert.equal(rayHitVolumes(origin,{x:0,y:0,z:1},volumes),null,`${faction} gap y=${y.toFixed(3)}`);
   assert.equal(oldHit(a,origin,{x:0,y:0,z:1}),true,'old damage bands filled this visible gap');clearRays++;
  }
  assert.ok(clearRays>=6,`${faction} retains a measurable open leg gap`);
 }
});
