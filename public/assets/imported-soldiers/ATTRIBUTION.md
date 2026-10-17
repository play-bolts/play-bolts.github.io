# Full-body soldier models

These models were acquired through the creators' official Sketchfab download
buttons, then adapted in Blender for Bolts. The original downloaded archives are
kept in the development workspace; runtime files are the adaptations below.

All three listings identify the license as
[Creative Commons Attribution 4.0](https://creativecommons.org/licenses/by/4.0/).
The creators are also credited in the game's Options → Credits.

| Runtime model | Original work | Creator |
| --- | --- | --- |
| `british.glb` | [WWII British Soldier](https://sketchfab.com/3d-models/wwii-british-soldier-9af571fa416546f08dfc2ba95e604083) | [patromes](https://sketchfab.com/patromes) |
| `german.glb` | [WW2 Panzergrenadier_fbx_tpose_CC0](https://sketchfab.com/3d-models/ww2-panzergrenadier-fbx-tpose-cc0-99ae9a9deb2c46c5956342b3bf9de7a2) | [britdawgmasterfunk](https://sketchfab.com/britdawgmasterfunk) |
| `russian.glb` | [WW2 Soviet Uniform](https://sketchfab.com/3d-models/ww2-soviet-uniform-f85a4ed8c33a43eca1a7caa45f7acf99) | [tnnv](https://sketchfab.com/tnnv) |

The German creator additionally describes that work as CC0; Bolts retains the
more explicit CC BY attribution provided with the downloaded GLB. The Soviet
creator describes the uniform as made in Blender and Quixel Mixer, with the body
made in Adobe Fuse. The Soviet model retains its original pilotka field cap.

Adaptations: normalization to 1.80 m; neutral bind-pose correction; continuous
15-bone skinning compatible with the game's deterministic IK; hidden covered
skin/source weapons removed where present; source UVs, visible faces and garment
details retained. British duplicate vertices were welded while preserving UV
corners and faces. British helmet and German uniform surface response were
corrected for painted metal and cloth. British/German weights were authored;
Soviet source weights were collapsed and retargeted. Color textures are JPEG92
(alpha color remains PNG) at up to 1K, with lossless normal/material maps up to
512 px. There are no Call of Duty soldier asset files in these models.

The runtime additionally removes the German helmet's separate camouflage
foliage and wire and applies solid gray paint to its shell. Soviet boot width
and length are fitted around the original ankle pivots, fading into the source
trousers; UVs, skin weights and sole height are retained. German boots are fitted
16% narrower and 13% shorter at the foot, fading out below the knees; their
ankle weights are tightened around the instep so the leather shafts follow the
shins. Source triangles, UVs, textures and sole heights are retained. These adjustments are
implemented in `src/soldierModelAssets.ts`; the derivative GLBs remain unchanged.

Each `*-provenance.json` records source/output SHA-256, geometry counts and
adaptations. Each `*-profile.json` records measured bind anchors. Reproducible
conversion scripts are in `scripts/build-imported-soldiers.py`,
`scripts/build-imported-soldier-german.py`,
`scripts/build-imported-soldier-russian.py`, and
`scripts/optimize-imported-soldier-textures.py`.
