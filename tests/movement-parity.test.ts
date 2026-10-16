import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fixtureGame,movementStep,movementState,type MovementFixture} from './helpers/movement-fixtures.ts';

const fixtures=JSON.parse(readFileSync(new URL('./fixtures/movement-parity.json',import.meta.url),'utf8')) as MovementFixture[];
function compare(actual:unknown,expected:unknown,path:string){
 if(typeof expected==='number')assert.ok(Math.abs((actual as number)-expected)<1e-8,`${path}: ${actual} != ${expected}`);
 else if(expected&&typeof expected==='object')for(const [key,value] of Object.entries(expected))compare((actual as Record<string,unknown>)[key],value,`${path}.${key}`);
 else assert.equal(actual,expected,path);
}
for(const fixture of fixtures)test(`shared TS/Rust movement trace: ${fixture.name}`,()=>{
 const game=fixtureGame(fixture);
 for(const segment of fixture.segments){
  for(let i=0;i<segment.ticks;i++)movementStep(game,segment.inputs);
  const actual=movementState(game.actors);
  segment.expected!.forEach((row,index)=>compare(actual[index],row,fixture.name));
 }
});
