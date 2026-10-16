import test from 'node:test';
import assert from 'node:assert/strict';
import {Game,createActor,type Input} from '../src/engine.ts';
import {ARENA,RULES} from '../src/config.ts';

const idle:Input={forward:0,right:0,jump:false,walk:false,lean:0};
const step=.1;
function move(input:Partial<Input>){
 const game=new Game(),player=createActor(0,'british','Touch player');
 Object.assign(player,{x:ARENA.width/2-1,z:0,yaw:0});game.actors=[player];game.state='playing';
 const start={x:player.x,z:player.z};game.update(step,{...idle,...input});
 return{game,player,x:player.x-start.x,z:player.z-start.z,distance:Math.hypot(player.x-start.x,player.z-start.z)};
}
const near=(actual:number,expected:number)=>assert.ok(Math.abs(actual-expected)<1e-9,`${actual} != ${expected}`);

test('offline analog movement preserves partial stick speed',()=>{
 const full=move({forward:1}),half=move({forward:.5}),quarter=move({forward:.25});
 near(full.distance,RULES.speed*step);near(half.distance,full.distance*.5);near(quarter.distance,full.distance*.25);
 near(move({right:.5}).distance,half.distance);
});

test('offline analog diagonals preserve magnitude below one and clamp at full speed',()=>{
 const partial=move({forward:.3,right:.4});
 near(partial.distance,RULES.speed*step*.5);near(partial.z,RULES.speed*step*.3);near(partial.x,-RULES.speed*step*.4);
 const diagonal=move({forward:1,right:1});near(diagonal.distance,RULES.speed*step);near(diagonal.z,-diagonal.x);
 near(move({forward:2}).distance,RULES.speed*step);
});

test('releasing the movement stick stops without residual movement',()=>{
 const {game,player}=move({forward:.5,right:.2}),position={x:player.x,z:player.z};
 game.update(step,idle);near(player.x,position.x);near(player.z,position.z);near(player.moving,0);
});
