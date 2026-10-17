import {sampleFirstPersonWeaponAnimation} from './firstPersonWeaponAnimation';
import {preloadModelDetails} from './modelDetails';
import {preloadImportedWeapons} from './importedWeapons';
import {preloadSurfaceAssets} from './materials';
import {createOutdoorEnvironment} from './outdoorLighting';
import * as THREE from 'three';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {FACTIONS, WEAPONS, WEAPON_SWITCH_SECONDS, RULES, type Faction} from './config';
import {makeRifle, getRifleVisuals,HIP_WEAPON_FOV,ADS_WEAPON_FOV} from './rifle';
import {keepADSBoltInFront} from './weaponPresentation';
import {VIEWMODEL_HIP_POSITION,VIEWMODEL_GRENADE_POSITION,type ViewmodelArm} from './viewmodelArms';
import {makeStielhandgranate} from './grenadeModel';
import {makeSoldier,preloadSoldierMaterials} from './soldier';
import {preloadHumanHead} from './humanHead';
import {applySoldierPose,sampleSoldierPose,type SoldierActor} from './soldierAnimation';
import {gaitRate} from './soldierMotionState';
import {sampleHitVolumes} from './hitboxes';
import {HitboxDebug} from './hitboxDebug';
import {applyWeaponAnimation,applyGrenadePose,sampleGrenadeReadyPose,sampleGrenadeMelee,sampleWeaponSwitch,MELEE_ANIMATION_SECONDS,type WeaponAction} from './weaponAnimation';
import {loadHandAssets} from './hands';
import {makeMuzzleFlash,updateMuzzleFlash,placeMuzzleFlash,MUZZLE_FLASH_RADII} from './weaponFeedback';
import {makeImpactEffect,updateImpactEffect} from './impactFeedback';
await Promise.all([loadHandAssets(),preloadHumanHead(),preloadSoldierMaterials(),preloadModelDetails(),preloadSurfaceAssets(),preloadImportedWeapons()]);

// Separate development entry point. Vite's default production entry is
// index.html, so this gallery is neither linked from nor included in the game.
type Mode = 'soldiers' | Faction;
type InspectorAction=WeaponAction|'grenade-ready'|'grenade-melee'|'switch-to-grenade'|'switch-to-rifle';
const canvasRenderer=new THREE.WebGLRenderer({antialias:true});
canvasRenderer.setPixelRatio(Math.min(devicePixelRatio,2));
canvasRenderer.shadowMap.enabled=true;
canvasRenderer.shadowMap.type=THREE.PCFSoftShadowMap;
canvasRenderer.outputColorSpace=THREE.SRGBColorSpace;
canvasRenderer.toneMapping=THREE.ACESFilmicToneMapping;
canvasRenderer.toneMappingExposure=1.04;
document.body.prepend(canvasRenderer.domElement);
const scene=new THREE.Scene();scene.background=new THREE.Color(0x444e49);
const environment=createOutdoorEnvironment(canvasRenderer);scene.environment=environment.texture;scene.environmentIntensity=.95;
const camera=new THREE.PerspectiveCamera(36,1,.008,80);
const orbit=new OrbitControls(camera,canvasRenderer.domElement);
orbit.enableDamping=true;orbit.dampingFactor=.1;orbit.maxDistance=14;orbit.minDistance=.15;
const ambient=new THREE.HemisphereLight(0xe4edf3,0x68685e,.95);scene.add(ambient);
const sunlight=new THREE.DirectionalLight(0xfff2dc,2.5);sunlight.position.set(-3,7,6);sunlight.castShadow=true;
sunlight.shadow.mapSize.set(2048,2048);sunlight.shadow.camera.left=-5;sunlight.shadow.camera.right=5;
sunlight.shadow.camera.top=5;sunlight.shadow.camera.bottom=-5;sunlight.shadow.normalBias=.0015;sunlight.shadow.bias=-.000035;
scene.add(sunlight,sunlight.target);


const floor=new THREE.Mesh(new THREE.PlaneGeometry(40,40),new THREE.MeshStandardMaterial({color:0x454e43,roughness:1}));
floor.rotation.x=-Math.PI/2;floor.position.y=-.012;floor.receiveShadow=true;scene.add(floor);
const grid=new THREE.GridHelper(12,24,0x858e7e,0x596352);grid.position.y=-.01;scene.add(grid);
const soldiers=new THREE.Group(),weapons=new Map<Faction,THREE.Group>(),grenades=new Map<Faction,THREE.Group>();scene.add(soldiers);
const hitDebug=FACTIONS.map(()=>new HitboxDebug());scene.add(...hitDebug);
const labels=document.querySelector<HTMLDivElement>('#labels')!;
const labelData:{element:HTMLDivElement;point:THREE.Vector3}[]=[];
const countryNames={british:'BRITISH',russian:'SOVIET',german:'GERMAN'};
FACTIONS.forEach((faction,i)=>{
  const model=makeSoldier(faction);model.position.x=(i-1)*1.35;model.rotation.y=-.13;soldiers.add(model);
  const element=document.createElement('div');element.className='model-label';
  element.innerHTML=`${countryNames[faction]}<small>${model.userData.uniform}</small>`;labels.append(element);
  labelData.push({element,point:new THREE.Vector3(model.position.x,-.09,.12)});
  const rifle=makeRifle(faction,true);rifle.visible=false;scene.add(rifle);weapons.set(faction,rifle);
  const muzzleAnchor=new THREE.Object3D();muzzleAnchor.name='inspector-muzzle-anchor';muzzleAnchor.position.set(...getRifleVisuals(faction).muzzle);muzzleAnchor.position.z-=.012;rifle.add(muzzleAnchor);
  const grenade=makeStielhandgranate(faction,true);grenade.visible=false;scene.add(grenade);grenades.set(faction,grenade);
});

const target=new THREE.Group();target.position.set(0,0,-9);scene.add(target);target.visible=false;
const targetBoard=new THREE.Mesh(new THREE.PlaneGeometry(3,3),new THREE.MeshStandardMaterial({color:0xd4d1bb,roughness:1}));
target.add(targetBoard);
for(const radius of [.035,.08,.15,.25,.40]) {
  const ring=new THREE.Mesh(new THREE.RingGeometry(radius-.002,radius+.002,64),new THREE.MeshBasicMaterial({color:0x606952,side:THREE.DoubleSide}));
  ring.position.z=.002;target.add(ring);
}
const sights=document.querySelector<HTMLInputElement>('#sights')!;
const firstPerson=document.querySelector<HTMLInputElement>('#first-person')!;
const animation=document.querySelector<HTMLSelectElement>('#animation')!;
const timeline=document.querySelector<HTMLInputElement>('#timeline')!;
const play=document.querySelector<HTMLButtonElement>('#play-animation')!;
const phase=document.querySelector<HTMLSpanElement>('#phase')!;
const soldierControls=document.querySelector<HTMLDivElement>('#soldier-controls')!;
const soldierAnimation=document.querySelector<HTMLSelectElement>('#soldier-animation')!;
const soldierFraming=document.querySelector<HTMLSelectElement>('#soldier-framing')!;
const soldierDirection=document.querySelector<HTMLSelectElement>('#soldier-direction')!;
const groundTravel=document.querySelector<HTMLInputElement>('#ground-travel')!;
const soldierTimeline=document.querySelector<HTMLInputElement>('#soldier-timeline')!;
const soldierPitch=document.querySelector<HTMLInputElement>('#soldier-pitch')!;
const soldierLean=document.querySelector<HTMLInputElement>('#soldier-lean')!;
const hitVolumes=document.querySelector<HTMLInputElement>('#hit-volumes')!;
const soldierPlay=document.querySelector<HTMLButtonElement>('#soldier-play')!;
const soldierPhase=document.querySelector<HTMLSpanElement>('#soldier-phase')!;
const axis=document.querySelector<HTMLInputElement>('#show-axis')!;
const axisMarker=document.querySelector<HTMLDivElement>('#axis')!;
const title=document.querySelector<HTMLSpanElement>('#title')!;
const description=document.querySelector<HTMLDivElement>('#description')!;
const stats=document.querySelector<HTMLDivElement>('#stats')!;
const effectSelect=document.querySelector<HTMLSelectElement>('#effect')!;
const effectAge=document.querySelector<HTMLInputElement>('#effect-age')!;
const effectPhase=document.querySelector<HTMLSpanElement>('#effect-phase')!;
const localFlash=makeMuzzleFlash(MUZZLE_FLASH_RADII.local),worldFlash=makeMuzzleFlash(MUZZLE_FLASH_RADII.world),effectLight=new THREE.PointLight(0xffc278,0,7);
const bloodEffect=makeImpactEffect({time:10,actor:1,origin:{x:0,y:1.25,z:3},end:{x:0,y:1.25,z:0},hit:0,headshot:false,kind:'shot'});
bloodEffect.visible=false;scene.add(localFlash,worldFlash,bloodEffect,effectLight);
let mode:Mode='soldiers',modelTriangles=0,modelMeshes=0;
let playing=false,animationTime=0,lastTime=performance.now();
let soldierPlaying=false,soldierTime=0;

function resetView() {
  const extent=mode==='soldiers'?5:1.7;
  Object.assign(sunlight.shadow.camera,{left:-extent,right:extent,top:extent,bottom:-extent});
  sunlight.shadow.camera.updateProjectionMatrix();
  sunlight.target.position.set(0,mode==='soldiers'?1:-.1,mode==='soldiers'?0:-.65);
  orbit.enabled=!((sights.checked||firstPerson.checked)&&mode!=='soldiers');
  camera.fov=mode==='soldiers'?36:sights.checked?ADS_WEAPON_FOV:firstPerson.checked?HIP_WEAPON_FOV:37;
  camera.updateProjectionMatrix();
  if(mode==='soldiers') {
    soldiers.children.forEach(model=>model.rotation.y=['stride-side','german-stride','german-legs'].includes(soldierFraming.value)?Math.PI/2:-.13);
    const head=FACTIONS.indexOf(soldierFraming.value as Faction);
    if(soldierFraming.value==='german-legs'){camera.position.set(1.35,.57,2.05);orbit.target.set(1.35,.53,0);}
    else if(soldierFraming.value==='german-stride'){camera.position.set(1.35,1.1,3.65);orbit.target.set(1.35,.87,0);}
    else if(head>=0){const x=(head-1)*1.35;camera.position.set(x+.05,1.66,.78);orbit.target.set(x,1.66,0);}
    else if(soldierFraming.value==='death-front'){camera.position.set(0,1.5,6.5);orbit.target.set(0,.55,0);}
    else if(soldierFraming.value==='death-side'){camera.position.set(4.4,1.6,3.2);orbit.target.set(0,.55,0);}
    else if(soldierAnimation.value==='jump'){camera.position.set(1.5,3,9);orbit.target.set(0,1.8,.05);}
    else{camera.position.set(1.15,2.00,6.25);orbit.target.set(0,.96,.05);}
  } else if(sights.checked||firstPerson.checked) {
    camera.position.set(0,0,0);orbit.target.set(0,0,-3);
    target.position.y=0;
  } else {
    camera.position.set(1.40,.56,.68);orbit.target.set(0,-.02,-.58);
  }
  camera.lookAt(orbit.target);orbit.update();
}

function changeMode(next:Mode) {
  mode=next;const isSoldiers=mode==='soldiers';
  soldiers.visible=isSoldiers;sights.disabled=isSoldiers;firstPerson.disabled=isSoldiers;
  hitDebug.forEach(overlay=>overlay.visible=isSoldiers&&hitVolumes.checked);
  soldierControls.style.display=isSoldiers?'flex':'none';
  animation.disabled=timeline.disabled=play.disabled=isSoldiers;
  floor.visible=!(sights.checked||firstPerson.checked)||isSoldiers;grid.visible=isSoldiers;
  floor.position.y=isSoldiers?-.012:-.26;
  target.visible=!isSoldiers&&(sights.checked||firstPerson.checked);
  axisMarker.style.display=!isSoldiers&&sights.checked&&axis.checked?'block':'none';
  labels.style.display=isSoldiers?'block':'none';
  for(const [faction,rifle] of weapons) rifle.visible=faction===mode;
  for(const grenade of grenades.values())grenade.visible=false;
  for(const button of document.querySelectorAll<HTMLButtonElement>('button[data-mode]')) button.setAttribute('aria-pressed',String(button.dataset.mode===mode));
  const active=isSoldiers?soldiers:weapons.get(mode as Faction)!;
  modelTriangles=0;modelMeshes=0;
  active.traverse(object=>{
    if(object instanceof THREE.Mesh) {modelMeshes++;modelTriangles+=(object.geometry.index?.count??object.geometry.getAttribute('position').count)/3;}
  });
  if(isSoldiers) {
    title.textContent='Faction uniform and equipment gallery';
    description.textContent='Articulated spine/neck/limbs · grounded two-bone IK · shouldered aim · recoil/reload · progressive death';
  } else {
    const faction=mode as Faction,weapon=WEAPONS[faction],visual=getRifleVisuals(faction);
    title.textContent=`${weapon.name} · ${weapon.model}${sights.checked?' · AIM DOWN SIGHTS':''}`;
    description.textContent=`${visual.description}${sights.checked?` · ${ADS_WEAPON_FOV}° weapon camera · optical axis at the top of the front post`:''}`;
  }
  resetView();
}

for(const button of document.querySelectorAll<HTMLButtonElement>('button[data-mode]')) {
  button.addEventListener('click',()=>changeMode(button.dataset.mode as Mode));
}
sights.addEventListener('change',()=>changeMode(mode));
firstPerson.addEventListener('change',()=>changeMode(mode));
animation.addEventListener('change',()=>{
  animationTime=0;timeline.value='0';playing=false;play.textContent='Play';
  if(animation.value!=='idle'){firstPerson.checked=true;sights.checked=false;}
  changeMode(mode);
});
timeline.addEventListener('input',()=>{animationTime=Number(timeline.value)/1000;playing=false;play.textContent='Play';});
play.addEventListener('click',()=>{playing=!playing;if(playing&&animationTime>=1)animationTime=0;play.textContent=playing?'Pause':'Play';});
soldierAnimation.addEventListener('change',()=>{soldierTime=0;soldierTimeline.value='0';soldierPlaying=false;soldierPlay.textContent='Play soldier action';resetView();});
soldierFraming.addEventListener('change',resetView);
soldierTimeline.addEventListener('input',()=>{soldierTime=Number(soldierTimeline.value)/1000;soldierPlaying=false;soldierPlay.textContent='Play soldier action';});
soldierPlay.addEventListener('click',()=>{soldierPlaying=!soldierPlaying;if(soldierPlaying&&soldierTime>=1)soldierTime=0;soldierPlay.textContent=soldierPlaying?'Pause soldier action':'Play soldier action';});
axis.addEventListener('change',()=>{axisMarker.style.display=sights.checked&&mode!=='soldiers'&&axis.checked?'block':'none';});
document.querySelector('#reset')!.addEventListener('click',resetView);
const togglePanels=()=>document.body.classList.toggle('clean-view');
document.querySelector('#hide-controls')!.addEventListener('click',togglePanels);
document.querySelector('#show-controls')!.addEventListener('click',togglePanels);
document.addEventListener('keydown',event=>{if(event.key.toLowerCase()==='h'&&!event.metaKey&&!event.ctrlKey&&!event.altKey)togglePanels();});
effectSelect.addEventListener('change',()=>{effectAge.value=effectSelect.value==='blood'?'120':'18';});

function resize() {
  canvasRenderer.setSize(innerWidth,innerHeight);camera.aspect=innerWidth/innerHeight;camera.updateProjectionMatrix();
}
window.addEventListener('resize',resize);resize();
const params=new URLSearchParams(location.search),initialMode=params.get('mode'),initialAction=params.get('action');
const initialEffect=params.get('effect');if(initialEffect&&[...effectSelect.options].some(option=>option.value===initialEffect))effectSelect.value=initialEffect;
if(params.has('effectAge'))effectAge.value=String(Math.max(0,Math.min(820,Number(params.get('effectAge'))||0)));
if(initialAction&&[...animation.options].some(option=>option.value===initialAction))animation.value=initialAction;
if(params.get('first')==='1')firstPerson.checked=true;
if(params.get('sights')==='1')sights.checked=true;
animationTime=Math.max(0,Math.min(1,Number(params.get('phase'))||0));timeline.value=String(Math.round(animationTime*1000));
const initialSoldier=params.get('soldier');
const initialFraming=params.get('framing');if(initialFraming&&[...soldierFraming.options].some(option=>option.value===initialFraming))soldierFraming.value=initialFraming;
if(params.has('direction'))soldierDirection.value=params.get('direction')!;
groundTravel.checked=params.get('travel')==='1';
if(initialSoldier&&[...soldierAnimation.options].some(option=>option.value===initialSoldier))soldierAnimation.value=initialSoldier;
soldierTime=animationTime;soldierTimeline.value=timeline.value;
changeMode(FACTIONS.includes(initialMode as Faction)?initialMode as Faction:'soldiers');
let frame=0;
canvasRenderer.setAnimationLoop(()=>{
  const now=performance.now(),delta=Math.min(.05,(now-lastTime)/1000);lastTime=now;
  if(orbit.enabled) orbit.update();
  if(mode==='soldiers') for(const {element,point} of labelData) {
    const screen=point.clone().project(camera);
    element.style.left=`${(screen.x*.5+.5)*innerWidth}px`;element.style.top=`${(-screen.y*.5+.5)*innerHeight}px`;
    element.style.visibility=screen.z<1?'visible':'hidden';
  }
  if(mode==='soldiers') {
    const action=soldierAnimation.value;
    const duration=action==='death'?5.2:action==='reload'?WEAPONS.british.reload:action==='melee'?MELEE_ANIMATION_SECONDS:action==='jump'?1.6:action==='fire'?1.8:action==='hit'?1.4:action==='switch'?WEAPON_SWITCH_SECONDS:action==='grenade-bash'?1.1:4.5;
    if(soldierPlaying){soldierTime=Math.min(1,soldierTime+delta/duration);soldierTimeline.value=String(Math.round(soldierTime*1000));if(soldierTime===1){soldierPlaying=false;soldierPlay.textContent='Play soldier action';}}
    const t=soldierTime*duration;
    const travelAngle=Number(soldierDirection.value)*Math.PI/180,forward=Math.cos(travelAngle),sideways=Math.sin(travelAngle);
    const smooth=(n:number)=>{const v=Math.max(0,Math.min(1,n));return v*v*(3-2*v);};
    const stanceWeight=smooth((t-.30)/.65)-smooth((t-3.30)/.65);
    for(let i=0;i<soldiers.children.length;i++) {
      const model=soldiers.children[i] as THREE.Group,faction=FACTIONS[i];
      const speed=action==='walk'?1.7:action==='run'?4.5:action==='crouch-walk'?1.3:0;
      const launch=.3,land=launch+2*RULES.jump/RULES.gravity,airTime=t-launch;
      const airborne=action==='jump'&&t>=launch&&t<land;
      model.position.y=airborne?RULES.jump*airTime-.5*RULES.gravity*airTime*airTime:0;
      const actor:SoldierActor={id:i,x:0,y:0,z:0,yaw:0,pitch:Number(soldierPitch.value)/180*Math.PI+(action==='aim'?Math.sin(t*1.7)*.42:0),stance:['crouch','crouch-walk'].includes(action)?'crouch':action==='prone'?'prone':'stand',alive:action!=='death'||t<.35||t>=4.6,moving:speed,ads:!['idle','walk','run','crouch-walk','jump','reload','grenade','grenade-bash','switch'].includes(action),recoil:action==='fire'&&t>=.2?Math.exp(-(t-.2)*7)*.07:0,cooldown:0,reload:action==='reload'?WEAPONS[faction].reload*(1-soldierTime):0,reloadTotal:WEAPONS[faction].reload,deadAt:.35,lastShotTime:action==='fire'?.2:-Infinity,lastHurtTime:action==='hit'?.15:-Infinity,lastMeleeTime:action==='grenade-bash'?.15:-Infinity,selectedWeapon:['grenade','grenade-bash','switch'].includes(action)?'grenade':'rifle',switchFrom:'rifle',switchStarted:action==='switch'?0:-Infinity,switchDuration:WEAPON_SWITCH_SECONDS,deathYaw:i===0?Math.PI:i===1?0:Math.PI/2,grounded:!airborne,vy:airborne?RULES.jump-RULES.gravity*airTime:0,jumpStarted:action==='jump'&&t>=launch?launch:-Infinity,landedAt:action==='jump'&&t>=land?land:-Infinity,landingSpeed:action==='jump'?RULES.jump:0};
      Object.assign(actor,{lean:Number(soldierLean.value)/100,lastMeleeTime:action==='melee'?0:actor.lastMeleeTime});
      const crouch=action==='crouch-walk'?1:action==='crouch'?stanceWeight:0,prone=action==='prone'?stanceWeight:0;
      actor.pose={phase:t*gaitRate(speed,crouch,prone)+i*.19,crouch,prone,aim:Number(actor.ads),speed,forward,sideways};
      if(i===0){
        const travel=groundTravel.checked?speed*t:0,yaw=model.rotation.y;
        grid.position.x=(-travel*(sideways*Math.cos(yaw)+forward*Math.sin(yaw)))%.5;
        grid.position.z=(-travel*(forward*Math.cos(yaw)-sideways*Math.sin(yaw)))%.5;
      }
      actor.x=model.position.x;actor.y=model.position.y;actor.z=model.position.z;actor.yaw=model.rotation.y;
      const pose=sampleSoldierPose(actor,faction,t,actor.pose);
      applySoldierPose(model,pose);
      hitDebug[i].visible=hitVolumes.checked;
      if(hitVolumes.checked)hitDebug[i].update(sampleHitVolumes({...actor,faction,lean:actor.lean??0},t));
      if(i===0)soldierPhase.textContent=`${pose.stage} · ${t.toFixed(2)} s`;
    }
  }
  if(mode!=='soldiers') {
    const action=animation.value as InspectorAction,switching=action.startsWith('switch-');
    const duration=switching?WEAPON_SWITCH_SECONDS:action==='reload'?WEAPONS[mode].reload:(action==='melee'||action==='grenade-melee')?MELEE_ANIMATION_SECONDS:WEAPONS[mode].cycle;
    if(playing){animationTime=Math.min(1,animationTime+delta/duration);timeline.value=String(Math.round(animationTime*1000));if(animationTime===1){playing=false;play.textContent='Play';}}
    const switchPose=sampleWeaponSwitch(switching?animationTime:1),grenadePose=action==='grenade-melee'?sampleGrenadeMelee(animationTime):sampleGrenadeReadyPose();
    const showsGrenade=action.startsWith('grenade-')||(switching&&(action==='switch-to-grenade'?switchPose.item==='to':switchPose.item==='from'));
    const align=sights.checked?(action==='reload'||switching?Math.exp(-14*animationTime*duration):1):0;
    const pose=sampleFirstPersonWeaponAnimation(mode,switching||action.startsWith('grenade-')?'idle':action as WeaponAction,animationTime,mode==='british',undefined,align);
    const rifle=weapons.get(mode)!,grenade=grenades.get(mode)!;
    rifle.visible=!showsGrenade&&!switchPose.hidden;grenade.visible=showsGrenade&&!switchPose.hidden;
    const first=sights.checked||firstPerson.checked,visual=getRifleVisuals(mode);
    // Reloading and switching cancel ADS in the simulation. Review the same
    // camera/weapon decay as the game, instead of a physically impossible
    // permanently shouldered reload selected only in this development tool.
    const viewAlign=showsGrenade?0:align*(1-(pose.unshoulder??0));
    const fieldOfView=first?THREE.MathUtils.lerp(HIP_WEAPON_FOV,ADS_WEAPON_FOV,viewAlign):37;
    if(camera.fov!==fieldOfView){camera.fov=fieldOfView;camera.updateProjectionMatrix();}
    axisMarker.style.display=axis.checked&&viewAlign>.99?'block':'none';
    rifle.position.set((first?THREE.MathUtils.lerp(VIEWMODEL_HIP_POSITION[0],-visual.sightX,viewAlign):0)+pose.position[0]+switchPose.position[0],(first?THREE.MathUtils.lerp(VIEWMODEL_HIP_POSITION[1],-visual.sightY,viewAlign):0)+pose.position[1]+switchPose.position[1],(first?THREE.MathUtils.lerp(VIEWMODEL_HIP_POSITION[2],visual.adsZ,viewAlign):0)+pose.position[2]+switchPose.position[2]);
    rifle.rotation.set(pose.rotation[0]+switchPose.rotation[0]+visual.adsRotation[0]*viewAlign,(first?THREE.MathUtils.lerp(-.035,0,viewAlign):0)+pose.rotation[1]+switchPose.rotation[1]+visual.adsRotation[1]*viewAlign,pose.rotation[2]+switchPose.rotation[2]+visual.adsRotation[2]*viewAlign);
    rifle.updateMatrix();applyWeaponAnimation(rifle,pose,first?rifle.matrix:undefined);
    if(viewAlign>0&&keepADSBoltInFront(rifle,rifle,camera,viewAlign)>0){rifle.updateMatrix();applyWeaponAnimation(rifle,pose,rifle.matrix);}
    grenade.position.set((first?VIEWMODEL_GRENADE_POSITION[0]:0)+grenadePose.position[0]+switchPose.position[0],(first?VIEWMODEL_GRENADE_POSITION[1]:0)+grenadePose.position[1]+switchPose.position[1],(first?VIEWMODEL_GRENADE_POSITION[2]:0)+grenadePose.position[2]+switchPose.position[2]);
    grenade.rotation.set(grenadePose.rotation[0]+switchPose.rotation[0],grenadePose.rotation[1]+switchPose.rotation[1],grenadePose.rotation[2]+switchPose.rotation[2]);
    grenade.updateMatrix();applyGrenadePose(grenade,grenadePose,first?grenade.matrix:undefined);
    phase.textContent=`${switching?switchPose.stage:showsGrenade?grenadePose.stage:pose.stage} · ${Math.round(animationTime*100)}%`;
  }
  // These are the production effect factories and absolute-age samplers. The
  // independent slider freezes any phase without depending on browser timing.
  const effectSeconds=Number(effectAge.value)/1000;effectPhase.textContent=`${effectAge.value} ms`;
  localFlash.visible=worldFlash.visible=bloodEffect.visible=false;effectLight.intensity=0;
  if(effectSelect.value==='muzzle'){
    const anchor=mode==='soldiers'?soldiers.children[1].getObjectByName('muzzle-anchor'):weapons.get(mode)?.getObjectByName('inspector-muzzle-anchor');
    let visible=Boolean(anchor);for(let parent=anchor;parent;parent=parent.parent??undefined)if(!parent.visible)visible=false;
    if(anchor&&visible){const flash=mode==='soldiers'?worldFlash:localFlash;placeMuzzleFlash(flash,anchor);effectLight.position.copy(flash.position);updateMuzzleFlash(flash,effectSeconds,effectLight,100000);}
  }else if(effectSelect.value==='blood'){
    bloodEffect.position.set(...(mode==='soldiers'?[0,1.25,.35]:(sights.checked||firstPerson.checked)?[.15,-.04,-1.55]:[0,.22,-.70]) as [number,number,number]);updateImpactEffect(bloodEffect,effectSeconds);
  }
  canvasRenderer.render(scene,camera);
  if(frame++%20===0) {
    let wrist='';
    if(mode!=='soldiers') {
      const rifle=weapons.get(mode)!,grenade=grenades.get(mode)!;
      const rig=rifle.visible?rifle.userData.handRig:grenade.visible?grenade.userData.grenadeRig:undefined;
      const arms=[['L',rig?.leftArm],['R',rig?.rightArm]] as const;
      const metrics=arms.filter(([,arm])=>arm).map(([side,arm]:readonly [string,ViewmodelArm])=>`${side} ${THREE.MathUtils.radToDeg(arm.wristBend).toFixed(1)}° / ${Math.max(0,arm.reachError*1000).toFixed(1)} mm`);
      if(metrics.length)wrist=` | Wrist / reach: ${metrics.join(' · ')}`;
    }
    stats.textContent=`Models: ${modelTriangles.toLocaleString()} triangles · ${modelMeshes} meshes | Rendered: ${canvasRenderer.info.render.triangles.toLocaleString()} triangles · ${canvasRenderer.info.render.calls} draw calls${wrist}`;
  }
});
