import * as THREE from 'three';

export type ParticleKind='mist'|'drop'|'spark';
export interface FeedbackParticle {
 position:[number,number,number];velocity:[number,number,number];
 delay:number;life:number;size:number;stretch:number;growth:number;
 gravity:number;drag:number;color:number;opacity:number;kind:ParticleKind;seed:number;
}

/** Absolute age, rather than frame integration, also supports killcam seeking. */
export function sampleFeedbackParticle(p:FeedbackParticle,age:number){
 const t=age-p.delay,visible=Number.isFinite(t)&&t>=0&&t<p.life;
 if(!visible)return{visible:false,position:[...p.position] as [number,number,number],size:0,opacity:0};
 const travel=p.drag>0?(1-Math.exp(-p.drag*t))/p.drag:t,progress=t/p.life;
 return{visible:true,position:[p.position[0]+p.velocity[0]*travel,p.position[1]+p.velocity[1]*travel-.5*p.gravity*t*t,p.position[2]+p.velocity[2]*travel] as [number,number,number],size:p.size*(1+p.growth*progress),opacity:p.opacity*Math.pow(1-progress,p.kind==='mist'?.85:1.4)*Math.min(1,t/.012+.3)};
}

/** One draw call per burst. Soft silhouettes are generated in the shader. */
export function makeParticleCloud(particles:FeedbackParticle[]){
 const geometry=new THREE.PlaneGeometry(1,1),count=particles.length;
 const color=new Float32Array(count*3),direction=new Float32Array(count*3),style=new Float32Array(count*2),alpha=new Float32Array(count);
 for(let i=0;i<count;i++){
  const p=particles[i],tint=new THREE.Color(p.color);tint.toArray(color,i*3);direction.set(p.velocity,i*3);
  style[i*2]=p.kind==='mist'?0:p.kind==='drop'?1:2;style[i*2+1]=p.seed;
 }
 geometry.setAttribute('particleColor',new THREE.InstancedBufferAttribute(color,3));
 geometry.setAttribute('particleDirection',new THREE.InstancedBufferAttribute(direction,3));
 geometry.setAttribute('particleStyle',new THREE.InstancedBufferAttribute(style,2));
 geometry.setAttribute('particleAlpha',new THREE.InstancedBufferAttribute(alpha,1));
 const material=new THREE.ShaderMaterial({transparent:true,depthWrite:false,side:THREE.DoubleSide,toneMapped:false,
  vertexShader:`attribute vec3 particleColor;attribute vec3 particleDirection;attribute vec2 particleStyle;attribute float particleAlpha;
   varying vec2 vUv;varying vec3 vColor;varying vec2 vStyle;varying float vAlpha;
   void main(){vUv=uv;vColor=particleColor;vStyle=particleStyle;vAlpha=particleAlpha;
    vec4 center=modelViewMatrix*instanceMatrix*vec4(0.,0.,0.,1.);
    vec2 motion=(modelViewMatrix*vec4(particleDirection,0.)).xy;
    vec2 up=length(motion)>.001?normalize(motion):vec2(0.,1.);vec2 right=vec2(up.y,-up.x);
    if(particleStyle.x<.5){float a=particleStyle.y*6.283;up=vec2(sin(a),cos(a));right=vec2(up.y,-up.x);}
    vec2 size=vec2(length(instanceMatrix[0].xyz),length(instanceMatrix[1].xyz));
    center.xy+=right*position.x*size.x+up*position.y*size.y;
    gl_Position=projectionMatrix*center;
   }`,
  fragmentShader:`varying vec2 vUv;varying vec3 vColor;varying vec2 vStyle;varying float vAlpha;
   float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
   float noise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y);}
   void main(){vec2 p=(vUv-.5)*2.;float alpha;
    if(vStyle.x<.5){float n=noise(vUv*5.+vStyle.y*19.)*.6+noise(vUv*11.+vStyle.y*7.)*.4;alpha=(1.-smoothstep(.20,.99,length(p)+(n-.5)*.36))*(.45+.55*n);}
    else if(vStyle.x<1.5){p.x*=1.+p.y*.3;alpha=1.-smoothstep(.52,1.,dot(p,p));}
    else{alpha=exp(-p.x*p.x*15.)*(1.-smoothstep(.25,1.,abs(p.y)));}
    alpha*=vAlpha;if(alpha<.005)discard;gl_FragColor=vec4(vColor,alpha);
    #include <colorspace_fragment>
   }`
 });
 const cloud=new THREE.InstancedMesh(geometry,material,count);cloud.name='feedback-particles';cloud.frustumCulled=false;cloud.instanceMatrix.setUsage(THREE.DynamicDrawUsage);cloud.userData.particles=particles;
 updateParticleCloud(cloud,-1);return cloud;
}

const transform=new THREE.Object3D();
export function updateParticleCloud(cloud:THREE.InstancedMesh,age:number){
 const particles=cloud.userData.particles as FeedbackParticle[],alpha=cloud.geometry.getAttribute('particleAlpha') as THREE.InstancedBufferAttribute;let visible=false;
 for(let i=0;i<particles.length;i++){
  const p=particles[i],t=age-p.delay,active=Number.isFinite(t)&&t>=0&&t<p.life;visible||=active;
  let size=0,opacity=0;
  if(active){const travel=p.drag>0?(1-Math.exp(-p.drag*t))/p.drag:t,progress=t/p.life;
   transform.position.set(p.position[0]+p.velocity[0]*travel,p.position[1]+p.velocity[1]*travel-.5*p.gravity*t*t,p.position[2]+p.velocity[2]*travel);
   size=p.size*(1+p.growth*progress);opacity=p.opacity*Math.pow(1-progress,p.kind==='mist'?.85:1.4)*Math.min(1,t/.012+.3);
  }else transform.position.set(...p.position);
  transform.scale.set(size,size*p.stretch,size);transform.updateMatrix();cloud.setMatrixAt(i,transform.matrix);alpha.setX(i,opacity);
 }
 cloud.instanceMatrix.needsUpdate=true;alpha.needsUpdate=true;cloud.visible=visible;return visible;
}

/** Refill an existing burst without allocating new GPU geometry or shaders. */
export function resetParticleCloud(cloud:THREE.InstancedMesh,particles:FeedbackParticle[]){
 if(particles.length!==cloud.count)throw new Error('Particle pool capacity mismatch');
 const geometry=cloud.geometry,color=geometry.getAttribute('particleColor'),direction=geometry.getAttribute('particleDirection'),style=geometry.getAttribute('particleStyle'),tint=new THREE.Color();
 for(let i=0;i<particles.length;i++){const p=particles[i];tint.setHex(p.color);color.setXYZ(i,tint.r,tint.g,tint.b);direction.setXYZ(i,...p.velocity);style.setXY(i,p.kind==='mist'?0:p.kind==='drop'?1:2,p.seed);}
 color.needsUpdate=direction.needsUpdate=style.needsUpdate=true;cloud.userData.particles=particles;updateParticleCloud(cloud,-1);
}

export function seededFeedback(seed:number){let state=seed>>>0;return()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state/4294967296;};}
