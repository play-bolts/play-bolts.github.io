# Realistic asset sources and acquired files

Inspected 2026-10-13. Sources below are creators, project repositories, or the original asset listing. This inventory distinguishes acquired assets from candidates that were only researched.

## Current full-body soldier replacements

The official authenticated Sketchfab GLB downloads now replace the earlier
procedural uniforms and separate MakeHuman heads in normal gameplay:

- [WWII British Soldier](https://sketchfab.com/3d-models/wwii-british-soldier-9af571fa416546f08dfc2ba95e604083), by patromes.
- [WW2 Soviet Uniform](https://sketchfab.com/3d-models/ww2-soviet-uniform-f85a4ed8c33a43eca1a7caa45f7acf99), by tnnv.
- [WW2 Panzergrenadier_fbx_tpose_CC0](https://sketchfab.com/3d-models/ww2-panzergrenadier-fbx-tpose-cc0-99ae9a9deb2c46c5956342b3bf9de7a2), by britdawgmasterfunk.

All downloaded files declare CC BY 4.0. The German creator also describes CC0
permission; the shipped attribution retains CC BY. The Soviet creator identifies
Adobe Fuse as the body source and Blender/Quixel Mixer for the authored uniform.
These are full source bodies with their original heads, cloth folds, equipment,
boots and UV textures. The Soviet source wears a pilotka field cap.

Blender normalizes the bodies to 1.80 m, removes covered/internal surfaces and
source firearms, and adapts continuous skin weights to the existing deterministic
15-bone rig. British/German weights are newly authored; Soviet source weights are
collapsed and retargeted. British position duplicates are welded without removing
faces or UV corners. Material adjustments remove a chrome-like British helmet
response and metallic/wet German cloth. Source color maps remain up to 1K;
auxiliary normal/material maps are 512px PNG, while opaque color uses JPEG92.
The three runtime files total 18.72 MB. Source hashes, output hashes, modifications
and texture dimensions are in [the complete provenance records](../public/assets/imported-soldiers/ATTRIBUTION.md).

Automated checks load the actual final GLBs, verify source UV/PBR data and
normalized weights, pose the real skin through stance/gait/death, test replay
restoration and independent disposal, and check download budgets. The standalone
anatomical head and authored uniforms below remain development fallbacks; the
CC0 first-person hands remain in active use.

## Acquired anatomical head

The practical face replacement is MakeHuman's continuous human topology, with adult male shape targets and a natural male skin. The [official license](https://github.com/makehumancommunity/makehuman/blob/master/LICENSE.md) explicitly separates CC0 graphical assets from the software's AGPL source. The selected [Margaret Toigo freckled skin](https://static.makehumancommunity.org/assets/assetpacks/skins02.html) is also specifically listed as CC0.

- [Base OBJ](https://raw.githubusercontent.com/makehumancommunity/makehuman/master/makehuman/data/3dobjs/base.obj).
- [Adult male anatomical target](https://raw.githubusercontent.com/makehumancommunity/makehuman/master/makehuman/data/targets/macrodetails/caucasian-male-young.target) and [average build target](https://raw.githubusercontent.com/makehumancommunity/makehuman/master/makehuman/data/targets/macrodetails/universal-male-young-averagemuscle-averageweight.target).
- [Official male-skin ZIP](https://files2.makehumancommunity.org/asset_packs/skins02/skins02_cc0.zip).

Delivered `public/assets/makehuman/human-head.glb`: cropped head, preserved skin UVs, continuous face/ears/lips/nose, separate eyes, one subdivision, embedded diffuse texture and roughness material. It faces +Z, uses +Y up, and measures approximately .210 m wide by .288 m high. `src/humanHead.ts` preloads it and creates independently disposable clones. `scripts/build-human-head.py` reproduces the conversion. The original helmets and uniforms remain separate. A neutral Blender render was inspected; this is an anatomical model with textured skin, not a head built from individual facial primitives. It does not contain facial animation or a measured skin-scattering shader.

## Acquired hands

[para's FPS arms](https://opengameart.org/content/fps-arms-rigged-only) are CC0, based on MakeHuman geometry and textures; the listing provides a [direct 7z download](https://opengameart.org/sites/default/files/fps%20arms.7z) containing Blender and FBX files. The source listing describes approximately 8,000 triangles, a 1024px texture, IK controls and finger curl constraints. It is suitable for a continuous skinned hand rather than disconnected palm/finger primitives.

The primary implementation converts these into separate wrist-local GLBs. The revised conversion bisects the adjoining forearm at a wrist plane and caps the cut, preserving UVs and skin weights. Both generated hands have zero open boundary edges at conversion time. Source provenance is retained under `public/assets/arms`.

## Acquired uniform material

[ambientCG Fabric030](https://ambientcg.com/view?id=Fabric030) provides a [direct 1K JPEG archive](https://ambientcg.com/get?file=Fabric030_1K-JPG.zip). The [CC0 license](https://docs.ambientcg.com/license/) permits redistribution of the raw maps in games. Selected color, OpenGL normal and roughness maps are under `public/assets/fabric`. The source is dark gray cloth; tint and lighting must be checked on each faction. Color uses sRGB; normal and roughness maps use linear data. This is a material approximation, not a scan of a verified wartime uniform.

## Researched alternatives, not acquired

| Asset | Format / license / reason |
| --- | --- |
| [WRAD arms](https://github.com/wwwriks/wrad-arms) | Direct GLB/FBX/OBJ, CC0, full rig and 512px skin. Convenient but intentionally 1,200-triangle GoldSource styling; less suitable than the acquired hands for this realism update. |
| [Danya's Kar98k](https://sketchfab.com/3d-models/kar98k-free-model-e88c90c8e203401fa28e8f4ef03e657f) | Creator lists a game-ready 10.7k-triangle model with 2K textures under CC Attribution. Downloadable listing, but no unrestricted direct file acquired in this research. |
| [gaethan_bracke No.4](https://sketchfab.com/3d-models/lee-enfield-mk1-no4-fd69c70851fe4d1cb8c3522c3b7607c4) | Correct model family, but its inspected listing does not offer download or a reusable asset license. Not selected. |
| [nisu's rigged WW2 German soldier](https://opengameart.org/content/rigged-lowpoly-ww2-soldier) | CC0 and directly downloadable, but low-poly stylization and a single faction do not address all three uniforms or the desired face quality. Not selected. |

## Animation direction

The practical improvement is continuous skinned anatomy with authored joint pivots and weights, restrained normal/roughness detail, and hand poses fitted to actual weapon contact points. Fingers should curl through their joints while the support hand stays on the fore-end and the working hand reaches the bolt or charger. Keep world-soldier aim, gait, crouch and death poses distinct from first-person presentation. Existing simulation time should drive playback so killcam repeats the same poses. These are implementation recommendations, not claims that the imported source includes Call of Duty animations or original timing data.

## User-selected Sketchfab replacements

Checked the four exact listings against Sketchfab's official model API on 2026-10-13. Each reports `isDownloadable: true`, `isProtected: false`, and Creative Commons Attribution 4.0. The four official GLB downloads were acquired through the signed-in Sketchfab download UI on 2026-10-13. No viewer-cache extraction was used. Original downloads are retained in the ignored `artifacts/sketchfab-source/` directory.

| Model | Creator | API geometry / textures |
| --- | --- | --- |
| [Mosin Nagant 1891/30](https://sketchfab.com/3d-models/low-poly-mosin-nagant-189130-2eb25ee9fdcd4ea38a6cbc5b4e6f9b37) | D_U | 7,985 faces; 4 materials; 0 textures |
| [Lee Enfield MKIII](https://sketchfab.com/3d-models/lee-enfield-mkiii-f6a2160daf134071a84e3cae5f831875) | Moony_State | 20,566 faces; 7 materials; 35 textures |
| [Kar98k](https://sketchfab.com/3d-models/kar98k-96b7387fe49b4dd491cc8277f765527a) | Ecler | 14,928 faces; 2 materials; 8 textures |
| [Stielhandgranate](https://sketchfab.com/3d-models/stielhandgranate-german-grenade-c49ce26939d64641afac1175a8d62338) | Janovich | 3,688 faces; 1 material; 4 textures |

Runtime rifle GLBs, measured anchors, source/output hashes and attribution are in [`public/assets/imported-weapons`](../public/assets/imported-weapons/ATTRIBUTION.md). The three rifles total 21.6 MB after texture optimization: original source resolution up to 2K for color and 1K for normal/metallic-roughness maps. The 3.0 MB grenade has its own [attribution and conversion record](../public/assets/models/ATTRIBUTION.md). Source geometry is preserved apart from removal of unused display extras; the untextured Mosin receives licensed CC0 wood/steel maps and rounded-bolt normal smoothing. Its intentionally low-poly topology remains visible.

All four have zero animation clips. The British replacement is a Mk III; it replaces the earlier No.4 visual variant and retains the source model's sights. Bolts adapts scale, moving parts, hand contacts and textures. The Options → Credits panel names each creator and links the exact asset and [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). [Sketchfab's official Download API](https://sketchfab.com/developers/download-api) exposes authenticated archive downloads; public model metadata alone is not the downloadable asset.

## Blender detail update

The later model pass acquired Tabasco’s CC0 small-arms archive and Lucian Pavel’s CC0 Lee-Enfield archive from OpenGameArt, inspected both with Blender 5.2.1, and used Tabasco’s Mosin walnut stock geometry in the game. The alternative Lee-Enfield was inspected but not shipped. British/German furniture and tailored uniform meshes were newly authored with Blender subdivision and UV seam correction. The runtime detail GLB is under one megabyte and reuses the existing material images. See [the detailed provenance](../public/assets/details/SOURCES.md), [hash manifest](../public/assets/details/provenance.json), and [reproducible build](../scripts/build-model-details.py).
