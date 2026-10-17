/** A cycle contains two alternating contacts. Distances are metres and phase
 * is unwrapped cycles. Keep this small numerical model mirrored in sim.rs and
 * hitbox_motion.rs so rendering, rewind and authoritative hitboxes agree. */
const mix=(a:number,b:number,t:number)=>a+(b-a)*t;
const ease=(v:number)=>{const t=Math.max(0,Math.min(1,v));return t*t*(3-2*t);};
// Cubic Hermite segments keep velocity continuous while bounding the swing.
function curve(t:number,a:number,b:number,va:number,vb:number){
 return (2*t*t*t-3*t*t+1)*a+(t*t*t-2*t*t+t)*va+(-2*t*t*t+3*t*t)*b+(t*t*t-t*t)*vb;
}
export function gaitRate(speed:number,crouch:number,prone:number){
 const stride=mix(mix(1.40,2.95,ease((speed-1.8)/3)),1.35,crouch);
 const distance=mix(stride,1.10,prone)*Math.max(0,speed)/Math.hypot(speed,.4);
 return distance>0?Math.min(mix(mix(1.75,1.60,crouch),1.20,prone),speed/distance):0;
}
export function groundGait(speed:number,crouch:number,phase:number,forward:number,sideways:number){
 const run=ease((speed-1.8)/1.3)*(1-crouch),moving=ease(speed/.65);
 const rate=gaitRate(speed,crouch,0),distance=rate>0?speed/rate:0;
 const duty=Math.min(mix(mix(.54,.24,run),.64,crouch),distance>0?mix(1.05,.88,crouch)/distance:1),span=distance*duty;
 const length=Math.hypot(forward,sideways),f=length>1e-6?forward/length:1,s=length>1e-6?sideways/length:0;
 // Turn the hips into a sidestep, keeping the chest free to aim. Backpedalling
 // still bends the knees forwards. Separate foot lanes prevent scissoring.
 const heading=Math.atan2(s,Math.abs(f))*.70,cos=Math.cos(heading),sin=Math.sin(heading);
 const width=mix(.13,.18,crouch),sway=-Math.cos((phase-duty/2)*Math.PI*2)*.018*moving;
 const foot=(side:number)=>{
  const p=((phase+(side>0?.5:0))%1+1)%1,swing=(p-duty)/(1-duty);
  // During support, d(localFoot)/dt = -velocity. The planted sole is therefore
  // stationary in world space. Swing matches this velocity at BOTH endpoints,
  // avoiding the old stop/reverse snap at touchdown and toe-off.
  // The old single cubic overshot by ~16cm at each end of a run and kept
  // the heel low behind the body. Recover the heel promptly, then bring the
  // foot down under the advancing knee before the next contact.
  const turnaround=.045,back=span/2+distance*.018,front=span/2+distance*.012;
  const velocity=-distance*(1-duty);
  const travel=p<duty?span/2-distance*p:swing<turnaround?
   curve(swing/turnaround,-span/2,-back,velocity*turnaround,0):swing<1-turnaround?
   curve((swing-turnaround)/(1-2*turnaround),-back,front,0,0):
   curve((swing-1+turnaround)/turnaround,front,span/2,0,velocity*turnaround);
  const peak=mix(.45,.28,run),arch=p<duty?0:swing<peak?Math.sin(Math.PI*.5*swing/peak)**2:Math.cos(Math.PI*.5*(swing-peak)/(1-peak))**2;
  const lift=arch*mix(.07,.25,run)*(1-crouch*.35)*moving;
  const pitch=p<duty?0:arch*mix(.25,.95,run)*moving;
  return {position:[side*width*cos+travel*s,lift,-side*width*sin+travel*f] as [number,number,number],rotation:[pitch,heading+side*.06,0] as [number,number,number],support:p<duty};
 };
 // Lower the hips for the stance reach before adding a small weight-transfer
 // bob. A long stride must bend at the knee, never stretch the leg or drag it.
 // All imported uniforms share a .420m thigh, .415m shin and hip joints
 // .090m above the pelvis control. Use those proportions, retaining a small
 // extension reserve; the old .70m reach held every model in a deep squat.
 const reach=Math.sqrt(Math.max(.10,.817**2-(span/2)**2));
 const height=mix(Math.min(.825,.095+reach-.09),.43,crouch);
 // Walking rises over the support leg; running compresses it under load and
 // rises in flight. Using the same bob for both reverses the sense of weight.
 const bounce=mix((1-Math.cos(phase*Math.PI*4))*.022,(1-Math.cos((phase-duty/2)*Math.PI*4))*.012,run)*moving;
 return {left:foot(-1),right:foot(1),heading,duty,run,moving,
  pelvis:[sway*cos,height+bounce,-.07*crouch-sway*sin] as [number,number,number],
  pelvisRotation:[0,heading,0] as [number,number,number],
  spineRotation:[mix(.04+.12*run,.27,crouch),-heading,0] as [number,number,number]};
}

/** Emit only newly crossed touchdown phases, never a backlog on reset/rewind. */
export function crossedFootContact(before:number,after:number){
 return after>before&&after-before<.5&&Math.floor((after+1e-9)*2)>Math.floor((before+1e-9)*2);
}
