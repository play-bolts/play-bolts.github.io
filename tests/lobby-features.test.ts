import test from 'node:test';
import assert from 'node:assert/strict';
import { EXTRA_LOBBIES_ENABLED,lobbyLocationEnabled } from '../src/lobbies.ts';

test('extra lobbies are off by default while legacy and Oregon rooms remain available',()=>{
 assert.equal(EXTRA_LOBBIES_ENABLED,false);
 assert.equal(lobbyLocationEnabled(),true);
 assert.equal(lobbyLocationEnabled('or'),true);
 for(const region of ['lon','sg','sp']){
  assert.equal(lobbyLocationEnabled(region),false);
  assert.equal(lobbyLocationEnabled(region,true),true);
 }
 assert.equal(lobbyLocationEnabled('unknown',true),false);
});
