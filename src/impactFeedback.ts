import * as THREE from 'three';
import type {Shot} from './engine';
import {makeParticleCloud,resetParticleCloud,updateParticleCloud,seededFeedback,type FeedbackParticle} from './particleFeedback';

export const IMPACT_SECONDS=1.08;
export const MAX_WORLD_EFFECTS=48;
export const BLOOD_PARTICLES=104;
export function shotFeedbackSeed(shot:Shot){return(Math.round(shot.time*10000)^Math.imul(shot.actor+1,2654435761)^Math.round(shot.end.x*971)^Math.round(shot.end.z*577))>>>0;}

/** Layered directional spray. Melee fans sideways; gunshots make a faster cone. */
export function makeImpactEffect(shot:Shot){return resetImpactEffect(new THREE.Group(),shot);}
export function resetImpactEffect(group:THREE.Group,shot:Shot){
 const blood=shot.hit!==null,r=seededFeedback(shotFeedbackSeed(shot));group.name=blood?'blood-impact':'surface-impact';group.position.set(shot.end.x,shot.end.y,shot.end.z);group.quaternion.identity();group.scale.setScalar(1);
 const normal=new THREE.Vector3(shot.origin.x-shot.end.x,shot.origin.y-shot.end.y,shot.origin.z-shot.end.z).normalize();if(normal.lengthSq()<.5)normal.set(0,0,1);
 const right=new THREE.Vector3().crossVectors(normal,Math.abs(normal.y)>.9?new THREE.Vector3(1,0,0):new THREE.Vector3(0,1,0)).normalize(),up=new THREE.Vector3().crossVectors(right,normal).normalize();
 const particles:FeedbackParticle[]=[],count=blood?BLOOD_PARTICLES:22,melee=shot.kind==='melee';
 for(let i=0;i<count;i++){
  const mist=i<(blood?14:6),wisp=blood&&i>=14&&i<20,streak=blood&&i>=20&&i<42,angle=r()*Math.PI*2;
  const spread=blood?(melee?1.65:mist?.8:.6):mist?.7:.45,radial=Math.sqrt(r())*spread,speed=mist?.35+r()*.65:wisp?.8+r()*.8:(melee?.7:1.2)+r()*(melee?1.2:2.4);
  const velocity=normal.clone().multiplyScalar(speed).addScaledVector(right,Math.cos(angle)*radial*speed*(melee?1.2:1)).addScaledVector(up,Math.sin(angle)*radial*speed*(melee?.6:1));velocity.y+=blood?.2:.35;
  // All blood variants keep one fixed instance count so melee and rifle bursts share GPU buffers.
  particles.push({position:[normal.x*.025,normal.y*.025,normal.z*.025],velocity:velocity.toArray() as [number,number,number],delay:wisp?0:r()*.045,
   life:mist?.40+r()*.28:wisp?.16+r()*.12:.5+r()*.5,
   size:mist?(blood?.12:.13)+r()*(blood?.12:.17):wisp?.025+r()*.025:blood?(streak?.004+r()*.004:.007+r()*(melee?.012:.009)):.018+r()*.025,
   stretch:mist?1:wisp?2+r()*1.2:streak?3+r()*2:1.05+r()*.6,growth:mist?2.1:wisp?.7:streak?-.4:0,
   gravity:mist?.3:wisp?2.2:5.2,drag:mist?2.5:wisp?1.8:.65,
   color:blood?(mist?0x86271e:i%3===0?0xb63729:i%3===1?0x7b1a14:0x58100c):(mist?0xa99d82:0x807763),
   opacity:mist?(blood?.20:.32):wisp?.52:blood?.86:.85,kind:mist?'mist':wisp?'wisp':'drop',seed:r()});
 }
 if(group.children.length)resetParticleCloud(group.children[0] as THREE.InstancedMesh,particles);else group.add(makeParticleCloud(particles));return group;
}

export function updateImpactEffect(effect:THREE.Group,elapsed:number){
 effect.visible=Number.isFinite(elapsed)&&elapsed>=0&&elapsed<IMPACT_SECONDS;
 if(effect.visible)updateParticleCloud(effect.children[0] as THREE.InstancedMesh,elapsed);
 return effect.visible;
}
