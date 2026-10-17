import test from 'node:test';
import assert from 'node:assert/strict';
import {findPath,type RouteRisk} from '../src/navigation.ts';
import {coverExposure} from '../src/aiCover.ts';
import {navigationComparisonPairs,referenceFindPath} from '../scripts/performance-navigation-reference.ts';

test('heap navigation preserves all 528 original audit routes including risk-aware detours',()=>{
 const pairs=navigationComparisonPairs(),cache=new Map<string,number>();
 const threats=[{id:1,point:{x:-13,y:1.65,z:15},time:1,confidence:1}];
 const risk:RouteRisk=point=>{
  const key=`${point.x}:${point.z}`;let value=cache.get(key);
  if(value===undefined){value=coverExposure({...point,y:0},threats)*2.5;cache.set(key,value);}
  return value;
 };
 assert.equal(pairs.length*2,528);
 for(const [index,{from,to}] of pairs.entries())for(const mode of [undefined,risk]){
  assert.deepEqual(findPath(from,to,mode),referenceFindPath(from,to,mode),`pair ${index}, ${mode?'risk':'distance'}`);
 }
});

function traced(path:typeof findPath,from:{x:number;z:number},to:{x:number;z:number},value:(point:{x:number;z:number},call:number)=>number){
 const calls:{x:number;z:number}[]=[];
 const route=path(from,to,point=>{calls.push({...point});return value(point,calls.length);});
 return{route,calls};
}

test('risk callbacks retain edge visitation order/count, including stateful costs and score ties',()=>{
 const pairs=navigationComparisonPairs();
 const risks=[
  ()=>0,
  (point:{x:number;z:number})=>Math.abs(point.x)<1?4:0,
  (_point:{x:number;z:number},call:number)=>call%7===0?20:call%3===0?.4:0,
 ];
 for(const pair of [pairs[1],pairs[7],pairs[81],pairs[163]])for(const risk of risks){
  const expected=traced(referenceFindPath,pair.from,pair.to,risk);
  assert.ok(expected.calls.length>0,'exercise an actual search');
  assert.deepEqual(traced(findPath,pair.from,pair.to,risk),expected);
 }
});

test('negative and non-finite risks retain the original clamp and blocked-edge behaviour',()=>{
 const {from,to}=navigationComparisonPairs()[7];
 for(const risk of [()=>-4,()=>-Infinity,()=>NaN,()=>Infinity,(p:{x:number;z:number})=>p.z>0?Infinity:-1]){
  assert.deepEqual(traced(findPath,from,to,risk),traced(referenceFindPath,from,to,risk));
 }
});

test('nested risk queries lease independent search state at every recursion depth',()=>{
 const pairs=navigationComparisonPairs();
 function nested(path:typeof findPath){
  let inner:{x:number;z:number}[]|undefined,deepest:{x:number;z:number}[]|undefined;
  const calls:{x:number;z:number}[]=[];
  const route=path(pairs[7].from,pairs[7].to,point=>{
   calls.push({...point});
   if(!inner)inner=path(pairs[81].from,pairs[81].to,middle=>{
    if(!deepest)deepest=path(pairs[163].from,pairs[163].to,deep=>deep.x>0?.3:0);
    return middle.z>0?.7:0;
   });
   return point.x>0?inner.length/100:0;
  });
  assert.ok(inner?.length&&deepest?.length);
  return{route,calls,inner,deepest};
 }
 assert.deepEqual(nested(findPath),nested(referenceFindPath));
 // Reusing the root scratch storage cannot mutate an already returned route.
 const retained=findPath(pairs[0].from,pairs[1].to),copy=structuredClone(retained);
 for(const pair of pairs.slice(20,30))findPath(pair.from,pair.to);
 assert.deepEqual(retained,copy);
});

test('throwing risk callbacks release both outer and nested search leases',()=>{
 const pairs=navigationComparisonPairs(),failure=new Error('risk failed');
 assert.throws(()=>findPath(pairs[7].from,pairs[7].to,()=>{
  findPath(pairs[81].from,pairs[81].to,()=>{throw failure;});
  return 0;
 }),error=>error===failure);
 // Reentrant failure can also be caught by a still-active outer search.
 let failed=false;
 const actual=findPath(pairs[7].from,pairs[7].to,()=>{
  if(!failed){failed=true;assert.throws(()=>findPath(pairs[81].from,pairs[81].to,()=>{throw failure;}),error=>error===failure);}
  return 0;
 });
 assert.equal(failed,true);
 assert.deepEqual(actual,referenceFindPath(pairs[7].from,pairs[7].to));
 for(const pair of pairs.slice(0,16))assert.deepEqual(findPath(pair.from,pair.to),referenceFindPath(pair.from,pair.to));
});

test('same-cell and invalid endpoints preserve empty routes without evaluating risk',()=>{
 const origin={x:-13,z:-15};
 const risk=()=>{throw new Error('risk must not run');};
 for(const [from,to] of [[origin,origin],[{x:NaN,z:0},origin],[origin,{x:Infinity,z:0}]]){
  assert.deepEqual(findPath(from,to,risk),referenceFindPath(from,to,risk));
 }
});
