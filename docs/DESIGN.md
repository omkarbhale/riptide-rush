# Riptide Rush — Game Design Document

Status: v1 draft. Expands [#1](https://github.com/omkarbhale/riptide-rush/issues/1) (concept and shared architecture) and tracked by [#6](https://github.com/omkarbhale/riptide-rush/issues/6). Where this document and #1 disagree, #1 wins and this document must be fixed.

**How to read the number tables.** Every value sourced from #1 is marked `#1`. Values introduced here to complete the design are marked `proposed`. Proposed values are tuning starting points and are listed for playtest in the open questions. No `#1` value is changed.

---

## 1. Pitch and design pillars

**Pitch.** Riptide Rush is a top-down neon-abyss arena slasher. You are Rip, a blade-fish. You do not shoot. You dash through enemies to kill them. Every kill instantly refunds a dash charge, so an expert chains dash after dash across the arena without stopping, while a new player can play slowly and safely. Actions per minute scale with skill.

**Pillars.**

1. **Dash is the only verb.** Everything the player does is movement through danger. There is no aim-and-fire, no reload, no menu during play. (#1: "You do not shoot.")
2. **Kills pay for the next move.** A kill refunds a charge, so the best play is always the most aggressive play. Hesitation is the only real cost. (#1: refund on kill.)
3. **Danger is always readable.** Every threat announces itself before it hits: a spawn warning, a charger telegraph, a mine arming ring, a spitter's aim line. Deaths should feel earned. (#1: "clear enemy telegraphs.")
4. **Juice is information.** Hit-stop, shake, sound pitch and floaters tell the player exactly what happened and how well. Feel is non-negotiable. (#1: "Feel targets.")
5. **Scales with skill, never gates.** The beginner's game and the expert's game are the same rules. The expert just takes more of the arena per second. (#1: "Actions per minute scale with skill.")

---

## 2. The first 10 seconds, moment to moment

### 2.1 Expert, 10 seconds (wave 6, roughly 9 enemies alive)

- **0.0 s.** Rip is mid-arena with 3 charges. A Shellback is on the left, two Drifters are closing from the top-right, and a Charger's telegraph line is pointing at the player.
- **0.0–0.3 s.** The expert dashes through the two Drifters. The dash (210 px, 0.12 s) kills both. Combo goes 6 → 8. Charges go 3 → 2 when the dash starts, then back to 3 on the two kill refunds.
- **0.3 s.** Multi-kill hit-stop (50 ms) freezes the frame. Pitch-rising kill chimes play. A `x2` floater rises.
- **0.4–0.6 s.** The expert swims 70 px to dodge the Charger's lunge (0.6 s telegraph, lunge at 640 px/s). The telegraph line is already known, so the swim is early and small.
- **0.7 s.** A Spitter bullet is inbound. The expert taps Pulse (right-click) with the bullet 60 px out. It reflects (`REFLECT`). The bullet flies back and kills a Drifter (kill chime, combo 8 → 9).
- **1.0–1.4 s.** Combo reaches 10. The HUD tier changes from cyan to green (tier-up arpeggio, `COMBO 10` floater). The expert dashes on the Shellback's side (not its front arc) and kills it (base 250 × multiplier 3 = 750).
- **1.5–3.0 s.** Two charges are back in 0.9 s each. The expert starts a dash at the Splitter. The three minis spawn. The expert dashes through two minis (`x2` bonus) and keeps the charge refund rolling.
- **3.0–10.0 s.** The pattern repeats. Average tempo is 1 dash every 0.8 s, 3–4 kills every dash, and the combo never reaches the 2.5 s timer. Pulse fires about every 2.5 s, and two out of three pulses reflect a bullet.

### 2.2 Beginner, 10 seconds (wave 1, 4 Drifters)

- **0.0 s.** Rip is centered. Four Drifters spawn at the edges (spawn warning 0.8 s before each).
- **0.0–2.0 s.** The beginner swims toward the nearest Drifter. Its chase (95 px/s, proposed) is slow enough to read as safe.
- **2.0 s.** One dash kills one Drifter. Combo 0 → 1. `+100` floater. No multi-kill.
- **2.0–4.0 s.** The beginner waits for a second Drifter to line up and does not dash until it does.
- **4.0 s.** A Drifter touches Rip. `-1 HP` floater, shake 10, hit-stop 70 ms, magenta flash. Rip has 2 HP and 1.0 s of invulnerability to steer away. The combo stays at 1, since a hit does not reset it (§3.6).
- **4.2 s.** The second kill. Combo 1 → 2. `+100` floater.
- **6.7 s.** The combo timer (2.5 s from the last kill) expires. `COMBO LOST` floater; combo 0. This is the first lesson in the timer.
- **7.5 s.** A dash lines up the last two Drifters. Double kill: combo 0 → 2, scores 100 + 100, multi bonus 50 × 1 × 1 = 50, total 250. `x2 +50` floater. The wave clears and the intermission begins.
- **7.5–10.0 s.** The beginner has 2 HP, 3 charges, and combo 2 with a 2.5 s timer. They have not used Pulse.

The beginner's game uses the same rules. The only difference is how many dashes they chain before waiting.

---

## 3. Core mechanics (exact numbers)

### 3.1 Arena and rendering

| Parameter | Value | Source |
|---|---|---|
| Logical resolution | 1280 × 720 px, scaled to fit the window | #1 |
| Arena | Single screen, walls at logical edges | #1 |
| Wall margin for player | 12 px | proposed |
| Simulation rate | 120 Hz fixed timestep, render interpolated | #1 |
| Target frame rate | 60 fps with 200+ entities | #1 |
| Entity cap (enemies incl. minis) | 120 alive; further spawns queue | proposed |
| Particle pool cap | 1500 live particles (`src/fx.js` hard cap) | proposed |

### 3.2 Movement

| Parameter | Value | Source |
|---|---|---|
| Input | WASD / arrows; diagonal input normalized | #1 |
| Top speed | 330 px/s | #1 |
| Acceleration | 1400 px/s² | proposed |
| Deceleration with no input | 1100 px/s² | proposed |
| Player hit radius | 12 px | proposed |
| Aim | Mouse cursor; aim is cursor position relative to Rip | #1 |

### 3.3 Dash-slash

| Parameter | Value | Source |
|---|---|---|
| Trigger | Left click or Space | #1 |
| Travel distance | 210 px, fixed, regardless of cursor distance | #1 |
| Duration | 0.12 s (implied speed 1750 px/s) | #1 |
| Path kill width | An enemy dies if it is within its radius + 26 px (blade) of the path. The body is 14 px, so the blade is longer than the body | proposed (blade 26 px) |
| Closing slash arc | At dash end, enemies within 46 px of the end point in the forward half-circle die (and enemy bullets there are cut) | proposed |
| Lunge assist | If the nearest enemy within ±12° of the aim line is 210–275 px out and within blade reach, the dash extends along the aim line to pass through it. Same speed, slightly longer duration. Never shortened or re-aimed | proposed |
| Exit grace | Invulnerable for 0.18 s after a dash that killed nothing; 0.25 s after one that did (each kill refreshes it). Shown as a fading afterglow | proposed |
| Bullet cut | Enemy bullets on the dash path or inside the closing arc are destroyed: +5 points, no combo, no charge refund | proposed |
| Dash whiff | A dash that kills nothing but passes within 60 px of an enemy emits a whiff event so effects can show it | proposed |
| Aim preview | A reticle at the end point the next dash would reach, brighter (gold) when it would kill | proposed |
| Invulnerability | Entire 0.12 s duration | #1 |
| Charges | 3 maximum | #1 |
| Recharge per charge | 0.9 s, one charge at a time, timer runs only while below 3 | #1 |
| Kill refund | +1 charge immediately, capped at 3 (refund on a full bar is lost) | #1 (cap proposed) |
| Input buffer | 120 ms | #1 |
| Zero-length aim | If the cursor is on Rip, dash along the last movement direction; if none, dash right | proposed |
| Arena wall | Dash stops at the wall; no bounce | proposed |
| Shellback front contact | Dash cancels at contact. Rip bounces back 80 px over 0.4 s, invulnerable, no damage. The dash's charge is refunded, so the lesson costs tempo, not charges or health (#85, balance pass) | proposed; bounce set in #97 |
| Mine contact | Dash through a mine defuses it (see §3.7) | #1 |

### 3.4 Pulse

| Parameter | Value | Source |
|---|---|---|
| Trigger | Right click or Shift | #1 |
| Radius | 110 px | #1 |
| Cooldown | 2.5 s | #1 |
| Enemy stagger (knockback + stun) | 0.8 s stun; knockback 120 px away from Rip | proposed |
| Shellback stagger | 1.5 s stun; armor is disabled while stunned | proposed |
| Bullet reflection | Every enemy bullet inside the radius reverses direction at 360 px/s | proposed |
| Perfect pulse window | Reflected bullet's time-to-impact ≤ 0.12 s at the moment of the pulse | #1 (0.12 s) / definition proposed |
| Perfect pulse reward | Slow-motion (sim time scale 0.35 for 200 ms real time) and cooldown reset to 0 | #1 (reward) / numbers proposed |
| Perfect pulse score | +150 flat, no multiplier | proposed |
| Mines | Pulse does not affect mines. Mines are defused only by dash (§3.7). | proposed |

### 3.5 Input buffering

| Parameter | Value | Source |
|---|---|---|
| Buffer window | 120 ms for dash and pulse | #1 |
| Buffer rule | A press made while the action is on cooldown or without a charge is kept for 120 ms and fires on the first frame it becomes legal | #1 (rule proposed) |

### 3.6 Health and damage

| Parameter | Value | Source |
|---|---|---|
| Max HP | 3 | #1 |
| Damage per hit | 1 | proposed |
| Invulnerability after hit | 1.0 s, player sprite blinks at 10 Hz | #1 (duration) / blink proposed |
| Healing | Heal orbs and flawless-wave heals, see §3.9a (supersedes Q2, #54) | #54 |
| Death | HP reaches 0 → DEAD state (§4.1) | #1 |
| Restart | R or click; death-to-playable under 300 ms | #1 |
| Combo on hit | Being hurt does not reset the combo; only timer expiry does | proposed |
| Contact reach | A non-lunging enemy hurts only inside its radius + 8 px player core, so grazes are safe. A charger hurts only while lunging (full body reach) | proposed (core 8 px) |
| Spawn safety | A newly spawned enemy cannot hurt for its first 0.4 s | proposed |
| Post-dash grace | No damage for 0.18 s after a dash, 0.25 s if it killed (see §3.3) | proposed |

Damage sources: enemy bullets (1), Drifter contact (1, Drifter dies), Charger lunge contact (1), Shellback contact outside a dash (1, Shellback continues), Splitter contact outside a dash (1, Splitter splits as on death with no score), Mini contact (1, mini dies), Mine blast (1).

### 3.7 Combo and scoring

| Parameter | Value | Source |
|---|---|---|
| Combo gain | +1 per kill (a mine defuse also counts, see Q3) | #1 |
| Combo timer | 2.5 s at combo ≤ 20; `max(2.0, 2.5 − 0.01 × (combo − 20))` above 20 | #1 (2.5 s) / shrink proposed |
| Timer reset | Resets to full on each kill | #1 |
| Combo expiry | Combo drops to 0; event `combo lost` | #1 |
| Multiplier | `min(10, 1 + floor(combo / 5))`, computed after the combo increment | #1 (formula) / ordering proposed |
| Base score: Drifter | 100 | proposed |
| Base score: Spitter | 150 | proposed |
| Base score: Charger | 150 | proposed |
| Base score: Shellback | 250 | proposed |
| Base score: Splitter | 120 | proposed |
| Base score: Mini | 40 | proposed |
| Base score: Mine defuse | 75 | proposed |
| Multi-kill bonus | `50 × (n − 1) × multiplier` where `n` = kills in one dash, multiplier = value after the last kill of that dash | #1 (existence) / formula proposed |
| Perfect pulse bonus | +150 flat | proposed |
| Tier thresholds | cyan 0–9, green 10–19, gold 20–29, magenta 30–39, white 40+ (`COMBO.tiers` = 10/20/30/40, as §3.10 says; #58) | #1 (colors) / thresholds proposed |
| Multiplier cap | ×10 at combo 45 | #1 |

### 3.8 Hit feel

| Parameter | Value | Source |
|---|---|---|
| Kill hit-stop | 40–70 ms; single kill 40 ms | #1 (range) / value proposed |
| Multi-kill hit-stop | 2 kills: 50 ms, 3 kills: 60 ms, 4+ kills: 70 ms | proposed |
| Screen shake | Peak amplitude in px, decays linearly over 0.2 s | proposed |
| Charge telegraph (Charger) | 0.6 s flash and line before lunge | #1 |

### 3.9 Pickups, charges, and HUD

| Element | Behavior | Source |
|---|---|---|
| Charge pips | 3 pips under Rip; fill on recharge | proposed |
| Pulse ring | Cooldown ring around Rip; full ring = ready | proposed |
| Combo counter | Top-center; color = tier color; timer bar underneath | proposed |
| HP | 3 orbs top-left | proposed |
| Score | Top-left, under HP; high score top-right from localStorage | #1 (high score) |

### 3.9a Health recovery and modifier drops (#54)

Recovery and power are earned by chaining, and they pull Rip toward the fight. Nothing needs a menu or a pause. Source: #54; builds on #21 (healing, superseded), #32 (Spark Coral), #34 (Riptide Coal), #36 (Shield Scale). Code: `src/pickups.js` (rules), `src/config.js` (`PICKUP`, `MODIFIER`), `src/pickups-art.js` (drawing and HUD).

**Heal orb (green heart).** Drops only while Rip is below max HP.

| Parameter | Value |
|---|---|
| Chance per kill | 0.2% + 0.5% per missing hit point (0.7% at 2 HP, 1.2% at 1 HP). Random orbs stay rare; recovery is mostly earned by chaining (#87; #105 lowered the base chance) |
| Combo guarantee | A hurt player who reaches combo 20 is owed a heal orb. It drops at the next kill once at least 25 s have passed since the last combo orb (#105). The orb waits, due, while the field is full or the drop spacing is still running |
| Pity | Guaranteed on the 300th kill while hurt without a heal drop (#105: was 150; kills are frequent in a crowd) |
| Collect | Restores 1 HP |
| Flawless release wave | A release wave (3, 5, 9, 11, 15, 18, ...) that cost no HP while it was live restores 1 HP if Rip is hurt (#105). Tension waves heal nothing |
| Full HP | A heal that would restore HP converts to bonus score: 200 × multiplier. Never wasted |

**Modifier drops.** Each lasts a few seconds, shows a countdown bar in the HUD (one row per modifier, under the combo), and stacks by refreshing its timer.

| Modifier | Colour / shape | Effect | Duration |
|---|---|---|---|
| Spark Coral | cyan / four-point spark | +1 max dash charge (4) and instant full recharge | 5 s (was 8) |
| Riptide Coal | gold / hexagon | Combo timer drains at half speed | 5 s (was 6) |
| Shield Scale | white / shield | Absorbs the next hit, then a 0.25 s bounce grace and a knockback so a touching enemy cannot drain HP next frame | 5 s or until used (was 6) |
| Frenzy | magenta / chevron | Dash charges recharge 2× faster (was 3×); dash distance +25% | 4 s (was 6) |
| Undertow | violet / swirl | Every kill releases a 90 px shockwave that kills adjacent enemies; chain kills count for score and combo | 4 s (was 5) |

Shield Scale is drawn as a silver aura around Rip with a ring that empties as the shield runs out.

**Drop rules (shared by heal and modifier drops).** At most one drop per kill, never two drops within 4 s, at most 3 pickups on the field. Modifier drops: 1.5% per kill, guaranteed on the 90th kill without one (was 5%, pity 30; balance pass, #87). Drops appear at the kill point with a small outward pop.

**Pickup behaviour.** Collected by touching. Inside 120 px they are pulled toward Rip at 420 px/s. A dash path passing within 60 px collects them, so chaining sweeps them up. They last 7 s and blink for the final 2 s, then despawn.

**Events** (drained by `main.js`): `pickupDrop {kind,x,y}`, `pickup {kind,x,y}`, `modifierEnd {kind}`, `heal {x,y,source,hp,bonus}`, `shieldBreak {x,y}`.

**Still open.** Pickup sounds and floaters are wired only as far as `pickups-art.js` (rings and floaters drawn from sim state). Mapping the events above to `audio.js` and `fx.js` is follow-up work in `main.js`.

### 3.10 Look and palette

Source: #1 "Look". Values are exact.

| Element | Value |
|---|---|
| Background | Vertical gradient `#050a18` (top) to `#0a1830` (bottom), with drifting plankton and parallax layers |
| Rendering | Glowing vector shapes with additive bloom |
| Player (Rip) | `#3cf2ff` cyan |
| Dash | `#eaffff` white-hot |
| Danger and magenta accents | `#ff3d81` |
| Enemy bullets | `#ffb347` amber |
| Score and gold accents | `#ffe066` gold |
| Combo tier 1 (0–9) | `#3cf2ff` cyan |
| Combo tier 2 (10–19) | `#5dff9b` green |
| Combo tier 3 (20–29) | `#ffe066` gold |
| Combo tier 4 (30–39) | `#ff3d81` magenta |
| Combo tier 5 (40+) | `#ffffff` white |

Tier 1 cyan matches the player color. The combo counter takes the tier color (§3.9), so cyan is shared between Rip and combo tier 1 by design.

---

## 4. State diagrams

### 4.1 Game state (global)

```
BOOT --(first user gesture)--> WAVE_INTRO
WAVE_INTRO --(1.5 s banner)--> PLAYING
PLAYING --(wave cleared OR 25 s timeout)--> INTERMISSION
INTERMISSION --(2.0 s)--> WAVE_INTRO
PLAYING --(HP == 0)--> DEAD
DEAD --(R or click, after 150 ms)--> WAVE_INTRO (wave 1, score reset)
PLAYING --(window blur or Esc/P)--> PAUSED     [see Q1]
PAUSED --(focus or Esc/P)--> PLAYING
```

- Wave 1 uses `WAVE_INTRO` on each run.
- `DEAD` shows the game-over card immediately, with score and high score. Input is accepted after 150 ms. Restart completes in one frame with a 120 ms fade, so death-to-playable is under 300 ms (#1).

### 4.2 Player

```
SWIM --(dash input, charges ≥ 1)--> DASH (0.12 s, invulnerable)
DASH --(0.12 s elapsed)--> SWIM
DASH --(Shellback front contact)--> BOUNCE (0.1 s, invulnerable)
BOUNCE --(0.1 s)--> SWIM
SWIM --(pulse input, cooldown 0)--> SWIM (pulse fires, cooldown 2.5 s)
SWIM --(enemy hit, not invulnerable)--> HURT (1.0 s invulnerable, blinking)
HURT --(1.0 s)--> SWIM
HURT or SWIM --(HP == 0)--> DEAD
```

Dash and pulse can be used from any substate of SWIM or HURT, but a dash during HURT is still invulnerable for its own 0.12 s and does not extend the hurt timer.

### 4.3 Enemies

Common states for every enemy: `SPAWN_WARN → SPAWN → ACTIVE → DEAD`. `STAGGER` can be entered from ACTIVE by Pulse (see per-enemy notes).

**Drifter**

```
SPAWN_WARN (0.8 s, warning mark) --> SPAWN (0.4 s fade-in, no collision)
SPAWN --> CHASE
CHASE --(pulse in radius)--> STAGGER (0.8 s, knockback 120 px)
STAGGER --> CHASE
CHASE or STAGGER --(dash path)--> DEAD (kill)
CHASE --(contact with Rip, Rip not dashing)--> DEAD (hurts Rip 1)
```

**Spitter**

```
SPAWN_WARN --> SPAWN --> KEEP_DISTANCE
KEEP_DISTANCE: holds 260–340 px from Rip; fires every 2.2 s
KEEP_DISTANCE --(fire timer, only while Rip is not dashing and 0.15 s have passed since a dash ended; otherwise it waits)--> AIM (0.35 s wind-up, thin amber aim line locked at its start, telegraph rises 0 to 1; a dash holds the wind-up)
AIM --> FIRE (bullet at 230 px/s) --> KEEP_DISTANCE
KEEP_DISTANCE --(pulse)--> STAGGER (0.8 s; firing paused)
STAGGER --> KEEP_DISTANCE
any --(dash path)--> DEAD (kill)
```

**Charger**

```
SPAWN_WARN --> SPAWN --> DRIFT (60 px/s toward Rip, slow)
DRIFT --(cooldown 2.4 s elapsed and Rip within 420 px)--> TELEGRAPH (0.6 s, flash plus line to target)
TELEGRAPH --> LUNGE (640 px/s, max 360 px, straight line, locked direction)
LUNGE --(distance cap or wall)--> RECOVER (0.4 s, no collision, slowed)
RECOVER --> DRIFT
DRIFT, TELEGRAPH, or RECOVER --(pulse)--> STAGGER (0.8 s; cancels telegraph and lunge)
any --(dash path)--> DEAD (kill)
LUNGE --(contact with Rip, Rip not dashing)--> DEAD (hurts Rip 1)
```

**Shellback**

```
SPAWN_WARN --> SPAWN --> TURN_TO_RIP (turn rate 1.5 rad/s)
TURN_TO_RIP --> ADVANCE (55 px/s toward Rip; armor arc = facing ±60°)
ADVANCE --(pulse)--> STAGGER (1.5 s; armor off)
ADVANCE --(contact with Rip, Rip not dashing)--> ADVANCE (hurts Rip 1)
STAGGER --> ADVANCE
ADVANCE --(dash path from front arc)--> BOUNCE_OFF_ARMOR (no kill; dash cancels on Rip)
ADVANCE or STAGGER --(dash path from side or behind, or while stunned)--> DEAD (kill)
```

**Splitter**

```
SPAWN_WARN --> SPAWN --> CHASE (80 px/s)
CHASE --(pulse)--> STAGGER (0.8 s)
STAGGER --> CHASE
CHASE or STAGGER --(dash path)--> DEAD (kill)
CHASE --(contact with Rip, Rip not dashing)--> DEAD (hurts Rip 1, no score)
DEAD --> spawns 3 Minis at 0°, 120°, 240° offsets of 24 px (both kill and contact)
```

**Mini**

```
SPAWN (instant, from Splitter) --> CHASE (200 px/s, lifetime 6 s)
CHASE --(dash path)--> DEAD (kill, base 40)
CHASE --(contact with Rip, Rip not dashing)--> DEAD (hurts Rip 1)
CHASE --(lifetime 0)--> DEAD (no score, no combo)
```

**Mine**

```
SPAWN_WARN --> SPAWN --> IDLE (stationary)
IDLE --(Rip within 130 px)--> ARMED (fuse 0.8 s, pulsing ring speeds up)
ARMED --(fuse 0)--> DETONATE (blast radius 90 px; hurts Rip 1 if inside and not dashing)
IDLE or ARMED --(dash path)--> DEFUSED (defuse bonus, base 75, counts as a kill; same reward whether IDLE or ARMED)
Pulse has no effect on mines.
```

### 4.4 Bullets

```
SPAWNED (from Spitter, speed 230 px/s, lifetime 4 s)
  --(inside pulse radius)--> REFLECTED (speed 360 px/s, travels back toward the enemy that fired it)
  --(hits Rip, Rip not dashing)--> REMOVED (hurts Rip 1)
  --(lifetime 0 or off arena)--> REMOVED
  --(on the dash path or in the closing arc)--> REMOVED (cut by the dash: +5 points, no combo, no charge refund)
REFLECTED --(hits enemy)--> REMOVED (kill, base score of that enemy)
REFLECTED --(off arena)--> REMOVED
```

---

## 5. Feedback matrix

Every game event, its exact feedback. Sound names are the proposed `SOUND_NAMES` keys for `src/audio.js` (audio task owns the final list). Particle presets are the proposed preset IDs for `src/fx.js`. `none` means the channel is intentionally silent for that event. Shake is peak amplitude in px. Flash is a full-screen overlay color and alpha, and is scaled by the reduced-flashes option (§7).

| Event | Sound | Particle preset | Shake (px) | Hit-stop (ms) | Flash (color, alpha) | Floater text |
|---|---|---|---|---|---|---|
| Dash start | `dash_whoosh` (pitch 1.0) | `dash_trail` (continuous while dashing) | 0 | 0 | `#eaffff`, 0.12 | none |
| Kill (single, one dash, 1 kill) | `kill_chime` (pitch 1.0 + 0.02 × min(combo, 30)) | `kill_burst_small` if base < 150, `kill_burst_large` if base ≥ 150 | 3 | 40 | enemy color, 0.10 | `+{score}` |
| Multi-kill (2+ kills in one dash) | `multi_kill_chord` plus `kill_chime` per kill, 30 ms apart | `multi_kill_nova` | 6 for 2 kills, +2 per extra kill, cap 12 | 50 (2 kills), 60 (3), 70 (4+) | `#ffe066`, 0.20 | `x{n} +{bonus}` |
| Hurt (Rip takes damage) | `hurt_thud` | `hurt_spark` | 10 | 70 | `#ff3d81`, 0.35 | `-1 HP` |
| Pulse fired | `pulse_pop` | `pulse_ring` (radius 110 px) | 2 | 0 | `#3cf2ff`, 0.08 | none |
| Reflect (enemy bullet reflected) | `reflect_clang` | `reflect_spark` | 1 | 20 | none | `REFLECT` |
| Perfect pulse | `perfect_pulse_ring` | `perfect_shatter` | 5 | 0 (slow-motion instead: time scale 0.35 for 200 ms) | `#ffffff`, 0.25 | `PERFECT +150` |
| Combo tier up (combo reaches 10, 20, 30, 40) | `tier_up_arpeggio` | `tier_bloom` (new tier color) | 4 | 0 | new tier color, 0.15 | `COMBO {combo}` |
| Combo lost (timer expires, combo was ≥ 1) | `combo_lost_fizzle` | `combo_drain` (particles drawn toward HUD counter) | 2 | 0 | none | `COMBO LOST` |
| Wave start (banner shows) | `wave_start_horn` | `wave_sweep` (ring across arena) | 3 | 0 | `#3cf2ff`, 0.10 | `WAVE {n}` |
| Game over (HP reaches 0) | `game_over_sink` | `gameover_implode` | 0 (the hurt shake already played) | 0 (the hurt hit-stop already played) | `#050a18`, 0.60 | `GAME OVER` |
| Charge ready (a charge refills, count < 3) | `charge_ready_tick` (pitch 1.0 + 0.1 × charges after refill) | `charge_glint` (at Rip) | 0 | 0 | none | none |
| Spawn warning (0.8 s before each spawn) | `spawn_warning_ping` (volume 0.4) | `spawn_motes` (at spawn point, `#ff3d81`) | 0 | 0 | none | `!` |

Notes on the matrix:
- A kill is the same event whether it comes from a dash, a reflected bullet, or a mine defuse. Mini lifetime expiry is not a kill and has no matrix row; it removes the mini silently (§4.3 Mini).
- Reflected bullets that kill an enemy fire both `REFLECT` and the kill row. The floater shows `REFLECT` first, then `+{score}` 150 ms later.
- Charge ready only fires when the refill brings the count from 0–2 up to 1–3. It does not fire on a kill refund.

---

## 6. Scoring formula and worked examples

**Formula.**

```
combo        = combo + 1                                  (on each kill; timer resets)
multiplier   = min(10, 1 + floor(combo / 5))              (after the increment)
kill_score   = base(type) × multiplier
multi_bonus  = 50 × (n − 1) × multiplier_after_last_kill  (n = kills in one dash, n ≥ 2)
perfect      = 150                                        (flat)
defuse_score = 75 × multiplier                            (defuse counts as a kill)
```

The combo timer resets on each kill. The multi-kill bonus uses the multiplier after the last kill of that dash.

**Example 1: single kill, low combo.** Combo is 4 before the dash. A Drifter dies.

- combo → 5, multiplier = 1 + floor(5 / 5) = 2
- kill_score = 100 × 2 = **200**
- floater `+200`, shake 3, hit-stop 40 ms

**Example 2: triple kill at mid combo.** Combo is 12 before the dash. Three Drifters die in one dash.

- kill 1: combo → 13, multiplier = 1 + floor(13 / 5) = 3, score = 100 × 3 = 300
- kill 2: combo → 14, multiplier = 3, score = 300
- kill 3: combo → 15, multiplier = 1 + floor(15 / 5) = 4, score = 100 × 4 = 400
- multi_bonus = 50 × (3 − 1) × 4 = **400**
- total = 300 + 300 + 400 + 400 = **1400**
- combo ends at 15; hit-stop 60 ms; floater `x3 +400`

**Example 3: Shellback from the side, tier up at high combo.** Combo is 39 before the dash. The Shellback is killed from its side.

- combo → 40, multiplier = 1 + floor(40 / 5) = 9
- kill_score = 250 × 9 = **2250**
- tier up to white (combo 40), `COMBO 40` floater, tier-up arpeggio
- hit-stop 40 ms (single kill)

---

## 7. Difficulty curve

### 7.1 Wave composition (first draft, superseded)

Superseded by the balance pass (#97). The source of truth is `WAVE_TABLE` and `planWave` in `src/waves.js`; see §7.4. The formulas and table below are kept as the first draft.

Formulas, with `n` = wave number starting at 1:

| Enemy | Count formula | First wave |
|---|---|---|
| Drifter | 3 + n | 1 |
| Spitter | floor(n / 2) | 2 |
| Charger | floor((n − 1) / 2) | 3 |
| Mine | 2 + floor(n / 3) | 3 |
| Shellback | floor((n − 1) / 3) | 4 |
| Splitter | floor((n − 2) / 3) | 5 |

Resulting counts, waves 1–10:

| Wave | Drifter | Spitter | Charger | Mine | Shellback | Splitter | Total |
|---|---|---|---|---|---|---|---|
| 1 | 4 | 0 | 0 | 0 | 0 | 0 | 4 |
| 2 | 5 | 1 | 0 | 0 | 0 | 0 | 6 |
| 3 | 6 | 1 | 1 | 3 | 0 | 0 | 11 |
| 4 | 7 | 2 | 1 | 3 | 1 | 0 | 14 |
| 5 | 8 | 2 | 2 | 3 | 1 | 1 | 17 |
| 6 | 9 | 3 | 2 | 4 | 1 | 1 | 20 |
| 7 | 10 | 3 | 3 | 4 | 2 | 1 | 23 |
| 8 | 11 | 4 | 3 | 4 | 2 | 2 | 26 |
| 9 | 12 | 4 | 4 | 5 | 2 | 2 | 29 |
| 10 | 13 | 5 | 4 | 5 | 3 | 2 | 32 |

Splitter counts exclude their minis. Minis are not counted toward wave size but count toward the 120 entity cap.

### 7.2 Pacing and scaling (first draft; the balance pass changes the numbers, see §7.4)

- **Spawn timing.** Each wave spawns over 6 s, in groups at random arena-edge points at least 200 px from Rip. Each spawn is preceded by a 0.8 s warning.
- **Wave end.** A wave ends when all its enemies are dead, or after 25 s; the next intermission then starts. Enemies still alive at the timeout keep acting.
- **Intermission.** 2.0 s between a wave ending and the next `WAVE_INTRO`.
- **Speed scaling.** Enemy speeds are multiplied by `1 + 0.02 × (n − 1)`, capped at ×1.4 (reached at wave 21). Superseded: see §7.4.
- **Combo timer shrink.** Above combo 20, the timer shrinks as in §3.7, reaching 2.0 s at combo 70.
- **Expected progression.** Waves 1–3 teach Drifters, Spitters, Chargers, and mines. Waves 4–6 add Shellbacks and Splitters. Waves 7 and onward mix all six types with more density. Target: a competent player reaches wave 8 within 2–3 minutes; an expert can run past wave 15 without losing a combo.

### 7.3 Enemy stats (proposed, all in one table)

| Enemy | Radius (px) | Speed (px/s) | HP | Base score | Special |
|---|---|---|---|---|---|
| Drifter | 14 | 95 | 1 | 100 | Chases; contact hurts Rip and dies |
| Spitter | 16 | 70 approach / retreat to hold 260–340 px | 1 | 150 | Fires every 2.2 s, bullet 230 px/s |
| Charger | 18 | 60 drift | 1 | 150 | Telegraph 0.6 s, lunge 640 px/s, max 360 px, cooldown 2.4 s, range 420 px |
| Shellback | 22 | 55 | 1 | 250 | Armor arc ±60° from facing; turn rate 1.5 rad/s |
| Splitter | 20 | 80 | 1 | 120 | Dies into 3 Minis at 0°, 120°, 240° offsets of 24 px |
| Mini | 9 | 200 | 1 | 40 | Lifetime 6 s |
| Mine | 12 | 0 | n/a (defuse only) | 75 (defuse) | Arms at 130 px, fuse 0.8 s, blast 90 px |

Every enemy has 1 HP in v1; the Shellback's armor arc is its defense. Multi-HP enemies are a future decision (Q8).

---

## 8. Accessibility and options

| Option | Values | Default | Storage | Behavior |
|---|---|---|---|---|
| Master volume | 0–100, step 5 | 70 | `riptide.options.v1` (localStorage) | Calls `audio.setMasterVolume(v / 100)`. Affects all sound. |
| Mute | on / off, key `M` | off | same | Calls `audio.setMuted(b)`. Hit-stop and shake still run when muted. |
| Screen-shake intensity | Off (0%), Low (50%), Full (100%) | Full | same | Multiplies shake amplitude from §5. Off still shows floaters and hit-stop. |
| Reduced flashes | on / off | off | same | Multiplies every flash alpha in §5 by 0.25. Removes the `wave_sweep` ring tint. Keeps perfect-pulse slow-motion (no flash). |
| High score | integer | 0 | `riptide.highscore.v1` (localStorage) | Updated on game over. |

Rules:
- Hit-stop cannot be disabled. It is part of the readability of the game (pillar 4). It is short enough (40–70 ms) that it is not a flashing or motion-sickness risk.
- Telegraphs and floaters are never optional. Reduced flashes and shake options never remove a telegraph; only the flash overlay is reduced.
- All audio is off until the first user gesture (#1 `audio.init()` contract). Before init, every `audio.play` call is a silent no-op.
- Options are read from localStorage inside try/catch. If storage is unavailable, defaults apply and the game still runs.

---

## 9. Open questions

Each open question below has a matching GitHub issue labelled `design` with a concrete recommendation, linked from its entry.

- **Q1 ([#18](https://github.com/omkarbhale/riptide-rush/issues/18)). Pause behavior.** Should Esc or P pause, and should the window auto-pause on blur? Recommendation: yes to both, with the pause overlay listing the controls.
- **Q2 ([#21](https://github.com/omkarbhale/riptide-rush/issues/21)). Healing.** Superseded by #54 (§3.9a): Rip recovers HP through heal orbs and flawless waves, both earned by chaining. The original recommendation (no healing) was reversed after playtest: an early mistake stayed permanent for the whole run.
- **Q3 ([#23](https://github.com/omkarbhale/riptide-rush/issues/23)). Mine defuse counts as a kill?** Recommendation: yes, it adds to combo, scores 75 × multiplier, and refunds a charge, so dashing through mines is never a worse choice than dashing through Drifters.
- **Q4 ([#25](https://github.com/omkarbhale/riptide-rush/issues/25)). Perfect pulse window definition.** The window is defined as time-to-impact ≤ 0.12 s. For a 230 px/s spitter bullet that is about 28 px of travel, a narrow window. Recommendation: keep the definition and validate it in the fx lab with a playtest of at least 20 pulses; widen to 0.15 s only if fewer than one in five pulses on incoming bullets is perfect.
- **Q5 ([#27](https://github.com/omkarbhale/riptide-rush/issues/27)). Shellback front contact.** Should dashing into the front arc bounce Rip back, or stop Rip where they touched? Recommendation: bounce 40 px over 0.1 s, no damage, charge spent. It reads as a clear failure without punishing hard.
- **Q6 ([#29](https://github.com/omkarbhale/riptide-rush/issues/29)). Full charge refund.** When a kill refunds a charge while the bar is full, should the refund be banked for later? Recommendation: no banking. The refund is lost. Banking would hide the cost of over-chaining and break the 3-charge cap in §3.3.
- **Q7 ([#31](https://github.com/omkarbhale/riptide-rush/issues/31)). Enemy readability for colorblind players.** Shapes are already distinct, and telegraphs are described in §4.3. Should there be an option for shape icons on each enemy? Recommendation: add an icon-overlay option in v2, not v1, after the core game is playtested.
- **Q8 ([#33](https://github.com/omkarbhale/riptide-rush/issues/33)). Enemy HP.** Should Shellback or future enemies have more than 1 HP? Recommendation: stay at 1 HP for all enemies in v1. The armor arc already creates the difficulty without a second health bar.
- **Q9 ([#35](https://github.com/omkarbhale/riptide-rush/issues/35)). Music intensity mapping.** Which combo tiers change the music layer? Recommendation: four layers, one added at tiers 10, 20, 30, and 40, with `audio.setMusicIntensity` set to tier/4.
- **Q10 ([#37](https://github.com/omkarbhale/riptide-rush/issues/37)). Persistence beyond a single high score.** Should local storage keep a top-5 list instead of one high score? Recommendation: top-5 locally, stored under `riptide.highscore.v1` as an array, with the same key name and a migration from the single value.
- **Q11 ([#39](https://github.com/omkarbhale/riptide-rush/issues/39)). Wave timeout.** Should a wave end at 25 s even with enemies alive? Recommendation: yes. The timeout keeps the game moving for passive players, and the alive enemies keep acting, so it is never a free wave.
- **Q12 ([#40](https://github.com/omkarbhale/riptide-rush/issues/40)). Spawn distance rule.** Is 200 px the right minimum distance from Rip for spawns? Recommendation: keep 200 px. It leaves room to dash out of a spawn group without taking damage on spawn.

---

## 10. Self-review checklist

- Every `#1` value appears verbatim in §3–§4 and §6 (checked against #1 numbers: 330 px/s, 1280×720, 120 Hz, 210 px, 0.12 s, 3 charges, 0.9 s, 110 px, 2.5 s, 0.12 s perfect window, 120 ms buffer, 3 HP, ~1 s invulnerability, 2.5 s combo timer, floor(combo/5), ×10 cap, 300 ms restart, 40–70 ms hit-stop, 0.6 s telegraph, colors, 120 Hz, 200+ entities, 60 fps).
- Feedback matrix (§5) has 13 rows; every cell is filled, using `none` where the channel is silent.
- Scoring formula (§6) has three worked examples.
- Difficulty table (§7.1) was computed by hand from the §7.1 formulas and cross-checked: each row's total matches the sum of its enemy counts.
- Beginner and expert walkthroughs (§2) use only rules defined in §3–§4 (combo timer, hit does not reset combo, charge refund, mine rules).

### 7.4 Balance pass: schools, overlap, pressure, the ramp (#97)

> Superseded in part by §7.5 (#105): the school size and cap, the cadence, the overlap rule (a wave now hands over when its last school is released, not at 15%), the beyond-20 budget (120 + 12k), and the Drifter counts. The rules below that §7.5 does not mention still stand.

The balance pass made the field denser and waves overlap, so a dash can kill several enemies and the difficulty keeps rising. It was tuned against the headless bot harness (`tools/bot/`, report in `docs/playtests/003-balance-pass.md`). Source: `src/waves.js`, `src/game.js`, `src/config.js`.

**Schools.** Drifters arrive in schools of 4–8 that swim in a formation: a line across the front, a wedge led by one member, or a ring. A school's anchor swims toward Rip at 0.8× chase speed and faces her; members hold their slot and chase Rip directly once she is within 120 px. Every other kind comes alone. The school cap grows by one every 4 waves, from 4 at wave 1 to 8 from wave 17. Splitter minis keep the split ring. A dash through a school's line kills several at once.

**Overlapping waves.** A wave that is not a release wave hands over to the next wave when it is down to 15% of its count (at least one enemy), or after 14 s, so stragglers keep fighting while the next wave arrives. Release waves (3, 5, 9, 11, 15, 18) run to a clear and keep their 2.5 s breather, but a release wave never runs longer than 24 s.

**Stalls (#83).** A lone enemy (the last of its wave, nothing else pending) turns aggressive after 8 s: it moves 1.6× faster and a Spitter fires at once or a Charger lunges at its next chance. An idle mine arms itself after 12 s.

**Pressure.** Enemy movement speeds grow 3.5% per wave past wave 1 with no cap (`SPAWN.speedPerWave`). Waves past 20 are budgeted at 60 + 9k points, with no cap, and weighted toward Spitters, Chargers and Shellbacks.

**Beginner ramp (#84).** Spitter bullets start at 150 px/s and speed up by 6 px/s per wave, to 260. The first shot waits 2.0 s. The first Spitter is held until Drifter schools are cleared (no more than two Drifters left and none queued), and no longer than 12 s. The first Spitter wind-up shows a one-time hint, "DASH THROUGH BULLETS - OR RIGHT-CLICK TO REFLECT"; the first Shellback shows "ARMORED FRONT - STRIKE FROM BEHIND OR PULSE IT". Each is an event (`hint {text, x, y}`), once per run.

**Deflect (#85).** A dash that deflects off a Shellback's front bounces Rip 80 px back over 0.4 s, invulnerable, and refunds the charge the dash spent.

**Spawn clamp (#82).** Spawns and minis are clamped to `ARENA.inset + radius` when they appear, so no enemy starts outside the arena.

**Wave 14 (#88).** Four Chargers (was two).

**Combo tiers (#58).** 10/20/30/40, as in §3.10.

### 7.5 Balance pass 2: crowd density and earned healing (#105)

The arena was too empty for flow: schools died on arrival and about ten enemies were alive, so an expert made about 80 actions per minute. This pass makes the crowd the design, and makes recovery reliably earnable by playing well. Tuned against the harness (`tools/bot/`, report in `docs/playtests/004-balance-pass-2.md`). Source: `src/waves.js`, `src/game.js`, `src/config.js`, `src/pickups.js`.

**Drifters are the crowd.** Waves 3 to 20 carry 150 to 240 Drifters each (wave 21 carries 86; waves 1 and 2 carry 16 and 24, and the first 30 s are Drifter-only to teach chaining). A wave is long enough to keep the crowd full for its whole run. Drifters are numerous, slow (a school swims at 0.8 × 95 px/s) and touch only a Rip who stops: at contact range they are as lethal as before. The count scales, not the lethality.

**Crowd director.** A Drifter school is released only while the live Drifters on the field stay under a target that climbs with the wave: 26 at wave 1, plus 2 a wave, to 50 (`SPAWN.crowdBase`, `crowdPerWave`, `crowdMax`). Warnings do not count, so the next schools can show their warnings while the current ones are still alive. The aim is a standing crowd of about 25–45 during tension waves.

**Schools.** Drifter schools hold 5–8 Drifters (a remainder under 5 is its own school). The cap grows one every 3 waves from 5 at wave 1 to 8 from wave 10. A school of 9 is kept whole, because nine cannot split into two schools of five or more. Schools are released every 0.2 s, several at once from different sides. A school spawns at least 560 px from Rip, so it takes the time to cross the arena before a dash can reach it.

**Overlapping waves.** A non-release wave hands over to the next wave once every one of its schools has been released, so the next wave's warnings show while this wave's schools are still alive. The 14 s limit still applies. Release waves keep their 2.5 s breather and run to a clear, as in §7.4.

**Caps on the shooting and lunging kinds.** Simultaneous Spitters (alive or warned) are capped at 2, rising by one every 4 waves to 5. Chargers are capped at 2, rising by one every 6 waves to 4. A school of either kind waits until a slot is free. Drifters are never capped.

**Earned healing.** Three sources, and no others:
- **Combo heal orb.** A hurt player who reaches combo 20 is owed a heal orb, dropped at the next kill, at most once per 25 s (`PICKUP.heal.comboTrigger`, `comboInterval`). Chaining while hurt brings HP back.
- **Flawless release wave.** A release wave that cost no HP while it was live restores 1 HP if Rip is hurt (see §3.9a).
- **Random orb.** Rare: 0.2% per kill while hurt, plus 0.5% per missing hit point, and a pity on the 300th hurt kill.

**Beyond wave 20.** The budget is 120 + 12k points (was 60 + 9k), with Drifters taking 60% of it. The cadence stays at 0.2 s. The director, not the cadence, sets the crowd.

**Bot sense (harness only).** The beginner bot now sees a Spitter bullet only after 400 ms in view, and reacts to about half of the bullets (decided per bullet). It was blind to bullets before. The change makes the beginner numbers not comparable with playtest 003.

**Boss hold (#114, limited in #105).** A boss wave holds for its boss, but for at most `SPAWN.bossHoldLimit` (60 s). After that it hands over as usual, and a living boss stays in the field. This keeps the harness free of stalled waves (see playtest 004).

**Edge rule.** The release gate reads the field once per decision (`gateCounts`), so a blocked queue costs one pass per step, not one per entry. The sim filters the enemy and bullet lists only when something died. Neither changes what happens in a run.

