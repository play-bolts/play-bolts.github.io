import * as THREE from 'three';

export type WeatheringKind='canvas'|'stone'|'ground'|'wood';

/** Metre-scale wear complements the photographed millimetre-scale maps.
 * World coordinates prevent every crate repeating the same stains. This is
 * local material shading, with no screen-space passes or extra texture fetches. */
export function weatherSurface(material:THREE.MeshStandardMaterial,kind:WeatheringKind,size:readonly[number,number,number]=[1,1,1]) {
  const inherited=material.onBeforeCompile,cacheKey=material.customProgramCacheKey();
  material.userData.weathering=kind;
  material.onBeforeCompile=(shader,renderer)=>{
    inherited(shader,renderer);
    shader.uniforms.boltsHalfSize={value:new THREE.Vector3(...size).multiplyScalar(.5)};
    const varyings='varying vec3 vBoltsWorld;\nvarying vec3 vBoltsLocal;\nvarying vec3 vBoltsNormal;\n';
    shader.vertexShader=varyings+shader.vertexShader;
    shader.vertexShader=shader.vertexShader.replace('#include <project_vertex>',`#include <project_vertex>
      vBoltsWorld=(modelMatrix*vec4(transformed,1.0)).xyz;
      vBoltsLocal=position;
      vBoltsNormal=normalize(mat3(modelMatrix)*objectNormal);`);
    shader.fragmentShader=varyings+`uniform vec3 boltsHalfSize;
      float boltsHash(vec2 p){vec3 q=fract(vec3(p.xyx)*.1031);q+=dot(q,q.yzx+33.33);return fract((q.x+q.y)*q.z);}
      float boltsNoise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.0-2.0*f);return mix(mix(boltsHash(i),boltsHash(i+vec2(1,0)),f.x),mix(boltsHash(i+vec2(0,1)),boltsHash(i+vec2(1,1)),f.x),f.y);}
      `+shader.fragmentShader;
    const code={
      canvas:`
        vec2 stainUV=vec2(vBoltsWorld.x+vBoltsWorld.z*.73,vBoltsWorld.y+vBoltsWorld.z*.27);
        float broad=boltsNoise(stainUV*.8),fine=boltsNoise(stainUV*3.1);
        float sides=1.0-abs(normalize(vBoltsNormal).y);
        float hem=min(vBoltsLocal.y+boltsHalfSize.y,boltsHalfSize.y-vBoltsLocal.y);
        float corner=mix(boltsHalfSize.x-abs(vBoltsLocal.x),boltsHalfSize.z-abs(vBoltsLocal.z),abs(normalize(vBoltsNormal).x));
        float folds=(.5+.5*sin(stainUV.x*17.0+broad*5.0))*exp(-max(0.0,boltsHalfSize.y-vBoltsLocal.y)*2.0);
        float seamShade=(exp(-max(hem,0.0)*24.0)*.13+exp(-max(corner,0.0)*15.0)*.15+folds*.035)*sides;
        float lowerDirt=exp(-max(0.0,vBoltsLocal.y+boltsHalfSize.y)*2.1)*(.12+fine*.12);
        diffuseColor.rgb*=mix(vec3(.72,.76,.70),vec3(1.08,1.07,1.01),broad)*(.94+fine*.08-seamShade-lowerDirt);
      `,
      ground:`
        float broad=boltsNoise(vBoltsWorld.xz*.22),fine=boltsNoise(vBoltsWorld.xz*1.8);
        diffuseColor.rgb*=mix(vec3(.69,.73,.71),vec3(1.08,1.04,.98),broad)*(.90+fine*.15);
      `,
      stone:`
        float broad=boltsNoise(vec2(vBoltsWorld.x+vBoltsWorld.z*.63,vBoltsWorld.y)*.53);
        float damp=exp(-max(vBoltsWorld.y,0.0)*1.8)*(.16+broad*.12);
        diffuseColor.rgb*=vec3(.93,.96,.98)*( .86+broad*.23-damp );
      `,
      wood:`
        float plank=floor(vBoltsWorld.y/.23),seam=abs(fract(vBoltsWorld.y/.23)-.5);
        float joint=smoothstep(.477,.498,seam)*.36;
        float grainWear=boltsNoise(vec2(vBoltsWorld.x+vBoltsWorld.z*.8,vBoltsWorld.y)*1.7);
        diffuseColor.rgb*=.78+boltsHash(vec2(plank,3.7))*.19+grainWear*.12-joint;
      `,
    }[kind];
    shader.fragmentShader=shader.fragmentShader.replace('#include <color_fragment>','#include <color_fragment>\n'+code);
  };
  material.customProgramCacheKey=()=>`${cacheKey}/weather-${kind}-v1`;
  return material;
}

/** Tight rectangular ambient contact, instead of a circular shadow halo. */
export function makeBoxContact(width:number,depth:number) {
  const margin=.9,size=new THREE.Vector2(width+margin*2,depth+margin*2);
  const material=new THREE.ShaderMaterial({
    uniforms:{contactSize:{value:size},contactBox:{value:new THREE.Vector2(width,depth).multiplyScalar(.5)}},
    vertexShader:'varying vec2 vContactUv;void main(){vContactUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}',
    fragmentShader:`varying vec2 vContactUv;uniform vec2 contactSize;uniform vec2 contactBox;
      void main(){vec2 q=abs((vContactUv-.5)*contactSize)-contactBox;
      float distanceToBox=length(max(q,0.0))+min(max(q.x,q.y),0.0);
      float alpha=.32*exp(-max(distanceToBox,0.0)*8.0);
      gl_FragColor=vec4(.075,.080,.070,alpha);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
      }`,
    transparent:true,depthWrite:false,polygonOffset:true,polygonOffsetFactor:-1,
  });
  const shadow=new THREE.Mesh(new THREE.PlaneGeometry(size.x,size.y),material);
  shadow.name='crate-contact-shadow';shadow.rotation.x=-Math.PI/2;return shadow;
}
