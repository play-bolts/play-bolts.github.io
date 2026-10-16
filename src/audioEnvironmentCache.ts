import type {Vec} from './config';
import {soundEnvironment} from './audioSpatial';

const UNOBSTRUCTED={gain:1,cutoff:20000};
type Environment={gain:number;cutoff:number};
type Entry={x:number;y:number;z:number;environment:Environment};
/** All concurrent/scheduled voices of one actor share the same cover raycast. */
export class AudioEnvironmentCache {
 private listener:Vec={x:0,y:0,z:0};
 private entries=new Map<number,Entry>();
 constructor(private compute:(origin:Vec,listener:Vec)=>Environment=soundEnvironment){}
 setListener(position:Vec){
  const last=this.listener;if(last.x===position.x&&last.y===position.y&&last.z===position.z)return;
  last.x=position.x;last.y=position.y;last.z=position.z;this.entries.clear();
 }
 get(actor:number,position:Vec,local:boolean):Environment{
  if(local)return UNOBSTRUCTED;
  const entry=this.entries.get(actor);
  if(entry&&entry.x===position.x&&entry.y===position.y&&entry.z===position.z)return entry.environment;
  const environment=this.compute(position,this.listener);
  this.entries.set(actor,{x:position.x,y:position.y,z:position.z,environment});return environment;
 }
 delete(actor:number){this.entries.delete(actor);}
 clear(){this.entries.clear();}
}
