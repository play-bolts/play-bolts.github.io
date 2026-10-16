import {clamp} from './config';

export interface InputTimingSample {received:number;late:number;missing:number;arrivalLead:number;shots?:number;rewindClamped?:number;shotAgeMs?:number}

/** Scheduling slack is learned from arrivals at the authority, rather than
 * inflated by downlink-only jitter. Counters are scoped to the current life. */
export class AdaptiveInputLead {
 ticks=2;
 changes=0;
 private previous:InputTimingSample|undefined;
 private healthySince=0;
 private adjustedAt=-Infinity;
 private shift=0;
 reset(now:number,preserveLead=false){if(!preserveLead)this.ticks=2;this.previous=undefined;this.healthySince=now;this.adjustedAt=-Infinity;this.shift=0;}
 observe(sample:InputTimingSample|undefined,now:number){
  if(!sample)return;
  const prior=this.previous;this.previous={...sample};
  if(!prior||sample.received<prior.received||sample.late<prior.late||sample.missing<prior.missing){this.healthySince=now;return;}
  const late=sample.late-prior.late,missing=sample.missing-prior.missing;
  // Deliberately increasing lead introduces a small scheduling gap. Do not
  // treat that gap as fresh congestion when newly arriving commands have slack.
  const unhealthy=late>0||missing>0&&sample.arrivalLead<=1;
  if(unhealthy){
   this.healthySince=now;
   if(now-this.adjustedAt>=250)this.adjust(clamp(this.ticks+Math.max(1,1-sample.arrivalLead),2,8),now);
  }else if(missing>0||sample.arrivalLead<2){this.healthySince=now;}
  else if(sample.received>prior.received&&now-this.healthySince>=4000&&now-this.adjustedAt>=2000){this.adjust(this.ticks-1,now);this.healthySince=now;}
 }
 private adjust(value:number,now:number){const ticks=clamp(Math.round(value),2,8);if(ticks===this.ticks)return;this.shift+=ticks-this.ticks;this.ticks=ticks;this.changes++;this.adjustedAt=now;}
 takeShift(){const value=this.shift;this.shift=0;return value;}
 clearShift(){this.shift=0;}
 get sample(){return this.previous?{...this.previous}:undefined;}
}

/** Remote playback never steps to a packet's timestamp. It can run at 90–110%
 * to restore its buffer, and freezes at the latest available authority state.
 * The only discontinuity is an explicit reset after >1 s of accumulated lag. */
export class RemotePlaybackClock {
 time=0;
 targetDelay=.1;
 jitter=0;
 underruns=0;
 resyncs=0;
 private latest=0;
 private receivedAt=0;
 private advancedAt=0;
 private ready=false;
 private started=false;
 private starving=false;
 reset(time:number,now:number){this.time=time;this.latest=time;this.receivedAt=now;this.advancedAt=now;this.ready=true;this.started=false;this.starving=false;this.jitter=0;this.targetDelay=.1;}
 receive(time:number,now:number,reset=false){
  if(reset||!this.ready){this.reset(time,now);return;}
  const seconds=Math.max(0,(now-this.receivedAt)/1000),simulation=Math.max(0,time-this.latest);
  // Keep a recent peak, then decay over a few seconds. A flushed burst must
  // not instantly erase the evidence that the previous gap exhausted a buffer.
  this.jitter=Math.max(this.jitter*Math.exp(-seconds/3),Math.max(0,seconds-simulation));
  this.targetDelay=clamp(.1+this.jitter,.1,.18);
  this.latest=time;this.receivedAt=now;
  if(time-this.time>1){this.time=Math.max(this.time,time-this.targetDelay);this.advancedAt=now;this.started=true;this.starving=false;this.resyncs++;}
 }
 advance(now:number){
  if(!this.ready)return this.time;
  const dt=Math.min(.25,Math.max(0,(now-this.advancedAt)/1000));this.advancedAt=now;
  const target=this.latest+Math.min(.25,Math.max(0,(now-this.receivedAt)/1000))-this.targetDelay;
  if(!this.started){if(target<=this.time)return this.time;this.started=true;}
  const difference=target-this.time,rate=clamp(1+difference*2,.9,1.1);
  const next=Math.min(this.latest,this.time+dt*rate),starving=next>=this.latest-1e-8;
  if(starving&&!this.starving)this.underruns++;
  this.starving=starving;this.time=Math.max(this.time,next);return this.time;
 }
 get bufferedSeconds(){return Math.max(0,this.latest-this.time);}
 get isStarving(){return this.starving;}
}
