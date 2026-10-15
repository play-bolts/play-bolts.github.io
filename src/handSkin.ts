import * as THREE from 'three';

/** The source photographs supply skin and palm lines; these surface details are
 * measured in the unposed hand's metres, so they remain attached to the skin.
 * No transmission/clearcoat: broad dry-skin highlights must not read as wax. */
export function makeHandSkin(source:THREE.MeshStandardMaterial){
 const material=new THREE.MeshPhysicalMaterial({
  name:'bolts/anatomical-skin',map:source.map?.clone()??null,
  color:0xe9e7e3,roughness:.73,metalness:0,ior:1.4,specularIntensity:.55,
  side:THREE.FrontSide,
 });
 if(material.map)material.map.anisotropy=8;
 material.onBeforeCompile=shader=>{
  shader.vertexShader=`attribute vec3 skinDetail;
varying vec3 vSkinDetail;
varying vec3 vSkinRest;
${shader.vertexShader}`.replace('#include <begin_vertex>',`#include <begin_vertex>
 vSkinDetail=skinDetail;
 vSkinRest=position;`);
  shader.fragmentShader=`varying vec3 vSkinDetail;
varying vec3 vSkinRest;
float skinHash(vec3 p){
 p=fract(p*.1031);p+=dot(p,p.yzx+33.33);return fract((p.x+p.y)*p.z);
}
float skinNoise(vec3 p){
 vec3 cell=floor(p),f=fract(p);f=f*f*(3.0-2.0*f);
 return mix(mix(mix(skinHash(cell),skinHash(cell+vec3(1,0,0)),f.x),
  mix(skinHash(cell+vec3(0,1,0)),skinHash(cell+vec3(1,1,0)),f.x),f.y),
  mix(mix(skinHash(cell+vec3(0,0,1)),skinHash(cell+vec3(1,0,1)),f.x),
  mix(skinHash(cell+vec3(0,1,1)),skinHash(cell+vec3(1,1,1)),f.x),f.y),f.z);
}
${shader.fragmentShader}`;
  shader.fragmentShader=shader.fragmentShader.replace('#include <map_fragment>',`#include <map_fragment>
 float nailMask=clamp(vSkinDetail.x,0.0,1.0);
 float knuckleMask=clamp(vSkinDetail.y,0.0,1.0);
 float palmMask=clamp(vSkinDetail.z,0.0,1.0);
 float skinMottle=skinNoise(vSkinRest*170.0)-.5;
 float skinBroad=skinNoise(vSkinRest*47.0)-.5;
 float skinPhotoLuma=0.35;
 #ifdef USE_MAP
  skinPhotoLuma=dot(sampledDiffuseColor.rgb,vec3(.2126,.7152,.0722));
 #endif
 // The source already contains blood colour. Neutralize its orange cast
 // instead of multiplying it by another pink tint. Keep the photographed
 // creases and pads legible under the bright first-person fill light.
 float skinLuma=dot(diffuseColor.rgb,vec3(.2126,.7152,.0722));
 diffuseColor.rgb=mix(vec3(skinLuma),diffuseColor.rgb,.86);
 diffuseColor.rgb*=1.0+(skinPhotoLuma-.35)*.24+skinMottle*.045+skinBroad*.035;
 diffuseColor.rgb*=vec3(1.0+.018*palmMask,.995-.016*knuckleMask,.995-.012*knuckleMask);
 diffuseColor.rgb=mix(diffuseColor.rgb,diffuseColor.rgb*vec3(1.06,1.07,1.06),nailMask*.6);`);
  shader.fragmentShader=shader.fragmentShader.replace('#include <roughnessmap_fragment>',`#include <roughnessmap_fragment>
 roughnessFactor=clamp(roughnessFactor+skinMottle*.08+palmMask*.025, .66,.80);
 roughnessFactor=mix(roughnessFactor,.46,nailMask);`);
  shader.fragmentShader=shader.fragmentShader.replace('#include <normal_fragment_maps>',`#include <normal_fragment_maps>
 // Derivative filtering removes sub-pixel pores instead of sparkling while
 // moving. Small height gradients add a dry skin surface, not coarse grain.
 float skinFootprint=max(length(dFdx(vSkinRest)),length(dFdy(vSkinRest)));
 float poreFilter=1.0-smoothstep(.00022,.00085,skinFootprint);
 // A very shallow relief from the actual UV photograph follows palm lines
 // and finger creases; filtered fine pores add detail only when resolvable.
 float skinHeight=((skinPhotoLuma-.35)*.00015+(skinNoise(vSkinRest*2400.0)-.5)*.000025*poreFilter)*(1.0-nailMask);
 vec3 skinSigmaX=dFdx(-vViewPosition),skinSigmaY=dFdy(-vViewPosition);
 vec3 skinR1=cross(skinSigmaY,normal),skinR2=cross(normal,skinSigmaX);
 float skinDet=dot(skinSigmaX,skinR1);
 vec3 skinGradient=dFdx(skinHeight)*skinR1+dFdy(skinHeight)*skinR2;
 normal=normalize(max(abs(skinDet),1e-12)*normal-sign(skinDet)*skinGradient);`);
 };
 material.customProgramCacheKey=()=> 'bolts-anatomical-skin-v2';
 material.addEventListener('dispose',()=>material.map?.dispose());
 return material;
}
