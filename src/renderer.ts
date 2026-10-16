import {EffectPool} from './effectPool';
import {sampleFirstPersonWeaponAnimation} from './firstPersonWeaponAnimation';
import * as THREE from 'three';
import {ARENA,BOXES,WEAPONS,RULES,MAP_SCALE,FACTIONS,clamp,lerp,type Faction} from './config';
import {ModelPool} from './modelPool';
import {prepareScenes,yieldLoadingPaint} from './scenePreparation';
import type {Actor,Game,Shot} from './engine';
import {batchArenaMeshes,reconcileActorModels,soldierContributesToView,type ActorModelEntry} from './renderOptimization';
import {makeRifle,getRifleVisuals,HIP_WEAPON_FOV,ADS_WEAPON_FOV} from './rifle';
import {makeSoldier} from './soldier';
import {IntroScene} from './introScene';
import {makeStielhandgranate} from './grenadeModel';
import {updateSoldier} from './soldierAnimation';
import {makeSurfaceMaterial,SURFACE_TILE_METERS} from './materials';
import {createOutdoorEnvironment} from './outdoorLighting';
import {weatherSurface,makeBoxContact} from './surfaceWeathering';
import {applyWeaponAnimation,sampleWeaponSwitch,sampleGrenadeReadyPose,sampleGrenadeMelee,applyGrenadePose,MELEE_ANIMATION_SECONDS,type WeaponAction} from './weaponAnimation';
import {makeMuzzleFlash,updateMuzzleFlash,placeMuzzleFlash,MUZZLE_FLASH_RADII,MUZZLE_FLASH_SECONDS,MUZZLE_EFFECT_SECONDS} from './weaponFeedback';
import {makeImpactEffect,updateImpactEffect,shotFeedbackSeed,IMPACT_SECONDS,MAX_WORLD_EFFECTS} from './impactFeedback';
import {sampleFirstPersonMotion} from './firstPersonMotion';
import {keepADSBoltInFront} from './weaponPresentation';
import {LEAN_CAMERA_RADIUS,leanEye} from './lean';
import {VIEWMODEL_HIP_POSITION,VIEWMODEL_GRENADE_POSITION} from './viewmodelArms';
const V=new THREE.Vector3();
function rand(seed:number){return()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};}
const mat=(color:number,roughness=.85)=>new THREE.MeshStandardMaterial({color,roughness});
function disposeModel(group:THREE.Object3D){const geometries=new Set<THREE.BufferGeometry>(),materials=new Set<THREE.Material>(),textures=new Set<THREE.Texture>(),skeletons=new Set<THREE.Skeleton>();group.traverse(o=>{if(o instanceof THREE.SkinnedMesh)skeletons.add(o.skeleton);if(o instanceof THREE.InstancedMesh)o.dispose();if(o instanceof THREE.Mesh){geometries.add(o.geometry);for(const material of Array.isArray(o.material)?o.material:[o.material]){materials.add(material);for(const value of Object.values(material))if(value instanceof THREE.Texture)textures.add(value);}}});geometries.forEach(g=>g.dispose());materials.forEach(m=>m.dispose());textures.forEach(t=>t.dispose());skeletons.forEach(s=>s.dispose());}
function box(parent:THREE.Object3D,w:number,h:number,d:number,x:number,y:number,z:number,material:THREE.Material,tile?:number){const geometry=new THREE.BoxGeometry(w,h,d);if(tile){const uv=geometry.getAttribute('uv'),faces=[[d,h],[d,h],[w,d],[w,d],[w,h],[w,h]];for(let face=0;face<6;face++)for(let i=0;i<4;i++){const index=face*4+i;uv.setXY(index,uv.getX(index)*faces[face][0]/tile,uv.getY(index)*faces[face][1]/tile);}uv.needsUpdate=true;}const mesh=new THREE.Mesh(geometry,material);mesh.position.set(x,y,z);mesh.castShadow=true;mesh.receiveShadow=true;mesh.userData.arenaStaticBatch=true;parent.add(mesh);return mesh;}
export class View {
 intro:IntroScene;grenade:THREE.Group|null=null;
 environment:THREE.WebGLRenderTarget;
 weaponSun=new THREE.DirectionalLight(0xfff2dc,2.5);
 worldSun=new THREE.DirectionalLight(0xfff4e3,3.0);
 private soldierRoster:ActorModelEntry<Actor,THREE.Group>[]=[];
 private viewFrustum=new THREE.Frustum();private viewProjection=new THREE.Matrix4();
 private shadowDirection=new THREE.Vector3(24,-40,-16).normalize();
 arenaBatches={before:0,after:0};
 private introFrameReady=false;
 private preparation?:Promise<void>;
 private readonly firstPersonModels=new Map<Faction,{rifle:THREE.Group;grenade:THREE.Group}>();
 private readonly soldierPool=new ModelPool<Faction,THREE.Group>(makeSoldier,model=>{
  delete model.userData.soldierState;delete model.userData.animationPose;delete model.userData.animationStage;delete model.userData.lastShadowTime;
  model.visible=false;model.position.set(0,0,0);model.rotation.set(0,0,0);model.scale.set(1,1,1);
 },disposeModel);
 weaponMeleeStart=-Infinity;weaponShotStart=-Infinity;weaponActor=-1;
 roundEnded=false;
 private effectPool?:EffectPool;
 private burstPool(){return this.effectPool??=new EffectPool(disposeModel);}
 renderer:THREE.WebGLRenderer;scene=new THREE.Scene();camera=new THREE.PerspectiveCamera(72,1,.05,150);weaponScene=new THREE.Scene();weaponCamera=new THREE.PerspectiveCamera(64,1,.01,8);weapon=new THREE.Group();rifle:THREE.Group|null=null;faction:Faction='british';soldiers:THREE.Group[]=[];ads=0;clock=0;bob=0;flash=new THREE.PointLight(0xffc278,0,7);effects:{mesh:THREE.Group;life:number;total:number;started:number;kind:'muzzle'|'impact';seed:number;anchor?:THREE.Object3D}[]=[];effectReplay=false;effectTime=-Infinity;menu=true;quality='high';lastReplayShot=-1;menuTarget=new THREE.Vector3(-3*MAP_SCALE,1.8,-8*MAP_SCALE);muzzle:THREE.Group;disposed=false;
 constructor(container:HTMLElement,renderer?:THREE.WebGLRenderer){
  this.renderer=renderer??new THREE.WebGLRenderer({antialias:true,powerPreference:'high-performance'});this.renderer.setPixelRatio(Math.min(devicePixelRatio,1.75));this.renderer.setSize(innerWidth,innerHeight);this.renderer.shadowMap.enabled=true;this.renderer.shadowMap.type=THREE.PCFSoftShadowMap;this.renderer.toneMapping=THREE.ACESFilmicToneMapping;this.renderer.toneMappingExposure=1.04;this.renderer.outputColorSpace=THREE.SRGBColorSpace;container.appendChild(this.renderer.domElement);
  this.scene.background=new THREE.Color(0xa6adb0);this.scene.fog=new THREE.Fog(0xa4aaa4,40,115);
  this.environment=createOutdoorEnvironment(this.renderer);
  this.scene.environment=this.weaponScene.environment=this.environment.texture;
  this.scene.environmentIntensity=.65;this.weaponScene.environmentIntensity=.95;
  this.scene.add(new THREE.HemisphereLight(0xdce7ef,0x666759,.92));
  const sun=this.worldSun;sun.shadow.autoUpdate=false;sun.shadow.needsUpdate=true;sun.position.set(-24,40,16);sun.castShadow=true;sun.shadow.mapSize.set(2048,2048);sun.shadow.camera.left=-27;sun.shadow.camera.right=27;sun.shadow.camera.top=27;sun.shadow.camera.bottom=-27;sun.shadow.camera.near=.5;sun.shadow.camera.far=100;sun.shadow.normalBias=.018;sun.shadow.bias=-.00015;sun.shadow.radius=3;this.scene.add(sun);
  this.buildArena();this.buildSky();this.intro=new IntroScene();
  this.intro.scene.environment=this.environment.texture;this.intro.scene.environmentIntensity=.5;
  this.weaponScene.add(new THREE.HemisphereLight(0xe4edf3,0x68685e,.95));
  // A separate close-range shadow frustum gives fingers, receiver cuts and
  // sleeve folds contact shading without spending arena shadow resolution.
  const gunSun=this.weaponSun;gunSun.position.set(-2,4,2);gunSun.target.position.set(0,-.1,-.65);
  gunSun.castShadow=true;gunSun.shadow.mapSize.set(2048,2048);
  Object.assign(gunSun.shadow.camera,{left:-1.7,right:1.7,top:1.7,bottom:-1.7,near:.1,far:12});
  gunSun.shadow.normalBias=.0015;gunSun.shadow.bias=-.000035;gunSun.shadow.radius=2;
  this.weaponScene.add(gunSun,gunSun.target,this.weapon);this.weapon.add(this.flash);
  this.muzzle=makeMuzzleFlash(MUZZLE_FLASH_RADII.local);this.weapon.add(this.muzzle);
  this.setFaction('british');this.resize();window.addEventListener('resize',()=>this.resize());
  this.renderer.domElement.addEventListener('webglcontextrestored',()=>{this.invalidateIntro();this.worldSun.shadow.needsUpdate=this.weaponSun.shadow.needsUpdate=true;});
 }
 setQuality(q:string,touch=false){this.quality=q;this.renderer.setPixelRatio(q==='high'?Math.min(devicePixelRatio,touch?1:1.75):1);this.renderer.shadowMap.enabled=q!=='low';const size=q==='high'?2048:1024;if(this.weaponSun.shadow.mapSize.x!==size){this.weaponSun.shadow.mapSize.set(size,size);this.weaponSun.shadow.map?.dispose();this.weaponSun.shadow.map=null;}this.worldSun.shadow.needsUpdate=true;this.intro.invalidateShadows();this.resize();}
 private updateCameraProjection(){
  const tangent=Math.tan(this.camera.fov*Math.PI/360);
  this.camera.near=Math.min(.05,.95*LEAN_CAMERA_RADIUS/Math.sqrt(1+tangent*tangent*(1+this.camera.aspect*this.camera.aspect)));
  this.camera.updateProjectionMatrix();
 }
 invalidateIntro(){this.introFrameReady=false;this.intro?.invalidateShadows();}
 resize(){this.invalidateIntro();this.camera.aspect=innerWidth/innerHeight;this.updateCameraProjection();this.weaponCamera.aspect=this.camera.aspect;this.weaponCamera.updateProjectionMatrix();this.renderer.setSize(innerWidth,innerHeight);this.intro?.resize(this.camera.aspect);}
 buildArena(){
  const ground=new THREE.Mesh(new THREE.PlaneGeometry(100,100),weatherSurface(makeSurfaceMaterial('dirt',{repeat:[100/SURFACE_TILE_METERS.dirt,100/SURFACE_TILE_METERS.dirt],normalStrength:.72,saturation:.82}),'ground'));ground.rotation.x=-Math.PI/2;ground.receiveShadow=true;this.scene.add(ground);
  const woodMat=weatherSurface(makeSurfaceMaterial('walnut',{color:new THREE.Color(.24,.37,.35),saturation:.5,rotation:Math.PI/2,roughnessRange:[.75,.96]}),'wood');
  const centralWood=weatherSurface(makeSurfaceMaterial('walnut',{color:new THREE.Color(.58,.56,.48),saturation:.68,rotation:Math.PI/2,roughnessRange:[.72,.95]}),'wood');
  const trim=mat(0x454c43),seam=mat(0x777d6f),stoneTrim=makeSurfaceMaterial('stone',{repeat:[.5,.2],color:0x939da1,normalStrength:.32});
  const wallMaterial=weatherSurface(makeSurfaceMaterial('stone',{repeat:[1,1],color:0xb0bec7,normalStrength:.85,saturation:.8}),'stone');
  const canvasTints=[new THREE.Color(.70,.98,1.28),new THREE.Color(.60,.86,1.16),new THREE.Color(.80,1.0,1.16),new THREE.Color(.68,.92,1.22)];
  for(const [index,b] of BOXES.entries()){
   if(b.kind==='wall'){
    box(this.scene,b.w,b.h,b.d,b.x,b.h/2,b.z,wallMaterial,SURFACE_TILE_METERS.stone);box(this.scene,b.w+.14,.23,b.d+.14,b.x,b.h+.1,b.z,stoneTrim);
   }else{
    const central=b.x===5*MAP_SCALE&&b.z===2*MAP_SCALE;const baseH=central?1.4:Math.min(.9,b.h*.38);
    const canvasMat=weatherSurface(makeSurfaceMaterial('canvas',{color:canvasTints[index%canvasTints.length],saturation:.45,normalStrength:.42,offset:[(index*.37)%1,(index*.61)%1]}),'canvas',[b.w+.035,b.h-baseH,b.d+.035]);
    box(this.scene,b.w,baseH,b.d,b.x,baseH/2,b.z,central?centralWood:woodMat,SURFACE_TILE_METERS.walnut);box(this.scene,b.w+.035,b.h-baseH,b.d+.035,b.x,baseH+(b.h-baseH)/2,b.z,canvasMat,SURFACE_TILE_METERS.canvas);
    for(const s of [-1,1]){box(this.scene,b.w+.06,.10,.07,b.x,.14,b.z+s*b.d/2,trim);box(this.scene,b.w+.06,.12,.075,b.x,baseH-.08,b.z+s*b.d/2,trim);box(this.scene,.07,.1,b.d,b.x+s*b.w/2,.15,b.z,trim);
     box(this.scene,.038,b.h-baseH,.046,b.x+s*(b.w/2-.05),baseH+(b.h-baseH)/2,b.z+b.d/2+.023,seam);
     box(this.scene,b.w+.07,.04,.038,b.x,b.h-.035,b.z+s*(b.d/2+.02),seam);
    }
    const shadow=makeBoxContact(b.w,b.d);shadow.position.set(b.x,.014,b.z);this.scene.add(shadow);
   }
  }
  // Small scattered stones and sparse dry grass retain the bare training-arena silhouette.
  const r=rand(17),rockGeo=new THREE.DodecahedronGeometry(1,0),rocks=new THREE.InstancedMesh(rockGeo,mat(0x777767),280),m=new THREE.Object3D();
  for(let i=0;i<280;i++){const s=.02+r()*.095;m.position.set((r()-.5)*ARENA.width,.018,(r()-.5)*ARENA.depth);m.scale.set(s,s*.35,s*.8);m.rotation.set(r(),r()*6,r());m.updateMatrix();rocks.setMatrixAt(i,m.matrix);}rocks.receiveShadow=true;this.scene.add(rocks);
  const grassMat=mat(0x73724b);for(let i=0;i<90;i++){const x=(r()-.5)*(ARENA.width-1),z=(r()-.5)*(ARENA.depth-1);if(Math.abs(x)<ARENA.width/2-3&&Math.abs(z)<ARENA.depth/2-3&&r()>.15)continue;const grass=new THREE.Group();for(let j=0;j<3;j++){const blade=box(grass,.012,.13+r()*.18,.008,(r()-.5)*.12,.09,(r()-.5)*.1,grassMat);blade.rotation.z=(r()-.5)*.8;}grass.position.set(x,0,z);this.scene.add(grass);}
  this.arenaBatches=batchArenaMeshes(this.scene);
 }
 buildSky(){
  const sky=new THREE.Mesh(new THREE.SphereGeometry(110,24,16),new THREE.ShaderMaterial({side:THREE.BackSide,depthWrite:false,uniforms:{},vertexShader:'varying vec3 vPosition;void main(){vPosition=position;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',fragmentShader:`varying vec3 vPosition;
   float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}float noise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1)),f.x),f.y);}
   void main(){vec3 d=normalize(vPosition);vec2 p=d.xz/(max(d.y,.08)+.35)*2.;float n=noise(p*2.)*.55+noise(p*4.)*.25+noise(p*9.)*.13+noise(p*19.)*.07;vec3 base=mix(vec3(.65,.69,.70),vec3(.43,.52,.59),max(d.y,0.));gl_FragColor=vec4(mix(base,vec3(.8,.81,.78),smoothstep(.32,.70,n)*.88),1.);}`}));this.scene.add(sky);
 }
 private firstPersonModel(faction:Faction){
  let models=this.firstPersonModels.get(faction);
  if(!models){models={rifle:makeRifle(faction,true),grenade:makeStielhandgranate(faction,true)};this.firstPersonModels.set(faction,models);}
  return models;
 }
 setFaction(faction:Faction){
  if(this.faction===faction&&this.rifle)return;
  this.faction=faction;this.rifle?.removeFromParent();this.grenade?.removeFromParent();
  const models=this.firstPersonModel(faction);this.rifle=models.rifle;this.grenade=models.grenade;
  this.rifle.visible=true;this.grenade.visible=false;this.weapon.add(this.rifle,this.grenade);
  this.muzzle.position.set(...getRifleVisuals(faction).muzzle);this.muzzle.position.z-=.012;this.flash.position.copy(this.muzzle.position);
 }
 /** Startup intentionally spends construction/upload/compilation time here,
  * before controls become ready. Reserves are reused by normal actor creation;
  * at most one idle soldier per faction and three viewmodel pairs are retained. */
 prepare(onProgress?:(value:number)=>void):Promise<void>{
  return this.preparation??=this.prepareModels(onProgress);
 }
 private async prepareModels(onProgress?:(value:number)=>void){
  const reserves:THREE.Group[]=[],attached:THREE.Object3D[]=[],warmEffects:THREE.Group[]=[];
  try{
   onProgress?.(0);
   for(const faction of FACTIONS){
    await yieldLoadingPaint();
    const model=this.soldierPool.acquire(faction);reserves.push(model);this.scene.add(model);
    const pair=this.firstPersonModel(faction);
    for(const object of [pair.rifle,pair.grenade])if(object.parent!==this.weapon){this.weapon.add(object);attached.push(object);}
    onProgress?.(.25*reserves.length/(FACTIONS.length+1));
   }
   await yieldLoadingPaint();
   const shot:Shot={time:0,actor:0,origin:{x:0,y:1,z:0},end:{x:0,y:1,z:-4},hit:null,headshot:false,kind:'shot'};
   const muzzle=this.burstPool().acquireMuzzle();updateMuzzleFlash(muzzle,.025);
   const dust=this.burstPool().acquireImpact(shot),blood=this.burstPool().acquireImpact({...shot,hit:1});
   updateImpactEffect(dust,.025);updateImpactEffect(blood,.025);warmEffects.push(muzzle,dust,blood);this.scene.add(...warmEffects);
   onProgress?.(.25);
   await prepareScenes(this.renderer,[{scene:this.scene,camera:this.camera},{scene:this.weaponScene,camera:this.weaponCamera},{scene:this.intro.scene,camera:this.intro.camera}],value=>onProgress?.(.25+.75*value));
  }finally{
   for(const effect of warmEffects)this.burstPool().release(effect);
   for(const object of attached)object.removeFromParent();
   for(const model of reserves){model.removeFromParent();this.soldierPool.release(model);}
   this.worldSun.shadow.needsUpdate=this.weaponSun.shadow.needsUpdate=true;this.invalidateIntro();
  }
 }
 setupActors(game:Game){this.roundEnded=false;this.weaponActor=-1;this.weaponMeleeStart=this.weaponShotStart=-Infinity;updateMuzzleFlash(this.muzzle,Infinity,this.flash);for(const s of this.soldiers){this.scene.remove(s);this.soldierPool.release(s);}this.soldierRoster=[];this.soldiers=[];this.clearEffects();this.effectReplay=false;this.effectTime=-Infinity;this.syncActors(game);this.ads=0;this.lastReplayShot=-1;}
 syncActors(game:Game){
  this.soldierRoster=reconcileActorModels(this.soldierRoster,game.actors,actor=>{const model=this.soldierPool.acquire(actor.faction);this.scene.add(model);return model;},model=>{
   // A departing actor's already-emitted flash keeps its last world position.
   for(const effect of this.effects)if(effect.anchor){let parent:THREE.Object3D|null=effect.anchor;while(parent&&parent!==model)parent=parent.parent;if(parent===model)effect.anchor=undefined;}
   this.scene.remove(model);this.soldierPool.release(model);
  });
  this.soldiers=this.soldierRoster.map(entry=>entry.model);this.worldSun.shadow.needsUpdate=true;
  const viewed=game.state==='killcam'?game.actors[game.killer]:game.viewedActor;
  if(viewed&&this.faction!==viewed.faction){this.setFaction(viewed.faction);this.weaponActor=-1;this.weaponMeleeStart=this.weaponShotStart=-Infinity;this.ads=0;updateMuzzleFlash(this.muzzle,Infinity,this.flash);}
 }
 clearEffects(){for(const effect of this.effects)this.burstPool().release(effect.mesh);this.effects=[];}
 clearRoundActions(game:Game){
  this.weaponMeleeStart=this.weaponShotStart=-Infinity;this.weaponActor=-1;this.ads=0;this.bob=0;this.lastReplayShot=-1;
  updateMuzzleFlash(this.muzzle,Infinity,this.flash);
  this.clearEffects();
  // The stopped simulation clock cannot decay the old locomotion/aim blends.
  // Rebuild only living rigs from the engine's neutral state; corpses retain
  // their exact current pose and recorded death animation state.
  for(let i=0;i<this.soldiers.length;i++)if(game.actors[i]?.alive)delete this.soldiers[i].userData.soldierState;
 }
 effect(shot:Shot,local:boolean,elapsed=0){
  const melee=shot.kind==='melee';
  if(local){if(melee)this.weaponMeleeStart=shot.time;else this.weaponShotStart=shot.time;}
  const delta=new THREE.Vector3(shot.end.x-shot.origin.x,shot.end.y-shot.origin.y,shot.end.z-shot.origin.z),len=delta.length();
  const seed=shotFeedbackSeed(shot);
  if(len<119&&elapsed>=0&&elapsed<IMPACT_SECONDS&&(!melee||shot.hit!==null)){
   const mesh=this.burstPool().acquireImpact(shot);updateImpactEffect(mesh,elapsed);this.scene.add(mesh);this.effects.push({mesh,life:IMPACT_SECONDS-elapsed,total:IMPACT_SECONDS,started:shot.time,kind:'impact',seed});
  }
  if(!local&&!melee&&elapsed>=0&&elapsed<MUZZLE_EFFECT_SECONDS){const spark=this.burstPool().acquireMuzzle(),anchor=this.soldiers[shot.actor]?.getObjectByName('muzzle-anchor');if(anchor)placeMuzzleFlash(spark,anchor);else{spark.position.set(shot.origin.x,shot.origin.y,shot.origin.z);if(len>0)spark.quaternion.setFromUnitVectors(new THREE.Vector3(0,0,-1),delta.normalize());}updateMuzzleFlash(spark,elapsed,undefined,seed);this.scene.add(spark);this.effects.push({mesh:spark,life:MUZZLE_EFFECT_SECONDS-elapsed,total:MUZZLE_EFFECT_SECONDS,started:shot.time,kind:'muzzle',seed,anchor});}
  while(this.effects.length>MAX_WORLD_EFFECTS){const oldest=this.effects.shift()!;this.burstPool().release(oldest.mesh);}
 }
 render(game:Game,dt:number,inMenu:boolean,intro=true,remoteTime=game.time,localPosition:{x:number;y:number;z:number}|null=null){
  this.clock+=dt;this.menu=inMenu;
  if(inMenu&&intro&&this.introFrameReady)return;
  if(!inMenu||!intro)this.introFrameReady=false;
  const ended=game.state==='ended';if(ended&&!this.roundEnded)this.clearRoundActions(game);this.roundEnded=ended;
  const replay=game.state==='killcam',spectating=!!game.player?.spectator;
  if(spectating)game.spectator.sync(game.actors);
  const viewedId=replay?game.killer:spectating?game.spectator.targetId:0;const frame=replay?game.replayFrame():null;const actors=frame?.actors??game.actors;
  if(replay!==Boolean(this.effectReplay)||replay&&game.replayTime<this.effectTime){this.clearEffects();this.lastReplayShot=-Infinity;}this.effectReplay=replay;this.effectTime=replay?game.replayTime:game.time;
  if(inMenu){const t=this.clock*.035;this.camera.position.set(17*MAP_SCALE+Math.sin(t)*1.0,5.0+Math.sin(t*.7)*.3,21*MAP_SCALE);this.camera.lookAt(this.menuTarget);this.camera.fov=62;this.updateCameraProjection();}
  else{
   const a=viewedId===null?undefined:actors[viewedId];if(a){this.ads=lerp(this.ads,a.ads?1:0,1-Math.exp(-dt*14));const eye=leanEye(a);
    this.camera.position.set(eye.x,eye.y,eye.z);
    if(localPosition&&!replay&&!spectating){this.camera.position.x+=localPosition.x-a.x;this.camera.position.y+=localPosition.y-a.y;this.camera.position.z+=localPosition.z-a.z;}
    const pitch=a.pitch+a.recoil;V.set(Math.sin(a.yaw)*Math.cos(pitch),Math.sin(pitch),Math.cos(a.yaw)*Math.cos(pitch));this.camera.up.set(0,1,0);this.camera.lookAt(this.camera.position.clone().add(V));this.camera.fov=lerp(72,49,this.ads);this.updateCameraProjection();
    const live={...game.actors[a.id],...a};
    if(this.weaponActor!==a.id){this.weaponActor=a.id;this.weaponMeleeStart=this.weaponShotStart=-Infinity;}
    if(this.faction!==live.faction)this.setFaction(live.faction);
    const visualTime=replay?game.replayTime:spectating?remoteTime:game.time;
    if(spectating){this.weaponMeleeStart=live.lastMeleeTime;this.weaponShotStart=live.lastShotTime;}
    const motion=sampleFirstPersonMotion({...live,ads:this.ads},visualTime);
    if(replay){
     this.weaponMeleeStart=this.weaponShotStart=-Infinity;
     for(const shot of game.replayShots)if(shot.actor===a.id&&shot.time<=visualTime){if(shot.kind==='melee')this.weaponMeleeStart=shot.time;else if(shot.kind==='shot')this.weaponShotStart=shot.time;}
    }
    const meleeElapsed=visualTime-this.weaponMeleeStart,shotElapsed=visualTime-this.weaponShotStart;
    let action:WeaponAction='idle',progress=0;
    if(meleeElapsed>=0&&meleeElapsed<MELEE_ANIMATION_SECONDS){action='melee';progress=meleeElapsed/MELEE_ANIMATION_SECONDS;}
    else if(live.reload>0){action='reload';progress=1-live.reload/live.reloadTotal;}
    else if(shotElapsed>=0&&shotElapsed<WEAPONS[live.faction].cycle){action='cycle';progress=shotElapsed/WEAPONS[live.faction].cycle;}
    const pose=sampleFirstPersonWeaponAnimation(live.faction,action,progress,live.faction==='british'&&live.reloadTotal>WEAPONS.british.reload*.8,undefined,this.ads);
    const switching=visualTime-live.switchStarted<live.switchDuration&&visualTime>=live.switchStarted;
    const swap=sampleWeaponSwitch(switching?(visualTime-live.switchStarted)/live.switchDuration:1);
    const slot=switching&&swap.item==='from'?live.switchFrom:live.selectedWeapon;
    const grenadePose=action==='melee'?sampleGrenadeMelee(progress):sampleGrenadeReadyPose();
    const activePose=slot==='grenade'?grenadePose:pose,visual=getRifleVisuals(live.faction);
    // A buttstock strike leaves the shoulder even when aim remains held. Only
    // presentation changes; input and the aiming state survive the recovery.
    const align=slot==='rifle'?this.ads*(1-(pose.unshoulder??0)):0;
    this.weaponCamera.fov=lerp(HIP_WEAPON_FOV,ADS_WEAPON_FOV,align);this.weaponCamera.updateProjectionMatrix();
    const hip=slot==='grenade'?VIEWMODEL_GRENADE_POSITION:VIEWMODEL_HIP_POSITION;
    this.weapon.position.set(lerp(hip[0],-visual.sightX,align)+motion.position[0]+activePose.position[0]+swap.position[0],lerp(hip[1],-visual.sightY,align)+motion.position[1]+activePose.position[1]+swap.position[1],lerp(hip[2],visual.adsZ,align)+Math.min(.11,a.recoil*1.8)+activePose.position[2]+swap.position[2]);
    this.weapon.rotation.set(a.recoil*1.1+motion.rotation[0]+activePose.rotation[0]+swap.rotation[0]+visual.adsRotation[0]*align,lerp(slot==='rifle'?-.035:0,0,align)+activePose.rotation[1]+swap.rotation[1]+visual.adsRotation[1]*align,motion.rotation[2]+activePose.rotation[2]+swap.rotation[2]+visual.adsRotation[2]*align);
    this.weapon.updateMatrix();
    if(this.rifle){
     this.rifle.visible=slot==='rifle'&&!swap.hidden;
     if(this.rifle.visible)applyWeaponAnimation(this.rifle,pose,this.weapon.matrix);
     // The bolt-clearance guard can shift the rifle after its mechanical pose.
     // Resolve the arms again in that final frame so shoulders stay on the body.
     if(this.rifle.visible&&keepADSBoltInFront(this.weapon,this.rifle,this.weaponCamera,align)>0){this.weapon.updateMatrix();applyWeaponAnimation(this.rifle,pose,this.weapon.matrix);}
    }
    if(this.grenade){this.grenade.visible=slot==='grenade'&&!swap.hidden;if(this.grenade.visible)applyGrenadePose(this.grenade,grenadePose,this.weapon.matrix);}

   }else if(spectating){
    const {position,yaw,pitch}=game.spectator;this.ads=0;this.weaponActor=-1;this.weaponMeleeStart=this.weaponShotStart=-Infinity;
    this.camera.position.set(position.x,position.y,position.z);V.set(Math.sin(yaw)*Math.cos(pitch),Math.sin(pitch),Math.cos(yaw)*Math.cos(pitch));this.camera.up.set(0,1,0);this.camera.lookAt(this.camera.position.clone().add(V));this.camera.fov=72;this.updateCameraProjection();
   }
  }
  this.camera.updateMatrixWorld();this.viewProjection.multiplyMatrices(this.camera.projectionMatrix,this.camera.matrixWorldInverse);this.viewFrustum.setFromProjectionMatrix(this.viewProjection);
  for(let i=0;i<this.soldiers.length;i++){
   const model=this.soldiers[i],a=actors[i],time=replay?game.replayTime:i===0?game.time:remoteTime;
   const visible=!inMenu&&!!a&&!a.spectator&&i!==viewedId&&soldierContributesToView(this.viewFrustum,a,this.renderer.shadowMap.enabled?this.shadowDirection:null);
   if(model.visible!==visible)this.worldSun.shadow.needsUpdate=true;
   if(a){
    updateSoldier(model,a,dt,time,visible);
    if(visible&&model.userData.lastShadowTime!==time)this.worldSun.shadow.needsUpdate=true;
    if(visible)model.userData.lastShadowTime=time;
   }
   model.visible=visible;
  }
  if(replay){for(const s of game.replayShots)if(s.time>this.lastReplayShot&&s.time<=game.replayTime){this.effect(s,s.actor===game.killer,game.replayTime-s.time);}this.lastReplayShot=game.replayTime;}else this.lastReplayShot=-1;
  const visualTime=replay?game.replayTime:game.time;
  updateMuzzleFlash(this.muzzle,inMenu||ended||viewedId===null||!actors[viewedId]?.alive||!this.rifle?.visible?Infinity:(spectating?remoteTime:visualTime)-this.weaponShotStart,this.flash,Math.round(this.weaponShotStart*10000));
  for(let i=this.effects.length-1;i>=0;i--){const e=this.effects[i],elapsed=visualTime-e.started;e.life=e.total-elapsed;if(elapsed<0||e.life<=0){this.burstPool().release(e.mesh);this.effects.splice(i,1);continue;}if(e.kind==='muzzle'){if(e.anchor&&elapsed<MUZZLE_FLASH_SECONDS)placeMuzzleFlash(e.mesh,e.anchor);updateMuzzleFlash(e.mesh,elapsed,undefined,e.seed);}else updateImpactEffect(e.mesh,elapsed);}
  this.renderer.autoClear=true;if(inMenu&&intro){this.renderer.render(this.intro.scene,this.intro.camera);this.introFrameReady=true;}else this.renderer.render(this.scene,this.camera);
  // A corpse keeps its world pose, but a waiting/dead view has no first-person
  // weapon. A living killer's recorded weapon remains visible during replay.
  if(!inMenu&&viewedId!==null&&actors[viewedId]?.alive){this.renderer.autoClear=false;this.renderer.clearDepth();this.renderer.render(this.weaponScene,this.weaponCamera);this.renderer.autoClear=true;}
 }
}
