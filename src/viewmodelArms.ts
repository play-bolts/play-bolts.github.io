import * as THREE from 'three';

export type ArmSide='left'|'right';
export const VIEWMODEL_UPPER_ARM=.31;
export const VIEWMODEL_FOREARM=.285;
export const VIEWMODEL_SHOULDERS={left:new THREE.Vector3(-.20,-.22,.025),right:new THREE.Vector3(.20,-.22,.025)};
export const VIEWMODEL_HIP_POSITION=[.105,-.235,-.04] as const;
export const VIEWMODEL_GRENADE_POSITION=[.16,-.20,-.28] as const;

export interface ViewmodelArm {
 mesh:THREE.SkinnedMesh;upper:THREE.Bone;lower:THREE.Bone;cuff:THREE.Bone;
 shoulder:THREE.Vector3;elbow:THREE.Vector3;wrist:THREE.Vector3;
 reachError:number;wristBend:number;
}

/** One continuous garment with blended elbow and forearm twist weights. The
 * sleeves have real segment lengths: their geometry is never stretched to
 * hide an unreachable hand target. */
export function makeViewmodelArm(material:THREE.Material,side:ArmSide):ViewmodelArm {
 const rings=48,sides=24,length=VIEWMODEL_UPPER_ARM+VIEWMODEL_FOREARM;
 const position:number[]=[],uv:number[]=[],indices:number[]=[],skinIndices:number[]=[],weights:number[]=[];
 for(let j=0;j<=rings;j++){
  const t=j/rings,s=t*length;
  const radius=s<VIEWMODEL_UPPER_ARM?THREE.MathUtils.lerp(.064,.048,s/VIEWMODEL_UPPER_ARM):THREE.MathUtils.lerp(.048,.030,(s-VIEWMODEL_UPPER_ARM)/VIEWMODEL_FOREARM);
  const elbowBlend=THREE.MathUtils.smoothstep(s,VIEWMODEL_UPPER_ARM-.038,VIEWMODEL_UPPER_ARM+.038);
  const cuffBlend=THREE.MathUtils.smoothstep(s,length-.15,length-.008)*.7;
  for(let i=0;i<=sides;i++){
   const a=i/sides*Math.PI*2,fold=Math.sin(Math.PI*t)*(.0016*Math.sin(t*43+Math.sin(a*2))+.0007*Math.sin(t*79-a*3));
   position.push(Math.cos(a)*(radius+fold),s,Math.sin(a)*(radius+fold)*.86);uv.push(i/sides,t*2);
   skinIndices.push(0,1,2,0);weights.push(1-elbowBlend,elbowBlend*(1-cuffBlend),elbowBlend*cuffBlend,0);
   if(j<rings&&i<sides){const k=j*(sides+1)+i,n=k+sides+1;indices.push(k,n,k+1,n,n+1,k+1);}
  }
 }
 const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute(position,3));geometry.setAttribute('uv',new THREE.Float32BufferAttribute(uv,2));
 geometry.setAttribute('skinIndex',new THREE.Uint16BufferAttribute(skinIndices,4));geometry.setAttribute('skinWeight',new THREE.Float32BufferAttribute(weights,4));geometry.setIndex(indices);geometry.computeVertexNormals();
 geometry.name='continuous-anatomical-sleeve';
 const mesh=new THREE.SkinnedMesh(geometry,material);mesh.name=side+'-continuous-sleeve';mesh.frustumCulled=false;mesh.castShadow=mesh.receiveShadow=true;
 const upper=new THREE.Bone(),lower=new THREE.Bone(),cuff=new THREE.Bone();upper.name=side+'-sleeve-upper';lower.name=side+'-sleeve-forearm';cuff.name=side+'-sleeve-cuff';
 lower.position.y=VIEWMODEL_UPPER_ARM;cuff.position.y=VIEWMODEL_FOREARM;upper.add(lower);lower.add(cuff);mesh.add(upper);mesh.bind(new THREE.Skeleton([upper,lower,cuff]));
 return {mesh,upper,lower,cuff,shoulder:new THREE.Vector3(),elbow:new THREE.Vector3(),wrist:new THREE.Vector3(),reachError:0,wristBend:0};
}

/** Fixed-length two-bone solve with a deterministic, body-relative elbow arc.
 * The elbow moves on the physical reach circle around a low body-relative
 * pole. Wrist comfort is a soft objective, not a cone that can select the
 * opposite tangent branch as the hand turns through the reach axis. */
export function solveViewmodelArm(side:ArmSide,wrist:THREE.Vector3,wristExit:THREE.Vector3,shoulder=VIEWMODEL_SHOULDERS[side],strikeFreedom=0) {
 const u=VIEWMODEL_UPPER_ARM,l=VIEWMODEL_FOREARM,delta=wrist.clone().sub(shoulder),rawDistance=delta.length();
 const axis=rawDistance>1e-8?delta.clone().divideScalar(rawDistance):new THREE.Vector3(0,0,-1);
 const distance=THREE.MathUtils.clamp(rawDistance,Math.abs(u-l)+.001,u+l-.001);
 const end=shoulder.clone().addScaledVector(axis,distance);
 const along=(u*u-l*l+distance*distance)/(2*distance),radius=Math.sqrt(Math.max(0,u*u-along*along));
 const center=shoulder.clone().addScaledVector(axis,along),sign=side==='left'?-1:1;
 // The support elbow stays below the fore-end instead of flaring sideways.
 // Its narrower continuous arc keeps the sleeve close to the rifle without
 // switching elbow branches as ADS and recoil move the hand through the axis.
 // A small outward offset lets the forearm approach the stock at a natural
 // angle while retaining the compact lower-left silhouette and exact grip.
 const pole=(side==='left'?new THREE.Vector3(.015,-.62,-.08):new THREE.Vector3(sign*.34,-.50,-.08)).sub(center);
 pole.addScaledVector(axis,-pole.dot(axis));
 if(pole.lengthSq()<1e-9)pole.set(sign,-1,0).addScaledVector(axis,-(sign*axis.x-axis.y));
 pole.normalize();
 const tangent=new THREE.Vector3().crossVectors(axis,pole);
 const exit=wristExit.clone().normalize(),offset=exit.dot(center.clone().sub(end))/l;
 // The wrist cosine is offset + a*cos(angle) + b*sin(angle). Regularize
 // its projection before weighting it: an axial wrist has vanishing plane
 // influence rather than acquiring an arbitrary normalized direction.
 const a=radius/l*exit.dot(pole),b=radius/l*exit.dot(tangent);
 const target=Math.cos(28*Math.PI/180),influence=Math.sqrt(a*a+b*b+.02*.02);
 let angle=0;
 // Minimize wrist deviation, distance from the low pole and torso crossing
 // in one angular solve. Fixed bounded steps make scrubbing deterministic;
 // there is no previous-frame elbow or sequential constraint projection.
 for(let i=0;i<80;i++){
  const c=Math.cos(angle),s=Math.sin(angle),error=Math.max(0,target-offset-a*c-b*s);
  const outer=center.x*sign+radius*sign*(pole.x*c+tangent.x*s),outerError=Math.max(0,(side==='left'?-.08:.065)-outer);
  const freedom=THREE.MathUtils.clamp(strikeFreedom,0,1);
  const gradient=(side==='left'?THREE.MathUtils.lerp(.3,.01,freedom):.01)*angle-4*error*(-a*s+b*c)/influence-8*outerError*radius*sign*(-pole.x*s+tangent.x*c);
  const limit=side==='left'?THREE.MathUtils.lerp(1.2,2.5,freedom):2.5;
  angle=THREE.MathUtils.clamp(angle-.10*gradient,-limit,limit);
 }
 const direction=pole.multiplyScalar(Math.cos(angle)).addScaledVector(tangent,Math.sin(angle));
 const elbow=center.addScaledVector(direction,radius);
 return {shoulder:shoulder.clone(),elbow,wrist:end,reachError:rawDistance-distance,wristBend:wristExit.angleTo(elbow.clone().sub(end))};
}

function frame(direction:THREE.Vector3,width:THREE.Vector3){
 const y=direction.clone().normalize(),x=width.clone().addScaledVector(y,-width.dot(y));
 if(x.lengthSq()<1e-8){x.set(Math.abs(y.x)<.8?1:0,Math.abs(y.x)<.8?0:1,0);x.addScaledVector(y,-x.dot(y));}x.normalize();
 return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x,y,new THREE.Vector3().crossVectors(x,y)));
}

/** All targets enter in camera/body space; convert the final physical chain
 * back into weapon-local coordinates only after the solve. */
export function poseViewmodelArm(arm:ViewmodelArm,side:ArmSide,wristLocal:THREE.Vector3,wristExitLocal:THREE.Vector3,wristWidthLocal:THREE.Vector3,bodyFromWeapon:THREE.Matrix4,strikeFreedom=0){
 const inverse=bodyFromWeapon.clone().invert();
 const wrist=wristLocal.clone().applyMatrix4(bodyFromWeapon),exit=wristExitLocal.clone().transformDirection(bodyFromWeapon),width=wristWidthLocal.clone().transformDirection(bodyFromWeapon);
 const solution=solveViewmodelArm(side,wrist,exit,undefined,strikeFreedom);
 arm.shoulder.copy(solution.shoulder);arm.elbow.copy(solution.elbow);arm.wrist.copy(solution.wrist);arm.reachError=solution.reachError;arm.wristBend=solution.wristBend;
 const shoulder=solution.shoulder.clone().applyMatrix4(inverse),elbow=solution.elbow.clone().applyMatrix4(inverse),end=solution.wrist.clone().applyMatrix4(inverse);
 const localWidth=width.transformDirection(inverse),upperQ=frame(elbow.clone().sub(shoulder),new THREE.Vector3(1,0,0).transformDirection(inverse));
 const lowerQ=frame(end.clone().sub(elbow),localWidth);
 arm.upper.position.copy(shoulder);arm.upper.quaternion.copy(upperQ);
 arm.lower.quaternion.copy(upperQ).invert().multiply(lowerQ);
 const cuffQ=frame(wristExitLocal.clone().negate(),wristWidthLocal);
 arm.cuff.quaternion.copy(lowerQ).invert().multiply(cuffQ);
 arm.mesh.updateMatrixWorld(true);arm.mesh.skeleton.update();
 return {elbow,end,shoulder,reachError:solution.reachError};
}

export function defaultWeaponBodyMatrix(position:readonly number[]=VIEWMODEL_HIP_POSITION,rotation:readonly number[]=[0,-.035,0]){
 return new THREE.Matrix4().compose(new THREE.Vector3(...position as [number,number,number]),new THREE.Quaternion().setFromEuler(new THREE.Euler(...rotation as [number,number,number])),new THREE.Vector3(1,1,1));
}
