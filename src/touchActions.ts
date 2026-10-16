type Press={x:number;y:number;endedAt:number|null};
const guards=new WeakMap<Document,ReturnType<typeof actionGuard>>();

/** Guard at the document because opening a menu may hide the pressed button. */
function actionGuard(document:Document){
 const presses=new Map<number,Press>();
 const consume=(event:Event)=>{event.preventDefault();event.stopImmediatePropagation();};
 const prune=()=>{const now=performance.now();for(const [id,press] of presses)if(press.endedAt!==null&&now-press.endedAt>800)presses.delete(id);};
 document.addEventListener('pointerdown',event=>{
  prune();
  // A real mouse press starts a new gesture; compatibility mouse events from
  // touch do not dispatch another pointerdown.
  if(event.pointerType==='mouse')presses.clear();
 },{capture:true,passive:false});
 const release=(event:PointerEvent)=>{
  const press=presses.get(event.pointerId);if(!press)return;
  press.x=event.clientX;press.y=event.clientY;press.endedAt=performance.now();consume(event);
 };
 document.addEventListener('pointerup',release,{capture:true,passive:false});
 document.addEventListener('pointercancel',release,{capture:true,passive:false});
 document.defaultView?.addEventListener('blur',()=>presses.clear());
 document.addEventListener('visibilitychange',()=>{if(document.hidden)presses.clear();});
 document.addEventListener('click',event=>{
  if(event.detail===0)return; // Keyboard and assistive-technology activation.
  prune();const pointer=event as PointerEvent;
  let id=presses.has(pointer.pointerId)?pointer.pointerId:undefined;
  if(id===undefined&&!pointer.pointerType){
   // Older Safari exposes the compatibility click as a MouseEvent. Match its
   // release position while preserving unrelated taps and mouse gestures.
   id=[...presses].find(([,press])=>press.endedAt!==null&&Math.hypot(event.clientX-press.x,event.clientY-press.y)<24)?.[0];
  }
  if(id===undefined)return;
  presses.delete(id);consume(event);
 },{capture:true,passive:false});
 return {
  begin(event:PointerEvent){
   const previous=presses.get(event.pointerId);if(previous?.endedAt===null)return false;
   presses.set(event.pointerId,{x:event.clientX,y:event.clientY,endedAt:null});return true;
  },
 };
}

/** Fire buttons on touch contact, including a second finger holding a stick. */
export function bindTouchAction(button:HTMLButtonElement,activate:()=>void){
 const document=button.ownerDocument;
 let guard=guards.get(document);if(!guard){guard=actionGuard(document);guards.set(document,guard);}
 const down=(event:PointerEvent)=>{
  if(button.disabled||(event.pointerType!=='touch'&&event.pointerType!=='pen')||event.button!==0)return;
  event.preventDefault();event.stopPropagation();
  if(!guard.begin(event))return;
  // Capture before activating: actions such as Menu can hide this button.
  try{button.setPointerCapture(event.pointerId);}catch{/* The page may have lost focus. */}
  activate();
 };
 const click=()=>{if(!button.disabled)activate();};
 button.addEventListener('pointerdown',down,{passive:false});
 button.addEventListener('click',click);
 return ()=>{button.removeEventListener('pointerdown',down);button.removeEventListener('click',click);};
}
