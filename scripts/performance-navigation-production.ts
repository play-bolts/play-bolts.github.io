/** Compare the frozen original implementation with production navigation.
 * Run alone: node --import tsx scripts/performance-navigation-production.ts
 * Writes a new implementation report; does not overwrite historical audit data.
 */
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {cpus} from 'node:os';
import {performance} from 'node:perf_hooks';
import {findPath,type RouteRisk} from '../src/navigation.ts';
import {coverExposure} from '../src/aiCover.ts';
import {navigationComparisonPairs,referenceFindPath} from './performance-navigation-reference.ts';

const pairs=navigationComparisonPairs(),cache=new Map<string,number>();
const threats=[{id:1,point:{x:-13,y:1.65,z:15},time:1,confidence:1}];
const risk:RouteRisk=point=>{
 const key=`${point.x}:${point.z}`;let value=cache.get(key);
 if(value===undefined){value=coverExposure({...point,y:0},threats)*2.5;cache.set(key,value);}
 return value;
};
for(const {from,to} of pairs)for(const mode of [undefined,risk])assert.deepEqual(findPath(from,to,mode),referenceFindPath(from,to,mode));
let sink:unknown;
function pass(path:typeof findPath,mode?:RouteRisk){
 const started=performance.now();
 for(const pair of pairs)sink=path(pair.from,pair.to,mode);
 return (performance.now()-started)*1000/pairs.length;
}
function comparison(mode?:RouteRisk){
 for(let warmup=0;warmup<3;warmup++){pass(referenceFindPath,mode);pass(findPath,mode);}
 const original:number[]=[],production:number[]=[];
 for(let run=0;run<11;run++){
  // Alternate ordering to reduce the effect of CPU frequency/temperature drift.
  if(run%2){production.push(pass(findPath,mode));original.push(pass(referenceFindPath,mode));}
  else{original.push(pass(referenceFindPath,mode));production.push(pass(findPath,mode));}
 }
 const summary=(values:number[])=>{const sorted=values.slice().sort((a,b)=>a-b);return{medianMicroseconds:sorted[5],minMicroseconds:sorted[0],maxMicroseconds:sorted.at(-1),passMicroseconds:values};};
 const baseline=summary(original),optimized=summary(production);
 return{original:baseline,production:optimized,speedup:baseline.medianMicroseconds/optimized.medianMicroseconds,reductionPercent:(1-optimized.medianMicroseconds/baseline.medianMicroseconds)*100};
}
const report={
 date:new Date().toISOString(),runtime:process.version,cpu:cpus()[0]?.model,
 head:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
 sourceSha256:Object.fromEntries(['src/navigation.ts','src/config.ts','src/aiCover.ts','scripts/performance-navigation-reference.ts'].map(path=>[path,createHash('sha256').update(readFileSync(path)).digest('hex')])),
 method:'Single-process warmed Node comparison of the frozen original A* and production indexed-heap A*. 264 spawn/random pairs, 528 exact full-path checks, three warm-up batches and eleven measured batches per variant/mode, alternating variant order. Both use the same current map and a pre-warmed shared exposure risk field. Times are batch means per query; not individual-query tail latency, browser FPS, mobile hardware or full tactical-planner gains. Each process loads source modules once.',
 exactPathComparisons:pairs.length*2,noRisk:comparison(),cachedRisk:comparison(risk),
};
mkdirSync('temp/performance-implementation',{recursive:true});
writeFileSync('temp/performance-implementation/navigation-production.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
void sink;
