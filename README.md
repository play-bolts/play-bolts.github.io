# Bolts

A TypeScript / Three.js browser FPS inspired by the rifle-only WaWa arena in Call of Duty (2003). Start a five-minute free-for-all against five tactical AI opponents. The highest score when time expires wins; there is no kill limit.

Play the complete game at **[play-bolts.github.io](https://play-bolts.github.io/)**. Source and deployment are in **[play-bolts/play-bolts.github.io](https://github.com/play-bolts/play-bolts.github.io)**.

Multiplayer adds six-player lobbies, an authoritative Rust server, chat and durable event history. See [multiplayer deployment, data model and operations](server/README.md). **Single player** retains the local AI game without a backend connection.

## Run locally

Use Node.js 22 and npm. From the repository root:

```sh
npm ci
npm run dev
```

Open the printed local URL in a desktop browser with WebGL 2, a mouse and keyboard. Choose **Single player**, then a faction and rifle, to capture the mouse. This mode runs entirely in the browser and needs no backend or account. Escape pauses and releases the mouse. If pointer lock is unavailable, drag to look or use the arrow keys.

To use a local multiplayer server, follow [the backend setup](server/README.md) and run the frontend with its origin:

```sh
VITE_MULTIPLAYER_URL=http://127.0.0.1:8080 npm run dev
```

Run the regression suite and preview a production build:

```sh
npm test
npm run build
npm run preview
```

The production build in `dist/` includes the complete game, JavaScript, CSS, models and textures. Development tools such as the model inspector and QA controls are excluded. No external fonts or separate game installation are required.

## Deploy to GitHub Pages

The repository's [Pages workflow](.github/workflows/pages.yml) publishes the complete `dist/` directory to **https://play-bolts.github.io/**. It runs on pushes to `main` and can also be started manually from the repository's Actions tab. The build job uses Node.js 22, runs `npm ci`, `npm test` and `npm run build`, then uploads the Pages artifact; the deployment job publishes that artifact. Set the repository's **Settings → Pages → Source** to **GitHub Actions**.

[`.env.production`](.env.production) configures the public multiplayer origin:

```dotenv
VITE_MULTIPLAYER_URL=https://bolts-api.christopherkrapu.com
```

This URL is compiled into the frontend; it is public configuration. Keep server credentials, AWS credentials and identity salts out of client environment variables and the Pages workflow. The API's allowed browser origins must include `https://play-bolts.github.io`; backend deployment, storage and backups remain separate from the static frontend and are documented in [server/README.md](server/README.md).

Optional direct links `/?launch=singleplayer`, `/?launch=multiplayer`, `/?launch=options` and `/?launch=controls` open the corresponding local menu action once the game has loaded. Normal visits show the main menu.

## Play

British: Lee–Enfield (10 rounds). Russian: Mosin–Nagant (5). German: Kar98k (5). Every spawn starts with 150 total rounds, including the loaded rifle. Slot **1** holds the faction rifle; slot **2** holds a Stielhandgranate. The mouse wheel switches between them. The grenade cannot be thrown. Holding it increases movement speed by 8%. Left-click or Shift performs a vertical grenade bash for 75 damage; rifle-butt melee deals 150.

WASD move; mouse look; LMB fire; 1/2 or wheel select rifle/grenade; RMB toggle iron sights; R reload; C crouch; Ctrl prone; Space stand/jump; Q/E lean; Shift melee; Alt walk; Tab scoreboard; M change team; Escape menu. ADS can be changed to hold in Options. Prone crawling prevents firing. Jumping or falling cancels iron sights and hides the crosshair. Switching lowers the outgoing weapon before raising the selected weapon. Melee runs for about 0.708 s and can interrupt a reload. Hip-fire crosshair radius and shot spread share a 10% increase; prone receives additional tuning and is now about 4% tighter than crouch. Health does not regenerate. Respawn restores ammunition and gives short protection which ends when firing.

In multiplayer, **T** or **Enter** opens chat; **Enter** sends and **Escape** cancels. Gameplay input is suspended while typing, and recent messages fade until chat is reopened. **Tab** shows kills, deaths and each player's server-measured ping in milliseconds. Single player shows kills and deaths without a ping column. Multiplayer keeps running while a menu is open; single player pauses.

Choose **Spectator** in the in-game team window for free flight or first-person following. Left/right click cycles forward/backward through living players, and Escape returns from following to free flight. In free flight, WASD moves, Space/Ctrl rises/descends, and Shift moves faster. Use the team window to join combat again.

Options saves your player name and previews classic `^0`–`^9` name colors, for example `^7Chri^9s` (white “Chri”, gray “s”). A color continues until the next code. Bolts uses dark green for `^8` and gray for `^9`; extended colors vary across original versions/maps. Use Escape or the **Esc · Menu** button to pause, then **Main menu** to leave the round; the end-of-round screen also provides **Main menu**.

Each difficulty changes recognition time, delayed visual observations, tracking speed, aim error, trigger hesitation, and tactical behavior. Bots take time to recognize a reappearing opponent, aim with persistent error and drift, and lose tracking accuracy when targets move. Rifle reports and incoming damage provide approximate threat locations. They share the player's collision, bullet obstruction, damage, reload, and bolt-cycle systems; misses come from the actual shot direction. Bots use visibility and a view cone, remember observed locations, choose cover with peek opportunities, flank according to their role, and navigate with A* without cutting crate corners. The round is free-for-all; faction selects equipment and appearance, not teams.

The fairness design, primary references, difficulty settings, and qualified seeded measurements are documented in [research/ai-fairness.md](research/ai-fairness.md). In a controlled 14 m shooting test, stationary hit rates fell from 100% to approximately 20% / 32% / 51% for Recruit / Regular / Veteran. These are isolated shooting measurements, not expected accuracy in a full round.

Death triggers a buffered simulation replay from the killer's perspective. The final scoreboard identifies the winner. Takeoff and landing transitions receive exact replay snapshots. Single-player rules run locally; multiplayer movement, damage, scoring, respawns and round timing are authoritative on the Rust server.

The arena is 29.7 × 33.9 m: exactly half the original implementation's floor area. Horizontal crate dimensions and spawn positions scale with it; cover heights stay unchanged. Full lean moves the viewpoint 0.416 m sideways, 30% farther than before, subject to collision clearance.

## Fidelity and reference

The original videos and official manual are documented in [research/wawa-reference.md](research/wawa-reference.md), with additional gameplay observations in [research/video-animation-reference.md](research/video-animation-reference.md). Stone walls, cloudy sky, dirt, canvas crates and rifle silhouettes follow the inspected footage. Balanced daylight, sky reflections, matte cloth, world-space weathering and tighter contact shadows add surface detail using the existing photographic maps. See [material and shader notes](research/material-sources.md). The current asset pass uses selective PBR maps, licensed full-body soldier and weapon geometry, and source ambient-occlusion maps. First-person hands retain the CC0 anatomical rig with smoother skinned geometry, shaped knuckles and pads, skin/nail roughness variation, folded cloth sleeves and close-range contact shadows. The environment is original, while soldiers and weapons use credited CC BY models alongside CC0 anatomical/material assets; no Call of Duty asset files are included. The opening menu contains **Single player**, **Multiplayer**, **Options** and **Controls**. AI difficulty is available in the single-player in-game Options panel, applies without resetting scores or time, and is remembered for future rounds.

The opening menu uses an original 3D tabletop scene and right-side logo/options based on the official 2003 manual. Single player loads the arena and opens Team then Weapon selection in a centered black double-bordered window. Multiplayer first opens the lobby browser, then the same selection flow before joining. These choices are also available from the in-game menu. A local faction change respawns the player while preserving scores and time; an online change from an active combat faction counts as a death and uses the normal respawn delay. The HUD uses cream serif lettering, distinct weapon silhouettes, a compass and a compact bordered ammunition counter. It has no stance indicator. The scoreboard shows kills, deaths and online ping on a near-black panel; colored kill messages appear lower-center and the killfeed sits above the compass. The Times-style system font approximates observed letterforms; the exact original font has not been identified. See [UI and equipment references](research/ui-reference.md).

Soldiers use three licensed full-body models: patromes' British battledress soldier, tnnv's Soviet uniform with pilotka cap, and britdawgmasterfunk's German Panzergrenadier. Their source faces, tailored garment folds, boots, equipment, UVs and textures replace the earlier segmented procedural bodies. Continuous skinning adapts each model to the deterministic 15-bone animation rig; original/source-authored weight gradients bend sleeves and trousers through the joints. Official download links, license attributions, adaptation details and source/output hashes are in [soldier provenance](public/assets/imported-soldiers/ATTRIBUTION.md). First-person hands still use para's CC0 MakeHuman-based mesh, UV skin and 20-joint skeleton, with clean capped wrists. The three imported rifles retain distinct woodwork, bolts and original iron sights. The Mosin uses MaX3Dd’s detailed source model and authored wood/metal PBR maps, adapted without its scope or bayonet. Earlier authored soldier and rifle geometry remains a development fallback. See [asset references](research/asset-reference.md) and [fallback provenance](public/assets/details/SOURCES.md).

Body motion adapts CC0 Mesh2Motion/Quaternius clips for walking, running, crouching, crawling, takeoff and landing. Fixed-length leg IK and weapon contact constraints adapt the source motion to the current rigs. First-person weapon inertia uses small source chest/shoulder movements and landing compression; full ADS preserves the sight axis. Rifle reloads use authored curved reaches with bounded source elbow/counter-motion, since the source library contains a pistol reload but no bolt-action rifle reload. Right wrists stay within a 28° bend through the rifle poses. See [motion sources and adaptations](research/mesh2motion-reference.md). The current Sketchfab models were acquired through official authenticated downloads: Moony_State’s Lee-Enfield Mk III, MaX3Dd’s Mosin-Nagant, Ecler’s Kar98k and Janovich’s Stielhandgranate. Their CC BY 4.0 attributions are available in Options → Credits. The source models have no animation clips; Bolts supplies their articulated bolt/hand animation.

This is a playable recreation, **not a verified identical port**. The short reference videos do not provide an overhead map, exact crate coordinates, original models, animation frames, sounds, or numerical weapon/physics data. Arena dimensions, crate placements, hitboxes, spread, reload times, recoil and movement constants remain approximations. Rifle regional damage follows firsthand original weapon-file research (180 head / 108 chest / 96 abdomen / 72, 60 or 48 limbs); headshots are always lethal. Hit volumes follow the posed source skeleton and remain simplified collision geometry rather than exact skin triangles. The unthrowable grenade with a melee bash is a requested departure from the original. See [combat evidence and limits](research/combat-reference.md). The tactical AI is a new implementation. Map colors and main silhouettes were compared to footage; pixel-perfect and frame-perfect equivalence has not been established.

## Code

- `src/config.ts`: rifles, rules, arena, collision/ray geometry and estimated damage table.
- `src/engine.ts`: fixed-step simulation, actor physics, rifle handling, tactical decisions, scoring and recorded killcam.
- `src/navigation.ts`: navigation grid, A* and cover scoring.
- `src/renderer.ts`: procedural Three.js world, animation and first-person presentation.
- `src/soldier.ts`, `src/soldierModelAssets.ts`, `src/rifle.ts`: licensed faction body/rifle models, continuous skin loading and equipment assembly.
- `src/hands.ts`, `src/humanHead.ts`: bundled anatomical asset loading, cloning and hand posing.
- `src/weaponAnimation.ts`: articulated two-hand reload, bolt-cycle, melee and bounded wrist alignment.
- `src/humanoidMotion.ts`, `src/soldierMotion.ts`, `src/firstPersonMotion.ts`: source clip sampling, body retargeting and held-weapon inertia.
- `scripts/build-motion.ts`: reproducible compact landmark export from the licensed source GLBs.
- `src/names.ts`: safe player-name normalization and classic color codes.
- `src/audio.ts`: generated rifle, bolt, reload, hit and footstep audio.
- `src/ui.ts`, `src/style.css`: match menu, options, controls, HUD and scoreboard.
- `tests/engine.test.ts`: occlusion, navigation, collision, weapons, replays, round lifecycle and AI simulations.
- `tests/ai.test.ts`: seeded accuracy, delayed perception, reacquisition, threat information, field of view, and firing readiness.
- `tests/assets.test.ts`: GLB geometry, embedded textures, skin weights, closed wrists and actual skeletal hand deformation.

During `npm run dev`, open `/inspector.html` to inspect the actual soldier and rifle geometry, orbit the models, check each iron sight, and scrub two-hand animations. Open `/?qa=1` for deterministic HUD, killcam and lean checks through real game events. Both development tools are excluded from the production build.

The app is an independent fan project, not affiliated with Activision. Call of Duty is the property of its respective owners.
