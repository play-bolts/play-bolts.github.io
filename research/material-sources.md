# PBR material sources

Selected and downloaded 2026-10-13. These CC0 replacement surfaces support Bolts' pale masonry, earth, khaki cloth and worn rifle finishes. They are independently licensed artwork, not extracted Call of Duty textures. Source image files remain unmodified.

## Selected assets and resolution

| Bolts surface | Original source and author | Color / normal / roughness / AO | Tile scale |
| --- | --- | --- | --- |
| `stone` | [Sandstone Blocks 04](https://polyhaven.com/a/sandstone_blocks_04), Rob Tuytel | 2K / 1K / 1K / 1K | 3 m |
| `dirt` | [Dirt](https://polyhaven.com/a/dirt), Charlotte Baglioni | 2K / 1K / 1K / 1K | 2 m |
| `canvas` | [Hessian 380](https://polyhaven.com/a/hessian_380), colormass photography / Rico Cilliers processing | 1K / 1K / 1K / 1K | Approximately 0.3 m |
| `walnut` | [Walnut Veneer 02](https://polyhaven.com/a/walnut_veneer_02), Jenelle van Heerden | 2K / 2K / 1K / — | 1 m |
| `steel` | [Metal 012](https://ambientcg.com/view?id=Metal012), ambientCG | 2K / 2K / 2K / — | 1 m artistic convention; source has no measured dimensions |

Here 1K means 1024 × 1024 and 2K means 2048 × 2048. Ground and masonry gain more color detail without quadrupling every map's memory. Close weapon surfaces use higher-resolution normals, and steel also uses its 2K roughness. The fine hessian weave remains 1K at its small physical scale. All normals are original OpenGL maps.

Metal 012 replaces Blue Metal Plate entirely. The selected source is neutral silver steel with subtle brushing, scuffs and scratches; it has no painted panels or long sheet seams. Its official creation-method identifier is `PBRProcedural`, so it is not described as a photographed or scanned historical gun finish. The source's metalness map is uniformly white, so a scalar replaces that redundant image. No AO map is supplied for this asset. Walnut's shallow grain uses normal and roughness detail without an additional AO image.

[Poly Haven](https://polyhaven.com/license) and [ambientCG](https://docs.ambientcg.com/license/) license these downloadable assets under CC0 1.0, permitting redistribution in a game. The [Poly Haven public file API](https://github.com/Poly-Haven/Public-API) supplied original URLs, dimensions by selected resolution, MD5 hashes and byte counts. The [ambientCG asset page](https://ambientcg.com/view?id=Metal012) and [documented file API](https://docs.ambientcg.com/api/v2/full_json/) supplied the original `Metal012_2K-JPG.zip` download. No paid account was used. Bolts serves these files locally and makes no provider/API requests at runtime.

## Provenance, payload and restoration

[provenance.json](../public/assets/materials/provenance.json) records source pages, providers, authors, license URLs, exact map dimensions, original URLs/archive members, byte counts and SHA-256 hashes. Every Poly Haven JPEG also matches its published MD5. ambientCG's archive SHA-256 and exact archive member names are recorded; its API did not provide individual member hashes, so those SHA-256 values were computed locally. All 18 images were decoded with Pillow and checked for their original dimensions during acquisition. No images were resized, upscaled, recompressed or baked into replacement maps.

The shipped JPEG payload is **23,405,161 bytes (22.32 MiB)**, up from 9,381,882 bytes. It contains seven 2K maps and eleven 1K maps. The distribution excludes source ZIP archives, Blender files, displacement maps, DirectX normals, preview images and the unused constant metalness map. Downloading the new maps plus the source steel archive consumed **23,805,073 bytes**, excluding API metadata; only selected archive members ship.

At RGBA8, a single shared decoded copy totals approximately 156 MiB, and GPU storage with a complete mip chain approximately **208 MiB** for this material set. These are estimates, not measured process memory: browser image storage, renderer allocations, alternate sampler configurations, models, skin and other textures add overhead. Source images are shared across material instances and UV transforms do not duplicate downloads. Keeping environment data maps at 1K avoids the roughly 384 MiB that eighteen 2K RGBA8 textures with mipmaps would require.

To verify the local files without network access:

```sh
python3 scripts/fetch-materials.py --verify-only
```

To restore missing or altered maps from the recorded original sources:

```sh
python3 scripts/fetch-materials.py
```

The standard-library script skips correct files, checks hashes before writing replacements, verifies the steel archive before reading its three selected members, and does not execute or extract source authoring files.

## Rendering integration

`makeSurfaceMaterial(kind, options)` creates a `MeshStandardMaterial`. Basecolor is tagged sRGB; normal, roughness and AO are non-color data. Source images are shared while each material owns its texture transforms. Preloading waits for every local image and reports missing paths. Disposing a material releases all its texture views, including AO. Node geometry tests can construct materials without a browser or image loader.

AO is integrated through Three's native indirect-light occlusion, not multiplied into the diffuse color. Stone uses intensity 0.65, dirt 0.35 and canvas 0.30; `aoIntensity` overrides these per material. Every map uses the same repeat, offset and rotation. Three r180's `Texture.channel = 0` maps AO to the existing `uv` attribute, so no duplicate UV buffer is needed. This was verified against the installed renderer's `getChannel(material.aoMap.channel)` and AO shader transform; the current [Texture documentation](https://threejs.org/docs/pages/Texture.html) describes the channel mapping. The generic material documentation still mentions a second UV set, but that is unnecessary with explicit channel 0 in this installed version.

Use face width and height divided by `SURFACE_TILE_METERS[kind]` for world surface repeats. A 6 × 3 m wall repeats stone 2 × 1; each box face needs its own dimensions. The 0.3 m hessian weave should stay fine while folds, seams, frame boards and hems are separate geometry/details. Grain should run along the stock and fore-end. Source wood is veneer and cloth is sackcloth, used as visual approximations rather than exact historic material samples.

The new steel basecolor averages sRGB 214/221/229; its roughness averages 0.088 with range 0.027–0.294, and its normal relief is mild. Gun materials no longer use the old orange compensating tint or central UV crop. Neutral dark gray exterior tints, lighter exposed bolt/edge tints, high metalness and normal strength around 0.7 suit the new maps. Shared roughness remapping preserves variation while giving the main steel an estimated 0.30–0.66 response range; individual dark recess and polished-part materials can override it. These are artistic finish estimates, not measured bluing.

`applySurfaceResponse` keeps cloth matte and controls roughness without changing source files: canvas 0.82–0.98, stone 0.76–1, dirt 0.84–1 and walnut 0.38–0.76. The existing outdoor environment reflections, physically shaded surfaces, and metre-scale `surfaceWeathering` variation continue to compose with the material shader. Source AO adds small crevice contrast; it does not replace dynamic shadows, geometry contact or actual folds. Scene-level QA should check lighting and model-specific material tuning.

## Verification

`tests/materials.test.ts` verifies every shipped file's hash, dimensions, original Poly Haven MD5 and payload budget. Its loader test checks all requested paths against the provenance manifest, one fetch per source, independent transforms over shared decoded images, sRGB versus data color spaces, aligned AO on UV0, load completion updates, and disposal of AO views. Existing rendering tests check shader composition so normal maps, physical lighting, weathering and tone mapping continue to use the installed Three shader hooks.

First-person weapons now use a dedicated close-range directional shadow frustum (2048 pixels on High, 1024 on Medium; disabled with shadows on Low), adding contact shading between fingers, wood and receiver hardware. The model inspector and menu weapon portrait use the same filtered outdoor reflection environment, so the new metal reads consistently across views. Exterior steel tints were darkened after Safari inspection to retain a blued finish while exposed bolts and edges remain lighter.
