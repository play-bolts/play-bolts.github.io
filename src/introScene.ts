import * as THREE from 'three';
import {makeRifle} from './rifle';
import {makeSurfaceMaterial} from './materials';

/** A spare rifle-on-cloth backdrop for the main menu. */
export class IntroScene {
 readonly scene=new THREE.Scene();
 readonly camera=new THREE.OrthographicCamera(-1.8,1.8,1.05,-1.05,.01,20);
 constructor(){
  this.scene.background=new THREE.Color(0x34372b);
  this.scene.add(new THREE.HemisphereLight(0xe4debc,0x252718,1.6));
  const light=new THREE.DirectionalLight(0xffe5b2,3.2);light.position.set(-2,5,-2);light.castShadow=true;light.shadow.mapSize.set(1024,1024);light.shadow.camera.left=-3;light.shadow.camera.right=3;light.shadow.camera.top=3;light.shadow.camera.bottom=-3;light.shadow.normalBias=.025;this.scene.add(light);
  const cloth=new THREE.Mesh(new THREE.PlaneGeometry(9,7),makeSurfaceMaterial('canvas',{repeat:[12,10],color:0x72745c,normalStrength:.7}));cloth.rotation.x=-Math.PI/2;cloth.receiveShadow=true;this.scene.add(cloth);
  const rifle=makeRifle('british',false);rifle.rotation.set(0,-.94,Math.PI/2);rifle.scale.setScalar(1.75);rifle.position.set(-.75,.18,-.56);this.scene.add(rifle);
  this.camera.position.set(0,5,.2);this.camera.up.set(0,0,-1);this.camera.lookAt(0,0,0);
 }
 resize(aspect:number){const halfH=1.06;this.camera.left=-halfH*aspect;this.camera.right=halfH*aspect;this.camera.top=halfH;this.camera.bottom=-halfH;this.camera.updateProjectionMatrix();}
}
