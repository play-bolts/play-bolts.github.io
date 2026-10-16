interface CaptureTarget {requestPointerLock():Promise<void>|void}
interface CaptureDocument {readonly pointerLockElement:unknown;exitPointerLock():void}

/** Capture failure is temporary: every fresh click can retry, including after
 * an asynchronous join or the browser's Escape-unlock cooldown. */
export class PointerCapture {
 fallback=false;
 private wanted=false;private wasLocked=false;private attempt=0;
 constructor(private target:CaptureTarget,private document:CaptureDocument){}
 get locked(){return this.document.pointerLockElement===this.target;}
 request(){
  this.wanted=true;this.wasLocked=this.locked;const attempt=++this.attempt;
  if(this.locked){this.wasLocked=true;this.fallback=false;return;}
  const failed=()=>{if(attempt===this.attempt)this.error();};
  try{const pending=this.target.requestPointerLock();if(pending)void pending.catch(failed);}catch{failed();}
 }
 /** Also handles browsers that report failure only via pointerlockerror. */
 error(){if(this.wanted&&!this.locked)this.fallback=true;}
 /** Returns true only for an unexpected loss of this canvas's capture. */
 changed(){
  const locked=this.locked,lost=this.wasLocked&&!locked&&this.wanted;this.wasLocked=locked;
  if(locked){
   // A pending request can finish after chat, a menu, or tab blur released it.
   if(!this.wanted){this.document.exitPointerLock();return false;}
   this.attempt++;this.fallback=false;
  }
  return lost;
 }
 release(){this.wanted=false;this.attempt++;this.fallback=false;if(this.locked)this.document.exitPointerLock();}
}
