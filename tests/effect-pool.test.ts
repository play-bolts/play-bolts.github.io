import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {EffectPool} from '../src/effectPool';
import {makeImpactEffect,updateImpactEffect} from '../src/impactFeedback';
import {sampleFeedbackParticle,type FeedbackParticle} from '../src/particleFeedback';
import type {Shot} from '../src/engine';
const shot:Shot={time:1,actor:1,origin:{x:1,y:2,z:3},end:{x:0,y:1,z:0},hit:0,headshot:false,kind:'shot'};
test('pooled effects reuse GPU buffers and exactly reproduce fresh bursts for a different shot',()=>{
 const pool=new EffectPool(()=>{}),first=pool.acquireImpact(shot),mesh=first.children[0] as THREE.InstancedMesh;
 const geometry=mesh.geometry,material=mesh.material;pool.release(first);
 const next={...shot,time:7,origin:{x:-3,y:.5,z:2}},reused=pool.acquireImpact(next),fresh=makeImpactEffect(next);
 assert.equal(reused,first);assert.equal((reused.children[0] as THREE.Mesh).geometry,geometry);assert.equal((reused.children[0] as THREE.Mesh).material,material);
 for(const age of [0,.05,.3,.7]){updateImpactEffect(reused,age);updateImpactEffect(fresh,age);const a=reused.children[0] as THREE.InstancedMesh,b=fresh.children[0] as THREE.InstancedMesh;assert.deepEqual(a.instanceMatrix.array,b.instanceMatrix.array);for(const key of ['particleColor','particleDirection','particleStyle','particleAlpha','particleProgress'])assert.deepEqual(a.geometry.getAttribute(key).array,b.geometry.getAttribute(key).array);}
 const particles=mesh.userData.particles as FeedbackParticle[];updateImpactEffect(reused,.2);for(let i=0;i<particles.length;i++){const reference=sampleFeedbackParticle(particles[i],.2),matrix=new THREE.Matrix4();mesh.getMatrixAt(i,matrix);const p=new THREE.Vector3().setFromMatrixPosition(matrix);reference.position.forEach((v,j)=>assert.ok(Math.abs(v-p.getComponent(j))<1e-6));}
});
test('reusing a rifle burst for melee refreshes its shape, age and falling direction',()=>{
 const pool=new EffectPool(()=>{}),rifle=pool.acquireImpact(shot),mesh=rifle.children[0] as THREE.InstancedMesh,geometry=mesh.geometry;
 updateImpactEffect(rifle,.4);pool.release(rifle);
 const meleeShot={...shot,kind:'melee' as const},melee=pool.acquireImpact(meleeShot),fresh=makeImpactEffect(meleeShot);
 assert.equal(melee,rifle);assert.equal((melee.children[0] as THREE.Mesh).geometry,geometry);
 for(const age of [.25,.01,.8,.25]){updateImpactEffect(melee,age);updateImpactEffect(fresh,age);const b=fresh.children[0] as THREE.InstancedMesh;assert.deepEqual(mesh.instanceMatrix.array,b.instanceMatrix.array);for(const key of ['particleDirection','particleAlpha','particleProgress','particleStyle'])assert.deepEqual(mesh.geometry.getAttribute(key).array,b.geometry.getAttribute(key).array);}
 const p=(mesh.userData.particles as FeedbackParticle[]).find(p=>p.kind==='drop')!,index=(mesh.userData.particles as FeedbackParticle[]).indexOf(p),direction=mesh.geometry.getAttribute('particleDirection'),age=.25-p.delay;
 assert.ok(Math.abs(direction.getY(index)-(p.velocity[1]*Math.exp(-p.drag*age)-p.gravity*age))<1e-6,'droplet orientation follows its falling velocity');
});
test('pool bounds retained bursts and prevents duplicate release ownership',()=>{
 const disposed:THREE.Group[]=[],pool=new EffectPool(g=>disposed.push(g),2),groups=Array.from({length:3},()=>pool.acquireMuzzle());
 groups.forEach(g=>pool.release(g));pool.release(groups[2]);assert.equal(pool.size,2);assert.deepEqual(disposed,[groups[0]]);assert.equal(pool.acquireMuzzle(),groups[1]);pool.clear();assert.deepEqual(disposed,[groups[0],groups[2]]);
});
