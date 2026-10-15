import test from 'node:test';
import assert from 'node:assert/strict';
import {FACTIONS,WEAPONS} from '../src/config.ts';
import {weaponIcon} from '../src/weaponIcons.ts';

test('melee kill icons use one faction-independent fist and an accessible melee label',()=>{
 const icons=FACTIONS.map(faction=>weaponIcon(faction,'melee'));
 assert.equal(new Set(icons).size,1,'a melee kill must not inherit the faction rifle silhouette');
 assert.match(icons[0],/class="weapon-icon melee"/);
 assert.match(icons[0],/role="img" aria-label="Melee"/);
 assert.match(icons[0],/<title>Melee<\/title>/);
 for(const faction of FACTIONS)assert.notEqual(icons[0],weaponIcon(faction,'rifle'));
});

test('the carried grenade icon remains distinct from a melee kill',()=>{
 for(const faction of FACTIONS){
  const grenade=weaponIcon(faction,'grenade');
  assert.match(grenade,/class="weapon-icon grenade"/);
  assert.match(grenade,/aria-label="Stielhandgranate"/);
  assert.notEqual(grenade,weaponIcon(faction,'melee'));
 }
});

test('rifle kills retain distinct weapon silhouettes and headshot announcements',()=>{
 assert.equal(new Set(FACTIONS.map(faction=>weaponIcon(faction))).size,3);
 for(const faction of FACTIONS){
  const icon=weaponIcon(faction,'rifle',true);
  assert.ok(icon.includes(`aria-label="${WEAPONS[faction].name} headshot"`));
  assert.match(icon,/<span class="headshot" aria-label="Headshot">/);
 }
});
