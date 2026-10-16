import test from 'node:test';
import assert from 'node:assert/strict';
import {LocalPredictionView,clipPredictionView} from '../src/localPredictionView.ts';
import {ARENA,BOXES} from '../src/config.ts';

const point=(x:number)=>({x,y:0,z:0});
test('local view interpolates physics steps and stops on the first neutral step',()=>{
 const view=new LocalPredictionView();view.reset(point(0),0);view.step(point(0),point(.08));
 assert.equal(view.sample(.25,4).x,.02);assert.equal(view.sample(.75,12).x,.06);
 view.step(point(.08),point(.08));
 for(let ms=17;ms<100;ms+=4)assert.equal(view.sample((ms%17)/17,ms).x,.08);
});
test('reconciliation preserves the displayed position then quickly removes only the correction offset',()=>{
 const view=new LocalPredictionView();view.reset(point(0),0);view.step(point(0),point(.08));
 const shown=view.sample(.5,10).x;view.reconcile(point(.08),point(0),10);
 assert.ok(Math.abs(view.sample(.5,10).x-shown)<1e-12);
 view.step(point(0),point(.08));
 const halfway=view.sample(.5,28).x;assert.ok(halfway>.04&&halfway<.12,'normal movement advances while error decays');
 assert.ok(Math.abs(view.sample(.5,211).x-.04)<1e-12);
});
test('moderate correction decays over several frames while release still stops physics interpolation immediately',()=>{
 const view=new LocalPredictionView();view.reset(point(.24),0);view.reconcile(point(.24),point(0),0);
 const first=view.sample(1,1000/60).x;assert.ok(first>.16&&first<.17,'the first frame removes less than8cm of a24cm correction');
 view.step(point(0),point(0));assert.ok(view.sample(1,100).x<.027);assert.equal(view.sample(1,200).x,0);
});
test('camera correction cannot cross domain walls or the floor, and never moves physics',()=>{
 const body={x:ARENA.width/2-.35,y:0,z:0},eye={...body,y:1.65},original={...body};
 const rendered=clipPredictionView({...body,x:body.x+.6},body,eye);
 assert.ok(rendered.x<=ARENA.width/2-.12);assert.deepEqual(body,original);
 const down=clipPredictionView({...body,y:-2},body,eye);assert.ok(down.y+1.65>=.12-1e-9);
 const safe=clipPredictionView({...body,x:body.x-.15},body,eye);assert.equal(safe.x,body.x-.15);
});
test('camera correction keeps near-plane clearance beside a crate, including grazing paths',()=>{
 const box=BOXES[0],edge=box.x+box.w/2,body={x:edge+.35,y:0,z:box.z},eye={...body,y:1.65};
 const rendered=clipPredictionView({...body,x:edge-.3},body,eye);assert.ok(rendered.x>=edge+.12);
 // This ray passes beside the exact box, but through the camera clearance.
 const cornerBody={x:edge+.35,y:0,z:box.z+box.d/2+.05},cornerEye={...cornerBody,y:1.65};
 const graze=clipPredictionView({...cornerBody,x:edge-.3},cornerBody,cornerEye);assert.ok(graze.x>=edge+.12);
});
test('repeated corrections preserve continuity and teleports/reset never ease across the map',()=>{
 const view=new LocalPredictionView();view.reset(point(1),0);
 view.reconcile(point(1),point(.92),0);const shown=view.sample(1,20).x;
 view.reconcile(point(.92),point(.97),20);assert.ok(Math.abs(view.sample(1,20).x-shown)<1e-12);
 view.reconcile(point(.97),point(8),21);assert.equal(view.sample(.2,21).x,8);
 view.reconcile(point(8),point(8.1),22,true);assert.equal(view.sample(0,22).x,8.1);
});
