# Gameplay video observations

## Natural arm study — current rig overhaul

Directly reviewed in **Safari**, paused and stepped through the rifle chapters of
[EVO33's CoD1/UO reload recording](https://www.youtube.com/watch?v=OUmvpEm7FII).
These observations describe the visible motion, not recovered animation data.

| Segment | Observed hand and arm mechanics |
| --- | --- |
| Enfield, 1:16–1:18 | The left palm cups the underside of the fore-end. Its sleeve enters low, slightly left of the rifle, with a coherent forearm-to-hand diagonal. The right hand approaches above the receiver from screen-right; the thumb presses down while the other fingers curl beside the charger. Most of the operating forearm stays beyond the right edge. |
| Kar98k, approximately 1:26 | The right hand slopes gently toward the loading thumb. The wrist does not form a separate sharp hinge. The support hand stays planted while the rifle tilts only slightly. |
| Unscoped Mosin, 1:48–1:49 | Opening, charger insertion, pressing and return are distinct beats. The loading hand enters from the right, with a nearly horizontal forearm direction and downward thumb. Support-hand contact persists. |

Reference captures: `artifacts/natural-cod1-enfield-load-77.png`,
`artifacts/natural-cod1-kar98k-loading-86.png`, and
`artifacts/natural-cod1-mosin-charger-109.png`. These are review evidence only;
no reference screenshots are shipped as game assets.

The resulting project checks must cover the complete arm in the actual gameplay
camera. A contact point, a finite transform, or a wrist-angle limit alone cannot
prove a natural pose. The old rig allowed long forearms and moving shoulders;
those are defects to remove, rather than established reference behavior to keep.

## Multiplayer

Source: [user-supplied Call of Duty multiplayer footage](https://www.youtube.com/watch?v=-0FQ5HX209g). The primary agent directly inspected the following frames in Safari; these notes record that visual inspection rather than inferred game data.

| Time | Visible reference used |
| --- | --- |
| [1:35](https://www.youtube.com/watch?v=-0FQ5HX209g&t=95s) | First-person hip-fire rifle holding pose and hands. Used to compare the procedural hand/rifle arrangement. |
| [2:10–2:20](https://www.youtube.com/watch?v=-0FQ5HX209g&t=130s) | Mosin iron-sight view and ADS presentation. Used to compare centered sight alignment and the transition into the aiming pose. |
| [2:21](https://www.youtube.com/watch?v=-0FQ5HX209g&t=141s) | “You killed” message in plain white/cream serif text with a black shadow and colored player-name characters, including a red `2`. The message is at about 78% of the game viewport height: observed video viewport y=240–1360, message near y=1118. The killfeed is lower-left above the compass, with small pale text and colored names. |
| [7:15](https://www.youtube.com/watch?v=-0FQ5HX209g&t=435s) | Compact scoreboard rows on a mostly black / very dark panel. |

Additional direct Safari comparison in this revision: the round opening after 2:21 shows the hip rifle close to horizontal center, with its muzzle roughly 53% across and 60% down the video frame. Bolts’ hip pose was moved inward and lower accordingly. The paused frame at **3:06** shows the Mosin rear notch/front hood aligned centrally, with the worn metal receiver below the sight line. This motivated photographic wood and worn steel surface work; numerical dimensions remain estimates.

## Original walkthrough

The primary agent directly viewed the [supplied original walkthrough](https://www.youtube.com/watch?v=X7KJ7yDJDGk&t=4500s) in Safari at **1:15:00–1:15:19**. The inspected segment shows a nighttime objective with a scoped bolt-action rifle: the left hand supports the fore-end at lower-left, and a long exposed metal receiver occupies the low center/right. A compact compass sits bottom-left, with a small health bar and ammunition display bottom-right. A pale serif “Game Saved” message appears around 71% of the game viewport height.

No reload sequence was observed in that segment. These observations support rifle holding-pose and HUD comparisons; they do not verify the reload animation, its duration, or an unscoped iron-sight pose.

## Limits

Bolts uses these observations for presentation and pose direction. Its original rifle/uniform shapes and authored animation transitions remain approximations (hands and faces now use textured anatomical meshes): they are not pixel-identical or animation-frame-exact reproductions, and this inspection does not establish original numerical animation timings.

## 13 October 2026 — combat/intro comparison

The supplied multiplayer video was reopened in **Safari**, with direct frame inspection around **2:38** and **3:00**. The readable differences addressed in this revision were:

- The killfeed shows a small, pale side-profile rifle between player names. Bolts' text dash is replaced by distinct original silhouettes for all three rifles, plus a melee icon and a grenade inventory icon.
- The reference HUD includes a triangular stance indicator immediately beside the compass, and a compact bordered ammunition counter. Both presentations were missing in Bolts and are now present.
- The Mosin has a continuous, shaped wooden fore-end and wrist rather than several visibly joined primitives. The new model pipeline adapts a publicly released CC0 Mosin mesh in Blender, with new stock surfaces for the British/German rifles and shaped uniform surfaces.

The [official manual](https://cdn.cloudflare.steamstatic.com/steam/apps/2620/manuals/COD.pdf), PDF page 3 / printed page 5, was rendered and viewed. Its main-menu screenshot shows a tabletop still life, a diagonally laid rifle, paper and ammunition, and a right-side logo/menu divided by a fine vertical rule. Bolts now recreates that composition with its own 3D scene, retaining the separately referenced black selection window for Team/Weapon. No screenshot or original CoD artwork is shipped.

Native video seeking was unreliable in this session: playback changed during attempts to pause/seek. These samples verify the HUD, rifle presentation and menu direction; they **do not** establish frame-exact switching, melee or death timings. The new lower/raise switch, right-led melee, and staged directional collapse are authored approximations, not recovered original animation clips. Numerical damage evidence and the remaining hitbox limits are recorded separately in combat-reference.md.
