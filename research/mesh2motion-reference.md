# Mesh2Motion motion sources

Reviewed 2026-10-13. Mesh2Motion provides useful humanoid locomotion, crouch and
jump animation, but its current library does not contain a bolt-action rifle or
stripper-clip reload. Source-derived motion must be adapted to Bolts' existing
rig and weapon contacts; it is not evidence of matching Call of Duty animation.

## Sources and inventory

- [Mesh2Motion](https://mesh2motion.org/) describes its animation library,
  auto-rigging, source Blender files and pre-rigged-model workflow.
- [Pinned application repository](https://github.com/Mesh2Motion/mesh2motion-app/tree/653a9698f5f315523072f1c3ff3496100401317b)
  supplies the original distributed GLB animation banks.
- [Source art repository](https://github.com/Mesh2Motion/mesh2motion-assets/tree/c5b0b6c821dbf2fa1dfe49590a6f431fd9f707ce)
  contains editable Blender rigs and individual animation projects, including
  Quaternius' human animation source pack.

The actual GLB animation inventories were inspected, rather than relying on
preview names or the marketing site's rounded count:

| Original bank | Clips | Bytes | Relevant contents |
| --- | ---: | ---: | --- |
| `human-base-animations.glb` | 87 | 5,656,648 | Walk, jog, sprint, crouch, jump phases, pistol reload |
| `human-addon-animations.glb` | 75 | 5,292,804 | Backward walk, strafing, crawl, subtle idle |
| `human-mocap-animations.glb` | 16 | 2,025,372 | Turns, gestures and other actions; not used for this integration |

These 178 humanoid clips contain one named reload, `Pistol_Reload`. There is no
rifle, bolt, charger or magazine-cartridge-loading clip. The banks include full
body tracks and finger joints; they are not first-person weapon animation packs.

Selected source durations before game-specific resampling:

| Clip | Bank | Seconds |
| --- | --- | ---: |
| Walk | base | 1.666667 |
| Jog | base | 1.166667 |
| Sprint | base | 0.833333 |
| Crouch_Idle | base | 3.666667 |
| Crouch_Walk | base | 2.500000 |
| Jump_Start | base | 1.666667 |
| Jump_air | base | 3.125000 |
| Jump_Land | base | 1.583333 |
| Pistol_Reload | base | 2.083333 |
| Idle_Subtle | addon | 2.583333 |
| Walk_Backwards | addon | 1.000000 |
| Strafe_left / Strafe_right | addon | 1.000000 |
| Crawl | addon | 1.708333 |

The exact selected clips, source hashes and generated derivative hash belong in
`public/assets/animations/mesh2motion/provenance.json`.

## License and exports

The application's [asset dedication](https://github.com/Mesh2Motion/mesh2motion-app/blob/653a9698f5f315523072f1c3ff3496100401317b/LICENSE-CC0.MD)
declares models, Blender files, rigs and animations CC0 1.0. The separate
[Quaternius notice](https://github.com/Mesh2Motion/mesh2motion-assets/blob/c5b0b6c821dbf2fa1dfe49590a6f431fd9f707ce/CC0-packs/Quaternius/License.txt)
also declares CC0. Original notices are retained alongside provenance. The app's
MIT code license is separate from these asset licenses; this pipeline reads
animation data and does not copy the Mesh2Motion retargeter implementation.

Current [export settings](https://github.com/Mesh2Motion/mesh2motion-app/blob/653a9698f5f315523072f1c3ff3496100401317b/src/lib/processes/export-to-file/DownloadSettings.ts)
and [retargeted export implementation](https://github.com/Mesh2Motion/mesh2motion-app/blob/653a9698f5f315523072f1c3ff3496100401317b/src/retarget/steps/StepExportRetargetedAnimations.ts)
support GLB and FBX, bundled selected animations, full mesh or skeleton-only
contents, and optional Mixamo-style bone names. The older repository README's
GLB-only description does not reflect those current implementations.

The [humanoid retargeter](https://github.com/Mesh2Motion/mesh2motion-app/blob/653a9698f5f315523072f1c3ff3496100401317b/src/retarget/AnimationRetargetService.ts)
maps source and target skeletal chains with rest-pose correction and bakes tracks
at 30 Hz. Its [target importer](https://github.com/Mesh2Motion/mesh2motion-app/blob/653a9698f5f315523072f1c3ff3496100401317b/src/retarget/steps/StepLoadTargetModel.ts)
requires skinned meshes with bones and a single skeletal hierarchy. It accepts
GLB, FBX or ZIP in that workflow. The ordinary auto-rigging workflow has different
import choices; those should not be confused with pre-rigged retargeting.

## Adaptation to Bolts

Bolts' world soldiers use procedural `Group` chains and two-bone IK, not a
Mesh2Motion-compatible `SkinnedMesh` hierarchy. The source rig has a root, pelvis,
three spine joints, clavicles, upper/lower arms, wrists, legs and fingers. Its
full ancestor transforms must be evaluated before reading world landmarks;
copying local joint values would ignore the source root's axis conversion.

The selected-source pipeline samples body landmarks and orientation from the
original GLBs offline, then maps those compact curves into `SoldierPose` and
the existing IK. It retains the faction models and weapon contact constraints.
Locomotion, crouching and crawling use the sampled landmark directions with
fixed-length limbs. Jump start, air and landing use their separate clips; the
landing compression is attenuated to 72% for the existing soldier proportions.
Ground contact accounts for rotated boot toe/heel bounds, a 0.245 m prone torso
support height and a 0.11 m minimum knee-center height. The knee adjustment
preserves hip/ankle contacts and bone lengths. An actual-model sweep checks
1,107 poses for floor clearance.
Only compact selected derivative data is bundled by Vite; the three complete
source banks remain research inputs, not additional runtime downloads.

`scripts/build-motion.ts` verifies the original base/addon SHA-256 hashes before
sampling. Its 15 selected clips contain 880 frames of 17 body landmarks. The
generated TypeScript data is 380,899 bytes before bundling. It retains the source
clip duration, averages and bind landmarks, removes world root translation,
reflects X to match Bolts' named limbs and rounds coordinates to five decimal
places. Full source geometry and textures are not included. To reproduce it,
download the two pinned URLs in provenance to a directory and run:

```sh
node --import tsx scripts/build-motion.ts /path/to/source-glbs
```

The provenance records the generated file hash and its gzip size. That gzip
measurement concerns this standalone source file, not a claim about the exact
final Vite bundle size.

Movement timing must follow the simulation and replay clock. Horizontal root
motion must not move actors a second time, and clip stride/phase needs adjustment
to actual travel speed. Source jump start, air and land poses need actual
grounded/vertical-velocity state. Crouch blending must preserve collision and eye
height transitions. Source clips are a motion foundation, not a replacement for
gameplay physics or aiming.

For first-person motion, source chest/pelvis rhythm can inform restrained weapon
movement and landing settlement. Any such use needs bounded offsets and ADS
checks; moving the optical axis freely would undermine the existing sight
alignment. Source body crouch should not add another camera-height displacement.

## Reload applicability

The current first-person hand GLBs each have 20 hand/palm/finger/thumb joints,
no shoulder or elbow skeleton, and no animation clips. They use different rest
axes from the humanoid bank. Directly playing its full-body clip cannot bind to
this rig. The current animation sampler also restores finger rest rotations and
solves palm, bolt-knob and thumb-cartridge contacts on every frame, so an
uncoordinated clip mixer would be overwritten.

Sampling `Pistol_Reload` confirms the left hand reaches down and returns while
the right hand predominantly holds the weapon. That is not Bolts' right-hand
bolt opening, charger placement and thumb-loading sequence. Its final use is
limited to left-elbow/shoulder fetch timing adapted into small right-elbow,
support-arm balance and rifle counter-motion. Rifle charger fetch and return
paths are separately authored smooth curves; bolt, charger and thumb contacts
remain authoritative. There is no source magazine-mechanism or direct hand-bone
retargeting. Contact and wrist checks cover both British chargers and all three
rifles; this must not be described as a sourced rifle reload.

For deterministic offline sampling, a `LoopOnce` action must have
`clampWhenFinished=true` when sampling its exact endpoint. Otherwise Three can
restore the bind pose at the last sample, introducing a false final-frame jump.

## Running sway correction

User review exposed exaggerated lateral upper-body motion after retargeting.
At 4.5 m/s the previous rifle run reached about 19.4 degrees of chest roll and
23.3 cm of lateral neck/rifle travel across a cycle. Upright running now damps
source chest roll by 80%, pelvis roll by 55%, and lateral pelvis movement by
60%, blended with the source run contribution. Crouch, crawl, airborne, landing,
backward and strafe clips retain their separate motion.

The applied-rig sweep measures approximately 4.3 degrees peak chest tilt and
5.3 cm lateral travel, while preserving more than 80 cm of stride and fixed limb
lengths. These are Bolts measurements and tuning choices, not recovered Call of
Duty constants. The regression lives in `tests/soldier-animation.test.ts`.

## Footstep cadence correction

Standing locomotion now uses a 1.35–2.40 m stride per two-footfall cycle, with a
maximum of 4.2 footfalls per second. At 1.6 m/s this produces 2.37 footfalls per
second, and at 4.5 m/s it produces 3.80, about 22–23% above the previous cadence.
These are Bolts tuning choices; crouch and crawl stride lengths are unchanged.

The step clock advances from resolved movement speed immediately and stops when
movement stops. Only the pose blend eases, reaching over 90% of the requested
speed within 100 ms. This prevents short moves from losing most of their step
phase during acceleration. The renderer, simulation and Rust hitbox fallback
share the cadence calculation within their respective runtimes. Shared movement
fixtures verify matching client/server phase and blends, including short bursts
and direction changes; dedicated tests cover frame rates and blocked movement.
