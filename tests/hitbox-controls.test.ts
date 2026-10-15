import test from 'node:test';
import assert from 'node:assert/strict';
import data from '../src/generated/hitboxData.json';
import {sampleWeaponAnimation,type WeaponAction} from '../src/weaponAnimation.ts';
import type {ImportedWeaponProfile} from '../src/importedWeapons.ts';
const modes=['idle','cycle','reload','reloadPartial','melee'] as const;
test('dense weapon controls preserve non-grid action targets within a millimetre',()=>{
 let position=0,angle=0,weight=0;
 for(const faction of ['british','russian','german'] as const)for(const mode of modes){
  const table=data.weaponControls[faction][mode];let index=0;
  for(let i=0;i<2401;i++){
   const phase=(i+.3781)/2401;while(index+1<table.phases.length-1&&table.phases[index+1]<phase)index++;
   const a=table.frames[index],b=table.frames[index+1],t=(phase-table.phases[index])/(table.phases[index+1]-table.phases[index]);
   const exact=sampleWeaponAnimation(faction,(mode==='reloadPartial'?'reload':mode) as WeaponAction,phase,mode==='reload',data.rigs[faction].weaponProfile as unknown as ImportedWeaponProfile);
   for(const key of ['position','right','rotation'] as const){const error=Math.hypot(...exact[key].map((v,n)=>v-(a[key][n]+(b[key][n]-a[key][n])*t)));if(key==='rotation')angle=Math.max(angle,error);else position=Math.max(position,error);}
   for(const key of ['fingerOpen','thumbContact','boltGrip'] as const)weight=Math.max(weight,Math.abs(exact[key]-(a[key]+(b[key]-a[key])*t)));
  }
 }
 assert.ok(position<.001,`action target error ${position}m`);assert.ok(angle<.001,`rotation error ${angle}rad`);assert.ok(weight<.001,`contact weight error ${weight}`);
 console.log({maximumControlPositionError:position,maximumControlRotationError:angle,maximumContactWeightError:weight});
});
