# WaWa reference inspection

Inspected 2026-10-12. This document distinguishes directly observed appearance from implementation estimates. The inspected clips do **not** establish exact map coordinates, collision dimensions, weapon timing, or damage values.

## Gameplay videos actually opened and inspected

1. [Wawa Cod 1 — teamheroes1](https://www.youtube.com/watch?v=ZhG3bY4aCic), approximately 48 seconds. Inspected paused gameplay frames around **00:14, 00:19, 00:24, and 00:29** in the YouTube player. Intro/outro occupy part of this short montage.
2. [Wawa Headshot — nathan154](https://www.youtube.com/watch?v=vyESxTUepaY), approximately 16 seconds. Inspected **00:10–00:11**. The first several seconds are a title card.

### Direct visual observations

- The arena is enclosed by tall, nearly featureless light beige/gray stone-block walls. The rectangular masonry courses are clearly visible. Wall height is several soldier heights.
- The top is open to a pale blue-gray, cloudy/overcast sky; it is not a roofed warehouse.
- The floor is flat, mottled brown/olive dirt. It does not have grass, paved roads, rubble-filled ruins, or urban buildings.
- Cover consists of axis-aligned rectangular crates and box stacks with different heights. Some short boxes are around waist height; the largest central stack rises clearly above a standing soldier.
- Most crates have khaki/gray canvas covering the upper body and a short dark olive green wooden/slatted base. The larger central stack seen in the second clip has a taller exposed pale brown plank crate base under its canvas-covered upper block.
- There are open gaps between clusters and an open strip along the perimeter. The clips show central and edge cover but do not provide a complete overhead plan.
- A small dark rectangular WaWa sign is attached high on one perimeter wall in the first video.
- Rifle viewmodel is wooden brown and dark gray steel with visible hands and muted green sleeves. It sits toward the lower-right in ordinary movement and shifts toward the center for sighting. The second clip shows the hand operating the bolt around 00:11.
- The HUD has a round compass in the lower-left, compact ammunition/health information near the lower-right, pale text in the lower portion, and a green health indicator. The clips contain extra montage/player-name overlays and performance counters, which should not be mistaken for stock HUD requirements.
- Bodies and dropped rifles are visible on the dirt in the second clip.

### Limits of verification

These low-resolution, edited clips are enough to check the visual theme and the major cover silhouettes. They are not sufficient to verify an identical layout or identical weapon behavior. No exact recoil curve, rate of fire, movement speed, spread, ADS time, damage table, spawn algorithm, or AI behavior was measured from them. Values chosen without additional authoritative game data must be described as approximations.

## Official control and behavior reference

[Call of Duty manual, hosted by Steam](https://cdn.cloudflare.steamstatic.com/steam/apps/2620/manuals/COD.pdf), printed pages 6–15 and 18–21.

The original defaults are WASD movement, Q/E held lean, C crouch, Ctrl prone, Space stand/jump, left-click fire, **right-click toggle ADS**, R reload, Shift melee, and Tab score. ADS slightly zooms and slows movement. Movement widens spread; stationary crouch/prone improves accuracy. Prone crawling prevents firing. Empty clips reload automatically. The Lee-Enfield holds ten rounds with two five-round clips; the three rifles are slow-firing, powerful long-range weapons.

This manual supplies qualitative behavior, not numerical recoil/damage or timings. COD1 does not have the United Offensive sprint default; Shift is melee in the original manual.

## Other corroborating pages

- [WaWa 3D Aim, Call of Duty 2 remake, GameFront](https://www.gamefront.com/games/call-of-duty-2/file/wawa-3d-aim-map): describes an enclosed room with scattered boxes. This is **CoD2**, not authoritative for CoD1 dimensions.
- [WaWa 3D Aim, United Offensive map listing](https://www.nexusmods.com/callofdutyunitedoffensive/mods/484?tab=files): confirms a UO variant exists, but does not establish which historical variant the footage uses.

## Verification checklist for Bolts

- Match tall beige masonry walls, flat dirt, overcast open sky, and varied khaki-covered box silhouettes.
- Use restrained brown/olive/gray materials, strong readable silhouettes, and a low-poly early-2000s appearance.
- Show a wood-and-steel bolt rifle with first-person hands, centered iron sights, recoil, and visible bolt operation.
- Keep the original crouch/prone/lean/ADS controls and compact period HUD where compatible with browser input.
- Record which map placements and weapon constants remain estimates; do not label them identical to the original.

## Comparison with the implementation

The implemented scene was compared in Chrome against the paused 00:10 frame of **Wawa Headshot**. That comparison prompted lighter beige masonry with smaller stone courses, a lighter gray-brown dirt floor, pale gray-khaki canvas instead of dark olive fabric, darker green crate bases, and a taller exposed wooden base on the central stack. The dark wall-mounted WaWa sign and short-lived fallen soldiers were also included. First-person wood grain, open iron sights, moving bolt and a reload clip were inspected in the running app.

Browser checks covered all three faction selections, Recruit/Regular/Veteran selection, round start, ADS, crouch, firing, ammo decrement, reload (5/60 to 4/60 to 5/59), death/killcam, respawn, pause, scoreboard and the 390 × 844 briefing layout. Pointer lock was unavailable to the browser automation, so interactive checks exercised the drag/arrow-key fallback; normal hardware pointer capture still needs a direct human play-test. Browser logs showed no app-origin errors during these checks.

The map's overall palette, cover types and HUD positions match the inspected reference qualitatively. Exact layout, asset detail, animations, recoil and damage have not been validated as identical. The implementation intentionally labels these constants as estimates.
