import {sampleFirstPersonWeaponAnimation} from '../src/firstPersonWeaponAnimation.ts';
import test,{before} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {FACTIONS,HEIGHTS,WEAPONS,WEAPON_SWITCH_SECONDS,type Faction} from '../src/config.ts';
import {loadHandAssetFromBuffer} from '../src/hands.ts';
import {loadImportedWeaponFromBuffer,loadImportedGrenadeFromBuffer,getImportedWeaponProfile} from '../src/importedWeapons.ts';
import {makeRifle,getRifleVisuals} from '../src/rifle.ts';
import {makeStielhandgranate} from '../src/grenadeModel.ts';
import {applyWeaponAnimation,applyGrenadePose,sampleGrenadeReadyPose,sampleGrenadeMelee,sampleWeaponSwitch,MELEE_ANIMATION_SECONDS,type WeaponPose,type GrenadePose} from '../src/weaponAnimation.ts';
import {sampleFirstPersonMotion} from '../src/firstPersonMotion.ts';
import {keepADSBoltInFront} from '../src/weaponPresentation.ts';
import {VIEWMODEL_HIP_POSITION,VIEWMODEL_GRENADE_POSITION,VIEWMODEL_SHOULDERS,VIEWMODEL_UPPER_ARM,VIEWMODEL_FOREARM,type ViewmodelArm} from '../src/viewmodelArms.ts';

const bytes=(path:string)=>{const file=readFileSync(new URL(`../public/assets/${path}`,import.meta.url));return file.buffer.slice(file.byteOffset,file.byteOffset+file.byteLength) as ArrayBuffer;};
before(async()=>{
 const loader=new GLTFLoader();loader.register(()=>({name:'arm-test-image-decoder',loadTexture:()=>Promise.resolve(new THREE.Texture())}));
 for(const side of ['left','right'] as const)await loadHandAssetFromBuffer(side,bytes(`arms/hand-${side==='left'?'l':'r'}.glb`),loader);
 for(const [faction,name] of Object.entries({british:'enfield',russian:'mosin',german:'kar98k'})){
  const profile=JSON.parse(readFileSync(new URL(`../public/assets/imported-weapons/${name}-profile.json`,import.meta.url),'utf8'));
  assert.equal(profile.faction,faction);await loadImportedWeaponFromBuffer(bytes(`imported-weapons/${name}.glb`),profile,loader);
 }
 await loadImportedGrenadeFromBuffer(bytes('models/imported-stielhandgranate.glb'),loader);
});

function rig(faction:Faction){
 const body=new THREE.Group(),rifle=makeRifle(faction,true),grenade=makeStielhandgranate(faction,true);
 body.add(rifle,grenade);return{body,rifle,grenade,camera:new THREE.PerspectiveCamera(64,16/9,.01,8)};
}
type Scene=ReturnType<typeof rig>;
function place(scene:Scene,faction:Faction,slot:'rifle'|'grenade',pose:WeaponPose|GrenadePose,ads:number,recoil=0,phase=0,swap=sampleWeaponSwitch(1)){
 const visual=getRifleVisuals(faction),hip=slot==='rifle'?VIEWMODEL_HIP_POSITION:VIEWMODEL_GRENADE_POSITION,align=slot==='rifle'?ads*(1-((pose as WeaponPose).unshoulder??0)):0;
 const motion=sampleFirstPersonMotion({moving:4.8,stance:'crouch',eyeHeight:THREE.MathUtils.lerp(HEIGHTS.stand,HEIGHTS.crouch,(1-Math.cos(phase*Math.PI*2))/2),ads,grounded:true,vy:0,jumpStarted:-Infinity,landedAt:-Infinity,landingSpeed:0},phase*3);
 const position=hip.map((value,i)=>THREE.MathUtils.lerp(value,[-visual.sightX,-visual.sightY,visual.adsZ][i],align)+motion.position[i]+pose.position[i]+swap.position[i]);
 position[2]+=Math.min(.11,recoil*1.8);
 scene.body.position.fromArray(position);
 scene.body.rotation.set(recoil*1.1+motion.rotation[0]+pose.rotation[0]+swap.rotation[0]+visual.adsRotation[0]*align,THREE.MathUtils.lerp(slot==='rifle'?-.035:0,0,align)+pose.rotation[1]+swap.rotation[1]+visual.adsRotation[1]*align,motion.rotation[2]+pose.rotation[2]+swap.rotation[2]+visual.adsRotation[2]*align);
 scene.body.updateMatrix();
 if(slot==='rifle'){
  applyWeaponAnimation(scene.rifle,pose as WeaponPose,scene.body.matrix);
  if(keepADSBoltInFront(scene.body,scene.rifle,scene.camera,align)>0){scene.body.updateMatrix();applyWeaponAnimation(scene.rifle,pose as WeaponPose,scene.body.matrix);}
 }else applyGrenadePose(scene.grenade,pose as GrenadePose,scene.body.matrix);
 scene.body.updateMatrixWorld(true);
}

function check(item:THREE.Group,context:string,previous?:Map<string,THREE.Vector3>){
 const rig=item.userData.handRig??item.userData.grenadeRig;
 for(const side of ['left','right'] as const){
  const hand=rig[side] as THREE.Group;if(!hand.visible)continue;
  const arm=rig[`${side}Arm`] as ViewmodelArm;assert.ok(arm,`${context}: visible hand uses a complete arm`);
  const shoulder=arm.upper.getWorldPosition(new THREE.Vector3()),elbow=arm.lower.getWorldPosition(new THREE.Vector3()),wrist=arm.cuff.getWorldPosition(new THREE.Vector3());
  assert.ok(shoulder.distanceTo(VIEWMODEL_SHOULDERS[side])<1e-6,`${context}/${side}: shoulder is body-fixed`);
  assert.ok(Math.abs(shoulder.distanceTo(elbow)-VIEWMODEL_UPPER_ARM)<1e-6,`${context}/${side}: upper arm cannot stretch`);
  assert.ok(Math.abs(elbow.distanceTo(wrist)-VIEWMODEL_FOREARM)<1e-6,`${context}/${side}: forearm cannot stretch`);
  const actualHandWrist=hand.localToWorld((hand.userData.wristLocal as THREE.Vector3).clone());
  assert.ok(wrist.distanceTo(actualHandWrist)<.00001,`${context}/${side}: cuff is attached to the actual hand (${wrist.distanceTo(actualHandWrist)} m)`);
  assert.ok(arm.reachError<=1e-6,`${context}/${side}: target must be reachable without hiding a gap`);
  const source=hand.userData.anatomical.model as THREE.Group;
  const bend=new THREE.Vector3(0,0,1).transformDirection(source.matrixWorld).angleTo(elbow.clone().sub(wrist));
  assert.ok(bend<Math.PI/4,`${context}/${side}: actual wrist is not folded back (${THREE.MathUtils.radToDeg(bend)}°)`);
  // Measure the rendered cloth's cuff ring, not just transform markers.
  arm.mesh.skeleton.update();const positions=arm.mesh.geometry.getAttribute('position'),cuffCenter=new THREE.Vector3();
  const first=positions.count-25;
  for(let i=0;i<24;i++)cuffCenter.add(arm.mesh.localToWorld(arm.mesh.applyBoneTransform(first+i,new THREE.Vector3().fromBufferAttribute(positions,first+i))));
  cuffCenter.divideScalar(24);assert.ok(cuffCenter.distanceTo(wrist)<1e-5,`${context}/${side}: continuous sleeve reaches its cuff`);
  if(previous){const prior=previous.get(side);if(prior)assert.ok(elbow.distanceTo(prior)<.035,`${context}/${side}: elbow pole cannot flip between nearby frames (${elbow.distanceTo(prior).toFixed(4)} m; ${prior.toArray()} to ${elbow.toArray()})`);previous.set(side,elbow);}
 }
}

test('actual rifle arms remain joined and body-fixed through actions, ADS transitions, recoil and stance motion',()=>{
 const failures:string[]=[];
 for(const faction of FACTIONS){
  const scene=rig(faction);
  for(const action of ['idle','cycle','reload','melee'] as const)for(const startsAimed of [false,true]){
   const previous=new Map<string,THREE.Vector3>();
   const duration=action==='reload'?WEAPONS[faction].reload:action==='melee'?MELEE_ANIMATION_SECONDS:WEAPONS[faction].cycle;
   // Fine sampling distinguishes a fast continuous charger reach from an
   // elbow branch jump; coarse normalized-time steps can conflate the two.
   for(let i=0;i<=600;i++){
    const progress=i/600;
    const ads=startsAimed?(action==='reload'?Math.exp(-14*progress*duration):1):0;
    const pose=sampleFirstPersonWeaponAnimation(faction,action,progress,faction==='british',undefined,ads);
    const recoil=action==='cycle'?WEAPONS[faction].recoil*Math.exp(-progress*duration*4.2)+.156*Math.sin(Math.PI*progress)**2:0;
    place(scene,faction,'rifle',pose,ads,recoil,progress);
    try{check(scene.rifle,`${faction}/${action}/${startsAimed}/${progress}`,previous);}catch(error){failures.push((error as Error).message);previous.clear();}
   }
  }
 }
 assert.equal(failures.length,0,failures.slice(0,20).join('\n'));
});

test('visible rifle/grenade handoffs and high grenade bashes preserve complete arm attachment',()=>{
 for(const faction of FACTIONS){
  const scene=rig(faction);
  for(const from of ['rifle','grenade'] as const)for(let i=0;i<=160;i++){
   const progress=i/160,swap=sampleWeaponSwitch(progress);if(swap.hidden)continue;
   const slot=swap.item==='from'?from:from==='rifle'?'grenade':'rifle';
   const pose=slot==='rifle'?sampleFirstPersonWeaponAnimation(faction,'idle',0):sampleGrenadeReadyPose();
   place(scene,faction,slot,pose,from==='rifle'?Math.exp(-14*progress*WEAPON_SWITCH_SECONDS):0,0,progress,swap);
   check(scene[slot],`${faction}/${from} switch/${progress}`);
  }
  const previous=new Map<string,THREE.Vector3>();
  for(let i=0;i<=160;i++){const progress=i/160;place(scene,faction,'grenade',sampleGrenadeMelee(progress),0,0,progress);check(scene.grenade,`${faction}/grenade bash/${progress}`,previous);}
 }
});

test('a replay seek rebuilds the same physical sleeve and hand pose',()=>{
 const scene=rig('british'),target=sampleFirstPersonWeaponAnimation('british','reload',.48,true);
 const snapshot=()=>{
  const rig=scene.rifle.userData.handRig;
  return [rig.left,rig.right,rig.leftArm.upper,rig.leftArm.lower,rig.leftArm.cuff,rig.rightArm.upper,rig.rightArm.lower,rig.rightArm.cuff].map((object:THREE.Object3D)=>object.matrixWorld.toArray());
 };
 place(scene,'british','rifle',target,0,0,.48);const expected=snapshot();
 place(scene,'british','rifle',sampleFirstPersonWeaponAnimation('british','melee',.35),1,0,.35);
 place(scene,'british','rifle',target,0,0,.48);assert.deepEqual(snapshot(),expected);
});

/** Conservative projected silhouette: clip the real skinned triangles before
 * building their hull, so behind-camera shoulder vertices cannot inflate it. */
function sleeveProjection(mesh:THREE.SkinnedMesh,camera:THREE.PerspectiveCamera){
 mesh.skeleton.update();const positions=mesh.geometry.getAttribute('position'),index=mesh.geometry.index!;
 const projected:THREE.Vector4[]=[];
 for(let i=0;i<positions.count;i++){
  const world=mesh.localToWorld(mesh.applyBoneTransform(i,new THREE.Vector3().fromBufferAttribute(positions,i)));
  projected.push(new THREE.Vector4(world.x,world.y,world.z,1).applyMatrix4(camera.matrixWorldInverse).applyMatrix4(camera.projectionMatrix));
 }
 const planes=[(v:THREE.Vector4)=>v.w+v.x,(v:THREE.Vector4)=>v.w-v.x,(v:THREE.Vector4)=>v.w+v.y,(v:THREE.Vector4)=>v.w-v.y,(v:THREE.Vector4)=>v.w+v.z,(v:THREE.Vector4)=>v.w-v.z];
 const points:{x:number;y:number}[]=[],bottom:number[]=[];
 for(let i=0;i<index.count;i+=3){
  let poly=[projected[index.getX(i)],projected[index.getX(i+1)],projected[index.getX(i+2)]];
  for(const plane of planes){
   const clipped:THREE.Vector4[]=[];
   for(let j=0;j<poly.length;j++){
    const a=poly[j],b=poly[(j+1)%poly.length],da=plane(a),db=plane(b);
    if(da>=0)clipped.push(a);if((da<0)!==(db<0))clipped.push(a.clone().lerp(b,da/(da-db)));
   }
   poly=clipped;if(!poly.length)break;
  }
  for(const p of poly){const x=p.x/p.w,y=p.y/p.w;points.push({x,y});if(Math.abs(y+1)<1e-6)bottom.push(x);}
 }
 points.sort((a,b)=>a.x-b.x||a.y-b.y);
 const cross=(a:{x:number;y:number},b:{x:number;y:number},c:{x:number;y:number})=>(b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x);
 const half=(list:typeof points)=>{const hull:typeof points=[];for(const p of list){while(hull.length>=2&&cross(hull.at(-2)!,hull.at(-1)!,p)<=0)hull.pop();hull.push(p);}return hull;};
 const lower=half(points),upper=half([...points].reverse()),hull=[...lower.slice(0,-1),...upper.slice(0,-1)];
 let area=0;for(let i=0;i<hull.length;i++){const a=hull[i],b=hull[(i+1)%hull.length];area+=a.x*b.y-a.y*b.x;}
 return {area:Math.abs(area)/8,bottom:bottom.length?(Math.min(...bottom)+Math.max(...bottom))/2:null,maxY:Math.max(...points.map(p=>p.y)),minX:Math.min(...points.map(p=>p.x)),maxX:Math.max(...points.map(p=>p.x))};
}


test('the actual support sleeve stays compact beside the rifle across viewport shapes',()=>{
 for(const faction of FACTIONS)for(const [action,progress,ads] of [
  ['idle',0,0],['idle',0,1],['cycle',.4,0],['reload',.48,0],
 ] as const){
  const scene=rig(faction),pose=sampleFirstPersonWeaponAnimation(faction,action,progress,faction==='british',undefined,ads);
  place(scene,faction,'rifle',pose,ads);
  const arm=scene.rifle.userData.handRig.leftArm as ViewmodelArm;
  assert.equal(arm.mesh.visible,true,'composition is achieved with a complete visible sleeve');
  for(const aspect of [4/3,16/9,21/9]){
   scene.camera.aspect=aspect;scene.camera.fov=ads?48:64;scene.camera.updateProjectionMatrix();
   const context=`${faction}/${action}/${ads}/${aspect}`,shape=sleeveProjection(arm.mesh,scene.camera);
   // The convex hull conservatively includes all rendered cloth, including
   // the elbow blend, rather than measuring only the arm's joint positions.
   assert.ok(shape.area<(ads?.055:action==='idle'?.012:.035),`${context}: support sleeve fills only a small viewport area (${shape.area})`);
   assert.ok(shape.maxY<-.4,`${context}: the support sleeve stays in the lower viewport`);
   const wrist=arm.cuff.getWorldPosition(new THREE.Vector3()).project(scene.camera);
   if(shape.area===0){
    assert.ok(wrist.y<-1,`${context}: an offscreen sleeve exits below the viewport`);
    continue;
   }
   assert.notEqual(shape.bottom,null,`${context}: the sleeve enters from the bottom, not the side`);
   const profile=getImportedWeaponProfile(faction)!;
   const front=scene.rifle.localToWorld(new THREE.Vector3(...profile.frontSight)).project(scene.camera);
   const rear=scene.rifle.localToWorld(new THREE.Vector3(...profile.rightStock)).project(scene.camera);
   const gunBottom=front.x+(-1-front.y)*(rear.x-front.x)/(rear.y-front.y);
   if(action==='idle'){
    // Multiplying horizontal NDC by aspect compares physical screen-space
    // distances and slopes equally at 4:3, 16:9 and 21:9.
    assert.ok(Math.abs(gunBottom-shape.bottom!)*aspect<.3,`${context}: the sleeve enters immediately beside the rifle`);
    const forearm=new THREE.Vector2((wrist.x-shape.bottom!)*aspect,wrist.y+1).normalize();
    const rifle=new THREE.Vector2((front.x-rear.x)*aspect,front.y-rear.y).normalize();
    const angle=Math.acos(THREE.MathUtils.clamp(forearm.dot(rifle),-1,1));
    assert.ok(angle<(ads?30:45)*Math.PI/180,`${context}: visible forearm follows the rifle instead of cutting across it (${THREE.MathUtils.radToDeg(angle)} degrees)`);
   }
  }
 }
});

/** Use the final 12 mm of the imported furniture itself: a receiver marker
 * or forward root translation cannot stand in for the actual striking end. */
function sourceButtplate(rifle:THREE.Group){
 const furniture=rifle.getObjectByName('furniture');assert.ok(furniture);
 rifle.updateMatrixWorld(true);const inverse=rifle.matrixWorld.clone().invert(),points:THREE.Vector3[]=[];
 furniture.traverse(object=>{if(object instanceof THREE.Mesh){
  const positions=object.geometry.getAttribute('position');
  for(let i=0;i<positions.count;i++)points.push(new THREE.Vector3().fromBufferAttribute(positions,i).applyMatrix4(object.matrixWorld).applyMatrix4(inverse));
 }});
 const rear=Math.max(...points.map(p=>p.z));
 return new THREE.Box3().setFromPoints(points.filter(p=>p.z>rear-.012)).getCenter(new THREE.Vector3());
}

test('all actual rifle buttplates smash inward from the right and lead the muzzle in hip and ADS views',()=>{
 for(const faction of FACTIONS)for(const startsAimed of [false,true]){
  const scene=rig(faction),buttLocal=sourceButtplate(scene.rifle),profile=getImportedWeaponProfile(faction)!;
  const phase=(progress:number)=>{
   const ads=startsAimed?1:0,pose=sampleFirstPersonWeaponAnimation(faction,'melee',progress,false,undefined,ads);
   place(scene,faction,'rifle',pose,ads);
   return{pose,butt:scene.rifle.localToWorld(buttLocal.clone()),muzzle:scene.rifle.localToWorld(new THREE.Vector3(...profile.muzzle))};
  };
  const draw=phase(.22),impact=phase(.40);
  assert.ok(draw.butt.x>.20,'the actual buttplate winds up to the right of the body');
  assert.ok(impact.butt.x<draw.butt.x-.10,'the stock sweeps inward from that right-side draw');
  assert.ok(impact.butt.z<draw.butt.z-.08,'the buttplate also advances toward the target');
  assert.ok(impact.muzzle.z-impact.butt.z>.35,'the buttstock, not the muzzle, is the leading striking surface');
  assert.equal(impact.pose.unshoulder,1,'the shouldered rifle is drawn out of its sight line for the strike');
  const ready=sampleFirstPersonWeaponAnimation(faction,'idle',0);
  for(const hand of ['left','right'] as const){
   assert.deepEqual(impact.pose[hand],ready[hand],'no palm slides away from its measured stock contact');
   assert.deepEqual(impact.pose[`${hand}Rotation`],ready[`${hand}Rotation`],'no wrist is twisted independently to disguise the rifle turn');
  }
  for(const aspect of [4/3,16/9,21/9]){
   scene.camera.aspect=aspect;scene.camera.fov=64;scene.camera.updateProjectionMatrix();
   const butt=impact.butt.clone().project(scene.camera);
   assert.ok(butt.x>0&&butt.x<.65&&butt.y>-.85&&butt.y<-.25,'the real striking buttplate is visible inside the lower-right viewport');
   for(const progress of [.10,.22,.30,.35,.40,.46,.60,.70,.85]){
    const current=phase(progress),align=(startsAimed?1:0)*(1-(current.pose.unshoulder??0));
    scene.camera.fov=THREE.MathUtils.lerp(64,48,align);scene.camera.updateProjectionMatrix();
    const arm=scene.rifle.userData.handRig.leftArm as ViewmodelArm,shape=sleeveProjection(arm.mesh,scene.camera);
    // The active cross-body swing opens the elbow briefly, but the real
    // skinned cloth must still leave the reticle and upper two thirds clear.
    assert.ok(shape.area<.10,`${faction}/${startsAimed}/${progress}/${aspect}: the striking sleeve occupies less than 10% of the viewport (${shape.area})`);
    assert.ok(shape.maxY<-.35,'the opened striking arm stays in the lower third');
   }
   phase(.40);
  }
  phase(1);const recovered=sampleFirstPersonWeaponAnimation(faction,'melee',1);
  assert.deepEqual(recovered.position,ready.position);assert.deepEqual(recovered.rotation,ready.rotation);
 }
});
