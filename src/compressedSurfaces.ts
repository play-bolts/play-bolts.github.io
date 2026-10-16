import type {Texture, WebGLRenderer} from 'three';

/** Only broad environment surfaces: close-up normals, hands and guns stay exact. */
export const COMPRESSED_SURFACES = [
  'stone/basecolor', 'stone/roughness', 'dirt/basecolor', 'dirt/roughness',
  'walnut/basecolor', 'walnut/roughness',
] as const;

/** Prefer quality-preserving 4x4 ASTC/BC7; weaker compression uses original JPEGs. */
export function supportsHighQualityCompression(renderer: Pick<WebGLRenderer, 'extensions'>) {
  return renderer.extensions.has('WEBGL_compressed_texture_astc') || renderer.extensions.has('EXT_texture_compression_bptc');
}

/** Decode once during loading, then terminate the idle workers; assets remain local. */
export async function loadCompressedSurfaces(renderer: WebGLRenderer): Promise<Map<string, Texture>> {
  const loaded = new Map<string, Texture>();
  if (!supportsHighQualityCompression(renderer)) return loaded;
  const {KTX2Loader} = await import('three/addons/loaders/KTX2Loader.js');
  const base = import.meta.env?.BASE_URL ?? '/';
  const loader = new KTX2Loader().setTranscoderPath(`${base}assets/basis/`).setWorkerLimit(2).detectSupport(renderer);
  try {
    await Promise.all(COMPRESSED_SURFACES.map(async key => {
      try {
        const texture = await loader.loadAsync(`${base}assets/materials/${key}.ktx2`);
        loaded.set(key, texture);
      } catch {
        // Missing assets, blocked WebAssembly/workers, or transcode errors must
        // never stop startup. The caller uses the retained original JPEG.
        console.warn(`Compressed surface unavailable; using original texture: ${key}`);
      }
    }));
  } finally {
    loader.dispose();
  }
  return loaded;
}
