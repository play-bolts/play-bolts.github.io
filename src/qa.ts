import type {Game} from './engine';
import {ARENA,HEIGHTS} from './config';

/** Imported only by the development build when ?qa=1 is explicitly requested. */
export function mountQA(game:Game,setLean:(value:number|null)=>void){
 const panel=document.createElement('details');panel.open=true;panel.id='dev-qa';
 panel.style.cssText='position:fixed;top:8px;left:8px;z-index:9999;max-width:270px;padding:8px;background:#101010e8;border:1px solid #aaa;color:white;font:12px monospace;pointer-events:auto';
 const title=document.createElement('summary');title.textContent='DEV QA';panel.append(title);
 const buttons=document.createElement('div');buttons.style.cssText='display:flex;gap:5px;flex-wrap:wrap;margin-top:7px';panel.append(buttons);
 const status=document.createElement('div');status.textContent='Start a round using the normal menu.';status.style.cssText='margin-top:7px;font-size:10px';panel.append(status);
 const opponent=()=>game.actors.find(actor=>actor.id>0&&actor.alive)??game.actors[1];
 function add(label:string,action:()=>void){
  const button=document.createElement('button');button.type='button';button.textContent=label;
  button.style.cssText='padding:4px 6px;color:white;background:#303030;border:1px solid #777;font:11px monospace';
  button.onclick=()=>{if(!game.player||game.state==='menu'||game.state==='ended'){status.textContent='Start a round first.';return;}
   // Releasing pointer lock pauses the game; a QA action resumes the existing round.
   if(game.state==='paused')game.state=game.player.alive||game.player.spectator?'playing':'killcam';
   action();status.textContent=label+' · '+game.state;button.blur();};
  buttons.append(button);
 }
 add('Player kill',()=>{const bot=opponent();if(bot&&game.player.alive)game.damage(bot,game.player,100);});
 add('Melee kill',()=>{const bot=opponent();if(bot&&game.player.alive)game.damage(bot,game.player,100,false,'melee');});
 add('Killcam',()=>{const bot=opponent();if(bot&&game.player.alive)game.damage(game.player,bot,100);});
 add('Lean left',()=>setLean(-1));add('Lean right',()=>setLean(1));add('Lean center',()=>setLean(0));add('Lean keys',()=>setLean(null));
 for(const corner of [false,true])add(corner?'Corner lean':'Wall lean',()=>{
  if(game.player.spectator)return;
  Object.assign(game.player,{x:-ARENA.width/2+.31,y:0,z:corner?-ARENA.depth/2+.31:0,yaw:corner?-Math.PI/4:0,pitch:0,stance:'stand',eyeHeight:HEIGHTS.stand,lean:0,vy:0,moving:0,ads:false,grounded:true,spawnSafe:600});
  setLean(1);
 });
 add('Damage 25',()=>{const bot=opponent();if(bot&&game.player.alive){game.damage(game.player,bot,25);game.player.spawnSafe=30;}});
 add('Quiet arena',()=>{for(const bot of game.actors.slice(1)){bot.alive=false;bot.deadAt=game.time+600;bot.y=-10;}game.player.spawnSafe=600;});
 add('Finish round',()=>game.finish());
 add('Reload',()=>{game.player.ammo=1;game.reload();});
 add('Melee',()=>game.fire(game.player,true));
 document.body.append(panel);
}
