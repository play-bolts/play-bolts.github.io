/** Bounded quality adjustment. Simulation, camera FOV and DOM resolution are independent. */
export class AdaptiveResolution {
 private base=1;private current=1;private samples:number[]=[];private elapsed=0;private healthy=0;
 get ratio(){return this.current;}
 setBase(ratio:number){this.base=this.current=Math.max(.1,Math.min(1.75,ratio));this.resetWindow();this.healthy=0;}
 private resetWindow(){this.samples.length=0;this.elapsed=0;}
 sample(frameMs:number,active:boolean):number|null {
  if(!active){this.resetWindow();this.healthy=0;if(this.current!==this.base){this.current=this.base;return this.current;}return null;}
  const floor=Math.min(this.base,1.5);
  if(floor===this.base||!Number.isFinite(frameMs)||frameMs<=0||frameMs>250)return null;
  this.samples.push(frameMs);this.elapsed+=frameMs;
  if(this.elapsed<2500||this.samples.length<45)return null;
  const sorted=this.samples.sort((a,b)=>a-b),p80=sorted[Math.floor(sorted.length*.8)],elapsed=this.elapsed;this.resetWindow();
  if(p80>21){this.healthy=0;const next=Math.max(floor,Math.round((this.current-.10)*100)/100);if(next!==this.current){this.current=next;return next;}}
  else if(p80<18){this.healthy+=elapsed;if(this.healthy>=10000&&this.current<this.base){this.current=Math.min(this.base,Math.round((this.current+.10)*100)/100);this.healthy=0;return this.current;}}
  else this.healthy=0;
  return null;
 }
}
