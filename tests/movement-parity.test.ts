import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fixtureGame,movementStep,movementState,type MovementFixture} from './helpers/movement-fixtures.ts';

const fixtures=JSON.parse(readFileSync(new URL('./fixtures/movement-parity.json',import.meta.url),'utf8')) as MovementFixture[];
for(const fixture of fixtures)test(`shared TS/Rust movement trace: ${fixture.name}`,()=>{
 const game=fixtureGame(fixture);
 for(const segment of fixture.segments){
  for(let i=0;i<segment.ticks;i++)movementStep(game,segment.inputs);
  const actual=movementState(game.actors);
  segment.expected!.forEach((row,index)=>{for(const [key,expected]of Object.entries(row)){const value=actual[index][key];if(typeof expected==='number')assert.ok(Math.abs((value as number)-expected)<1e-8,`${key}: ${value} != ${expected}`);else assert.equal(value,expected,key);}});
 }
});
