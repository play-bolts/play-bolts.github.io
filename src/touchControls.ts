type TouchSurfaces={move:HTMLElement;fire:HTMLElement;look:HTMLElement};
type TouchCallbacks={look:(dx:number,dy:number)=>void;fire:()=>void;fireReleased?:(cancelled:boolean)=>void;jump?:()=>void;reset:()=>void};
type Stick={element:HTMLElement;pointer:number|null;x:number;y:number};
type Drag={element:HTMLElement;pointer:number|null;x:number;y:number};
const MOVE_TAP_MS=250,MOVE_TAP_SLOP=10;

/** Touch input stays independent of mouse capture and keeps one owner per surface. */
export class TouchControls {
 private enabled=false;
 private sensitivity=1;
 private move:Stick;
 private fire:Drag;
 private look:Drag;
 private moveTap:{x:number;y:number;started:number}|null=null;

 constructor(private elements:TouchSurfaces,private callbacks:TouchCallbacks){
  this.move={element:elements.move,pointer:null,x:0,y:0};
  this.fire={element:elements.fire,pointer:null,x:0,y:0};
  this.look={element:elements.look,pointer:null,x:0,y:0};
  this.bindMove();this.bindDrag(this.fire,true);this.bindDrag(this.look,false);
  this.renderStick(this.move);this.renderFire();
 }

 get movement(){return {forward:this.move.y===0?0:-this.move.y,right:this.move.x};}

 setEnabled(enabled:boolean){if(this.enabled===enabled)return;this.enabled=enabled;if(!enabled)this.clear();}
 setSensitivity(value:number){if(Number.isFinite(value)&&value>0)this.sensitivity=value;}

 /** Called for menus, rotation, blur, death and other interruptions. */
 clear(){
  const movePointer=this.move.pointer,firePointer=this.fire.pointer,lookPointer=this.look.pointer;
  const hadInput=movePointer!==null||firePointer!==null||lookPointer!==null;
  // Forget ownership first: releasing capture may synchronously dispatch loss.
  this.move.pointer=null;this.fire.pointer=null;this.look.pointer=null;this.moveTap=null;
  this.move.x=0;this.move.y=0;
  this.renderStick(this.move);this.renderFire();
  if(movePointer!==null)this.release(this.move.element,movePointer);
  if(firePointer!==null)this.release(this.fire.element,firePointer);
  if(lookPointer!==null)this.release(this.elements.look,lookPointer);
  if(firePointer!==null)this.callbacks.fireReleased?.(true);
  if(hadInput)this.callbacks.reset();
 }

 private accepts(event:PointerEvent){return this.enabled&&(event.pointerType==='touch'||event.pointerType==='pen');}
 private owns(pointer:number){return this.move.pointer===pointer||this.fire.pointer===pointer||this.look.pointer===pointer;}
 private consume(event:PointerEvent){event.preventDefault();event.stopPropagation();}
 private capture(element:HTMLElement,pointer:number){try{element.setPointerCapture(pointer);}catch{/* Capture can race with an interrupted touch. */}}
 private release(element:HTMLElement,pointer:number){try{if(element.hasPointerCapture(pointer))element.releasePointerCapture(pointer);}catch{/* The browser may already have cancelled it. */}}

 /** A fire press shoots once; dragging either surface only moves the camera. */
 private bindDrag(drag:Drag,shoot:boolean){
  drag.element.addEventListener('pointerdown',event=>{
   if(!this.accepts(event)||drag.pointer!==null||this.owns(event.pointerId))return;
   this.consume(event);drag.pointer=event.pointerId;drag.x=event.clientX;drag.y=event.clientY;
   this.capture(drag.element,event.pointerId);
   if(shoot){this.renderFire();this.callbacks.fire();}
  },{passive:false});
  drag.element.addEventListener('pointermove',event=>{
   if(event.pointerId!==drag.pointer)return;
   this.consume(event);
   const dx=(event.clientX-drag.x)*this.sensitivity,dy=(event.clientY-drag.y)*this.sensitivity;
   drag.x=event.clientX;drag.y=event.clientY;
   if(dx!==0||dy!==0)this.callbacks.look(dx,dy);
  },{passive:false});
  const end=(event:PointerEvent)=>{
   if(event.pointerId!==drag.pointer)return;
   this.consume(event);drag.pointer=null;
   if(shoot)this.renderFire();
   this.release(drag.element,event.pointerId);
   if(shoot)this.callbacks.fireReleased?.(event.type!=='pointerup');
  };
  for(const type of ['pointerup','pointercancel','lostpointercapture'])drag.element.addEventListener(type,end as EventListener,{passive:false});
 }

 private bindMove(){
  const stick=this.move;
  stick.element.addEventListener('pointerdown',event=>{
   if(!this.accepts(event)||stick.pointer!==null||this.owns(event.pointerId))return;
   this.consume(event);stick.pointer=event.pointerId;this.positionStick(stick,event);this.capture(stick.element,event.pointerId);
   this.moveTap={x:event.clientX,y:event.clientY,started:event.timeStamp};
  },{passive:false});
  stick.element.addEventListener('pointermove',event=>{
   if(event.pointerId!==stick.pointer)return;
   this.checkMoveTap(event);
   this.consume(event);this.positionStick(stick,event);
  },{passive:false});
  const end=(event:PointerEvent)=>{
   if(event.pointerId!==stick.pointer)return;
   this.checkMoveTap(event);
   const elapsed=this.moveTap?event.timeStamp-this.moveTap.started:Infinity;
   const jump=event.type==='pointerup'&&elapsed>=0&&elapsed<=MOVE_TAP_MS;
   this.moveTap=null;
   this.consume(event);stick.pointer=null;stick.x=0;stick.y=0;
   this.renderStick(stick);this.release(stick.element,event.pointerId);
   if(jump)this.callbacks.jump?.();
  };
  for(const type of ['pointerup','pointercancel','lostpointercapture'])stick.element.addEventListener(type,end as EventListener,{passive:false});
 }

 private checkMoveTap(event:PointerEvent){
  // A drag that returns to its starting point is still movement, not a tap.
  if(this.moveTap&&Math.hypot(event.clientX-this.moveTap.x,event.clientY-this.moveTap.y)>MOVE_TAP_SLOP)this.moveTap=null;
 }

 private positionStick(stick:Stick,event:PointerEvent){
  const bounds=stick.element.getBoundingClientRect(),radius=Math.max(1,Math.min(bounds.width,bounds.height)*.4);
  const dx=(event.clientX-bounds.left-bounds.width/2)/radius,dy=(event.clientY-bounds.top-bounds.height/2)/radius;
  const distance=Math.hypot(dx,dy),strength=Math.max(0,Math.min(1,(distance-.12)/.88));
  stick.x=distance>0?dx/distance*strength:0;stick.y=distance>0?dy/distance*strength:0;
  this.renderStick(stick);
 }

 private renderStick(stick:Stick){
  const bounds=stick.element.getBoundingClientRect(),radius=Math.max(1,Math.min(bounds.width,bounds.height)*.4);
  stick.element.style.setProperty('--stick-x',`${stick.x*radius}px`);
  stick.element.style.setProperty('--stick-y',`${stick.y*radius}px`);
  stick.element.classList.toggle('active',stick.pointer!==null);
  stick.element.dataset.active=String(stick.pointer!==null);
 }

 private renderFire(){
  this.fire.element.classList.toggle('active',this.fire.pointer!==null);
  this.fire.element.dataset.active=String(this.fire.pointer!==null);
 }
}
