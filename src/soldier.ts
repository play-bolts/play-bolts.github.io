import * as THREE from 'three';
import {RoundedBoxGeometry} from 'three/addons/geometries/RoundedBoxGeometry.js';
import {mergeGeometries} from 'three/addons/utils/BufferGeometryUtils.js';
import type {Faction} from './config';
import {makeRifle,getRifleVisuals} from './rifle';
import {makeHumanHead} from './humanHead';
import {makeModelDetail} from './modelDetails';
import {makeImportedSoldierBody,type SoldierBodyRig} from './soldierModelAssets';
import {makeStielhandgranate} from './grenadeModel';
import {makeSoldierMaterials} from './soldierMaterials';
export {preloadSoldierMaterials} from './soldierMaterials';
import {applySoldierPose,makeClothJoint,sampleSoldierPose,type JointChain,type SoldierRig} from './soldierAnimation';

type Point = [number, number, number];
type Ring = [number, number, number, number?];

// Original, procedural uniforms. The three loadouts follow wartime battledress,
// gymnastiorka, and Feldbluse silhouettes; no extracted game assets are used.
// Object references: https://collection.nam.ac.uk/detail.php?acc=1998-02-259--1
// https://www.awm.gov.au/collection/C1005479
// https://samlinger.natmus.dk/khs/object/23176
// https://ar.culture.ru/en/subject/ssh-40-i-osenniy-maskhalat

function add(parent:THREE.Object3D,geometry:THREE.BufferGeometry,material:THREE.Material,position:Point=[0,0,0]) {
  const mesh=new THREE.Mesh(geometry,material);
  mesh.position.set(...position); parent.add(mesh); return mesh;
}

function oval(parent:THREE.Object3D,position:Point,size:Point,material:THREE.Material,segments=16,rings=10) {
  const mesh=add(parent,new THREE.SphereGeometry(1,segments,rings),material,position);
  mesh.scale.set(...size); return mesh;
}

function rounded(parent:THREE.Object3D,position:Point,size:Point,material:THREE.Material,radius=.012) {
  return add(parent,new RoundedBoxGeometry(...size,1,Math.min(radius,...size.map(v=>v*.45))),material,position);
}

// Elliptical cross sections preserve an anatomical silhouette instead of boxy
// bodies or constant-radius tubes. Rings are [height, half-width, half-depth, z].
function loft(parent:THREE.Object3D,rings:Ring[],material:THREE.Material,segments=24) {
  const positions:number[]=[], uv:number[]=[], indices:number[]=[];
  for(let j=0;j<rings.length;j++) {
    const [y,rx,rz,z=0]=rings[j];
    for(let i=0;i<=segments;i++) {
      const angle=i/segments*Math.PI*2;
      positions.push(Math.sin(angle)*rx,y,Math.cos(angle)*rz+z);
      uv.push(i/segments,j/(rings.length-1));
    }
  }
  for(let j=0;j<rings.length-1;j++) for(let i=0;i<segments;i++) {
    const a=j*(segments+1)+i, b=a+segments+1;
    indices.push(a,a+1,b,b,a+1,b+1);
  }
  const geometry=new THREE.BufferGeometry();
  geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));
  geometry.setAttribute('uv',new THREE.Float32BufferAttribute(uv,2));
  geometry.setIndex(indices); geometry.computeVertexNormals();
  return add(parent,geometry,material);
}

function limb(parent:THREE.Object3D,start:Point,end:Point,radius:number,material:THREE.Material) {
  const a=new THREE.Vector3(...start), b=new THREE.Vector3(...end), length=a.distanceTo(b);
  const shape=loft(parent,[
    [-length/2,0,0],[-length/2+.018,radius*.67,radius*.74],
    [-length*.34,radius*.93,radius],[-length*.05,radius,radius*.95],
    [length*.29,radius*.88,radius*.84],[length/2-.012,radius*.70,radius*.72],
    [length/2,0,0],
  ],material,20);
  shape.position.copy(a).add(b).multiplyScalar(.5);
  shape.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0),b.sub(a).normalize());
  return shape;
}

function seam(parent:THREE.Object3D,points:Point[],radius:number,material:THREE.Material,segments=10) {
  const curve=new THREE.CatmullRomCurve3(points.map(p=>new THREE.Vector3(...p)));
  return add(parent,new THREE.TubeGeometry(curve,segments,radius,5,false),material);
}

function ribbon(parent:THREE.Object3D,points:Point[],width:number,material:THREE.Material,normal:Point=[0,0,1]) {
  const curve=new THREE.CatmullRomCurve3(points.map(p=>new THREE.Vector3(...p)));
  const positions:number[]=[], uv:number[]=[], indices:number[]=[];
  const facing=new THREE.Vector3(...normal);
  for(let i=0;i<=12;i++) {
    const t=i/12, center=curve.getPoint(t), side=new THREE.Vector3().crossVectors(curve.getTangent(t),facing).normalize().multiplyScalar(width*.5);
    positions.push(...center.clone().sub(side).toArray(),...center.clone().add(side).toArray());
    uv.push(0,t,1,t);
    if(i<12) {const a=i*2; indices.push(a,a+1,a+2,a+1,a+3,a+2);}
  }
  const geometry=new THREE.BufferGeometry();
  geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));
  geometry.setAttribute('uv',new THREE.Float32BufferAttribute(uv,2));
  geometry.setIndex(indices); geometry.computeVertexNormals();
  const mesh=add(parent,geometry,material);
  // Equipment straps wrap around shoulders and can be seen from either side.
  return mesh;
}

function buckle(parent:THREE.Object3D,position:Point,width:number,height:number,material:THREE.Material) {
  const [x,y,z]=position;
  rounded(parent,[x,y-height/2,z],[width,.005,.006],material,.002);
  rounded(parent,[x,y+height/2,z],[width,.005,.006],material,.002);
  rounded(parent,[x-width/2,y,z],[.005,height,.006],material,.002);
  rounded(parent,[x+width/2,y,z],[.005,height,.006],material,.002);
  rounded(parent,[x,y,z],[.004,height,.006],material,.001);
}

function pouch(parent:THREE.Object3D,position:Point,size:Point,material:THREE.Material,seamMat:THREE.Material,metal:THREE.Material) {
  const [x,y,z]=position,[w,h,d]=size;
  rounded(parent,position,size,material,.019);
  rounded(parent,[x,y+h*.35,z+d*.5],[w*.98,h*.29,.013],material,.006);
  seam(parent,[[x-w*.43,y+h*.2,z+d*.51],[x,y+h*.18,z+d*.51],[x+w*.43,y+h*.2,z+d*.51]],.0018,seamMat,5);
  oval(parent,[x,y+h*.19,z+d*.5+.007],[.006,.006,.0025],metal,8,6);
}

function helmet(parent:THREE.Object3D,faction:Faction,shell:THREE.Material,rim:THREE.Material) {
  if(faction==='british') {
    // Mk II: shallow crown, very broad, almost level circular brim.
    loft(parent,[[1.690,.233,.249,-.004],[1.699,.234,.25,-.004],
      [1.706,.204,.218,-.004],[1.714,.168,.18,-.006],
      [1.755,.158,.171,-.006],[1.800,.130,.147,-.008],
      [1.833,.083,.096,-.009],[1.845,.025,.032,-.010],[1.847,0,0,-.010]],shell,40);
    const ring=new THREE.Mesh(new THREE.TorusGeometry(1,.009,5,40),rim);
    ring.rotation.x=Math.PI/2; ring.scale.set(.233,.249,.55); ring.position.set(0,1.697,-.004); parent.add(ring);
    return;
  }
  // SSh-40 is round with a modest visor. The Stahlhelm has a high dome,
  // flared skirt, extended rear neck guard, and a higher cut around the face.
  const german=faction==='german', segments=40;
  const profiles=german
    ? [[1.630,.178,.193],[1.648,.179,.190],[1.673,.164,.173],
       [1.727,.157,.170],[1.781,.143,.157],[1.822,.106,.119],
       [1.847,.053,.063],[1.854,0,0]]
    : [[1.681,.161,.187],[1.692,.162,.184],[1.727,.156,.172],
       [1.778,.136,.153],[1.823,.095,.109],[1.847,.042,.055],[1.850,0,0]];
  const positions:number[]=[],uv:number[]=[],indices:number[]=[],edge:THREE.Vector3[]=[];
  for(let j=0;j<profiles.length;j++) for(let i=0;i<=segments;i++) {
    const angle=i/segments*Math.PI*2, front=Math.cos(angle),[y,rx,rz]=profiles[j];
    const lip=j<2?1:Math.max(0,1-j/3);
    const yy=y+(german?Math.max(0,front)*.067-Math.max(0,-front)*.018:Math.max(0,front)*.005)*lip;
    const zz=front*rz-.007+(front>.45?.017*front*lip:0);
    positions.push(Math.sin(angle)*rx,yy,zz);uv.push(i/segments,j/(profiles.length-1));
    if(j===0) edge.push(new THREE.Vector3(Math.sin(angle)*rx,yy,zz));
  }
  for(let j=0;j<profiles.length-1;j++) for(let i=0;i<segments;i++) {
    const a=j*(segments+1)+i,b=a+segments+1; indices.push(a,a+1,b,b,a+1,b+1);
  }
  const geometry=new THREE.BufferGeometry();
  geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));
  geometry.setAttribute('uv',new THREE.Float32BufferAttribute(uv,2));
  geometry.setIndex(indices);geometry.computeVertexNormals();add(parent,geometry,shell);
  add(parent,new THREE.TubeGeometry(new THREE.CatmullRomCurve3(edge),40,.0032,5,false),rim);
  for(const side of [-1,1]) oval(parent,[side*.159,1.733,-.018],[.003,.006,.006],rim,8,6);
}

function head(parent:THREE.Object3D,faction:Faction,skin:THREE.Material,skinShade:THREE.Material,hair:THREE.Material,dark:THREE.Material,eye:THREE.Material,helmetMat:THREE.Material,metal:THREE.Material,strap:THREE.Material) {
  const anatomical=makeHumanHead();
  if(anatomical) {
    anatomical.position.set(0,1.47,0);parent.add(anatomical);
    for(const side of [-1,1]) seam(parent,[[side*.117,1.686,0],[side*.099,1.573,.041],[side*.048,1.523,.061],[0,1.513,.047]],.004,strap,8);
    helmet(parent,faction,helmetMat,metal);return;
  }
  // The anatomical asset supplies its own continuous neck. This narrow
  // fallback is only needed when that asset could not be loaded.
  loft(parent,[[1.423,.044,.039],[1.450,.047,.042],[1.485,.048,.043],[1.520,.048,.042]],skin,28);
  const face=oval(parent,[0,1.620,.006],[.101,.140,.099],skin,40,28);
  // Recess the sockets into the skull. Small, partly occluded eyes read as
  // human features at playing distance instead of bright beads on the face.
  const vertices=face.geometry.getAttribute('position');
  for(let i=0;i<vertices.count;i++) {
    const x=vertices.getX(i)*.101,y=vertices.getY(i)*.140,z=vertices.getZ(i);
    if(z<=0) continue;
    const socket=Math.exp(-(((Math.abs(x)-.040)/.022)**2+((y-.024)/.013)**2));
    vertices.setZ(i,z-socket*.006/.099);
  }
  vertices.needsUpdate=true;face.geometry.computeVertexNormals();
  oval(parent,[0,1.561,.032],[.080,.070,.067],skin,20,14);
  oval(parent,[0,1.533,.052],[.062,.025,.043],skin,16,10);
  for(const side of [-1,1]) {
    oval(parent,[side*.100,1.610,.003],[.016,.030,.015],skin,14,10);
    oval(parent,[side*.110,1.611,.008],[.003,.016,.008],skinShade,10,8);
    oval(parent,[side*.058,1.597,.080],[.029,.022,.012],skin,16,10);
    oval(parent,[side*.040,1.644,.092],[.020,.006,.003],skinShade,16,8);
    oval(parent,[side*.040,1.644,.094],[.016,.0032,.0018],eye,14,8);
    oval(parent,[side*.040,1.644,.096],[.0034,.0030,.001],dark,10,8);
    const brow=oval(parent,[side*.040,1.658,.094],[.025,.0025,.003],hair,12,8);
    brow.rotation.z=side*.08;
    seam(parent,[[side*.117,1.686,0],[side*.099,1.573,.041],[side*.048,1.523,.061],[0,1.513,.047]],.005,strap,8);
  }
  oval(parent,[0,1.626,.095],[.011,.025,.018],skin,16,12);
  oval(parent,[0,1.606,.108],[.014,.010,.014],skin,16,10);
  for(const side of [-1,1]) oval(parent,[side*.010,1.600,.108],[.005,.0025,.002],skinShade,10,6);
  oval(parent,[0,1.572,.098],[.023,.0018,.0012],skinShade,16,6);
  oval(parent,[0,1.568,.098],[.021,.0018,.0012],skin,14,6);
  // Hair at the nape is visible under the different steel helmet silhouettes.
  oval(parent,[0,1.654,-.064],[.096,.072,.054],hair,20,12);
  helmet(parent,faction,helmetMat,metal);
}

function hand(parent:THREE.Object3D,position:Point,skin:THREE.Material,left:boolean) {
  const group=new THREE.Group();group.position.set(...position);parent.add(group);
  oval(group,[0,0,0],[.036,.039,.052],skin,16,10);
  for(let i=0;i<4;i++) {
    const x=(i-1.5)*.016;
    seam(group,[[x,-.014,.023],[x,-.002,.055],[x,.023,.058],[x,.034,.043]],.009,skin,7);
    oval(group,[x,.029,.041],[.009,.012,.013],skin,8,6);
  }
  seam(group,[[left?.031:-.031,.015,-.014],[left?.043:-.043,.037,.007],[left?.023:-.023,.045,.027]],.013,skin,7);
  group.rotation.z=left?-.30:.25;
}

// Hundreds of small modeled seams/buttons should not cost hundreds of draw
// calls. Bake every static assembly into one mesh per material while leaving
// body and the two independently animated hip pivots intact.
function batchStatic(group:THREE.Group) {
  group.updateMatrixWorld(true);
  const inverse=new THREE.Matrix4().copy(group.matrixWorld).invert();
  const byMaterial=new Map<THREE.Material,THREE.BufferGeometry[]>();
  const originals=new Set<THREE.BufferGeometry>();
  group.traverse(object=>{
    if(!(object instanceof THREE.Mesh)) return;
    const source=object.geometry as THREE.BufferGeometry;
    originals.add(source);
    const geometry=source.index?source.toNonIndexed():source.clone();
    geometry.applyMatrix4(new THREE.Matrix4().multiplyMatrices(inverse,object.matrixWorld));
    // Rifle meshes and uniform meshes need an identical attribute layout.
    for(const name of Object.keys(geometry.attributes)) if(!['position','normal','uv'].includes(name)) geometry.deleteAttribute(name);
    if(!geometry.getAttribute('uv')) geometry.setAttribute('uv',new THREE.Float32BufferAttribute(new Float32Array(geometry.getAttribute('position').count*2),2));
    const material=object.material as THREE.Material;
    const geometries=byMaterial.get(material)??[];geometries.push(geometry);byMaterial.set(material,geometries);
  });
  group.clear();
  for(const [material,geometries] of byMaterial) {
    const combined=mergeGeometries(geometries,false);
    if(combined) {const mesh=add(group,combined,material);mesh.castShadow=mesh.receiveShadow=true;}
    geometries.forEach(geometry=>geometry.dispose());
  }
  originals.forEach(geometry=>geometry.dispose());
}

export function makeSoldier(faction:Faction):THREE.Group {
  const soldier=new THREE.Group();soldier.name=`${faction}-soldier`;
  const imported=makeImportedSoldierBody(faction,soldier);
  if(imported)return equipSoldier(soldier,faction,imported,new THREE.MeshStandardMaterial({color:0x6d6756,metalness:.6,roughness:.6}),new THREE.MeshStandardMaterial({color:0x54402c,roughness:.8}));
  const {wool,shade,web,leather,leatherEdge,helmetMat,metal}=makeSoldierMaterials(faction);
  const solid=(color:number,roughness=.82)=>new THREE.MeshStandardMaterial({color,roughness});
  const skin=solid(faction==='russian'?0xb69a7d:0xb4997e), skinShade=solid(0x927861),hair=solid(0x4d4538);
  const dark=solid(0x282a25), eye=solid(0xaaa28e);
  const body=new THREE.Group();body.name='body';soldier.add(body);

  const tailoredTorso=makeModelDetail(`uniform-${faction}-torso`,wool);
  soldier.userData.authoredUniform=!!tailoredTorso;
  if(tailoredTorso)body.add(tailoredTorso);else loft(body,[[.824,0,0],[.832,.177,.107],[.87,.187,.117],[.95,.184,.119],
    [1.045,.190,.123],[1.16,.213,.132],[1.285,.230,.135],
    [1.355,.221,.119],[1.402,.178,.096],[1.440,.098,.076],[1.447,0,0]],wool,32);
  // The Soviet shirt and German tunic hang below the waist; battledress is
  // bloused into a visibly high belt at the bottom of the short jacket.
  if(faction!=='british') loft(body,[[.797,.199,.120],[.815,.202,.124],[.892,.190,.121],[.977,.185,.119]],wool,28);
  const beltY=faction==='british'?.912:.977;
  loft(body,[[beltY-.029,.193,.127],[beltY+.029,.193,.127]],faction==='british'?web:leather,32);
  buckle(body,[0,beltY,.133],.047,.045,metal);
  if(faction==='german') rounded(body,[0,beltY,.133],[.044,.039,.009],metal,.002);

  // Rounded collars and separate epaulettes read correctly from above and
  // when an opponent turns side-on, as opposed to painted front-only details.
  for(const side of [-1,1]) {
    const collar=rounded(body,[side*.054,1.414,.072],[.077,.070,.018],faction==='german'?shade:wool,.009);
    collar.rotation.z=side*.40;collar.rotation.x=-.15;
    const shoulder=rounded(body,[side*.158,1.397,0],[.106,.016,.046],shade,.007);shoulder.rotation.z=-side*.20;
    oval(body,[side*.111,1.413,.009],[.006,.003,.006],metal,8,6);
  }
  if(faction==='russian') loft(body,[[1.423,.073,.075],[1.455,.073,.075]],shade,24);
  seam(body,[[.006,1.371,.115],[.005,1.22,.136],[.005,1.06,.127]],.003,shade,10);
  for(const y of (faction==='russian'?[1.397,1.356,1.314]:[1.359,1.282,1.20,1.117,1.036])) {
    oval(body,[.007,y,y>1.30?.123:.139],[.006,.006,.003],metal,8,6);
  }
  for(const side of [-1,1]) {
    pouch(body,[side*.117,1.245,.128],[.104,.119,.024],wool,shade,metal);
    seam(body,[[side*.119,1.273,.155],[side*.118,1.238,.153],[side*.118,1.196,.145]],.0022,shade,5);
    if(faction==='german') pouch(body,[side*.125,.871,.110],[.125,.112,.036],wool,shade,metal);
    seam(body,[[side*.142,1.15,.116],[side*.123,1.10,.125],[side*.143,1.016,.113]],.003,shade,7);
    seam(body,[[side*.165,1.31,-.094],[side*.163,1.12,-.119],[side*.149,.99,-.101]],.002,shade,10);
  }

  if(faction==='british') {
    for(const side of [-1,1]) {
      ribbon(body,[[side*.164,.944,.15],[side*.169,1.16,.153],[side*.165,1.345,.139],[side*.164,1.433,.015],[side*.144,1.37,-.117],[side*.067,1.11,-.135],[side*-.09,.93,-.128]],.051,web);
      pouch(body,[side*.169,1.035,.163],[.108,.205,.091],web,shade,metal);
      buckle(body,[side*.17,1.184,.163],.032,.028,metal);
      ribbon(body,[[side*.182,1.01,.218],[side*.182,1.078,.219],[side*.182,1.142,.216]],.019,web);
    }
    pouch(body,[.03,1.133,-.193],[.288,.296,.148],web,shade,metal);
    for(const side of [-1,1]) ribbon(body,[[side*.10,.982,-.279],[side*.10,1.15,-.28],[side*.10,1.29,-.27]],.025,web,[0,0,-1]);
    oval(body,[-.224,.858,-.015],[.065,.103,.058],web,20,12);
    ribbon(body,[[-.257,.93,.019],[-.254,.85,.037],[-.239,.765,.006]],.024,web,[-1,0,0]);
  } else if(faction==='russian') {
    for(const side of [-1,1]) {
      pouch(body,[side*.144,.994,.160],[.123,.113,.076],leather,leatherEdge,metal);
      seam(body,[[side*.144-.026,.96,.201],[side*.144-.026,1.03,.201]],.0025,leatherEdge,5);
    }
    ribbon(body,[[-.206,.912,.068],[-.112,1.117,.15],[.065,1.341,.138],[.18,1.401,.015],[.19,1.17,-.126],[.116,.93,-.143]],.036,leather);
    // Soviet veshmeshok has a soft gathered neck rather than a box pack.
    oval(body,[.017,1.120,-.199],[.182,.23,.108],web,24,16);
    oval(body,[.019,1.337,-.188],[.072,.051,.062],web,16,10);
    seam(body,[[-.035,1.351,-.238],[.02,1.36,-.249],[.075,1.35,-.231]],.006,leatherEdge,8);
    oval(body,[-.224,.874,-.015],[.06,.096,.050],web,16,12);
    rounded(body,[-.23,.965,-.015],[.029,.035,.029],leather,.007);
  } else {
    for(const side of [-1,1]) {
      ribbon(body,[[side*.145,1.012,.17],[side*.178,1.214,.151],[side*.168,1.381,.115],[side*.153,1.421,-.014],[side*.106,1.312,-.139],[0,1.174,-.151]],.028,leather);
      for(let i=0;i<3;i++) pouch(body,[side*(.085+i*.047),1.008,.168],[.044,.124,.063],leather,leatherEdge,metal);
      buckle(body,[side*.17,1.148,.173],.022,.030,metal);
    }
    ribbon(body,[[0,1.183,-.151],[0,1.062,-.137],[0,.96,-.135]],.029,leather,[0,0,-1]);
    pouch(body,[.104,.877,-.175],[.206,.225,.090],web,shade,metal);
    oval(body,[-.197,.916,-.145],[.070,.103,.055],shade,20,12);
    rounded(body,[-.194,1.013,-.143],[.026,.029,.026],dark,.005);
    // Cylindrical gas-mask canister and its closely spaced reinforcing ribs.
    const canister=new THREE.Group();canister.position.set(-.060,1.092,-.223);canister.rotation.z=Math.PI/2+.20;body.add(canister);
    loft(canister,[[-.133,0,0],[-.132,.055,.055],[.132,.055,.055],[.133,0,0]],helmetMat,24);
    for(const y of [-.122,-.075,-.028,.02,.069,.118]) loft(canister,[[y-.004,.059,.059],[y+.004,.059,.059]],metal,24);
  }

  // The equipment remains batched by material, but the torso, head, arms,
  // thighs, lower legs, and feet are independently articulated assemblies.
  batchStatic(body);
  for(const child of body.children) if(child instanceof THREE.Mesh) child.geometry.translate(0,-.95,0);
  const pelvis=new THREE.Group();pelvis.name='pelvis';pelvis.position.y=.84;soldier.add(pelvis);
  pelvis.add(body);body.position.set(0,.11,0);
  const neck=new THREE.Group();neck.name='neck';
  head(neck,faction,skin,skinShade,hair,dark,eye,helmetMat,metal,leather);
  batchStatic(neck);
  for(const child of neck.children) if(child instanceof THREE.Mesh) child.geometry.translate(0,-1.46,0);
  neck.position.set(0,.51,0);body.add(neck);

  const makeArm=(side:number):JointChain=>{
    const upper=new THREE.Group();upper.name=side<0?'shoulderL':'shoulderR';
    const lower=new THREE.Group();lower.name=side<0?'elbowL':'elbowR';
    const wrist=new THREE.Group();wrist.name=side<0?'wristL':'wristR';
    const upperSleeve=makeModelDetail('uniform-upper-sleeve',wool);
    if(upperSleeve)upper.add(upperSleeve);else {oval(upper,[0,-.035,0],[.074,.084,.079],wool,20,12);limb(upper,[0,-.005,0],[0,-.345,0],.070,wool);}
    seam(upper,[[side*.072,-.045,.013],[side*.07,-.18,.02],[side*.057,-.31,.011]],.0017,shade,8);
    batchStatic(upper);
    const lowerSleeve=makeModelDetail('uniform-lower-sleeve',wool);
    if(lowerSleeve)lower.add(lowerSleeve);else limb(lower,[0,.016,0],[0,-.34,0],.059,wool);
    loft(lower,[[-.350,.039,.038],[-.342,.043,.042],[-.304,.044,.043],[-.296,.043,.042]],shade,20);
    seam(lower,[[-.034,-.336,.023],[0,-.337,.043],[.034,-.336,.023]],.0015,wool,7);
    for(const y of [-.055,-.09])seam(lower,[[-.047,y,.025],[0,y-.009,.066],[.047,y-.004,.027]],.002,shade,6);
    batchStatic(lower);
    hand(wrist,[0,0,0],skin,side<0);batchStatic(wrist);
    upper.position.set(side*.228,.394,.006);body.add(upper);
    lower.position.set(0,-.33,0);upper.add(lower);wrist.position.set(0,-.34,0);lower.add(wrist);
    return{root:upper,middle:lower,end:wrist,upperLength:.33,lowerLength:.34};
  };
  const leftArm=makeArm(1),rightArm=makeArm(-1);

  const makeLeg=(side:number):JointChain=>{
    const hip=new THREE.Group();hip.name=side<0?'legL':'legR';
    const knee=new THREE.Group();knee.name=side<0?'kneeL':'kneeR';
    const ankle=new THREE.Group();ankle.name=side<0?'ankleL':'ankleR';
    const british=faction==='british';
    const trouser=makeModelDetail('uniform-thigh',wool);
    if(trouser)hip.add(trouser);else loft(hip,[[.042,0,0],[.038,.110,.108],[-.09,.115,.111],[-.22,.100,.094],[-.34,.081,.086],[-.394,.080,.083]],wool,24);
    seam(hip,[[side*.100,.01,.024],[side*.10,-.18,.015],[side*.076,-.37,.025]],.0017,shade,10);
    for(const y of [-.29,-.35])seam(hip,[[-.058,y,.051],[0,y-.009,.085],[.055,y-.015,.057]],.0023,shade,6);
    batchStatic(hip);
    if(british) {
      const lowerTrouser=makeModelDetail('uniform-british-trouser',wool);
      if(lowerTrouser)knee.add(lowerTrouser);else loft(knee,[[.01,.080,.083],[-.06,.078,.083],[-.14,.071,.077],[-.255,.068,.071]],wool,24);
      loft(knee,[[-.26,.072,.074],[-.21,.076,.079],[-.08,.078,.083],[-.06,.080,.085]],web,24);
      for(const y of [-.083,-.166]) {
        loft(knee,[[y-.006,.080,.085],[y+.006,.080,.085]],leather,24);
        buckle(knee,[side*.07,y,.044],.022,.015,metal);
      }
    } else {
      loft(knee,[[-.347,.066,.074,.012],[-.25,.068,.074],[-.12,.075,.079],[-.028,.081,.087],[-.015,.079,.085]],leather,28);
      loft(knee,[[-.031,.082,.088],[-.019,.082,.088]],leatherEdge,28);
      for(const y of [-.22,-.253,-.285])seam(knee,[[-.052,y,.046],[0,y-.006,.074],[.051,y,.047]],.0025,leatherEdge,6);
    }
    batchStatic(knee);
    oval(ankle,[0,-.002,.051],[.079,.084,.145],leather,24,14);
    rounded(ankle,[0,-.065,.052],[.16,.035,.284],dark,.02);
    rounded(ankle,[0,-.059,-.04],[.139,.040,.098],dark,.008);
    seam(ankle,[[-.068,-.014,.098],[-.046,-.001,.147],[0,.002,.172],[.046,-.001,.147],[.068,-.014,.098]],.0024,leatherEdge,12);
    if(british) {
      rounded(ankle,[0,.052,.077],[.072,.086,.024],leather,.012);
      for(let i=0;i<4;i++) {
        const y=.083-i*.016;
        seam(ankle,[[-.031,y,.097],[.031,y-.011,.101]],.0018,web,3);
        seam(ankle,[[.031,y,.097],[-.031,y-.011,.101]],.0018,web,3);
      }
    }
    batchStatic(ankle);
    hip.position.set(side*.13,-.015,0);pelvis.add(hip);
    knee.position.set(0,-.385,0);hip.add(knee);ankle.position.set(0,-.345,0);knee.add(ankle);
    return{root:hip,middle:knee,end:ankle,upperLength:.385,lowerLength:.345};
  };
  const leftLeg=makeLeg(-1),rightLeg=makeLeg(1);
  const clothJoints=[makeClothJoint(leftArm,wool,.055,.051,.085),makeClothJoint(rightArm,wool,.055,.051,.085),
    makeClothJoint(leftLeg,wool,.081,.077),makeClothJoint(rightLeg,wool,.081,.077)];
  for(const joint of clothJoints)soldier.add(joint.mesh);

  return equipSoldier(soldier,faction,{pelvis,spine:body,neck,leftArm,rightArm,leftLeg,rightLeg,clothJoints},metal,leatherEdge);
}

function equipSoldier(soldier:THREE.Group,faction:Faction,bodyRig:SoldierBodyRig,metal:THREE.Material,leatherEdge:THREE.Material):THREE.Group {
  const riflePivot=new THREE.Group();riflePivot.name='held-rifle';soldier.add(riflePivot);
  const rifle=makeRifle(faction);rifle.scale.setScalar(getRifleVisuals(faction).worldScale);rifle.rotation.y=Math.PI;riflePivot.add(rifle);
  const muzzle=new THREE.Object3D();muzzle.name='muzzle-anchor';muzzle.position.set(...getRifleVisuals(faction).muzzle);rifle.add(muzzle);
  const clip=new THREE.Group();clip.name='world-charger';rifle.add(clip);clip.visible=false;
  rounded(clip,[0,0,.023],[.087,.012,.009],metal,.002);
  const clipRounds=new THREE.Group();clipRounds.name='world-charger-rounds';clip.add(clipRounds);
  for(let i=0;i<5;i++){
    const casing=add(clipRounds,new THREE.CylinderGeometry(.006,.006,.049,10),metal,[(i-2)*.017,0,-.001]);casing.rotation.x=Math.PI/2;
    const bullet=add(clipRounds,new THREE.ConeGeometry(.005,.018,10),leatherEdge,[(i-2)*.017,0,-.034]);bullet.rotation.x=-Math.PI/2;
  }
  const grenade=makeStielhandgranate(faction,false);grenade.visible=false;soldier.add(grenade);
  const rig:SoldierRig={faction,...bodyRig,riflePivot,rifle,clip,clipRounds,grenade};
  soldier.userData.soldierRig=rig;
  soldier.userData.uniform??=faction==='british'?'Battledress / Mk II / Pattern 1937':faction==='russian'?'Gymnastiorka / SSh-40 / veshmeshok':'Feldbluse / Stahlhelm / Y-straps';
  applySoldierPose(soldier,sampleSoldierPose({id:0,x:0,y:0,z:0,yaw:0,pitch:0,stance:'stand',alive:true,moving:0,ads:false,recoil:0,cooldown:0,reload:0,reloadTotal:0},faction,0));
  soldier.traverse(object=>{if(object instanceof THREE.Mesh){object.castShadow=true;object.receiveShadow=true;}});
  return soldier;
}
