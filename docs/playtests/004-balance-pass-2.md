# Playtest 004: balance pass 2 (crowd density, earned healing)

Tracked by [#105](https://github.com/omkarbhale/riptide-rush/issues/105). Follows [playtest 003](003-balance-pass.md). Design source: [DESIGN.md §7.5](../DESIGN.md) and §3.9a. Harness: `tools/bot/run.mjs`. The build includes the #114 enemy roster (merged from `origin/main`).

The brief had two problems: healing regressed (a hurt player could not recover), and the arena was too empty for flow (about 10 enemies alive, so an expert made about 80 actions per minute). This pass changes the crowd and the heal rules, and makes the bots measure more.

## How to reproduce

```
node tools/bot/run.mjs            # 300 seeds per policy, 300 s cap; prints the metrics and the targets table
node tools/bot/run.mjs --runs 60  # quick check
node --test                       # 363 tests
```

A full run takes about 10 minutes on a loaded machine. The crowd costs about 3–4× the sim time of 003.

## Result against the targets

300 seeds per policy, on the merged build (this branch with `origin/main` at `5a9a6b8`, #114 included). Full output: `tools/bot/run.mjs`.

| Policy | Measure | 003 (before) | 004 (after) | Target | Holds |
| --- | --- | --- | --- | --- | --- |
| Expert | median actions per minute (dashes + pulses) | 81 | 188 | ≥ 110 | yes |
| Expert | average dash kills per dash | 2.22 | 4.30 | ≥ 2 | yes |
| Expert | median survival | 266 s | 300 s (cap) | ≥ 200 s | yes |
| Expert | average enemies alive in tension waves (wave 3 on) | about 10 | 25.1 | 25–45 | yes (by a small margin) |
| Expert | median time below full health before a heal | n/a | 2.6 s | < 45 s | yes |
| Intermediate | median survival | 224 s | 300 s (cap) | 120–240 s | **no** |
| Intermediate | share reaching the 300 s cap | 25% | 81% | < 15% | **no** |
| Intermediate | median time below full health before a heal | n/a | 3.2 s | < 45 s | yes |
| Beginner | median survival | 106 s | 154 s | 70–120 s | **no** |
| Beginner | worst wave death rate (waves reached by 30+ runs) | 76% | 56% (wave 10, the Warden) | ≤ 45% | **no** |
| Every policy | invariant violations | 0 | 0 | 0 | yes |
| Every policy | runs with a stalled wave | 0 | 0 | 0 | yes |

Six of eleven measured targets hold; five do not. Each miss is explained below.

## Heal rate per policy

| Policy | Heals per run | Heals per minute of run | Time below full health (share of run) | Heal sources (300 runs) |
| --- | --- | --- | --- | --- |
| Beginner | 2.3 | 0.78 | 34% | combo orb 518, random drop 158, Warden 5 |
| Intermediate | 5.8 | 1.20 | 14% | combo orb 1358, random drop 296, Warden 72, flawless 8 |
| Expert | 2.4 | 0.48 | 3.7% | combo orb 511, random drop 58, Warden 151, flawless 5 |

"Time below full health before a heal" runs from the first HP lost (or from the last heal, if still hurt) to the heal that ends it. The median is 2.6 s (expert), 3.2 s (intermediate) and 14 s (beginner).

Read this with care. The brief expected a hurt chaining player to get a hit point back about every 30–45 s. The combo-20 orb caps heals at one per 25 s, and that cap holds. But a chaining player is almost always at combo 20 or more, so the orb is usually ready the moment Rip is hit. The cooldown rarely binds, and chainers recover in seconds. That is the outcome of the rule as specified, and it is the main reason the intermediate survives so long. Whether the 25 s cap should bind more often is a design decision for the owner.

The Warden's heals (#114) count in the expert and intermediate totals. They are a separate source and are not part of the combo rule.

## Why the misses hold

**Intermediate (median 300 s, 81% reach the cap).** Its hits come mostly from Drifter contact and Shellback bounces, about six a run. It recovers from each in about 3 s, from combo-20 orbs that are almost always ready. Drifters only hurt a player who stops, and the bot keeps moving, so contacts are rarer than the crowd size suggests. Meeting the target would take less healing for chainers (the 25 s cap is in the brief, so that is a design choice) or more contact per second. Contact per second would change lethality, and the brief says to scale the count, not the lethality. I did not bend the bot to get there.

**Beginner (median 154 s; worst wave 56%).** Its worst wave is wave 10, the Warden's boss wave: 133 of the 238 runs that reach it die there. Most of its damage elsewhere comes from Spitter bullets. It heals too, because one dash through a school builds a combo quickly. The beginner now sees bullets after 400 ms and sidesteps about half of them, as the brief asked. Bringing it inside 70–120 s without changing the heal rule or the Warden would need a larger change to wave 10, which is #114's design. I did not tune the beginner against its own target.

**Expert alive count (25.1).** Inside the band, but barely. The faster school cadence (0.2 s) is what lifts it above the expert's clearing rate. A small change to the crowd would move it out of the band, so treat it as borderline.

## What changed

- **Healing.** A hurt player who reaches combo 20 is owed a heal orb at the next kill, at most once per 25 s (`PICKUP.heal.comboTrigger`, `comboInterval`). The orb waits, due, while the field is full or the drop spacing is still running. A release wave that cost no HP while it was live heals 1 HP if Rip is hurt. Tension waves heal nothing. Random orbs were too frequent in a crowd (the intermediate got about 2 per run), so the base chance dropped to 0.2% per kill (0.5% per missing HP) and the pity to 300 hurt kills.
- **Crowd.** A crowd director keeps the live Drifters under a target that climbs from 26 at wave 1 to 50. It counts live Drifters only, so warnings can show ahead. Drifter schools are 5–8 (a school of 9 stays whole). Schools are released every 0.2 s from different sides, spawning at least 560 px from Rip. A non-release wave hands over when its last school is released, so the next wave's warnings show while the current schools are alive.
- **Caps.** Simultaneous Spitters are capped at 2, rising to 5. Chargers are capped at 2, rising to 4. Drifters are never capped.
- **Waves.** Waves 3–20 carry 150–240 Drifters each; wave 21 carries 86. The budget beyond wave 20 is 120 + 12k, with Drifters taking 60% of it. The #114 kinds (Puffer, Shield Bearer, Ink Squid, Phase Eel, and the Warden at waves 10 and 20) stay on their waves at #114's low counts.
- **Boss hold (a deviation).** #114 held a boss wave until its boss died. A bot that never kills the Warden then stalls the run, and the brief forbids stalled waves. A boss wave now holds for at most `SPAWN.bossHoldLimit` (60 s), then hands over as usual. A living Warden stays in the field. The owner should confirm this is the intended trade-off.
- **Harness.** The beginner sees a bullet after 400 ms and reacts to about half of them. The checker knows the #114 event types and the lure bonus that rides on kill points. Reports add heal rate and source, hurt time, and enemies alive in tension waves. The targets are the brief's thresholds.

Results are **not like-for-like with 003**. The beginner change alone moves its numbers, and the crowd changes every policy.

## Browser check (not complete)

Served the worktree with `python3 -m http.server` and drove it with `chrome-devtools-axi`. The title screen renders. A scripted run (random WASD and Space, with a dash on about 60% of ticks) reached **wave 4** with a crowd on screen, and the console had **no errors**. The wave 4 screenshot is attached to the PR comment, not committed.

**Wave 5 was not reached in any scripted run.** Random input does not survive the large release waves long enough. The brief's gate ("reaching at least wave 5 with zero console errors") is therefore **not met**. Clearing it needs a real player, or a bot that aims, and it should be repeated before merge.

## Issues

- **Not filed, out of scope:** the second perfect-pulse slow-motion (#104) is still open and unchanged. The renderer's load with 150+ enemies on screen belongs to #102 (renderer pass) and was not measured here.
