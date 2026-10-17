import * as THREE from 'three';
import {GLTFLoader, type GLTF} from 'three/addons/loaders/GLTFLoader.js';

export type AssetTier = 'low' | 'medium' | 'high';
export const assetTierForQuality = (quality: string): AssetTier => quality === 'low' ? 'low' : quality === 'medium' ? 'medium' : 'high';

/** Lower tiers are offline image variants; never download the original first. */
export function tieredAssetUrl(path: string, tier: AssetTier): string {
  return `${import.meta.env?.BASE_URL ?? '/'}assets/${tier === 'high' ? '' : `tiers/${tier}/`}${path}`;
}

type TextureGroup = {source: THREE.Source; index: number; views: Set<THREE.Texture>};
type Asset = {path: string; groups: TextureGroup[]; textureCount: number};
type TextureDecoder = (path: string, tier: AssetTier) => Promise<THREE.Texture[]>;

function releaseDecoded(textures: THREE.Texture[], closeImages: boolean) {
  const images = new Set<unknown>();
  for (const texture of new Set(textures)) {
    images.add(texture.source.data);
    texture.dispose();
  }
  if (closeImages) for (const image of images) {
    if (image && typeof (image as ImageBitmap).close === 'function') (image as ImageBitmap).close();
  }
}

async function decodeAssetTextures(path: string, tier: AssetTier): Promise<THREE.Texture[]> {
  const gltf = await new GLTFLoader().loadAsync(tieredAssetUrl(path, tier));
  const textures = await gltf.parser.getDependencies('texture') as THREE.Texture[];
  // Only decoded images survive a switch. Replacement geometry and materials
  // never enter the live scene, including the first-person sights and rig.
  const geometries = new Set<THREE.BufferGeometry>(), materials = new Set<THREE.Material>();
  gltf.scene.traverse(object => {
    if (!(object instanceof THREE.Mesh)) return;
    geometries.add(object.geometry);
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) materials.add(material);
  });
  geometries.forEach(geometry => geometry.dispose());
  materials.forEach(material => material.dispose());
  return textures;
}

/** One manager also makes cancellation/failure and clone ownership testable
 * without a browser. It retains only the current decoded tier, not a tier cache. */
export class AssetTierManager {
  private tier: AssetTier = 'high';
  private assets = new Map<string, Asset>();
  private groups = new WeakMap<THREE.Source, TextureGroup>();
  private tracked = new WeakSet<THREE.Texture>();
  private releasingGpu = false;
  private revision = 0;
  private queue: Promise<void> = Promise.resolve();

  constructor(private decode: TextureDecoder = decodeAssetTextures) {}

  getTier(): AssetTier { return this.tier; }

  setInitialTier(tier: AssetTier) {
    if (this.assets.size) throw new Error('Initial asset tier must be selected before preloading models');
    this.tier = tier;
  }

  register(path: string, textures: THREE.Texture[], scene?: THREE.Object3D) {
    if (this.assets.has(path)) throw new Error(`Asset already registered: ${path}`);
    const groups: TextureGroup[] = [];
    textures.forEach((texture, index) => {
      let group = this.groups.get(texture.source);
      if (!group) {
        group = {source: texture.source, index, views: new Set()};
        this.groups.set(texture.source, group); groups.push(group);
      }
      this.track(texture);
    });
    scene?.traverse(object => {
      if (!(object instanceof THREE.Mesh)) return;
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
        for (const value of Object.values(material)) if (value instanceof THREE.Texture) this.track(value);
      }
    });
    this.assets.set(path, {path, groups, textureCount: textures.length});
  }

  /** Texture.clone shares Source but owns sampler state and its GPU reference. */
  track(texture: THREE.Texture) {
    const group = this.groups.get(texture.source);
    if (!group || this.tracked.has(texture)) return;
    this.tracked.add(texture); group.views.add(texture);
    texture.addEventListener('dispose', () => {
      if (!this.releasingGpu) group.views.delete(texture);
    });
  }

  change(tier: AssetTier): Promise<void> {
    const revision = ++this.revision;
    const operation = this.queue.catch(() => {}).then(async () => {
      if (revision !== this.revision || tier === this.tier) return;
      const assets = [...this.assets.values()];
      // Settle every request before releasing a failed/stale batch; a rejected
      // sibling must not leave decoded images retained by a detached promise.
      const results = await Promise.allSettled(assets.map(asset => this.decode(asset.path, tier)));
      const decoded = results.flatMap(result => result.status === 'fulfilled' ? [result.value] : []);
      const failed = results.find(result => result.status === 'rejected');
      if (revision !== this.revision || failed) {
        decoded.forEach(textures => releaseDecoded(textures, true));
        if (revision === this.revision && failed?.status === 'rejected') throw failed.reason;
        return;
      }
      if (decoded.some((textures, index) => textures.length !== assets[index].textureCount || textures.some(texture => !(texture instanceof THREE.Texture) || !texture.source.data))) {
        decoded.forEach(textures => releaseDecoded(textures, true));
        throw new Error('Asset tier has incompatible texture bindings');
      }
      const previousImages = new Set<unknown>(), nextImages = new Set<unknown>();
      this.releasingGpu = true;
      try {
        // Release all old GPU references before changing dimensions. Three's
        // immutable texture storage otherwise cannot be resized safely. Keep
        // Source identity and all per-view UV/channel/filter/sampler settings.
        for (const asset of assets) for (const group of asset.groups) {
          previousImages.add(group.source.data);
          for (const view of group.views) view.dispose();
        }
        assets.forEach((asset, index) => {
          for (const group of asset.groups) {
            group.source.data = decoded[index][group.index].source.data;
            nextImages.add(group.source.data);
            for (const view of group.views) view.needsUpdate = true;
          }
        });
        this.tier = tier;
      } finally { this.releasingGpu = false; }
      decoded.forEach(textures => releaseDecoded(textures, false));
      for (const image of previousImages) if (!nextImages.has(image) && image && typeof (image as ImageBitmap).close === 'function') (image as ImageBitmap).close();
    });
    this.queue = operation;
    return operation;
  }
}

const manager = new AssetTierManager();
export const setInitialAssetTier = (tier: AssetTier) => manager.setInitialTier(tier);
export const getAssetTier = () => manager.getTier();
export const assetUrl = (path: string) => tieredAssetUrl(path, manager.getTier());
/** Superseded requests resolve without publishing; callers can check getAssetTier. */
export const changeAssetTier = (tier: AssetTier) => manager.change(tier);
export const trackAssetTextureCopy = (_source: THREE.Texture, copy: THREE.Texture) => manager.track(copy);
export async function registerTieredAsset(path: string, gltf: GLTF) {
  manager.register(path, await gltf.parser.getDependencies('texture'), gltf.scene);
}
