import * as THREE from 'three';
import {makeParticleCloud,updateParticleCloud,seededFeedback,type FeedbackParticle} from './particleFeedback';

export const MUZZLE_FLASH_SECONDS=.080;
export const MUZZLE_EFFECT_SECONDS=.72;
export const MUZZLE_PRESSURE_SECONDS=.065;
export const MUZZLE_FLASH_RADII={local:.168,world:.269} as const;

/** Shot-time sampling makes a replay and a live shot use the same brief pulse. */
export function sampleMuzzleFlash(elapsed:number){
 const visible=Number.isFinite(elapsed)&&elapsed>=0&&elapsed<MUZZLE_FLASH_SECONDS;
 if(!visible)return{visible:false,scale:1,opacity:0,light:0};
 const t=elapsed/MUZZLE_FLASH_SECONDS,fade=1-t;
 return{visible:true,scale:1-.16*t,opacity:Math.sqrt(fade),light:14*fade*fade};
}

/** Crossing tapered ribbons give the flame volume without an opaque cone.
 * Everything points down rifle-local -Z, starting at the barrel opening. */
export function makeMuzzleFlash(radius:number):THREE.Group {
 const flash=new THREE.Group();flash.name='muzzle-flash';flash.visible=false;
 const flameMaterial=new THREE.ShaderMaterial({transparent:true,depthWrite:false,side:THREE.DoubleSide,blending:THREE.AdditiveBlending,toneMapped:false,uniforms:{age:{value:0},opacity:{value:1},seed:{value:0}},
  vertexShader:'varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
  fragmentShader:`varying vec2 vUv;uniform float age;uniform float opacity;uniform float seed;
   float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
   float noise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y);}
   void main(){float t=vUv.y;float n=noise(vec2(vUv.x*9.+seed,t*12.-age*95.))*.55+noise(vec2(vUv.x*21.,t*25.-age*120.+seed))*.3+noise(vec2(vUv.x*43.+seed,t*39.-age*145.))*.15;
    float width=(.15+sin(t*3.14159)*.85)*pow(1.-t,.55);float x=abs((vUv.x-.5)*2.+sin(t*18.-age*90.)*.06);
    float edge=width*(.58+n*.6);float alpha=(1.-smoothstep(edge*.24,edge,x))*(1.-smoothstep(.65,1.,t))*opacity*(.82+.18*sin(age*470.+seed));
    vec3 color=mix(vec3(1.,.20,.025),vec3(1.,.65,.15),n);color=mix(color,vec3(1.,.98,.80),(1.-smoothstep(.0,.46,t))*(1.-smoothstep(0.,.25,x)));
    if(alpha<.006)discard;gl_FragColor=vec4(color,alpha);
    #include <colorspace_fragment>
   }`
 });
 const ribbon=new THREE.PlaneGeometry(radius*2,radius*3.5,1,4);ribbon.translate(0,radius*1.75,0);ribbon.rotateX(-Math.PI/2);
 for(let i=0;i<3;i++){const flame=new THREE.Mesh(ribbon,flameMaterial);flame.name='flame-ribbon';flame.rotation.z=i*Math.PI/3;flash.add(flame);}
 const core=new THREE.Mesh(new THREE.SphereGeometry(radius*.23,12,8),new THREE.MeshBasicMaterial({color:0xfff6db,transparent:true,opacity:1,depthWrite:false,blending:THREE.AdditiveBlending,toneMapped:false}));
 core.name='flash-core';core.scale.z=2.5;core.position.z=-radius*.46;flash.add(core);
 const pressureMaterial=new THREE.ShaderMaterial({transparent:true,depthWrite:false,side:THREE.DoubleSide,toneMapped:false,uniforms:{opacity:{value:0},age:{value:0}},
  vertexShader:'varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
  fragmentShader:`varying vec2 vUv;uniform float opacity;uniform float age;
   void main(){vec2 p=(vUv-.5)*2.;float radius=length(p);float ripple=sin(atan(p.y,p.x)*9.+age*24.)*.035;float ring=exp(-pow((radius-.62+ripple)*14.,2.));
    float alpha=ring*opacity;if(alpha<.004)discard;gl_FragColor=vec4(vec3(.64,.60,.50),alpha);
    #include <colorspace_fragment>
   }`
 });
 const pressure=new THREE.Mesh(new THREE.PlaneGeometry(radius*2,radius*2),pressureMaterial);pressure.name='muzzle-pressure';pressure.userData.radius=radius;flash.add(pressure);
 const r=seededFeedback(10577),smoke:FeedbackParticle[]=[],sparks:FeedbackParticle[]=[];
 for(let i=0;i<14;i++)smoke.push({position:[(r()-.5)*radius*.3,(r()-.5)*radius*.3,-radius*(.35+r()*1.8)],velocity:[(r()-.5)*radius*1.1,radius*(.45+r()*.8),-radius*(.8+r()*1.6)],delay:.018+r()*.055,life:.40+r()*.23,size:radius*(.42+r()*.65),stretch:1.1,growth:2.5,gravity:0,drag:1.8,color:i%3===0?0xb9b5a9:0x85837b,opacity:.13+r()*.10,kind:'mist',seed:r()});
 for(let i=0;i<18;i++){const angle=r()*Math.PI*2,speed=radius*(7+r()*11);sparks.push({position:[0,0,-radius*.3],velocity:[Math.cos(angle)*radius*(1+r()*2),Math.sin(angle)*radius*(1+r()*2),-speed],delay:r()*.012,life:.065+r()*.13,size:radius*(.02+r()*.03),stretch:3+r()*6,growth:-.5,gravity:.7,drag:1.4,color:i%3===0?0xffefbd:0xff9b2c,opacity:.95,kind:'spark',seed:r()});}
 const smokeCloud=makeParticleCloud(smoke);smokeCloud.name='muzzle-smoke';flash.add(smokeCloud);
 const sparkCloud=makeParticleCloud(sparks);sparkCloud.name='muzzle-sparks';(sparkCloud.material as THREE.ShaderMaterial).blending=THREE.AdditiveBlending;flash.add(sparkCloud);
 return flash;
}

export function updateMuzzleFlash(flash:THREE.Group,elapsed:number,light?:THREE.PointLight,seed=0){
 const pulse=sampleMuzzleFlash(elapsed);flash.visible=Number.isFinite(elapsed)&&elapsed>=0&&elapsed<MUZZLE_EFFECT_SECONDS;flash.scale.setScalar(1);
 for(const child of flash.children){
  if(child instanceof THREE.InstancedMesh){updateParticleCloud(child,elapsed);continue;}
  if(!(child instanceof THREE.Mesh))continue;
  if(child.name==='muzzle-pressure'){
   const active=Number.isFinite(elapsed)&&elapsed>=0&&elapsed<MUZZLE_PRESSURE_SECONDS,t=active?elapsed/MUZZLE_PRESSURE_SECONDS:1;
   child.visible=active;child.scale.setScalar(.28+t*1.8);child.position.z=-child.userData.radius*(.3+t*1.5);
   const material=child.material as THREE.ShaderMaterial;material.uniforms.opacity.value=active?.21*Math.pow(1-t,1.7):0;material.uniforms.age.value=active?elapsed:0;continue;
  }
  child.visible=pulse.visible;child.scale.x=child.scale.y=pulse.scale;
  if(child.material instanceof THREE.ShaderMaterial){child.material.uniforms.age.value=elapsed;child.material.uniforms.opacity.value=pulse.opacity;child.material.uniforms.seed.value=(seed%997)/97;}
  else (child.material as THREE.MeshBasicMaterial).opacity=pulse.opacity;
 }
 if(light)light.intensity=pulse.light;
 return pulse;
}

/** Keep the world flash attached to the actual animated barrel, including lean. */
export function placeMuzzleFlash(flash:THREE.Object3D,anchor:THREE.Object3D){
 anchor.updateWorldMatrix(true,false);anchor.getWorldPosition(flash.position);anchor.getWorldQuaternion(flash.quaternion);
}
