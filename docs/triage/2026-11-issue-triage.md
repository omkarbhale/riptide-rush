# Issue triage, November 2026

Tracking issue: #112. Reference state: `origin/main` at b4e2bc9 (includes PR #109).

Scope: every open issue at the time of triage (59 issues). Two issues that were open when the list was first pulled, #100 and #102, were closed by PR #109 before the check finished and are not in the table. Each verdict was checked against the code and docs on `origin/main`. File and line references are to that commit.

Verdict key:
- **DONE**: the code resolves the issue. The cited code is the evidence.
- **PARTLY**: some of the issue is resolved and the rest is named.
- **OPEN**: still valid, no resolving code yet.
- **OBSOLETE**: the issue no longer applies because something else replaced it.

Tests: `node --test` on b4e2bc9 runs 208 tests, all pass, in about 7 seconds (issue #43 is therefore DONE in the repo).

## 1. Verdict table

| # | Title | Verdict | Evidence (origin/main b4e2bc9) |
|---|---|---|---|
| 1 | Game design: core concept and shared architecture | PARTLY | Architecture and most mechanics ship. Several numbers in the body differ from code: combo timer floor (src/config.js:63), spark and coal durations (src/config.js:212-213), wave timeout 14 s (src/config.js:171), spawn minimum 280 px (src/config.js:164). Keep open as the design source. |
| 9 | Multi-kill hit-stop number | PARTLY | Sim formula is 40 ms plus 10 per extra kill, cap 100 (src/game.js hitStopFor, src/config.js:70-75). Presentation uses its own table that caps at 70 ms for 4+ kills (src/feedback.js:68, 91) and ignores ev.hitStopMs. |
| 10 | Buffer dash/pulse presses during hit-stop | DONE | The hit-stop is a freeze of sim steps. The input buffer ticks per sim step (src/main.js pumpInput, simStep; src/input.js createActionBuffer), so presses pressed during the freeze wait for the next step. The dropped-press playtest was not run. |
| 11 | Combo timer floor 1.6 s at x10 | DONE | comboWindowFor shrinks linearly from 2.5 s to a floor of 1.6 s at x10 (src/game.js comboWindowFor; src/config.js:61-64). |
| 12 | Numeric shake caps and reduced-motion setting | PARTLY | Shake option 100/50/0 and a Reduced flashes option, saved in localStorage (src/hud.js:17-26, 157-160; src/render.js:291-303; src/main.js:29). Kill shake peaks are 3-12 px (src/feedback.js:67). Missing: the per-source limit of 4 shake triggers per second. |
| 14 | Kill-sound pitch cap at +12 semitones | PARTLY | A cap exists (src/feedback.js killPitch, MAX_KILL_PITCH = 2). The step is 0.02 per combo (about 0.33 semitone), so the cap is never reached: the maximum is 1.6x at combo 30. No layering past the cap. |
| 15 | Splitter mini spawn grace 0.3 s | DONE | ENEMY.mini.graceTime = 0.3 (src/config.js:143), applied at spawn (src/game.js:380, 942). |
| 16 | Wave pacing: breathers and 200-entity cap | PARTLY | The 200-entity cap is enforced (src/game.js:367, 1185; src/config.js:166). A 2.5 s breather runs only after release waves (src/game.js:1139, 1172). There is no breather guaranteed every 20-30 s, and spawn rate does not scale with combo tier. |
| 17 | Distinct stagger feedback | OPEN | The stagger row is a tick plus charge-glint sparks (src/feedback.js:336-341). No ring in its own colour and no 0.4 s cue. |
| 18 | Q1: pause behaviour (Esc/P, window blur) | DONE | Esc and P map to pause (src/input.js:22-23). Window blur pauses (src/main.js:278; src/input.js:116). |
| 19 | Enemy: Puffer | OPEN | No puffer kind in src/config.js ENEMY or src/game.js. Tracked by #114. |
| 20 | Enemy: Shield Bearer | OPEN | No aura or barrier code. Tracked by #114. |
| 21 | Q2: healing in v1 | OBSOLETE | Superseded by DESIGN section 3.9a (docs/DESIGN.md:130, 180). Heal orbs ship (src/config.js:195-200; src/pickups.js). |
| 22 | Enemy: Ink Squid | OPEN | No code. Tracked by #114. |
| 23 | Q3: mine defuse counts as a kill | DONE | A mine dashed through goes through killEnemy with cause `defuse` (src/game.js, around lines 754 and 780). It gives combo, points and the charge refund. |
| 24 | Enemy: Phase Eel | OPEN | No code. Tracked by #114. |
| 25 | Q4: perfect pulse timing window | OPEN | Window is 0.12 s (src/config.js:53). No 20-pulse hit-rate log exists in the issue or in docs/playtests. |
| 26 | Hazard: Tidal Current | OPEN | No hazard in config or sim. The current lines in src/art.js (around line 298) are cosmetic background. |
| 27 | Q5: dash into Shellback front arc | PARTLY | The bounce ships as 80 px over 0.4 s, invulnerable, with the charge refunded (src/config.js:45-46; src/game.js startBounce, around line 794-811), per #85. Q5's "40 px, 0.1 s, charge spent" is superseded. |
| 29 | Q6: refund on a full charge bar | DONE | killEnemy clamps the refund to the max charge, so no banking (src/game.js killEnemy). |
| 30 | Hazard: Reef Pillars | OPEN | No pillar code. |
| 31 | Q7: colour-blind enemy readability | OPEN | No icon overlay. A silhouette check is planned in #107. |
| 32 | Pickup: Spark Coral | PARTLY | sparkCoral gives +1 max charge for 5 s (src/config.js:212; src/pickups.js:54). Spec is +1 charge immediately for 8 s. It drops per kill (src/config.js:201), not on a timed 18 s spawn. |
| 33 | Q8: enemy HP above 1 | DONE | Every enemy kind in src/config.js ENEMY has no HP field, so 1 HP. Boss HP belongs to #38. |
| 34 | Pickup: Riptide Coal | PARTLY | Implemented as a combo drain at half speed for 5 s (src/config.js:213), not a 4.0 s timer for 6 s. Per-kill drop, not timed. |
| 35 | Q9: music layers by combo tier | OPEN | Music intensity is fed from the multiplier, 0-1 (src/feedback.js, around lines 580-588). No layers yet. Tracked by #108. |
| 36 | Pickup: Shield Scale | PARTLY | Absorbs one hit for 5 s (src/config.js:214; src/pickups.js). Spec is 6 s. Per-kill drop, not timed every 30 s. |
| 37 | Q10: top-5 local high scores | OPEN | Single high score under riptide-rush.highScore (src/config.js:219; src/main.js:60-71). No src/scores.js. |
| 38 | Boss: Anglerfish Warden | OPEN | No boss code. Tracked by #114 and #107. |
| 39 | Q11: wave timeout | OPEN | A timeout exists at 14 s (src/config.js:171). DESIGN says 25 s (docs/DESIGN.md:470). |
| 40 | Q12: spawn distance from Rip | OPEN | Shipped minimum is 280 px (src/config.js:164). DESIGN says 200 px (docs/DESIGN.md:469). |
| 43 | Test command fails on Node 22+ | DONE | package.json `"test": "node --test"` (no directory argument). No `node --test test/` remains in the repo. |
| 55 | Perfect pulse does not award +150 | DONE | src/game.js adds PULSE.perfectBonus (src/game.js, around line 900) and the event carries the points. |
| 56 | fx: inward collapse for game-over implode | OPEN | No collapse primitive in src/fx.js. src/feedback.js (around line 123) approximates it. |
| 57 | Sim does not emit chargeReady or spawnWarning | OPEN | The sim emits neither (no such event types in src/game.js). src/feedback.js derives them (around lines 368-377, 551-560). |
| 58 | Config vs DESIGN: combo tiers and double slow-mo | PARTLY | Item 1 DONE: COMBO.tiers is 10/20/30/40 (src/config.js:66; src/game.js tierFor). Item 2 OPEN, see #104. |
| 65 | Pickups: dedicated sounds and effects | OPEN | src/audio.js SOUND_NAMES has no pickup, heal, shieldBreak or modifierEnd sound. Tracked by #108. |
| 66 | Playtest: mine arming and detonation are silent | PARTLY | Rows for mineArm and mineExplode now exist with sound, preset, shake and hit-stop (src/feedback.js, around lines 343-355). The armed blast-radius telegraph is not drawn (no blastRadius use in src/render.js or src/art.js). |
| 68 | Playtest: spitter shots silent, bullets hard to see | PARTLY | Event and sound are done: src/game.js emits enemyShoot (line 239) and src/feedback.js has the row (lines 291-292). Bullet visibility changed in 20ef02b but was not re-checked in a browser here. |
| 71 | Playtest: menus and pause have no UI sounds | PARTLY | Start and restart play uiStart (src/feedback.js:601). Pause and resume play uiClick (src/feedback.js:606). The mute toggle is silent (src/main.js:101). |
| 73 | Playtest: enemies, the player and floaters merge with the HUD | PARTLY | The HUD moved to src/hud.js with layout bands (#99), and warnings avoid HUD rectangles (src/render.js drawFrame). Floaters still draw over the player (see #98). |
| 74 | Playtest: frame cost dominated by canvas raster | PARTLY | Enemy sprite cache and static background layer (20ef02b; src/art.js, around lines 224-240 and 925-940). Adaptive effects quality and frame profiling (#109; src/main.js, around lines 234-252; src/fx.js, around lines 345-348). No GPU measurement, and the 3x target is not shown. |
| 77 | Playtest: GAME OVER floater overlaps WRECKED | OPEN | src/feedback.js (lines 275-282) still spawns the GAME OVER floater. Centred by enrich (src/feedback.js, around line 414). |
| 84 | Balance: first spitter in wave 2 is a brick wall | PARTLY | Ramp shipped: firstShotDelay 2.0 s, spitter gate (src/config.js:99, 173-174). docs/playtests/003-balance-pass.md:88 says the wall is still there. |
| 85 | Balance: shellback contact after a deflect | PARTLY | 80 px over 0.4 s bounce shipped (src/config.js:45-46). docs/playtests/003-balance-pass.md:88 says expert damage is still mostly contact. |
| 86 | Balance: expert APM tops out near 60 | OPEN | docs/playtests/003-balance-pass.md:88 reports APM 81 against a target of 110. Tracked by #105. |
| 87 | Balance: intermediate is effectively invulnerable | PARTLY | Heal and modifier rates reduced, with the #87 comments (src/config.js:196-216). docs/playtests/003-balance-pass.md:88 reports a cap share of 25%. Re-measure in #105. |
| 96 | Render: mine rings draw at PULSE.radius, not 90 px | OPEN | src/render.js (around lines 333 and 341) still uses PULSE.radius. No per-ring radius. |
| 98 | Feedback: GAME OVER and WAVE floaters duplicate the HUD; floaters draw over the player | OPEN | src/feedback.js lines 256-262 (WAVE n floater) and 275-282 (GAME OVER). src/render.js drawFrame draws fx.drawWorld after drawPlayer (lines 456-467), so floaters sit over the ship. drawModifierHud (src/pickups-art.js:162) is unused. |
| 104 | Feel: perfect pulse slow-motion applied twice | OPEN | Layer 1: the sim (src/game.js, `game.slowmo` at the perfect pulse, around line 899; scaled in update). Layer 2: the feedback row (src/feedback.js:224) calls fx.slowmo with 0.35 for 200 ms. The fx.js preset slowmo (src/fx.js:97) is not applied in the game path, because feedback uses only the preset's bursts (src/feedback.js:116). Dropping one of the two layers resolves this. |
| 105 | Balance pass 2: crowd density and earned healing | OPEN | Not started: docs/playtests/004-balance-pass-2.md is absent. |
| 106 | art.js: enemy, background and bullet raster dominate | PARTLY | Enemy sprite cache and background cache (20ef02b; src/art.js, around lines 224-240 and 925-940). Bullet draw is still per frame. Not re-profiled. |
| 107 | Art: four new enemies, boss, pickups polish, CB-safe shapes | OPEN | No puffer, shieldbearer, inksquid, phaseeel, warden, or draw.hazard in src/art.js. |
| 108 | Sound pass 2: adaptive music and new sounds | OPEN | No setMusicDanger or setMusicPaused in src/audio.js. No new names in SOUND_NAMES (src/audio.js:14). |
| 110 | Screens: title, how-to, run summary, top-5 scores | OPEN | No src/scores.js. No how-to or run-summary screen. Single high score only. |
| 111 | Web shell: touch, fullscreen, gamepad, page polish | OPEN | index.html has only touch-action: none. No src/touch.js, gamepad, or fullscreen code. |
| 112 | Issue triage (this task) | OPEN | This PR, fm/rr-triage. |
| 113 | Brainstorm: reasons to play again | OPEN | docs/design/replayability.md does not exist yet. |
| 114 | Game logic: Puffer, Phase Eel, Ink Squid, Shield Bearer, Warden | OPEN | No src/enemies-extra.js. |

Counts: DONE 9, PARTLY 19, OPEN 30, OBSOLETE 1 (total 59).

## 2. Next 10 things to build

Ranked by impact on how fun and polished the game feels. Each is one line of rationale.

1. **Balance pass 2 (#105), with APM and flow as the target.** Expert APM is about 81 against a target of 110 (docs/playtests/003-balance-pass.md:88). This is the core skill goal, and it is the biggest gap between the game and its design.
2. **New enemy logic and art (#114, #107), starting with the Warden boss (#38).** Variety and a climax are what turn a good arena into a game. The Warden gives a wave-10 moment.
3. **Stagger feedback distinct from kill (#17).** Players need to tell "vulnerable" from "dead" at a glance, and this is cheap to do.
4. **Floater and HUD clutter (#98, #77).** Removing the duplicate GAME OVER and WAVE floaters and moving floaters under the ship is a fast, visible polish win.
5. **Screens: title, how-to, run summary with medals, top-5 scores (#110, #37).** Retention depends on the "one more go" moment, and the game has no run summary yet.
6. **Sound: pickups, mine telegraph, menu mute, adaptive music (#65, #108, #71).** Audio is the most direct source of feel, and several events are still silent or reuse the wrong sound.
7. **One source for perfect-pulse slow-motion, and the kill-pitch step (#104, #14).** A double slow-mo and a pitch cap that never engages change how the signature moves feel. Both are small code changes.
8. **Hazards: Tidal Current and Reef Pillars (#26, #30).** Arena geometry gives players terrain to read, which the current arena lacks.
9. **Touch and gamepad (#111).** Reaches phone and controller players, a large share of the audience the page can serve.
10. **Replayability v1 (#113).** A daily or seeded run and medals give a reason to come back after the first session.

Honourable mention (small, can ride with other work): #96 mine ring radius, #56 and #57 event and effect cleanups, #25 pulse-window validation.

## 3. Safe to close

These are DONE on code evidence, or OBSOLETE, so the issue has nothing left to build. Closing them is for a maintainer. Nothing was closed in this task.

- #43 test command (package.json:4 uses plain `node --test`)
- #18 Q1 pause behaviour (Esc/P, blur)
- #21 Q2 healing (superseded by DESIGN §3.9a and #54)
- #23 Q3 mine defuse as kill
- #29 Q6 no banking
- #33 Q8 enemy HP (1 HP for regular enemies; the boss is covered by #38)
- #15 splitter mini grace
- #11 combo timer floor
- #55 perfect pulse +150
- #10 buffer during hit-stop (the playtest of dropped presses can be a new issue if wanted)

## 4. Recommended answers to the design questions

**Q1 (#18), pause behaviour.** Yes to both: Esc and P toggle pause, and window blur pauses. Already shipped (src/input.js:22-23; src/main.js:278). Close.

**Q2 (#21), healing in v1.** Superseded. Keep the earned model that shipped in #54: heal orbs with a pity timer, and a flawless-wave heal. The original "no healing" call was reversed after playtest 001. Close.

**Q3 (#23), mine defuse as a kill.** Yes. Already shipped: defuse goes through killEnemy (combo, points, charge refund). Close.

**Q4 (#25), perfect pulse window.** Keep 0.12 s (src/config.js:53). Validate with at least 20 pulses in tools/fx-lab.html, and log the hit rate here. Widen to 0.15 s only if fewer than 1 in 5 pulses is perfect. This is the one question with no evidence yet, so it stays open.

**Q5 (#27), dash into a Shellback's front arc.** The shipped answer is a bounce, but at 80 px over 0.4 s, and the charge is refunded (src/config.js:45-46; src/game.js startBounce). That is the #85 result, and the refund is the lesson's cost in tempo, not charges. Recommend keeping the #85 values and the refund, and updating docs/DESIGN.md §3.4 and Q5 to match. Then close.

**Q6 (#29), refund on a full bar.** No banking. Already shipped (killEnemy clamps to max). Close.

**Q7 (#31), colour-blind icon overlay.** Not in v1. Rely on silhouettes, and check them in the gallery under deuteranopia and protanopia (#107). Revisit an icon overlay in v2 only if that check fails.

**Q8 (#33), enemy HP above 1.** Regular enemies stay at 1 HP. The boss (#38) is the one multi-HP exception. Close.

**Q9 (#35), music layers.** Four layers at combo tiers 10, 20, 30 and 40, intensity tier/4. The current feedback code maps intensity from the multiplier (src/feedback.js, around lines 580-588), so change it to use tierFor(count) / 4. That keeps the music and the HUD colour tiers on the same thresholds. Done with #108.

**Q10 (#37), top-5 local high scores.** Yes, top 5. Keep the key the code already uses, riptide-rush.highScore (src/config.js:219), and migrate it into a new array key. The Q10 text names riptide.highscore.v1, which the code has never used, so using it would strand existing scores. Done with #110.

**Q11 (#39), wave timeout.** Yes, a timeout that keeps enemies acting. The value that shipped is 14 s (src/config.js:171), not the 25 s in DESIGN. Recommend keeping 14 s, which the balance pass has already tuned, and updating docs/DESIGN.md (§4 and §7) to match. Revisit the value in #105.

**Q12 (#40), spawn distance.** The principle holds: spawns should not land on Rip. The shipped minimum is 280 px (src/config.js:164), not 200. In #86, dropping it to 180 px moved expert APM from 60.8 to 60.2, so there is no evidence to move it. Recommend keeping 280 px and updating DESIGN, then revisiting when #105 changes crowding.

## 5. Findings outside the triage scope

- DESIGN §9 Q10 names the storage key riptide.highscore.v1, but the code uses riptide-rush.highScore. Fix in the docs when #110 lands.
- The double slow-mo in #104 is the sim (game.js) plus the feedback row (feedback.js:224). The fx.js preset slowmo at fx.js:97 is dead in the game path, so removing it changes nothing; the fix is to drop one of the two live layers.
- drawModifierHud (src/pickups-art.js:162) is unused. Its owner can delete it (noted in #98).
