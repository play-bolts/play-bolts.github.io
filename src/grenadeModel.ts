import * as THREE from 'three';
import type {Faction} from './config';
import {makeAnatomicalHand,configureHandWristFrame} from './hands';
import {makeSurfaceMaterial} from './materials';
import {makeImportedGrenade} from './importedWeapons';
import {applyGrenadePose,sampleGrenadeReadyPose} from './weaponAnimation';
import {makeViewmodelArm} from './viewmodelArms';

/** Visual M24-style stick grenade. Model coordinates are centred on the
 * handle grip, with the canister above it on +Y; no gameplay logic lives here. */
export function makeStielhandgranate(faction:Faction,arms=true,options:{source?:'auto'|'procedural'}={}):THREE.Group {
  const root=new THREE.Group();root.name=arms?'stielhandgranate-viewmodel':'stielhandgranate-projectile';
  const grenade=new THREE.Group();grenade.name='grenade-pivot';root.add(grenade);
  const imported=options.source==='procedural'?null:makeImportedGrenade();
  if(imported){grenade.add(imported);root.userData.importedWeapon=true;}
  else {
  const wood=makeSurfaceMaterial('walnut',{repeat:[.55,1.5],color:0xb48b54,roughness:.91,normalStrength:.18});
  const steel=makeSurfaceMaterial('steel',{repeat:[.65,.65],color:0x87916c,roughness:1,roughnessRange:[.65,.9],metalness:.2,normalStrength:.25});
  const edge=new THREE.MeshStandardMaterial({color:0x595a43,roughness:.7,metalness:.55});
  const dark=new THREE.MeshStandardMaterial({color:0x252b22,roughness:.9});
  const add=(geometry:THREE.BufferGeometry,material:THREE.Material,y:number)=>{const mesh=new THREE.Mesh(geometry,material);mesh.position.y=y;mesh.castShadow=mesh.receiveShadow=true;grenade.add(mesh);return mesh;};
  const handle=new THREE.LatheGeometry([[-.115,.022],[-.110,.023],[-.080,.021],[-.025,.017],[.055,.017],[.114,.021],[.143,.022]].map(([y,r])=>new THREE.Vector2(r,y)),40);
  add(handle,wood,0).name='wooden-handle';
  add(new THREE.CylinderGeometry(.042,.043,.103,48,4),steel,.194).name='canister';
  add(new THREE.CylinderGeometry(.044,.044,.008,48),edge,.143);
  add(new THREE.CylinderGeometry(.043,.043,.006,48),edge,.248);
  add(new THREE.CylinderGeometry(.040,.040,.003,48),steel,.252);
  add(new THREE.CylinderGeometry(.024,.024,.026,36),edge,-.113).name='pull-cap';
  for(const y of [-.125,-.121,-.116])add(new THREE.TorusGeometry(.0235,.0013,6,40),dark,y).rotation.x=Math.PI/2;
  // A small closure screw and restrained stamped plate break up the casing.
  const screw=add(new THREE.CylinderGeometry(.004,.004,.003,16),edge,.196);screw.rotation.x=Math.PI/2;screw.position.z=.043;
  const plate=add(new THREE.BoxGeometry(.021,.031,.0018),dark,.216);plate.position.z=.043;
  }
  if(!arms)return root;

  const skin=new THREE.MeshStandardMaterial({color:0xb49b80,roughness:.8});
  const sleeve=makeSurfaceMaterial('canvas',{repeat:[2,3],color:faction==='british'?0x75674b:faction==='russian'?0x727552:0x586153,normalStrength:.13});
  const hand=(side:'left'|'right')=>{
    const anatomical=makeAnatomicalHand(side);if(anatomical)return anatomical;
    const fallback=new THREE.Group();fallback.name=`${side}-hand`;
    const palm=new THREE.Mesh(new THREE.SphereGeometry(1,18,12),skin);palm.scale.set(.035,.046,.025);fallback.add(palm);return fallback;
  };
  const right=hand('right'),left=hand('left');root.add(right,left);
  // Align the finger hinge axes with the handle, then place the palm behind
  // its rear surface. The digits curl around the vertical wood cylinder.
  const grip=new THREE.Group();grip.name='vertical-handle-grip';grip.rotation.set(Math.PI/2,0,-Math.PI/2);grip.position.z=-.022;
  for(const child of [...right.children])grip.add(child);right.add(grip);
  const wrist=right.userData.wristLocal as THREE.Vector3|undefined;
  if(wrist)wrist.applyEuler(grip.rotation).add(grip.position);
  configureHandWristFrame(right);configureHandWristFrame(left);
  const rightArm=makeViewmodelArm(sleeve,'right'),leftArm=makeViewmodelArm(sleeve,'left');root.add(rightArm.mesh,leftArm.mesh);
  const rightForearm=new THREE.Object3D(),leftForearm=new THREE.Object3D();root.add(rightForearm,leftForearm);rightForearm.name='right-forearm';leftForearm.name='left-forearm';
  // The overhead bash brings the elbow into view. Continue the cloth back
  // into the body and cover the bend instead of exposing a capped forearm.
  const rightUpperArm=new THREE.Object3D();rightUpperArm.name='right-upper-arm';
  const rightElbow=new THREE.Object3D();rightElbow.name='right-elbow';root.add(rightUpperArm,rightElbow);
  right.position.set(.050,-.074,-.185);left.position.set(-.11,-.09,-.30);left.visible=false;leftForearm.visible=false;
  grenade.position.set(.03,-.05,-.20);
  root.userData.grenadeRig={right,left,rightForearm,leftForearm,rightUpperArm,rightElbow,rightArm,leftArm,grenade};
  applyGrenadePose(root,sampleGrenadeReadyPose());
  return root;
}
