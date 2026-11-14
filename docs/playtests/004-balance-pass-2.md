# Playtest 004: balance pass 2 (crowd density, earned healing)

Tracked by [#105](https://github.com/omkarbhale/riptide-rush/issues/105). Follows [playtest 003](003-balance-pass.md). Design source: [DESIGN.md §7.5](../DESIGN.md) and §3.9a. Harness: `tools/bot/run.mjs`.

The brief had two problems: healing regressed (a hurt player could not recover), and the arena was too empty for flow (about 10 enemies alive, so an expert made about 80 actions per minute). This pass changes the crowd and the heal rules, and makes the bots measure more.

## How to reproduce

```
node tools/bot/run.mjs            # 300 seeds per policy, 300 s cap; prints the metrics and the targets table
node tools/bot/run.mjs --runs 60  # quick check
node --test                       # 211 tests
```

The full run takes several minutes on a loaded machine (the crowd costs about 3–4× the sim time of 003). Budget for it.

## Result against the targets

300 seeds per policy on the final build (`fm/rr-balance2`, on top of `origin/main` at the time of writing). Full output: `tools/bot/run.mjs`.

| Policy | Measure | 003 (before) | 004 (after) | Target | Holds |
| --- | --- | --- | --- | --- | --- |
| Expert | median actions per minute (dashes + pulses) | 81 | 196 | ≥ 110 | yes |
| Expert | average dash kills per dash | 2.22 | 4.44 | ≥ 2 | yes |
| Expert | median survival | 266 s | 300 s (cap) | ≥ 200 s | yes |
| Expert | average enemies alive in tension waves (wave 3 on) | about 10 | 25.8 | 25–45 | yes |
| Expert | median time below full health before a heal | n/a | 2.1 s | < 45 s | yes |
| Intermediate | median survival | 224 s | 300 s (cap) | 120–240 s | **no** |
| Intermediate | share reaching the 300 s cap | 25% | 68% | < 15% | **no** |
| Intermediate | median time below full health before a heal | n/a | 3.3 s | < 45 s | yes |
| Beginner | median survival | 106 s | 151 s | 70–120 s | **no** |
| Beginner | worst wave death rate (waves reached by 30+ runs) | 76% | 63% | ≤ 45% | **no** |
| Every policy | invariant violations | 0 | 0 | 0 | yes |
| Every policy | runs with a stalled wave | 0 | 0 | 0 | yes |

Six of eleven measured targets hold. Five do not. The brief asked for these to be reported plainly, so each miss is explained below.

## Heal rate per policy

| Policy | Heals per run | Heals per minute of run | Time below full health (share of run) | Heal sources (300 runs) |
| --- | --- | --- | --- | --- |
| Beginner | 1.9 | 0.74 | 30% | combo orb 455, random drop 117 |
| Intermediate | 5.7 | 1.21 | 15% | combo orb 1357, random drop 326, flawless 13 |
| Expert | 1.9 | 0.37 | 2.5% | combo orb 503, random drop 50, flawless 5 |

"Time below full health before a heal" is the time from first losing HP (or from the last heal, if still hurt) to the heal that ends it. The median is 2.1 s (expert), 3.3 s (intermediate) and 11 s (beginner).

Read this with care. The brief expected a hurt chaining player to get a hit point back about every 30–45 s. The combo-20 orb caps heals at one per 25 s, and that cap is met. But a chaining player is almost always at combo 20 or more, so the orb is usually ready the moment Rip is hit. The cooldown rarely binds, and chainers recover in seconds, not 30–45 s. That is the real outcome of the rule as specified. It is the main reason the intermediate survives so long (see below). Whether the owner wants the 25 s cap to bind more often is a design decision, and it is raised in the summary for that reason.

## Why the misses hold

**Intermediate (median 300 s, 68% reach the cap).** Its hits come mostly from Drifter contact (73%) and Shellback bounces (20%). It takes about six hits a run and recovers from each in about 3 s, from combo-20 orbs that are almost always ready. Each Drifter touches only a player who stops, and the bot keeps moving, so contacts are rarer than the crowd size suggests. Meeting the target would take either less healing for chainers (the rule is 25 s by spec, so this is a design choice) or more contact per second. Making contacts more frequent would change lethality, and the brief says to scale the count, not the lethality. I did not bend the bot to get there.

**Beginner (median 151 s, worst wave 63%).** Most of its damage comes from Spitter bullets (about 57% in the last measurement). It heals too, because one dash through a school builds a combo quickly. The beginner now sees bullets after 400 ms and sidesteps about half of them, as the brief asked, and that is what the harness was given. The crowd also makes every dash a multi-kill, which feeds combo-20 orbs to a player who barely aims. Bringing the beginner inside 70–120 s without changing the heal rule or the Spitter counts is not possible with these levers. I did not tune the beginner against its own target.

**Expert alive count (first measured at 22.8, now 25.8).** This one moved into the band with a faster school cadence (0.25 s to 0.20 s, which lifts supply above what the expert can clear). It is the closest call, and its margin is small.

## What changed

- **Healing.** A hurt player who reaches combo 20 is owed a heal orb at the next kill, at most once per 25 s (`PICKUP.heal.comboTrigger`, `comboInterval`). The orb waits, due, while the field is full or the drop spacing is still running. A release wave that cost no HP while it was live heals 1 HP if Rip is hurt. Tension waves heal nothing. Random orbs were too frequent in a crowd (the intermediate got about 2 per run), so the base chance dropped to 0.2% per kill (0.5% per missing HP) and the pity to 300 hurt kills.
- **Crowd.** A crowd director keeps the live Drifters under a target that climbs from 26 at wave 1 to 50, counting live Drifters only, so warnings can show ahead. Drifter schools are 5–8 (a school of 9 stays whole). Schools are released every 0.2 s from different sides, spawning at least 560 px from Rip. A non-release wave hands over when its last school is released, so the next wave's warnings show while the current schools are still alive.
- **Caps.** Simultaneous Spitters are capped at 2, rising to 5. Chargers are capped at 2, rising to 4. Drifters are never capped.
- **Waves.** Waves 3–20 carry 150–240 Drifters each; wave 21 carries 86. The budget beyond wave 20 is 120 + 12k, with Drifters taking 60% of it.
- **Harness.** The beginner now sees a bullet after 400 ms and reacts to about half of them. Reports add heal rate and source, time below full health, and enemies alive in tension waves. The target thresholds were updated to the brief's: beginner 70–120 s and ≤ 45%, intermediate 120–240 s, expert ≥ 200 s and ≥ 2 kills per dash.

Results are **not like-for-like with 003**. The beginner change alone moves its numbers, and the crowd changes every policy.

## Known caveat in the crowd

Waves are long now. Each Drifter wave (150–240) holds the crowd for a while, so the wave number rises more slowly in real time. The 60-second playtest run (below) reached wave 4 in one run, and wave 3 in others, after about two minutes. The harness does not report the wave the intermediate reaches at 300 s, so I have not claimed a figure for it; the per-wave table in the full run output has the answer.

Release waves still clear and breathe for 2.5 s before the next wave can start. Right after one, the field is empty for about 4–5 s, and that gap is inside the "tension" metric for the wave that follows. I kept the 2.5 s breather because it is part of the release-wave design (§7.4).

## Browser check (not complete)

Served the worktree with `python3 -m http.server 8447` and drove it with `chrome-devtools-axi`. The title screen renders. A scripted run (random WASD and Space, with a dash on about 60% of ticks) reached **wave 4** with the crowd on screen, and the console had **no errors** across the runs. The wave 4 screenshot shows a school crowd on screen. It is attached to the PR comment, not committed.

**Wave 5 was not reached in any scripted run.** Random input does not survive the large release waves long enough. The brief's gate ("reaching at least wave 5 with zero console errors") is therefore **not met yet**. Clearing it needs a real player, or a bot that aims, and the run should be repeated before merge.

## Issues

- **Out of scope, not filed:** the second perfect-pulse slow-motion (#104) is still open and unchanged. The renderer's load with 150+ enemies on screen belongs to #102 (renderer pass) and was not measured here.
