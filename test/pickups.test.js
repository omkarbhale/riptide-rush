import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LOGICAL_WIDTH as W,
  LOGICAL_HEIGHT as H,
  SIM_DT,
  DASH,
  PLAYER,
  PICKUP,
  MODIFIER,
  COMBO,
} from '../src/config.js';
import {
  createGame,
  update,
  drainEvents,
  spawnEnemy,
  killEnemy,
  damagePlayer,
  dashPreview,
} from '../src/game.js';
import { dashMaxCharges, healChance, healPlayer, MODIFIER_KINDS } from '../src/pickups.js';

const NONE = { moveX: 0, moveY: 0, aimX: W / 2, aimY: H / 2, dash: false, pulse: false };
const dashAt = (aimX, aimY) => ({ ...NONE, aimX, aimY, dash: true });

// A game with no spawner, so every enemy and pickup in a test is one the test placed.
const quiet = (seed = 1) => createGame(seed, { spawning: false });

function place(g, x, y) {
  const p = g.player;
  p.x = p.px = x;
  p.y = p.py = y;
  p.vx = 0;
  p.vy = 0;
}

function seconds(g, s, input = NONE) {
  const n = Math.round(s / SIM_DT);
  for (let i = 0; i < n; i++) update(g, input, SIM_DT);
}

// Steps until the active dash ends. Frenzy makes the dash longer in time at the same speed.
function finishDash(g) {
  for (let i = 0; i < 60 && g.player.dash.active; i++) update(g, NONE, SIM_DT);
}

// Adds a pickup to the field directly, with no pop, so tests control where it sits.
function addPickup(g, kind, x, y) {
  const it = { id: g.nextId++, kind, x, y, vx: 0, vy: 0, age: 0, r: PICKUP.radius };
  g.pickups.items.push(it);
  return it;
}

// Kills a drifter at (x, y). Advancing game time first keeps the 4 s drop spacing out of the way unless a test wants it.
function killAt(g, x, y, wait = 0) {
  g.time += wait;
  const e = spawnEnemy(g, 'drifter', x, y);
  return killEnemy(g, e, 1);
}

// Replaces the generator with one that always returns v (for threshold tests).
function constantRng(g, v) {
  g.rng = () => v;
}

function takeEvents(g, type) {
  return drainEvents(g).filter((ev) => ev.type === type);
}

const near = (actual, expected, tol, msg) =>
  assert.ok(Math.abs(actual - expected) <= tol, `${msg ?? ''} expected ~${expected}, got ${actual}`);

// ---- Drop rules -----------------------------------------------------------------------------

test('heal chance is the base plus a step per missing hit point', () => {
  const g = quiet();
  const { baseChance, chancePerMissingHp } = PICKUP.heal;
  g.player.hp = 2;
  near(healChance(g), baseChance + chancePerMissingHp, 1e-9, 'one missing');
  g.player.hp = 1;
  near(healChance(g), baseChance + 2 * chancePerMissingHp, 1e-9, 'two missing');

  // Threshold check: a roll just under the chance drops a heal, a roll just over does not.
  const chance = healChance(g);
  const hurt = quiet();
  hurt.player.hp = 1;
  constantRng(hurt, chance - 0.001);
  killAt(hurt, 500, 300);
  assert.ok(hurt.pickups.items.some((it) => it.kind === 'heal'), 'a roll under the chance drops a heal');

  const miss = quiet();
  miss.player.hp = 1;
  constantRng(miss, chance + 0.001);
  killAt(miss, 500, 300);
  assert.ok(!miss.pickups.items.some((it) => it.kind === 'heal'), 'a roll over the chance does not');
});

test('no heal drops at full HP, even when every roll would succeed', () => {
  const g = quiet();
  constantRng(g, 0);
  for (let i = 0; i < 200; i++) {
    g.pickups.items = [];
    killAt(g, 500, 300, PICKUP.dropSpacing + 0.1);
    assert.ok(!g.pickups.items.some((it) => it.kind === 'heal'), 'heal dropped at full HP');
  }
  assert.equal(g.pickups.healPity, 0, 'heal pity does not build at full HP');
});

test('heal pity guarantees a heal drop on the pityKills-th kill while hurt', () => {
  const g = quiet();
  g.player.hp = 2;
  constantRng(g, 0.99); // no chance rolls succeed, and no modifier chance either
  let firstHeal = -1;
  for (let kill = 1; kill <= PICKUP.heal.pityKills + 5; kill++) {
    g.pickups.items = [];
    g.combo.count = 0; // keep the chain under the combo-20 guarantee (#105), so this test sees only the pity
    killAt(g, 500, 300, PICKUP.dropSpacing + 0.1);
    if (firstHeal < 0 && g.pickups.items.some((it) => it.kind === 'heal')) firstHeal = kill;
  }
  assert.equal(firstHeal, PICKUP.heal.pityKills, 'the first heal drop is on the pity kill');
});

test('reaching a new combo tier while hurt no longer guarantees a heal drop (#87)', () => {
  const g = quiet();
  g.player.hp = 2;
  constantRng(g, 0.99);
  // Combo tier 1 now starts at 10 kills (#58). The tier-up does not force a heal.
  for (let kill = 1; kill <= COMBO.tiers[0]; kill++) killAt(g, 500, 300);
  assert.equal(g.combo.tier, 1, 'the tier is reached');
  assert.equal(g.pickups.items.filter((it) => it.kind === 'heal').length, 0, 'no guaranteed heal on a tier-up');
});

test('modifier pity guarantees a modifier drop on the modifierPityKills-th kill', () => {
  const g = quiet();
  constantRng(g, 0.99); // no chance rolls succeed
  let firstDrop = -1;
  for (let kill = 1; kill <= PICKUP.modifierPityKills + 5; kill++) {
    g.pickups.items = [];
    killAt(g, 500, 300, PICKUP.dropSpacing + 0.1);
    if (firstDrop < 0 && g.pickups.items.length > 0) firstDrop = kill;
  }
  assert.equal(firstDrop, PICKUP.modifierPityKills, 'the first modifier drop is on the pity kill');
});

test('at most 3 pickups on the field, and never two drops within 4 s', () => {
  const g = quiet();
  g.player.hp = 2;
  constantRng(g, 0);

  // Spacing: a drop at t=0 blocks one at t=1 but allows one at t=4.
  killAt(g, 500, 300);
  assert.equal(g.pickups.items.length, 1, 'first kill drops');
  killAt(g, 500, 300, 1);
  assert.equal(g.pickups.items.length, 1, 'a drop 1 s later is blocked');
  killAt(g, 500, 300, 3);
  assert.equal(g.pickups.items.length, 2, 'a drop 4 s after the first is allowed');

  // Field cap: many more kills never exceed 3 on the field.
  for (let i = 0; i < 10; i++) killAt(g, 500, 300, PICKUP.dropSpacing + 0.1);
  assert.equal(g.pickups.items.length, PICKUP.maxOnField, 'the field holds at most 3');
});

test('a seeded run drops the same pickups every time', () => {
  const run = (seed) => {
    const g = quiet(seed);
    g.player.hp = 2;
    const out = [];
    for (let i = 0; i < 300; i++) {
      killAt(g, 300 + (i % 7) * 60, 300, PICKUP.dropSpacing + 0.1);
      out.push(...g.pickups.items.splice(0).map((it) => `${it.kind}@${it.x.toFixed(3)},${it.y.toFixed(3)}`));
    }
    return out.join('|');
  };
  assert.equal(run(7), run(7), 'same seed, same drops');
  assert.notEqual(run(7), run(8), 'different seeds differ');
});

test('modifier drop rate is about 2% per kill, with pity keeping gaps at modifierPityKills or fewer', () => {
  const g = quiet(2024);
  let kills = 0;
  let drops = 0;
  for (let i = 0; i < 6000; i++) {
    g.pickups.items = [];
    killAt(g, 500, 300, PICKUP.dropSpacing + 0.1);
    kills += 1;
    drops += g.pickups.items.length;
  }
  const rate = drops / kills;
  // A 1.5% chance per kill, capped by pity at 90 kills, gives about 2.0% of kills dropping a modifier (#87).
  assert.ok(rate > 0.016 && rate < 0.025, `modifier drop rate ${rate.toFixed(4)} outside 1.6% to 2.5%`);
});

// ---- Modifiers: effect and expiry -----------------------------------------------------------

test('Spark Coral adds a fourth charge and refills all charges for its duration, then drops back to 3', () => {
  const g = quiet();
  place(g, 600, 360);
  g.player.dash.charges = 0;
  addPickup(g, 'sparkCoral', 600, 360);
  update(g, NONE, SIM_DT);
  assert.equal(g.modifiers.sparkCoral !== undefined, true, 'modifier active');
  assert.equal(dashMaxCharges(g), DASH.maxCharges + MODIFIER.sparkCoral.extraCharges, 'max is 4');
  assert.equal(g.player.dash.charges, 4, 'instant full recharge');
  assert.equal(takeEvents(g, 'pickup').length, 1, 'pickup event');
  seconds(g, MODIFIER.sparkCoral.duration - 0.5);
  assert.ok(g.modifiers.sparkCoral > 0, 'still active just before expiry');
  seconds(g, 0.6);
  assert.equal(g.modifiers.sparkCoral, undefined, 'expired on time');
  assert.equal(g.player.dash.charges, DASH.maxCharges, 'charges clamp back to 3');
  assert.equal(takeEvents(g, 'modifierEnd').length, 1, 'modifierEnd fires once');
});

test('Riptide Coal drains the combo timer at half speed for 6 s', () => {
  const g = quiet();
  constantRng(g, 0.99); // no drops: this test only watches the combo timer
  killAt(g, 500, 300); // combo 1, timer set to comboWindowFor(1), about 2.47 s
  assert.equal(g.combo.count, 1);
  g.modifiers.riptideCoal = MODIFIER.riptideCoal.duration;
  const start = g.combo.timer;
  seconds(g, 1);
  near(start - g.combo.timer, 0.5, 0.02, 'with Coal, 1 s drains 0.5 s of combo timer');

  g.modifiers.riptideCoal = 0.5;
  seconds(g, 1);
  assert.equal(g.modifiers.riptideCoal, undefined, 'expired');
  const before = g.combo.timer;
  seconds(g, 0.5);
  near(before - g.combo.timer, 0.5, 0.02, 'after expiry the timer runs at full speed');
});

test('Frenzy recharges dash charges faster and adds 25% to dash distance, for its duration', () => {
  const g = quiet();
  place(g, 300, H / 2);
  g.modifiers.frenzy = MODIFIER.frenzy.duration;
  g.player.dash.charges = 0;
  g.player.dash.recharge = 0;
  // One charge takes DASH.rechargeTime / rechargeScale under Frenzy (#87: 2x, was 3x).
  seconds(g, DASH.rechargeTime / MODIFIER.frenzy.rechargeScale + 0.01);
  assert.equal(g.player.dash.charges, 1, 'one charge after the faster recharge');
  // The dash ends after 15 steps (0.12 s). Measure there, before exit momentum carries Rip on.
  const h = quiet();
  place(h, 300, H / 2);
  update(h, dashAt(900, H / 2), SIM_DT);
  finishDash(h);
  assert.equal(h.player.dash.active, null, 'baseline dash finished');
  near(h.player.x - 300, DASH.distance, 1e-6, 'baseline dash distance');
  const f = quiet();
  place(f, 300, H / 2);
  f.modifiers.frenzy = MODIFIER.frenzy.duration;
  update(f, dashAt(900, H / 2), SIM_DT);
  finishDash(f);
  assert.equal(f.player.dash.active, null, 'Frenzy dash finished');
  near(f.player.x - 300, DASH.distance * (1 + MODIFIER.frenzy.dashDistanceBonus), 1e-6, 'Frenzy dash distance');
  seconds(f, MODIFIER.frenzy.duration);
  assert.equal(f.modifiers.frenzy, undefined, 'Frenzy expired');
});

test('Undertow: every kill releases a 90 px shockwave that kills adjacent enemies and chains', () => {
  const g = quiet();
  const a = spawnEnemy(g, 'drifter', 500, 300);
  spawnEnemy(g, 'drifter', 560, 300); // 60 px from a
  spawnEnemy(g, 'drifter', 640, 300); // 80 px from the middle one, 140 px from a
  constantRng(g, 0.99); // no drops mid-chain
  g.modifiers.undertow = MODIFIER.undertow.duration;

  const kills = killEnemy(g, a, 1);
  assert.equal(kills, 3, 'the chain kills all three');
  assert.equal(g.enemies.filter((e) => e.alive).length, 0, 'no enemy survives');
  assert.equal(g.combo.count, 3, 'chain kills count for combo');
  // Kill 1 scores 10 (no multi bonus). Kills 2 and 3 are chain kills after the first, so each gets the multi bonus: 10 + 25.
  assert.equal(g.score, 10 + 35 + 35, 'chain kills count for score');
  assert.equal(takeEvents(g, 'kill').length, 3, 'three kill events');
});

test('Undertow ignores enemies beyond 90 px and expires after 5 s', () => {
  const g = quiet();
  const a = spawnEnemy(g, 'drifter', 500, 300);
  const far = spawnEnemy(g, 'drifter', 500, 300 + 100); // 100 px away
  constantRng(g, 0.99); // no drops, so nothing can refresh the timer
  g.modifiers.undertow = MODIFIER.undertow.duration;
  assert.equal(killEnemy(g, a, 1), 1, 'a kill with nothing in range chains nowhere');
  assert.ok(far.alive, 'an enemy 100 px away survives');

  g.enemies = []; // the survivor would otherwise touch Rip and end the run, which freezes the timers
  seconds(g, 5.5);
  assert.equal(g.modifiers.undertow, undefined, 'Undertow expired after 5 s');
});

test('Shield Scale absorbs exactly one hit, with no HP lost and no normal invulnerability', () => {
  const g = quiet();
  place(g, 600, 360);
  g.modifiers.shieldScale = MODIFIER.shieldScale.duration;

  assert.equal(damagePlayer(g, 560, 360), true, 'the attack connects and the shield takes it');
  assert.equal(g.player.hp, PLAYER.maxHp, 'no HP lost');
  assert.equal(g.player.invuln, 0, 'normal hit invulnerability is not triggered');
  assert.equal(g.modifiers.shieldScale, undefined, 'shield is used up');
  const breaks = takeEvents(g, 'shieldBreak');
  assert.equal(breaks.length, 1, 'shieldBreak fires once');

  // Right after absorbing, a second touch is held off by the short bounce grace...
  assert.equal(damagePlayer(g, 560, 360), false, 'bounce grace blocks the next touch');
  assert.equal(g.player.hp, PLAYER.maxHp);

  // ...and once the grace is over, the next hit lands normally.
  seconds(g, PICKUP.shield.grace + 0.05);
  assert.equal(damagePlayer(g, 560, 360), true, 'a hit with no shield lands');
  assert.equal(g.player.hp, PLAYER.maxHp - 1);
});

test('Shield Scale expires after 6 s if it is not used', () => {
  const g = quiet();
  g.modifiers.shieldScale = MODIFIER.shieldScale.duration;
  seconds(g, 6.2);
  assert.equal(g.modifiers.shieldScale, undefined, 'expired');
  assert.equal(takeEvents(g, 'modifierEnd').length, 1);
});

test('re-collecting a modifier refreshes its timer and does not stack', () => {
  const g = quiet();
  place(g, 600, 360);
  g.modifiers.frenzy = 1;
  addPickup(g, 'frenzy', 600, 360);
  update(g, NONE, SIM_DT);
  near(g.modifiers.frenzy, MODIFIER.frenzy.duration, 0.02, 'timer reset to the full duration');
  assert.equal(Object.keys(g.modifiers).length, 1);
});

// ---- Pickup behaviour -----------------------------------------------------------------------

test('a pickup is pulled in by the magnet from within 120 px, and not from beyond it', () => {
  const g = quiet();
  place(g, 640, 360);
  addPickup(g, 'frenzy', 640 + 100, 360); // 100 px away
  seconds(g, 1);
  assert.equal(takeEvents(g, 'pickup').length, 1, 'magnet brings it in');
  assert.equal(g.pickups.items.length, 0);

  place(g, 640, 360);
  addPickup(g, 'frenzy', 640, 360 - 200); // 200 px away, outside the magnet
  seconds(g, 2);
  assert.equal(g.pickups.items.length, 1, 'a pickup 200 px away stays put');
});

test('a dash whose path passes within 60 px collects a pickup the magnet would not reach', () => {
  const g = quiet();
  place(g, 300, 360);
  // Dash east along y=360. The pickup is 50 px off the path and about 158 px from the start.
  addPickup(g, 'frenzy', 450, 410);
  update(g, dashAt(900, 360), SIM_DT);
  seconds(g, 0.2);
  const got = takeEvents(g, 'pickup');
  assert.equal(got.length, 1, 'the dash collects it');
  assert.equal(got[0].kind, 'frenzy');
});

test('a pickup 200 px off the path is not collected by a dash', () => {
  const g = quiet();
  place(g, 300, 360);
  addPickup(g, 'frenzy', 450, 560); // 200 px below the path
  update(g, dashAt(900, 360), SIM_DT);
  seconds(g, 0.2);
  assert.equal(takeEvents(g, 'pickup').length, 0);
  assert.equal(g.pickups.items.length, 1);
});

test('pickups last 7 s, then despawn', () => {
  const g = quiet();
  place(g, 1000, 600);
  addPickup(g, 'shieldScale', 200, 200);
  seconds(g, 6.9);
  assert.equal(g.pickups.items.length, 1, 'still there at 6.9 s');
  seconds(g, 0.2);
  assert.equal(g.pickups.items.length, 0, 'gone after 7 s');
});

test('a heal orb restores 1 HP when collected below max', () => {
  const g = quiet();
  place(g, 640, 360);
  g.player.hp = 1;
  addPickup(g, 'heal', 640, 360);
  update(g, NONE, SIM_DT);
  assert.equal(g.player.hp, 2, 'one HP restored');
  const heals = takeEvents(g, 'heal');
  assert.equal(heals.length, 1);
  assert.equal(heals[0].source, 'drop');
  assert.equal(heals[0].bonus, 0);
});

test('a heal collected at full HP converts to bonus score', () => {
  const g = quiet();
  place(g, 640, 360);
  addPickup(g, 'heal', 640, 360);
  update(g, NONE, SIM_DT);
  assert.equal(g.player.hp, PLAYER.maxHp);
  assert.equal(g.score, PICKUP.overflowScore * 1, 'bonus at combo 0 (x1)');
  assert.equal(takeEvents(g, 'heal')[0].bonus, PICKUP.overflowScore);
});

// A wave clears when its queue is empty and every enemy it spawned is dead. These tests empty the queue
// and let the spawner notice on the next step, which is the real waveClear path.
function clearWave(g) {
  g.spawnQueue = [];
  g.warnings = [];
  g.enemies = [];
  update(g, NONE, SIM_DT);
}

// Marks wave 1 (the only live wave of a fresh game) as a release wave or not, as the wave table would.
function makeRelease(g, release) {
  g.liveWaves[0].release = release;
}

test('a flawless release wave heals 1 HP when Rip is hurt (#105)', () => {
  const g = createGame(1);
  g.player.hp = 2;
  makeRelease(g, true);
  clearWave(g);
  assert.equal(g.player.hp, 3, 'one HP back for a clean release wave');
  const heals = takeEvents(g, 'heal');
  assert.equal(heals.length, 1);
  assert.equal(heals[0].source, 'flawless');
  assert.equal(heals[0].bonus, 0, 'a real heal, not a bonus');
});

test('a release wave that cost HP while it was live is not flawless (#105)', () => {
  const g = createGame(1);
  g.player.hp = 2;
  makeRelease(g, true);
  g.pickups.hurts += 1; // a hit landed while this wave was live
  clearWave(g);
  assert.equal(g.player.hp, 2, 'no flawless heal after a hit');
  assert.equal(takeEvents(g, 'heal').length, 0);
});

test('a flawless non-release wave does not heal (#105: release waves only)', () => {
  const g = createGame(1);
  g.player.hp = 2;
  makeRelease(g, false);
  clearWave(g);
  assert.equal(g.player.hp, 2, 'no heal on a tension wave');
  assert.equal(takeEvents(g, 'heal').length, 0);
});

test('a flawless release clear at full HP adds no bonus score (#87)', () => {
  const g = createGame(1);
  makeRelease(g, true);
  const before = g.score;
  clearWave(g);
  assert.equal(g.score, before, 'no bonus score from a clear');
  assert.equal(takeEvents(g, 'heal').length, 0, 'no heal event');
});

test('a hurt player who reaches combo 20 gets a guaranteed heal orb (#105)', () => {
  const g = quiet();
  g.player.hp = 2;
  constantRng(g, 0.99); // no random heal or modifier rolls succeed
  for (let kill = 1; kill < PICKUP.heal.comboTrigger; kill++) {
    g.pickups.items = [];
    killAt(g, 500, 300, PICKUP.dropSpacing + 0.1);
  }
  assert.equal(g.pickups.items.filter((it) => it.kind === 'heal').length, 0, 'no orb before combo 20');
  g.pickups.items = [];
  killAt(g, 500, 300, PICKUP.dropSpacing + 0.1);
  const orbs = g.pickups.items.filter((it) => it.kind === 'heal');
  assert.equal(orbs.length, 1, 'the orb drops on combo 20');
  assert.equal(orbs[0].origin, 'combo');
});

test('the combo-20 orb comes at most once per comboInterval seconds (#105)', () => {
  const g = quiet();
  g.player.hp = 2;
  constantRng(g, 0.99);
  const drops = [];
  // Each kill is 4.1 s after the last, so the 25 s limit lands on a later kill, not every kill.
  for (let kill = 1; kill <= 60; kill++) {
    g.pickups.items = [];
    killAt(g, 500, 300, PICKUP.dropSpacing + 0.1);
    if (g.pickups.items.some((it) => it.kind === 'heal' && it.origin === 'combo')) drops.push(g.time);
  }
  assert.ok(drops.length >= 2, 'the chain earns more than one orb');
  for (let i = 1; i < drops.length; i++) {
    assert.ok(drops[i] - drops[i - 1] >= PICKUP.heal.comboInterval, `orbs ${drops[i] - drops[i - 1]} s apart`);
  }
});

test('a combo-20 orb is not owed to a player who is not hurt (#105)', () => {
  const g = quiet();
  constantRng(g, 0.99);
  for (let kill = 1; kill <= PICKUP.heal.comboTrigger + 2; kill++) {
    g.pickups.items = [];
    killAt(g, 500, 300, PICKUP.dropSpacing + 0.1);
  }
  assert.equal(g.pickups.items.filter((it) => it.kind === 'heal').length, 0, 'no heal orb at full HP');
  assert.equal(g.pickups.comboDue, false);
});

test('healPlayer restores up to max and never above it', () => {
  const g = quiet();
  g.player.hp = PLAYER.maxHp - 1;
  healPlayer(g, 0, 0, 'drop');
  healPlayer(g, 0, 0, 'drop');
  assert.equal(g.player.hp, PLAYER.maxHp);
});

test('Frenzy widens the lunge window: dashPreview and the real dash both use the 25% longer distance', () => {
  const g = quiet();
  place(g, 300, H / 2);
  const e = spawnEnemy(g, 'drifter', 600, H / 2); // 300 px ahead on the aim line
  e.stagger = 100; // keep it still
  // Without Frenzy the lunge reach is DASH.lungeMaxDistance (275 px), so 300 px is out of reach.
  assert.equal(dashPreview(g, 900, H / 2).assisted, false, 'no Frenzy: 300 px is beyond reach');
  g.modifiers.frenzy = MODIFIER.frenzy.duration;
  const pv = dashPreview(g, 900, H / 2);
  assert.equal(pv.assisted, true, 'Frenzy: the reach grows to about 344 px, so the dash is extended to it');
  near(pv.x, 600, 1e-6, 'preview end point');
  update(g, dashAt(900, H / 2), SIM_DT);
  finishDash(g);
  near(g.player.x, 600, 1e-6, 'the real dash ends where the preview said');
});

test('Shield Scale only absorbs a hit that would land: grace and i-frames leave the shield for later', () => {
  const g = quiet();
  place(g, 600, 360);
  g.modifiers.shieldScale = MODIFIER.shieldScale.duration;

  g.player.dashGrace = 0.2;
  assert.equal(damagePlayer(g, 560, 360), false, 'dash grace blocks the hit');
  assert.ok(g.modifiers.shieldScale > 0, 'the shield is not spent on a blocked hit');
  assert.equal(takeEvents(g, 'shieldBreak').length, 0);

  g.player.dashGrace = 0;
  g.player.invuln = 0.5;
  assert.equal(damagePlayer(g, 560, 360), false, 'post-hit invulnerability blocks the hit');
  assert.ok(g.modifiers.shieldScale > 0, 'still not spent');

  g.player.invuln = 0;
  assert.equal(damagePlayer(g, 560, 360), true, 'a hit that would land is absorbed');
  assert.equal(g.modifiers.shieldScale, undefined, 'now it is spent');
  assert.equal(g.player.hp, PLAYER.maxHp, 'no HP lost');
});
