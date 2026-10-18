import * as THREE from 'three';
import {MELEE_CONTACT_FRACTION,MELEE_SECONDS,type Faction} from './config';
import {poseAnatomicalHand,handContactLocal} from './hands';
import {sampleSourceMotion} from './humanoidMotion';
import {getImportedWeaponProfile,type ImportedWeaponProfile} from './importedWeapons';
import {poseViewmodelArm,solveViewmodelArm,defaultWeaponBodyMatrix,VIEWMODEL_HIP_POSITION,VIEWMODEL_GRENADE_POSITION,type ViewmodelArm} from './viewmodelArms';

export type WeaponAction='idle'|'cycle'|'reload'|'melee';
type Vector=[number,number,number];
type SupportCurls=Record<'index'|'middle'|'ring'|'pinky',Vector>;
type Key=[number,Vector];
export const MELEE_ANIMATION_SECONDS=MELEE_SECONDS;
export interface WeaponSwitchPose {
  position:Vector;rotation:Vector;item:'from'|'to';hidden:boolean;stage:string;
}
export interface GrenadePose {
  position:Vector;rotation:Vector;right:Vector;rightRotation:Vector;left:Vector;leftRotation:Vector;
  grenadePosition:Vector;grenadeRotation:Vector;grenadeVisible:boolean;leftVisible:boolean;stage:string;
}
export interface WeaponPose {
  position:Vector;rotation:Vector;right:Vector;rightRotation:Vector;
  left:Vector;leftRotation:Vector;rightElbow:Vector;leftElbow:Vector;boltLift:number;boltTravel:number;
  clipVisible:boolean;clipPosition:Vector;clipPress:number;fingerOpen:number;thumbContact:number;boltGrip:number;stage:string;
  boltOrigin:Vector;boltAxis:Vector;
  stockThumbTurn:number;
  stockThumbCurl?:Vector;
  /** Visual draw out of the sights; combat aim and shot direction are unchanged. */
  unshoulder?:number;
  /** The supporting elbow may open during the cross-body buttstock swing. */
  supportArmFreedom?:number;
  sourceSupportGrip:boolean;
  supportCurls?:SupportCurls;
  stockCurls?:SupportCurls;
}
const STOCK_GRIP:Record<Faction,Vector>={british:[-.003,-.085,-.180],russian:[-.004,-.085,-.180],german:[.001,-.089,-.180]};
// Source stock anchors describe the wood, while the existing hand contact is
// inside its curled fingers. These small fitted offsets and thumb adduction
// wrap the narrower acquired stocks without the legacy wide-stock thumbs-up.
const SOURCE_GRIP_FIT:Record<Faction,{offset:Vector;supportOffset:Vector;thumb:number}>={
  british:{offset:[.002,.006,-.005],supportOffset:[-.0019,.0239,.198],thumb:.304},
  russian:{offset:[0,-.010,.005],supportOffset:[.0022,-.0024,-.0095],thumb:-.172},
  german:{offset:[-.004,-.004,.003],supportOffset:[-.0023,.0249,.2246],thumb:.088},
};
// Pronation cups the source stock while the wrist exits rearward and slightly
// down, so the supporting sleeve follows the rifle instead of crossing the
// view. Each digit and broad palm pad are fitted to the actual source wood.
const SOURCE_SUPPORT_ROTATION:Record<Faction,Vector>={british:[1.1,1.3,-.9],russian:[.5,1.3,-.3],german:[1.07,1.34,-.92]};
const SOURCE_SUPPORT_CURL:Record<Faction,SupportCurls>={
  british:{index:[0,0,0],middle:[0,.18,0],ring:[0,1.24,.75],pinky:[1.55,.5,.14]},
  russian:{index:[0,.55,0],middle:[0,.9,0],ring:[.315,1.39,.15],pinky:[1.55,.5,.5]},
  german:{index:[0,0,0],middle:[0,0,.06],ring:[0,1.27,.15],pinky:[1.55,.56,.296]},
};
const SOURCE_STOCK_CURL:Record<Faction,SupportCurls>={
  british:{index:[.3,.5,.38],middle:[.65,.52,.38],ring:[.56,.5,.3],pinky:[.1,.3,.2]},
  russian:{index:[.3,.5,.38],middle:[.65,.55,.68],ring:[.65,.65,.15],pinky:[.1,.55,.5]},
  german:{index:[.3,.5,.38],middle:[.71,.82,.15],ring:[.8,.5,.3],pinky:[.45,.3,.15]},
};
// The firing thumb lies across/along the stock instead of rising beside the
// sights. These source-specific curls preserve clearance from the wood.
const SOURCE_STOCK_THUMB_CURL:Record<Faction,Vector>={british:[.174,.107,.38],russian:[-.51,.11,.38],german:[-.48,.08,.377]};
const STOCK_ROTATION:Vector=[.7,-.25,0];
const LEFT:Vector=[0,-.026,-.680];
const GRENADE_RIGHT:Vector=[.050,-.074,-.185];
const LOAD_ROTATION:Vector=[1.901071,.921525,-.202327];
const RELOAD_REFERENCE=sampleSourceMotion('Pistol_Reload',0);
const BOLT_HAND_AXIS=new THREE.Vector3(0,1,0).applyAxisAngle(new THREE.Vector3(0,0,1),-.75);
const smooth=(x:number)=>{const t=Math.max(0,Math.min(1,x));return t*t*(3-2*t);};
function keys(t:number,points:Key[]):Vector {
  if(t<=points[0][0]) return [...points[0][1]];
  for(let i=1;i<points.length;i++) if(t<=points[i][0]) {
    const [a,av]=points[i-1],[b,bv]=points[i],w=smooth((t-a)/(b-a));
    return av.map((v,k)=>v+(bv[k]-v)*w) as Vector;
  }
  return [...points[points.length-1][1]];
}
const ramp=(t:number,a:number,b:number)=>smooth((t-a)/(b-a));
const mix=(a:Vector,b:Vector,t:number)=>a.map((v,i)=>v+(b[i]-v)*t) as Vector;
function mixRotation(a:Vector,b:Vector,t:number):Vector {
  if(t<=0)return [...a];if(t>=1)return [...b];
  const q=new THREE.Quaternion().setFromEuler(new THREE.Euler(...a)).slerp(new THREE.Quaternion().setFromEuler(new THREE.Euler(...b)),t);
  const e=new THREE.Euler().setFromQuaternion(q);return [e.x,e.y,e.z];
}
function boltHandRotation(lift:number,stockRotation:Vector=STOCK_ROTATION):Vector {
  // Pronation follows the bolt about the wrist's longitudinal axis. Turning
  // the entire hand about weapon Z previously pointed its wrist straight up.
  const q=new THREE.Quaternion().setFromEuler(new THREE.Euler(...stockRotation)).multiply(new THREE.Quaternion().setFromAxisAngle(BOLT_HAND_AXIS,lift*.55));
  const e=new THREE.Euler().setFromQuaternion(q);return [e.x,e.y,e.z];
}
const reachCurves=new Map<string,THREE.CatmullRomCurve3>();
function reachCurve(t:number,points:Vector[]):Vector {
  // Reload reach control points stay fixed while the action is open. Keep the
  // exact curve and its 200-segment arc-length table instead of rebuilding it
  // for every hand/frame. Numeric keys also respect edited profile overrides.
  const key=points.map(point=>point.join(',')).join(';');let curve=reachCurves.get(key);
  if(!curve){
    curve=new THREE.CatmullRomCurve3(points.map(point=>new THREE.Vector3(...point)),false,'centripetal');
    if(reachCurves.size>=32)reachCurves.delete(reachCurves.keys().next().value!);
    reachCurves.set(key,curve);
  }
  return curve.getPointAt(smooth(t)).toArray() as Vector;
}
/** Centre of the authored bolt knob, transformed by the same bolt pose that
 * moves its mesh. A hand cannot lag behind a differently interpolated path. */
export function rifleBoltContact(faction:Faction,lift:number,travel:number,profileOverride?:Readonly<ImportedWeaponProfile>|null):Vector {
  const profile=profileOverride===undefined?getImportedWeaponProfile(faction):profileOverride;
  if(profile)return new THREE.Vector3(...profile.bolt.knobLocal).applyAxisAngle(new THREE.Vector3(...profile.bolt.axis).normalize(),lift).add(new THREE.Vector3(...profile.bolt.origin)).add(new THREE.Vector3(0,0,travel)).toArray() as Vector;
  const x=faction==='russian'?.119:.087,y=faction==='russian'?-.002:-.057,z=faction==='russian'?.010:.013;
  return [Math.cos(lift)*x-Math.sin(lift)*y,.045+Math.sin(lift)*x+Math.cos(lift)*y,-.26+travel+z];
}

/** Lower the outgoing item completely before raising its replacement. The
 * hidden interval makes the inventory hand-off invisible at any frame rate. */
export function sampleWeaponSwitch(progress:number):WeaponSwitchPose {
  const t=Math.max(0,Math.min(1,progress));
  return {
    position:keys(t,[[0,[0,0,0]],[.12,[0,0,0]],[.40,[.025,-.25,.272]],[.57,[.025,-.25,.272]],[.91,[0,.008,-.006]],[1,[0,0,0]]]),
    rotation:keys(t,[[0,[0,0,0]],[.12,[0,0,0]],[.40,[-.07,.06,.04]],[.57,[-.07,.06,.04]],[.91,[.012,0,-.004]],[1,[0,0,0]]]),
    item:t<.5?'from':'to',hidden:t>=.40&&t<=.57,
    stage:t<.4?'Lower weapon':t<.57?'Change weapon':t<.91?'Raise weapon':'Settle into grip',
  };
}

/** The grenade is a carried movement item, held continuously in the palm. */
export function sampleGrenadeReadyPose():GrenadePose {
  return {
    position:[0,0,0],rotation:[0,0,0],right:[...GRENADE_RIGHT],rightRotation:[0,-1.2,0],
    left:[-.19,-.19,-.28],leftRotation:[0,0,0],
    grenadePosition:[.03,-.05,-.20],grenadeRotation:[0,0,0],
    grenadeVisible:true,leftVisible:false,stage:'Ready',
  };
}

/** Lift the canister above the shoulder, snap downward, then recover. Keep
 * recovery inside the existing melee interval so attack cadence is unchanged.
 * The item and gripping hand share the same transform throughout the bash. */
export function sampleGrenadeMelee(progress:number):GrenadePose {
  const t=Math.max(0,Math.min(1,progress)),pose=sampleGrenadeReadyPose(),contact=MELEE_CONTACT_FRACTION.grenade;
  pose.position=keys(t,[[0,[0,0,0]],[.18,[-.025,.32,.055]],[contact,[-.045,-.13,-.24]],[.44,[-.04,-.16,-.20]],[1,[0,0,0]]]);
  pose.rotation=keys(t,[[0,[0,0,0]],[.18,[.58,0,.04]],[contact,[-1.25,0,-.025]],[.44,[-1.13,0,-.02]],[1,[0,0,0]]]);
  pose.stage=t<.18?'Raise grenade':t<.44?'Downward bash':'Recover grip';
  return pose;
}

// Body-space receiver paths fitted against both actual hands and fixed-length
// arms. A continuous curve avoids a sequence of stop/start translation keys.
const MELEE_DRAW_ROTATION:Vector=[-.896,1.064,-.864];
const MELEE_STRIKE_ROTATION:Vector=[-.007,2.041,-1.85];
const MELEE_DRAW_PATH=new THREE.CatmullRomCurve3([
 [.105,-.235,-.04],[.114375,-.228125,-.079125],[.12375,-.22125,-.11825],
 [.112071,-.199864,-.137259],[.108751,-.174801,-.158118],
 [.119034,-.154656,-.187273],[.138981,-.142933,-.230941],
 [.159827,-.148668,-.285215],[.170187,-.176299,-.340988],
].map(p=>new THREE.Vector3(...p)),false,'centripetal');
const MELEE_STRIKE_PATH=new THREE.CatmullRomCurve3([
 [.170187,-.176299,-.340988],[.151179,-.168011,-.343421],
 [.131955,-.159858,-.344315],[.111443,-.153470,-.344372],
 [.089406,-.148571,-.345896],[.066554,-.147819,-.347527],
 [.040152,-.147460,-.351756],[.010803,-.148282,-.357189],
 [-.019975,-.152588,-.363618],
].map(p=>new THREE.Vector3(...p)),false,'centripetal');

/** Canonical action controls used by world soldiers and collision generation.
 * Camera-facing framing belongs in firstPersonWeaponAnimation; changing it
 * must not change another player's silhouette or authoritative hit volumes. */
export function sampleWeaponAnimation(faction:Faction,action:WeaponAction,progress:number,twoClips=false,profileOverride?:Readonly<ImportedWeaponProfile>|null):WeaponPose {
  const t=Math.max(0,Math.min(1,progress));
  const profile=profileOverride===undefined?getImportedWeaponProfile(faction):profileOverride;
  const RIGHT=profile?profile.rightStock.map((v,i)=>v+SOURCE_GRIP_FIT[faction].offset[i]) as Vector:STOCK_GRIP[faction];
  const left=profile?profile.leftGrip.map((v,i)=>v+SOURCE_GRIP_FIT[faction].supportOffset[i]) as Vector:LEFT;
  const actionRotation=profile?.rightRotation??STOCK_ROTATION,stockRotation:Vector=profile?[0,-.2,-.75]:STOCK_ROTATION;
  const seatOffset=profile?new THREE.Vector3(...profile.chargerSeat).sub(new THREE.Vector3(0,.075,-.315)):new THREE.Vector3();
  const loadingPoint=(point:Vector):Vector=>point.map((v,i)=>v+seatOffset.getComponent(i)) as Vector;
  const pose:WeaponPose={position:[0,0,0],rotation:[0,0,0],right:[...RIGHT],rightRotation:[...stockRotation],left:[...left],leftRotation:[...(profile?.leftRotation??(profile?SOURCE_SUPPORT_ROTATION[faction]:[0,0,0]))] as Vector,rightElbow:[.32,-.26,.09],leftElbow:[-.32,-.29,.025],boltLift:0,boltTravel:0,clipVisible:false,clipPosition:loadingPoint([0,.075,-.32]),clipPress:0,fingerOpen:0,thumbContact:0,boltGrip:0,stage:'Ready',boltOrigin:[...(profile?.bolt.origin??[0,.045,-.26])] as Vector,boltAxis:[...(profile?.bolt.axis??[0,0,1])] as Vector,stockThumbTurn:profile?SOURCE_GRIP_FIT[faction].thumb:-1.5,sourceSupportGrip:!!profile,supportCurls:profile?SOURCE_SUPPORT_CURL[faction]:undefined};
  if(profile){pose.stockCurls=SOURCE_STOCK_CURL[faction];pose.stockThumbCurl=SOURCE_STOCK_THUMB_CURL[faction];}
  if(action==='idle') return pose;
  if(action==='cycle') {
    pose.stage=t<.16?'Recover':t<.31?'Lift bolt':t<.52?'Extract case':t<.72?'Chamber round':t<.87?'Lock bolt':'Return to grip';
    pose.rotation=keys(t,[[0,[0,0,0]],[.25,[.025,-.025,-.055]],[.65,[.015,-.012,-.038]],[1,[0,0,0]]]);
    pose.position=keys(t,faction==='british'
      ?[[0,[0,0,0]],[.30,[-.055,.090,-.045]],[.7,[-.055,.075,-.045]],[1,[0,0,0]]]
      :[[0,[0,0,0]],[.30,[.008,.090,.018]],[.7,[.005,.065,.006]],[1,[0,0,0]]]);
    pose.boltLift=(ramp(t,.16,.30)-ramp(t,.73,.84))*(profile?.bolt.lift??1.05);
    pose.boltTravel=(ramp(t,.30,.47)-ramp(t,.56,.73))*(profile?.bolt.travel??.112);
    pose.boltGrip=ramp(t,.06,.16)-ramp(t,.84,1);
    pose.right=mix(RIGHT,rifleBoltContact(faction,pose.boltLift,pose.boltTravel,profile),pose.boltGrip);
    pose.rightRotation=mixRotation(stockRotation,boltHandRotation(pose.boltLift,actionRotation),pose.boltGrip);
    return pose;
  }
  if(action==='melee') {
    // Move the actual stock around the planted palms, not just the muzzle
    // forward. The draw brings the buttplate up on screen-right; the second
    // arc turns it beyond square and drives it toward the center/target.
    const contact=MELEE_CONTACT_FRACTION.rifle;
    const phase=t<.22?ramp(t,0,.22):t<contact?1+ramp(t,.22,contact):t<.46?2:t<.68?2-ramp(t,.46,.68):1-ramp(t,.68,1);
    const position=(phase<=1?MELEE_DRAW_PATH.getPoint(phase):MELEE_STRIKE_PATH.getPoint(phase-1));
    pose.position=position.toArray().map((v,i)=>v-VIEWMODEL_HIP_POSITION[i]) as Vector;
    const bodyRotation=phase<=1?mix([0,-.035,0],MELEE_DRAW_ROTATION,phase):mix(MELEE_DRAW_ROTATION,MELEE_STRIKE_ROTATION,phase-1);
    pose.rotation=[bodyRotation[0],bodyRotation[1]+.035,bodyRotation[2]];
    pose.unshoulder=ramp(t,0,.13)-ramp(t,.84,1);
    pose.supportArmFreedom=ramp(t,0,.07)-ramp(t,.91,1);
    pose.stage=t<.22?'Raise buttstock on right':t<contact?'Right-side buttstock smash':t<.54?'Follow through':'Recover both hands';
    // Grips stay exactly fitted to each source stock, including during the
    // roll. The body-fixed arms solve around those contacts without stretching.
    return pose;
  }
  pose.stage=t<.12?'Raise rifle':t<.24?'Open action':t<.35?'Reach for charger':t<.72?'Load rounds':t<.88?'Close action':'Return to grip';
  pose.position=keys(t,[[0,[0,0,0]],[.17,[-.075,.038,.045]],[.76,[-.075,.038,.045]],[1,[0,0,0]]]);
  pose.rotation=keys(t,[[0,[0,0,0]],[.16,[.08,-.08,-.18]],[.77,[.08,-.08,-.18]],[1,[0,0,0]]]);
  pose.boltLift=(ramp(t,.08,.16)-ramp(t,.85,.91))*(profile?.bolt.lift??1.05);
  pose.boltTravel=(ramp(t,.16,.24)-ramp(t,.79,.85))*(profile?.bolt.travel??.112);
  const boltPoint=rifleBoltContact(faction,pose.boltLift,pose.boltTravel,profile);
  const liftedRotation=boltHandRotation(pose.boltLift,actionRotation);
  if(t<.24){
    pose.boltGrip=ramp(t,.025,.08);pose.right=mix(RIGHT,boltPoint,pose.boltGrip);pose.rightRotation=mixRotation(stockRotation,liftedRotation,pose.boltGrip);
  }else if(t<.35){
    pose.boltGrip=1-ramp(t,.24,.29);
    pose.right=reachCurve((t-.24)/.11,[boltPoint,loadingPoint([.12,.06,-.20]),loadingPoint([.10,.17,-.26]),loadingPoint([0,.238,-.316])]);
    pose.thumbContact=ramp(t,.28,.35);pose.rightRotation=mixRotation(liftedRotation,LOAD_ROTATION,ramp(t,.25,.35));
    pose.fingerOpen=(ramp(t,.24,.28)-ramp(t,.32,.35))*.35;
  }else if(t>=.735&&t<.79){
    pose.boltGrip=ramp(t,.755,.79);
    pose.right=reachCurve((t-.735)/.055,[loadingPoint([.105,.218,-.291]),loadingPoint([.12,.16,-.23]),boltPoint]);
    pose.thumbContact=1-ramp(t,.735,.79);pose.rightRotation=mixRotation(LOAD_ROTATION,liftedRotation,ramp(t,.735,.79));
  }else if(t>=.79){
    pose.boltGrip=1-ramp(t,.91,1);pose.right=mix(RIGHT,boltPoint,pose.boltGrip);pose.rightRotation=mixRotation(stockRotation,liftedRotation,pose.boltGrip);
  }
  const count=faction==='british'&&twoClips?2:1;
  const loadStart=.35,loadEnd=.735;
  if(t>=loadStart&&t<loadEnd) {
    const step=(t-loadStart)/(loadEnd-loadStart)*count,local=step%1,last=Math.floor(step)===count-1;
    pose.stage=local<.28?'Seat charger':local<.72?'Press rounds into magazine':'Remove empty charger';
    pose.thumbContact=1;pose.rightRotation=[...LOAD_ROTATION];
    pose.clipVisible=local>.07&&local<.85;
    pose.clipPosition=loadingPoint(keys(local,[[0,[0,.18,-.315]],[.29,[0,.075,-.315]],[.71,[0,.075,-.315]],[.84,[.07,.16,-.31]],[1,last?[.105,.16,-.29]:[0,.18,-.315]]]));
    pose.clipPress=ramp(local,.38,.70);
    const press=local<.72?pose.clipPress:1-ramp(local,.72,.84);
    pose.right=[pose.clipPosition[0],pose.clipPosition[1]+.058-press*.064,pose.clipPosition[2]-.001];
  }
  pose.rightElbow=mix([.32,-.26,.09],[.46,.40,.14],ramp(t,.27,.35)-ramp(t,.735,.80));
  pose.rightElbow=pose.rightElbow.map((v,i)=>v+seatOffset.getComponent(i)*pose.thumbContact) as Vector;
  // Adapt only the source's support/reach mechanics. Its left-hand pistol
  // magazine path is not used for this rifle's right-hand bolt/charger path.
  const reference=RELOAD_REFERENCE,source=sampleSourceMotion('Pistol_Reload',t);
  const envelope=Math.sin(Math.PI*t)**2;
  const fetch=Math.max(0,Math.min(1,(reference.leftWrist[1]-source.leftWrist[1])/.28))*envelope;
  pose.position[1]-=fetch*.018;pose.position[2]+=fetch*.025;
  pose.rotation[0]+=fetch*.028;pose.rotation[2]+=fetch*.035;
  pose.rightElbow[0]-=(source.leftElbow[0]-reference.leftElbow[0])*.16*envelope;
  pose.rightElbow[1]+=(source.leftElbow[1]-reference.leftElbow[1])*.16*envelope;
  pose.rightElbow[2]-=(source.leftElbow[2]-reference.leftElbow[2])*.16*envelope;
  pose.leftElbow[1]-=fetch*.020;pose.leftElbow[2]+=fetch*.035;
  return pose;
}

function forearm(mesh:THREE.Object3D,elbow:Vector,wrist:Vector,width?:THREE.Vector3) {
  const from=new THREE.Vector3(...elbow),to=new THREE.Vector3(...wrist),delta=to.clone().sub(from);
  mesh.position.copy(from).add(to).multiplyScalar(.5);
  const y=delta.clone().normalize();
  if(width){
    // Resolve roll from the hand's wrist section, not an arbitrary shortest
    // rotation of the sleeve. Its cloth seam follows forearm pronation.
    const x=width.clone().addScaledVector(y,-width.dot(y)).normalize();
    mesh.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(x,y,new THREE.Vector3().crossVectors(x,y)));
  }else mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0),y);
  mesh.scale.y=delta.length();
}

export const MAX_RIFLE_WRIST_BEND=28*Math.PI/180;
export const MAX_SUPPORT_WRIST_BEND=22*Math.PI/180;
/** Fixed body anchor, expressed back in the animated rifle's local frame.
 * Reload lift/roll must move the hand while leaving the shoulder attached. */
export function supportShoulder(pose:WeaponPose):Vector {
  return new THREE.Vector3(-.29,-.27,.015).sub(new THREE.Vector3(...pose.position))
    .applyQuaternion(new THREE.Quaternion().setFromEuler(new THREE.Euler(...pose.rotation)).invert()).toArray() as Vector;
}
/** Keep the supporting forearm in the hand's anatomical exit cone. The old
 * fixed elbow could point almost perpendicular to the actual wrist cap. */
export function supportElbow(hand:THREE.Group,pose:WeaponPose,wrist:THREE.Vector3):Vector {
  const axis=((hand.userData.wristAxisLocal as THREE.Vector3|undefined)?.clone()??new THREE.Vector3(-1,0,0)).applyQuaternion(hand.quaternion);
  const preferred=new THREE.Vector3(...pose.leftElbow).sub(new THREE.Vector3(...pose.position)).applyQuaternion(new THREE.Quaternion().setFromEuler(new THREE.Euler(...pose.rotation)).invert());
  const direction=preferred.sub(wrist).normalize(),dot=THREE.MathUtils.clamp(direction.dot(axis),-1,1);
  if(dot<Math.cos(MAX_SUPPORT_WRIST_BEND)){
    const tangent=direction.clone().addScaledVector(axis,-dot).normalize();
    direction.copy(axis).multiplyScalar(Math.cos(MAX_SUPPORT_WRIST_BEND)).addScaledVector(tangent,Math.sin(MAX_SUPPORT_WRIST_BEND));
  }
  return wrist.clone().addScaledVector(direction,.32).toArray() as Vector;
}
/** Solve the elbow from the actual cuff exit after solving the hand contact.
 * The elbow prefers the body side of the view model, with a bounded forearm
 * length and wrist bend. The established loading reach remains unchanged. */
export function rifleElbow(hand:THREE.Group,pose:WeaponPose,wrist:THREE.Vector3):Vector {
  const axis=((hand.userData.wristAxisLocal as THREE.Vector3|undefined)?.clone()??new THREE.Vector3(0,1,0).applyAxisAngle(new THREE.Vector3(0,0,1),-.75)).applyQuaternion(hand.quaternion);
  const preferred=new THREE.Vector3(...pose.rightElbow);
  const body=preferred.clone().sub(new THREE.Vector3(...pose.position)).applyQuaternion(new THREE.Quaternion().setFromEuler(new THREE.Euler(...pose.rotation)).invert());
  preferred.lerp(body,1-pose.thumbContact);
  const direction=preferred.sub(wrist),distance=direction.length();direction.normalize();
  const dot=THREE.MathUtils.clamp(direction.dot(axis),-1,1);
  if(dot<Math.cos(MAX_RIFLE_WRIST_BEND)){
    const tangent=direction.clone().addScaledVector(axis,-dot).normalize();
    direction.copy(axis).multiplyScalar(Math.cos(MAX_RIFLE_WRIST_BEND)).addScaledVector(tangent,Math.sin(MAX_RIFLE_WRIST_BEND));
  }
  const length=THREE.MathUtils.lerp(THREE.MathUtils.clamp(distance,.28,.38),distance,pose.thumbContact);
  return wrist.clone().addScaledVector(direction,length).toArray() as Vector;
}

export function applyGrenadePose(item:THREE.Group,pose:GrenadePose,bodyFromWeapon?:THREE.Matrix4) {
  const rig=item.userData.grenadeRig as {
    right:THREE.Group;left:THREE.Group;rightForearm:THREE.Mesh;leftForearm:THREE.Mesh;grenade:THREE.Group;
    rightUpperArm?:THREE.Mesh;rightElbow?:THREE.Mesh;
    rightArm?:ViewmodelArm;leftArm?:ViewmodelArm;
  }|undefined;
  if(!rig)return;
  rig.right.position.set(...pose.right);rig.right.rotation.set(...pose.rightRotation);
  rig.left.position.set(...pose.left);rig.left.rotation.set(...pose.leftRotation);
  rig.left.visible=rig.leftForearm.visible=pose.leftVisible;
  if(rig.leftArm)rig.leftArm.mesh.visible=pose.leftVisible;
  // Keep the grenade fixed in the right palm when its pose is reapplied.
  const offset=new THREE.Vector3(...pose.grenadePosition).sub(new THREE.Vector3(...GRENADE_RIGHT)).applyEuler(rig.right.rotation);
  rig.grenade.position.copy(rig.right.position).add(offset);
  rig.grenade.rotation.copy(rig.right.rotation);rig.grenade.rotateX(pose.grenadeRotation[0]);rig.grenade.rotateY(pose.grenadeRotation[1]);rig.grenade.rotateZ(pose.grenadeRotation[2]);
  rig.grenade.visible=pose.grenadeVisible;
  const body=bodyFromWeapon??defaultWeaponBodyMatrix(VIEWMODEL_GRENADE_POSITION.map((v,i)=>v+pose.position[i]),pose.rotation);
  for(const [side,hand,arm,elbow] of [['right',rig.right,rig.rightForearm,[.32,-.26,.09]],['left',rig.left,rig.leftForearm,[-.32,-.29,.025]]] as const) {
    const wrist=((hand.userData.wristLocal as THREE.Vector3|undefined)?.clone()??new THREE.Vector3(.015,-.035,.076)).applyEuler(hand.rotation).add(hand.position);
    const chain=side==='right'?rig.rightArm:rig.leftArm;
    if(chain){
     const axis=((hand.userData.wristAxisLocal as THREE.Vector3|undefined)?.clone()??new THREE.Vector3(1,0,0)).applyQuaternion(hand.quaternion);
     const width=((hand.userData.wristWidthLocal as THREE.Vector3|undefined)?.clone()??new THREE.Vector3(0,1,0)).applyQuaternion(hand.quaternion);
     const solved=poseViewmodelArm(chain,side,wrist,axis,width,body);
     forearm(arm,solved.elbow.toArray() as Vector,solved.end.toArray() as Vector,width);
     if(side==='right'){
      if(rig.rightUpperArm)forearm(rig.rightUpperArm,solved.shoulder.toArray() as Vector,solved.elbow.toArray() as Vector,width);
      if(rig.rightElbow)rig.rightElbow.position.copy(solved.elbow);
     }
    }else forearm(arm,elbow as Vector,wrist.toArray() as Vector);
  }
  // Cancel the bash transform at the shoulder only. The existing gripping
  // hand and forearm follow the strike, while the upper sleeve stays attached
  // to the body beyond the bottom of the first-person camera.
  const shoulder=new THREE.Vector3(.29,-.27,.015).sub(new THREE.Vector3(...pose.position))
    .applyQuaternion(new THREE.Quaternion().setFromEuler(new THREE.Euler(...pose.rotation)).invert());
  if(!rig.rightArm){
   if(rig.rightUpperArm)forearm(rig.rightUpperArm,shoulder.toArray() as Vector,[.32,-.26,.09]);
   if(rig.rightElbow){rig.rightElbow.position.set(.32,-.26,.09);rig.rightElbow.quaternion.copy(rig.rightForearm.quaternion);}
  }
  poseAnatomicalHand(rig.right,0,'cylinder');poseAnatomicalHand(rig.left,.15);
}

/** Applies absolute poses, so replay scrubbing never accumulates rotations. */
export function applyWeaponAnimation(rifle:THREE.Group,pose:WeaponPose,bodyFromWeapon?:THREE.Matrix4) {
  const rig=rifle.userData.handRig as {
    right:THREE.Group;left:THREE.Group;rightForearm:THREE.Mesh;leftForearm:THREE.Mesh;
    leftUpperArm?:THREE.Mesh;leftElbow?:THREE.Mesh;
    rightArm?:ViewmodelArm;leftArm?:ViewmodelArm;
    rightFingers:THREE.Group[];rightThumb:THREE.Group;clip:THREE.Group;rounds:THREE.Group;bolt:THREE.Group;
  }|undefined;
  const bolt=rig?.bolt??rifle.getObjectByName('bolt');
  if(bolt) {bolt.position.set(...pose.boltOrigin);bolt.position.z+=pose.boltTravel;bolt.quaternion.setFromAxisAngle(new THREE.Vector3(...pose.boltAxis).normalize(),pose.boltLift);}
  if(!rig) return;
  rig.right.rotation.set(...pose.rightRotation);rig.left.rotation.set(...pose.leftRotation);
  for(let i=0;i<rig.rightFingers.length;i++) rig.rightFingers[i].rotation.z=-pose.fingerOpen*(i===0?.30:.48);
  rig.rightThumb.rotation.y=pose.fingerOpen*.38;
  rig.right.userData.stockThumbTurn=pose.stockThumbTurn;
  rig.right.userData.stockThumbCurl=pose.stockThumbCurl;
  rig.right.userData.stockFingerCurl=pose.stockCurls;
  poseAnatomicalHand(rig.right,pose.fingerOpen,'rifle',pose.thumbContact,pose.boltGrip);
  // Separate digit lengths require separate bends: lifting the palm while
  // retaining a single curl drove the shorter ring/pinky through the stock.
  rig.left.userData.supportFingerCurl=pose.supportCurls;
  rig.left.userData.supportThumbTurn=pose.sourceSupportGrip?.6:undefined;
  rig.left.userData.supportThumbDirection=pose.sourceSupportGrip?new THREE.Vector3(0,.45,-1).applyQuaternion(rig.left.quaternion.clone().invert()):undefined;
  poseAnatomicalHand(rig.left,0);
  const body=bodyFromWeapon??defaultWeaponBodyMatrix(VIEWMODEL_HIP_POSITION.map((v,i)=>v+pose.position[i]),[pose.rotation[0],pose.rotation[1]-.035,pose.rotation[2]]);
  const rightContact=handContactLocal(rig.right,pose.thumbContact);
  rig.right.position.set(...pose.right).sub(rightContact.clone().applyQuaternion(rig.right.quaternion));
  rig.left.position.set(...pose.left).sub(handContactLocal(rig.left).applyQuaternion(rig.left.quaternion));
  // The stock grip is planted and keeps its measured surface fit. A hand on
  // the spherical bolt or pressing with its thumb may swivel around that
  // exact contact, letting the forearm share the motion instead of folding
  // the wrist to preserve an unrelated Euler pose.
  const free=THREE.MathUtils.smoothstep(Math.max(pose.boltGrip,pose.thumbContact),.15,.75);
  if(rig.rightArm&&rig.right.userData.wristAxisLocal&&free>0){
   const bodyQ=new THREE.Quaternion().setFromRotationMatrix(body),inverseQ=bodyQ.clone().invert();
   for(let iteration=0;iteration<7;iteration++){
    const wrist=(rig.right.userData.wristLocal as THREE.Vector3).clone().applyQuaternion(rig.right.quaternion).add(rig.right.position).applyMatrix4(body);
    const axis=(rig.right.userData.wristAxisLocal as THREE.Vector3).clone().applyQuaternion(rig.right.quaternion).applyQuaternion(bodyQ);
    const solved=solveViewmodelArm('right',wrist,axis),toward=solved.elbow.sub(solved.wrist).normalize(),angle=axis.angleTo(toward);
    if(angle<26*Math.PI/180)break;
    const swing=new THREE.Quaternion().setFromUnitVectors(axis,toward);
    swing.slerp(new THREE.Quaternion(),1-free*Math.min(.65,(angle-26*Math.PI/180)/angle));
    const local=inverseQ.clone().multiply(swing).multiply(bodyQ);
    rig.right.quaternion.premultiply(local);
    rig.right.position.set(...pose.right).sub(rightContact.clone().applyQuaternion(rig.right.quaternion));
   }
  }
  const wristOffset=((rig.right.userData.wristLocal as THREE.Vector3|undefined)?.clone()??new THREE.Vector3(.015,-.035,.076)).applyEuler(rig.right.rotation);
  const wrist=rig.right.position.clone().add(wristOffset);
  const width=(rig.right.userData.wristWidthLocal as THREE.Vector3|undefined)?.clone().applyQuaternion(rig.right.quaternion);
  const leftWristOffset=((rig.left.userData.wristLocal as THREE.Vector3|undefined)?.clone()??new THREE.Vector3(.015,-.035,.076)).applyEuler(rig.left.rotation);
  const leftWrist=rig.left.position.clone().add(leftWristOffset);
  const leftWidth=(rig.left.userData.wristWidthLocal as THREE.Vector3|undefined)?.clone().applyQuaternion(rig.left.quaternion);
  if(rig.rightArm&&rig.leftArm){
   const rightExit=((rig.right.userData.wristAxisLocal as THREE.Vector3|undefined)?.clone()??new THREE.Vector3(0,1,0)).applyQuaternion(rig.right.quaternion);
   const leftExit=((rig.left.userData.wristAxisLocal as THREE.Vector3|undefined)?.clone()??new THREE.Vector3(-1,0,0)).applyQuaternion(rig.left.quaternion);
   const right=poseViewmodelArm(rig.rightArm,'right',wrist,rightExit,width??new THREE.Vector3(1,0,0),body);
   const left=poseViewmodelArm(rig.leftArm,'left',leftWrist,leftExit,leftWidth??new THREE.Vector3(1,0,0),body,pose.supportArmFreedom??0);
   forearm(rig.rightForearm,right.elbow.toArray() as Vector,right.end.toArray() as Vector,width);
   forearm(rig.leftForearm,left.elbow.toArray() as Vector,left.end.toArray() as Vector,leftWidth);
   if(rig.leftUpperArm)forearm(rig.leftUpperArm,left.shoulder.toArray() as Vector,left.elbow.toArray() as Vector,leftWidth);
   if(rig.leftElbow)rig.leftElbow.position.copy(left.elbow);
  }else{
   forearm(rig.rightForearm,rifleElbow(rig.right,pose,wrist),wrist.toArray() as Vector,width);
   const elbow=supportElbow(rig.left,pose,leftWrist);
   forearm(rig.leftForearm,elbow,leftWrist.toArray() as Vector,leftWidth);
   if(rig.leftUpperArm)forearm(rig.leftUpperArm,supportShoulder(pose),elbow,leftWidth);
   if(rig.leftElbow){rig.leftElbow.position.set(...elbow);rig.leftElbow.quaternion.copy(rig.leftForearm.quaternion);}
  }
  rig.clip.visible=pose.clipVisible;rig.clip.position.set(...pose.clipPosition);
  rig.rounds.position.y=-pose.clipPress*.064;rig.rounds.visible=pose.clipPress<.98;
}
