# Cover and flank survival

Implemented on 2026-10-16 for local **Regular** and **Veteran**. Recruit retains its previous behavior. Multiplayer bots use a separate Rust implementation with a fixed preset; this change does not alter them.

## Behavior

`src/aiSurvival.ts` manages seeking cover, holding, peeking and withdrawing. `src/aiCover.ts` evaluates cover and reachable firing positions. `src/engine.ts` supplies sensory cues and executes movement, aiming and physical shots.

- Keep an already protected position instead of choosing a new destination on every decision. Crouch when the obstacle protects the head and torso at crouch height, and stay sheltered during reloads.
- Seek protection when wounded, suppressed, low on ammunition or exposed for too long. Empty rifles can wait for shelter before reloading, with a 3.5-second fallback so an obstructed route cannot prevent reloading indefinitely.
- Step to a reachable firing position, face its planned firing lane, fire, and return to cover for recovery. Routine search scans do not interrupt an active peek. After two unsuccessful peeks, an unpressured bot leaves shelter to investigate; prolonged holds also trigger relocation.
- Prefer routes with less exposure and reject positions vulnerable to remembered crossfire. Cover checks include the head and shoulder width, not just one eye ray.
- Remember up to three independent threats. Delivered visual observations are snapshots; rifle reports and unseen damage retain their existing location uncertainty. Threats expire after the difficulty's normal memory interval. No hidden actor positions are read by the planner.
- Check side and rear directions while searching, recovering or reacting to pressure. Turning remains bounded by the existing motor limit; scanning cannot authorize firing. Impossible noisy positions inside solid obstacles remain directional cues but are excluded from cover scoring.

Recognition delays, visual observation latency, aim error, bullet spread, turn speed, damage and weapon timing are unchanged. Their design is described in [AI aiming and fairness](ai-fairness.md).

## Tactical tuning

These are gameplay choices, not measurements of the original game's AI. Planning and scans also wait for the ordinary difficulty decision interval.

| Setting | Regular | Veteran |
| --- | ---: | ---: |
| Minimum cover replan interval | 1.25 s | 0.90 s |
| Base protected recovery | 0.85 s | 0.65 s |
| Firing window after reaching a peek | 3.30 s | 3.00 s |
| Base flank-check interval | 4.20 s | 2.80 s |
| Flank-check duration | 0.80 s | 1.00 s |
| Wounded cover threshold | 65 HP | 80 HP |
| Exposed engagement threshold | 4.50 s | 3.80 s |
| Relocate after prolonged safe hold | 9 s | 7 s |

Per-bot offsets stagger planning and scanning. The planner evaluates geometry first and runs at most three risk-aware A* searches per plan; it does not run a path search every frame. Ordinary navigation and Recruit's path costs are unchanged.

## Validation

Run `npm test` and `npm run build`. The survival and cover suites exercise sheltered reloads, empty-magazine timing, withdrawal after a peek, compromised-cover replacement, gradual rear attention, expiring snapshots, impossible sound cues, body clearance, reachable peeks, route safety and empty-ammunition melee fallback. Existing aiming and full-round simulation tests still cover shooting fairness and combat progression.

A controlled comparison against commit `73a69cb` used the same bot crouched at `(-8, 0, 2)`, a remembered threat at `(0, 1.65, 2)`, and the first two seconds of a three-second reload. Before the change, Regular walked 7.36 m and Veteran 8.07 m; both exposed their head sight line for 1.98 seconds. Both updated bots stayed crouched at the protected origin with zero exposure in that interval. This demonstrates a specific shelter-retention fix, not a measured full-round survival or win-rate increase.

In a separate stationary-listener check, rear gunfire caused a bounded turn of 43.5° on Regular and 59.6° on Veteran over 0.4 seconds, compared with 17.4° previously. Neither version acquired the hidden shooter or fired in that interval. Three seeded 30-second Recruit replays (42, 7919, 981123) matched the prior implementation exactly.

Ten five-minute spectator simulations (five seeds per skilled difficulty, five bots per round) checked that cover does not starve combat. Final Regular rounds produced 126–139 shots and 5–8 kills; Veteran produced 122–143 shots and 6–8 kills. Every bot fired 16–36 shots, no stationary episode exceeded 16.1 seconds, and continuous protected holds stayed below 3.3 seconds. This is substantially more cautious pacing than the prior implementation, whose mean shot totals were 506 / 576 and mean kills 25 / 36 for Regular / Veteran. It is not a human difficulty or balance measurement. Early tuning was too passive; the final version lets healthy bots sustain exchanges and sends bots investigating after repeated empty peeks.

Cover remains a geometric approximation with short-lived sensory memory. Bots do not coordinate as a team in this free-for-all, and actor collisions can require replanning when two bots approach the same shelter. Browser observation checks rendering and live progression; the controlled tests provide the repeatable behavioral evidence.
