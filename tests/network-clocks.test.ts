import test from 'node:test';
import assert from 'node:assert/strict';
import {AdaptiveInputLead,RemotePlaybackClock} from '../src/networkTiming.ts';

test('input lead responds to authority lateness, bounds growth, and drains only after sustained healthy arrivals',()=>{
 const lead=new AdaptiveInputLead();lead.reset(0);
 lead.observe({received:10,late:0,missing:0,arrivalLead:3},0);
 lead.observe({received:13,late:2,missing:2,arrivalLead:-2},50);
 assert.equal(lead.ticks,5);assert.equal(lead.takeShift(),3);assert.equal(lead.takeShift(),0);
 // Deliberate gaps used to build lead must not create positive feedback.
 lead.observe({received:16,late:2,missing:5,arrivalLead:5},300);assert.equal(lead.ticks,5);
 lead.observe({received:19,late:5,missing:8,arrivalLead:-20},600);assert.equal(lead.ticks,8);
 lead.observe({received:22,late:5,missing:8,arrivalLead:8},1000);assert.equal(lead.ticks,8);
 lead.observe({received:240,late:5,missing:8,arrivalLead:8},4601);assert.equal(lead.ticks,7);
 lead.observe({received:243,late:5,missing:8,arrivalLead:7},4651);assert.equal(lead.ticks,7);
});

test('counter resets are baselines, not a burst of rejected input, and zero loss keeps the two-tick base',()=>{
 const lead=new AdaptiveInputLead();lead.reset(0);
 for(let n=0;n<30;n++)lead.observe({received:n*3,late:0,missing:0,arrivalLead:3},n*50);
 assert.equal(lead.ticks,2);assert.equal(lead.changes,0);
 lead.observe({received:0,late:0,missing:0,arrivalLead:0},2000);assert.equal(lead.ticks,2);
 lead.observe({received:3,late:0,missing:0,arrivalLead:3},2050);assert.equal(lead.ticks,2);
});

test('a flushed packet burst changes the playback target without jumping or rewinding remote time',()=>{
 const clock=new RemotePlaybackClock();clock.receive(0,25);
 let previous=0;
 for(let n=1;n<=30;n++){
  const now=25+n*1000/60;if(n%3===0)clock.receive(n/60,now);
  const time=clock.advance(now);assert.ok(time>=previous);assert.ok(time-previous<=1.1/60+1e-10);previous=time;
 }
 // The first unpredicted stall can exhaust the buffer; a burst must not then
 // turn its accumulated delay into a single-frame position discontinuity.
 for(let n=31;n<=45;n++){const time=clock.advance(25+n*1000/60);assert.ok(time>=previous);assert.ok(time-previous<=1.1/60+1e-10);previous=time;}
 assert.equal(clock.isStarving,true);
 clock.receive(.55,775);clock.receive(.6,775);clock.receive(.65,775);clock.receive(.7,775);clock.receive(.75,775);
 assert.equal(clock.time,previous);assert.equal(clock.targetDelay,.18);
 for(let n=46;n<=90;n++){
  const now=25+n*1000/60;if(n%3===0)clock.receive(n/60,now);
  const time=clock.advance(now);assert.ok(time>=previous);assert.ok(time-previous<=1.1/60+1e-10);previous=time;
 }
 assert.equal(clock.resyncs,0);
});

test('ordinary packet jitter does not add unbounded latency and severe suspension explicitly resynchronizes',()=>{
 const clock=new RemotePlaybackClock();clock.receive(0,25);
 for(let n=1;n<=200;n++){clock.receive(n*.05,25+n*50+(n%2?9:-9));clock.advance(25+n*50+9);}
 assert.ok(clock.targetDelay>=.1&&clock.targetDelay<.13);
 const before=clock.time;clock.receive(12,12025);assert.ok(clock.time>=before);assert.equal(clock.resyncs,1);
 assert.ok(12-clock.time<=.180000001);
});
