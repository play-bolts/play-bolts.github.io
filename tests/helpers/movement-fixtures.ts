import {Game,createActor,type Actor} from '../../src/engine.ts';
import {advanceLean} from '../../src/lean.ts';
import type {NetworkInput} from '../../src/network.ts';

export interface MovementInput {id:number;input:Partial<NetworkInput>}
export interface MovementSegment {ticks:number;inputs:MovementInput[];expected?:Record<string,unknown>[]}
export interface MovementFixture {name:string;actors:Record<string,unknown>[];segments:MovementSegment[]}
export const movementFields=['id','x','y','z','vy','eyeHeight','moving','lean','stance','grounded','ads'] as const;
export function fixtureGame(fixture:MovementFixture){
 const game=new Game();game.state='playing';game.actors=fixture.actors.map(a=>Object.assign(createActor(a.id as number,'british','Fixture'),structuredClone(a))).sort((a,b)=>a.id-b.id);return game;
}
export function movementStep(game:Game,inputs:MovementInput[]){
 const dt=1/60;game.time+=dt;
 for(const actor of game.actors){
  const input=inputs.find(row=>row.id===actor.id)?.input??{};
  actor.stance=input.stance??actor.stance;actor.yaw=input.yaw??actor.yaw;actor.pitch=input.pitch??actor.pitch;
  actor.ads=!!input.ads&&game.canADS(actor);
  const forward=input.forward??0,right=input.right??0,length=Math.max(1,Math.hypot(forward,right)),walk=input.walk?.55:1;
  const f=forward/length,r=right/length;
  game.move(actor,(Math.sin(actor.yaw)*f-Math.cos(actor.yaw)*r)*walk,(Math.cos(actor.yaw)*f+Math.sin(actor.yaw)*r)*walk,dt,input.jump);
  actor.lean=advanceLean(actor,input.lean??0,dt);
 }
}
export function movementState(actors:Actor[]){return actors.map(a=>({...Object.fromEntries(movementFields.map(key=>[key,a[key]])),pose:a.pose?{...a.pose}:undefined}));}
