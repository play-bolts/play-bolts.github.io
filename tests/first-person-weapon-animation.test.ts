import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {FACTIONS,type Faction} from '../src/config.ts';
import type {ImportedWeaponProfile} from '../src/importedWeapons.ts';
import {sampleWeaponAnimation} from '../src/weaponAnimation.ts';
import {sampleFirstPersonWeaponAnimation} from '../src/firstPersonWeaponAnimation.ts';

const profiles=Object.fromEntries(Object.entries({british:'enfield',russian:'mosin',german:'kar98k'}).map(([faction,name])=>[faction,JSON.parse(readFileSync(new URL(`../public/assets/imported-weapons/${name}-profile.json`,import.meta.url),'utf8'))])) as Record<Faction,ImportedWeaponProfile>;

test('first-person framing preserves canonical weapon mechanics and action timing',()=>{
 for(const faction of FACTIONS)for(const action of ['idle','cycle','reload','melee'] as const)for(const full of [false,true])for(let i=0;i<=100;i++){
  const canonical=sampleWeaponAnimation(faction,action,i/100,full,profiles[faction]);
  assert.deepEqual(sampleFirstPersonWeaponAnimation(faction,action,i/100,full,profiles[faction],0),canonical,'hip presentation starts from the unchanged canonical action');
  for(const ads of [.25,.5,1]){
   const view=sampleFirstPersonWeaponAnimation(faction,action,i/100,full,profiles[faction],ads);
   const{position,...mechanics}=view,{position:worldPosition,...worldMechanics}=canonical;
   assert.deepEqual(mechanics,worldMechanics,'view framing cannot change bolt, charger, grip, strike phase or recovery');
   if(action!=='cycle')assert.deepEqual(position,worldPosition);
  }
 }
 for(const faction of FACTIONS){
  const hip=sampleFirstPersonWeaponAnimation(faction,'cycle',.4,false,profiles[faction],0),ads=sampleFirstPersonWeaponAnimation(faction,'cycle',.4,false,profiles[faction],1);
  assert.ok(hip.position[1]-ads.position[1]>.08,'the visual boundary actually separates hip operating-hand framing from ADS');
 }
});

test('editing a first-person pose cannot alter world contacts, source profiles or later views',()=>{
 for(const faction of FACTIONS){
  const profile=profiles[faction],beforeProfile=structuredClone(profile);
  const world=structuredClone(sampleWeaponAnimation(faction,'idle',0,false,profile));
  const first=sampleFirstPersonWeaponAnimation(faction,'idle',0,false,profile),another=structuredClone(first);
  const mutateArrays=(value:unknown):void=>{
   if(Array.isArray(value)){for(let i=0;i<value.length;i++)if(typeof value[i]==='number')value[i]+=3;else mutateArrays(value[i]);}
   else if(value&&typeof value==='object')for(const child of Object.values(value))mutateArrays(child);
  };
  mutateArrays(first);first.fingerOpen=1;first.boltTravel=9;
  assert.deepEqual(sampleWeaponAnimation(faction,'idle',0,false,profile),world,'world sampler retains its canonical source and finger controls');
  assert.deepEqual(sampleFirstPersonWeaponAnimation(faction,'idle',0,false,profile),another,'each view owns independent mutable controls');
  assert.deepEqual(profile,beforeProfile,'source optics, stock anchors and bolt axis remain untouched');
 }
});
