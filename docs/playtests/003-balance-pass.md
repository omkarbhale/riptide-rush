# Playtest 003: balance pass (schools, pressure, the ramp)

Tracked by [#97](https://github.com/omkarbhale/riptide-rush/issues/97). Follows [playtest 002](002-bot-balance.md). Design source: [DESIGN.md §7.4](../DESIGN.md). Harness: `tools/bot/run.mjs`.

This pass changed the game to fix the three problems in playtest 002: the field was too sparse for multi-kill dashes, nothing pressured a competent player, and a deflect off a Shellback was a trap. It also changed the bots. Read the "Harness changes" section before comparing numbers.

## How to reproduce

```
node tools/bot/run.mjs            # 300 seeds per policy, 300 s cap; prints the metrics and the targets table
node tools/bot/run.mjs --runs 60  # quick check
node --test                       # 203 tests, about 1.5 s
```

## Result against the targets

Measured with 300 seeds per policy on the final build (`origin/main` merged in, 2026-11-14). Full output: `tools/bot/run.mjs`.

| Policy | Measure | Before (002) | After (003) | Target | Holds |
| --- | --- | --- | --- | --- | --- |
| Beginner | median survival | 102 s | 106 s | 75–120 s | yes |
| Beginner | worst wave death rate (waves reached by 30+ runs) | 99% (wave 4) | 76% (wave 9) | ≤ 40% | **no** |
| Beginner | largest single-type share of HP lost | 95% (spitter) | 83% (spitter) | ≤ 60% | **no** |
| Intermediate | median survival | 300 s | 224 s | 150–270 s | yes |
| Intermediate | share reaching the 300 s cap | 100% | 25% | < 15% | **no** |
| Expert | median survival | 285 s | 266 s | ≥ 240 s | yes |
| Expert | median APM (dashes + pulses / min) | 60 | 81 | ≥ 110 | **no** |
| Expert | average dash kills per dash | 0.91 | 2.22 | ≥ 1.8 | yes |
| Every policy | invariant violations | beginner 2, intermediate 4, expert 3 (see below) | 0 | 0 | yes |
| Every policy | runs with a stalled wave | intermediate 25 | 0 | 0 | yes |

Four targets are not met. They are listed under "What blocks the rest" with the best numbers and the cause.

### Per-policy metrics

| | Beginner before | Beginner after | Intermediate before | Intermediate after | Expert before | Expert after |
| --- | --- | --- | --- | --- | --- | --- |
| Survival p10 / p50 / p90, s | 66 / 102 / 137 | 83 / 106 / 139 | 300 / 300 / 300 | 137 / 224 / 300 | 122 / 285 / 300 | 163 / 266 / 300 |
| Died / reached the cap | 99% / 1% | 100% / 0% | 0% / 100% | 75% / 25% | 56% / 44% | 62% / 38% |
| Wave reached, median | 4 | 7 | 20 | 25 | 17 | 28 |
| APM p50 | 7.5 | 8.4 | 88 | 76 | 60 | 81 |
| Dash kills per dash | 2.56 | 7.54 | 0.59 | 2.19 | 0.91 | 2.22 |
| Dashes that deflected (total) | 0 | 62 | 23,741 | 9,198 | 13,428 | 1,834 |
| HP lost, total (300 runs) | 1,125 | 1,026 | 144 | 1,512 | 1,247 | 1,504 |
| HP lost to Spitter bullets | 95% | 83% | 1% | — | 0% | — |
| HP lost within 0.5 s of a deflected dash | 0% | 0.7% | 53% | 23.5% | 63% | 0.1% |

The deflect-related rows show the Shellback change. Expert damage used to come right after a deflected dash (63% within 0.5 s). Now it is almost all from ordinary contact, and the expert deflects 1,834 times in 300 runs, down from 13,428.

## What changed

- **Schools (#97 item 1).** Drifters spawn in formation schools of 4–8 (a line, a wedge or a ring), which swim together and break formation within 120 px of Rip. The school cap grows from 4 at wave 1 to 8 from wave 17. Raised counts and spawn cadence (school every 0.5–0.7 s; the 200-entity cap is unchanged).
- **Overlapping waves (#97 item 2, #83).** A non-release wave hands over to the next at 15% of its count or after 14 s. Release waves (3, 5, 9, 11, 15, 18) keep their 2.5 s breather, and cannot run longer than 24 s. A lone enemy turns aggressive after 8 s. An idle mine arms itself after 12 s.
- **Pressure (#97 item 3).** Speed grows 3.5% per wave with no cap. Waves past 20 are budgeted at 60 + 9k with no cap, weighted to Spitters, Chargers and Shellbacks. Sustain was reined in (#87): heal orbs at 0.5% per kill while hurt, with pity at 150 kills; no tier-up heal guarantee; no heal for a flawless wave; modifiers at 1.5% per kill (pity 90), with shorter durations (Spark Coral 5 s, Frenzy 4 s at 2×, Shield Scale 5 s, Undertow 4 s, Riptide Coal 5 s).
- **Beginner ramp (#97 item 4, #84).** Early Spitter bullets are 150 px/s and gain 6 px/s per wave (to 260). The first shot waits 2.0 s. The first Spitter waits for the Drifter schools to be cleared, with a 12 s cap on the wait. One-time hints fire on the first Spitter wind-up and the first Shellback.
- **Deflect (#97 item 5, #85).** A deflect bounces Rip 80 px back over 0.4 s, invulnerable, and refunds the charge.
- **Fixes.** Spawns and minis are clamped to the arena (#82). Wave 14 has four Chargers (#88). Combo tiers are 10/20/30/40 (#58, tiers only; see below).

## Harness changes

The bots and the checks changed in this pass, so the before and after numbers are not a like-for-like comparison of the game alone.

- **Intermediate (fair human).** It reacts 200 ms after a target or bullet comes into view, its dash aim is off by up to 4°, it dashes at most every 0.25 s, and it does not pick a Shellback whose front faces Rip as a target.
- **Expert.** It plans with the sim's own `planDash`, so lunge reach counts, and it values pickups on the dash path. It tests a Shellback deflect with the sim's first-touch rule, not an approximation. Before this fix it deflected on 47% of its dashes, which made its kill rate look far lower than it is. It keeps 80 px from Shellbacks, and aims at school centroids.
- **Buffered dashes** keep the aim they were pressed with, as the browser input does. Before, a buffered dash could fire along Rip's facing.
- **Invariants.** `spitWindup`, `chargerTelegraph` and `chargerLunge` are known events (they were flagged as unknown). Perfect-pulse points count toward the score check (they were flagged as unexplained). `WAVE_STALL` now means the newest wave has not cleared or handed over within 120 s. A leftover older wave is an observation, `WAVE_OLD_OVER_120S`.
- **Report.** A targets table is printed at the end of each run. The worst single-wave death rate only counts waves reached by 30 or more runs; one run reaching a wave tells nothing about it.

The baseline's invariant violations were partly harness false positives (`UNKNOWN_EVENT` for `spitWindup`, `SCORE_CHANGE_NOT_FROM_KILLS` for perfect pulses) and partly real bugs (`ENEMY_OUT_OF_ARENA` is #82; `WAVE_STALL` is #83). The real ones are fixed.

## What blocks the rest

**Beginner: the wave-9 wall and the spitter share.** The beginner never pulses or dodges bullets, so Spitter bullets are the only ranged damage it meets. Spitters it cannot reach stay alive into the next waves. Wave 9 is a release wave: it waits for a clear, so the wall is the first release wave after the wave-8 Spitters. Ways to fix this are a beginner that sidesteps bullets (which would change the bot's character), or spreading ranged threats over more early waves. I did not pick either without a playtest.

**Intermediate: 25% still reach the cap.** The median is in target (224 s). Survivors past wave 28 are the tail. The pressure that rises with the wave is real but the late hazard is still low: the intermediate takes about 5 hits per run and recovers from them. Raising the beyond-20 budget further did not move the cap share much. The lever left is hazard in waves 21–30 itself, which I did not tune further.

**Expert APM: 81 against 110.** The expert dashes only when a planned path kills something, and its APM tracks how many enemies are within reach at once. Schools clear quickly, so about 10 enemies are alive at a time. Faster cadence (×0.5) raised APM only to about 90 and pushed the intermediate's cap share back up. A wider planning reach did not change it. Reaching 110 probably needs a larger on-screen density, or a design decision that rewards repositioning dashes; I did not add dashes that kill nothing, because that would inflate APM without a game reason.

Targets that are met (survival medians, kills per dash, zero violations, zero stalls) were not tuned against the brief's numbers by bending the bots or the checks. Heal and modifier rates were the lever that moved survival most, and they are now reduced to match #87.

## Browser check

Served the worktree with `python3 -m http.server` on 127.0.0.1:8613 and drove it with `chrome-devtools-axi`. The menu started a run. The screenshot after a few seconds shows a Drifter school of four in formation beside Rip. It is attached to the PR's comment, not committed. The console had no messages and no errors. I stopped the server by its own PID and stopped the browser session.

## Issues

- **Fixed in this PR:** #82, #83, #88. #58 is half-fixed (see below).
- **Not closed, mechanic in place, outcome not met:** #84 (ramp in, wall still there), #85 (bounce in, expert damage now from contact), #86 (APM 81 against 110), #87 (sustain reined in; intermediate cap share is 25%).
- **#58, second half.** The sim applies its own perfect-pulse slow-motion (`PULSE.slowmoScale`), and `src/fx.js` applies a second one on the same pulse (`perfectPulse` preset, `slowmo: [0.3, 220]`), so enemies run at about 0.3 × 0.3 for about 200 ms. Both live outside this task's files, so I did not change them. Filed as a follow-up for the effects owner.
