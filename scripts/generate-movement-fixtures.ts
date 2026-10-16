/** node --import tsx scripts/generate-movement-fixtures.ts */
import {writeFileSync} from 'node:fs';
import {createActor,type Actor} from '../src/engine.ts';
import {MAP_SCALE} from '../src/config.ts';
import {fixtureGame,movementStep,movementState,type MovementFixture,type MovementSegment} from '../tests/helpers/movement-fixtures.ts';

function body(id:number,patch:Partial<Actor>={}){
 const {ai,...a}=Object.assign(createActor(id,'british','Fixture'),{x:13.5,z:-5},patch);
 return Object.fromEntries(Object.entries({...a,ack:0,hipSpread:.08,spawnGeneration:1}).map(([key,value])=>[key,typeof value==='number'&&!Number.isFinite(value)?-1000:value]));
}
const segment=(ticks:number,input:MovementSegment['inputs'][number]['input'],id=42):MovementSegment=>({ticks,inputs:[{id,input}]});
const cases:MovementFixture[]=[
 {name:'run and stop',actors:[body(42)],segments:[segment(12,{forward:1}),segment(8,{})]},
 {name:'diagonal walk and lean',actors:[body(42)],segments:[segment(20,{forward:1,right:1,walk:true,yaw:.3,lean:1}),segment(10,{lean:-1}),segment(10,{})]},
 {name:'stance speed and ADS transitions',actors:[body(42)],segments:[segment(12,{forward:1,stance:'crouch',ads:true}),segment(18,{forward:1,stance:'prone',ads:true}),segment(1,{stance:'prone',ads:true,jump:true}),segment(1,{stance:'stand',ads:true,jump:true}),segment(45,{stance:'stand'})]},
 {name:'jump and landing',actors:[body(42)],segments:[segment(1,{forward:1,jump:true}),segment(12,{forward:1}),segment(50,{})]},
 {name:'grenade movement',actors:[body(42,{selectedWeapon:'grenade'})],segments:[segment(20,{forward:1,ads:true}),segment(8,{forward:1,walk:true}),segment(8,{})]},
 {name:'slide along arena wall',actors:[body(42,{x:14.3,z:-5})],segments:[segment(30,{forward:1,right:-1}),segment(10,{})]},
 {name:'opposing actors and sliding',actors:[body(7,{z:-.7}),body(42,{z:.7,yaw:Math.PI})],segments:[{ticks:20,inputs:[{id:7,input:{forward:1}},{id:42,input:{forward:1,yaw:Math.PI}}]},{ticks:10,inputs:[{id:7,input:{forward:1,right:1}},{id:42,input:{}}]}]},
 {name:'coincident bodies',actors:[body(42,{x:0,z:-3}),body(7,{x:0,z:-3})],segments:[segment(1,{}),segment(5,{forward:1})]},
 {name:'landing on cover',actors:[body(42,{x:3*MAP_SCALE,z:-18*MAP_SCALE,y:3.6,vy:-2,grounded:false})],segments:[segment(30,{})]},
 {name:'walking off cover',actors:[body(42,{x:3*MAP_SCALE,z:-18*MAP_SCALE,y:2.3,yaw:Math.PI/2})],segments:[segment(30,{forward:1,yaw:Math.PI/2}),segment(30,{})]},
];
for(const fixture of cases){const game=fixtureGame(fixture);for(const step of fixture.segments){for(let i=0;i<step.ticks;i++)movementStep(game,step.inputs);step.expected=movementState(game.actors);}}
writeFileSync('tests/fixtures/movement-parity.json',JSON.stringify(cases,null,2)+'\n');
console.log(`Wrote ${cases.length} shared movement traces.`);
