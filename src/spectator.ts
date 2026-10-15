import {ARENA,clamp,type Vec} from './config';
import type {Actor} from './engine';
import {leanEye} from './lean';

export interface FlightInput {forward:number;right:number;up:number;fast:boolean}
type CameraActor=Pick<Actor,'x'|'y'|'z'|'yaw'|'pitch'|'recoil'|'lean'|'eyeHeight'>;
const eye=leanEye;
/** Camera state never occupies an actor or enters authoritative movement input. */
export class SpectatorCamera {
 position:Vec={x:0,y:3,z:0};yaw=0;pitch=0;targetId:number|null=null;
 private exitSource:'key'|'unlock'|null=null;private exitedAt=-Infinity;
 get following(){return this.targetId!==null;}
 target(actors:readonly Actor[]){return actors.find(actor=>actor.id===this.targetId&&actor.alive&&!actor.spectator)??null;}
 reset(){this.exitSource=null;this.exitedAt=-Infinity;this.targetId=null;this.position={x:0,y:3,z:0};this.yaw=this.pitch=0;}
 enter(actor:CameraActor){this.targetId=null;this.position=eye(actor);this.yaw=actor.yaw;this.pitch=clamp(actor.pitch+actor.recoil,-1.43,1.43);}
 free(actors:readonly Actor[]){const actor=actors.find(actor=>actor.id===this.targetId);if(actor)this.enter(actor);else this.targetId=null;}
 /** Browsers may deliver Escape key and pointer-unlock in either order. */
 handleExit(source:'key'|'unlock',now:number,actors:readonly Actor[]){
  if(this.following){this.free(actors);this.exitSource=source;this.exitedAt=now;return true;}
  if(this.exitSource&&this.exitSource!==source&&now-this.exitedAt<300){this.exitSource=null;return true;}
  return false;
 }
 cycle(actors:readonly Actor[],direction:1|-1){
  const candidates=actors.filter(actor=>actor.alive&&!actor.spectator).sort((a,b)=>a.id-b.id);
  if(!candidates.length){this.free(actors);return null;}
  const current=this.targetId;
  const next=direction===1?(candidates.find(actor=>current===null||actor.id>current)??candidates[0]):([ ...candidates].reverse().find(actor=>current===null||actor.id<current)??candidates.at(-1)!);
  this.targetId=next.id;this.position=eye(next);this.yaw=next.yaw;this.pitch=clamp(next.pitch+next.recoil,-1.43,1.43);return next;
 }
 sync(actors:readonly Actor[]){
  if(this.targetId===null)return;
  const actor=this.target(actors);
  if(actor){this.position=eye(actor);this.yaw=actor.yaw;this.pitch=clamp(actor.pitch+actor.recoil,-1.43,1.43);}
  else this.cycle(actors,1);
 }
 /** Server IDs are stable; renderer IDs are compact indexes and may change. */
 remap(oldIds:readonly number[],newIds:readonly number[],actors:readonly Actor[]){
  if(this.targetId===null)return;const key=oldIds[this.targetId],index=newIds.indexOf(key);
  if(index>=0){this.targetId=index;this.sync(actors);return;}
  const candidates=newIds.map((id,index)=>({id,actor:actors[index]})).filter(({actor})=>actor?.alive&&!actor.spectator).sort((a,b)=>a.id-b.id);
  const next=candidates.find(candidate=>candidate.id>key)??candidates[0];this.targetId=next?.actor.id??null;this.sync(actors);
 }
 look(dx:number,dy:number){if(this.following)return;this.yaw+=dx;this.pitch=clamp(this.pitch+dy,-1.43,1.43);}
 move(dt:number,input:FlightInput){
  if(this.following)return;
  const cp=Math.cos(this.pitch),sp=Math.sin(this.pitch),sy=Math.sin(this.yaw),cy=Math.cos(this.yaw);
  const x=sy*cp*input.forward-cy*input.right,y=sp*input.forward+input.up,z=cy*cp*input.forward+sy*input.right;
  const length=Math.max(1,Math.hypot(x,y,z)),step=Math.max(0,Math.min(dt,.1))*(input.fast?16:7)/length;
  this.position.x=clamp(this.position.x+x*step,-ARENA.width/2-8,ARENA.width/2+8);
  this.position.y=clamp(this.position.y+y*step,.15,24);
  this.position.z=clamp(this.position.z+z*step,-ARENA.depth/2-8,ARENA.depth/2+8);
 }
}
