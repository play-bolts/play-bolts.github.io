# Combat reference — 13 October 2026

## Evidence

- [Activision's original Call of Duty manual](https://cdn.cloudflare.steamstatic.com/steam/apps/2620/manuals/COD.pdf), printed pages 12–13 and 22: number keys select inventory slots, wheel moves through inventory, and Stielhandgranate mobility is faster than rifles. The manual does not publish numerical damage or animation timing. Bolts deliberately maps the grenade to **2**, as requested, rather than the original grenade key **4**.
- [Robert Bloom / DeathZero II's 2005 weapon-file investigation](https://gamefaqs.gamespot.com/pc/920122-call-of-duty-united-offensive/faqs/32843), introduction, damage modifiers, and rifle entries: the author describes directly extracting the game's PK3 weapon data. It reports 120 base damage for bolt rifles in both CoD1 and UO; shared multipliers are head/neck 1.5, upper torso .9, lower torso .8, upper limbs .6, lower limbs .5, extremities .4. The listed rifle melee damage is 150. This is firsthand community analysis, not an official engine specification.

## Implementation

- All three rifles now apply 180/108/96/72/60/48 damage to those six regions. Head hits are explicitly lethal. The previous arbitrary damage reduction after 45 m was removed. Health remains 100, with no automatic regeneration.
- Hit volumes are still simplified, stance-scaled body sections rather than original CoD skeletal collision volumes. Head position follows lateral lean. Arms are not separately traced; the limb bands currently represent legs. This distinction must not be advertised as an exact copy of CoD1's damage engine.
- Switching has a shared 0.6 s simulation/animation interval. Reload cancellation transfers no ammunition. Rifle bolt cooldown continues across switches. ADS is unavailable when airborne, switching, or holding the grenade.
- The Stielhandgranate is a movement-only item, per the user's clarification: no throwing, ammunition, projectiles, or blast damage. Holding it grants an 8% movement bonus once equipped; the exact multiplier is a Bolts tuning choice.
- Weapon selection and incoming death direction are stored in immutable killcam snapshots. Kill events distinguish rifle and melee attacks.
- Rifle recoil rises by another 35%, as requested. This is a deliberate preference adjustment rather than a claim of recovered CoD1 recoil constants.

## Verification

Behavior tests cover menu/pause/end weapon-action guards, switch/attack locks, reload conservation, movement bonus, grenade attack no-ops, regional damage, airborne ADS, and replay immutability. Existing seeded AI fairness tests still require misses at every level, increasing difficulty, and reduced accuracy against strafing.
