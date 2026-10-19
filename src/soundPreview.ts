export type PreviewState={phase:'idle'|'loading'|'playing'|'error';id?:string;label?:string};
export type PreviewLoad=(context:AudioContext,signal:AbortSignal)=>AudioBuffer|Promise<AudioBuffer>;

/** Owns only review playback. A stopped fetch/decode can never revive a sample. */
export class SoundPreviewPlayer {
 private context:AudioContext|null=null;
 private master:GainNode|null=null;
 private source:AudioBufferSourceNode|null=null;
 private request:AbortController|null=null;
 private generation=0;
 constructor(private volume:()=>number,private changed:(state:PreviewState)=>void,private createContext:()=>AudioContext=()=>new AudioContext()){}
 stop(){
  this.generation++;this.request?.abort();this.request=null;
  const source=this.source;this.source=null;
  if(source){source.onended=null;try{source.stop();}catch{}source.disconnect();}
  this.changed({phase:'idle'});
 }
 refreshVolume(){if(this.master){const value=this.volume();this.master.gain.value=Number.isFinite(value)?Math.max(0,Math.min(1,value)):0;}}
 async play(id:string,label:string,load:PreviewLoad){
  this.stop();const generation=this.generation,request=this.request=new AbortController();
  const current=()=>generation===this.generation&&!request.signal.aborted;
  this.changed({phase:'loading',id,label});
  try{
   const context=this.context??=this.createContext();
   if(!this.master){this.master=context.createGain();this.master.connect(context.destination);}
   this.refreshVolume();await context.resume();if(!current())return;
   const buffer=await load(context,request.signal);if(!current())return;
   const source=this.source=context.createBufferSource();source.buffer=buffer;source.connect(this.master);
   source.onended=()=>{if(!current()||this.source!==source)return;source.disconnect();this.source=null;this.request=null;this.changed({phase:'idle'});};
   source.start();this.changed({phase:'playing',id,label});
  }catch{
   if(!current())return;
   this.request=null;const source=this.source;this.source=null;
   if(source){source.onended=null;try{source.stop();}catch{}source.disconnect();}
   this.changed({phase:'error',id,label});
  }
 }
}

export function previewBuffer(context:AudioContext,samples:Float32Array,gain=1):AudioBuffer {
 const buffer=context.createBuffer(1,samples.length,context.sampleRate),output=buffer.getChannelData(0);
 for(let i=0;i<samples.length;i++)output[i]=samples[i]*gain;
 return buffer;
}

export async function loadPreviewFile(context:AudioContext,file:string,signal:AbortSignal):Promise<AudioBuffer> {
 const response=await fetch(file,{signal});if(!response.ok)throw new Error('Audio unavailable');
 const bytes=await response.arrayBuffer();if(signal.aborted)throw new Error('Preview cancelled');
 return context.decodeAudioData(bytes);
}
