# Posed collision model

The renderer and CPU collision path share `solveHeldArms` in `src/hitboxArms.ts`. It fits fixed-length arms and the held rifle together using the source stock contacts. `src/hitboxCore.ts` supplies the same body, stance, gait and foot transforms used for rendering. The Rust server mirrors these calculations; snapshots carry the authoritative gait phase and blended stance/aim values so client IDs and frame rates do not select different poses.

First-person presentation has a separate entry point, `sampleFirstPersonWeaponAnimation` in `src/firstPersonWeaponAnimation.ts`. The player, killcam, spectator follow and weapon inspector use it; world soldiers and this data generator continue to use `sampleWeaponAnimation`. First-person framing operates on a complete owned copy, including finger controls. Camera-facing grip, sleeve or weapon offsets can be tuned there without changing canonical third-person poses, source contact constants or hitboxes. Both views still use the gameplay action phase and timing.

Collision uses ellipsoids fitted to the imported body surfaces, attached to the posed bones. These are still an approximation of skin and loose clothing, not triangle-perfect collision. Helmet brims, carried weapons and equipment do not enlarge damageable flesh. The geometry audit measures both missed body silhouette and hits outside visible flesh rather than checking bone centers alone.

## Regeneration

Run from the project root after changing source hand assets/contact selection, soldier geometry or weights, weapon contacts, world animation, or arm fitting:

```sh
node --import tsx scripts/generate-hand-collision-data.ts
node --import tsx scripts/generate-hitboxes.ts
node --import tsx scripts/generate-hitbox-fixtures.ts
node --import tsx --test tests/hitbox-arms.test.ts tests/hitbox-controls.test.ts tests/hitbox-geometry.test.ts
cargo test --manifest-path server/Cargo.toml
```

Commit the generators and their generated JSON/fixture outputs together. Rebuild the Rust binary after regenerating data, because the server embeds it at compile time.

`handCollisionData.json` contains only the ancestor transforms and weighted source vertices needed for palm/thumb contact. Its CPU forward kinematics reproduce those deformed hand vertices directly; no mesh or texture is loaded by the server. `hitboxData.json` contains body-volume fits, source rig measurements, locomotion clips and densely sampled weapon controls. The control regression bounds interpolation error below 1 mm and 0.001 radians; final posed-bone comparisons are checked against the actual imported models.

The British trouser loader repairs a source adaptation defect independently of collision: a fold crosses the bind-pose centerline but belongs to the left leg. Connected garment components below 0.82 m identify that leg, including coincident UV-seam vertices. Only the side of 322 mistaken leg influences changes; vertex positions, normals, UVs, triangle topology and normalized weight magnitudes are retained. This prevents stretched cloth between the knees instead of enlarging hit volumes to cover it.

For live client parity, run an isolated local backend and then:

```sh
BOLTS_TEST_URL=http://127.0.0.1:18082 node --import tsx scripts/test-network-adapter.ts
```

That harness checks two actual clients' common authoritative pose frames, independent history copies, remote pose interpolation, matching shot rays, reconnect, spectator transitions and return to local play.
