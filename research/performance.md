# Performance update

This update reduces rendering and presentation overhead while preserving the gameplay configuration and authoritative simulation. Movement, jumping, stances, weapon timing, recoil, spread, damage, hitboxes, input bindings, AI decisions, round rules and server protocol are unchanged. The only engine/network metadata addition is a stable renderer identity used to retain the correct model across roster changes.

## Implemented work

| Area | Implementation and preserved behavior |
| --- | --- |
| Invisible models | Conservative body bounds include every stance, weapon and death pose. A swept bound also checks whether an offscreen soldier can cast a visible shadow. Hidden actors still advance animation phase, stance blends and death history; expensive posing resumes at the correct simulation/replay time. |
| Static scenery | Compatible opaque meshes merge into spatial batches with their positions, normals, UVs, material identity and shadow flags preserved. Canvas meshes stay separate because their shading depends on local coordinates. Static transforms no longer rebuild each frame. |
| Shadows | The fixed world-light shadow map is reused until contributing actors or scene state change. Intro shadows update on invalidation. Animated first-person shadows retain their separate pass; quality changes and context restoration invalidate cached state. Static and dynamic world shadows have not been split into separate baked layers. |
| Roster changes | Models reconcile by stable participant identity and faction rather than array index. Only affected rigs change. A bounded reserve keeps one idle soldier per faction; first-person rifle/grenade pairs are retained by faction. Active actors own independent mutable rigs. |
| Effects and animation allocation | Muzzle and impact bursts reuse GPU geometry/materials in a bounded pool. Reused bursts reset their transforms, particle attributes and shot-time state. Particle counts and trajectories stay the same. Hand posing reuses scratch vectors and bone metadata; reload reaches cache their existing curves and arc-length tables. |
| Startup preparation | All faction model variants are constructed, textures uploaded and shader variants compiled while loading. A temporary target warms geometry and shadow programs, then restores renderer and object state. Nine rifle sound variants are synthesized in a worker after the first audio initialization using the original recipes, sample rate and seeds; first-use synthesis remains an exact fallback. |
| Texture storage | Six stone/dirt/walnut color and roughness maps use high-quality KTX2 where ASTC/BC7 is available. Source resolution, mip chains, color space and UV orientation are retained. Original JPEGs handle unsupported formats and loading failures. |
| HUD | Ammo, weapon/feed markup, text, classes and styles update when their inputs change. Crosshair, compass and other continuous indicators still sample each frame. |
| Main menu | The static three-rifle scene renders on entry and layout/quality/context changes, then retains that frame. Online-count polling and menu input continue independently. |
| Resolution under load | High-DPI, high-quality rendering can reduce only the 3D drawing-buffer pixel ratio, with bounded steps and recovery described below. |

Spatial audio also shares unchanged emitter/listener obstruction results across an actor's concurrent voices. Updating all transforms before routing the voices avoids repeating cover raycasts against a mixture of old and new positions. Stereo positioning, distance response and obstruction behavior remain in place.

## Bounded visual tradeoffs

Adaptive resolution applies only when the configured pixel ratio is above **1.5**. High quality starts at `min(devicePixelRatio, 1.75)`; medium/low and screens at or below 1.5 retain their configured ratio. During active play, a 2.5-second sampling window reduces the ratio by at most 0.10 per step when the 80th-percentile frame time exceeds 21 ms, stopping at 1.5. Sustained healthy windows recover toward the original ratio. Menus, paused presentation and hidden tabs restore the configured ratio and reset the sampling window. Large suspension spikes are ignored.

At the maximum adjustment, 1.75 → 1.5 draws approximately **27% fewer pixels**; this is not a promise of a 27% FPS gain. The 3D image can be slightly softer temporarily. DOM text, HUD layout, camera field of view, aiming coordinates and simulation remain unchanged.

The six compressed maps require **20,971,680 bytes** of ASTC 4×4/BC7 GPU storage including mipmaps, compared with **83,886,072 bytes** as RGBA8: approximately **60 MiB saved**. Their quality-first files total **15,965,498 bytes**, compared with **8,925,766 bytes** of JPEGs, adding about **7 MB** to an uncached download plus roughly 0.6 MB of local transcoder files. Other material maps and imported model textures are unchanged. Compression is not pixel-identical; decoded quality checks and unchanged source dimensions guard against large visual changes. Original JPEGs remain in the distribution for fallback. [Encoding, provenance and compatibility details](performance-webgpu.md)

WebGPU is **not shipped as the game renderer**. The isolated experiment had higher CPU submission time on the tested device, and Bolts' custom GLSL materials require a separate port to Three's node material system. That comparison does not establish whole-game FPS or results on other hardware. [WebGPU measurements and limits](performance-webgpu.md)

## Measurement

Use `npm run dev` and open `/performance.html` for the deterministic six-actor presentation scene. `/performance.html?compressed=1` enables the production KTX2 path; the default retains JPEGs for comparisons that isolate other changes. The scene exercises standing/crouching, aim, reloads, muzzle flashes and impacts at a fixed 1280 × 720 viewport and 1.75 pixel ratio. Adaptive resolution is not active in this harness. Runs warm for four seconds and measure the next twelve; hiding the tab invalidates the result. GPU timing is included only when the browser exposes disjoint timer queries.

The harness reports frame intervals, renderer-side CPU time, draw calls, triangle counts and resource counts. Its roster action measures model reconciliation, and its menu action measures repeated calls to the static menu renderer. It measures the isolated renderer and effects, **excluding AI, network and UI CPU work**. Compare equivalent viewport, quality, texture mode, browser and foreground state; frame intervals may be capped by display refresh. CPU submission time is not GPU execution time, and GPU storage arithmetic is not an FPS measurement.

The following 2026-10-16 results use repeated, warmed runs to reduce first-run/JIT bias. The baseline uses original JPEGs; the final optimized combat run includes the production KTX2 path. Both use the same six-actor scene, four-second warmup, twelve-second measurement, foreground browser and fixed 1280 × 720 / 1.75 rendering resolution. Both already sustained approximately 120 Hz, so the result is reduced rendering cost and additional headroom rather than a demonstrated FPS increase.

| Measurement | Before | After | Conditions / interpretation |
| --- | --- | --- | --- |
| Combat presented frame interval, median | 8.3 ms | 8.3 ms | Both approximately 120 Hz |
| Combat renderer/effects CPU, mean | 3.617 ms | 2.395 ms | **34% lower** in this controlled run |
| Combat renderer/effects CPU, median / p95 | 3.5 / 4.2 ms | 2.4 / 2.8 ms | 1,439 / 1,441 measured frames |
| Combat GPU execution, mean | 4.389 ms | 3.757 ms | **14% lower**, measured with GPU timer queries |
| Combat draw calls, mean | 762.84 | 315.62 | **59% fewer**, including world and first-person passes |
| Combat triangles, mean | 845,995 | 846,598 | Essentially unchanged; sampled effect timing differs slightly |
| Unchanged menu CPU, mean | 2.131 ms | 0.020 ms | Retains the previously rendered image |
| Unchanged menu draw calls | 43 | 0 | No redraw until invalidated |
| Roster reconciliation CPU, mean | 95.525 ms | 0.150 ms | Four controlled leave/rejoin operations; small sample, not a general join-latency guarantee |

Earlier runs were substantially more variable; comparing a cold baseline with a warm optimized run exaggerates the improvement. The table deliberately uses the repeated warmed pair and does not claim a guaranteed FPS gain on other machines. Saved local measurements are `artifacts/performance-before-combat-repeat.json`, `artifacts/performance-after-compressed-repeat.json` and the corresponding `before/after-menu` and `before/after-roster` reports. The raw resource count can grow when models are retained for reuse; texture counts alone do not measure GPU bytes.

## Verification

Regression coverage checks world geometry/UV preservation when batching, offscreen shadow bounds, hidden animation continuity, independent rig ownership, pool capacity and reuse, unchanged particle output, scene preparation state restoration, menu invalidation, HUD updates, exact rifle-worker sample output, audio obstruction-cache invalidation, KTX2 hashes/orientation/transfer functions/mips/fallback, and adaptive-resolution bounds/recovery. Existing combat, network, reload, hand-contact and round-presentation tests remain part of the suite.

Run `npm test` and `npm run build` for the full frontend checks. The focused network and round-presentation tests check unchanged multiplayer prediction and end-of-round/killcam presentation. Browser QA covers real shader compilation and texture decoding, menu and combat screenshots, and the isolated WebGPU experiment. Benchmark pages, inspector controls and the WebGPU experiment are development entries and are excluded from the shipped game bundle.

No backend deployment or database migration is needed for this update. GitHub Pages continues to host the complete frontend and local assets; the existing API server remains authoritative for multiplayer.
