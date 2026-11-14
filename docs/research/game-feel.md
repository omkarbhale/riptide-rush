# Game feel research for Riptide Rush

Tracking: [#7 Research: game-feel techniques](https://github.com/omkarbhale/riptide-rush/issues/7). Design source of truth: [#1 Game design: core concept and shared architecture](https://github.com/omkarbhale/riptide-rush/issues/1).

This is a numbers-first checklist for the people implementing and playtesting Riptide Rush. Every technique is described in our own words. Where a number comes from a source, the source is linked next to it. Where a number is our recommendation, it is marked **(rec)** and must be confirmed in playtests, not treated as settled.

## How to read this note

- Sim rate in #1 is 120 Hz, so one simulation tick is **8.33 ms**. Frame-count advice from fighting games is converted to ms with that in mind. At 60 fps, one render frame is 16.7 ms.
- Most sources below are postmortems, blog posts and talk write-ups, not peer-reviewed studies. Treat their numbers as starting points.
- Several talks cited in community write-ups could not be confirmed on GDC Vault during research. Those are marked "unverified" and should be checked before anyone quotes them.

---

## 1. Input responsiveness and forgiveness windows

**Core idea.** The player's perception of "I pressed it and it happened" depends on three things: the time from press to the first visible response, whether the press was lost because it arrived at a bad moment, and whether the game forgave near-misses.

- **Input buffering.** Store a press for a short window and execute it at the first moment the action becomes legal. A common explanation of the technique is in [bugnet: input buffering for responsive controls](https://bugnet.io/blog/how-to-implement-input-buffering-for-responsive-controls). Fighting-game frame data shows the same idea in a stricter form: inputs pressed during hit-stop can be executed right after it ends ([Dustloop attack attributes](https://dustloop.com/w/GGST/Attack_Attributes), [Impact Freeze notes](https://sonichurricane.com/?p=1043)).
- **Coyote-style forgiveness.** Let an action still succeed for a few frames after its condition has ended. Maddy Thorson's public explanation for *Celeste* describes this as the jump working briefly after leaving a ledge, and buffering a press just before landing so it fires on the landing frame ([Celeste and forgiveness, Maddy Makes Games](https://maddymakesgames.com/articles/celeste_and_forgiveness/); [Blizzard Watch summary of Thorson's thread](https://blizzardwatch.com/2020/03/13/celeste-developer-game-feel/)). One secondary guide puts *Celeste*'s window at about 5 frames; this is unverified, so treat it as a rough order of magnitude ([bugnet: coyote time and input buffering](https://bugnet.io/blog/coyote-time-and-input-buffering-explained)).
- **Perception floor.** A Lübeck study of mouse-driven interaction found that people notice latency at around 60 ms, which is well below the 100 ms figure often quoted ([Are 100 ms fast enough?](https://research.uni-luebeck.de/en/publications/are-100-ms-fast-enough-characterizing-latency-perception-threshol/)). NVIDIA's esports study found that more refresh rate improved performance monotonically across 60, 120 and 240 Hz, so frame rate matters on its own, not only latency ([NVIDIA: Esports Arms Race](https://research.nvidia.com/publication/2019-09_Esports-Arms-Race%3A)).

**Recommended numbers**

| Item | Value | Basis |
|---|---|---|
| Dash input to first visible frame | 1 sim tick (8.3 ms) plus one render frame | rec, derived from 120 Hz sim |
| Input buffer for dash and pulse | 120 ms | matches #1 |
| Buffer for dash charge that is not yet ready | 120 ms, then drop | rec |
| Forgiveness window on a "dash landed on a wall" edge case | 2–3 ticks (17–25 ms) | rec |
| Pulse perfect-timing window | 120 ms around impact | matches #1 |
| Total mouse-click-to-sound latency budget | under 60 ms | rec, from the Lübeck threshold |

**Why it matters.** Dash-combat is a skill game. A player who clicks a fraction of a second early and gets nothing will read that as the game being broken, not as their mistake. Buffering turns that into a satisfying chain.

---

## 2. Impact feedback: hit-stop, shake, flashes, particles

**Hit-stop (impact freeze).** Briefly pause the simulation, or only the affected entities, at the moment of a hit. Sources describe it as a few frames, roughly 60–120 ms, with longer pauses making the game feel laggy ([Godot 4 game feel checklist](https://forum.godotengine.org/t/game-feel-checklist-for-godot-4-hit-stop-trauma-shake-coyote-time-and-more/145340); [bugnet: how to use hit pause](https://bugnet.io/blog/how-to-use-hit-pause-to-make-impacts-feel-powerful)). Fighting-game frame data uses about 7 frames of hit-stop for a light attack ([King of Fighters XIII hitstun/hitstop table](https://srk.shib.live/w/The_King_of_Fighters_XIII/Character_States/Hitstun_Blockstun_state)). Some third-party breakdowns cite only 10–20 ms, so the effect is strongly tuning-dependent.

- Recommended for a kill: **40–70 ms** (matches #1). Start at 50 ms, then tune.
- Recommended for a multi-kill: add 10 ms per extra kill, cap at **100 ms** (rec).
- Do not stop input. Buffer inputs during hit-stop (see section 1).
- Do not stop the particles or floaters. Only the entity motion pauses.

**Screen shake.** A widely cited talk is Jan Willem Nijman's "The Art of Screenshake" (c. 2013, Control conference / INDIGO Classes; video at [youtu.be/AJdEqssNZ-U](https://youtu.be/AJdEqssNZ-U), not checked on GDC Vault). He starts from a plain shooter and adds small effects one at a time. The common practical model is "trauma": add trauma on each hit, decay it over time, and offset the camera by a random amount scaled by trauma squared, so small hits barely register while big hits kick ([Godot 4 screen shake and hit-stop](https://dev.to/saltmire/godot-4-screen-shake-and-hit-stop-in-one-script-11eh)). Guides also suggest a few frames of shake per landing or hit, not continuous shake ([Feel docs: screen shakes](https://feel-docs.moremountains.com/screen-shakes)).

- Kill shake peak: **4–6 px** at 1280x720 (rec).
- Big hit or multi-kill peak: **8–12 px** (rec).
- Cap total shake at **14 px** and decay over **150–250 ms** (rec).
- Never shake for each bullet; cap shake triggers at about 4 per second per source (rec). Developers warn that shake on rapid-fire weapons becomes obnoxious ([Game Developer summary of Nijman's advice](https://gamedeveloper.com/design/vlambeer-co-founder-shares-advice-on-building-better-action-games)).
- Provide a motion-reduction setting that scales shake to 0 (see [camera shake without motion sickness](https://www.strayspark.studio/blog/camera-shake-game-feel-without-motion-sickness)).

**Flashes.** A white or tinted flash on the struck enemy for **2–3 render frames** at 60% alpha is a common, cheap cue (rec). It helps the eye register the hit even when particles are busy.

**Particles and floaters.**
- Kill burst: **8–16 particles**, lifetime **250–450 ms**, pooled, with a hard cap (matches the cap requirement in #1) (rec).
- Score floater: rise **30–40 px** over **600–800 ms**, fade in the last third (rec).
- A common technique is to stack 5–8 small responses (flash, shake, sound, particles, floater, hit-stop) within about 100 ms of the hit ([gamejuice: game juice checklist](https://gamejuice.pages.dev/articles/game-juice-checklist-30-techniques)). Keep this stack for kills, not for every bullet or every frame.

---

## 3. Audio feedback and pitch escalation

- **Rising pitch on a chain.** Step the pitch up on each consecutive hit in a combo. A common interval is one semitone per step, which sounds natural ([Game Developer: the power of pitch shifting](https://gamedeveloper.com/audio/the-power-of-pitch-shifting)). Middleware such as CRIWARE exposes combo-sequential cues for this without code ([CRIWARE: combo SFX](https://blog.criware.com/index.php/2016/11/05/implement-combo-sfx-in-a-few-clicks/)).
- **Cap the escalation.** Cap pitch at **+12 semitones** (one octave) above base, then keep the same sound with louder layering (rec). Past that, the sound becomes shrill and the player stops hearing differences.
- **Random pitch jitter.** Add ±1 semitone random variation to avoid repetition. This is separate from escalation (same source as above).
- **Layering.** Kill sound = impact layer (short noise transient, 10–20 ms) + tonal layer (escalating pitch) + tail (fades over 150–300 ms) (rec). Jan Willem Nijman of Vlambeer is reported to argue that feel comes from concrete additions such as bass on effects and screen shake, and that how elements interact matters more than any one element. This is a secondhand translation of an interview, so treat it as a pointer, not a quote ([Nijman interview reprint, unverified](https://www.gcores.com/articles/106660)).
- **Audio timing.** Audio must start within the same perceptual budget as visuals. Use the 60 ms perception floor as the upper bound (section 1).

---

## 4. Readability under chaos

- **Telegraphs.** A telegraph must give enough warning to react, but not so long that combat feels sluggish ([Game Developer: enemy attacks and telegraphing](https://gamedeveloper.com/design/enemy-attacks-and-telegraphing)). Typical forms are large gestures, colour changes and a sound cue ([bugnet: enemy attack telegraphs](https://bugnet.io/blog/how-to-design-enemy-attack-telegraphs)).
- Charger telegraph in #1 is 0.6 s. Recommended range **0.45–0.7 s** (rec). Below 0.45 s it is hard to read at speed, above 0.7 s it feels slow.
- **Colour coding.** Enemy danger colour (magenta #ff3d81 in #1) and player colour (cyan #3cf2ff) must stay distinct under deuteranopia. Verify with a colour-blind simulator before locking the palette (rec). Bullets (amber) must not share a hue family with score floaters (gold) (rec).
- **Contrast.** Enemy outlines should have at least 3:1 luminance contrast against the background gradient #050a18 to #0a1830 (rec, WCAG non-text contrast guideline).
- **Stagger vs. kill.** The feedback for "this enemy is staggered" (Shellback after Pulse, Spitter after reflect) must be visually distinct from "this enemy died". Doom's 2016 combat design talk is cited for timing that does not interrupt player flow, in particular that glory-kill timing was a central problem and that the animations were kept to hundreds of milliseconds ([GDC 2018 Loudy and Campbell session, via GDC news](https://gdconf.com/news/speaker-qa-kurt-loudy-jake-campbell-break-combat-philosophy-doom); [Game Developer on glory kill timing](https://gamedeveloper.com/design/-i-doom-s-i-glory-kill-animations-nearly-cost-the-game-its-chainsaw)). The stagger/kill distinction itself is our recommendation.
- **Death readability.** When a player is hit, the cause must be visible in under 300 ms: one flash on the damaging element and a short sound (rec).

---

## 5. Combo and flow design

- **Flow channel.** Player engagement is highest when challenge roughly matches skill. The channel model is the classic framing ([PMC review: flow in video games](https://pmc.ncbi.nlm.nih.gov/articles/PMC8943660)).
- **Combo timers.** Warframe's melee combo resets its timer on every hit and drops the multiplier in steps when the counter falls below a threshold ([Warframe wiki: melee combo](https://wiki.warframe.com/w/Melee_Combo_Counter)). A developer config model lets decay start after a short grace period and drop the combo by a fixed amount per interval, so a combo cannot be held indefinitely without fighting ([devlog config example](https://vitalstrike.vercel.app/docs/configuration/combo)).
- **Style and rank.** Character-action games add a second success metric beyond survival, which keeps players chasing points even when they are safe ([Game Developer: style meters in Death of a Wish](https://www.gamedeveloper.com/design/style-meters-and-play-aesthetics-in-death-of-a-wish)).
- **Recommended for Riptide Rush.**
  - Combo timer 2.5 s (matches #1). Shrink to a **floor of 1.6 s** at x10 (rec, #1 says "shrinking slightly", which needs a floor).
  - Multiplier steps every 5 kills (matches #1).
  - Show the next tier threshold on the HUD so a player always has a visible goal (rec).
- **Dash as the reward loop.** Each kill refunds a charge (matches #1). Hyper Light Drifter's dash doubles as a dodge and players can chain it precisely ([Game Developer: how Hyper Light Drifter balances difficulty with fairness](https://gamedeveloper.com/design/how-i-hyper-light-drifter-i-balances-difficulty-with-fairness); [PC Gamer preview](https://pcgamer.com/hyper-light-drifter-preview)). The dash-as-dodge pattern is widely used ([bugnet: dash mechanic](https://bugnet.io/blog/how-to-implement-a-dash-mechanic)).

---

## 6. Difficulty and pacing curves for 2–5 minute arcade runs

- **Roller-coaster waves.** A common pattern is intense waves alternating with short breathers, with difficulty running slightly ahead of the player before their skill catches up. This is described in game-design pattern write-ups; no single primary source was confirmed during research, so treat it as a working model.
- **Avoid spikes and dips.** Perceived difficulty should stay within a range without sudden jumps (*Fundamentals of Game Design*, 2nd ed. — book, no link verified during research).
- **Breather cadence.** One breather of **2–3 s** (no new spawns, existing enemies clear) every **20–30 s** (rec). Adjust after playtests.
- **Run length target.** A first clean run of 2–3 minutes; a skilled run of 5+ minutes (rec). Use spawn budget growth with a cap so the arena does not overflow past 200 entities (matches #1).
- **Adaptive difficulty.** Dynamic difficulty systems such as Left 4 Dead's AI Director aim to keep players in the flow channel. An overview of flow control in game design is at [Flow and flow control](https://www.mediadesign.de/de/news/2017/flow-and-flow-control-how-design-games-player-growth-replay-value-and-great-gaming) (secondary; not checked for the AI Director detail). For Riptide Rush, a simpler rule is enough: scale spawn rate by the player's current combo tier, not by hidden skill estimates (rec).

---

## 7. Common mistakes that make action games feel mushy

- **Over-juice.** Too many responses on routine actions cause fatigue and nausea, and hide the real impacts ([gamejuice: game juice checklist](https://gamejuice.pages.dev/articles/game-juice-checklist-30-techniques)).
- **Long hit-stop.** Freezes over about 120 ms feel laggy ([Godot checklist](https://forum.godotengine.org/t/game-feel-checklist-for-godot-4-hit-stop-trauma-shake-coyote-time-and-more/145340)).
- **Dropped inputs during hit-stop.** A press during a freeze that is lost, not buffered, feels like the game ate the input.
- **Shake on every bullet.** Leads to nausea and removes the signal of big hits.
- **Invisible invulnerability.** If dash i-frames are not visible, players think they got hit through the dash. Show the dash as a bright, unbroken trail (matches #1).
- **Telegraphs that are too short or too long** (see section 4).
- **Colour clutter.** Multiple bullet colours, floaters and particles in the same hue as enemies.
- **Unbounded combo timers.** Players hold a combo by standing still.
- **Sound that does not match the visual.** A kill sound that starts 100 ms after the flash reads as lag.
- **Accessibility gaps.** No motion-reduction setting, no colour-blind mode.

---

## Riptide Rush checklist

Each item is testable. "Playtest" items need a person to check them with a stopwatch or by eye; "automated" items can run under `node --test`.

1. Dash starts within 1 sim tick (8.3 ms) of input, measured in the simulation. *(automated)*
2. Dash visual begins within 1 render frame (16.7 ms) of the simulation starting it. *(playtest, frame capture)*
3. Dash input pressed up to 120 ms before a charge is ready is executed when the charge arrives. *(automated)*
4. A dash input pressed while already dashing is buffered for the dash end, not dropped. *(automated)*
5. Pulse input pressed up to 120 ms before cooldown ends is executed. *(automated)*
6. Pulse reflection within 120 ms of an enemy bullet impact counts as a perfect pulse. *(automated)*
7. Kill hit-stop is 40–70 ms. *(automated)*
8. Multi-kill hit-stop adds 10 ms per extra kill, capped at 100 ms. *(automated)*
9. Inputs pressed during hit-stop are buffered and executed after it. *(automated)*
10. Screen shake peak on a kill is 4–6 px, decays within 150–250 ms. *(automated)*
11. Screen shake is capped at 14 px total. *(automated)*
12. Shake triggers per source are capped at about 4 per second. *(automated)*
13. Motion-reduction setting scales shake to 0 and removes flashes longer than 2 frames. *(playtest)*
14. Kill flash lasts 2–3 render frames at about 60% alpha. *(playtest, frame capture)*
15. Kill particle burst is 8–16 particles, 250–450 ms life, from a pool with a hard cap. *(automated)*
16. Score floater rises 30–40 px over 600–800 ms, fades in its last third. *(automated)*
17. Kill sound starts within 60 ms of the kill event, measured from the event timestamp. *(automated via the audio-call timestamp)*
18. Kill pitch escalates one semitone per combo step and is capped at +12 semitones. *(automated)*
19. Kill sound has an impact transient of 10–20 ms before its tonal layer. *(playtest, audio listen)*
20. Charger telegraph lasts 0.45–0.7 s (current #1 value 0.6 s is inside range). *(automated)*
21. Enemy danger colour and player colour pass a deuteranopia simulation check with clear separation. *(playtest, simulator)*
22. Enemy outlines have at least 3:1 luminance contrast with the background gradient. *(automated, once colours are fixed)*
23. Combo timer resets on every kill and shrinks, but not below 1.6 s at x10. *(automated)*
24. Multiplier increases every 5 kills and is capped at x10. *(automated)*
25. The next combo tier threshold is visible on the HUD. *(playtest)*
26. A breather of 2–3 s with no new spawns occurs at least once per 30 s of play. *(automated, from the wave director)*
27. Spawn count never exceeds 200 entities at the cap. *(automated)*
28. Player damage cause is visible within 300 ms (flash plus sound). *(playtest)*
29. The restart from death screen to playing takes under 300 ms. *(automated timer, matches #1)*
30. Tests run under 10 seconds total. *(automated, matches #1)*

---

## Comparison with issue #1

Issue #1 already covers most of the basics: input buffering, the 40–70 ms kill hit-stop range, shake with decay, particle bursts, dash trail, pitch-rising kill sound, and telegraphs. The checklist above is consistent with those values (the Charger telegraph of 0.6 s is inside the recommended 0.45–0.7 s range). The gaps are where #1 has no number, no cap, or no rule. Each gap is filed as its own `research` issue with rationale and a playtest:

| Gap in #1 | Proposed change | Issue |
|---|---|---|
| Multi-kill hit-stop is "longer" with no value | 40–70 ms plus 10 ms per extra kill, capped at 100 ms | [#9](https://github.com/omkarbhale/riptide-rush/issues/9) |
| Dropped presses during hit-stop not specified | Buffer presses made during hit-stop | [#10](https://github.com/omkarbhale/riptide-rush/issues/10) |
| Combo timer shrinks with no floor | Floor at 1.6 s at x10 | [#11](https://github.com/omkarbhale/riptide-rush/issues/11) |
| Shake has no caps and no reduced-motion option | Numeric caps and a motion-reduction setting | [#12](https://github.com/omkarbhale/riptide-rush/issues/12) |
| Kill-sound pitch escalation has no limit | Cap at +12 semitones | [#14](https://github.com/omkarbhale/riptide-rush/issues/14) |
| Splitter minis can hit on spawn | 0.3 s spawn grace | [#15](https://github.com/omkarbhale/riptide-rush/issues/15) |
| Endless waves have no pacing rule | Breather every 20–30 s, 200-entity cap | [#16](https://github.com/omkarbhale/riptide-rush/issues/16) |
| Stagger and kill feedback are not distinguished | Separate stagger cue | [#17](https://github.com/omkarbhale/riptide-rush/issues/17) |

Numbers marked **(rec)** are recommendations and need playtest confirmation. Sources are linked inline above.
