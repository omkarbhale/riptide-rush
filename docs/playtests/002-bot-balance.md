# Playtest 002: scripted bot balance and bug hunt

Tracked by [#61](https://github.com/omkarbhale/riptide-rush/issues/61). Harness: `tools/bot/run.mjs`. Game design source: [#1](https://github.com/omkarbhale/riptide-rush/issues/1).

This is a headless run of the pure simulation (`src/game.js`) with three scripted policies. It finds bugs by invariant checks at every 120 Hz step, and balance problems by measuring the outcomes. Scripted bots are not people: treat the numbers as a strong hint about the design, and confirm the big ones with a human playtest. Nothing in the game rules was changed for this task.

## How to reproduce

```
node tools/bot/run.mjs                       # 300 seeds per policy, 300 s cap, 6 threads
node tools/bot/run.mjs --runs 50 --policy expert
node tools/bot/run.mjs --json out.json --strict
node --test                                  # harness tests and the existing game tests
```

The full run takes about 17 s wall time on an 8-core WSL2 machine (about 50 s with `--jobs 1`). The seeds are the same for every policy, so the policies are compared on identical maps and wave timings. Every run depends only on its seed and policy, so results do not depend on the thread count.

## Policies

- **Beginner**: moves away from the nearest enemy of any kind, and wall-avoids. Dashes only at a non-mine target within 90 px, with a 2 s minimum gap and a 25% roll per step. Never pulses, by spec.
- **Intermediate**: keeps 90–170 px from the nearest non-mine enemy and sidesteps bullets. Dashes at the nearest enemy within 320 px whenever a charge is ready. Pulses when a spitter bullet is within 110 px and about to arrive in under 0.45 s.
- **Expert**: every 8 steps (about 67 ms) it scores each candidate dash (aimed at each nearby enemy, plus 12 ring directions) by the value of the enemies its swept path kills, and rejects dashes that run into a Shellback's front arc. It fires the best chain when it kills something and a charge is ready. It parks 110 px short of the nearest cluster, or of the nearest mine once only mines are left, dodges bullets and charger lunges, and keeps off armed mines. It pulses when a bullet is inside the 0.12 s perfect window.

Presses are buffered for 120 ms, as the browser input layer does. APM counts accepted dash and pulse events from the sim. Every lost hit point is attributed to a cause: a mine blast, a spitter bullet, or contact with the enemy that touched Rip. Each hit is also bucketed by time since the last dash ended.

Invariant checks at every step: finite numbers, Rip inside the arena, enemies inside their clamp, timers never negative (charger and spitter shot timers are excluded because they only compare against zero), bullets with positive life and in bounds, one hit point lost per hurt event, no hit inside invulnerability or during a dash, score changes only from kills and only by the formula, combo counts and timer resets, event fields present, waves sequential, no wave stalled for more than 120 s, and no wave empty but active.

## Results

300 seeds per policy, 300 s sim cap.

| | Beginner | Intermediate | Expert |
| --- | --- | --- | --- |
| Survival, s (p10 / p50 / p90) | 49 / 65 / 117 | 195 / 300* / 300* | 120 / 192 / 293 |
| Died / survived to cap | 100% / 0% | 37% / 63% | 91% / 9% |
| Wave reached (p50, max) | 2, 4 | 17, 21 | 13, 21 |
| Score (p50) | 555 | 6,405 | 4,988 |
| Peak combo (p50) | 6 | 20 | 20 |
| APM, dashes + pulses / min (p50 per run) | 7.9 | 94.2 | 60.7 |
| Dash kills per dash | 2.34 | 0.57 | 0.94 |
| Dashes that killed at least once | 99.9% | 50.1% | 86.9% |
| Perfect pulses / deflected dashes | 0 / 0 | 18 / 17,894 | 639 / 6,321 |
| Time with no enemy within 250 px | 63% | 69% | 80% |
| Hit points lost (total) | 900 | 547 | 855 |

\* Intermediate: 63% of runs survive to the cap, so its median is the cap.

### Hit points lost, by cause

| Cause (enemy type) | Beginner | Intermediate | Expert |
| --- | --- | --- | --- |
| Drifter (contact) | 15.8% | 54.5% | 26.9% |
| Spitter (bullet) | **84.0%** | 3.7% | 0.7% |
| Charger | 0.2% | 22.5% | 1.3% |
| Shellback | 0.0% | 12.1% | **71.0%** |
| Mine (blast) | 0.0% | 5.7% | 0.0% |
| Splitter / mini | 0.0% | 1.6% | 0.1% |

### Hits per 100 s spent in each time-since-dash bucket

Raw hit counts mislead here, because intermediate spends most of its time right after a dash. Rates are the honest comparison.

| Bucket | Beginner | Intermediate | Expert |
| --- | --- | --- | --- |
| 0–0.2 s after the dash | 8.39 | 1.89 | 0.47 |
| 0.2–0.5 s after the dash | 1.78 | 0.47 | **3.98** |
| Later | 4.50 | 0.21 | 1.01 |

Of the expert's hits, 60% land within 0.5 s of a deflected dash (515 of 855). Only 2% land in the very step a dash ends.

### Waves: death rate and pacing

Death rate is the fraction of runs that reached the wave and died in it.

| Wave (design tag) | Beginner | Intermediate | Expert |
| --- | --- | --- | --- |
| 2 (spitter 1) | **68%** (203 of 300 reached) | 0% | 0% |
| 8 (shellback 2, spitter 2) | — | 2.7% | **31%** |
| 13 (shellback 1) | — | 4.4% | **41%** |
| 14 (charger 2, tagged intensity 7) | — | 0% (cleared in 3.6 s) | 0% (cleared in 3.5 s) |
| 17 (charger 3, shellback 2) | — | 17% | **64%** |
| 20 (shellback 2, charger 2, spitter 2) | — | 9% | 50% |
| Release waves 9 / 11 / 15 / 18 | — | 1.4 / 2.2 / 3.8 / 5.0% | 0.5 / 1.0 / 0 / 0% |

The release waves are doing their job: the expert's death rate there is near zero, against 31–64% on the tension waves. The problem is that the tension waves are dominated by shellbacks.

### Invariant checks

| Code | Result |
| --- | --- |
| NaN, negative timers, combo or score going backwards, event fields missing, multiple hits per step, hits inside invulnerability | none in any run |
| `ENEMY_OUT_OF_ARENA` | intermediate and expert: every run (see bug B2) |
| `WAVE_STALL` | intermediate: 11 of 300 runs stuck on wave 13 with one shellback alive (see balance C6) |

The expert's earlier stall on wave 7 was a bot bug, not a game bug (see "Harness notes" below). After the fix it does not occur.

## Bugs

Each one is a separate GitHub issue with `playtest` (and `bug` where it applies): #81 to #89.

- **B1 ([#81](https://github.com/omkarbhale/riptide-rush/issues/81)), low: reflected bullets kill idle mines.** `reflectedBulletsHitEnemies` in `src/game.js` does not skip mines, although the mine's comment says "Pulse ignores it". A mine 200 px from Rip, outside its 130 px arm range, is killed by a reflected spitter bullet (`kill`, `enemyType: mine`, `cause: reflect`). It did not occur in the bot runs, which is consistent with a rare geometry. Needs a decision: is a reflect kill of a mine intended?
- **B2 ([#82](https://github.com/omkarbhale/riptide-rush/issues/82)), low: spawns and split minis land outside the arena clamp.** `SPAWN.edgeInset` is 40 px, but enemies clamp to `ARENA.inset + radius`. A shellback (r 22) spawns 6 px outside its clamp, and a splitter (r 20) spawns 4 px outside, on the top and bottom walls too. Splitter minis are placed at 0°, 120° and 240° around a splitter pinned to a wall, so they land up to 9.8 px outside (reproduced: a mini at y 696.8 against a limit of 687). The clamp catches it one step later.
- **B3 ([#83](https://github.com/omkarbhale/riptide-rush/issues/83)), medium: soft-lock on idle mines and lone shellbacks.** A wave clears only when every enemy it spawned is dead. Mines never time out, and only arm inside 130 px. Intermediate stalled on wave 13 with one shellback alive for 120+ s in 11 of 300 runs, and nothing forces the fight. A player who does not go to the mine is stuck until the cap.

## Balance problems

- **C1 ([#84](https://github.com/omkarbhale/riptide-rush/issues/84)), high: the first spitter, in wave 2, is a brick wall for a player who never pulses.** 68% of beginners die in wave 2 (73% on the 100-seed sensitivity run), and spitter bullets are 84% of their hit points. Tested: removing the wave 2 spitter takes wave-2 deaths to 0% and median survival from 64 s to 115 s (100 seeds). Changing only the spitter's timing (first shot 1.2 → 2.5 s, interval 2.2 → 3.0 s) did nothing (73%).
- **C2 ([#85](https://github.com/omkarbhale/riptide-rush/issues/85)), high: shellback contact is the expert's main damage, and it lands right after a deflect.** Shellbacks cause 71% of expert hit points, and 60% of expert hits come within 0.5 s of a deflected dash. Its death rate is 31% in wave 8, 41% in wave 13, 64% in wave 17 and 50% in wave 20. The bounce after a deflect is 40 px with 0.1 s of invulnerability, and the shellback keeps coming at 55 px/s. Tested: bounce 0.4 s and 80 px takes expert survive-to-cap from 9% to 21%, cuts shellback's share to 56%, and cuts wave-8 deaths from 31% to 10% (100 seeds). Caveat: a shellback-aware expert still takes 37% of its hits from shellbacks, so contact is hard to avoid even when the player tries.
- **C3 ([#86](https://github.com/omkarbhale/riptide-rush/issues/86)), high: expert APM tops out near 60, against a target of 120+.** APM tracks kills almost one-for-one (191 kills per run, about 58 per minute of survival): dashes rarely chain more than one kill. Tested levers (100 seeds, expert APM): halving every wave's cadence gives 77, but also cuts median survival from 191 s to 144 s, so it is not a clean win. Spawn distance 280 → 180 px gives 61 (no change). Dash distance 210 → 260 px gives 62. Breather 2.5 → 1.5 s gives 66, with mixed survival. No tested lever reaches 120.
- **C4 ([#87](https://github.com/omkarbhale/riptide-rush/issues/87)), medium: spam-dashing beats planning.** Intermediate, which dashes whenever a charge is ready, survives to the cap 63% of the time. The expert, which only dashes for kills, does so 9% of the time. Intermediate's hit rate is 9× higher in the first 0.2 s after a dash than later (1.89 vs 0.21 per 100 s), so the dash endpoint and exit momentum put Rip among drifters. The expert's own weaknesses contribute (it is shellback-blind), but the expert with shellback avoidance still reaches the cap only 28% of the time. A human playtest is needed before acting on this.
- **C5 ([#88](https://github.com/omkarbhale/riptide-rush/issues/88)), medium: wave 14 is trivially skippable despite its intensity 7 tag.** Two chargers, cleared in 3.5–3.6 s median by both intermediate and expert with zero hit points lost. Other tension waves take 10–17 s. Untested suggestion: more chargers, or a second spawn lane.
- **C6 ([#89](https://github.com/omkarbhale/riptide-rush/issues/89)), medium: wave 17 is the hardest wave for any policy that reaches it.** The expert dies there 64% of the time, intermediate 17%. Wave 17 is 3 chargers and 2 shellbacks, and the shellbacks are the threat (C2). Reducing the chargers from 3 to 2 changes nothing (55.6% → 55.6% on the fixed expert, 100 seeds). The fix is the shellback bounce from C2, which lowers wave 17 to 46% in the test.

## Ranked tuning recommendations

Ranked by expected effect on the design goals. Numbers are from the 100-seed sensitivity runs (seeds 1–100, with the baseline re-run on the same seeds). Only the first two are backed by a test that moved the target; the rest are untested.

1. **Bounce: `DASH.bounceTime` 0.1 → 0.4 s and `DASH.bounceDistance` 40 → 80 px.** Tested: expert survive-to-cap 9% → 21%, median survival 191 → 240 s, shellback share of hits 70% → 56%, wave 8 death 31% → 10%, wave 13 48% → 25%, wave 17 56% → 46%. It also fixes the post-deflect spike from C2.
2. **Remove the spitter from wave 2 (`WAVE_TABLE[1].counts.spitter` 1 → 0).** Tested: beginner wave-2 death 73% → 0%, median survival 64 → 115 s (inside the 60–120 s design window), median wave 2 → 4. Untested alternative: move the spitter to wave 3, which is a release wave.
3. **Stall timer (B3): after 20 s with only idle mines or one shellback left, arm the mines or let the last enemy home in.** Untested; it removes a soft-lock.
4. **Post-dash safety: add roughly 0.1 s of invulnerability after the last dash step, or push enemies off the dash endpoint.** Untested. Targets the 0–0.2 s spike in C4 (1.89 hits per 100 s for intermediate, 8.39 for beginner).
5. **Wave 14: raise the chargers from 2 to 4 (or cut its intensity tag to match).** Untested. Targets C5.
6. **Keep cadence as it is.** Halving the cadence raises expert APM to 77, but median survival falls from 191 to 144 s. Only revisit it together with item 1.

Rejected for now (tested, no effect on the design goals): spawn minimum distance 280 → 180 px (survive-to-cap 9% → 7%, APM flat); dash distance 210 → 260 px (APM 61.7, survive-to-cap 8%); wave 17 chargers 3 → 2 (no change).

The 120 APM target is not reached by any tested lever. Reaching it probably needs dashes that kill more than one enemy on average, which means denser clusters or a rethink of the one-kill-per-dash gate. That is a design call for the captain.

## Browser checks

Two real-browser runs through `chrome-devtools-axi`, served from the worktree with `python3 -m http.server` on 127.0.0.1:8437 (the server was stopped afterwards by its own PID).

- **Run 1.** Loaded `index.html`, then pressed Space, WASD, Shift and Space while playing. The screenshot shows the HUD, wave 1, drifters with spawn warnings, three dash charges and the pulse ring. Console: no messages and no errors.
- **Run 2.** Fresh load, then arrow keys, Enter, Space and Shift. The run ended in wave 1 on the game-over screen, which exercises the death and restart path. Console: no messages and no errors. The "GAME OVER" subtitle overlaps the "WRECKED" title in this screenshot, which is already tracked as #77.

## Harness notes and limits

- **Caught and fixed in the harness, not the game:** the expert's cluster target was the centroid of the nearest two mines, which sat in empty space at opposite corners, so it oscillated and never reached either. This produced a false WAVE_STALL in 4 of 300 expert runs and inflated the expert's survive-to-cap to 32%. The corrected figure is 9%.
- **Known and not re-filed:** [#58](https://github.com/omkarbhale/riptide-rush/issues/58) (combo tier thresholds and perfect-pulse slow-mo applied twice) is outside this task's scope.
- **Benign, not filed:** charger `cooldown` and spitter `shotCd` can run below zero. Both are only compared with zero, so they have no effect.
- **Limits:** the policies are scripts, not people. The expert's APM ceiling is partly its planner, and its shellback blindness inflates C2 (the avoidance variant was 28% survive-to-cap, against 9% for the baseline). Sensitivity runs mutate the config objects in-process and do not change the repo.
