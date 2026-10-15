# Detailed model geometry

Built with Blender 5.2.1 on 2026-10-13. `model-details.glb` contains geometry and UVs only; Bolts assigns the acquired CC0 walnut, steel and cloth materials at runtime.

## Acquired and used: Mosin stock

- Author: **Tabasco**.
- Original listing: https://opengameart.org/content/various-small-arms-assault-rifles-sniper-pistol
- Direct archive: https://opengameart.org/sites/default/files/smallarms.zip
- Source file: `mosin9130.blend`, from the downloaded archive in `assets-source/reference-rifles/`.
- License: **CC0 / public domain**, as added by the author on 2023-12-15. The listing retains its earlier CC BY 3.0 alternative; this use relies on the author's later public-domain dedication.
- Changes: selected only walnut material faces; removed all other weapon parts and old rig; normalized to the existing game grip/fore-end coordinates; subdivided the carved cross sections and applied small rounded-edge bevels and smooth normals; authored cylindrical, longitudinal UVs; exported the resulting mesh as `rifle-wood-russian`.

## Newly authored for Bolts

The British two-piece stock/fore-end, German continuous stock, three tunic bodies, upper/lower sleeves, thighs and British lower trousers are newly authored geometry. They use shaped cross-section profiles, shallow asymmetric cloth gathers, Blender subdivision surfaces, consistent UV seams and smooth normals. The existing faction helmets, webbing, pouches, boots, head and articulation are retained. These are visual interpretations, not scans of museum firearms or uniforms.

Editable source: `assets-source/details/model-details.blend`.
Reproducible build: `scripts/build-model-details.py`.

The later rifle-metal pass adds fifteen newly authored mesh batches across the three factions: static action/furniture, machined trim, recessed surfaces, moving bolt body and moving bolt trim. `scripts/build-weapon-metal.py` is invoked by the main build. The receivers have actual open top/side channels, curved complete trigger guards, shaped magazines, oval bands, slotted screws and recessed muzzle mouths. Bolts have curved or straight handles appropriate to the faction, smaller 29–30 mm visual knobs and separate rear cocking/shroud forms. Small Blender bevels, weighted normals and one consistent UV channel replace hard primitive junctions. The original sight and muzzle anchors and animated bolt pivots remain unchanged.

These metal meshes are original artistic interpretations. Reference objects: [AWM Lee-Enfield No.4](https://www.awm.gov.au/collection/C244160), [AWM Mauser Kar98k](https://www.awm.gov.au/collection/C1017354), and [Mosin 1891/30 museum object](https://ar.culture.ru/en/subject/9-vintovka-obrazca-1891-30-gg-no-lg6018). Museum images are reference only and are not redistributed. No new third-party model geometry was acquired for the metal pass.

The combined detail asset is approximately 2 MB and includes the unchanged uniform/wood geometry. Static rifle furniture and each sight assembly are batched by material at runtime. World rifles use approximately 19.7k–25.7k triangles and 12–13 mesh draws, including wood and sights. The first-person sleeves are separately authored cloth cross sections in `src/viewmodelSleeve.ts`, with shallow asymmetric folds and a cuff seam; their unit Y axis preserves the existing animated wrist attachment.

No Call of Duty assets are included. The original CC0 face, hands, material maps and their provenance remain in their existing asset folders.

## Acquired but not shipped: alternative Lee-Enfield

Lucian Pavel's CC0 [Lee-Enfield](https://opengameart.org/content/bolt-action-rifle-lee-enfield) was downloaded from https://opengameart.org/sites/default/files/Lee%20Enfield.zip and inspected in Blender. It is a single 2,875-vertex mesh with a complete 2K texture atlas. Its inseparable static bolt/sight assemblies and authored proportions did not match the existing animation anchors, so no geometry or texture from this alternative is included in the runtime bundle. The archive and preview are retained under `assets-source/reference-rifles/` for review.

## Grenade

`src/grenadeModel.ts` creates an original M24-style stick-grenade visual, using turned wooden handle geometry, rolled canister rims, screw cap, closure detail, existing CC0 PBR materials and the existing anatomical hand assets. It is a game prop and does not model a working internal mechanism.
