/** Protocol-v3 controls for input-only integration probes. Each held intent
 * becomes distinct fixed-step commands; actions are emitted exactly once.
 * The short intent lease makes a stalled test driver release its controls. */
export class TestInputStream {
 constructor(send,actor){this.send=send;this.actor=actor;this.seq=0;this.tick=0;this.generation=undefined;this.epoch=undefined;this.intent={};this.until=0;this.frame=null;this.at=0;this.timer=null;}
 observe(frame){
  this.frame=frame;this.at=performance.now();
  const actor=this.actor();if(!actor)return;
  this.seq=Math.max(this.seq,actor.ack);
  const epoch=`${frame.lobbyId??''}:${frame.roundNumber}:${actor.id}:${actor.spawnGeneration}`;
  if(this.epoch!==epoch){this.epoch=epoch;this.generation=actor.spawnGeneration;this.tick=0;this.until=0;this.intent={};}
 }
 input(intent={}){
  this.intent={forward:0,right:0,jump:false,walk:false,lean:0,yaw:this.actor()?.yaw??0,pitch:0,ads:false,fire:false,reload:false,melee:false,...intent};
  this.until=performance.now()+250;
  const message=this.emit(true);
  if(!this.timer){this.timer=setInterval(()=>this.emit(false),1000/60);this.timer.unref();}
  return message;
 }
 emit(explicit){
  const actor=this.actor();if(!actor||!this.frame)return;
  const now=performance.now(),horizon=this.frame.tick+Math.ceil((now-this.at+(actor.ping??50))/(1000/60))+3;
  if(!explicit&&(this.frame.ended||!actor.alive||actor.spectator||this.tick>=horizon+3))return;
  this.tick=Math.max(this.tick+1,horizon);
  const active=now<this.until,held=active?this.intent:{yaw:actor.yaw,pitch:actor.pitch,stance:actor.stance,weapon:actor.selectedWeapon};
  const message={type:'input',seq:++this.seq,tick:this.tick,generation:actor.spawnGeneration,forward:0,right:0,jump:false,walk:false,lean:0,yaw:actor.yaw,pitch:actor.pitch,ads:false,stance:actor.stance,weapon:actor.selectedWeapon,shotTime:0,fire:false,reload:false,melee:false,...held};
  if(!explicit){message.jump=false;message.fire=false;message.reload=false;message.melee=false;message.shotTime=0;}
  this.send(message);return message;
 }
 close(){clearInterval(this.timer);this.timer=null;this.until=0;this.frame=null;this.epoch=undefined;this.tick=0;this.intent={};}
}
