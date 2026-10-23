import type {UI} from './ui';

export interface PreparedGame {
 start:()=>void;
 multiplayer:()=>void;
 selectLoadout:()=>void;
 selectSpectator:()=>void;
 cancelSelection:()=>void;
}

/** Resume in a new task after the browser has painted the usable menu. */
export function afterMenuPaint():Promise<void>{
 if(typeof requestAnimationFrame==='undefined')return Promise.resolve();
 return new Promise(resolve=>requestAnimationFrame(()=>setTimeout(resolve,0)));
}

/** Menu actions stay live while the optional runtime and required arena assets
 * load. A team choice waits for preparation; cancelling never starts a game. */
export async function startBackgroundGame(ui:UI,load:()=>Promise<PreparedGame>,afterPaint=afterMenuPaint):Promise<PreparedGame>{
 let mode:'singleplayer'|'multiplayer'|null=null,choice:'loadout'|'spectator'|null=null;
 const back=()=>{mode=null;choice=null;ui.showMenu();};
 ui.start=()=>{mode='singleplayer';choice=null;ui.openSelection();};
 ui.multiplayer=()=>{mode='multiplayer';choice=null;ui.showLobbies([],'Preparing arena…');};
 const choose=(next:typeof choice)=>{if(mode!=='singleplayer')return;choice=next;ui.setSelectionBusy(true);ui.setSelectionStatus('Preparing arena…');};
 ui.selectLoadout=()=>choose('loadout');ui.selectSpectator=()=>choose('spectator');
 ui.cancelSelection=back;ui.lobbyBack=back;
 ui.setReady(true,false);
 ui.setStartupProgress(0);
 const keyboard=(event:KeyboardEvent)=>{
  if(ui.modalOpen){ui.handleModalKey(event);if(event.code==='Escape')ui.closeModal();return;}
  if((event.target as HTMLElement)?.matches?.('input,textarea,select'))return;
  ui.handleMenuKey(event);
 };
 document.addEventListener('keydown',keyboard);
 try{
  await afterPaint();
  const game=await load();
  ui.setStartupProgress(null);
  if(mode==='singleplayer'&&ui.selectionOpen){
   // If preparation wins the race, keep the current team/options view in place
   // until the visitor chooses. Only that gesture begins the offline session.
   const restore=()=>{ui.selectLoadout=game.selectLoadout;ui.selectSpectator=game.selectSpectator;ui.cancelSelection=game.cancelSelection;};
   const enter=(spectator:boolean)=>{restore();game.start();if(spectator)game.selectSpectator();else game.selectLoadout();};
   if(choice)enter(choice==='spectator');
   else{
    ui.selectLoadout=()=>enter(false);ui.selectSpectator=()=>enter(true);
    ui.cancelSelection=()=>{restore();ui.showMenu();};
    ui.start=()=>{restore();game.start();};
   }
  }else if(mode==='multiplayer'&&ui.lobbyOpen)game.multiplayer();
  return game;
 }catch(error){
  ui.setStartupProgress(null);ui.hideLoading();
  if(ui.el['load-error'].classList.contains('hidden')){
   ui.el['load-error'].classList.remove('hidden');
   ui.el['load-error'].innerHTML='<div class="dialog"><h2>Unable to prepare game</h2><button class="start-button" onclick="location.reload()">Retry</button></div>';
  }
  throw error;
 }finally{document.removeEventListener('keydown',keyboard);}
}
