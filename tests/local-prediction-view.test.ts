import test from 'node:test';
import assert from 'node:assert/strict';
import {LocalPredictionView} from '../src/localPredictionView.ts';

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
 assert.ok(Math.abs(view.sample(.5,111).x-.04)<1e-12);
});
test('repeated corrections preserve continuity and teleports/reset never ease across the map',()=>{
 const view=new LocalPredictionView();view.reset(point(1),0);
 view.reconcile(point(1),point(.92),0);const shown=view.sample(1,20).x;
 view.reconcile(point(.92),point(.97),20);assert.ok(Math.abs(view.sample(1,20).x-shown)<1e-12);
 view.reconcile(point(.97),point(8),21);assert.equal(view.sample(.2,21).x,8);
 view.reconcile(point(8),point(8.1),22,true);assert.equal(view.sample(0,22).x,8.1);
});
