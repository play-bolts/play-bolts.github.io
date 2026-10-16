import * as THREE from 'three';
import type {Shot} from './engine';
import {makeImpactEffect,resetImpactEffect,MAX_WORLD_EFFECTS} from './impactFeedback';
import {makeMuzzleFlash,MUZZLE_FLASH_RADII} from './weaponFeedback';

/** Idle bursts retain GPU buffers between shots. Active ownership stays with View. */
export class EffectPool {
 private idle:THREE.Group[]=[];
 constructor(private readonly dispose:(group:THREE.Group)=>void,readonly capacity=MAX_WORLD_EFFECTS){}
 acquireImpact(shot:Shot){const key=shot.hit===null?'surface-impact':'blood-impact';const found=this.take(key);return found?resetImpactEffect(found,shot):makeImpactEffect(shot);}
 acquireMuzzle(){const found=this.take('muzzle-flash');if(found){found.position.set(0,0,0);found.quaternion.identity();found.scale.setScalar(1);}return found??makeMuzzleFlash(MUZZLE_FLASH_RADII.world);}
 private take(name:string){const index=this.idle.findIndex(g=>g.name===name);if(index<0)return null;return this.idle.splice(index,1)[0];}
 release(group:THREE.Group){group.removeFromParent();group.visible=false;if(this.idle.includes(group))return;if(this.idle.length>=this.capacity)this.dispose(this.idle.shift()!);this.idle.push(group);}
 clear(){for(const group of this.idle)this.dispose(group);this.idle=[];}
 get size(){return this.idle.length;}
}
