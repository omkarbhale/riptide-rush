# Enemies, hazards, pickups and waves

Status: proposal for [#8](https://github.com/omkarbhale/riptide-rush/issues/8). Part of the game defined in [#1](https://github.com/omkarbhale/riptide-rush/issues/1).

This document follows the architecture and numbers in #1 exactly: 1280x720 logical arena, player top speed 330 px/s, dash 210 px in 0.12 s with 3 charges that each recharge in 0.9 s, every kill refunds one charge, Pulse radius 110 px with a 2.5 s cooldown, a perfect Pulse within 0.12 s of impact, 3 hit points, about 1 s of invulnerability after a hit, a 2.5 s combo timer, and a score of base x multiplier with multiplier = 1 + floor(combo/5) capped at x10.

Ratings used throughout are on a 1 to 5 scale:

- **Fun**: 5 means the moment it creates is one players will talk about.
- **Read**: readability at speed. 5 means a player can tell what it does within a glance, mid-chain.
- **Cost**: implementation effort. 1 is cheap, 5 is expensive. Lower is better for scope.

---

## Part 1: Brainstorm

### 1.1 Enemy ideas (beyond the six in #1)

**E1. Tether Pair (Lantern Pair).** Two small fish joined by a visible glowing tether that breaks the moment the tether is crossed. Each dies normally, but a dash that cuts the tether kills both and counts as a double kill. It tests geometry: a player who sees the pair as one target lines the dash up across the tether and gets a bonus. It chains well because a successful cut resolves two enemies in one motion. Pulse does not cut tethers, but a Pulse that staggers one fish drags the other by up to 40 px, so a stagger can set up a cut. It is fun because it rewards spatial reading. Fun 4, Read 4, Cost 2.

**E2. Krill Swarm.** A flock of 10 to 12 tiny boids that move together and scatter when a dash enters their cloud. Each boid is one hit point, so a single dash through the middle creates a large multi-kill. The skill is aiming through the thickest part of the swarm while avoiding its edges. Pulse is strong here because a Pulse scatters the flock and dissolves its shape, which is a deliberate trade-off against the dash that would have killed them. Fun 4, Read 3, Cost 3.

**E3. Harpoon Turret.** Stationary on the arena rim, it fires a slow homing harpoon every 2.4 s, and the harpoon turns at 40 degrees per second. Players learn to use dash as an evasion tool as well as an attack, since a dash that starts the moment the harpoon is about to hit gives invulnerability for the dash. It tests timing against a tracking projectile. A perfect Pulse reflects the harpoon back into the turret, which is satisfying. Fun 3, Read 4, Cost 2.

**E4. Ink Squid (Lobber).** Keeps 320 to 420 px from the player and lobs an arc that lands on the player's predicted position, then leaves an ink puddle that slows the player. It tests area control and reading arcs. The best chain moment is a dash that cuts through the arc's landing spot, since a dash is invulnerable and clears the puddle's threat. A Pulse reflects the arc back at the squid. Fun 4, Read 3, Cost 3.

**E5. Mimic Clam.** Looks exactly like a Pulse pickup until the player comes within 90 px, then opens and fires a short burst of three spines. It is a readability test: players learn that the shimmer on pickups is not always a pickup, and that a pickup approached from a distance can be a trap. Fun 4, Read 2, Cost 2.

**E6. Shield Bearer (Escort).** A slow, larger fish with an aura of radius 120 px. Enemies inside the aura carry a Barrier that absorbs one dash hit, shown as a ring. Players must decide whether to kill the Bearer first, which is a target-priority decision that the rest of the roster does not offer. Dashing through a barrier does not kill the enemy and does not refund a charge, which is a meaningful cost that teaches players to clear the Bearer. Fun 4, Read 4, Cost 2.

**E7. Leech.** A small fish that latches onto the player after a touch and drains 1 hit point over 2 s unless the player dashes or Pulses it off. It tests whether the player can break a grab without losing the chain. A dash that removes the leech is also a kill, so it counts toward the combo. Risk: the latch can feel like an unfair hit if it lands during a chain. Fun 3, Read 3, Cost 2.

**E8. Prism Drone.** A hovering drone that absorbs a Pulse and stores it, then fires the stored pulse as a wide 180 degree wave after 1.5 s. It makes Pulse a resource to be managed rather than a reflex. Fun 3, Read 2, Cost 4.

**E9. Burrower.** Invisible under the sand until the player comes within 150 px, then erupts after a 0.5 s rumble for a short area attack. The eruption site is a fixed point the player can dash through before it fires, which is rewarding when a dash path crosses it. Fun 3, Read 2, Cost 3.

**E10. Vortex Jelly.** A slow jelly with a strong pull that drags the player and nearby enemies toward its core. A dash that enters the core cancels the pull and carries momentum out, so the jelly becomes a slingshot. It is fun because it turns a hazard into a movement tool, but it adds a physics interaction that is expensive to tune. Fun 4, Read 3, Cost 4.

**E11. Pod Launcher.** A stationary spawner that releases a Drifter every 2 s until destroyed, with 3 hit points. It is simple, readable, and useful as a priority target that forces the player to leave a chain to clear a source. Fun 3, Read 4, Cost 1.

**E12. Hook Crab.** Scuttles sideways and throws a hook along a line toward the player. If the hook connects, it pulls the player 80 px and cancels any dash in progress. It tests dash angle, because a dash that ends at the hook's line is safe. Fun 3, Read 3, Cost 3.

**E13. Phase Eel.** Cycles between hidden and visible. Hidden for 1.6 s, then surfacing with a 0.5 s ripple telegraph, then visible for 1.2 s. It can only be killed while visible, so a dash must time its arrival. It is the clearest timing test in the roster. Fun 4, Read 3, Cost 3.

**E14. Armored Heavy.** A large, slow enemy with 5 hit points that takes two dashes to fully destroy. Its first dash removes its outer plate and the second kills it. It tests commitment, since it takes two charges at the same spot. Fun 3, Read 5, Cost 2.

**E15. Gull Bomber.** Flies across the arena in a straight line at 260 px/s and drops bombs every 0.7 s. The bombs fall where the gull is, so a dash through the gull's flight line is an air kill. It tests reading of a moving threat. Fun 3, Read 4, Cost 2.

**E16. Echo Ray.** After 1.5 s, it replays the player's most recent dash path as a short damaging line. It discourages repeating the same chain route and rewards variety, a direct replayability hook. Risk: it can feel like the game is punishing good play. Fun 4, Read 3, Cost 3.

**E17. Puffer.** A slow chaser that bursts into eight shrapnel shards when killed or when it reaches the player. Shards kill enemies they touch, and each of those kills counts toward the combo. This is the chain-reaction enemy: a dash through a cluster of Pufferfish can cascade across the arena. Fun 5, Read 4, Cost 2.

### 1.2 Arena hazards and modifiers

**H1. Tidal Current.** The arena has a current that pushes the player and projectiles at 60 px/s. The direction rotates 90 degrees every 12 s, with a 1.5 s warning arrow. Dash chains that follow the current go further, which teaches the player to read the water. Fun 4, Read 4, Cost 2.

**H2. Reef Pillars.** Four static pillars of radius 28 px that stop a dash on contact. The dash ends, the charge is spent, and no refund is given unless a kill happened earlier in the same dash. Pillars shape the lines a player can take and reward planning. Fun 4, Read 5, Cost 1.

**H3. Thermal Vents.** Fixed vents that erupt every 6 s for 1 s, pushing a 90 px radius away from the vent. Dashing through an active vent gives a boost. Fun 3, Read 4, Cost 2.

**H4. Whirlpool Edges.** Circular pull zones along the arena edges that drag projectiles inward. Pulse can push projectiles out of the pull, which is a strong use of Pulse. Fun 3, Read 3, Cost 3.

**H5. Blackout.** Enemy outlines are visible only within 180 px of the player, and Pulse reveals the arena for 1 s. It is a modifier, not a hazard, and tests memory and anticipation. Readability cost is high, so it is best kept to a short release wave. Fun 4, Read 2, Cost 2.

**H6. Current Lanes.** Bands of fast water at 200 px/s. Dashes along a lane travel 40 percent further but are harder to aim at turns. Fun 3, Read 4, Cost 2.

**H7. Rising Tide.** The arena edge moves inward over time, shrinking the play area. It creates steady pressure, but it conflicts with the dash-chain goal of open movement. It is best used as a late-run modifier. Fun 3, Read 4, Cost 3.

**H8. Ink Clouds.** Floating ink clouds that block line of sight and slow the player by 20 percent while inside. Fun 2, Read 2, Cost 2.

**H9. Flare Pulse.** A periodic bioluminescent flash every 8 s that briefly blinds the screen, returning after 0.4 s. It tests peripheral vision and rhythm. Fun 3, Read 2, Cost 2.

**H10. Kelp Snare.** Kelp beds that slow the player by 40 percent and hold projectiles. A dash cuts through kelp at full speed. Fun 3, Read 4, Cost 2.

### 1.3 Short-term power-ups and pickups

**P1. Spark Coral.** Gives one charge immediately and raises the maximum to 4 for 8 s. It makes a chain possible for longer. Fun 4, Read 5, Cost 1.

**P2. Riptide Coal.** Extends the combo timer to 4.0 s for 6 s. It rewards a player already in a chain. Fun 4, Read 5, Cost 1.

**P3. Shield Scale.** Absorbs one hit and lasts 6 s, or until used. It makes a risky chain safer and lets players commit. Fun 3, Read 5, Cost 1.

**P4. Sonar Ping.** Reveals all enemies for 3 s, including Phase Eels while hidden. It is a planning tool, not a combat tool. Fun 3, Read 4, Cost 2.

**P5. Overcharge Pearl.** The next dash kill counts double toward the combo. It is a burst multiplier. Fun 4, Read 4, Cost 2.

**P6. Magnet Kelp.** Pulls nearby score shards toward the player for 5 s. It is a quality-of-life pickup that adds feel without adding danger. Fun 2, Read 4, Cost 1.

**P7. Frenzy Shell.** Dash cooldown drops from 0.9 s to 0.4 s for 4 s. Fun 4, Read 4, Cost 2.

**P8. Bubble of Calm.** Slows all enemies to 50 percent speed for 3 s. It is a reset tool for a stressful moment. Fun 3, Read 4, Cost 2.

**P9. Ghost Fin.** Gives one free dash that does not spend a charge. Fun 3, Read 4, Cost 2.

**P10. Score Shard.** Dropped by kills and worth a flat score. It feeds the combo visually but has no mechanical effect. Fun 2, Read 5, Cost 1.

### 1.4 Elite waves and boss moments

**B1. Anglerfish Warden.** A large elite with a glowing lure that spawns Drifters on a fixed timer. Its body is dashable only once every 0.6 s, so players must dash in time with its lure. Fun 5, Read 4, Cost 4.

**B2. Twin Mantas.** Two linked bosses that move together. Killing one causes the other to dash wildly for 3 s. Fun 4, Read 3, Cost 4.

**B3. Hydra Cluster.** A boss with four heads that each regrow when cut. Dashing through a head removes it, but the head regrows after 4 s unless the core is hit. Fun 4, Read 3, Cost 5.

**B4. Drowned Choir.** A sound-based boss whose song creates a visible wave ring that moves across the arena. Dash through the ring at the right moment to avoid it. Fun 4, Read 3, Cost 4.

**B5. Warden Shellback.** An armored elite with three plates that each need a dash from a different side. It is a bigger version of the Shellback mechanic. Fun 3, Read 4, Cost 3.

**B6. Gull Armada.** A wave of Gull Bombers that dive in formation. Dashing through the formation's center kills several gulls at once. Fun 4, Read 4, Cost 3.

---

## Part 2: Proposal

### 2.1 Selected enemies

Four enemies were selected for the first round: the Puffer for chain reactions, the Shield Bearer for target priority, the Ink Squid for area control, and the Phase Eel for timing. Together they test four different skills while keeping the roster readable.

| Stat | Puffer | Shield Bearer | Ink Squid (Lobber) | Phase Eel |
| --- | --- | --- | --- | --- |
| Radius | 16 px | 22 px | 18 px | 14 px |
| Hit points | 1 | 2 | 1 | 1 |
| Speed | 90 px/s | 70 px/s | keeps 320 to 420 px | teleports |
| Attack | Burst into 8 shards when killed or on contact | Aura radius 120 px grants Barrier to Drifters and Spitters | Lob every 2.2 s, lands 0.4 s ahead of player, 1.0 s flight | Bite dash at 280 px/s during visible window |
| Timing | Swells 0.6 s when within 40 px | Barrier ring lasts until dash-hit | Puddle 60 px radius for 3.0 s, 50 percent slow | Hidden 1.6 s, ripple 0.5 s, visible 1.2 s |
| Score | 20 | 40 | 35 | 40 |
| Dash interaction | Chain reaction source, shards count as kills | Barrier absorbs one dash without a kill or refund | Dash clears the puddle; dash over landing spot dodges | Kill only while visible |
| Pulse interaction | Pulse knocks it back 40 px and does not burst it; a Pulse that pushes it into another Puffer's shards triggers a chain | Pulse staggers Bearer and drops its aura for 1 s | Perfect Pulse reflects arc back at the squid, killing it | Pulse during the 0.5 s ripple stuns it for 0.8 s |

### 2.2 Selected hazards

| Stat | Tidal Current | Reef Pillars |
| --- | --- | --- |
| Count | 1 global field | 4 static pillars |
| Strength | 60 px/s push on player and projectiles | Dash-stop on contact |
| Timing | Rotates 90 degrees every 12 s, 1.5 s warning arrow | Constant |
| Dash rule | Dash vector unchanged | Dash ends on contact, charge spent, refund only if a kill happened earlier in that dash |
| Pulse rule | Pulse pushes projectiles against current for 0.5 s | Pulse does not interact |
| Readability | Arrow icons drawn on the water, color-coded to direction | Solid pillar sprite, always visible |

### 2.3 Selected pickups

| Stat | Spark Coral | Riptide Coal | Shield Scale |
| --- | --- | --- | --- |
| Effect | +1 charge now, max charges 4 for 8 s | Combo timer 4.0 s for 6 s | Absorbs one hit for 6 s |
| Spawn | Every 18 s, random point off the player | Every 22 s, random point off the player | Every 30 s, only when the player has no shield |
| Stacking | Refreshes duration only | Refreshes duration only | Does not stack |
| Read | Teal glow, bubble icon | Gold spiral, combo arc icon | Silver disc, shield icon |
| Pickup radius | 28 px | 28 px | 28 px |

### 2.4 Selected boss moment

| Stat | Anglerfish Warden |
| --- | --- |
| Radius | 60 px |
| Hit points | 14 (each dash hit removes 1, at most once per dash) |
| Speed | 55 px/s, rising to 90 px/s at 50 percent hit points |
| Lure | Spawns 4 Drifters every 6 s, at 220 px/s |
| Vulnerability window | Body dashable only once every 0.6 s, marked by a glow |
| Pulse | Perfect Pulse stuns for 1.0 s |
| Score | 500 on kill, plus 50 per Drifter from its lure killed in the same fight |
| Appears | Wave 10 and wave 20 (phase 2 at wave 20) |

---

## Part 3: Wave script

### 3.1 Waves 1 to 20

The table uses counts per wave. Cadence is the time between spawn groups. Intensity is on a 1 to 10 scale. The script alternates tension waves with release waves (waves 3, 5, 9, 11, 15, and 18 are release waves, with fewer enemies and a pickup or reward beat).

| Wave | Intensity | Drifter | Spitter | Charger | Shellback | Splitter | Mine | Puffer | Bearer | Lobber | Eel | Cadence | Hazard or pickup | What is new |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 10 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 3.0 s per group of 2 to 3 | None | Teaching: Drifters only for the first 30 s |
| 2 | 2 | 14 | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 2.5 s | None | Spitter, after 20 s |
| 3 | 2 | 12 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1.8 s | Spark Coral pickup | Release wave, first pickup |
| 4 | 4 | 10 | 2 | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 2.2 s | None | Charger telegraph |
| 5 | 3 | 12 | 0 | 0 | 0 | 2 | 0 | 0 | 0 | 0 | 0 | 2.5 s | None | Splitter, release wave |
| 6 | 5 | 14 | 0 | 2 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 2.0 s | Tidal Current | Hazard introduced |
| 7 | 4 | 16 | 0 | 0 | 0 | 0 | 3 | 0 | 0 | 0 | 0 | 2.0 s | None | Mine (spaced out) |
| 8 | 6 | 12 | 2 | 0 | 2 | 0 | 0 | 0 | 0 | 0 | 0 | 2.0 s | None | Shellback |
| 9 | 5 | 18 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1.6 s | Riptide Coal pickup | Chain-window release |
| 10 | 8 | 12 | 0 | 0 | 0 | 2 | 0 | 0 | 0 | 0 | 0 | 2.0 s | Anglerfish Warden (boss) | Boss moment |
| 11 | 3 | 16 | 2 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1.8 s | Shield Scale pickup | Release wave |
| 12 | 6 | 12 | 0 | 0 | 0 | 0 | 0 | 3 | 0 | 0 | 0 | 1.8 s | None | Puffer |
| 13 | 6 | 8 | 0 | 0 | 1 | 0 | 0 | 0 | 1 | 0 | 0 | 2.0 s | None | Shield Bearer |
| 14 | 7 | 0 | 0 | 2 | 0 | 0 | 0 | 0 | 0 | 2 | 0 | 2.0 s | Tidal Current (faster rotation, 8 s) | Ink Squid |
| 15 | 4 | 20 | 0 | 0 | 0 | 0 | 0 | 2 | 0 | 0 | 0 | 1.4 s | Reef Pillars | Reef Pillars, release wave |
| 16 | 7 | 0 | 0 | 0 | 0 | 2 | 4 | 0 | 0 | 0 | 2 | 2.0 s | None | Phase Eel |
| 17 | 8 | 0 | 0 | 3 | 2 | 0 | 0 | 0 | 2 | 2 | 0 | 1.8 s | None | Gauntlet of armor |
| 18 | 5 | 22 | 2 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1.4 s | All three pickups | Release wave, pickup-rich |
| 19 | 9 | 0 | 0 | 3 | 0 | 3 | 4 | 4 | 0 | 0 | 3 | 1.6 s | Reef Pillars and Tidal Current together | Gauntlet |
| 20 | 10 | 12 | 2 | 2 | 2 | 0 | 0 | 3 | 1 | 2 | 2 | 1.5 s | Anglerfish Warden phase 2 | Capstone wave, all enemy types |

Wave 1 detail: the first 30 s teach dash-chaining with only Drifters, and the wave lasts about 30 s. Ten Drifters spawn in groups of 2 or 3 every 3.0 s, placed so that the first group is in a line 150 px ahead of the player, which teaches the dash line. A 3-kill chain prints a "CHAIN" prompt. The wave ends once all 10 are dead, with a 2 s pause before wave 2 begins.

Pacing rule: no more than three tension waves (intensity 6 or higher) run back to back, and every release wave must be followed by a wave of intensity 4 or higher. Waves 12 to 14 are the longest run and are the place to watch in playtest.

### 3.2 Waves beyond 20

For wave N greater than 20, let k = N - 20.

- **Point budget**: `budget(N) = min(120, 60 + 3k)`. Release waves are every 5th wave beyond 20 (25, 30, 35, ...) and use 60 percent of budget.
- **Point costs**: Drifter 1, Mine 1, Puffer 2, Spitter 2, Splitter 3, Charger 3, Ink Squid 3, Shield Bearer 4, Phase Eel 4, Shellback 5, Anglerfish Warden 25.
- **Boss**: Anglerfish Warden spawns on every 10th wave beyond 20 (30, 40, ...) at 25 budget points. On those waves the boss replaces the release wave, so wave 30 is a boss wave and not a release wave.
- **Intensity**: `intensity(N) = min(10, 9 + (N % 5 == 0 ? 0 : 1))`, so tension waves sit at 10 and release waves at 9. Tune in playtest.
- **Duration and cadence**: wave length `min(90, 45 + 2k)` seconds. Group spawn interval `max(1.2, 3.0 - 0.05k)` seconds.
- **Hazards**: cycle through the Part 2 hazards and the Part 1 hazards not yet used, one new hazard every 5 waves.
- **Cap**: no more than 60 active enemies at once. Excess spawns queue and enter when space frees up.

---

## Part 4: Issue plan

One GitHub issue per Part 2 item, each labelled `design` and `feature`:

1. Enemy: Puffer
2. Enemy: Shield Bearer
3. Enemy: Ink Squid (Lobber)
4. Enemy: Phase Eel
5. Hazard: Tidal Current
6. Hazard: Reef Pillars
7. Pickup: Spark Coral
8. Pickup: Riptide Coal
9. Pickup: Shield Scale
10. Boss: Anglerfish Warden

Each issue contains its stats from this document and acceptance criteria covering behaviour, readability, the dash and Pulse interactions above, and a `node --test` check where the logic is pure.
