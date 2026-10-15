import * as THREE from 'three';
import type {Faction} from './config';

type Family='wool'|'web'|'leather'|'paint';
type MapSet={color:THREE.Texture;normal:THREE.Texture;roughness:THREE.Texture};
const sourceMaps:Partial<Record<Family,MapSet>>={};
let loading:Promise<void>|undefined;

export const SOLDIER_PALETTES={
  british:{wool:0x706249,shade:0x5a503b,web:0xa69e79,helmet:0x565b43,leather:0x42342a,leatherEdge:0x645440,metal:0x88764e},
  russian:{wool:0x7b7854,shade:0x625f43,web:0x968b67,helmet:0x48563c,leather:0x49382a,leatherEdge:0x68533d,metal:0x5d6157},
  german:{wool:0x667268,shade:0x4b5951,web:0x79816b,helmet:0x626262,leather:0x292b27,leatherEdge:0x484b3f,metal:0x60675f},
} as const;

/** All paths are local; decoded images are cached and shared across soldiers. */
export function preloadSoldierMaterials():Promise<void> {
  if(typeof window==='undefined'||typeof document==='undefined')return Promise.resolve();
  return loading??=(async()=>{
    const loader=new THREE.TextureLoader(),base=import.meta.env?.BASE_URL??'/';
    const paths:Record<Exclude<Family,'paint'>,[string,string,string]>={
      wool:['fabric/Fabric030_1K-JPG_Color.jpg','fabric/Fabric030_1K-JPG_NormalGL.jpg','fabric/Fabric030_1K-JPG_Roughness.jpg'],
      web:['materials/canvas/basecolor.jpg','materials/canvas/normal.jpg','materials/canvas/roughness.jpg'],
      leather:['soldier/leather-color.jpg','soldier/leather-normal.jpg','soldier/leather-roughness.jpg'],
    };
    await Promise.all(Object.entries(paths).map(async([family,urls])=>{
      try {
        const [color,normal,roughness]=await Promise.all(urls.map(url=>loader.loadAsync(`${base}assets/${url}`)));
        color.colorSpace=THREE.SRGBColorSpace;
        for(const texture of [color,normal,roughness]){texture.wrapS=texture.wrapT=THREE.RepeatWrapping;texture.anisotropy=8;texture.channel=0;}
        sourceMaps[family as Family]={color,normal,roughness};
      } catch(error){console.warn(`Soldier ${family} texture unavailable; using the local material fallback.`,error);}
    }));
  })();
}

function dataTexture(bytes:Uint8Array,size:number,color=false) {
  const texture=new THREE.DataTexture(bytes,size,size,THREE.RGBAFormat);
  texture.colorSpace=color?THREE.SRGBColorSpace:THREE.NoColorSpace;
  texture.wrapS=texture.wrapT=THREE.RepeatWrapping;texture.magFilter=THREE.LinearFilter;texture.minFilter=THREE.LinearMipmapLinearFilter;texture.generateMipmaps=true;texture.anisotropy=8;texture.needsUpdate=true;return texture;
}

/** Original fine paint stipple, shared across helmets/canisters. Its surface
 * detail is sub-millimetre at the .12 m tile, not large hammered-metal dents. */
function paintMaps():MapSet {
  if(sourceMaps.paint)return sourceMaps.paint;
  const size=256,count=size*size,grain=new Float32Array(count),color=new Uint8Array(count*4),normal=new Uint8Array(count*4),roughness=new Uint8Array(count*4);
  let seed=971;
  for(let i=0;i<count;i++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;grain[i]=seed/4294967296;}
  for(let y=0;y<size;y++)for(let x=0;x<size;x++) {
    const i=y*size+x,k=i*4,g=grain[i],value=Math.round(224+g*23);
    color.set([value,value,value,255],k);
    const dx=(grain[y*size+(x+1)%size]-grain[y*size+(x+size-1)%size])*.13;
    const dy=(grain[((y+1)%size)*size+x]-grain[((y+size-1)%size)*size+x])*.13;
    const n=new THREE.Vector3(-dx,-dy,1).normalize();normal.set([Math.round(n.x*127+128),Math.round(n.y*127+128),Math.round(n.z*127+128),255],k);
    const r=Math.round(162+g*67);roughness.set([r,r,r,255],k);
  }
  return sourceMaps.paint={color:dataTexture(color,size,true),normal:dataTexture(normal,size),roughness:dataTexture(roughness,size)};
}

let fallback:MapSet|undefined;
function fallbackMaps():MapSet {
  return fallback??={color:dataTexture(new Uint8Array([255,255,255,255]),1,true),normal:dataTexture(new Uint8Array([128,128,255,255]),1),roughness:dataTexture(new Uint8Array([220,220,220,255]),1)};
}

/** Sampling in local metres makes thread/grain scale consistent between
 * torso, boots, pouches and limbs without touching their UVs or geometry.
 * The dominant local surface plane uses one sample per map, rather than
 * nine fetches for a full triplanar PBR blend. It stays attached during poses. */
function materialFor(family:Family,color:number,name:string):THREE.MeshStandardMaterial {
  const source=family==='paint'?paintMaps():sourceMaps[family],maps=source??fallbackMaps();
  const config={
    wool:{tile:.20,mean:.1115,normal:.19,range:[.88,1],saturation:.12,wear:.10,metalness:0},
    web:{tile:.18,mean:.3062,normal:.32,range:[.86,.99],saturation:.08,wear:.15,metalness:0},
    leather:{tile:.40,mean:.03771,normal:.32,range:[.45,.76],saturation:.18,wear:.12,metalness:0},
    paint:{tile:.12,mean:.835,normal:.65,range:[.66,.88],saturation:0,wear:.14,metalness:.12},
  }[family];
  const map=maps.color.clone(),normalMap=maps.normal.clone(),roughnessMap=maps.roughness.clone();
  const material=new THREE.MeshStandardMaterial({name:`soldier/${name}`,color,map,normalMap,roughnessMap,roughness:1,metalness:config.metalness,normalScale:new THREE.Vector2(config.normal,config.normal),side:THREE.DoubleSide});
  material.userData.soldierSurface={family,tileMetres:config.tile,roughnessRange:[...config.range]};
  material.onBeforeCompile=shader=>{
    const declarations='varying vec3 vSoldierSurfacePosition;\nvarying vec3 vSoldierSurfaceNormal;\n';
    shader.vertexShader=declarations+shader.vertexShader;
    shader.vertexShader=shader.vertexShader.replace('#include <begin_vertex>',`#include <begin_vertex>
      vSoldierSurfacePosition=position;vSoldierSurfaceNormal=normal;`);
    shader.fragmentShader=declarations+`uniform float soldierTile;uniform float soldierSourceMean;uniform float soldierSourceSaturation;uniform float soldierWear;uniform vec2 soldierRoughness;
      float soldierHash(vec2 p){vec3 q=fract(vec3(p.xyx)*.1031);q+=dot(q,q.yzx+33.33);return fract((q.x+q.y)*q.z);}
      float soldierNoise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.0-2.0*f);return mix(mix(soldierHash(i),soldierHash(i+vec2(1,0)),f.x),mix(soldierHash(i+vec2(0,1)),soldierHash(i+vec2(1,1)),f.x),f.y);}
      `+shader.fragmentShader;
    Object.assign(shader.uniforms,{soldierTile:{value:config.tile},soldierSourceMean:{value:source?config.mean:1},soldierSourceSaturation:{value:config.saturation},soldierWear:{value:config.wear},soldierRoughness:{value:new THREE.Vector2(...config.range)}});
    shader.fragmentShader=shader.fragmentShader.replace('#include <map_fragment>',`
      vec3 surfaceNormal=abs(normalize(vSoldierSurfaceNormal));
      vec2 soldierUv=surfaceNormal.z>=surfaceNormal.x&&surfaceNormal.z>=surfaceNormal.y?vSoldierSurfacePosition.xy:surfaceNormal.x>=surfaceNormal.y?vSoldierSurfacePosition.zy:vSoldierSurfacePosition.xz;
      soldierUv/=soldierTile;
      #ifdef USE_MAP
        vec4 soldierTexel=texture2D(map,soldierUv);
        vec3 balanced=mix(vec3(dot(soldierTexel.rgb,vec3(.2126,.7152,.0722))),soldierTexel.rgb,soldierSourceSaturation);
        diffuseColor.rgb*=clamp(balanced/max(soldierSourceMean,.001),vec3(.35),vec3(1.7));
        diffuseColor.a*=soldierTexel.a;
      #endif
      float wear= soldierNoise((vSoldierSurfacePosition.xy+vSoldierSurfacePosition.z*vec2(.61,.39))*9.0);
      float wearFine=soldierNoise((vSoldierSurfacePosition.zy+vSoldierSurfacePosition.x*.31)*37.0);
      diffuseColor.rgb*=1.0-soldierWear*.6+soldierWear*wear;
      diffuseColor.rgb=mix(diffuseColor.rgb,diffuseColor.rgb*vec3(1.11,1.07,.98),smoothstep(.66,.95,wearFine)*soldierWear);
    `);
    for(const chunk of ['normal_fragment_begin','normal_fragment_maps','roughnessmap_fragment'] as const) {
      let code=THREE.ShaderChunk[chunk].replaceAll('vNormalMapUv','soldierUv').replaceAll('vRoughnessMapUv','soldierUv');
      if(chunk==='roughnessmap_fragment')code+='\nroughnessFactor=mix(soldierRoughness.x,soldierRoughness.y,clamp(roughnessFactor,0.0,1.0));\n';
      shader.fragmentShader=shader.fragmentShader.replace(`#include <${chunk}>`,code);
    }
  };
  material.customProgramCacheKey=()=> 'bolts-soldier-material-v1';
  material.addEventListener('dispose',()=>{map.dispose();normalMap.dispose();roughnessMap.dispose();});
  return material;
}

export function makeSoldierMaterials(faction:Faction) {
  const p=SOLDIER_PALETTES[faction];
  return {
    wool:materialFor('wool',p.wool,`${faction}/wool`),shade:materialFor('wool',p.shade,`${faction}/seams`),
    web:materialFor('web',p.web,`${faction}/webbing`),leather:materialFor('leather',p.leather,`${faction}/leather`),
    leatherEdge:materialFor('leather',p.leatherEdge,`${faction}/leather-edges`),helmetMat:materialFor('paint',p.helmet,`${faction}/helmet-paint`),
    metal:new THREE.MeshStandardMaterial({name:`soldier/${faction}/fittings`,color:p.metal,roughness:faction==='british'?.54:.68,metalness:faction==='british'?.65:.45}),
  };
}
