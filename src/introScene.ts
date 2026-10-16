import * as THREE from 'three';
import type {Faction} from './config';
import {makeRifle} from './rifle';
import {makeSurfaceMaterial} from './materials';

/** The three playable rifles laid on a dark walnut table, clear of the menu. */
export class IntroScene {
 readonly scene=new THREE.Scene();
 readonly camera=new THREE.OrthographicCamera(-1.8,1.8,1.18,-1.18,.01,20);
 private readonly shadowLights:THREE.DirectionalLight[]=[];
 private readonly rifles:{group:THREE.Group;width:number;depth:number;floor:number}[]=[];
 constructor(){
  this.scene.background=new THREE.Color(0x17100b);
  this.scene.add(new THREE.HemisphereLight(0xe7ddce,0x22160e,.85));
  const light=new THREE.DirectionalLight(0xffe6c4,3.3);
  light.position.set(-3,5,-1);light.castShadow=true;light.shadow.autoUpdate=false;light.shadow.needsUpdate=true;this.shadowLights.push(light);light.shadow.mapSize.set(2048,2048);
  Object.assign(light.shadow.camera,{left:-4,right:4,top:3,bottom:-3,near:.1,far:12});
  light.shadow.normalBias=.002;light.shadow.bias=-.00008;light.shadow.radius=3;
  const fill=new THREE.DirectionalLight(0xbac7d6,.55);fill.position.set(3,2,4);
  this.scene.add(light,fill);
  // Photographic CC0 grain, normal and roughness maps remain local. Separate
  // boards have shallow seams and offset grain instead of a flat colored card.
  for(let i=-9;i<=9;i++){
   const tint=new THREE.Color(0x423023).multiplyScalar(1+Math.sin(i*2.3)*.07);
   const material=makeSurfaceMaterial('walnut',{repeat:[2.7,.17],offset:[(i*.271)%1,(i*.193)%1],color:tint,normalStrength:.38,roughnessRange:[.48,.77],saturation:.77});
   const board=new THREE.Mesh(new THREE.BoxGeometry(11,.10,.365),material);
   board.position.set(0,-.052,i*.37);board.receiveShadow=true;
   this.scene.add(board);
  }
  const factions:Faction[]=['british','russian','german'];
  for(const [i,faction] of factions.entries()){
   const group=new THREE.Group(),rifle=makeRifle(faction,false);
   rifle.rotation.set(0,-1.43+(i===1?.035:-.02),Math.PI/2);
   rifle.updateMatrixWorld(true);
   const box=new THREE.Box3().setFromObject(rifle),center=box.getCenter(new THREE.Vector3());
   rifle.position.set(-center.x,0,-center.z);group.add(rifle);
   group.name=`menu-${faction}-rifle`;this.scene.add(group);
   this.rifles.push({group,width:box.max.x-box.min.x,depth:box.max.z-box.min.z,floor:box.min.y});
  }
  this.camera.position.set(0,6,.25);this.camera.up.set(0,0,-1);this.camera.lookAt(0,0,0);
  this.resize(16/9);
 }
 invalidateShadows(){for(const light of this.shadowLights)light.shadow.needsUpdate=true;}
 resize(aspect:number){
  this.invalidateShadows();
  const halfH=1.18,halfW=halfH*Math.max(.4,aspect),width=halfW*2;
  this.camera.left=-halfW;this.camera.right=halfW;this.camera.top=halfH;this.camera.bottom=-halfH;this.camera.updateProjectionMatrix();
  // Keep all three complete silhouettes in the left side at any desktop size.
  const available=Math.min(2.75,width*(aspect<1.2?.36:.51));
  for(const [i,rifle] of this.rifles.entries()){
   const scale=Math.min(available/rifle.width,.56/rifle.depth);
   rifle.group.scale.setScalar(scale);
   rifle.group.position.set(-width*(aspect<1.2?.30:.22)+(i===1?.04:-.02),.01-rifle.floor*scale,(i-1)*.66);
  }
 }
}
