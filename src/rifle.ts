import {sampleFirstPersonWeaponAnimation} from './firstPersonWeaponAnimation';
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { WEAPONS, type Faction } from './config';
import {applyWeaponAnimation} from './weaponAnimation';
import {makeAnatomicalHand,configureRifleHand} from './hands';
import {makeSurfaceMaterial} from './materials';
import {makeModelDetail} from './modelDetails';
import {makeViewmodelArm} from './viewmodelArms';
import {getImportedWeaponProfile,makeImportedWeapon,type WeaponPoint} from './importedWeapons';

// The top of each front post and the optical axis are identical in model space.
// Only the weapon presentation changes: ballistics still leave the camera aim ray.
export const RIFLE_VISUALS = {
  british: { muzzleZ: -1.27, sightY: .12, frontZ: -1.19, rearZ: -.30, adsZ: -.015, description: 'Aperture rear · protected blade front' },
  russian: { muzzleZ: -1.46, sightY: .108, frontZ: -1.40, rearZ: -.57, adsZ: -.015, description: 'Open notch rear · fine hooded post front' },
  german: { muzzleZ: -1.18, sightY: .103, frontZ: -1.12, rearZ: -.55, adsZ: -.015, description: 'Open notch rear · exposed barleycorn front' },
} as const;

export const HIP_WEAPON_FOV=64;
export const ADS_WEAPON_FOV=48;
// Keep the complete receiver in front of the eye as the bolt travels back.
// A narrower weapon-only lens supplies the closer shouldered presentation
// without changing world zoom, the aim ray, or the source model's proportions.
const ADS_POSITION_Z:Record<Faction,number>={british:0,russian:.06,german:.04};

export function getRifleVisuals(faction:Faction) {
  const fallback=RIFLE_VISUALS[faction],profile=getImportedWeaponProfile(faction);
  if(!profile)return {...fallback,sightX:0,muzzle:[0,.031,fallback.muzzleZ] as WeaponPoint,adsRotation:[0,0,0] as WeaponPoint,worldScale:.82};
  const direction=new THREE.Vector3(...profile.frontSight).sub(new THREE.Vector3(...profile.rearSight)).normalize();
  const alignment=new THREE.Quaternion().setFromUnitVectors(direction,new THREE.Vector3(0,0,-1));
  const rear=new THREE.Vector3(...profile.rearSight).applyQuaternion(alignment),rotation=new THREE.Euler().setFromQuaternion(alignment);
  return {muzzleZ:profile.muzzle[2],sightY:rear.y,sightX:rear.x,frontZ:profile.frontSight[2],rearZ:profile.rearSight[2],adsZ:ADS_POSITION_Z[faction],
    description:faction==='british'?'SMLE Mk III source sights':fallback.description,muzzle:[...profile.muzzle] as WeaponPoint,adsRotation:[rotation.x,rotation.y,rotation.z] as WeaponPoint,worldScale:profile.worldScale??.82};
}

function material(color:number,metalness=0,roughness=.7) {
  return new THREE.MeshStandardMaterial({ color, metalness, roughness });
}
function mesh(parent:THREE.Object3D,geometry:THREE.BufferGeometry,mat:THREE.Material,x=0,y=0,z=0) {
  const m=new THREE.Mesh(geometry,mat);m.position.set(x,y,z);m.castShadow=m.receiveShadow=true;parent.add(m);return m;
}
function rounded(parent:THREE.Object3D,w:number,h:number,d:number,x:number,y:number,z:number,mat:THREE.Material,r=.005) {
  return mesh(parent,new RoundedBoxGeometry(w,h,d,2,Math.min(r,w/3,h/3,d/3)),mat,x,y,z);
}
function rod(parent:THREE.Object3D,r:number,length:number,x:number,y:number,z:number,mat:THREE.Material,axis:'y'|'z'|'x'='z',r2=r) {
  const m=mesh(parent,new THREE.CylinderGeometry(r,r2,length,24,1),mat,x,y,z);
  if(axis==='z')m.rotation.x=Math.PI/2;else if(axis==='x')m.rotation.z=Math.PI/2;return m;
}
function ellipsoid(parent:THREE.Object3D,r:number,x:number,y:number,z:number,sx:number,sy:number,sz:number,mat:THREE.Material) {
  const m=mesh(parent,new THREE.SphereGeometry(r,24,16),mat,x,y,z);m.scale.set(sx,sy,sz);return m;
}
function link(parent:THREE.Object3D,a:number[],b:number[],r:number,mat:THREE.Material,r2=r) {
  const va=new THREE.Vector3(...a),vb=new THREE.Vector3(...b),delta=vb.clone().sub(va);
  const m=rod(parent,r,delta.length(),...va.clone().add(vb).multiplyScalar(.5).toArray() as [number,number,number],mat,'y',r2);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0),delta.normalize());return m;
}
function stock(parent:THREE.Object3D,wood:THREE.Material,faction:Faction){
  const profile=new THREE.Shape();
  profile.moveTo(-.215,.007);profile.lineTo(-.225,-.155);profile.quadraticCurveTo(-.03,-.15,.10,-.07);
  if(faction==='british'){profile.quadraticCurveTo(.17,-.058,.22,-.087);profile.lineTo(.275,-.055);profile.lineTo(.28,.005);profile.lineTo(.21,.025);}
  else {profile.quadraticCurveTo(.20,-.055,.26,-.082);profile.lineTo(.41,-.052);profile.lineTo(.42,.011);profile.lineTo(.29,.018);}
  profile.quadraticCurveTo(.06,-.035,-.06,.009);profile.closePath();
  const g=new THREE.ExtrudeGeometry(profile,{depth:.068,bevelEnabled:true,bevelSegments:4,steps:1,bevelSize:.012,bevelThickness:.012,curveSegments:12});
  const s=mesh(parent,g,wood,-.034,0,0);s.rotation.y=Math.PI/2;
}
function notch(parent:THREE.Object3D,z:number,y:number,style:'u'|'v',steel:THREE.Material){
  // Extruded polygon leaves a genuine opening instead of painting a notch.
  const halfWidth=style==='v'?.047:.043,cut=style==='v'?.010:.006;
  const s=new THREE.Shape();s.moveTo(-halfWidth,y-.025);s.lineTo(halfWidth,y-.025);s.lineTo(halfWidth,y+.003);s.lineTo(cut,y+.003);
  if(style==='v'){s.lineTo(.007,y-.010);s.quadraticCurveTo(0,y-.016,-.007,y-.010);}else {s.lineTo(.005,y-.004);s.quadraticCurveTo(0,y-.008,-.005,y-.004);}
  s.lineTo(-cut,y+.003);s.lineTo(-halfWidth,y+.003);s.closePath();
  mesh(parent,new THREE.ExtrudeGeometry(s,{depth:.008,bevelEnabled:false,steps:1}),steel,0,0,z);
}
function mergeStatic(group:THREE.Group){
  group.updateMatrixWorld(true);const buckets=new Map<THREE.Material,THREE.BufferGeometry[]>();
  group.traverse(o=>{if(o instanceof THREE.Mesh&&!Array.isArray(o.material)){const g=o.geometry.index?o.geometry.toNonIndexed():o.geometry.clone();for(const name of Object.keys(g.attributes))if(!['position','normal','uv'].includes(name))g.deleteAttribute(name);g.applyMatrix4(o.matrixWorld);buckets.set(o.material,[...(buckets.get(o.material)??[]),g]);o.geometry.dispose();}});
  group.clear();for(const [mat,geos] of buckets){const g=mergeGeometries(geos,false);geos.forEach(v=>v.dispose());if(g)mesh(group,g,mat);}
}

function makeHand(side:'left'|'right',skin:THREE.Material,cuff:THREE.Material) {
  const anatomical=makeAnatomicalHand(side);
  if(anatomical){
    configureRifleHand(anatomical,true);
    if(side==='right') {
      const wrist=(anatomical.userData.wristSkinLocal as THREE.Vector3).clone();
      const cuffMesh=mesh(anatomical,new THREE.CylinderGeometry(.032,.029,.030,24,4),cuff);
      const wristAxis=(anatomical.userData.wristAxisLocal as THREE.Vector3).clone();
      cuffMesh.name='right-wrist-cuff';cuffMesh.position.copy(wrist).addScaledVector(wristAxis,.007);
      cuffMesh.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0),wristAxis);
    }
    return {hand:anatomical,fingers:[] as THREE.Group[],thumb:new THREE.Group()};
  }
  const hand=new THREE.Group();hand.name=`${side}-hand`;
  const fingers:THREE.Group[]=[];
  // A continuous sweep has rounded ends and a tapered fingertip. Unlike
  // cylinders joined with spheres, it never exposes flat cuts or bead joints.
  const digit=(parent:THREE.Object3D,points:number[][],radius:number)=>{
    const curve=new THREE.CatmullRomCurve3(points.map(p=>new THREE.Vector3(...p))),lengthSegments=20,radialSegments=12;
    const frames=curve.computeFrenetFrames(lengthSegments,false),positions:number[]=[],uv:number[]=[],indices:number[]=[];
    for(let j=0;j<=lengthSegments;j++) {
      const t=j/lengthSegments,center=curve.getPointAt(t);
      const cap=j===0||j===lengthSegments?0:j===lengthSegments-1?.60:1;
      const r=radius*(1-t*.25)*cap;
      for(let i=0;i<=radialSegments;i++) {
        const a=i/radialSegments*Math.PI*2;
        const point=center.clone().addScaledVector(frames.normals[j],Math.cos(a)*r).addScaledVector(frames.binormals[j],Math.sin(a)*r);
        positions.push(point.x,point.y,point.z);uv.push(i/radialSegments,t);
        if(j<lengthSegments&&i<radialSegments){const k=j*(radialSegments+1)+i,n=k+radialSegments+1;indices.push(k,k+1,n,n,k+1,n+1);}
      }
    }
    const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));geometry.setAttribute('uv',new THREE.Float32BufferAttribute(uv,2));geometry.setIndex(indices);geometry.computeVertexNormals();
    return mesh(parent,geometry,skin);
  };
  // Broad palm and a blended wrist bridge keep the whole hand connected when
  // it turns over to insert a charger. The cuff overlaps the sleeve endpoint.
  ellipsoid(hand,.043,0,0,0,.82,.91,1.16,skin);
  ellipsoid(hand,.032,.011,-.019,.037,.94,.87,1.18,skin);
  digit(hand,[[0,-.007,.019],[.006,-.021,.044],[.015,-.033,.076]],.029);
  if(side==='right') {
    for(let i=0;i<4;i++) {
      const finger=new THREE.Group();finger.name=`right-finger-${i}`;
      finger.position.set(-.014,.024-i*.016,-.027+i*.005);hand.add(finger);fingers.push(finger);
      digit(finger,[[.006,0,.006],[-.012,-.004,-.004],[-.027,-.003,-.014],[-.030,.008,-.028],[-.014,.019,-.040]],i===3?.009:.010);
    }
  } else {
    for(let i=0;i<4;i++) {
      const finger=new THREE.Group();finger.name=`left-finger-${i}`;
      finger.position.set(-.025,-.005,-.033+i*.020);hand.add(finger);fingers.push(finger);
      digit(finger,[[.004,-.006,.002],[-.010,.022,-.003],[-.013,.060,-.006],[.031,.081,-.008],[.078,.064,-.010],[.083,.032,-.012]],i===3?.0095:.011);
    }
  }
  const thumb=new THREE.Group();thumb.name=`${side}-thumb`;hand.add(thumb);
  if(side==='right') {
    ellipsoid(thumb,.024,.014,.014,.012,.72,1,.87,skin);
    digit(thumb,[[.018,.006,.027],[.021,.026,.009],[.012,.039,-.009],[-.010,.042,-.024]],.015);
  } else {
    ellipsoid(thumb,.023,.021,.006,.023,.75,1,.90,skin);
    digit(thumb,[[.020,-.008,.030],[.035,.012,.021],[.039,.033,.013],[.018,.046,.004]],.015);
  }
  const cuffMesh=ellipsoid(hand,.045,.015,-.035,.076,.96,.79,.62,cuff);
  cuffMesh.rotation.x=-.22;
  return {hand,fingers,thumb};
}

function attachRifleHands(root:THREE.Group,faction:Faction,bolt:THREE.Object3D,steel:THREE.Material,brass:THREE.Material){
    const skin=material(0xb18b6c),sleeve=makeSurfaceMaterial('canvas',{repeat:[2,3],color:WEAPONS[faction].color,normalStrength:.12}),cuff=sleeve;
    const rightRig=makeHand('right',skin,cuff),leftRig=makeHand('left',skin,cuff);
    root.add(rightRig.hand,leftRig.hand);
    // Sleeves are independent tapered meshes whose endpoints follow the
    // articulated wrists; they are never baked into static gun furniture.
    const rightArm=makeViewmodelArm(sleeve,'right'),leftArm=makeViewmodelArm(sleeve,'left');root.add(rightArm.mesh,leftArm.mesh);
    // Transform markers remain useful to the inspector and anatomical tests;
    // visible cloth is a single skinned garment from shoulder to cuff.
    const rightForearm=new THREE.Object3D(),leftForearm=new THREE.Object3D();root.add(rightForearm,leftForearm);
    rightForearm.name='right-forearm';leftForearm.name='left-forearm';
    // The support elbow can enter the viewport when the rifle is lifted.
    // Continue the cloth back to the shoulder rather than exposing a capped
    // forearm floating in front of the player during reloads.
    const leftUpperArm=new THREE.Object3D();root.add(leftUpperArm);
    leftUpperArm.name='left-upper-arm';
    const leftElbow=new THREE.Object3D();root.add(leftElbow);
    leftElbow.name='left-elbow';
    const clip=new THREE.Group();clip.name='clip';clip.position.set(0,.17,-.30);clip.visible=false;root.add(clip);
    rounded(clip,.014,.064,.009,0,.028,.027,steel,.002);
    const rounds=new THREE.Group();rounds.name='clip-rounds';clip.add(rounds);
    const copper=material(0xa36b43,.4);
    for(let i=0;i<5;i++){rod(rounds,.006,.049,0,i*.013,-.001,brass);rod(rounds,.005,.018,0,i*.013,-.034,copper,'z',.001);}
    root.userData.handRig={right:rightRig.hand,left:leftRig.hand,rightForearm,leftForearm,leftUpperArm,leftElbow,rightArm,leftArm,rightFingers:rightRig.fingers,rightThumb:rightRig.thumb,clip,rounds,bolt};
}

export function makeRifle(faction:Faction,arms=false,options:{source?:'auto'|'procedural'}={}):THREE.Group {
  const imported=options.source==='procedural'?null:makeImportedWeapon(faction);
  if(imported){
    const visual=getRifleVisuals(faction);
    imported.userData.sightY=visual.sightY;imported.userData.muzzleZ=visual.muzzleZ;
    if(arms){
      attachRifleHands(imported,faction,imported.getObjectByName('bolt')!,material(0x41464c,.9,.45),material(0xa39361,.65,.5));
      applyWeaponAnimation(imported,sampleFirstPersonWeaponAnimation(faction,'idle',0));
    }
    return imported;
  }
  const root=new THREE.Group();root.name=`rifle-${faction}`;
  const body=new THREE.Group();body.name='furniture';root.add(body);
  const v=RIFLE_VISUALS[faction];root.userData.sightY=v.sightY;root.userData.muzzleZ=v.muzzleZ;
  // Neutral brushed steel is tinted toward blued exterior and polished wear;
  // its fine roughness/normal detail no longer contains painted panel seams.
  const steel=makeSurfaceMaterial('steel',{repeat:[1,1],color:faction==='british'?0x41464c:0x494c50,normalStrength:.7,roughness:1,metalness:.95,roughnessRange:[.30,.66]}),
    dark=makeSurfaceMaterial('steel',{repeat:[1,1],color:0x25292d,normalStrength:.5,roughness:1,metalness:.9,roughnessRange:[.40,.72]}),
    edge=makeSurfaceMaterial('steel',{repeat:[1,1],color:0x8a8d90,normalStrength:.7,roughness:1,metalness:1,roughnessRange:[.20,.56]});
  const brass=material(0xa39361,.65,.5),wood=makeSurfaceMaterial('walnut',{repeat:[1.7,.6],rotation:Math.PI/2,color:faction==='british'?0x805e40:faction==='russian'?0xa27748:0x886743,roughness:.82}),leather=material(0x403725);
  const woodNames=faction==='british'?['rifle-wood-british-butt','rifle-wood-british-foreend']:[`rifle-wood-${faction}`];
  const detailedWood=woodNames.map(name=>makeModelDetail(name,wood));
  const hasAuthoredWood=detailedWood.every(Boolean);
  root.userData.authoredWood=hasAuthoredWood;
  if(hasAuthoredWood)for(const part of detailedWood)body.add(part!);else stock(body,wood,faction);
  rounded(body,.095,.17,.015,0,-.074,.23,faction==='british'?brass:steel,.008);
  const metalParts=[makeModelDetail(`rifle-metal-${faction}-body`,steel),makeModelDetail(`rifle-metal-${faction}-trim`,edge),makeModelDetail(`rifle-metal-${faction}-recess`,dark)];
  const hasAuthoredMetal=metalParts.every(Boolean);root.userData.authoredMetal=hasAuthoredMetal;
  if(hasAuthoredMetal)for(const part of metalParts)body.add(part!);
  else {
  if(faction==='british'){
    // No.4: two-piece furniture, butt socket, full fore-end and box magazine.
    rod(body,.045,.073,0,-.013,-.25,steel);
    if(!hasAuthoredWood){rounded(body,.083,.09,.62,0,-.025,-.60,wood,.024);rounded(body,.070,.059,.25,0,.006,-1.02,wood,.014);}
    rounded(body,.073,.13,.17,0,-.088,-.385,steel,.017);
    rounded(body,.065,.024,.13,0,-.16,-.385,dark,.01);
    for(const x of [-.038,.038])rounded(body,.004,.07,.095,x,-.09,-.39,edge,.001);
    rounded(body,.074,.057,.22,0,.029,-.36,steel,.009);
    rounded(body,.022,.02,.065,-.041,.053,-.29,steel,.004);
  }else if(faction==='russian'){
    // 91/30: long straight stock, exposed barrel, finger grooves, straight bolt.
    if(!hasAuthoredWood){rounded(body,.080,.084,.73,0,-.026,-.685,wood,.022);rounded(body,.062,.042,.33,0,.013,-.78,wood,.017);}
    for(const x of [-.040,.040])rounded(body,.007,.012,.28,x,-.026,-.69,leather,.004);
    rounded(body,.055,.099,.18,0,-.075,-.36,steel,.008);
    rod(body,.039,.23,0,.029,-.335,steel);
    rod(body,.042,.048,0,.030,-.194,edge);
  }else{
    // Kar98k: shorter rounded fore-end, flat magazine floor and cupped buttplate.
    if(!hasAuthoredWood){rounded(body,.076,.082,.69,0,-.026,-.64,wood,.026);rounded(body,.061,.043,.23,0,.009,-.705,wood,.016);}
    rounded(body,.066,.027,.21,0,-.066,-.35,steel,.010);
    rod(body,.037,.20,0,.028,-.333,steel);
    rounded(body,.035,.05,.018,0,.055,-.225,steel,.003).rotation.z=.6;
    for(const x of [-.044,.044]){rod(body,.014,.002,x,-.049,.06,edge,'x');rod(body,.009,.003,x,-.049,.06,dark,'x');}
  }
  const barrelEnd=v.muzzleZ,barrelStart=-.42;
  rod(body,.015,Math.abs(barrelEnd-barrelStart),0,.031,(barrelEnd+barrelStart)/2,steel,'z',.025);
  rod(body,.018,.017,0,.031,barrelEnd,edge);rod(body,.010,.018,0,.031,barrelEnd-.004,dark);
  // Receiver raceway, ejection port, bands and screws catch the light.
  rounded(body,.041,.010,.125,0,.064,-.35,dark,.003);
  for(const z of faction==='russian'?[-.84,-1.025]:faction==='british'?[-.65,-1.095]:[-.82,-.985]){
    rounded(body,.085,.086,.026,0,-.002,z,steel,.014);
    rod(body,.004,.088,0,-.014,z,edge,'x');
  }
  for(const z of [-.24,-.42])rod(body,.005,.076,0,-.025,z,edge,'x');
  const guard=new THREE.Mesh(new THREE.TorusGeometry(.035,.0045,8,28,Math.PI*1.7),steel);guard.rotation.y=Math.PI/2;guard.position.set(0,-.100,-.21);body.add(guard);
  const trigger=rounded(body,.008,.031,.009,0,-.083,-.214,steel,.003);trigger.rotation.x=-.35;
  }
  // Sling and swivels, kept beneath the sight line.
  rounded(body,.015,.010,.83,-.05,-.114,-.535,leather,.003).rotation.x=.035;
  for(const z of [.10,-.90]){const ring=new THREE.Mesh(new THREE.TorusGeometry(.019,.003,6,16),steel);ring.position.set(-.045,-.083,z);ring.rotation.y=Math.PI/2;body.add(ring);}

  const sights=new THREE.Group();sights.name='sights';root.add(sights);
  const rear=new THREE.Group();rear.name=`${faction}-rear-sight`;sights.add(rear);
  if(faction==='british'){
    // CoD1's lowered battle sight sits on a broad block, with short guards.
    // The previous tall twin rails resembled a raised ladder sight in ADS.
    rounded(rear,.088,.046,.037,0,.078,v.rearZ,steel,.003);
    const aperture=new THREE.Mesh(new THREE.TorusGeometry(.0135,.0036,12,48),dark);aperture.name='rear-aperture';aperture.position.set(0,v.sightY,v.rearZ);rear.add(aperture);
    rounded(rear,.027,.020,.012,0,.101,v.rearZ,dark,.002);
    for(const sign of [-1,1])rounded(rear,.009,.041,.033,sign*.043,.080,v.rearZ,steel,.003);
    rod(rear,.007,.098,0,.073,v.rearZ,steel,'x');
    rod(rear,.009,.010,.052,.073,v.rearZ,steel,'x');
  }else{
    const leafY=v.sightY-.029;
    rounded(rear,.040,.038,.050,0,leafY-.023,v.rearZ-.050,steel,.004);
    const leaf=rounded(rear,.043,.012,.135,0,leafY,v.rearZ-.05,steel,.003);leaf.rotation.x=.045;
    for(let i=0;i<6;i++)rounded(rear,.031,.002,.002,0,leafY+.007,v.rearZ-.092+i*.016,edge,.0005);
    notch(rear,v.rearZ,v.sightY,faction==='russian'?'u':'v',dark);
  }
  const front=new THREE.Group();front.name=`${faction}-front-sight`;sights.add(front);
  rounded(front,.035,.044,.036,0,.059,v.frontZ,steel,.005);
  if(faction==='german'){
    const triangle=new THREE.Shape();triangle.moveTo(-.006,.068);triangle.lineTo(.006,.068);triangle.lineTo(0,v.sightY);triangle.closePath();
    const post=mesh(front,new THREE.ExtrudeGeometry(triangle,{depth:.009,bevelEnabled:false}),dark,0,0,v.frontZ-.003);post.name='front-barleycorn';
    // The original game's unscoped Kar98k has an exposed front blade.
  }else{
    rounded(front,.006,v.sightY-.067,.009,0,(v.sightY+.067)/2,v.frontZ,dark,.0007).name='front-post';
    if(faction==='russian'){
      const hood=new THREE.Mesh(new THREE.TorusGeometry(.014,.0018,10,40),dark);hood.name='front-hood';hood.position.set(0,v.sightY,v.frontZ);front.add(hood);
    }else{
      for(const sign of [-1,1]){const ear=rounded(front,.009,.066,.025,sign*.030,.110,v.frontZ,steel,.003);ear.rotation.z=sign*.18;}
    }
  }
  const bolt=new THREE.Group();bolt.name='bolt';bolt.position.set(0,.045,-.26);root.add(bolt);
  const boltParts=[makeModelDetail(`rifle-metal-${faction}-bolt`,steel),makeModelDetail(`rifle-metal-${faction}-bolt-trim`,edge)];
  if(boltParts.every(Boolean))for(const part of boltParts)bolt.add(part!);
  else {
    rod(bolt,.018,.17,0,0,0,edge);
    if(faction==='russian'){rod(bolt,.008,.102,.063,-.002,.01,steel,'x');ellipsoid(bolt,.0145,.119,-.002,.01,1,1,1,steel);}
    else{link(bolt,[.028,.007,-.02],[.083,-.051,.01],.008,steel);ellipsoid(bolt,.0145,.087,-.057,.013,1,1,1,steel);}
  }
  // Renderer animates only displacement relative to this authored orientation.
  bolt.userData.restRotation=0;
  if(arms)attachRifleHands(root,faction,bolt,steel,brass);
  mergeStatic(body);mergeStatic(rear);mergeStatic(front);
  if(arms)applyWeaponAnimation(root,sampleFirstPersonWeaponAnimation(faction,'idle',0,false,null));
  return root;
}
