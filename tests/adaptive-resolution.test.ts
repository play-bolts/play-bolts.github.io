import test from 'node:test';
import assert from 'node:assert/strict';
import {AdaptiveResolution} from '../src/adaptiveResolution';
test('adaptive resolution requires sustained misses and stays within the small approved range',()=>{
 const controller=new AdaptiveResolution();controller.setBase(1.75);
 for(let i=0;i<60;i++)controller.sample(16.67,true);controller.sample(180,true);assert.equal(controller.ratio,1.75,'one hitch does not soften the scene');
 for(let i=0;i<500;i++)controller.sample(33.33,true);assert.equal(controller.ratio,1.5);
 for(let i=0;i<100;i++)controller.sample(16.67,true);assert.equal(controller.ratio,1.5,'recovery waits before probing higher resolution');
 for(let i=0;i<2500;i++)controller.sample(16.67,true);assert.equal(controller.ratio,1.75);
});
test('low DPI/manual quality and hidden or paused tabs retain native configured resolution',()=>{
 const controller=new AdaptiveResolution();for(const base of [1,1.25,1.5]){controller.setBase(base);for(let i=0;i<1000;i++)controller.sample(40,true);assert.equal(controller.ratio,base);}
 controller.setBase(1.75);for(let i=0;i<100;i++)controller.sample(40,true);assert.ok(controller.ratio<1.75);assert.equal(controller.sample(40,false),1.75);
 for(const value of [NaN,Infinity,0,-1,1000])assert.equal(controller.sample(value,true),null);assert.equal(controller.ratio,1.75);
});
