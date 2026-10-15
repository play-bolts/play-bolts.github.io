import test from 'node:test';
import assert from 'node:assert/strict';
import {damageFlashOpacity} from '../src/damageFeedback.ts';

test('damage is immediately visible and lethal flash persists through the beginning of killcam',()=>{
 assert.ok(damageFlashOpacity(0)>.6);
 assert.ok(damageFlashOpacity(180,true)>damageFlashOpacity(180));
 assert.ok(damageFlashOpacity(650,true)>0);
 assert.equal(damageFlashOpacity(650),0);
 assert.equal(damageFlashOpacity(1100,true),0);
 for(const age of [Infinity,NaN,-1])assert.equal(damageFlashOpacity(age),0);
 for(const lethal of [false,true])for(let age=20;age<1200;age+=20)assert.ok(damageFlashOpacity(age,lethal)<=damageFlashOpacity(age-20,lethal));
});
