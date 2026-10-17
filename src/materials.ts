import * as THREE from 'three';
import {loadCompressedSurfaces} from './compressedSurfaces';

export type SurfaceKind = 'stone' | 'dirt' | 'canvas' | 'walnut' | 'steel';

/** Approximate tile size in metres; steel is an artistic scale, not a measured scan. */
export const SURFACE_TILE_METERS: Readonly<Record<SurfaceKind, number>> = {
  stone: 3, dirt: 2, canvas: .3, walnut: 1, steel: 1,
};

export interface SurfaceOptions {
  repeat?: readonly [number, number];
  offset?: readonly [number, number];
  rotation?: number;
  color?: THREE.ColorRepresentation;
  normalStrength?: number;
  roughness?: number;
  metalness?: number;
  anisotropy?: number;
  /** Strength of source crevice occlusion in indirect lighting. */
  aoIntensity?: number;
  /** Remap source roughness into the material's intended response range. */
  roughnessRange?: readonly [number, number];
  saturation?: number;
}

const defaults = {
  stone: { color: 0xe4e8eb, normalStrength: .55, roughness: 1, metalness: 0, aoIntensity: .65 },
  dirt: { color: 0xeee8dc, normalStrength: .55, roughness: 1, metalness: 0, aoIntensity: .35 },
  canvas: { color: 0xd4d5c6, normalStrength: .25, roughness: 1, metalness: 0, aoIntensity: .3 },
  walnut: { color: 0x99724f, normalStrength: .22, roughness: .92, metalness: 0, aoIntensity: 0 },
  steel: { color: 0x70747a, normalStrength: .7, roughness: 1, metalness: .95, aoIntensity: 0 },
} satisfies Record<SurfaceKind, { color: THREE.ColorRepresentation; normalStrength: number; roughness: number; metalness: number; aoIntensity: number }>;

type MapKind = 'basecolor' | 'normal' | 'roughness' | 'ao';
// Only load useful source AO. Wood has no deep relief at this scale, while the
// steel archive has no AO and a completely white metalness map (use a scalar).
const mapsBySurface: Readonly<Record<SurfaceKind, readonly MapKind[]>> = {
  stone: ['basecolor', 'normal', 'roughness', 'ao'],
  dirt: ['basecolor', 'normal', 'roughness', 'ao'],
  canvas: ['basecolor', 'normal', 'roughness', 'ao'],
  walnut: ['basecolor', 'normal', 'roughness'],
  steel: ['basecolor', 'normal', 'roughness'],
};
type Source = { texture: THREE.Texture; copies: Set<THREE.Texture>; ready: Promise<void> };
const sources = new Map<string, Source>();
const loader = new THREE.TextureLoader();
const canLoadTextures = () => typeof window !== 'undefined' && typeof document !== 'undefined';

function getSource(kind: SurfaceKind, map: MapKind) {
  const key = `${kind}/${map}`;
  let source = sources.get(key);
  if (!source) {
    const copies = new Set<THREE.Texture>();
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const ready = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
    const url = `${import.meta.env?.BASE_URL ?? '/'}assets/materials/${key}.jpg`;
    const texture = loader.load(url, () => {
      // Copies may have rendered before the asynchronous image completed.
      for (const copy of copies) copy.needsUpdate = true;
      resolve();
    }, undefined, () => reject(new Error(`Could not load material texture: ${url}`)));
    // Direct material users may not call preload; the exported preload promise
    // still rejects so startup can report a missing asset explicitly.
    void ready.catch(() => {});
    source = { texture, copies, ready };
    sources.set(key, source);
  }
  return source;
}

let preload: Promise<void> | undefined;
/** Imported production rifles do not use legacy steel. Procedural tools keep
 * the complete default set; a later caller can still request missing maps. */
export async function preloadSurfaceAssets(renderer?: THREE.WebGLRenderer, options: {includeLegacy?: boolean} = {}) {
  if (!canLoadTextures()) return;
  preload ??= (async () => {
    // Materials are normally created after preload. The no-renderer inspector
    // and callers that already constructed materials preserve their JPEG views.
    if (renderer && sources.size === 0) {
      try {
        const compressed = await loadCompressedSurfaces(renderer);
        for (const [key, texture] of compressed) {
          if (sources.has(key)) texture.dispose();
          else sources.set(key, {texture, copies: new Set(), ready: Promise.resolve()});
        }
      } catch { console.warn('Compressed texture loader unavailable; using original surfaces.'); }
    }
  })();
  await preload;
  await Promise.all((Object.keys(defaults) as SurfaceKind[]).filter(kind => options.includeLegacy !== false || kind !== 'steel').flatMap(kind =>
    mapsBySurface[kind].map(map => getSource(kind, map).ready)));
}

function surfaceTexture(kind: SurfaceKind, map: MapKind, options: SurfaceOptions) {
  const source = getSource(kind, map);
  // UV transforms belong to each material; source images remain shared. This
  // keeps long walls and small props independently tiled without extra fetches.
  const texture = source.texture.clone();
  texture.name = `bolts/${kind}/${map}`;
  texture.colorSpace = map === 'basecolor' ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  // Three r180 routes AO through its texture channel, so all source maps can
  // use the same existing UVs and transforms without a redundant UV1 buffer.
  texture.channel = 0;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = options.anisotropy ?? 8;
  texture.repeat.set(...(options.repeat ?? [1, 1]));
  texture.offset.set(...(options.offset ?? [0, 0]));
  texture.rotation = options.rotation ?? 0;
  source.copies.add(texture);
  texture.addEventListener('dispose', () => source.copies.delete(texture));
  return texture;
}

/** Preserve real roughness detail without turning wool or canvas glossy. */
export function applySurfaceResponse(material:THREE.MeshStandardMaterial,range:readonly[number,number],saturation=1) {
  material.userData.surfaceRange=[...range];
  material.onBeforeCompile=shader=>{
    shader.uniforms.boltsRoughnessRange={value:new THREE.Vector2(...range)};
    shader.uniforms.boltsSaturation={value:saturation};
    shader.fragmentShader='uniform vec2 boltsRoughnessRange;\nuniform float boltsSaturation;\n'+shader.fragmentShader;
    shader.fragmentShader=shader.fragmentShader.replace('#include <map_fragment>',`#include <map_fragment>
      diffuseColor.rgb=mix(vec3(dot(diffuseColor.rgb,vec3(.2126,.7152,.0722))),diffuseColor.rgb,boltsSaturation);`);
    shader.fragmentShader=shader.fragmentShader.replace('#include <roughnessmap_fragment>',`#include <roughnessmap_fragment>
      roughnessFactor=mix(boltsRoughnessRange.x,boltsRoughnessRange.y,clamp(roughnessFactor,0.0,1.0));`);
  };
  material.customProgramCacheKey=()=> 'bolts-pbr-surface-v2';
  return material;
}

/** Local CC0 maps; no runtime asset API or third-party network requests. */
export function makeSurfaceMaterial(kind: SurfaceKind, options: SurfaceOptions = {}) {
  const preset = defaults[kind];
  // Geometry/animation tests can construct complete models without a DOM or
  // image loader. In the browser startup preloads these maps before rendering.
  const load = canLoadTextures();
  const map = load ? surfaceTexture(kind, 'basecolor', options) : null;
  const normalMap = load ? surfaceTexture(kind, 'normal', options) : null;
  const roughnessMap = load ? surfaceTexture(kind, 'roughness', options) : null;
  const aoMap = load && mapsBySurface[kind].includes('ao') ? surfaceTexture(kind, 'ao', options) : null;
  const strength = options.normalStrength ?? preset.normalStrength;
  const material = new THREE.MeshStandardMaterial({
    name: `bolts/${kind}`,
    map, normalMap, roughnessMap, aoMap,
    aoMapIntensity: options.aoIntensity ?? preset.aoIntensity,
    color: options.color ?? preset.color,
    normalScale: new THREE.Vector2(strength, strength),
    roughness: options.roughness ?? preset.roughness,
    metalness: options.metalness ?? preset.metalness,
  });
  // Source roughness is multiplied by the scalar in Three. The hessian map
  // averages .59, so scalar=1 alone still makes cloth shine like varnish.
  const range=options.roughnessRange??({canvas:[.82,.98],steel:[.3,.66],stone:[.76,1],dirt:[.84,1],walnut:[.38,.76]} as const)[kind];
  applySurfaceResponse(material,range,options.saturation??1);
  // Each material owns its texture views, while their decoded images are shared.
  material.addEventListener('dispose', () => {
    map?.dispose(); normalMap?.dispose(); roughnessMap?.dispose(); aoMap?.dispose();
  });
  return material;
}
