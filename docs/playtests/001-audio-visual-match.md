# Playtest 001: do the visuals, effects and sounds match what happens?

Tracked by #60. Build audited: `main` at `b9fad66` (feat(feedback): wire art, fx and audio into the game loop), served unmodified from the worktree. Branch `fm/rr-playtest-av`. No game code was changed.

## How this was tested, and its limits

- **Browser:** headless Chromium (snap build, `/snap/bin/chromium`) on WSL2, `devicePixelRatio` 1, canvas 2D in software. Frame times here are dominated by software rasterisation and are not representative of a GPU-backed browser (see "Frame time").
- **Audio:** the sound layer ran with a live `AudioContext` (base latency 11.6 ms, `running`). I could not listen to the output. Sound character is judged from the measured table in PR #47 (levels, duration, dominant frequency) and from the synth definitions, not by ear. Every "sound plays" result below is a call to `audio.play`, not a measurement of what came out of the speakers.
- **Instrumentation:** to see the game's state and calls I served a scratch copy of the worktree with one appended line in `src/main.js` (`window.__rr = { app, feedback, fx, audio, input }`). The copy is outside the worktree and is not committed. I wrapped `audio.play`, the `fx` methods, `feedback.handleStep` and `requestAnimationFrame` to log every call with a timestamp. Input was dispatched as real `KeyboardEvent`/`MouseEvent`s on `window` and the canvas, which the game's own handlers consume.
- **Bot:** a small in-page bot steered from game state and dispatched key and mouse events. It is not a human player, and it is weak.

### Runs

| Run | Kind | Ended | Wave | Score | Kills | Max combo |
|---|---|---|---|---|---|---|
| 1 | natural (bot) | death at 14 s | 1 | 120 | 9 | 7 |
| 2 | natural (bot) | death at 38 s | 3 | 500 | 27 | 15 |
| 3 | natural (bot) | death at 14 s | 1 | 130 | 9 | 8 |
| 4 | natural (bot) | death at 27 s | 2 | 320 | 21 | 11 |
| 5 | natural (bot) | death at 38 s | 3 | 750 | 32 | 15 |
| 6 | harness-assisted | ended by harness at wave 22 (wave 20: 289 kills) | 22 | 11,634 at end | 289 at wave 20, not final | not recorded |

- Runs 1–5 are the only unassisted runs. **None of them reached a wave with a spitter, charger, splitter, mine or shellback, so they do not meet the brief's "every enemy type" requirement.** The bot dies to Drifters before wave 4.
- Run 6 is harness-assisted: HP was reset to 3 every 5 ms, which stops deaths and does not change any feedback path (hits still emit `hurt` and the hurt feedback). It let the sim's own wave script run to wave 22 with all seven kinds present (first seen: drifter wave 1, spitter/charger wave 4, splitter/mini wave 5, mine wave 7, shellback wave 8).
- Game-over timing was measured on a death forced by placing a Drifter in contact at 1 HP. A separate run on the unmodified worktree build (no bot, no harness) died at wave 1 with score 0 within seconds of starting.

## Event-to-feedback table

Counts come from a clean sample of 6,867 sim steps at waves 11–15, plus forced tests where the event was too rare to sample. "Sound" means `audio.play` was called in the same `handleStep` as the event. "Effect" means an `fx` call in that step. Visuals are drawn in the same animation-frame callback that runs the sim step, so there is no frame of visual delay; the sound is scheduled 5 ms after the call, plus 11.6 ms base latency.

| Event (source) | Sound | Effect | Observed | Verdict |
|---|---|---|---|---|
| `dash` (sim) | `dash` | dashStart burst, white flash | 82/82 steps: sound, burst and flash | OK |
| `pulse` (sim) | `pulse` | pulseRing burst, shake 2, cyan flash, ring | 16/16 | OK |
| `perfectPulse` (sim) | `perfectPulse` | perfectShatter, shake 5, white flash, slow-mo 0.35 for 200 ms, floater "PERFECT PULSE" | forced test: all fired, no score awarded by the sim | OK on feedback; reward gap (#78); doubled slow-mo tracked in #58 |
| `reflect` (sim) | `reflect` | reflectSpark, shake 1, hit-stop 20 ms, floater "REFLECT" | forced test: all fired | OK |
| `kill` (sim) | `kill` (pitch rises with combo) | killSmall/killLarge burst, shake, hit-stop, flash, score floater | 55/55 | OK |
| `multiKill` (synthetic) | `multiKill` | multiKillNova, gold flash | 3 steps | OK; `multiKillEnd` floater not observed in the sample |
| `comboTier` (sim) | `comboTierUp` on tier-up | bloom, shake 4, flash, "COMBO n" floater | 7 of 10 steps played `comboTierUp`; the rest were drops to tier 0, which are silent by design | OK; thresholds tracked in #58 |
| `comboLost` (sim) | `comboLost` | comboDrain, shake 2, "COMBO LOST" floater | 6/6 | OK |
| `hurt` (sim) | `hurt` | hurtSpark, shake 10, hit-stop 70 ms, magenta flash, "-1 HP" | 9/9 | OK, strongest feedback in the game |
| `waveStart` (sim) | `waveStart` | waveSweep, shake 3, flash, "WAVE n" | 4/4 | OK |
| `gameOver` (sim) | `gameOver` (+ `hurt`) | implode, dark flash, "GAME OVER" floater, music stops | 5/5 | OK; floater overlaps title (#77) |
| `chargeReady` (derived) | `dashReady` | chargeGlint sparks | fired on refill | OK |
| `spawnWarning` (derived) | `spawnWarn` at volume 0.4 | motes and a "!" floater | 387 sounds in about 5 min | Works; busy and collides with HUD (#72, #79) |
| `deflect` (sim) | none | none of its own | 5 of 6 deflect steps silent | **Silent (#67)** |
| `stagger` (sim) | none | none (render tints the enemy) | 2/2 | **Silent (#70)** |
| `mineArm` (sim) | none (`mineArm` synth unused) | none | 3/3, plus forced test | **Silent (#66)** |
| `mineExplode` (sim) | none (`mineExplode` synth unused) | none (`mineExplode` preset unused) | forced test: nothing fired | **Silent (#66)** |
| `waveClear` (sim) | none | none | 4/4 | **Silent (#70)** |
| Enemy shot (no event emitted) | none (`enemyShoot` synth unused) | none | 2 shots in 40 s poll, 0 sounds | **Silent (#68)** |
| Charger telegraph (no event emitted) | none (`chargerTelegraph` unused) | none (telegraph shown visually only) | 5 telegraphs in poll, 0 sounds | **Silent (#69)** |
| Charger lunge (no event emitted) | none (`chargerLunge` unused) | none | not counted; silent by code | **Silent (#69)** |
| Menus: start, pause, resume, restart, mute | only `waveStart` on start | none | no UI sound at all | **Silent (#71)** |

Mapping coverage: `GAME_EVENT_TYPES` in `src/feedback.js` lists 10 types, but the sim emits 15. The unlisted five are `deflect`, `stagger`, `mineArm`, `mineExplode` and `waveClear`, which is why they are silent. The file's header says the list covers "every event type src/game.js can emit", which is not true.

Event ordering: sound and visual for an event are issued in the same step, so they cannot diverge by more than the 5 ms scheduling offset plus output latency. That is within a frame on this machine. The gap under load is covered in "Frame time".

## Readability

Screenshots: `docs/playtests/001-shots/`.

- **Dense frame, every scripted kind on screen** (`dense-all-enemies-1920x1080.png`): drifters, a spitter, a charger, a splitter, a mine, a shellback and two enemy shots are placed around the player. Enemy silhouettes are distinct at a glance. Enemy shots are the weak point: 6 px amber dots with a glow, lost among grey and maroon shard debris. The "-1 HP" and "COMBO LOST" text sits on top of the player's ship, which is small and is hard to find in that moment.
- **Calm and combo-lost** (`calm-combo-lost-1905x2053.png`): the HUD reads well; the score gold and the wave number are the strongest elements.
- **Overlap with the HUD:** enemies and the player move under the score and the wave number. At 1920, a Drifter sits on the "WAVE" label. In the pause screen the player's cyan ship sits at the top right, in the same cyan as the wave number, and the two merge (`pause-1920x1080.png`).
- **Spawn markers on the dash row** (`narrow-800x900-spawn-on-dash-row.png`): bottom-edge spawn warnings are placed at y = 680 logical. The dash charge diamonds are drawn at y = 678 and the "DASH" label at y = 706, so a marker at the bottom edge sits on the dash charges.

## HUD, title, pause, game over, restart, resize

- **Title** (`title-800x900.png`): the layout is clean at 800×900. The "Best: 0" line and the control list are small at this size.
- **Pause:** the "PAUSED" title and the resume hint read well. The HUD dims, which is right.
- **Game over:** "WRECKED", the score, and "NEW BEST!" read well. Two problems:
  - The "Click, Space or R to dive again" prompt blinks with alpha 0.1–1.0 (`render.js`, `0.55 + 0.45 sin`), so for part of each 1.26 s cycle it is close to invisible.
  - At 1366×768 the "GAME OVER" floater (1.6 s life) is drawn behind and across "WRECKED" and "Score 0" (`gameover-1366x768-floater-overlap.png`).
- **Restart:** key press to a playing screen takes 76, 86 and 80 ms (three trials). Well under the 300 ms target.
- **Resize:**
  - 1920×1080: canvas 1920×1080 css, no letterbox, layout as designed.
  - 1366×768: canvas 1365×768, fits.
  - 800×900: canvas letterboxes to 800×450 with 225 px of empty band above and below. HUD labels are about 8 px and the controls text about 11 px. The fit uses only the width, so a narrow window makes the game small.

## Frame time

Measured in the harness build, 1920×1080 viewport, with `window.requestAnimationFrame` intervals and the time spent inside the frame callback:

| Condition | Frame interval p50 / p95 / max | Callback JS p50 / p95 / max | Long tasks |
|---|---|---|---|
| Bot play across runs 1–6 (mostly waves 1–22) | 41 / 59 / 119 ms | about 1–2 ms | 724 total, median 55 ms |
| 120 Drifters, playing (heaviest) | 85.6 / 102 / 113 ms | 3.9 / 7.4 / 10.4 ms | 84 in 3 s, median 79 ms, max 110 ms |
| 120 Drifters, paused (draw only) | 78.7 / 90.5 / 103 ms | 3.1 / 7.9 / 9.0 ms | — |

The frame callback's JavaScript is 3–4 ms, and the paused draw costs almost the same as the playing frame. So the cost is in canvas raster and compositing outside the game's JavaScript. On this headless software-canvas setup that is roughly 75 ms per frame at 120 entities. **This is an environment result, not a GPU result.** It still points at draw cost, and it means the sound would lead the visual by the raster time at heavy frames: the sound starts about 17 ms after the call, but the frame's pixels can reach the screen tens of milliseconds later.

## Findings, ranked by impact on feel

1. **#66 Mine arming and detonation are silent.** Highest impact: a lethal hazard vanishes with no sound or effect. (Issue #66)
2. **#67 Shellback front deflect is silent.** The most common "dash bounce" moment has no clang or shake. (Issue #67)
3. **#68 Spitter shots are silent, and the bullets are the least visible element.** (Issue #68)
4. **#69 Charger telegraph and lunge are silent.** The telegraph is the main warning for a charger. (Issue #69)
5. **#70 Stagger and wave-clear have no feedback.** (Issue #70)
6. **#71 Menus and pause have no UI sounds.** (Issue #71)
7. **#72 Bottom-edge spawn markers sit on the dash charge row.** (Issue #72)
8. **#73 HUD and arena overlap:** the player and enemies merge with the HUD, and floaters cover the player. (Issue #73)
9. **#74 Frame cost is dominated by canvas raster.** Environment-bound here; needs a GPU profile. (Issue #74)
10. **#75 Narrow windows letterbox to a small game.** (Issue #75)
11. **#76 The game-over prompt blinks down to near-invisible.** (Issue #76)
    **#77 The "GAME OVER" floater overlaps the game-over title.** (Issue #77)
12. **#78 Perfect pulse shows "PERFECT PULSE" but awards nothing.** (Issue #78)
13. **#79 Spawn warnings are busy:** each spawn plays a sound, adds a motes burst and a "!" floater. (Issue #79; needs a listening pass)

Already tracked, not refiled: **#57** (sim does not emit `chargeReady`/`spawnWarning`; feedback derives them correctly), **#58** (combo tier thresholds and doubled perfect-pulse slow-mo: confirmed in this playtest, the sim slows enemies and `fx` slows the sim).

Code-read, not verified in the browser: kills outside a dash batch (including mine blast kills) get the 150 ms REFLECT delay on their score floater, because `delay: ev.batched ? 0 : REFLECT_KILL_FLOATER_DELAY_MS` does not distinguish cause.

## Not done

- Five long unassisted runs that reach every enemy type: not met (see Runs).
- Listening to the sounds: not done. The sound judgements above come from the PR #47 table and the synth code.
- GPU frame timing: not available in this environment.
- Pickups: the sim has no pickups yet, so there was nothing to check.
