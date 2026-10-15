import * as THREE from 'three';
import type {Shot} from './engine';
import {makeParticleCloud,updateParticleCloud,seededFeedback,type FeedbackParticle} from './particleFeedback';

export const IMPACT_SECONDS=.82;
export const MAX_WORLD_EFFECTS=48;
export function shotFeedbackSeed(shot:Shot){return(Math.round(shot.time*10000)^Math.imul(shot.actor+1,2654435761)^Math.round(shot.end.x*971)^Math.round(shot.end.z*577))>>>0;}

/** Modest, directional hit spray: no body fragments, wounds or persistent pools. */
export function makeImpactEffect(shot:Shot){
 const blood=shot.hit!==null,r=seededFeedback(shotFeedbackSeed(shot)),group=new THREE.Group();group.name=blood?'blood-impact':'surface-impact';group.position.set(shot.end.x,shot.end.y,shot.end.z);
 const normal=new THREE.Vector3(shot.origin.x-shot.end.x,shot.origin.y-shot.end.y,shot.origin.z-shot.end.z).normalize();if(normal.lengthSq()<.5)normal.set(0,0,1);
 const right=new THREE.Vector3().crossVectors(normal,Math.abs(normal.y)>.9?new THREE.Vector3(1,0,0):new THREE.Vector3(0,1,0)).normalize(),up=new THREE.Vector3().crossVectors(right,normal).normalize();
 const particles:FeedbackParticle[]=[],count=blood?60:22;
 for(let i=0;i<count;i++){
  const mist=i<(blood?7:6),streak=blood&&i>=7&&i<16,angle=r()*Math.PI*2,spread=mist?.7:.45,radial=r()*spread,speed=mist?.35+r()*.5:.8+r()*1.8;
  const velocity=normal.clone().multiplyScalar(speed).addScaledVector(right,Math.cos(angle)*radial*speed).addScaledVector(up,Math.sin(angle)*radial*speed);velocity.y+=blood?.12:.35;
  particles.push({position:[normal.x*.025,normal.y*.025,normal.z*.025],velocity:velocity.toArray() as [number,number,number],delay:r()*.025,life:mist?.30+r()*.20:.38+r()*.4,size:mist?(blood?.10:.13)+r()*(blood?.08:.17):blood?(streak?.003+r()*.004:.005+r()*.009):.018+r()*.025,stretch:mist?1:streak?3+r()*2:1.05+r()*.45,growth:mist?1.8:streak?-.4:0,gravity:mist?.3:5.2,drag:mist?2.5:.65,color:blood?(mist?0x7b2118:i%3===0?0x9b3022:0x59130f):(mist?0xa99d82:0x807763),opacity:mist?(blood?.13:.32):blood?.72:.85,kind:mist?'mist':'drop',seed:r()});
 }
 group.add(makeParticleCloud(particles));return group;
}

export function updateImpactEffect(effect:THREE.Group,elapsed:number){
 effect.visible=Number.isFinite(elapsed)&&elapsed>=0&&elapsed<IMPACT_SECONDS;
 if(effect.visible)updateParticleCloud(effect.children[0] as THREE.InstancedMesh,elapsed);
 return effect.visible;
}
