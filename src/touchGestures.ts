/** Gameplay already activates through pointer events. Cancel the native touch
 * completion as well, so Safari cannot turn rapid presses into page zoom.
 * Keep ownership until release even if a press opens a menu or the player dies. */
export function bindGameplayZoomGuard(root:HTMLElement,controls:HTMLElement){
 const gameplayTouches=new Set<number>();
 const start=(event:TouchEvent)=>{
  if(controls.classList.contains('hidden')&&!controls.contains(event.target as Node|null))return;
  for(const touch of Array.from(event.changedTouches))gameplayTouches.add(touch.identifier);
 };
 const forget=(event:TouchEvent)=>{
  let owned=false;
  for(const touch of Array.from(event.changedTouches))if(gameplayTouches.delete(touch.identifier))owned=true;
  return owned;
 };
 const end=(event:TouchEvent)=>{if(forget(event)&&event.cancelable)event.preventDefault();};
 root.addEventListener('touchstart',start,{capture:true,passive:true});
 root.addEventListener('touchend',end,{capture:true,passive:false});
 root.addEventListener('touchcancel',forget,{capture:true,passive:true});
 return ()=>{
  root.removeEventListener('touchstart',start,{capture:true});
  root.removeEventListener('touchend',end,{capture:true});
  root.removeEventListener('touchcancel',forget,{capture:true});
  gameplayTouches.clear();
 };
}
