# Bolts

A TypeScript / Three.js browser FPS inspired by the rifle-only WaWa arena in Call of Duty (2003). Start a five-minute free-for-all against five tactical AI opponents. The highest score when time expires wins; there is no kill limit.

Play the complete game at **[play-bolts.github.io](https://play-bolts.github.io/)**. Source and deployment are in **[play-bolts/play-bolts.github.io](https://github.com/play-bolts/play-bolts.github.io)**.

London, Singapore and São Paulo are behind `extraLobbies` in [shared/features.json](shared/features.json), currently **false**. Disabled releases hide these lobbies, reject regional admission and prohibit provisioning warm regional capacity; Oregon remains on the existing host. Existing AWS capacity must also be drained with the [regional disable procedure](server/README.md#disabling-extra-lobbies) to stop its compute charges. See [regional operations](server/README.md#gamelift-regional-hosting).

Multiplayer adds six-player lobbies, an authoritative Rust server, chat and durable event history. See [multiplayer deployment, data model and operations](server/README.md). **Single player** retains the local AI game without a backend connection.

Multiplayer protocol 3 uses lossless binary inputs and snapshots, adaptive input scheduling, monotonic opponent interpolation, and immediate generation-tagged combat effects. Snapshot publication is paced after server stalls; shared payloads are encoded outside the game lock. Durable kill/chat notifications retain their ordering and persistence guarantees; camera corrections stay clear of walls. The client and server must be released together. See [the research and measurements](research/netcode.md), [protocol and timing diagnostics](server/PROTOCOL.md), and [multiplayer validation](server/README.md).

The main menu displays a Kar98k, ammunition clips, breadbag and marching compass on a worn wooden tabletop. The locally bundled still-life uses no WebGL rendering or hidden model animation while the front menu is open. Its online count tracks connected human lobby members, including spectators, across the server. Quiet multiplayer lobbies add two server-controlled opponents while one or two humans are connected; the bots leave at three humans or when the last human disconnects. Humans retain priority over bot seats, and disconnected human reservations still count toward the six-player capacity.

**Leaderboard** shows all-time and rolling 24-hour kills and deaths, ranked by kills. Scores are indexed by the name used when each event happened, with color codes removed, whitespace normalized and capitalization ignored. Renaming does not transfer earlier scores. Identical names share a row; names are not authenticated accounts. The default **Unknown Soldier** and bot identities are excluded. **Feedback** accepts a required message and optional email, stored privately in the backend SQLite database; no feedback or contact information is exposed through a public read API. See the backend documentation for schema, migration and operator queries.

The all-time leaderboard includes three operator-seeded launch scores, tracked separately in `leaderboard_seeds`. They create no player identities or activity events and contribute nothing to the rolling 24-hour scores. The repeatable [seed utility](scripts/seed-leaderboard.py) preserves later earned scores and requires a private pre-change backup when applying changes.

Count browsers opening Bolts in the past N hours with `python3 scripts/user-analytics.py --aws --hours 24 --json`. Lightweight visitor tracking includes the menu and single-player mode, using a random browser ID and server receipt times, independent of multiplayer identities. It respects Do Not Track and Global Privacy Control; failed requests never block play. Counts begin at deployment and represent browsers, not verified distinct people. Use `--source multiplayer` for the separate connection-based report. The [analytics and privacy guide](research/user-analytics.md) covers time windows, exclusions, opt-out and limitations.

## Run locally

Use Node.js 22 and npm. From the repository root:

```sh
npm ci
npm run dev
```

Open the printed local URL in a desktop browser with WebGL 2, a mouse and keyboard. Choose **Single player**, then a faction and rifle, to capture the mouse. This mode runs entirely in the browser and needs no backend or account. Escape pauses and releases the mouse. If mouse look stops, use **Resume**, click the game, or click **Click to enable mouse look**. Every fresh click retries capture after a failure; chat, menus and lost focus cancel pending capture so late events cannot steal the mouse back. If pointer lock remains unavailable, drag to look or use the arrow keys.

Mobile browsers with WebGL 2 can also play. The mobile menu displays **Best experienced on a PC.** Rotate into landscape to enter a match; menus remain usable in portrait.

Enable **Options → Hit indicators** for four small diagonal marks around the aim point when you hit an opponent, including while using iron sights. They are off by default, and your choice is saved in this browser. Multiplayer indicators wait for the server to confirm the hit.

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

## Performance

Rendering reuses actor models and effect buffers, batches compatible scenery, skips invisible posing, updates unchanged HUD elements less often, and draws the static menu on demand. Models, textures and shaders warm up before play; rifle audio warms in a worker after audio initialization. Gameplay rules, controls, hitboxes, AI decisions and multiplayer authority are unchanged.

High-quality environment compression saves about **60 MiB of GPU texture storage** on supported hardware, with roughly **7 MB more initial downloads** plus the local transcoder. High-quality rendering on high-DPI screens can temporarily reduce pixel ratio from **1.75 to 1.5** under sustained load; HUD text stays at native resolution. WebGPU was evaluated separately and is not enabled in the game. See [implementation, benchmarks and verification](research/performance.md) and [texture/WebGPU findings](research/performance-webgpu.md).

First-time mobile players default to **Medium** graphics. Touch mode caps rendering pixel ratio at **1**, adapts down to **0.75** under sustained load, and gradually restores resolution when performance recovers. Saved graphics preferences are preserved.

## Deploy to GitHub Pages

The repository's [Pages workflow](.github/workflows/pages.yml) publishes the complete `dist/` directory to **https://play-bolts.github.io/**. It runs on pushes to `main` and can also be started manually from the repository's Actions tab. The build job uses Node.js 22, runs `npm ci`, `npm test`, the Python operator-script tests and `npm run build`, then uploads the Pages artifact; the deployment job publishes that artifact. Set the repository's **Settings → Pages → Source** to **GitHub Actions**.

[`.env.production`](.env.production) configures the public multiplayer origin:

```dotenv
VITE_MULTIPLAYER_URL=https://bolts-api.christopherkrapu.com
```

This URL is compiled into the frontend; it is public configuration. Keep server credentials, AWS credentials and identity salts out of client environment variables and the Pages workflow. The API's allowed browser origins must include `https://play-bolts.github.io`; backend deployment, storage and backups remain separate from the static frontend and are documented in [server/README.md](server/README.md).

Optional direct links `/?launch=singleplayer`, `/?launch=multiplayer`, `/?launch=options` and `/?launch=controls` open the corresponding local menu action once the game has loaded. Normal visits show the main menu.

## Play

British: Lee–Enfield (10 rounds). Russian: Mosin–Nagant (5). German: Kar98k (5). Every spawn starts with 150 total rounds, including the loaded rifle. Slot **1** holds the faction rifle; slot **2** holds a Stielhandgranate. The mouse wheel switches between them. The grenade cannot be thrown. Holding it increases movement speed by 8%. Left-click or Shift performs a vertical grenade bash for 75 damage; rifle-butt melee deals 150.

WASD move; mouse look; LMB fire; 1/2 or wheel select rifle/grenade; RMB toggle iron sights; R reload; C crouch; Ctrl prone; Space stand/jump; Q/E lean; Shift melee; Alt walk; Tab scoreboard; M change team; Escape menu. ADS can be changed to hold in Options. Prone crawling prevents firing. Jumping or falling cancels iron sights and hides the crosshair. Switching lowers the outgoing weapon before raising the selected weapon. Melee runs for about 0.708 s and can interrupt a reload. Hip-fire crosshair radius and shot spread share a 10% increase; prone receives additional tuning and is now about 4% tighter than crouch. Health does not regenerate. Respawn restores ammunition and gives short protection which ends when firing.

In touch mode, the **left joystick** moves at an analog speed and stops on release; tap it to jump. **Crouch** and **Prone** sit above the left joystick, with **Aim** and **Reload** above a separate **Fire** button. Swipe the open right side of the screen to look; the camera follows finger movement and stops when the finger stops. Press **Fire** for one shot, and drag from that button to adjust your aim while moving with the other thumb. Release and press again for another shot. **Aim** toggles iron sights. Compact buttons provide menu, scoreboard and multiplayer chat. Spectators can also swipe to look. Rotating into portrait clears held inputs; return to landscape and tap **Resume** to continue. Multiplayer keeps running during interruptions.

In **Options**, set **Controls** to **Automatic**, **Touch**, or **Mouse and keyboard**. **Touch sensitivity** and **Control size** adjust the mobile controls independently of mouse sensitivity.

The mobile main menu is centered in either orientation. The online-player count appears only when at least two players are connected.

Combat feedback combines rifle reports, separate melee swings and contacts, and positional hit sounds. Muzzle blasts include animated flame, smoke, sparks and a brief gas ring. Confirmed hits emit denser directional blood mist, streaks and falling droplets; melee uses a wider fan. Effects reuse bounded GPU buffers, and killcams replay the same recorded effect shapes. Rifle reports, bolt/reload handling and movement now use 27 excerpts from the supplied gameplay recordings. Three reports per rifle avoid consecutive repeated takes; two movement candidates alternate across all stances with the existing stance volume. Combat impacts, melee, switching and UI sounds remain procedural. Procedural fallbacks play immediately if a recording is unavailable; see [audio design and validation](research/audio-reference.md) and [recording provenance](public/assets/audio/game/README.md).

Open the standalone [Sound review page](sound-review.html) at
`/sound-review.html` on the development or production site. It includes the current
three reports per rifle, bolt cycles, full reloads and the Enfield partial reload,
two movement clips with stance sequences, three combat effects and nine
AI-generated character voice lines with their English translations. The recorded
clips retain their supplied duration and natural pitch, with short boundary fades.
An older procedural rifle report remains available as a fuller DSP comparison.
Reports now last 800 ms, retaining the shot and following audio
with a gradual 300 ms curved fade from 0.5 to 0.8 seconds. Handling retains
overlapping sounds and ambience. The Mosin
reload source is a partial refill, and the movement
clips are unconfirmed footstep candidates rather than verified stance recordings.

The candidate bank contains three Stability AI options for each of 18 sound
families (three rifles, three movement stances, three combat effects and nine
voice lines): **Warm & full**, **Crisp & detailed**, and **Gritty & powerful**,
54 options in total. The page lists only completed assets from
`shared/audio-candidates.json`. Each candidate has Play and Download controls;
reviewing one does not replace game audio. Movement candidates use the same
stance gain as current step previews, leaving the downloadable WAV unchanged.
Voice options whose local transcription differs from the intended words carry a
review note; short accented speech can also confuse transcription, so audition
these alongside the originals. These are experimental options, not approved
replacements.

For a portable file with all audio embedded, run
`node --import tsx scripts/export-sound-review-html.ts` and open
`temp/sound-review.html` directly. Its preferences are separate from the game.

Only one preview plays at a time; **Stop**, **Escape**, or leaving the page stops
it. The page is separate from the game's main menu and shares saved Volume with
the game.

Spoken kill lines are currently disabled by `killVoices: false` in
[shared/features.json](shared/features.json). Gameplay neither downloads nor
plays voice clips, even with a previously saved 100% chance. **Options** and the
review page show the chance control as disabled; saved preferences and the
underlying 10% default remain available for a future release. Existing static
voice assets can still be auditioned manually on the review page. Gameplay makes
no AI API calls. [Voice provenance and regeneration](public/assets/audio/voices/README.md).

In multiplayer, **T** or **Enter** opens chat; **Enter** sends and **Escape** cancels. Gameplay input is suspended while typing, and recent messages fade until chat is reopened. **Tab** shows kills, deaths and each player's server-measured ping in milliseconds. Single player shows kills and deaths without a ping column. Multiplayer keeps running while a menu is open; single player pauses.

Choose **Spectator** in the in-game team window for free flight or first-person following. Left/right click cycles forward/backward through living players, and Escape returns from following to free flight. In free flight, WASD moves, Space/Ctrl rises/descends, and Shift moves faster. Use the team window to join combat again.

Options saves your player name and previews classic `^0`–`^9` name colors, for example `^7Chri^9s` (white “Chri”, gray “s”). A color continues until the next code. Bolts uses dark green for `^8` and gray for `^9`; extended colors vary across original versions/maps. Use Escape or the **Esc · Menu** button to pause, then **Main menu** to leave the round; the end-of-round screen also provides **Main menu**.

Each difficulty changes recognition time, delayed visual observations, tracking speed, aim error, trigger hesitation, and tactical behavior. Bots take time to recognize a reappearing opponent, aim with persistent error and drift, and lose tracking accuracy when targets move. Rifle reports and incoming damage provide approximate threat locations. They share the player's collision, bullet obstruction, damage, reload, and bolt-cycle systems; misses come from the actual shot direction. Bots use visibility and a view cone, remember observed locations, choose cover with peek opportunities, flank according to their role, and navigate with A* without cutting crate corners. The round is free-for-all; faction selects equipment and appearance, not teams.

Regular and Veteran also hold protected cover while reloading, use short peeks and withdrawals, prefer less exposed routes, and reconsider a position when a flank becomes threatened. They remember up to three approximate threat locations and scan their flanks during recovery or search. Veteran checks and replans more frequently. These survival tactics apply to the single-player difficulty presets; Recruit and the multiplayer server's separate bot preset are unchanged. See [survival behavior and validation](research/ai-survival.md).

The fairness design, primary references, difficulty settings, and qualified seeded measurements are documented in [research/ai-fairness.md](research/ai-fairness.md). In a controlled 14 m shooting test, stationary hit rates fell from 100% to approximately 20% / 32% / 51% for Recruit / Regular / Veteran. These are isolated shooting measurements, not expected accuracy in a full round.

Death triggers a buffered simulation replay from the killer's perspective. The final scoreboard identifies the winner. Takeoff and landing transitions receive exact replay snapshots. Single-player rules run locally; multiplayer movement, damage, scoring, respawns and round timing are authoritative on the Rust server.

The arena is 29.7 × 33.9 m: exactly half the original implementation's floor area. Horizontal crate dimensions and spawn positions scale with it; cover heights stay unchanged. Full lean moves the viewpoint 0.416 m sideways, 30% farther than before, subject to collision clearance.

## Fidelity and reference

The original videos and official manual are documented in [research/wawa-reference.md](research/wawa-reference.md), with additional gameplay observations in [research/video-animation-reference.md](research/video-animation-reference.md). Stone walls, cloudy sky, dirt, canvas crates and rifle silhouettes follow the inspected footage. Balanced daylight, sky reflections, matte cloth, world-space weathering and tighter contact shadows add surface detail using the existing photographic maps. See [material and shader notes](research/material-sources.md). The current asset pass uses selective PBR maps, licensed full-body soldier and weapon geometry, and source ambient-occlusion maps. First-person hands retain the CC0 anatomical rig with smoother skinned geometry, shaped knuckles and pads, skin/nail roughness variation, folded cloth sleeves and close-range contact shadows. The environment is original, while soldiers and weapons use credited CC BY models alongside CC0 anatomical/material assets. Audio uses supplied recordings, with processing details in [audio metadata](public/assets/audio/game/provenance.json). The opening menu contains **Single player**, **Multiplayer**, **Leaderboard**, **Feedback**, **Options**, **Controls** and **Credits**. The title uses locally bundled Alfa Slab One under SIL OFL 1.1; see [title font sources](research/title-font.md). AI difficulty is available in the single-player in-game Options panel, applies without resetting scores or time, and is remembered for future rounds.

The opening menu uses an original 3D tabletop scene and right-side logo/options based on the official 2003 manual. Single player loads the arena and opens team selection in a centered black double-bordered window. Selecting British, Russian or German immediately equips its Lee–Enfield, Mosin–Nagant or Kar98k and enters play; there is no separate weapon selection screen. Multiplayer first opens the lobby browser, then uses the same team selection before joining. Team changes and Spectator remain available from the in-game menu. A local faction change respawns the player while preserving scores and time; an online change from an active combat faction counts as a death and uses the normal respawn delay. The HUD uses cream serif lettering, distinct weapon silhouettes, a compass and a compact bordered ammunition counter. It has no stance indicator. The scoreboard shows kills, deaths and online ping on a near-black panel; colored kill messages appear lower-center and the killfeed sits above the compass. The Times-style system font approximates observed letterforms; the exact original font has not been identified. See [UI and equipment references](research/ui-reference.md).

Soldiers use three licensed full-body models: patromes' British battledress soldier, tnnv's Soviet uniform with pilotka cap, and britdawgmasterfunk's German Panzergrenadier. Their source faces, tailored garment folds, boots, equipment, UVs and textures replace the earlier segmented procedural bodies. Continuous skinning adapts each model to the deterministic 15-bone animation rig; original/source-authored weight gradients bend sleeves and trousers through the joints. Official download links, license attributions, adaptation details and source/output hashes are in [soldier provenance](public/assets/imported-soldiers/ATTRIBUTION.md). First-person hands still use para's CC0 MakeHuman-based mesh, UV skin and 20-joint skeleton, with clean capped wrists. The three imported rifles retain distinct woodwork, bolts and original iron sights. The Mosin uses MaX3Dd’s detailed source model and authored wood/metal PBR maps, adapted without its scope or bayonet. Earlier authored soldier and rifle geometry remains a development fallback. See [asset references](research/asset-reference.md) and [fallback provenance](public/assets/details/SOURCES.md).

Body motion adapts CC0 Mesh2Motion/Quaternius clips for walking, running, crouching, crawling, takeoff and landing. Fixed-length leg IK and weapon contact constraints adapt the source motion to the current rigs. First-person weapon inertia uses small source chest/shoulder movements and landing compression; full ADS preserves the sight axis. Rifle reloads use authored curved reaches with bounded source elbow/counter-motion, since the source library contains a pistol reload but no bolt-action rifle reload. Right wrists stay within a 28° bend through the rifle poses. See [motion sources and adaptations](research/mesh2motion-reference.md). The current Sketchfab models were acquired through official authenticated downloads: Moony_State’s Lee-Enfield Mk III, MaX3Dd’s Mosin-Nagant, Ecler’s Kar98k and Janovich’s Stielhandgranate. Their CC BY 4.0 attributions are available in the main menu's Credits entry. The source models have no animation clips; Bolts supplies their articulated bolt/hand animation.

This is a playable recreation, **not a verified identical port**. The short reference videos do not provide an overhead map, exact crate coordinates, original models, animation frames, isolated sound assets, or numerical weapon/physics data. Arena dimensions, crate placements, hitboxes, spread, reload times, recoil and movement constants remain approximations. Rifle regional damage follows firsthand original weapon-file research (180 head / 108 chest / 96 abdomen / 72, 60 or 48 limbs); headshots are always lethal. Hit volumes follow the posed source skeleton and remain simplified collision geometry rather than exact skin triangles. The unthrowable grenade with a melee bash is a requested departure from the original. See [combat evidence and limits](research/combat-reference.md). The tactical AI is a new implementation. Map colors and main silhouettes were compared to footage; pixel-perfect and frame-perfect equivalence has not been established.

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
- `public/assets/menu/`: the static tabletop menu artwork and its provenance.
- `src/community.ts`: online count, leaderboard and feedback API client.
- `src/visitors.ts`: optional anonymous page-open and visible-page heartbeat tracking.
- `server/src/bots.rs`: authoritative multiplayer bot perception, navigation and input.
- `tests/engine.test.ts`: occlusion, navigation, collision, weapons, replays, round lifecycle and AI simulations.
- `tests/ai.test.ts`: seeded accuracy, delayed perception, reacquisition, threat information, field of view, and firing readiness.
- `tests/ai-survival.test.ts` and `tests/ai-cover.test.ts`: protected reloads, peeking, flank attention, crossfire, sensory memory, cover geometry, route risk and Recruit isolation.
- `tests/assets.test.ts`: GLB geometry, embedded textures, skin weights, closed wrists and actual skeletal hand deformation.

During `npm run dev`, open `/inspector.html` to inspect the actual soldier and rifle geometry, orbit the models, check each iron sight, and scrub two-hand animations. Open `/?qa=1` for deterministic HUD, killcam and lean checks through real game events. Both development tools are excluded from the production build.

The app is an independent fan project, not affiliated with Activision. Call of Duty is the property of its respective owners.
