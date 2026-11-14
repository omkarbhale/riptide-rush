# Playtest 002: scripted bot balance and bug hunt

Tracked by [#61](https://github.com/omkarbhale/riptide-rush/issues/61). Harness: `tools/bot/run.mjs`. Game design source: [#1](https://github.com/omkarbhale/riptide-rush/issues/1).

This report describes the game as merged with `origin/main` (dash fairness, pickups and modifiers, and the audio/visual audit). The earlier run on the pre-merge game is superseded; its numbers are not used here.

This is a headless run of the pure simulation (`src/game.js`) with three scripted policies. It finds bugs with invariant checks at every 120 Hz step, and balance problems by measuring outcomes. Scripted bots are not people: treat the numbers as a strong hint about the design, and confirm the large ones with a human playtest. No game rules were changed for this task.

## How to reproduce

```
node tools/bot/run.mjs                       # 300 seeds per policy, 300 s cap, 6 threads
node tools/bot/run.mjs --runs 50 --policy expert
node tools/bot/run.mjs --json out.json --strict
node --test                                  # harness tests and the existing game tests
```

A full run takes about 17–33 s wall time on an 8-core WSL2 machine, depending on load. Seeds are the same for every policy, so policies are compared on identical maps and wave timings. Each run depends only on its seed and policy, so results do not depend on the thread count.

## Policies

- **Beginner**: moves away from the nearest enemy of any kind, and wall-avoids. Dashes only at a non-mine target within 90 px, with a 2 s minimum gap and a 25% roll per step. Never pulses, by spec.
- **Intermediate**: keeps 90–170 px from the nearest non-mine enemy and sidesteps bullets. Dashes at the nearest enemy within 320 px whenever a charge is ready. Pulses when a spitter bullet is within 110 px and about to arrive in under 0.45 s.
- **Expert**: every 8 steps (about 67 ms) it scores each candidate dash (aimed at each nearby enemy, plus 12 ring directions) by the value of the enemies its swept path kills, and rejects dashes that run into a Shellback's front arc. It fires the best chain when it kills something and a charge is ready. It parks 110 px short of the nearest cluster, or of the nearest mine once only mines are left, dodges bullets and charger lunges, and keeps off armed mines. It pulses when a bullet is inside the 0.12 s perfect window.

Presses are buffered for 120 ms, as the browser input layer does. APM counts accepted dash and pulse events from the sim. Every lost hit point is attributed to a cause: a mine blast, a spitter bullet, or the enemy that touched Rip. Each hit is bucketed by time since the last dash ended, and the time spent in each bucket is recorded so hit counts can be read as rates.

Known simplification: the expert plans dash endpoints at the base `DASH.distance`, but lunge assist and Frenzy can extend a dash. The expert therefore under-counts reach slightly, and the harness does not model pickups as targets.

### Invariant checks

Checked after every step:

- Numbers are finite; Rip stays inside the arena; enemies stay inside their clamp.
- Timers never go negative. Charger cooldown and spitter shot timers are excluded because they are only compared with zero.
- **Dash:** `0 ≤ t ≤ dur`, using each dash's own `dur`. Lunge assist and Frenzy make a dash longer than `DASH.duration`, so the bound is the dash's own duration, not the constant.
- **Charges:** between 0 and `dashMaxCharges(game)`, which is 4 while Spark Coral is active.
- **Score:** changes only by kill points, plus 5 per `bulletCut` event, plus the `bonus` on `heal` events. A heal bonus is only valid at full HP.
- **HP:** the step's `hurt` and `heal` events are replayed in order. A heal without a bonus restores `PICKUP.heal.restore`.
- Kill points and combo follow the formula. Hits never land inside invulnerability or during a dash. Event fields are present. Waves run in sequence, with no wave stalled for more than 120 s and no wave empty but active.

## Results

300 seeds per policy, 300 s sim cap, merged game.

| | Beginner | Intermediate | Expert |
| --- | --- | --- | --- |
| Survival, s (p10 / p50 / p90) | 66 / 102 / 137 | 300 / 300 / 300 | 122 / 285 / 300 |
| Died / survived to cap | 99.3% / 0.7% | 0% / 100% | 56% / 44% |
| Wave reached (p50, max) | 4, 7 | 20, 21 | 17, 21 |
| Score (p50) | 1,650 | 18,785 | 16,030 |
| Peak combo (p50) | 7 | 22 | 20 |
| APM, dashes + pulses / min (p50 per run) | 7.5 | 87.6 | 60.4 |
| Dashes per run / pulses per run | 13.0 / 0.0 | 434 / 2.9 | 238 / 1.3 |
| Dash kills per dash | 2.56 | 0.59 | 0.91 |
| Dashes that killed at least once | 99.9% | 50.6% | 79.3% |
| Perfect pulses / deflected dashes | 0 / 0 | 2 / 23,741 | 402 / 13,428 |
| Time with no enemy within 250 px | 65% | 69% | 76% |
| Hit points lost (total, 300 runs) | 1,125 | 144 | 1,247 |

### Hit points lost, by cause

| Cause (enemy type) | Beginner | Intermediate | Expert |
| --- | --- | --- | --- |
| Drifter (contact) | 4.4% | 8.3% | 34.8% |
| Spitter (bullet) | **95.1%** | 0.7% | 0.0% |
| Charger | 0.4% | **62.5%** | 0.7% |
| Shellback | 0.0% | 22.9% | **64.4%** |
| Mine (blast) | 0.0% | 5.6% | 0.0% |
| Splitter / mini | 0.0% | 0.0% | 0.1% |

### Hits per 100 s spent in each time-since-dash bucket

The fairness change targeted this table. Compared with the pre-merge game:

| Bucket | Beginner | Intermediate | Expert | Pre-merge expert |
| --- | --- | --- | --- | --- |
| 0–0.2 s after the dash | 0.00 | **0.08** (was 1.89) | 0.16 (was 0.47) | 0.47 |
| 0.2–0.5 s after the dash | 0.51 | 0.23 (was 0.47) | **3.91** (unchanged) | 3.98 |
| Later | 4.24 | 0.17 (was 0.21) | 1.61 | 1.01 |

The post-dash spike that dominated intermediate's damage is gone. The 0.2–0.5 s window after a deflected dash is still the expert's main damage window: 63% of its hits (787 of 1,247) land within 0.5 s of a deflected dash.

### Waves: death rate and pacing

Death rate is the fraction of runs that reached the wave and died in it.

| Wave (design tag) | Beginner | Intermediate | Expert |
| --- | --- | --- | --- |
| 2 (spitter 1) | 48% | 0% | 0% |
| 4 (spitter 2, charger 1) | **99%** (153 of 155 reached) | 0% | 0% |
| 8 (shellback 2, spitter 2) | — | 0% | **26%** |
| 13 (shellback 1) | — | 0% | 15% |
| 14 (charger 2, tagged intensity 7) | — | 0% (cleared in 3.5 s, p50) | 0% (cleared in 3.6 s, p50) |
| 17 (charger 3, shellback 2) | — | 0% | 15% |
| 20 (shellback 2, charger 2, spitter 2) | — | 0% | **20%** |
| Release waves 9 / 11 / 15 / 18 | — | 0 / 0 / 0 / 0% | 0 / 1 / 0 / 0% |

Intermediate has 0% death on every wave. Its runs stop at the 300 s cap around wave 20, so these numbers say nothing about waves past 21. The release waves are near-zero death for both policies that survive long enough to see them. The expert's tension waves (8, 13, 17, 20) carry all of its deaths.

### Invariant checks

| Code | Result |
| --- | --- |
| NaN, negative timers, combo or score going backwards, unexplained score, unexplained HP change, missing event fields, dash `t` outside its own `dur`, charges over cap, multiple hits per step | none in any run |
| `ENEMY_OUT_OF_ARENA` | intermediate and expert: every run; beginner: 2 runs (see B2) |
| `WAVE_STALL` | intermediate: 25 of 300 runs stuck on wave 8 with one shellback alive (see B3) |

`DASH_T_RANGE` (reported by CI on the pre-merge branch) was an outdated assumption in the harness. It compared a dash's `t` with the constant `DASH.duration`, but each dash now carries its own `dur`. The invariant now checks `0 ≤ t ≤ dur` for each dash. It holds on every step of every run.

## Bugs

Each one is a separate GitHub issue with `playtest` (and `bug` where it applies).

- **B1 ([#81](https://github.com/omkarbhale/riptide-rush/issues/81)), low: reflected bullets kill idle mines.** `reflectedBulletsHitEnemies` in `src/game.js` does not skip mines, although the mine's comment says "Pulse ignores it". Re-verified on the merged game: a mine 200 px from Rip, outside its 130 px arm range, is killed by a reflected spitter bullet (`kill`, `enemyType: mine`, `cause: reflect`). It did not occur in the bot runs.
- **B2 ([#82](https://github.com/omkarbhale/riptide-rush/issues/82)), low: spawns and split minis land outside the arena clamp.** `SPAWN.edgeInset` is 40 px, but enemies clamp to `ARENA.inset + radius`. A shellback (r 22) spawns 6 px outside its clamp; a splitter (r 20) spawns 4 px outside, on the top and bottom walls too. Re-verified on the merged game. Splitter minis land up to 9.8 px outside when a splitter is pinned to a wall. Harness: `ENEMY_OUT_OF_ARENA` in every intermediate and expert run.
- **B3 ([#83](https://github.com/omkarbhale/riptide-rush/issues/83)), medium: soft-lock on idle mines and lone shellbacks.** A wave clears only when every enemy it spawned is dead. Mines never time out. On the merged game intermediate stalls on wave 8 with one shellback alive for 120+ s in 25 of 300 runs. Nothing forces the fight.

## Balance problems

- **C1 ([#84](https://github.com/omkarbhale/riptide-rush/issues/84)), high: the beginner's brick wall is wave 4, with wave 2 close behind.** A player who never pulses dies in wave 4 in 99% of runs that reach it, and in wave 2 in 48% of all runs. Spitter bullets are 95% of beginner hit points. Beginner median survival is 102 s, inside the 60–120 s target, but the failure is concentrated in two waves. Tested on 100 seeds: removing the wave 2 spitter takes wave-2 deaths to 0% (median survival 102 → 126 s). Removing the two wave 4 spitters takes median survival to 272 s and survive-to-cap to 50%, which overshoots the target. Reducing wave 4 to one spitter changes nothing (103 s). No tested setting moves the wave-4 wall inside the target, so this needs a finer lever.
- **C2 ([#85](https://github.com/omkarbhale/riptide-rush/issues/85)), high: shellback contact is the expert's main damage, and it lands right after a deflect.** Shellbacks cause 64% of expert hit points, and 63% of expert hits land within 0.5 s of a deflected dash. The expert's death waves are 8 (26%), 13 (15%), 17 (15%) and 20 (20%), all shellback waves. The bounce after a deflect is 40 px with 0.1 s of invulnerability. Tested on 100 seeds: bounce 0.4 s and 80 px takes expert survive-to-cap from 45% to 80%, and wave-8 deaths from 25% to 3%. It does not reduce the shellback share (65% → 68%), so the damage moves rather than disappears. A shellback-aware expert reaches the cap 82% of the time.
- **C3 ([#86](https://github.com/omkarbhale/riptide-rush/issues/86)), high: expert APM tops out near 60, against a target of 120+.** APM tracks kills almost one-for-one (about 0.9 kills per dash). Tested on 100 seeds, expert APM at the median: baseline 60.8. Halving every wave's cadence gives 73.2, with survive-to-cap 45% → 50%. Dash distance 210 → 260 px gives 62.0. Breather 2.5 → 1.5 s gives 65.1. Spawn minimum distance 280 → 180 px gives 60.2. No tested lever reaches 120.
- **C4 ([#87](https://github.com/omkarbhale/riptide-rush/issues/87)), medium: intermediate is effectively invulnerable on the merged game.** On the pre-merge game the question was spam-dashing beating planning, and the post-dash spike that drove it is gone. Now intermediate survives 300/300 runs to the 300 s cap, with 144 hit points lost in total across all runs, and it reaches wave 20 at the median. The sim currently gives a dash-spamming player no meaningful difficulty. Heal orbs, Spark Coral and Frenzy are the likely contributors, but this is untested. The expert, which dashes only for kills, dies in 56% of runs, so the policies no longer order as skill suggests.
- **C5 ([#88](https://github.com/omkarbhale/riptide-rush/issues/88)), medium: wave 14 is trivially skippable despite its intensity 7 tag.** Two chargers, cleared in 3.5 s (intermediate) and 3.6 s (expert) median, with 0 hit points lost. Other tension waves take 10–17 s. Unchanged by the merge.
- **C6 ([#89](https://github.com/omkarbhale/riptide-rush/issues/89)): withdrawn.** On the pre-merge game wave 17 was the expert's worst wave (64% deaths). On the merged game the expert's wave-17 death rate is 15%, the same range as wave 13. The issue is closed because it no longer describes the game.

## Ranked tuning recommendations

Ranked by expected effect on the design goals. Numbers are from 100-seed sensitivity runs on the merged game (seeds 1–100, with the baseline re-run on the same seeds). Only items 1 and 2 are backed by a test that moved a target; the rest are untested or marked as small.

1. **Bounce: `DASH.bounceTime` 0.1 → 0.4 s and `DASH.bounceDistance` 40 → 80 px.** Tested: expert survive-to-cap 45% → 80%, wave-8 death 25% → 3%, wave-13 death 15% → 3%, wave-17 death 16% → 14%. It leaves the shellback share unchanged, so pair it with a check on shellback contact.
2. **Beginner wave 4: the two spitters are the lever, but not the right one yet.** Removing both gives median survival 272 s, which overshoots 60–120 s. Reducing to one gives 103 s, which changes nothing. Untested next step: spitter fire interval or first-shot delay in wave 4 only.
3. **Intermediate's difficulty (C4): design review before tuning.** Survive-to-cap 100% and 144 hit points in 300 runs suggests the mid-tier player has no pressure. Untested candidates: heal drop rate, Spark Coral or Frenzy duration, or a wave-scaled dash cost.
4. **Stall timer (B3): after about 20 s with only idle mines or one shellback left, arm the mines or let the last enemy home in.** Untested. It removes a soft-lock.
5. **Wave 14: raise the chargers from 2 to 4 (or cut the intensity tag to match).** Untested. Targets C5.
6. **Cadence and dash distance: small effects, not yet confirmed.** Cadence ×0.5 raises APM to 73 with no survival loss, and dash distance 260 raises survive-to-cap to 54%. Both are within about 10 points of noise at 100 seeds, so confirm at 300 seeds before changing config.

Rejected for now: spawn minimum distance 280 → 180 px (survive-to-cap 45% → 55%, APM flat; within noise at 100 seeds).

The 120 APM target is not reached by any tested lever. Reaching it probably needs dashes that kill more than one enemy on average, which means denser clusters or a rethink of the one-kill-per-dash gate. That is a design call.

## Browser checks

Two real-browser runs through `chrome-devtools-axi`, served from the worktree with `python3 -m http.server` on 127.0.0.1:8437 (the server was stopped afterwards by its own PID). These runs were on the pre-merge branch; they are not repeated on the merged game in this pass.

- **Run 1.** Loaded `index.html`, then pressed Space, WASD, Shift and Space while playing. The screenshot shows the HUD, wave 1, drifters with spawn warnings, three dash charges and the pulse ring. Console: no messages and no errors.
- **Run 2.** Fresh load, then arrow keys, Enter, Space and Shift. The run ended in wave 1 on the game-over screen, which exercises the death and restart path. Console: no messages and no errors. The "GAME OVER" subtitle overlaps the "WRECKED" title in this screenshot, which is already tracked as #77.

## Harness notes and limits

- **Harness fixes this round:** the `DASH_T_RANGE` invariant is now per-dash (see above). The score and HP invariants were extended to the new sources (bullet cut, heal overflow, heal restore). The charge cap now follows Spark Coral. The new event types are declared with their fields.
- **Harness fix from the previous round:** the expert's cluster target was the centroid of the nearest two mines, which sat in empty space at opposite corners. The target is now the nearest single mine. The earlier false wave-7 stall was a bot bug, not a game bug.
- **Known and not re-filed:** [#58](https://github.com/omkarbhale/riptide-rush/issues/58) (combo tier thresholds and perfect-pulse slow-mo applied twice) is outside this task's scope.
- **Benign, not filed:** charger `cooldown` and spitter `shotCd` can run below zero. Both are only compared with zero, so they have no effect.
- **Limits:** the policies are scripts, not people. The expert's APM ceiling is partly its planner. Its shellback blindness inflates C2, and it does not account for lunge-extended dashes or pickups. Sensitivity runs mutate the config objects in-process and do not change the repo.
