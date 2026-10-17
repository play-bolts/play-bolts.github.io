import test from 'node:test';
import assert from 'node:assert/strict';
import {AdaptiveResolution} from '../src/adaptiveResolution';
test('adaptive resolution requires sustained misses and recovers slowly within configured limits',()=>{
 const controller=new AdaptiveResolution();controller.setBase(1.75);
 for(let i=0;i<60;i++)controller.sample(16.67,true);controller.sample(180,true);assert.equal(controller.ratio,1.75,'one hitch does not soften the scene');
 for(let i=0;i<1500;i++)controller.sample(33.33,true);assert.equal(controller.ratio,.75);
 for(let i=0;i<100;i++)controller.sample(16.67,true);assert.equal(controller.ratio,.75,'recovery waits before probing higher resolution');
 for(let i=0;i<7500;i++)controller.sample(16.67,true);assert.equal(controller.ratio,1.75);
});
test('low DPI/manual quality can recover from GPU pressure; hidden or paused tabs restore their base',()=>{
 const controller=new AdaptiveResolution();for(const base of [1,1.25,1.5]){controller.setBase(base);for(let i=0;i<1000;i++)controller.sample(40,true);assert.equal(controller.ratio,.75);}
 controller.setBase(1.75);for(let i=0;i<100;i++)controller.sample(40,true);assert.ok(controller.ratio<1.75);assert.equal(controller.sample(40,false),1.75);
 for(const value of [NaN,Infinity,0,-1,1000])assert.equal(controller.sample(value,true),null);assert.equal(controller.ratio,1.75);
});
test('mobile resolution reduces sustained slow frames to the configured floor and recovers gradually',()=>{
 const controller=new AdaptiveResolution();controller.setBase(1,.75);
 for(let i=0;i<500;i++)controller.sample(33.33,true);assert.equal(controller.ratio,.75);
 for(let i=0;i<100;i++)controller.sample(16.67,true);assert.equal(controller.ratio,.75,'recovery waits for sustained headroom');
 for(let i=0;i<2500;i++)controller.sample(16.67,true);assert.equal(controller.ratio,1);
});
test('explicit floors and bases below the default floor remain respected',()=>{
 const controller=new AdaptiveResolution();controller.setBase(1,.75);
 for(let i=0;i<500;i++)controller.sample(40,true);assert.equal(controller.ratio,.75);assert.equal(controller.sample(40,false),1);
 controller.setBase(1.75,1.5);for(let i=0;i<500;i++)controller.sample(40,true);assert.equal(controller.ratio,1.5,'an explicit user/platform floor is respected');
 controller.setBase(.5,.75);for(let i=0;i<500;i++)controller.sample(40,true);assert.equal(controller.ratio,.5,'a floor above the base cannot increase rendering resolution');
});
test('CPU-dominated slow frames do not trigger lower pixel quality',()=>{
 const controller=new AdaptiveResolution();controller.setBase(1);
 for(let i=0;i<1000;i++)controller.sample(33.33,true,28);assert.equal(controller.ratio,1);
 for(let i=0;i<500;i++)controller.sample(33.33,true,4);assert.equal(controller.ratio,.75);
});
