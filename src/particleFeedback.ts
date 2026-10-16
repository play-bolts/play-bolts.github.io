import * as THREE from 'three';

export type ParticleKind='mist'|'drop'|'spark'|'wisp';
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

const particleStyle=(kind:ParticleKind)=>kind==='mist'?0:kind==='drop'?1:kind==='spark'?2:3;

/** One draw call per burst. Soft silhouettes and their breakup are generated in the shader. */
export function makeParticleCloud(particles:FeedbackParticle[]){
 const geometry=new THREE.PlaneGeometry(1,1),count=particles.length;
 const color=new Float32Array(count*3),direction=new Float32Array(count*3),style=new Float32Array(count*2),alpha=new Float32Array(count),progress=new Float32Array(count);
 for(let i=0;i<count;i++){
  const p=particles[i],tint=new THREE.Color(p.color);tint.toArray(color,i*3);direction.set(p.velocity,i*3);
  style[i*2]=particleStyle(p.kind);style[i*2+1]=p.seed;
 }
 geometry.setAttribute('particleColor',new THREE.InstancedBufferAttribute(color,3));
 geometry.setAttribute('particleDirection',new THREE.InstancedBufferAttribute(direction,3));
 geometry.setAttribute('particleStyle',new THREE.InstancedBufferAttribute(style,2));
 geometry.setAttribute('particleAlpha',new THREE.InstancedBufferAttribute(alpha,1));
 geometry.setAttribute('particleProgress',new THREE.InstancedBufferAttribute(progress,1));
 for(const attribute of ['particleDirection','particleAlpha','particleProgress'])(geometry.getAttribute(attribute) as THREE.InstancedBufferAttribute).setUsage(THREE.DynamicDrawUsage);
 const material=new THREE.ShaderMaterial({transparent:true,depthWrite:false,side:THREE.DoubleSide,toneMapped:false,
  vertexShader:`attribute vec3 particleColor;attribute vec3 particleDirection;attribute vec2 particleStyle;attribute float particleAlpha;attribute float particleProgress;
   varying vec2 vUv;varying vec3 vColor;varying vec2 vStyle;varying float vAlpha;varying float vProgress;
   void main(){vUv=uv;vColor=particleColor;vStyle=particleStyle;vAlpha=particleAlpha;vProgress=particleProgress;
    vec4 center=modelViewMatrix*instanceMatrix*vec4(0.,0.,0.,1.);
    vec2 motion=(modelViewMatrix*vec4(particleDirection,0.)).xy;
    vec2 up=length(motion)>.001?normalize(motion):vec2(0.,1.);vec2 right=vec2(up.y,-up.x);
    if(particleStyle.x<.5){float a=particleStyle.y*6.283+particleProgress*(particleStyle.y-.5)*1.6;up=vec2(sin(a),cos(a));right=vec2(up.y,-up.x);}
    vec2 size=vec2(length(instanceMatrix[0].xyz),length(instanceMatrix[1].xyz));
    center.xy+=right*position.x*size.x+up*position.y*size.y;
    gl_Position=projectionMatrix*center;
   }`,
  fragmentShader:`varying vec2 vUv;varying vec3 vColor;varying vec2 vStyle;varying float vAlpha;varying float vProgress;
   float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
   float noise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y);}
   void main(){vec2 p=(vUv-.5)*2.;float alpha;vec3 color=vColor;
    if(vStyle.x<.5){vec2 drift=vec2(vProgress*.65,-vProgress*.9);float n=noise(vUv*4.+vStyle.y*19.+drift)*.55+noise(vUv*9.+vStyle.y*7.-drift)*.3+noise(vUv*19.+drift)*.15;
     alpha=(1.-smoothstep(.12,.99,length(p)+(n-.5)*.5))*(.32+.68*n);color*=.72+n*.5;}
    else if(vStyle.x<1.5){p.x*=1.+p.y*.3;float edge=dot(p,p);alpha=1.-smoothstep(.48,1.,edge);
     float highlight=exp(-dot(p-vec2(-.23,.28),p-vec2(-.23,.28))*19.);color=color*(.65+.35*(1.-edge))+vec3(.18,.08,.06)*highlight;}
    else if(vStyle.x<2.5){alpha=exp(-p.x*p.x*18.)*(1.-smoothstep(.2,1.,abs(p.y)));color=mix(color,vec3(1.,.97,.78),exp(-dot(p,p)*12.)*.55);}
    else{float n=noise(vec2(vUv.x*8.+vStyle.y*17.,vUv.y*12.-vProgress*2.));float ribbon=abs(p.x+sin(p.y*5.+vStyle.y*9.)*.2);
     alpha=(1.-smoothstep(.08,.72,ribbon))*(1.-smoothstep(.2,1.,abs(p.y)))*smoothstep(.22+vProgress*.35,.66,n);color*=.7+n*.6;}
    alpha*=vAlpha;if(alpha<.005)discard;gl_FragColor=vec4(color,alpha);
    #include <colorspace_fragment>
   }`
 });
 const cloud=new THREE.InstancedMesh(geometry,material,count);cloud.name='feedback-particles';cloud.frustumCulled=false;cloud.instanceMatrix.setUsage(THREE.DynamicDrawUsage);cloud.userData.particles=particles;
 updateParticleCloud(cloud,-1);return cloud;
}

const transform=new THREE.Object3D();
export function updateParticleCloud(cloud:THREE.InstancedMesh,age:number){
 const particles=cloud.userData.particles as FeedbackParticle[],alpha=cloud.geometry.getAttribute('particleAlpha') as THREE.InstancedBufferAttribute,progressAttribute=cloud.geometry.getAttribute('particleProgress'),direction=cloud.geometry.getAttribute('particleDirection');let visible=false;
 for(let i=0;i<particles.length;i++){
  const p=particles[i],t=age-p.delay,active=Number.isFinite(t)&&t>=0&&t<p.life;visible||=active;
  let size=0,opacity=0,progress=0;
  if(active){const damping=Math.exp(-p.drag*t),travel=p.drag>0?(1-damping)/p.drag:t;progress=t/p.life;
   transform.position.set(p.position[0]+p.velocity[0]*travel,p.position[1]+p.velocity[1]*travel-.5*p.gravity*t*t,p.position[2]+p.velocity[2]*travel);
   size=p.size*(1+p.growth*progress);opacity=p.opacity*Math.pow(1-progress,p.kind==='mist'?.85:1.4)*Math.min(1,t/.012+.3);
   direction.setXYZ(i,p.velocity[0]*damping,p.velocity[1]*damping-p.gravity*t,p.velocity[2]*damping);
  }else{transform.position.set(...p.position);direction.setXYZ(i,...p.velocity);}
  transform.scale.set(size,size*p.stretch,size);transform.updateMatrix();cloud.setMatrixAt(i,transform.matrix);alpha.setX(i,opacity);progressAttribute.setX(i,progress);
 }
 cloud.instanceMatrix.needsUpdate=true;alpha.needsUpdate=progressAttribute.needsUpdate=direction.needsUpdate=true;cloud.visible=visible;return visible;
}

/** Refill an existing burst without allocating new GPU geometry or shaders. */
export function resetParticleCloud(cloud:THREE.InstancedMesh,particles:FeedbackParticle[]){
 if(particles.length!==cloud.count)throw new Error('Particle pool capacity mismatch');
 const geometry=cloud.geometry,color=geometry.getAttribute('particleColor'),direction=geometry.getAttribute('particleDirection'),style=geometry.getAttribute('particleStyle'),tint=new THREE.Color();
 for(let i=0;i<particles.length;i++){const p=particles[i];tint.setHex(p.color);color.setXYZ(i,tint.r,tint.g,tint.b);direction.setXYZ(i,...p.velocity);style.setXY(i,particleStyle(p.kind),p.seed);}
 color.needsUpdate=direction.needsUpdate=style.needsUpdate=true;cloud.userData.particles=particles;updateParticleCloud(cloud,-1);
}

export function seededFeedback(seed:number){let state=seed>>>0;return()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state/4294967296;};}
