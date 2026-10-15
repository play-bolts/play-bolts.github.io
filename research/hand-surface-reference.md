# Anatomical first-person hands

The bundled hands retain the mesh, UV photograph and 20-joint finger rig from
[para's FPS arms, rigged only](https://opengameart.org/content/fps-arms-rigged-only),
published March 18, 2015 under CC0. The listing credits MakeHuman for the mesh
and texture and para for cleanup, UV rebaking and the rig. No Call of Duty hand
assets or textures are used. Original files remain in `assets-source/arms`.

`scripts/build-hands.py` isolates each hand in wrist-local coordinates and caps
the wrist at the original attachment plane. One Catmull-Clark subdivision smooths
the fingers and thumb webbing; a creased wrist boundary preserves its exact fit.
Small authored knuckle volumes and thenar/hypothenar palm pads add contour without
moving the skeleton. Each exported hand has 13,304 triangles and 20 joints, up from
3,334 triangles. The original 1,024-pixel photographic atlas is unchanged.

The exported `_SKIN_DETAIL` attribute marks nails, knuckles and palmar surfaces.
It is bound to the same vertices as finger skinning. `src/handSkin.ts` combines
the source photograph with slight skin-tone variation, broad dry-skin highlights,
lower nail roughness and derivative-filtered pore detail. The pore pattern uses
unposed mesh coordinates, avoiding sliding or swimming during animation.
The current material neutralizes the source's orange cast, uses a broader matte
highlight, and derives shallow crease relief from the same UV photograph. It
does not add a second pink tint over the photographic skin. The support elbow
has a small outward pole offset, while the fitted palm and fingertip contacts
remain fixed to each stock. Dense animation and projected-silhouette checks
continue to cover attachment, wrist bend, and the compact lower-left sleeve.
The [Three.js MeshPhysicalMaterial documentation](https://threejs.org/docs/pages/MeshPhysicalMaterial.html)
documents the IOR/specular controls used here. This material has no transmission
or clearcoat, and uses the shared scene lighting and first-person contact shadows.

The grenade-only hand transform aligns finger hinges with the vertical handle;
its transformed wrist anchor remains connected to the forearm. Rifle hand
coordinates, finger posing interfaces and animation timings are preserved.

Validation checks the embedded photograph, normalized skin weights, all fingertip
influences, closed welded wrist topology, exact wrist plane, finite anatomical
masks and real skinned fingertip deformation. Visual checks cover reload at 43%,
bolt at 40%, melee at 35% and the carried grenade in the development inspector.
This is authored anatomical refinement, not a photogrammetric hand scan or a
frame-exact reproduction of the original game's hand model.
