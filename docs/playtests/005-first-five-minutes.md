# Playtest 005: first five minutes on the current build

Tracked by [#130](https://github.com/omkarbhale/riptide-rush/issues/130). Follows [playtest 003](003-balance-pass.md). Design source: [DESIGN.md](../DESIGN.md) and [#1](https://github.com/omkarbhale/riptide-rush/issues/1).

**Read this first: the run sample is much smaller than the brief asked for.** I could not drive a reactive player. The page exposes no state hook, the HUD is canvas-drawn, and every action costs a tool call. The controller I used is open-loop: it sweeps the eight directions, taps dash toward the canvas centre and presses Pulse on a timer, with no sight of enemies. It dies within 4 to 20 seconds at wave 1. So this report does **not** measure the first five minutes. It records what the screens look like, what a new player sees in the first seconds, and a few visual and layout faults that show up regardless of play skill. The fairness and flow audits could not be done and are marked as such below.

## What was run

| Requested (brief) | Done | Notes |
| --- | --- | --- |
| 10 full desktop runs at 1366x768 | 4 short open-loop runs (ended at wave 1, about 4 s, 9 s, 18 s and 40 s+) | A blind controller cannot survive a school. These are not representative. |
| 3 touch runs in phone emulation | 0 touch runs. 1 phone-emulation layout check (390x844, touch flag) | The browser tool sends mouse events, not touch events, so no real touch input was possible. |
| 1 run with options changed (shake 0%, reduced flashes, muted) | Options set on the pause screen and checked. Not played through. | Screenshot: `options-set-1366.png` |
| Minute-by-minute timeline, first-time screenshots | First 5 seconds and the game-over screen only | No first school, Spitter, Shellback, pickup, heal or modifier was reached. |
| Fairness audit (every hit) | Not done. One hit observed (-1 HP from a drifter school, about 3 s in). | No warning timing could be measured. |
| Flow audit (dash gaps, charge gaps, combo) | Not done. | |
| Feel bursts (5 frames, 50 ms apart) | Not done. | |
| Screen checks (title, how-to, pause, options, game over) | Done for title, pause/options, game over and phone layout. | There is no how-to screen in the current build. |
| Console | Checked after each run and at the end: no errors, no warnings. | |

## Timeline of the first minute (what a new player sees)

Times are from the first Space press on the title screen, 1366x768.

- **0 s, title.** "RIPTIDE RUSH" with a one-line pitch, a controls table (WASD/arrows, mouse aim, left click or Space dash, right click or Shift pulse, Esc/P pause, M mute) and "Click or press Space to dive in". Clean, no overlap. The top-centre pill reads "CLICK OR PRESS A KEY TO START", which repeats the same instruction. (`title-1366.png`)
- **0–2 s, play starts.** Rip sits in the middle with a dashed aim line to the cursor. Three cyan hearts sit bottom-left, three dash diamonds bottom-centre, a PULSE ring bottom-right. None of these three HUD blocks is labelled in the controls table or anywhere else. A player has to work out from the pips that the left group is health and the centre group is dash. (`run1-t3s.png`)
- **About 2–3 s, first school.** A drifter school (purple, 4 to 6 fish) reaches Rip. The hearts and dash charge drop. A "-1 HP" floater sits over Rip and the school at the moment of the hit, which reads as clutter more than information. (`run3-s2.png`)
- **About 4 s, dead.** In the run with the 4 s death, the screen goes to WRECKED with score 0 and wave 1. The player has no chance to learn a mechanic. The same happened in the 9 s and 18 s runs. Whether this is a balance problem or only the open-loop controller cannot be settled here; a reactive run is needed. (`run3-s3.png`)
- **Game-over screen.** "WRECKED", score, best, WAVE REACHED, PEAK COMBO and "Click, Space or R to dive again". Layout is clear at 1366x768, but ambient drifters and a ghost of Rip draw over the stat numbers and the PEAK COMBO label. (`run3-s6.png`, `run4-a6.png`)

Not reached in this sample: the first Spitter and its hint, first Shellback, first pickup, first heal, first modifier, first death as a teaching moment. Those moments are still unchecked.

## Findings

Each finding is filed as a separate issue or added as evidence to an existing one. See "Issues" below.

1. **Fullscreen button covers the WAVE label on every play and pause screen.** The top-right fullscreen button sits on top of the "WAVE" heading, so the word reads "WA" and the number "1" is partly hidden. Seen on play (`run1-t3s.png`) and pause (`pause-1366.png`) at 1366x768. Filed as [#139](https://github.com/omkarbhale/riptide-rush/issues/139).
2. **Game-over stats are overdrawn by ambient sprites.** Drifters and the Rip ghost sit over WAVE REACHED, the "1", and the PEAK COMBO label. Same family as [#73](https://github.com/omkarbhale/riptide-rush/issues/73) (enemies merge with the HUD), so it is added there as evidence. Not a duplicate of [#77](https://github.com/omkarbhale/riptide-rush/issues/77), which is the GAME OVER floater.
3. **Pause options panel is see-through.** Drifters and the Rip ghost show through the OPTIONS panel behind the Screen shake and Reduced flashes rows. Added to [#73](https://github.com/omkarbhale/riptide-rush/issues/73).
4. **The live-region text is wrong on game over.** During the WRECKED screen, the `aria-live` status reads "Click or press a key to start", not the dive-again prompt. A screen reader user is told to start a game that is already over. Filed as [#140](https://github.com/omkarbhale/riptide-rush/issues/140).
5. **HUD blocks have no labels.** Hearts (bottom-left), the dash row (bottom-centre) and PULSE (bottom-right) are unexplained; the title lists controls only. Added to [#110](https://github.com/omkarbhale/riptide-rush/issues/110) (screens, how-to-play).
6. **Phone (390 px) layout clips the title and game-over text.** At 390x844 the RIPTIDE RUSH title, the pitch line, the "dash-slash toward the cursor" and "pulse: reflect bullets" text, and the WRECKED title all run past the screen edges. Added to [#126](https://github.com/omkarbhale/riptide-rush/issues/126), which already reports this.
7. **Phone title shows the mouse controls table only**; the touch controls are not on the title screen. Also in [#126](https://github.com/omkarbhale/riptide-rush/issues/126).
8. **Options change works.** Setting Mute, Screen shake 0% and Reduced flashes produces a "MUTED (M)" toast and the three values update on the panel. Good evidence the options screen is working.

## Three things that most hurt the first five minutes

These are based on what was seen, not on a full run. Items 1 and 2 are the strongest.

1. **The first ten seconds are unreadable for a new player.** The three HUD blocks are unlabelled, the "-1 HP" floater clutters the first hit, and the first school arrives within about 3 seconds.
2. **The HUD collides with the fullscreen button**, so the wave number is hard to read from the first frame onward.
3. **The game-over screen is cluttered and its live-region text is wrong**, which makes the moment after the first death less clear than it should be.

## Issues

- New: [#139](https://github.com/omkarbhale/riptide-rush/issues/139) (fullscreen button covers WAVE), [#140](https://github.com/omkarbhale/riptide-rush/issues/140) (live region on game over).
- Evidence added to existing issues: [#73](https://github.com/omkarbhale/riptide-rush/issues/73) (game-over and pause overdraw), [#110](https://github.com/omkarbhale/riptide-rush/issues/110) (unlabelled HUD), [#126](https://github.com/omkarbhale/riptide-rush/issues/126) (phone clipping).

## Three things that most help

1. **Title screen is clean and direct** at 1366x768: a clear name, a one-line pitch, a controls table and one start prompt.
2. **The pause and options screens work**: readable rows, sensible defaults, a toast that confirms each change.
3. **The core read is good when it is visible**: the aim line, the dash row and the pulse ring are all legible in the first frame. No console errors or warnings in any run.

## Ranked fixes

1. Move or hide the fullscreen button so it does not cover the WAVE label (issue filed).
2. Label the three HUD blocks, or add a one-line legend to the title screen (see [#110](https://github.com/omkarbhale/riptide-rush/issues/110)).
3. Keep ambient sprites off the game-over stats card, and make the pause panel opaque or dim what is behind it ([#73](https://github.com/omkarbhale/riptide-rush/issues/73)).
4. Set the live-region text per screen, so game over announces the dive-again prompt (issue filed).
5. Fix phone-width clipping on title and game over ([#126](https://github.com/omkarbhale/riptide-rush/issues/126)).
6. Run a reactive playtest once a state hook or a steerable controller exists, to measure the first five minutes, the fairness audit and the flow audit. This is the main gap in this report.

## Screenshots

Stored with the task data (not in the repo, since this task owns only this file). Attached to the playtest PR comment.
