# Replayability: reasons to play Riptide Rush again

Status: v1 proposal. Tracks [#113](https://github.com/omkarbhale/riptide-rush/issues/113). Builds on [#1](https://github.com/omkarbhale/riptide-rush/issues/1) and [`docs/DESIGN.md`](../DESIGN.md). Where this document and `DESIGN.md` disagree, `DESIGN.md` wins until the change is agreed in #1 and merged there.

**Conventions.** Every value below is marked either `#1`, `DESIGN §x` (already defined in `DESIGN.md`), or `proposed` (a tuning starting point to playtest). The v1 items each have a GitHub issue with acceptance criteria (listed in §5).

---

## 1. The problem

A run is endless waves until Rip dies. A competent player reaches wave 8 in two to three minutes, and an expert runs past wave 15 (`DESIGN §7.2`). That is already the right length for "one more run". What is missing is a reason to start the *next* run rather than quit:

- **No goal beyond the high score.** The only persistent number is one local high score (`riptide.highscore.v1`). Once beaten, there is nothing left to chase.
- **No shared target.** Every run is a fresh random roll, so nobody can compare a result with a friend or a day.
- **No variety of rules.** Every run plays by the same rules, so skill plateaus quickly.
- **No memory of play.** The game forgets how each run went, so death does not teach the player anything beyond the score.

**Constraints the answer must respect**

- No accounts and no server. Everything is `localStorage`, read inside try/catch (`DESIGN §8`).
- No build step and no npm dependencies (`#1`).
- The telegraphs, hit-stop, and floaters are never optional (`DESIGN §8`). Mutators and challenges may change rules, but they may not hide danger.
- "Scales with skill, never gates" (`DESIGN §1`, pillar 5). Reasons to replay should not lock the core game behind unlocks.
- Death-to-playable stays under 300 ms (`#1`). Anything shown on the death card must not delay restart.

---

## 2. What the public writing says

These are my summaries in my own words, from the sources listed. Where a claim rests on a search snippet rather than a full read, I say so in §8.

- **Score-chasing needs a readable scoring system.** Arcade-style scoring works when the player can see *why* a score moved and what would raise it next. This is the case for keeping combo, multiplier, and floaters visible and immediate. Source: [itch.io, "What makes a great scoring system: lessons from the arcade"](https://itch.io/blog/810141/what-makes-a-great-scoring-system-lessons-from-the-arcade).
- **Failure should teach, and the next try should look winnable.** Players keep trying when each loss feels like a lesson and a visible step toward mastery. Source: [Gamespace, "How modern games are bringing back classic arcade progression"](https://gamespace.com/all-articles/news/how-modern-games-are-bringing-back-classic-arcade-progression/).
- **Mastery drives roguelike-style replay, and the same lessons transfer to other genres.** Tom Cadwell's GDC 2015 talk argues that the roguelike's long replay life comes from the pursuit of mastery, and that other designs can borrow from it. Source: [GDC, "Level Up Your Game: The Untapped Potential of Roguelikes"](https://www.gdconf.com/news/learn_how_roguelike_design_can).
- **Special modes give experienced players new problems rather than new content.** A rules variant pushes players to adapt what they already know, which renews interest without adding a new level. Source: [Game Developer, "Special Game Modes in a Roguelike Context"](https://www.gamedeveloper.com/design/special-game-modes-in-a-roguelike-context).
- **Daily runs work when everyone gets the same seed, derived from the date.** A date-derived seed lets the same run be reproduced without a server, and fairness comes from the shared input rather than secrecy. Source: [DEV Community, "One seed, same puzzle for everyone"](https://dev.to/gowtham_r_2002/one-seed-same-puzzle-for-everyone-seeded-rng-for-a-fair-daily-challenge-1h7d). Daily modes in a commercial game: [Yacht Club Games, "Delve into Daily Mode"](https://www.yachtclubgames.com/blog/daily-mode), and [Binding of Isaac wiki, "Daily challenge"](https://bindingofisaacrebirth.wiki.gg/wiki/Daily_challenge).
- **A spoiler-free result string spreads a game.** Wordle's share grid let people brag about a result without spoiling the answer, and each post raised curiosity in people who had not played. Source: [Smithsonian, "Here's why the word game Wordle went viral"](https://www.smithsonianmag.com/smart-news/heres-why-the-word-game-wordle-went-viral-180979439/) and [The Spinoff, on the coloured-box posts](https://thespinoff.co.nz/media/13-01-2022/those-coloured-boxes-on-twitter-are-new-zealands-fault).
- **Ghosts make the best run a visible opponent.** Several recent games let the player race a recording of their best run. Two notes from developers: ghosts should be small and accurate, and replays that depend on frame timing drift if the frame rate changes. Sources: [Messenger Mouse devlog, "Record and replay: ghost races"](https://troystorygames.itch.io/messenger-mouse/devlog/945109/record-and-replay-ghost-races), and [Vice, on Neon White's developers and their ghost system](https://www.vice.com/en/article/neon-whites-developers-being-too-good-at-their-own-game-caused-real-problems).
- **Optional difficulty modifiers are a long-term loop when the player chooses them.** Hades' Pact of Punishment lets players stack difficulty for bigger rewards, and the game keeps the modifiers opt-in. Source: [RPG Site, "Hades: Pact of Punishment, Heat, modifiers and how to maximize your rewards"](https://www.rpgsite.net/feature/10287-hades-pact-of-punishment-heat-modifiers-and-how-to-maximize-your-rewards).
- **Unlocks and short runs work together.** Analyses of Vampire Survivors credit the unlock screen with bringing players back for another short run, and credit the "just one more go" feel to short runs with no cost to restarting. Source: [The Loop & Ledger, "The overlooked but humble magic sauce of Vampire Survivors"](https://loopandledger.beehiiv.com/p/the-overlooked-but-humble-magic-sauce-of-vampire-survivors).

**What this means for Riptide Rush**

1. Show the *why* of every score change. The combo and floaters already do this; the death card should extend it to the whole run.
2. A daily seed gives a shared target with no server. The seeded RNG is also the foundation for ghosts later.
3. Rules variants are cheap ways to renew skill, but only if they are optional and keep telegraphs.
4. Record the result in a form people want to share, and keep it spoiler-free.

---

## 3. Idea bank (25 ideas)

**Rating scale.** Each idea is rated 1–5 on three axes.

- **Fun**: 5 means it is likely to make the player want the next run.
- **Clarity**: 5 means the player understands the reward or rule at a glance.
- **Cost**: 5 means the most implementation work, counting code, data, and UI. 1 means a few lines.

| # | Idea | What it is | Fun | Clarity | Cost | Notes |
|---|---|---|:-:|:-:|:-:|---|
| 1 | Daily Tide | Same seeded run for everyone each UTC day | 4 | 4 | 3 | Needs a seeded RNG for sim-affecting randomness. **v1** |
| 2 | Share string | Spoiler-free result line for the day's run | 3 | 5 | 1 | Ships with Daily Tide. **v1** |
| 3 | Seed link | `?seed=` in the URL to challenge a friend | 3 | 4 | 1 | Cheap once seeding exists. v2 |
| 4 | Daily mutator | One rules change chosen from the day's seed | 4 | 4 | 2 | Part of Daily Tide. **v1** |
| 5 | Challenge: One Life | 1 HP, heal drops off | 4 | 5 | 1 | Single flag. **v1** |
| 6 | Challenge: No Pulse | Pulse disabled, personal best per mode | 4 | 5 | 1 | Single flag. **v1** |
| 7 | Challenge: Time Attack | 90 s, score is everything | 3 | 5 | 2 | Needs run-length hold. v2 |
| 8 | Run mutators | Persistent mutators the player picks | 3 | 3 | 3 | Overlaps with Daily Tide's mutator. v2 |
| 9 | Medals | Bronze, silver, gold by run score | 3 | 5 | 2 | Thresholds need the balance pass's numbers. **v1** |
| 10 | Achievements | Lifetime list of skill feats | 3 | 4 | 2 | Stored locally, shown between waves. **v1** |
| 11 | Score-milestone trails | Lifetime score unlocks Rip's trail colour | 3 | 4 | 2 | Cosmetic only. **v1** |
| 12 | Palette unlocks | Lifetime score unlocks a background palette | 2 | 3 | 3 | Must keep danger colours readable. v2 |
| 13 | Ghost of best run | Race a recording of your best run | 5 | 4 | 5 | Needs a deterministic sim replay. v2 |
| 14 | Ghost-lite milestones | Faint markers of where the best run hit each wave | 3 | 4 | 2 | Cheap ghost substitute. v2 candidate |
| 15 | Death recap | Cause, run stats, and a tip on the death card | 4 | 5 | 2 | Tracks death cause. **v1** |
| 16 | Delta to best | "+340 to beat your best" on the death card | 4 | 5 | 1 | Part of the recap. **v1** |
| 17 | Combo goal card | "Reach combo 40" objective before a run | 3 | 4 | 2 | Gives a target without changing rules. v2 |
| 18 | Best wave splits | Personal best per wave reached | 2 | 5 | 1 | Lower fun, cheap. v2 |
| 19 | Hall of fame | Local top-5 scores (`DESIGN` Q10) | 2 | 5 | 1 | Already an open question. v2 |
| 20 | Streak of dailies | Count of consecutive days played | 2 | 4 | 1 | Retention lever, but risks guilt. v2 |
| 21 | Death replay | Rewind about 3 s and replay the death in slow motion | 4 | 3 | 4 | Needs a state history buffer. v2 |
| 22 | Score card image | Shareable PNG from a canvas render | 3 | 4 | 3 | Uses canvas `toBlob`. v2 |
| 23 | Scripted drills | Fixed dash puzzles, e.g. ten Shellback angles | 3 | 3 | 3 | Teaches, does not replay. v2 |
| 24 | Pulse-streak challenge | Reflect N bullets with consecutive pulses | 3 | 4 | 2 | Could be an achievement. v2 |
| 25 | Start-screen mode row | Choose Standard, Daily, or a challenge | 3 | 5 | 2 | UI for ideas 1, 5, 6. **v1** |

**Reading the table.** The cheapest high-fun ideas are the challenge flags (5, 6), the delta to best (16), and the share string (2). The most fun idea is the ghost (13), and it is expensive. Ghost and Daily Tide both need deterministic simulation, so Daily Tide comes first.

---

## 4. Choosing the v1 set

Selection criteria, in order:

1. **Works without a server.** Everything reads and writes `localStorage`.
2. **Foundation for later.** Daily Tide's seeded RNG enables ghosts and seed links.
3. **Clear to a new player.** Each item explains itself on screen.
4. **Cheap enough to ship in one round.** Each v1 item touches a few files and one UI surface.

The v1 set is five items: Daily Tide with its share string and daily mutator; challenge modes One Life and No Pulse; the death recap with delta to best; medals and achievements; and score-milestone trail unlocks. Together they cover the four needs in §1: a shared target, variety, memory of play, and a long-term goal.

Ghosts are deferred to v2 on purpose. They need Daily Tide's deterministic replay first, and they are the most expensive item in the bank.

---

## 5. v1 specifications

Each item has one issue. The issue carries the acceptance criteria. The rules here are the source of truth.

| Item | Issue |
|---|---|
| 5.1 Daily Tide and share string | [#115](https://github.com/omkarbhale/riptide-rush/issues/115) |
| 5.2 Challenge modes: One Life and No Pulse | [#116](https://github.com/omkarbhale/riptide-rush/issues/116) |
| 5.3 Death recap and delta to best | [#117](https://github.com/omkarbhale/riptide-rush/issues/117) |
| 5.4 Medals and achievements | [#118](https://github.com/omkarbhale/riptide-rush/issues/118) |
| 5.5 Score-milestone trail unlocks | [#119](https://github.com/omkarbhale/riptide-rush/issues/119) |

**Overlap with #110.** Issue [#110](https://github.com/omkarbhale/riptide-rush/issues/110) (screens: animated title, how-to-play, run summary with medals, top-5 scores) covers part of §5.3 and §5.4. Its run summary and medal display should be built once, under whichever issue lands first. The rules in this document decide the medal thresholds and recap fields; #110 owns the screen layout.

### 5.1 Daily Tide and share string

**Why.** A date-derived seed gives everyone the same run each day with no server. The share string lets players compare results without spoiling the run (ideas 1, 2, 4).

**Rules.**

- The seed is the UTC date as `YYYY-MM-DD`, hashed to a 32-bit integer (FNV-1a), then used to seed a small PRNG (mulberry32). `proposed`.
- Every random choice that affects the simulation goes through an injected `rng()` function. Standard runs use the same interface with `Math.random`. Particles, floaters, and other visuals may keep using `Math.random`. `proposed`.
- Daily runs use the same waves, school formations, mine placement, and pickup drops for every player on the same date. Enemy behavior after spawn is also deterministic, so the day is reproducible given the same inputs. `proposed`.
- One **daily mutator** is chosen from the seed, `seed mod 3`, from this list. Each mutator keeps every telegraph (`DESIGN §8`):
  - **Swift School**: Drifter and school speeds ×1.25.
  - **Short Fuse**: mines arm after 0.4 s instead of 0.8 s. The ring still speeds up as the fuse runs.
  - **Thin Reserve**: maximum dash charges 2 instead of 3. Kill refunds still apply, capped at 2.
- Attempts are unlimited. The **best** score of the day counts. There is no first-attempt rule, so practice does not cost the day (`DESIGN §1`, "scales with skill, never gates").
- **Share string** (copied to the clipboard, spoiler-free, does not contain the seed's inputs):

  `RIPTIDE RUSH 2026-11-14 · 4,812 · wave 9 ▮▮▮▮▮▮▮▮▮▯ · Short Fuse`

  The bar has 10 cells, filled up to `min(wave, 10)`. The mutator name is last. The format is fixed so results can be compared by eye.

**Data (localStorage).**

- `riptide.daily.v1`: `{ "2026-11-14": { "best": 4812, "wave": 9, "combo": 23, "plays": 3 } }`. Keep the last 30 dates and drop older ones.

**UI placement.**

- **Start screen (BOOT, after the first gesture).** A two-option row, `STANDARD` and `DAILY TIDE`, with today's date, the mutator name, and today's best if any. This is the only place mode is chosen. It does not appear during play (`DESIGN §1`, pillar 1, "no menu during play").
- **Death card.** A `SHARE` button, and a line "Daily best 4,812" when the run was a daily.
- **Restart (R or click).** Keeps the current mode. Restart still completes under 300 ms.

**State change.** Adding BOOT mode selection changes `DESIGN §4.1`. That change is agreed in #1 and then merged to `DESIGN.md`, as `#1` requires.

**Acceptance criteria** are in the issue for this item.

### 5.2 Challenge modes: One Life and No Pulse

**Why.** Rules variants give experienced players new problems without adding content (idea 5, 6).

**Rules.**

- **One Life.** Max HP is 1. Heal orbs and flawless-wave heals are disabled (`DESIGN §3.9a`). Modifier drops are unchanged. Death ends the run as normal. `proposed`.
- **No Pulse.** The Pulse input is ignored, along with its buffer. Perfect-pulse bonuses and slow-motion never trigger. Enemy bullets are not reflected. Without Pulse, a Shellback cannot be staggered, so it must be struck from the side or behind. `proposed`.
- Challenge modes are chosen on the start screen alongside Standard and Daily. A challenge run can be a daily only in a later version; in v1 they are separate.

**Data (localStorage).**

- `riptide.challenges.v1`: `{ "one-life": { "best": 3100, "wave": 7 }, "no-pulse": { "best": 2480, "wave": 6 } }`.

**UI placement.** The start screen mode row (§5.1) gains two more entries. The death card shows the challenge's best beside the run score, labelled with the challenge name.

**Acceptance criteria** are in the issue for this item.

### 5.3 Death recap and delta to best

**Why.** The player learns from the run, not just the score. Showing "+340 to beat your best" makes the next try feel close (ideas 15, 16).

**Rules.**

- Track these per run: `cause` (the enemy type of the killing hit), `kills`, `longestChain` (most kills in one dash), `maxCombo`, `dashes`, `perfectPulses`, and `timeSurvived`.
- **Cause tips.** One tip per cause, shown on the death card. `proposed` wording:
  - Drifter contact: "Drifters only hurt on contact. Dash through them, don't wait for them."
  - Spitter bullet: "A Spitter's aim line shows where the shot goes. Pulse it back."
  - Charger lunge: "The Charger's line is a 0.6 s warning. Swim across it early."
  - Shellback contact: "Its armor covers the front. Dash from the side, or Pulse it first."
  - Splitter or mini contact: "Minis are fast and short-lived. Let them come, then dash through."
  - Mine blast: "Mines arm after you come near. Dash through one to defuse it."
- **Delta to best.** Compare the run score with the best of the same mode. If the run beats the best, show `NEW BEST`. Otherwise show `+N to beat your best`, or `-N from your best`. `proposed`.
- The recap is part of the death card. It renders after the 150 ms input gate and never delays restart. If it is slow to render, the restart still works.

**Data (localStorage).**

- `riptide.bests.v1`: `{ "standard": { "score": 12400, "wave": 11, "combo": 38, "date": "2026-11-12" }, "lastRun": { ...same fields... } }`.

**UI placement.** Death card, between the score and the buttons. Three rows: the cause line with its tip, a stats row, and the delta line.

**Acceptance criteria** are in the issue for this item.

### 5.4 Medals and achievements

**Why.** Medals give a short-term target on every run. Achievements give a long-term list of skill feats (ideas 9, 10).

**Rules.**

- **Medals** are per mode, from the run's final score on the Standard mode only in v1. Bronze at 2,000, silver at 6,000, gold at 12,000. `proposed`; tune with the balance pass's numbers. A medal shows as a coin on the death card. Medals are not awarded in challenge or daily runs in v1.
- **Achievements** (eight, lifetime, each unlocked once). `proposed`:
  - **First Blood**: first kill.
  - **Chain Reaction**: five kills in one dash.
  - **Reflector**: reflect 50 bullets, lifetime.
  - **Perfect Pulse**: one perfect pulse.
  - **White Tide**: reach combo 40.
  - **Mine Sweeper**: defuse 10 mines, lifetime.
  - **Untouched**: clear a wave without taking damage.
  - **Deep Wave**: reach wave 10 in one run.
- Achievements are checked at the moment of the event and written at run end, so a crash mid-run loses at most the current run. `proposed`.

**Data (localStorage).**

- `riptide.medals.v1`: `{ "medals": { "standard": "gold" }, "achievements": { "first-blood": "2026-11-12" } }`.

**UI placement.**

- Medal: death card, beside the score.
- Achievement toast: top-centre, shown during the 2.0 s intermission (`DESIGN §7.2`), never during play. This keeps play unchanged.

**Acceptance criteria** are in the issue for this item.

### 5.5 Score-milestone trail unlocks

**Why.** Lifetime score is a long-term goal that never ends, and it costs no gameplay balance (ideas 11).

**Rules.**

- **Lifetime score** is the sum of all run scores, written at run end. `proposed`.
- Milestones and trails. `proposed`:

  | Lifetime score | Trail unlocked |
  |---|---|
  | 10,000 | Cyan (default, always on) |
  | 50,000 | Gold |
  | 150,000 | Green |
  | 400,000 | Violet |
  | 1,000,000 | White |

- A trail colours Rip's dash trail and afterglow only. It must not use danger magenta `#ff3d81` or bullet amber `#ffb347` (`DESIGN §3.10`). Enemies, bullets, telegraphs, and pickups always use the default palette, so danger stays readable.
- Trail colours must keep a contrast ratio of at least 3:1 against the background `#050a18` (WCAG non-text contrast). `proposed`.

**Data (localStorage).**

- `riptide.cosmetics.v1`: `{ "lifetimeScore": 153200, "selectedTrail": "gold", "unlocked": ["cyan", "gold", "green"] }`.

**UI placement.**

- **Options panel** (`DESIGN §8`): a "Trail" row with the unlocked trails as swatches. Locked swatches show the score needed.
- **Unlock toast**: top-centre during the intermission, same as the achievement toast.

**Acceptance criteria** are in the issue for this item.

---

## 6. Deferred to v2 (and why)

- **Ghost of best run (13).** Highest fun, highest cost. Needs Daily Tide's deterministic replay, and the developer notes in §2 warn that frame-timed recordings drift. Build it on fixed-step input recording.
- **Seed link (3).** Cheap once seeding exists. Deferred to keep v1 to one new concept, the daily seed.
- **Time attack (7).** Needs a run-length hold and a new end state. Worth doing after playtest shows whether the 2–5 min target is right.
- **Hall of fame (19).** Already open as `DESIGN` Q10. Keep it out of v1 so the reasons-to-replay work does not depend on it.
- **Streak of dailies (20).** Retention lever with a guilt risk. Playtest first.

---

## 7. Open questions for playtest

Each question has a proposed answer. The playtest decides.

1. **Is one mutator a day enough variety?** Proposed: yes. Revisit if players stop trying daily runs after day three.
2. **Should a challenge run count toward the medal?** Proposed: no in v1, to keep medals about the standard game.
3. **Is the medal threshold right?** Proposed: 2,000, 6,000, and 12,000. Tune after the balance pass's numbers settle.
4. **Does the share string get shared?** Proposed: measure it through playtests, not analytics. There is no server, so ask testers directly.
5. **Are the cause tips read?** Proposed: test whether a player who reads the tip plays the next run differently.

---

## 8. Sources and confidence

**Read in full.** None. I worked from search results and snippets, not full articles, so the summaries in §2 are my reading of those snippets. Before a claim goes into `DESIGN.md`, someone should read the full source.

**Confidence by source.**

- **Higher.** Smithsonian on Wordle, the GDC 2015 talk listing, and the Game Developer piece on special modes. These are established outlets or event pages.
- **Medium.** Yacht Club Games, Binding of Isaac wiki, Gamespace, The Loop & Ledger, Vice, and RPG Site. Credible but mostly journalism or community writing.
- **Lower.** DEV Community, itch.io, and the Messenger Mouse devlog. Practitioner notes, useful as ideas rather than evidence.

**Known gaps.**

- I did not find a developer write-up on the design goals of Hades' Pact of Punishment. The "optional" reading in §2 is an inference from how the system works.
- The claim that Vlambeer or Mark Brown wrote on ghost runs could not be confirmed, so I have not cited them.
- No retention numbers. Every retention claim above is a design argument, not a measured result.
