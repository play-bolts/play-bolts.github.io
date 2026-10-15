# Rifle geometry refinement

Implemented with Blender 5.2.1 on 2026-10-13. The existing British/German authored stocks and Tabasco CC0 Mosin stock remain in use; see [asset provenance](../public/assets/details/SOURCES.md). This pass adds original metal geometry and does not extract any Call of Duty assets.

## Reference and visual interpretation

- [Australian War Memorial No.4 Mk I](https://www.awm.gov.au/collection/C244160): receiver and detached box-magazine silhouette, rear aperture mounting and two-piece wood furniture. The museum documents variation in finishes and wartime parts; this model represents the family rather than that exact specimen.
- [Australian War Memorial Kar98k](https://www.awm.gov.au/collection/C1017354): rounded Mauser action, internal magazine floor, bent bolt handle, front bands and muzzle furniture.
- [Mosin Model 1891/30 museum object](https://ar.culture.ru/en/subject/9-vintovka-obrazca-1891-30-gg-no-lg6018): long stock/barrel, straight bolt handle and characteristic lower magazine.

Museum photographs are inspected as references; they are not shipped. The rifle proportions remain adapted to the existing game camera, grip, muzzle and sight coordinates. These are renderable exterior surfaces, not internal mechanical replicas or manufacturing models.

### Original Call of Duty sight comparison

The original-game screenshots on the [Call of Duty (2003) firearm reference page](https://www.imfdb.org/wiki/Call_of_Duty_(2003)) were reviewed in Safari alongside the running inspector. Local evidence captures are `artifacts/cod1-enfield-ads-reference.png`, `artifacts/cod1-mosin-ads-reference.png` and `artifacts/cod1-kar98k-ads-reference.png`. These screenshots document the game's presentation; they are not redistributed as runtime assets.

The Enfield screenshot shows a broad rear-sight base below its aperture, with short protective sides. The Mosin's distant front hood appears much smaller than the previous Bolts hood. The original Kar98k presents an exposed front post rather than the hood used in the earlier reconstruction. This review led to shorter Enfield sight rails and a broader base, a smaller Mosin hood, an exposed Kar98k post, and slimmer supported rear-notch leaves. The ADS camera placement was also brought closer to the receiver (`adsZ: -.015`) to improve the relative size of rear and front sights. These are visual corrections from screenshots; exact original model dimensions and projection settings remain unverified.

## Implementation

`scripts/build-weapon-metal.py` creates five material/animation batches per rifle. Boolean openings remove the top/side of each receiver around the bolt; the ejection channel is real geometry rather than a dark rectangle over a solid cylinder. The rest of the model adds continuous curved guards and triggers, stepped/tapered barrels with recessed bores, shaped magazine profiles, oval barrel bands, slotted screws, curved handles and smaller bolt knobs. Bevels and weighted normals make the new neutral-metal PBR maps catch broad light on machined edges. Smart-projected UV islands are normalized to one channel before glTF export and material batching.

`src/rifle.ts` retains the `bolt` group's position `[0,.045,-.26]`. The animated bolt meshes use coordinates relative to that pivot; they retain the hand-contact centres even though the knobs are less oversized. Named front/rear sight groups and hand interfaces are preserved. Static geometry is merged by material, including the front/rear sight furniture. Before the subsequent sight-detail adjustment, world models measured approximately 25,704 triangles/13 mesh draws (British), 19,734/12 (Russian), and 23,060/12 (German), so every bot can use the same silhouette without a large draw-call increase.

`makeViewmodelSleeveGeometry()` provides a shared unit-length forearm mesh for rifle and grenade. Its tapered, slightly oval cross sections have shallow diagonal folds and cuff gathers. The renderer continues scaling the local Y axis between the elbow and wrist. The right cuff shares the sleeve's photographed cloth material, preventing a flat tan material band at the hand attachment.

The later [hand-contact review](hand-contact-reference.md) replaces wrapper-origin targets with palm-cup and actual skinned thumb-pad anchors. The charger now presents a vertical cartridge stack, the bolt hand follows its actual knob, and the loading elbow moves above/right behind the wrist.

## Validation

The model tests load the actual exported glTF, check finite UVs/normals, independent clone disposal, barrel/sight/bolt anchors, model bounds and mesh/triangle budgets. Raycasts verify an open lowered receiver channel and recessed muzzle mouth on each faction. Sleeve checks cover finite geometry and the exact `[-.5,+.5]` Y animation range. Existing reload/bolt/melee tests cover absolute animation poses; final optical/grip appearance is checked in the running model inspector.
