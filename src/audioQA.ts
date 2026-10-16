import {Sound,type SoundEmitter} from './audio';
import {BOXES,type Faction,type Vec} from './config';

/** Development-only, actual browser Web Audio rendering of the shared production path. */
if(import.meta.env.DEV){
 const output=document.querySelector<HTMLPreElement>('#result')!,run=document.querySelector<HTMLButtonElement>('#run')!;
 const energy=(values:Float32Array)=>values.reduce((sum,v)=>sum+v*v,0);
 async function sample(position:Vec,origin:Vec,yaw=0,local=false){
  const ctx=new OfflineAudioContext(2,48000,48000),sound=new Sound();
  sound.ctx=ctx as unknown as AudioContext;sound.master=ctx.createGain();sound.master.connect(ctx.destination);
  sound.updateListener(position,yaw);sound.shot({actor:1,position:origin,local,faction:'russian'});
  const rendered=await ctx.startRendering(),left=energy(rendered.getChannelData(0)),right=energy(rendered.getChannelData(1));
  return{left,right,balanceDb:10*Math.log10((right+1e-15)/(left+1e-15)),levelDb:10*Math.log10((left+right)/rendered.length)};
 }
 run.onclick=async()=>{
  run.disabled=true;output.textContent='Rendering…';
  try{
   const eye={x:0,y:5,z:0},right={x:-3,y:5,z:0},left={x:3,y:5,z:0},box=BOXES[0];
   const cases={right:await sample(eye,right),left:await sample(eye,left),turned:await sample(eye,right,Math.PI),near:await sample(eye,{x:0,y:5,z:3}),far:await sample(eye,{x:0,y:5,z:12}),follow:await sample(eye,right,0,true),
    covered:await sample({x:box.x-box.w/2-1,y:1,z:box.z},{x:box.x+box.w/2+1,y:1,z:box.z}),
    clear:await sample({x:box.x-box.w/2-1,y:5,z:box.z},{x:box.x+box.w/2+1,y:5,z:box.z})};
   const checks={rightChannel:cases.right.balanceDb>3,leftChannel:cases.left.balanceDb< -3,rotation:cases.turned.balanceDb< -3,distance:cases.far.levelDb<cases.near.levelDb-5,firstPersonCentered:Math.abs(cases.follow.balanceDb)<.1,coverQuieter:cases.covered.levelDb<cases.clear.levelDb-5};
   const pass=Object.values(checks).every(Boolean);
   output.textContent=JSON.stringify({pass,checks,cases},(_key,value)=>typeof value==='number'?Math.round(value*100)/100:value,2);
  }catch(error){output.textContent=String(error);}finally{run.disabled=false;}
 };
 const live=new Sound();let review:HTMLAudioElement|null=null,stopReview:number|undefined;
 const stop=()=>{live.resetScene();review?.pause();clearTimeout(stopReview);};
 for(const button of document.querySelectorAll<HTMLButtonElement>('[data-rifle]'))button.onclick=()=>{stop();live.init();live.shot({actor:0,position:{x:0,y:0,z:0},local:true,faction:button.dataset.rifle as Faction} satisfies SoundEmitter);};
 for(const button of document.querySelectorAll<HTMLButtonElement>('[data-combat]'))button.onclick=()=>{
  stop();live.init();const emitter={actor:0,position:{x:0,y:0,z:0},local:true};
  if(button.dataset.combat==='swing')live.melee(emitter);else live.impact(emitter,button.dataset.combat==='melee-impact'?'melee':'shot');
 };
 // These ignored analysis recordings/baselines exist only in the local workspace.
 // Neither the development page nor these media files is included in the Vite production build.
 for(const button of document.querySelectorAll<HTMLButtonElement>('[data-before]'))button.onclick=()=>{stop();review=new Audio(`/artifacts/audio-reference/before-spectrogram/${button.dataset.before}-synth.wav`);review.volume=.6;void review.play().catch(error=>output.textContent=String(error));};
 for(const button of document.querySelectorAll<HTMLButtonElement>('[data-reference]'))button.onclick=()=>{
  stop();const player=review=new Audio('/artifacts/audio-reference/firing.webm');player.volume=.6;
  player.onloadedmetadata=()=>{player.currentTime=Number(button.dataset.reference)-.015;};
  player.onseeked=()=>{player.onseeked=null;void player.play().then(()=>{stopReview=window.setTimeout(()=>player.pause(),465);}).catch(error=>output.textContent=String(error));};
 };
}
