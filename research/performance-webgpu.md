# Texture compression and WebGPU evaluation

Assessed 2026-10-16 against the installed Three.js **0.180.0** and current primary documentation.

## Production renderer decision

Keep the existing WebGL renderer for this update. WebGPU may reduce draw submission overhead on some devices, but it is not a compatible constructor replacement here. Three explicitly requires custom `ShaderMaterial` and `onBeforeCompile` work to be ported to node materials/TSL; its WebGL fallback uses the new material system too, so fallback does not preserve the existing GLSL code. [Three WebGPURenderer migration guide](https://threejs.org/manual/pages/webgpurenderer)

The installed code has these concrete migration blockers:

| Module | Current custom rendering |
| --- | --- |
| `renderer.ts` | GLSL sky gradient |
| `surfaceWeathering.ts` | Weathering patches and shader-based environment details |
| `materials.ts` | Roughness range and saturation adjustments |
| `handSkin.ts` | Skin shading adjustments |
| `soldierMaterials.ts` | Uniform texture/material adjustment |
| `particleFeedback.ts` | Blood, smoke and impact particle shaders |
| `weaponFeedback.ts` | Muzzle flame shader |

These affect the appearance the user asked to preserve. The current performance changes also address CPU animation, DOM work, object churn, scene reconstruction and texture memory; changing the graphics API alone cannot eliminate those costs. This is a code-based assessment, not a measured claim that WebGPU is slower in the complete game.

`webgpu-probe.html` is a separate development-only Vite page (`npm run dev`, open `/webgpu-probe.html`). Its button compares the two renderers using the same 600 independent stock-material cubes, 960 × 540 output and pixel ratio 1. Each run compiles first, warms for 120 frames, then reports median/p95 CPU submission time and presented frame interval over 240 frames. It detects and reports WebGPU fallback instead of mislabeling WebGL as WebGPU. The experiment is excluded from the production app bundle.

This is a deliberately narrow submission-cost experiment, not a Bolts FPS benchmark: it excludes the custom shaders, dynamic shadows, skinned animation and networking, does not use GPU timestamp queries, and display refresh can cap frame intervals. A production WebGPU port should first reproduce all seven custom-material modules and both render passes, then compare the same combat/replay scenes across WebGPU and WebGL on multiple devices.

The browser run on 2026-10-16 measured **WebGL CPU submission median 1.4 ms / p95 2.1 ms**, versus **WebGPU median 3.7 ms / p95 5.2 ms**. Both presented at a median **8.3 ms** interval on the 120 Hz display. WebGPU did not improve this isolated scene on the tested browser/device; these numbers do not predict the complete game's FPS or other hardware. Together with the material incompatibilities, the result supports retaining WebGL for this release.

## GPU-compressed surfaces shipped now

Six existing CC0 maps—stone, dirt and walnut base color/roughness—have additional KTX2 versions. Their original JPEGs remain available for unsupported hardware and per-file decode/network failures. The renderer opts in before material construction; inspectors without a renderer retain the original loading path. KTX2Loader performs capability detection and transcodes UASTC into the device format. [Three KTX2Loader documentation](https://threejs.org/docs/pages/KTX2Loader.html)

Only ASTC 4×4 or BC7 support enables this path. This avoids downgrading to lower-quality BC1 on older devices. Source dimensions are unchanged, and all mip levels are stored offline. Base color is sRGB, roughness is linear with explicit RGB channels, and the physical vertical flip matches the original JPEG uploads. The container records these properties; its structure is checked in tests. [Khronos KTX 2 specification](https://registry.khronos.org/KTX/specs/2.0/ktxspec.v2.html)

Encoding uses official **KTX-Software 4.4.2**, UASTC quality 3, lossless Zstandard level 18 and no lossy RDO stage. All six pass `ktx validate --warnings-as-errors` and decoded RGB PSNR checks against the source JPEG pixels (46.62–62.63 dB). This metric is an offline quality check; it does not replace visual inspection or promise pixel identity. Normal maps, hand textures, imported soldier textures and imported weapon textures are unchanged. [Official KTX-Software release](https://github.com/KhronosGroup/KTX-Software/releases/tag/v4.4.2)

For the six maps, calculated texture storage including mipmaps falls from **83,886,072 bytes to 20,971,680 bytes**, approximately **60 MiB saved** on ASTC/BC7. This excludes driver bookkeeping and is not an FPS estimate. Quality-first compression has a loading tradeoff: the six KTX2 downloads total **15,965,498 bytes** versus **8,925,766 bytes** of JPEGs, plus about 0.6 MB of local Basis transcoder assets. RDO at 0.25 barely reduced a representative stone map, so it was not used merely to claim a smaller download. The two transcoder workers terminate after preload.

Rebuild with `python3 scripts/compress-surface-textures.py --toktx /path/to/toktx --ktx /path/to/ktx` using Pillow and the pinned encoder. Source/output hashes, sizes, measured PSNR and storage arithmetic are in `public/assets/materials/compressed-provenance.json`. The original CC0 provenance stays intact. The Basis runtime files are copied from the pinned Three package and retain their Apache 2.0 license; no third-party runtime CDN is used.
