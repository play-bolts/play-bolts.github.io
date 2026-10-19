import test from 'node:test';
import assert from 'node:assert/strict';
import {FootstepSequence,FOOTSTEP_VARIANTS,FOOTSTEP_STANCES,FOOTSTEP_SIDES,synthesizeFootstep,footstepLevel,renderMovementPreview,MOVEMENT_PREVIEW_SPEED} from '../src/movementAudio.ts';
import {synthesizeRifle,synthesizeRiflePreview} from '../src/audioSynthesis.ts';
import {FACTIONS} from '../src/config.ts';
import {gaitRate} from '../src/soldierGait.ts';

const rms=(pcm:Float32Array)=>Math.sqrt(pcm.reduce((sum,value)=>sum+value*value,0)/pcm.length);
const peak=(pcm:Float32Array)=>pcm.reduce((best,value)=>Math.max(best,Math.abs(value)),0);
function energyTime(pcm:Float32Array,rate:number,fraction:number){const target=pcm.reduce((sum,value)=>sum+value*value,0)*fraction;let power=0;for(let i=0;i<pcm.length;i++){power+=pcm[i]*pcm[i];if(power>=target)return i/rate;}return pcm.length/rate;}

test('all stance/foot/take combinations produce bounded, deterministic contact PCM at device rates',()=>{
 for(const rate of [44100,48000])for(const stance of FOOTSTEP_STANCES){
  const takes:Float32Array[]=[];
  for(const side of FOOTSTEP_SIDES)for(let variant=0;variant<FOOTSTEP_VARIANTS;variant++){
   const pcm=synthesizeFootstep(stance,rate,variant,side);takes.push(pcm);
   assert.ok(pcm.every(Number.isFinite));assert.equal(pcm[0],0);assert.equal(pcm.at(-1),0);
   assert.ok(peak(pcm)<=.741);assert.ok(rms(pcm)>.035,'contact has an audible body');
   assert.ok(Math.abs(pcm.reduce((sum,value)=>sum+value,0)/pcm.length)<.003,'no audible DC offset');
   assert.ok(pcm.length>=rate*.25&&pcm.length<=Math.ceil(rate*.40));
   assert.deepEqual(pcm,synthesizeFootstep(stance,rate,variant,side));
  }
  for(let i=1;i<takes.length;i++)assert.notDeepEqual(takes[0],takes[i],'each foot/take has its own grain pattern and weight transfer');
 }
});

test('shuffled movement bags alternate feet, visit every take and never repeat at boundaries',()=>{
 for(const seed of [0,1,0x5a17,73241]){
  const sequence=new FootstepSequence(seed),repeat=new FootstepSequence(seed);let last=-1;
  for(let bag=0;bag<20;bag++){
   const variants=new Set<number>();
   for(let i=0;i<FOOTSTEP_VARIANTS;i++){
    const stance=FOOTSTEP_STANCES[(bag+i)%3],take=sequence.next(stance);
    assert.deepEqual(take,repeat.next(stance));assert.notEqual(take.variant,last);last=take.variant;
    assert.equal(take.side,i%2?'right':'left');variants.add(take.variant);
   }
   assert.equal(variants.size,FOOTSTEP_VARIANTS);
  }
 }
});

test('crouch has a softer weight transfer and quieter but present scrape than walking',()=>{
 const rate=48000,walk=synthesizeFootstep('stand',rate),crouch=synthesizeFootstep('crouch',rate);
 const windowRms=(pcm:Float32Array,start:number,end:number)=>rms(pcm.slice(Math.round(start*rate),Math.round(end*rate)));
 assert.ok(windowRms(crouch,.07,.15)/windowRms(crouch,0,.04)>windowRms(walk,.07,.15)/windowRms(walk,0,.04),'crouch shifts emphasis from heel thump to sole/cloth movement');
 const walkLevel=rms(walk)*footstepLevel('stand',2.5),crouchLevel=rms(crouch)*footstepLevel('crouch',1.4);
 assert.ok(crouchLevel<walkLevel*.85&&crouchLevel>walkLevel*.25,'crouching stays quieter without disappearing');
 assert.ok(footstepLevel('stand',4.8)>footstepLevel('stand',1),'faster contacts carry more weight without pitch shifting');
});

test('review sequence uses runtime takes and gait cadence with no loudness normalization',()=>{
 const rate=44100;
 for(const stance of FOOTSTEP_STANCES){
  const speed=MOVEMENT_PREVIEW_SPEED[stance],preview=renderMovementPreview(stance,rate,{steps:3}),sequence=new FootstepSequence();
  const first=sequence.next(stance),pcm=synthesizeFootstep(stance,rate,first.variant,first.side),gain=footstepLevel(stance,speed);
  const secondAt=Math.round(rate/(2*gaitRate(speed,Number(stance==='crouch'),Number(stance==='prone'))));
  for(let i=0;i<Math.min(secondAt,pcm.length);i++)assert.equal(preview[i],Math.fround(pcm[i]*gain));
  assert.deepEqual(preview,renderMovementPreview(stance,rate,{steps:3}));
  assert.ok(peak(preview)<=.75,'cadence overlap retains ample headroom');
 }
});

test('optional fuller rifle DSP preserves the baseline, duration and comparison loudness',()=>{
 for(const rate of [44100,48000])for(const faction of FACTIONS)for(let variant=0;variant<3;variant++){
  const current=synthesizeRiflePreview(faction,rate,'current',variant),fuller=synthesizeRiflePreview(faction,rate,'fuller',variant);
  assert.deepEqual(current,synthesizeRifle(faction,rate,0x51f15e+variant*7919));
  assert.equal(fuller.length,current.length);assert.notDeepEqual(fuller,current);assert.ok(fuller.every(Number.isFinite));
  assert.equal(fuller[0],0);assert.equal(fuller.at(-1),0);assert.ok(peak(fuller)<=peak(current)+1e-5);
  assert.ok(Math.abs(rms(fuller)/rms(current)-1)<.001,'candidate cannot appear better merely by becoming louder');
  for(const fraction of [.05,.5,.95])assert.ok(Math.abs(energyTime(fuller,rate,fraction)-energyTime(current,rate,fraction))<.015,'fuller texture must preserve the crack/body/tail timing within one game tick');
 }
});
