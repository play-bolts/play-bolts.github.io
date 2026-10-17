export const LOADING_TIPS=[
 'Lean with Q and E to peek around corners with less exposure.',
 'Right-click to aim down your rifle’s iron sights.',
 'In multiplayer, press T to chat, Enter to send, or Esc to cancel.',
 'Turn hit indicators on or off in Options.',
 'Press Shift to interrupt a reload with a melee attack at close range.',
 'With one or two human players, multiplayer lobbies add two AI soldiers.',
 'Bolts is inspired by the original Call of Duty and its competitive rifle-only community.',
] as const;
export const LOADING_TIP_INTERVAL_MS=10000;
export const LOADING_TIP_FADE_MS=120;

/** A shuffled, reversible sequence that only runs while the loading UI is active. */
export class LoadingTips {
 private order:string[]=[];
 private index=0;
 private active=false;
 private paused=false;
 private advanceTimer:ReturnType<typeof setTimeout>|undefined;
 private fadeTimer:ReturnType<typeof setTimeout>|undefined;
 constructor(
  private render:(text:string,fading:boolean,announce:boolean)=>void,
  private reducedMotion:()=>boolean=()=>false,
  private random:()=>number=Math.random,
 ){}
 start(){
  if(this.active)return;
  this.order=[...LOADING_TIPS];
  for(let i=this.order.length-1;i>0;i--){const j=Math.floor(this.random()*(i+1));[this.order[i],this.order[j]]=[this.order[j],this.order[i]];}
  this.index=0;this.active=true;this.render(this.order[this.index],false,false);this.schedule();
 }
 stop(){
  this.active=false;clearTimeout(this.advanceTimer);clearTimeout(this.fadeTimer);
  this.advanceTimer=this.fadeTimer=undefined;
  if(this.order.length)this.render(this.order[this.index],false,false);
 }
 setPaused(paused:boolean){
  if(this.paused===paused)return;this.paused=paused;this.schedule();
 }
 move(direction:1|-1,announce=true){
  if(!this.active)return;
  this.index=(this.index+direction+this.order.length)%this.order.length;
  clearTimeout(this.fadeTimer);this.fadeTimer=undefined;
  if(this.reducedMotion())this.render(this.order[this.index],false,announce);
  else{
   // Fade the old text first. Rapid arrow presses replace the pending change.
   this.render(this.order[this.index],true,false);
   this.fadeTimer=setTimeout(()=>{this.fadeTimer=undefined;this.render(this.order[this.index],false,announce);},LOADING_TIP_FADE_MS);
  }
  this.schedule();
 }
 private schedule(){
  clearTimeout(this.advanceTimer);this.advanceTimer=undefined;
  if(this.active&&!this.paused)this.advanceTimer=setTimeout(()=>this.move(1,false),LOADING_TIP_INTERVAL_MS);
 }
}
