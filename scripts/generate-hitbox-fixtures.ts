import fs from 'node:fs';
import {sampleHitboxCore} from '../src/hitboxCore.ts';
import {sampleHitVolumes,rayHitVolumes} from '../src/hitboxes.ts';
import {createActor} from '../src/engine.ts';
import {initialMotion} from '../src/soldierMotionState.ts';
const cases:any[]=[];
for(const faction of ['british','russian','german'] as const)for(const [name,patch]of Object.entries({stand:{},crouch:{stance:'crouch'},prone:{stance:'prone'},lean:{lean:.8,yaw:.6,pitch:.42},run:{moving:4.2,pitch:-.35,ads:true},reload:{reload:1.3,reloadTotal:3.2,stance:'crouch',pitch:.7},jump:{grounded:false,jumpStarted:3.8,y:1.1,vy:3.2},melee:{lastMeleeTime:3.8,selectedWeapon:'rifle'},grenade:{selectedWeapon:'grenade',lastMeleeTime:3.7},land:{landedAt:3.94,landingSpeed:5.4},hurt:{lastHurtTime:3.9},switchRifle:{switchStarted:3.85,switchDuration:.6,switchFrom:'rifle',selectedWeapon:'grenade'},switchGrenade:{switchStarted:3.6,switchDuration:.6,switchFrom:'rifle',selectedWeapon:'grenade'},switchBack:{switchStarted:3.6,switchDuration:.6,switchFrom:'grenade',selectedWeapon:'rifle'},partialReload:{reload:.8,reloadTotal:2.1,pitch:-.35,ads:false},aimed:{pitch:.67,ads:true},transition:{stance:'prone',moving:1.7,pose:{phase:.27,crouch:.32,prone:.45,aim:.36,speed:2.6,forward:.45,sideways:-.55}}})){
 const actor=Object.assign(createActor(2,faction,'Fixture'),patch,{x:2,z:-3,yaw:.4,ack:0,hipSpread:.02});
 actor.pose??=initialMotion(actor,4.05);if(name==='run')actor.pose.phase=.37;
 const time=4.05,volumes=sampleHitVolumes(actor,time),rays=[];
 for(const volume of volumes){const origin={x:volume.center.x,y:volume.center.y,z:volume.center.z+4},direction={x:0,y:0,z:-1};rays.push({origin,direction,expected:rayHitVolumes(origin,direction,volumes)});}
 for(const x of [-.7,-.3,0,.3,.7])for(const y of [.15,.65,1.3,1.65]){const origin={x:actor.x+x,y:actor.y+y,z:actor.z+4},direction={x:0,y:0,z:-1};rays.push({origin,direction,expected:rayHitVolumes(origin,direction,volumes)});}
 const safeActor=Object.fromEntries(Object.entries(actor).filter(([key])=>key!=='ai').map(([key,value])=>[key,typeof value==='number'&&!Number.isFinite(value)?-1000:value]));
 const coreBones=sampleHitboxCore(actor,time).bones.flatMap((b,index)=>b?[{index,position:b.position.toArray(),rotation:b.rotation.toArray()}]:[]);
 cases.push({coreBones,name:`${faction}/${name}`,actor:safeActor,time,volumes,rays});
}
fs.writeFileSync('tests/fixtures/hitbox-parity.json',JSON.stringify(cases));
console.log(`Wrote ${cases.length} cross-language cases, ${cases.reduce((n,c)=>n+c.rays.length,0)} rays`);
