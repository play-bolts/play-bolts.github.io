# AI aiming and fairness

Implemented and evaluated on 2026-10-13. This is a new opponent model for Bolts, not a reconstruction of Call of Duty's original AI. Numerical tuning below is a gameplay design choice, not a measurement of human reaction times or the original game's settings.

## Sources consulted

- [Jiri Holba, Open-world Enemy AI in Mafia III](https://www.gamedeveloper.com/design/open-world-enemy-ai-in-mafia-iii): the game's developer describes vision-cone and visibility checks, recognition that takes time, and shooting styles that control first-shot and subsequent-shot delays independently of tactical decisions. This informed the separation of perception, tactics, and firing readiness.
- [Yoon et al., Modeling Visually-Guided Aim-and-Shoot Behavior in First-Person Shooters, NVIDIA Research](https://research.nvidia.com/publication/2025-04_modeling-visually-guided-aim-and-shoot-behavior-first-person-shoters): the researchers model perception, decision-making, and motor processes separately. This supports treating delayed observations and imperfect motor tracking as distinct mechanisms. Bolts does not implement their fitted research model or claim equivalent validation.
- [Game AI Pro 3, Using Your Combat AI Accuracy to Balance Difficulty](https://www.gameaipro.com/GameAIPro3/GameAIPro3_Chapter33_Using_Your_Combat_AI_Accuracy_to_Balance_Difficulty.pdf): discusses controlling combat pressure through accuracy and timing, including token-based damage control. Bolts uses physical ray hits and does not implement the chapter's hit tokens, guaranteed misses, or damage scheduling.
- [Valve's published Half-Life bot implementation](https://github.com/ValveSoftware/halflife/blob/master/game_shared/bot/bot.cpp): inspected as an example of separate command and higher-level AI update rates. No code was copied.

## Implemented behavior

The old aiming loop read the opponent's current position every frame and rotated directly toward it. Its small angular spread could fit entirely inside a torso at ordinary WaWa distances. Reaction delays applied only to a change in target ID, and a retained target could bypass the view cone. Consequently, reducing bullet accuracy alone would not address tracking or re-peek behavior.

`src/engine.ts` now implements these stages:

1. **Visibility and recognition.** Acquisition requires a living, unprotected target inside range, the view cone, and an unobstructed sight ray. The view cone also applies to previously selected targets. A new target, or the same target returning after more than 0.25 seconds out of sight, starts a fresh recognition delay.
2. **Delayed observation.** Visible target positions are sampled at a jittered interval and delivered after a separate latency. The aiming controller follows the most recent delivered snapshot. It never reads the current target position as its firing solution. Losing sight clears undelivered observations; a remembered position can guide navigation but cannot authorize a shot.
3. **Imperfect motor control.** Yaw and pitch approach the observed aim point with damping and bounded angular speed. Aim is centered on the torso at 65% of stance height. Each acquisition assigns persistent horizontal and vertical error, with slowly changing drift. Its amplitude settles toward a nonzero floor and grows during movement. Error is measured in world metres so shortening the map does not eliminate it. The floor is an error amplitude, not a guaranteed minimum miss distance: some shots can still be accurate.
4. **Trigger discipline.** A bot must finish recognition and align with its perceived, imperfect aim point. After a shot it waits through the same bolt cycle as the player and then an additional jittered hesitation. It does not wait for a ray to intersect the real target before choosing to shoot.
5. **Limited threat information.** Rifle reports provide a location with up to ±1.5 m error on each horizontal axis. Damage while the shooter is unseen provides up to ±2.5 m error, without assigning an exact target or bypassing recognition. Damage also disrupts aim settling.

Shots use the actor's actual yaw, pitch, recoil, and weapon spread. That orientation is recorded for rendering and killcam; there is no separate corrected shooting direction. Bots retain the same ray obstruction, ammunition, bolt cycle, reload, and damage rules. Torso damage remains lethal at normal arena ranges. Cover selection, flanking roles, and A* navigation remain separate from shooting skill.

## Difficulty values

Values are defined in `DIFFICULTIES` in `src/config.ts`. Acquisition times are the random recognition budget after detection, not a guarantee of total time from exposure to firing. Detection scheduling, turning, occlusion, reloading, and aim alignment can add time.

| Setting | Recruit | Regular | Veteran |
| --- | ---: | ---: | ---: |
| Recognition budget | 1.25–1.70 s | 0.85–1.20 s | 0.55–0.85 s |
| Base observation interval | 0.30 s | 0.22 s | 0.16 s |
| Observation delivery latency | 0.20 s | 0.16 s | 0.12 s |
| Maximum yaw speed | 1.4 rad/s | 1.9 rad/s | 2.6 rad/s |
| Tracking response constant | 3 /s | 4 /s | 5 /s |
| Initial horizontal error amplitude | 1.65 m | 1.20 m | 0.85 m |
| Settled error amplitude floor | 1.00 m | 0.72 m | 0.50 m |
| Settling time constant | 2.8 s | 2.4 s | 2.0 s |
| Base hesitation after bolt cycle | 0.65 s | 0.45 s | 0.30 s |
| Base angular bullet spread | 0.032 rad | 0.024 rad | 0.018 rad |
| Awareness range | 20 m | 27 m | 34 m |
| Memory duration | 3 s | 5 s | 7 s |
| Movement multiplier | 0.72 | 0.85 | 0.94 |
| Tactical decision interval | 0.75 s | 0.50 s | 0.32 s |
| Aggression parameter | 0.40 | 0.60 | 0.78 |

Observation intervals vary by ±15%; post-bolt hesitation varies by ±25%. The vertical aim-error scale is 65% of horizontal. Persistent error coefficients lie in [-1, 1]; drift contributes up to an additional 30% before smoothing. Movement can increase amplitude by up to 55% and slows settling. ADS multiplies bullet spread by 0.7. The random angular spread offset on each axis is half the displayed full spread. Tactical decision scheduling adds 0–0.1 seconds to its base interval.

## Seeded evaluation

The isolated comparison used 100 seeds per difficulty and movement condition, six simulated seconds per seed, and 60 updates per second. Seeds are `n * 7919` for `n = 1..100`. One British bot with a Lee–Enfield starts facing a target 14 m away in the clear perimeter lane at `x = ARENA.width / 2 - 1.2`, with shooter `z = -7` and target `z = 7`. The arena uses the revised half-floor-area geometry.

The stationary condition holds the target still. The moving condition uses a triangular side-step pattern 1.1 m wide at 4 m/s. Bot locomotion is disabled and tactical replanning stops after the first update to isolate shooting behavior. The target has a large HP pool, protection is off, and the bot has enough ammunition for the measurement window. Bullet collisions and damage still execute normally. These are controlled hit-rate measurements, not kill rates, full-round balance estimates, or a human playtest.

| Difficulty | Old stationary hits | Old moving hits | New stationary hits | New moving hits | New mean first shot |
| --- | ---: | ---: | ---: | ---: | ---: |
| Recruit | 500 / 500 (100%) | 500 / 500 (100%) | 59 / 300 (19.7%) | 54 / 300 (18.0%) | 1.481 s |
| Regular | 592 / 592 (100%) | 592 / 592 (100%) | 126 / 399 (31.6%) | 121 / 399 (30.3%) | 1.032 s |
| Veteran | 600 / 600 (100%) | 600 / 600 (100%) | 209 / 407 (51.4%) | 148 / 407 (36.4%) | 0.707 s |

The old model's mean first-shot times were 1.004 / 0.512 / 0.249 seconds respectively. The baseline used the pre-change engine from commit `107c31e635f9905b2bbd1d2f9d11978f6e9e0886`, its original difficulty values, and the revised map geometry, so both versions faced the same lane. Baseline execution used temporary copies outside the source tree; the obsolete implementation is not shipped.

These results demonstrate substantially reduced precision in this scenario and that moving disrupts tracking, particularly on Veteran. They do not imply those percentages apply to every distance, stance, weapon, engagement length, cover arrangement, or seed. Persistent aiming errors correlate shots within an engagement. Full-round combat and navigation are checked separately by `tests/engine.test.ts`.

## Reproduction and regression checks

Run the current fairness tests and the full simulation suite:

```sh
node --import tsx --test tests/ai.test.ts
npm test
```

`tests/ai.test.ts` contains the seeded setup and checks fallible accuracy, difficulty progression, delayed observation, recognition on reacquisition, information from damage/hearing, retained-target field of view, physical shot orientation, and post-bolt hesitation. To print current measurement totals from the repository root:

```sh
node --import tsx --input-type=module <<'JS'
import {Game} from './src/engine.ts';
import {ARENA} from './src/config.ts';
for (const difficulty of ['recruit', 'regular', 'veteran']) {
  for (const moving of [false, true]) {
    let shots = 0, hits = 0, firstShotTotal = 0;
    for (let seed = 1; seed <= 100; seed++) {
      const game = new Game();
      game.start('german', difficulty);
      game.seed = seed * 7919;
      for (const actor of game.actors) actor.alive = false;
      const bot = game.actors[1], target = game.player;
      const x = ARENA.width / 2 - 1.2;
      Object.assign(bot, {alive:true, x, y:0, z:-7, yaw:0, pitch:0,
        cooldown:0, spawnSafe:0, ammo:100, reserve:100, hp:1e9});
      Object.assign(target, {alive:true, x, y:0, z:7, spawnSafe:0, hp:1e9});
      game.move = () => {};
      for (let frame = 0; frame < 360; frame++) {
        if (moving) {
          const phase = (frame / 60 * 4 / 1.1) % 2;
          target.x = x + .55 - 1.1 * (phase < 1 ? phase : 2 - phase);
        }
        game.time += 1 / 60;
        bot.cooldown = Math.max(0, bot.cooldown - 1 / 60);
        bot.recoil *= Math.exp(-5 / 60);
        game.updateAI(bot, 1 / 60);
        bot.ai.decision = Infinity;
      }
      shots += bot.shots;
      hits += bot.hits;
      firstShotTotal += game.shots[0]?.time ?? 6;
    }
    console.log({difficulty, moving, shots, hits,
      hitRate: hits / shots, meanFirstShot: firstShotTotal / 100});
  }
}
JS
```
