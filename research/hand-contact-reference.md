# Hand contact and reload review

The October 2026 screenshot review identified two errors that mesh subdivision
could not fix: animation targets referred to a hand wrapper's origin rather than
the palm, and a second rifle-only rotation changed that origin's meaning. The
reload also kept its elbow below the screen while the wrist rose, making the
sleeve cross behind the hand.

Original gameplay screenshots on the
[Call of Duty firearm reference page](https://www.imfdb.org/wiki/Call_of_Duty_(2003)#Lee-Enfield_No._4_Mk._I)
show the support hand wrapping the fore-end, the loading wrist entering from the
upper right, and a thumb pushing a vertical cartridge stack down into the
receiver. Local review captures include `artifacts/cod1-enfield-reload-reference.png`
and `artifacts/cod1-enfield-ads-reference.png`; they are reference evidence, not
game assets.

The rifle hands now have explicit contact frames. Stock and bolt poses position
the cup of the fingers; loading positions an actual vertex on the skinned thumb
pad. Hand-root transforms are solved from those contacts after finger posing.
The moving bolt knob supplies the same lift and travel path as its mesh. The
charger contains a vertical stack of five cartridges, with thumb contact following
the upper cartridge as the stack moves into the receiver. Grip changes blend
continuously, and the reload elbow rises behind the wrist. The grenade retains
its separate grip frame.

`tests/hand-contact.test.ts` loads the real hand GLBs and checks thumb-to-cartridge
contact, downward loading palm/fingers, support thumb/finger sides, all three bolt
paths, and wrist continuity through contact transitions. This complements visual
review in the inspector; it does not establish frame-exact original animation.

The subsequent `artifacts/update12-melee-final.png` review exposed a separate
stock-grip error: a fingertip emerging above the trigger guard was actual mesh
penetration, rather than normal occlusion on the far side of the rifle. Probing
the skinned hand against the authored wooden stock confirmed that the original
tightly curled fingers intersected the wood despite their correct palm anchor.
The firing grip now sits 35 mm farther forward and 20 mm lower on the British and
Russian rifles, and 24 mm lower plus 3 mm to the right on the German rifle. Its
middle, ring, and little fingers use progressively looser curls, and the thumb
rotates outside the stock. These adjustments fade out for the bolt grasp and
loading-thumb contact, preserving the reviewed reload pose.

The final lower, looser grip is geometry-verified against the real hand and stock
GLBs for all three rifles. The regression checks every skinned hand vertex for
more than 1 mm of horizontal penetration inside the stock and also requires skin
within 3 mm of its surface so that avoiding overlap cannot leave a floating grip.
This check takes approximately 3.6 seconds. A visual recapture of this final grip
adjustment is pending; the earlier reload and melee captures remain the visual
evidence for the preceding contact-frame and sleeve corrections.

The next review measured the actual imported wrist-cap outward axis against the
sleeve's wrist-to-elbow direction. Correct positional attachment alone had left
the right wrist bent about 95.5 degrees in idle and melee, and up to 151.8 degrees
while cycling the Mosin bolt. The loading pose at 43% was already aligned within
7.1 degrees for the British rifle and 9.4 degrees for the others. The fixed low
elbow and a bolt rotation around weapon Z caused the severe bends.

The stock hand now angles back toward the body, and bolt manipulation rotates
around the wrist's longitudinal axis. Quaternion interpolation joins the stock,
bolt, and unchanged loading orientations while contact-point placement remains
exact. The elbow prefers the right side of the body and is constrained to a
28-degree wrist cone; normal forearm reach stays between 28 and 38 cm. The
reviewed loading reach is preserved. Sleeve roll follows the actual wrist
cross-section, and its endpoint sits inside the existing cuff. No hand geometry,
finger curls, cuff size, or curved sleeve was introduced for this correction.
The rotated stock grip needed only 2–4 mm of lateral contact adjustment to retain
clearance and near-surface contact against all three actual wooden stocks.

The actual-asset regression samples 501 phases of each action for every rifle.
It checks the imported wrist axis against the sleeve, the shared cuff endpoint,
body-side elbow position, bounded reach, smooth sleeve rotation and position,
preserved loading reach, and deterministic scrubbing. The resulting maximum
wrist bend is 28 degrees. Offline first-person renders of the actual geometry
confirmed the corrected bolt grip and melee wrist silhouette. They also exposed
an open cuff edge: its original 10.5 mm of sleeve overlap was smaller than the
rim's approximately 19.7 mm axial offset at a 28-degree bend. Moving only the
sleeve endpoint 14 mm farther inside the existing cuff fixes that overlap without
enlarging the cuff or changing the hand pose. At that stage, the 43% loading bends
measured 6.9 degrees British and 9.1 degrees Russian/German. Browser and offline
captures are reviewed separately from these geometry and continuity checks.

The subsequent Mesh2Motion pass replaces the charger's segmented fetch and return
with smooth reach curves and adds small weapon/support-arm counter-motion. The
official library's `Pistol_Reload` supplies only secondary reach timing and elbow
balance: its magazine and hand paths are not used as rifle loading mechanics.
The authored bolt, charger, and loading-thumb contacts remain authoritative.
With this balance movement, the final 43% loading bends measure 8.2 degrees
British and 10.8 degrees Russian/German; the dense actual-asset sweep remains
bounded at 28 degrees. Browser review of `artifacts/update14-reload-reach.png`,
`artifacts/update14-reload-wrist.png`, and `artifacts/update14-reload-return.png`
confirmed the approach, thumb contact, and recovery without wrist inversion.

World soldiers use the source's lower-body and torso motion while rifle and
grenade grips remain constrained. An initial landing review exposed elevated
arms when the body compressed beneath a fixed-height weapon. Weapon positions
and elbow hints now follow the retargeted torso, including the carried grenade.
The corrected landing was visually reviewed in `artifacts/update14-source-land.png`;
regressions sweep hip-fire and aiming poses for both held items across the landing.
Source provenance and the limits of this adaptation are recorded in
`research/mesh2motion-reference.md`.

## Imported rifle contact calibration

The exact user-selected Sketchfab rifles use measured source stock, fore-end, bolt and sight anchors. The existing anatomical hand rig then applies source-specific contact offsets and thumb/finger curls. The initial wide-stock thumb pose produced a visible thumbs-up against the narrower sources; it now wraps across the stock. A lowered support palm passed a nearest-point test but visibly floated below the Mosin during melee. That was replaced by a palm-supported grasp with individual curls for the shorter fingers and explicit palm/fingertip proximity checks. The imported melee keeps both fitted grips fixed relative to the rifle.

Browser verification includes all three ADS views, reload and melee poses, the movement-only grenade, world soldier reloads, and the live Enfield arena view. Exact source geometry tests accompany the existing wrist/bolt/charger sweeps. The source models do not include animation clips; Bolts supplies their motion.

## Support wrist and shouldered presentation review

The next user review correctly identified that the support wrist still looked
bent. The previous wrist constraint covered only the right hand. The left sleeve
now follows the actual skinned cuff frame, including its roll, with a maximum
22-degree wrist deviation. The support thumb follows the barrel and the palm
supports the fore-end; the firing palm turns upward under the stock. Separate
operating poses preserve bolt-knob and loading-thumb contacts. Actual source
wood/skin checks require palm and multiple finger contacts as well as clearance.

The first closer ADS experiment put the rear sights 22 cm from the eye. Browser
inspection rejected it: the back of the Kar98k receiver dominated the view, and
a sweep of the actual animated bolts showed near-plane crossings. Final framing
uses source-specific shouldered offsets and a 48-degree weapon camera (64
degrees at the hip), preserving the original model scale and the world camera.
The rear/front sight points stay on the aim ray. A source-bolt bounds guard moves
the complete held model forward only when necessary to retain 5 cm of camera
clearance through cycling and damage recoil; gameplay recoil is unchanged.

`artifacts/update16-kar98k-ads-hands.png` and
`artifacts/update16-mosin-melee-hands.png` record browser review of the improved
grip silhouette. The real-geometry tests are complementary checks, not evidence
of frame-exact Call of Duty animation.

## Professional first-person animation methods — October 2026

The cone-only elbow approach documented above is **superseded as the rig
design**. Its 22/28-degree wrist limits reduced extreme bends but did not
constrain a complete shoulder–elbow–wrist chain. The upper sleeve could change
length to meet the chosen elbow. Passing those angle/contact tests therefore
did not establish believable anatomy. This section records the replacement
requirements, not a claim that implementation or visual approval is complete.

DICE weapon animator Oskar Wetterbrandt describes authoring idle, ADS and sprint
poses before actions, reviewing through the final first-person camera, and
checking tight grips, natural wrists and low screen-space elbows. Reloads follow
weapon mechanism reference and deliberate action beats. Competing breathing,
sprint-camera and hit-reaction layers are suppressed during complex actions.
These practices support rebuilding the whole-arm base pose before refining
reloads. [DICE, Animating weapons for Battlefield V](https://ea_dice.artstation.com/blog/jMao/animating-weapons-for-battlefield-v)

Epic's two-bone IK uses a three-joint chain, wrist effector position/orientation,
an elbow joint target and explicit stretching controls. Unity independently
exposes position, rotation and elbow-hint weights. For Bolts, the inference is
to preserve measured segment lengths and body-side shoulders, author elbow
hints, and adjust unreachable weapon/hand poses rather than stretch sleeves.
[Epic Two Bone IK](https://dev.epicgames.com/documentation/en-us/unreal-engine/two-bone-ik?application_version=4.27),
[Unity Two Bone IK](https://docs.unity3d.com/Packages/com.unity.animation.rigging@1.3/manual/constraints/TwoBoneIKConstraint.html)

Rebel Thorp's production workflow places an independently animated weapon root
and hand targets in explicit spaces, blending constraints when a hand leaves
or returns. Its first-person guidance also stresses skinning and lower-arm
twist joints. Unity's twist correction distributes rotation across multiple
nodes. This addresses a different problem from wrist bending: a rigid sleeve
cannot represent distributed forearm roll merely by following the cuff.
[Rebel Thorp Animation](https://rebelthorp.com/guides/animation),
[Unity Twist Correction](https://docs.unity3d.com/Packages/com.unity.animation.rigging@1.3/manual/constraints/TwistCorrection.html)

Autodesk matches IK and FK controls before switching to prevent jumps. Apply
the same principle to stock, bolt, charger and free-reach handoffs: match
position and orientation, then blend ownership. Epic's first-person rendering
documentation also distinguishes the final camera projection from an ordinary
editor view; inspection must use the actual game camera and aspect ratio.
[Autodesk IK/FK matching](https://help.autodesk.com/cloudhelp/2023/ENU/Maya-Animation/files/GUID-C5ACDDBC-9E30-443C-8419-F07FC41E9A86.htm),
[Epic First Person Rendering](https://dev.epicgames.com/documentation/unreal-engine/first-person-rendering)

### Acceptance checklist

These are Bolts engineering/visual targets, not published anatomical standards:

- Preserve actual-mesh grip regressions: palm distance below 1.2 mm, finger
  contact below 3 mm and existing penetration limits.
- Keep upper/lower-arm lengths constant and shoulders attached. Reject elbow
  plane flips, accidental stretching and unstable straight-arm configurations.
- Review idle, ADS, bolt manipulation, every charger phase, melee and recovery
  as whole-arm poses. Wrist-angle caps alone cannot approve them.
- Require smooth forearm roll, intact cuff overlap and no pinching or sleeve
  corkscrew in palm-up/down poses.
- Check position/orientation continuity at contact handoffs. Planted hands stay
  weapon-relative under recoil and sway; free hands release cleanly.
- Preserve rifle-specific bolt/charger mechanics; generic pistol motion is
  secondary reference only. Check deterministic forward/backward scrubbing.
- Review frozen poses and playback through the actual hip/ADS cameras at 4:3,
  16:9 and ultrawide, including killcam. Numerical checks complement visual
  review; neither proves frame-exact Call of Duty animation.

### Implemented and verified — October 14, 2026

The replacement rig now uses fixed shoulder anchors, measured upper/lower-arm
lengths, continuous skinned sleeves and distributed forearm roll. Reload targets
have shorter approach/withdraw paths, and the supporting hand stays on the
stock. World soldiers use articulated fingers with anatomically mapped sides,
neutral wrists and low elbow targets. Reloads lower the rifle rather than pull
the operating hand behind the face.

The final suite passes 193 tests. Dense 600-step first-person sweeps include
stance motion, recoil, ADS transitions, bolt actions and contact handoffs;
actual skinned wrists/cuffs and fixed segment lengths are checked independently
of diagnostic metadata. Real-asset world sweeps cover all factions, stances,
aim pitches and action phases. Replay does not accumulate pose changes.

Final screenshots review all three rifles in hip fire and ADS, bolt extraction
and closing, charger reloads, melee, grenade bash and world prone/reload poses.
Live-game checks cover reload completion, crouched ADS, weapon switching,
killcam, round ending during a bash and returning to the menu. No application
console errors appeared. Representative artifacts are
`artifacts/final-mosin-reload-55.png`,
`artifacts/natural-enfield-cycle-accepted.png`, and
`artifacts/natural-world-reload-close.png`.

Visual browser checks used the available approximately 4:3 viewport. The
browser viewport override did not change reported dimensions, so the intended
16:9/ultrawide visual pass remains unverified; the existing camera/projection
regressions cover 4:3 grip visibility and 16:9 ADS bolt clearance. These are
authored animations informed by footage and production methods, not extracted
or frame-exact Call of Duty clips.

### Support-arm framing correction — October 14, 2026

The user's attached Enfield frame identifies a composition problem that the
previous anatomical checks missed: the supporting palm should sit beside the
fore-end, with only a short cuff entering from below. A long sleeve sweeping
across the lower-left viewport is incorrect even when its wrist angle passes.

The revised first-person pose pronates each support hand around its actual
stock, directs the wrist back along the rifle, and tucks the elbow underneath.
Each rifle retains an individually fitted palm and finger contact. The right
hand and imported third-person soldiers keep their established pose systems.
Projection regressions measure the deformed sleeve surface in hip fire and
ADS at 4:3, 16:9 and 21:9, alongside the existing complete-action checks for
fixed limb lengths, cuff attachment, wrist comfort and motion continuity.

Final verification: 207 frontend tests pass, plus 36 Rust tests and the
two-client WebSocket reload-interruption checks. Browser review confirms the
compact hip/ADS framing on all three rifles and connected cuffs during the
Enfield reload (`artifacts/support-enfield-reload-final.png`). The live HUD
shows the fist for melee kills and no active reload label. The server release
passed its health check after deployment to the existing Oregon instance.
