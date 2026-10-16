import test from 'node:test';
import assert from 'node:assert/strict';
import {sampleNetworkColliders} from '../src/networkCollision.ts';
import {resolveActorMovement} from '../src/actorCollision.ts';
import {Game,createActor} from '../src/engine.ts';
import {ARENA,blocked} from '../src/config.ts';

const body=(id:number,x=13.5,z=0)=>({...createActor(id,'british',`Player ${id}`),x,z,spawnGeneration:1});
test('prediction uses authoritative collision history independently of rendered positions',()=>{
 const first=body(7,13.5,0),second={...first,z:.24,moving:4.8};
 const frames=[{time:0,actors:[first]},{time:.05,actors:[second]}];
 const collider=sampleNetworkColliders(frames,.1,42)[0];assert.ok(Math.abs(collider.z-.48)<1e-10);
 const game=new Game();game.state='playing';const p=body(0,13.5,1.2);p.collisionId=42;game.actors=[p,body(1,13.5,1.2)];
 game.move(p,0,-1,1/60,false,[collider]);const withStaleDisplay=p.z;
 p.z=1.2;game.actors[1].z=-10;game.move(p,0,-1,1/60,false,[collider]);assert.equal(p.z,withStaleDisplay,'mutating a displayed remote actor cannot change prediction');
 assert.equal(frames[1].actors[0].z,.24,'collision extrapolation does not mutate snapshots');
});
test('collision history interpolates past ticks and extrapolation is bounded and stops with authoritative motion',()=>{
 const first=body(7),second={...first,z:.24,moving:4.8};
 const frames=[{time:0,actors:[first]},{time:.05,actors:[second]}];
 assert.ok(Math.abs(sampleNetworkColliders(frames,.025,42)[0].z-.12)<1e-10);
 assert.ok(Math.abs(sampleNetworkColliders(frames,1,42)[0].z-.72)<1e-10,'no more than 100ms extrapolation');
 second.moving=0;assert.equal(sampleNetworkColliders(frames,1,42)[0].z,.24);
});
test('collider extrapolation respects walls, life changes, spectators and stable self identity',()=>{
 const first=body(7,ARENA.width/2-.5,0),second={...first,x:first.x+.1,moving:4.8};
 const frames=[{time:0,actors:[first]},{time:.05,actors:[second]}];
 const collider=sampleNetworkColliders(frames,.15,42)[0];assert.equal(blocked(collider.x,collider.z,0,.3),false);
 second.spawnGeneration=2;assert.equal(sampleNetworkColliders(frames,.15,42)[0].x,second.x,'never infer velocity across a respawn');
 assert.equal(sampleNetworkColliders(frames,.15,7).length,0);
 second.spectator=true;assert.equal(sampleNetworkColliders(frames,.15,42).length,0);
});
test('coincident-body separation uses stable server IDs despite local roster reindexing',()=>{
 const a=body(42,0,0),b=body(7,0,0),options={blocked:()=>false};
 const server=resolveActorMovement(a,[a,b],0,0,options);
 const local={...a,id:0,collisionId:42},remote={...b,id:1,collisionId:7};
 assert.deepEqual(resolveActorMovement(local,[local,remote],0,0,options),server);
});
