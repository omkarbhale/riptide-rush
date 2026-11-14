import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LOGICAL_WIDTH as W,
  LOGICAL_HEIGHT as H,
  SIM_DT,
  DASH,
  PULSE,
  PLAYER,
  SPAWN,
  COMBO,
  ENEMY,
} from '../src/config.js';
import {
  createGame,
  update,
  drainEvents,
  spawnEnemy,
  killEnemy,
  damagePlayer,
  segmentHitsCircle,
  multiplierFor,
  comboWindowFor,
  hitStopFor,
  tierFor,
  mulberry32,
  ENEMY_KINDS,
  dashPreview,
} from '../src/game.js';
import { SCRIPTED_KINDS } from '../src/waves.js';
import { createActionBuffer } from '../src/input.js';

const NONE = { moveX: 0, moveY: 0, aimX: W / 2, aimY: H / 2, dash: false, pulse: false };
const dashAt = (aimX, aimY) => ({ ...NONE, aimX, aimY, dash: true });
const pulseInput = { ...NONE, pulse: true };

// A game with no spawner, so every enemy in a test is one the test placed.
const quiet = (seed = 1) => createGame(seed, { spawning: false });

function place(g, x, y) {
  const p = g.player;
  p.x = p.px = x;
  p.y = p.py = y;
  p.vx = 0;
  p.vy = 0;
}

function steps(g, n, input = NONE) {
  for (let i = 0; i < n; i++) update(g, input, SIM_DT);
}

function seconds(g, s, input = NONE) {
  steps(g, Math.round(s / SIM_DT), input);
}

// Runs `n` steps and returns every event they produced, in order.
function run(g, n, input = NONE) {
  const events = [];
  for (let i = 0; i < n; i++) {
    update(g, input, SIM_DT);
    events.push(...drainEvents(g));
  }
  return events;
}

const collect = (g, s, input = NONE) => run(g, Math.round(s / SIM_DT), input);
const kindOf = (events, type) => events.filter((ev) => ev.type === type);

function addBullet(g, x, y, vx, vy) {
  g.bullets.push({ id: g.nextId++, owner: 'enemy', x, y, px: x, py: y, vx, vy, r: 6, life: 4, alive: true });
}

function assertNear(actual, expected, tol, msg) {
  assert.ok(Math.abs(actual - expected) <= tol, `${msg ?? ''} expected ~${expected}, got ${actual}`);
}

test('dash starts with 3 charges, costs one, moves 210 px in 0.12 s, and recharges one per 0.9 s', () => {
  const g = quiet();
  place(g, 300, H / 2);
  assert.equal(g.player.dash.charges, DASH.maxCharges);

  // The dash starts and finishes in the same 15 steps (0.12 s at 120 Hz rounds up to 15).
  update(g, dashAt(900, H / 2), SIM_DT);
  assert.equal(g.player.dash.charges, 2);
  assert.ok(g.player.dash.active, 'dash should be active');
  steps(g, 14);
  assert.equal(g.player.dash.active, null, 'dash should have finished');
  assertNear(g.player.x, 300 + DASH.distance, 1e-6, 'dash distance');

  seconds(g, 0.5);
  assert.equal(g.player.dash.charges, 2, 'no recharge before 0.9 s');
  seconds(g, 0.45);
  assert.equal(g.player.dash.charges, 3, 'one charge back after 0.9 s');
});

test('a dash needs a charge', () => {
  const g = quiet();
  place(g, 300, H / 2);
  g.player.dash.charges = 0;
  update(g, dashAt(900, H / 2), SIM_DT);
  assert.equal(g.player.dash.active, null);
  assert.equal(g.player.dash.charges, 0);
});

test('each kill refunds one dash charge immediately, capped at the maximum', () => {
  const g = quiet();
  place(g, 300, H / 2);
  spawnEnemy(g, 'drifter', 400, H / 2);

  update(g, dashAt(900, H / 2), SIM_DT);
  assert.equal(g.player.dash.charges, 2, 'dash spent one charge');
  for (let i = 0; i < 20 && g.kills === 0; i++) update(g, NONE, SIM_DT);
  assert.equal(g.kills, 1, 'dash killed the drifter in its path');
  assert.equal(g.player.dash.charges, 3, 'the kill refunded the charge at once');

  // A kill at full charges does not overflow the cap.
  const e = spawnEnemy(g, 'drifter', 900, 100);
  killEnemy(g, e, 1);
  assert.equal(g.player.dash.charges, DASH.maxCharges);
});

test('swept dash kills an enemy the path crosses even when one step covers the whole dash', () => {
  const g = quiet();
  place(g, 300, H / 2);
  spawnEnemy(g, 'drifter', 400, H / 2); // dead centre of the 300 -> 510 path

  // One step of the full dash duration: a point test at the endpoint would miss the enemy.
  update(g, dashAt(900, H / 2), DASH.duration);
  assert.equal(g.kills, 1);
  assert.equal(g.enemies.length, 0);
});

test('swept dash misses an enemy that is clear of the path', () => {
  const g = quiet();
  place(g, 300, H / 2);
  // Path is a horizontal segment; enemy radius 13 + blade 26 = 39, so 60 px off-axis is clear.
  spawnEnemy(g, 'drifter', 400, H / 2 + 60);
  update(g, dashAt(900, H / 2), DASH.duration);
  assert.equal(g.kills, 0);
  assert.equal(g.enemies.length, 1);
});

test('segment test catches a crossing that point tests would skip', () => {
  assert.equal(segmentHitsCircle(0, 0, 1000, 0, 500, 0, 1), true);
  assert.equal(segmentHitsCircle(0, 0, 1000, 0, 500, 5, 1), false);
  assert.equal(segmentHitsCircle(0, 0, 10, 0, 50, 0, 1), false, 'circle past the segment end');
});

test('multiplier is 1 + floor(combo / 5), capped at x10', () => {
  assert.equal(multiplierFor(0), 1);
  assert.equal(multiplierFor(4), 1);
  assert.equal(multiplierFor(5), 2);
  assert.equal(multiplierFor(9), 2);
  assert.equal(multiplierFor(10), 3);
  assert.equal(multiplierFor(45), COMBO.multiplierCap);
  assert.equal(multiplierFor(999), COMBO.multiplierCap);
});

test('combo timer is 2.5 s at x1, shrinks linearly with the multiplier, and floors at 1.6 s at x10', () => {
  assert.equal(comboWindowFor(0), COMBO.window);
  assert.equal(comboWindowFor(4), COMBO.window, 'still x1');
  assert.ok(comboWindowFor(10) < comboWindowFor(1));
  // x2 is one ninth of the way from 2.5 to 1.6 s.
  assertNear(comboWindowFor(5), COMBO.window - (COMBO.window - COMBO.windowMin) / 9, 1e-9, 'x2 step');
  assert.equal(comboWindowFor(45), COMBO.windowMin, 'x10 reaches the floor');
  assert.equal(comboWindowFor(500), COMBO.windowMin, 'the floor holds above x10');
});

test('combo tiers step up at the configured counts', () => {
  assert.equal(tierFor(0), 0);
  assert.equal(tierFor(4), 0);
  assert.equal(tierFor(5), 1);
  assert.equal(tierFor(10), 2);
  assert.equal(tierFor(20), 3);
  assert.equal(tierFor(30), 4);
});

test('kill score is base x multiplier of the combo after the kill', () => {
  const g = quiet();
  for (let i = 0; i < 5; i++) killEnemy(g, spawnEnemy(g, 'drifter', 100 + i * 50, 100), 1);
  // Kills 1-4 are at x1 (4 x 10); kill 5 makes combo 5, so x2 (20).
  assert.equal(g.combo.count, 5);
  assert.equal(g.score, 60);
  assert.equal(g.combo.tier, 1, 'five kills reach colour tier 1');
});

test('a multi-kill bonus applies to the second and later kills in one slash, and the kill event carries it', () => {
  const g = quiet();
  for (let i = 0; i < 5; i++) killEnemy(g, spawnEnemy(g, 'drifter', 100 + i * 50, 100), 1);
  drainEvents(g);
  // Combo becomes 6 (x2). Base 10 x2 = 20, plus multi bonus 25 x2 = 50, total 70.
  killEnemy(g, spawnEnemy(g, 'drifter', 600, 600), 2);
  assert.equal(g.score, 60 + 70);
  const kill = drainEvents(g).find((ev) => ev.type === 'kill');
  assert.equal(kill.points, 70);
  assert.equal(kill.bonus, 50);
  assert.equal(kill.multi, 2);
  assert.equal(kill.combo, 6);
  assert.equal(kill.hitStopMs, hitStopFor(2));
});

test('hit-stop is 40 ms for one kill, +10 ms per extra kill in a slash, capped at 100 ms', () => {
  assert.equal(hitStopFor(1), 40);
  assert.equal(hitStopFor(2), 50);
  assert.equal(hitStopFor(4), 70);
  assert.equal(hitStopFor(20), 100);
});

test('combo expires after its timer, dropping to 0 with a comboLost event', () => {
  const g = quiet();
  killEnemy(g, spawnEnemy(g, 'drifter', 300, 300), 1);
  assert.equal(g.combo.count, 1);
  seconds(g, comboWindowFor(1) - 0.2);
  assert.equal(g.combo.count, 1, 'combo still alive just before expiry');
  seconds(g, 0.4);
  assert.equal(g.combo.count, 0);
  assert.ok(drainEvents(g).some((ev) => ev.type === 'comboLost'));
});

test('a hit costs 1 hp, grants invulnerability, and overlapping hits are ignored until it ends', () => {
  const g = quiet();
  place(g, W / 2, H / 2);
  spawnEnemy(g, 'drifter', W / 2, H / 2).grace = 0; // past the spawn grace
  spawnEnemy(g, 'drifter', W / 2, H / 2).grace = 0;
  steps(g, 1);
  assert.equal(g.player.hp, PLAYER.maxHp - 1, 'two overlapping enemies cost one hit');
  assert.ok(g.player.invuln > 0.9, 'invulnerable after a hit');
  assert.equal(damagePlayer(g, W / 2, H / 2), false, 'no damage while invulnerable');

  g.enemies.length = 0;
  seconds(g, PLAYER.invulnAfterHit + 0.05);
  assert.equal(g.player.invuln, 0);
  assert.equal(damagePlayer(g, W / 2, H / 2), true, 'damage again once invulnerability ends');
  assert.equal(g.player.hp, PLAYER.maxHp - 2);
});

test('three hits end the run with a gameOver event', () => {
  const g = quiet();
  place(g, W / 2, H / 2);
  g.score = 123;
  for (let i = 0; i < PLAYER.maxHp; i++) {
    g.player.invuln = 0;
    damagePlayer(g, W / 2, H / 2);
  }
  assert.equal(g.over, true);
  assert.equal(g.player.hp, 0);
  const over = drainEvents(g).filter((ev) => ev.type === 'gameOver');
  assert.equal(over.length, 1);
  assert.equal(over[0].score, 123);
});

test('dashing makes the player untouchable', () => {
  const g = quiet();
  place(g, 300, H / 2);
  update(g, dashAt(900, H / 2), SIM_DT);
  assert.ok(g.player.dash.active);
  assert.equal(damagePlayer(g, 300, H / 2), false);
  assert.equal(g.player.hp, PLAYER.maxHp);
});

test('a pulse reflects an enemy bullet back at its shooter', () => {
  const g = quiet();
  place(g, W / 2, H / 2);
  addBullet(g, W / 2 + 80, H / 2, -240, 0); // 80 px out: impact in ~0.27 s, not perfect
  update(g, pulseInput, SIM_DT);
  const events = drainEvents(g);
  const b = g.bullets[0];
  assert.equal(b.owner, 'player');
  assertNear(b.vx, 480, 1e-6, 'reflected bullet flies back at 2x speed');
  assert.ok(events.some((ev) => ev.type === 'reflect'));
  assert.ok(!events.some((ev) => ev.type === 'perfectPulse'));
  assertNear(g.player.pulseCooldown, PULSE.cooldown, 1e-9, 'normal pulse starts the cooldown');
});

test('reflecting a bullet within 0.12 s of impact is a perfect pulse: cooldown reset and slow-motion', () => {
  const g = quiet();
  place(g, W / 2, H / 2);
  addBullet(g, W / 2 + 40, H / 2, -240, 0); // 26 px to the body at 240 px/s: ~0.11 s to impact
  update(g, pulseInput, SIM_DT);
  const events = drainEvents(g);
  assert.ok(events.some((ev) => ev.type === 'perfectPulse'), 'perfect pulse fired');
  assert.equal(g.player.pulseCooldown, 0, 'perfect pulse resets the cooldown');
  assert.ok(g.slowmo > 0, 'slow-motion started');

  update(g, pulseInput, SIM_DT);
  assert.ok(drainEvents(g).some((ev) => ev.type === 'pulse'), 'pulse can fire again straight away');
});

test('pulse cooldown is 2.5 s', () => {
  const g = quiet();
  place(g, W / 2, H / 2);
  update(g, pulseInput, SIM_DT);
  drainEvents(g);
  seconds(g, PULSE.cooldown - 0.2, NONE);
  update(g, pulseInput, SIM_DT);
  assert.equal(drainEvents(g).filter((ev) => ev.type === 'pulse').length, 0, 'still cooling down');
  seconds(g, 0.3, NONE);
  update(g, pulseInput, SIM_DT);
  assert.equal(drainEvents(g).filter((ev) => ev.type === 'pulse').length, 1, 'ready again');
});

test('reflected bullets kill the enemy they hit; the pulse also staggers nearby enemies', () => {
  const g = quiet();
  place(g, W / 2, H / 2);
  const spitter = spawnEnemy(g, 'spitter', W / 2 + 120, H / 2); // inside pulse radius + enemy radius
  addBullet(g, W / 2 + 40, H / 2, -240, 0);
  update(g, pulseInput, SIM_DT);
  assert.ok(spitter.stagger > 0, 'pulse staggered the spitter');
  steps(g, 60);
  assert.equal(spitter.alive, false, 'reflected bullet killed the spitter');
  assert.equal(g.kills, 1);
  assert.ok(drainEvents(g).some((ev) => ev.type === 'kill' && ev.enemyType === 'spitter' && ev.cause === 'reflect'));
});

test('spitter fires aimed bullets at the player on its interval', () => {
  const g = quiet();
  place(g, W / 2, H / 2);
  spawnEnemy(g, 'spitter', W / 2 + 300, H / 2);
  seconds(g, ENEMY.spitter.firstShotDelay + ENEMY.spitter.windup + 0.1);
  const bullets = g.bullets.filter((b) => b.owner === 'enemy');
  assert.ok(bullets.length >= 1, 'spitter fired');
  assert.ok(bullets[0].vx < 0, 'bullet flies toward the player');
});

test('charger telegraphs for 0.6 s, then lunges in a straight line', () => {
  const g = quiet();
  place(g, W / 2, H / 2);
  const e = spawnEnemy(g, 'charger', W / 2 + 360, H / 2);
  e.cooldown = 0;
  steps(g, 1);
  assert.equal(e.state, 'telegraph');
  seconds(g, 0.5);
  assert.equal(e.state, 'telegraph', 'still telegraphing at 0.5 s');
  assert.equal(e.vx, 0);
  seconds(g, 0.15);
  assert.equal(e.state, 'lunge');
  assertNear(e.dirX, -1, 1e-9, 'lunge direction is locked toward the player');
});

// ---- Shellback -----------------------------------------------------------------------------

// Places a shellback and sets its facing explicitly (spawning aims it at the player).
function shellbackAt(g, x, y, facing) {
  const e = spawnEnemy(g, 'shellback', x, y);
  e.facing = facing;
  return e;
}

const wrap = (a) => a - 2 * Math.PI * Math.round(a / (2 * Math.PI));

test('a dash into the shellback front arc deflects: no kill, no damage, Rip bounces back, the charge is spent', () => {
  const g = quiet();
  place(g, 600, H / 2); // in front of it (facing 0 is +x)
  const e = shellbackAt(g, 400, H / 2, 0);
  update(g, dashAt(100, H / 2), SIM_DT);
  const events = [...drainEvents(g), ...run(g, 40)];

  assert.ok(kindOf(events, 'deflect').length === 1, 'one deflect event');
  assert.equal(e.alive, true, 'the shellback survives');
  assert.equal(g.kills, 0);
  assert.equal(g.player.hp, PLAYER.maxHp, 'no damage from the bounce');
  assert.equal(g.player.dash.charges, 2, 'the dash spent its charge and got no refund');
  assert.equal(g.player.dash.active, null, 'the dash was cancelled');
  const gap = Math.hypot(g.player.x - e.x, g.player.y - e.y);
  assert.ok(gap > e.r + PLAYER.radius, 'Rip ends outside the armour');
  assert.ok(g.player.x > 600 - DASH.distance, 'Rip is pushed back, not through');
});

test('a dash into the shellback from its side or behind kills it', () => {
  const behind = quiet();
  place(behind, 200, H / 2); // behind it (facing 0 is +x)
  shellbackAt(behind, 400, H / 2, 0);
  update(behind, dashAt(900, H / 2), SIM_DT);
  const eventsBehind = run(behind, 20);
  assert.equal(behind.kills, 1, 'from behind: killed');
  assert.ok(kindOf(eventsBehind, 'kill').some((ev) => ev.enemyType === 'shellback'));
  assert.equal(kindOf(eventsBehind, 'deflect').length, 0);

  const side = quiet();
  place(side, 400, 600); // below it, dashing up through its centre
  shellbackAt(side, 400, H / 2, 0);
  update(side, dashAt(400, 100), SIM_DT);
  run(side, 20);
  assert.equal(side.kills, 1, 'from the side: killed');
});

test('a pulse drops the armour for 1.5 s and emits stagger, then any dash kills it', () => {
  const g = quiet();
  place(g, 480, H / 2);
  const e = shellbackAt(g, 400, H / 2, 0);
  const events = collect(g, 0.02, pulseInput);
  assert.ok(kindOf(events, 'stagger').length === 1, 'stagger event');
  assert.ok(e.stagger > ENEMY.shellback.staggerTime - 0.05, 'stagger state is exposed on the enemy');

  // Front contact while staggered: the armour is down, so the dash kills.
  place(g, 600, H / 2);
  update(g, dashAt(100, H / 2), SIM_DT);
  const after = run(g, 20);
  assert.equal(g.kills, 1, 'the dash killed it while staggered');
  assert.equal(kindOf(after, 'deflect').length, 0);
  assert.ok(kindOf(after, 'kill').some((ev) => ev.enemyType === 'shellback'));
});

test('a shellback turns toward Rip slowly, at most its turn rate, so flanking is possible', () => {
  const g = quiet();
  place(g, 600, H / 2);
  const e = shellbackAt(g, 400, H / 2, Math.PI / 2);
  const start = e.facing;
  seconds(g, 0.2);
  const turned = Math.abs(wrap(e.facing - start));
  assert.ok(turned > 0.1, 'it turns');
  assert.ok(turned <= ENEMY.shellback.turnRate * 0.2 + 1e-6, `turned ${turned} rad in 0.2 s`);
});

// ---- Splitter and mini -----------------------------------------------------------------------

test('a splitter dies into three minis, each with spawn grace', () => {
  const g = quiet();
  place(g, 400, H / 2);
  spawnEnemy(g, 'splitter', 600, H / 2);
  update(g, dashAt(900, H / 2), SIM_DT);
  for (let i = 0; i < 40 && g.kills === 0; i++) update(g, NONE, SIM_DT);
  assert.equal(g.kills, 1, 'the dash killed the splitter');
  const minis = g.enemies.filter((e) => e.kind === 'mini');
  assert.equal(minis.length, 3, 'three minis');
  assert.ok(minis.every((m) => m.grace > 0), 'every mini is in spawn grace');
  assert.ok(minis.every((m) => m.alive));
});

test('a mini cannot hurt Rip during its spawn grace, and a landed contact removes it', () => {
  const g = quiet();
  place(g, 900, 100);
  const m = spawnEnemy(g, 'mini', 900, 100);
  steps(g, 1);
  assert.equal(g.player.hp, PLAYER.maxHp, 'no damage during grace');
  assert.equal(m.alive, true);

  seconds(g, Math.max(ENEMY.mini.graceTime, SPAWN.safeTime) + 0.05); // every enemy gets at least SPAWN.safeTime
  assert.equal(m.alive, false, 'after grace the mini hits Rip, then is removed');
  assert.equal(g.player.hp, PLAYER.maxHp - 1);
});

test('a mini fades after its lifetime with no score and no combo', () => {
  const g = quiet();
  // Far enough that the mini cannot reach Rip (1288 px at 200 px/s takes longer than its 6 s life),
  // so this is the lifetime path and not a contact.
  place(g, 40, 40);
  const m = spawnEnemy(g, 'mini', 1200, 600);
  const events = collect(g, ENEMY.mini.lifetime + 0.1);
  assert.equal(m.alive, false);
  assert.equal(g.score, 0);
  assert.equal(g.combo.count, 0);
  assert.equal(g.player.hp, PLAYER.maxHp, 'it faded; it did not hit Rip');
  assert.equal(kindOf(events, 'kill').length, 0);
});

// ---- Mine ------------------------------------------------------------------------------------

test('a mine arms when Rip comes within 130 px, and detonates 0.8 s later', () => {
  const g = quiet();
  place(g, 400, H / 2);
  const m = spawnEnemy(g, 'mine', 640, H / 2); // 240 px away: idle
  seconds(g, 0.2);
  assert.equal(m.state, 'idle');

  place(g, 520, H / 2); // 120 px: arms
  const armed = run(g, 1);
  assert.equal(kindOf(armed, 'mineArm').length, 1, 'arm event');
  assert.equal(m.state, 'armed');

  const early = collect(g, 0.75);
  assert.equal(kindOf(early, 'mineExplode').length, 0, 'not yet');
  const late = collect(g, 0.1);
  assert.equal(kindOf(late, 'mineExplode').length, 1, 'detonated after the fuse');
  assert.equal(m.alive, false);
  assert.equal(g.player.hp, PLAYER.maxHp, 'Rip is outside the 90 px blast');
});

test('a mine blast hurts Rip when Rip is inside it', () => {
  const g = quiet();
  place(g, 600, H / 2);
  spawnEnemy(g, 'mine', 630, H / 2); // 30 px away: armed and inside the blast
  const events = collect(g, 0.9);
  assert.equal(kindOf(events, 'mineExplode').length, 1);
  assert.equal(g.player.hp, PLAYER.maxHp - 1);
});

test('dashing through a mine defuses it: bonus score, a kill for combo, and a charge refund', () => {
  const g = quiet();
  place(g, 300, H / 2);
  const m = spawnEnemy(g, 'mine', 420, H / 2);
  update(g, dashAt(900, H / 2), SIM_DT);
  assert.equal(g.player.dash.charges, 2);
  const events = [...drainEvents(g), ...collect(g, 0.3)];

  const kill = kindOf(events, 'kill')[0];
  assert.ok(kill, 'defusing counts as a kill');
  assert.equal(kill.enemyType, 'mine');
  assert.equal(kill.cause, 'defuse');
  assert.equal(g.score, ENEMY.mine.points, 'bonus score at x1');
  assert.equal(g.combo.count, 1);
  assert.equal(g.player.dash.charges, 3, 'the kill refunded the charge');
  assert.equal(kindOf(events, 'mineExplode').length, 0, 'a defused mine does not detonate');
  assert.equal(m.alive, false);
});

test('a mine blast kills the other enemies inside it, and those kills count for score and combo', () => {
  const g = quiet();
  place(g, 520, H / 2); // 120 px from the mine: armed, and outside the blast
  spawnEnemy(g, 'mine', 640, H / 2);
  spawnEnemy(g, 'drifter', 700, H / 2); // 60 px from the mine: inside the blast
  const events = collect(g, 0.9);
  const kill = kindOf(events, 'kill').find((ev) => ev.enemyType === 'drifter');
  assert.ok(kill, 'the drifter was killed by the blast');
  assert.equal(kill.cause, 'blast');
  assert.equal(g.kills, 1);
  assert.equal(g.score, ENEMY.drifter.points, 'the chain kill scores like any kill at x1');
  assert.equal(g.combo.count, 1);
  assert.equal(g.player.hp, PLAYER.maxHp, 'Rip was outside the blast');
});

test('a splitter killed by a blast still splits', () => {
  const g = quiet();
  place(g, 520, H / 2);
  spawnEnemy(g, 'mine', 640, H / 2);
  spawnEnemy(g, 'splitter', 690, H / 2);
  collect(g, 0.9);
  assert.equal(g.enemies.filter((e) => e.kind === 'mini').length, 3);
});

// ---- Waves -----------------------------------------------------------------------------------

test('the first 30 s are Drifters only, even for a wave whose script has other kinds', () => {
  const g = createGame(7, { startWave: 8 }); // wave 8 has spitters and shellbacks in the script
  place(g, W / 2, H / 2);
  const seen = new Set();
  for (let i = 0; i < 6 * 120; i++) {
    update(g, NONE, SIM_DT);
    for (const wn of g.warnings) seen.add(wn.kind);
    for (const e of g.enemies) seen.add(e.kind);
  }
  assert.ok(seen.size > 0, 'something spawned');
  assert.deepEqual([...seen], ['drifter']);
});

test('after 30 s the script’s kinds appear, and warnings sit on the arena edge', () => {
  const g = createGame(7, { startWave: 8 });
  g.time = SPAWN.drifterOnlyUntil;
  place(g, W / 2, H / 2);
  const seen = new Set();
  for (let i = 0; i < 2 * 120; i++) {
    update(g, NONE, SIM_DT);
    for (const wn of g.warnings) {
      seen.add(wn.kind);
      const edge = wn.x <= 41 || wn.x >= W - 41 || wn.y <= 41 || wn.y >= H - 41;
      assert.ok(edge, 'warning marker sits on the arena edge');
    }
  }
  assert.ok(seen.has('spitter') && seen.has('shellback'), `kinds seen: ${[...seen]}`);
});

test('a wave clears once its queue is empty and its enemies are dead, then a breather, then the next wave', () => {
  const g = createGame(5);
  g.wave.queue = [];
  g.warnings.length = 0;
  g.enemies.length = 0;
  const d = spawnEnemy(g, 'drifter', 200, 200);
  assert.equal(kindOf(collect(g, 0.1), 'waveClear').length, 0, 'not clear while an enemy lives');
  killEnemy(g, d, 1);
  const cleared = kindOf(collect(g, 0.05), 'waveClear');
  assert.deepEqual(cleared.map((ev) => ev.wave), [1]);
  assert.equal(g.wave.phase, 'breather');

  const next = collect(g, SPAWN.breather + 0.05);
  assert.ok(next.some((ev) => ev.type === 'waveStart' && ev.wave === 2), 'wave 2 starts after the breather');
  assert.equal(g.wave.number, 2);
  assert.equal(g.wave.phase, 'active');
  assert.ok(g.wave.queue.length > 0, 'wave 2 has a spawn queue');
});

test('the wave script waits while the entity cap is full, then carries on', () => {
  const g = createGame(9);
  for (let i = 0; i < SPAWN.maxEntities; i++) addBullet(g, 40, 40, 0, 0);
  collect(g, 1);
  assert.equal(g.warnings.length, 0, 'nothing spawns at the cap');
  assert.equal(g.enemies.length, 0);

  g.bullets.length = 0;
  collect(g, 0.2);
  assert.ok(g.warnings.length + g.enemies.length > 0, 'spawning resumes once there is room');
});

test('every enemy kind is data plus behaviour and has the fields the sim needs', () => {
  for (const [kind, def] of Object.entries(ENEMY_KINDS)) {
    assert.equal(typeof def.radius, 'number', `${kind}.radius`);
    assert.equal(typeof def.points, 'number', `${kind}.points`);
    assert.equal(typeof def.init, 'function', `${kind}.init`);
    assert.equal(typeof def.think, 'function', `${kind}.think`);
  }
  for (const kind of SCRIPTED_KINDS) assert.ok(ENEMY_KINDS[kind], `${kind} is in the sim`);
});

test('input buffer keeps a dash press armed for 120 ms of sim time, then consumes it once', () => {
  const buffer = createActionBuffer();
  buffer.press('dash');
  assert.equal(buffer.has('dash'), true);
  buffer.tick(0.1);
  assert.equal(buffer.has('dash'), true, 'still armed at 100 ms');
  buffer.tick(0.03);
  assert.equal(buffer.has('dash'), false, 'expired after 120 ms');

  buffer.press('dash');
  assert.equal(buffer.consume('dash'), true);
  assert.equal(buffer.consume('dash'), false, 'a press is consumed once');
});

test('same seed and same inputs give identical state', () => {
  const randomInput = (r) => ({
    moveX: [-1, 0, 1][Math.floor(r() * 3)],
    moveY: [-1, 0, 1][Math.floor(r() * 3)],
    aimX: r() * W,
    aimY: r() * H,
    dash: r() < 1 / 40,
    pulse: r() < 1 / 120,
  });
  const runOnce = () => {
    const g = createGame(42);
    const r = mulberry32(43);
    for (let i = 0; i < 1200; i++) update(g, randomInput(r), SIM_DT);
    return JSON.stringify({
      score: g.score,
      player: g.player,
      enemies: g.enemies.map((e) => [e.kind, e.x, e.y]),
      bullets: g.bullets.map((b) => [b.x, b.y]),
    });
  };
  assert.equal(runOnce(), runOnce());
});

const KNOWN = new Set([
  'kill', 'dash', 'hurt', 'pulse', 'reflect', 'perfectPulse', 'comboTier', 'comboLost', 'waveStart', 'waveClear',
  'gameOver', 'deflect', 'stagger', 'mineArm', 'mineExplode', 'bulletCut', 'enemyShoot', 'dashWhiff',
  // PICKUPS (#54): health recovery and modifier drop events.
  'pickupDrop', 'pickup', 'modifierEnd', 'heal', 'shieldBreak',
]);

const finite = (g) => {
  const p = g.player;
  const vals = [p.x, p.y, p.vx, p.vy, g.score, g.combo.timer, p.dash.charges];
  for (const e of g.enemies) vals.push(e.x, e.y, e.vx, e.vy, e.facing, e.stagger, e.grace);
  for (const b of g.bullets) vals.push(b.x, b.y, b.vx, b.vy);
  return vals.every((v) => Number.isFinite(v));
};

// A game that starts at `startWave` past the Drifter-only opening, so the script's own kinds can spawn.
function fresh(seed, startWave) {
  const g = createGame(seed, { startWave });
  g.time = SPAWN.drifterOnlyUntil;
  return g;
}

// Random scripted input for `seconds` of sim time from a start wave. Returns what it saw.
function soak(seed, startWave, secondsOfSim) {
  const r = mulberry32(seed + 1000 * startWave);
  let g = fresh(seed, startWave);
  const kinds = new Set();
  let kills = 0;
  let clears = 0;
  const total = Math.round(secondsOfSim / SIM_DT);
  for (let i = 0; i < total; i++) {
    const input = {
      moveX: [-1, 0, 1][Math.floor(r() * 3)],
      moveY: [-1, 0, 1][Math.floor(r() * 3)],
      aimX: r() * W,
      aimY: r() * H,
      dash: r() < 1 / 40,
      pulse: r() < 1 / 120,
    };
    update(g, input, SIM_DT);
    for (const ev of drainEvents(g)) {
      assert.ok(KNOWN.has(ev.type), `unknown event ${ev.type}`);
      if (ev.type === 'kill') kills += 1;
      if (ev.type === 'waveClear') clears += 1;
    }
    for (const e of g.enemies) kinds.add(e.kind);
    for (const wn of g.warnings) kinds.add(wn.kind);
    assert.ok(finite(g), `non-finite state at step ${i} (start wave ${startWave})`);
    assert.ok(g.enemies.length + g.warnings.length + g.bullets.length <= SPAWN.maxEntities, 'entity cap holds');
    if (g.over) g = fresh(seed + i, startWave); // instant restart, as the game does
  }
  return { kinds, kills, clears };
}

test('60 simulated seconds of scripted random input from wave 1: no NaN, no exceptions, waves advance', () => {
  const r = mulberry32(999);
  let g = createGame(12345);
  let deaths = 0;
  let kills = 0;
  let furthestWave = 1;
  let clears = 0;
  const total = Math.round(60 / SIM_DT);
  for (let i = 0; i < total; i++) {
    const input = {
      moveX: [-1, 0, 1][Math.floor(r() * 3)],
      moveY: [-1, 0, 1][Math.floor(r() * 3)],
      aimX: r() * W,
      aimY: r() * H,
      dash: r() < 1 / 40,
      pulse: r() < 1 / 120,
    };
    update(g, input, SIM_DT);
    for (const ev of drainEvents(g)) {
      assert.ok(KNOWN.has(ev.type), `unknown event ${ev.type}`);
      if (ev.type === 'kill') kills += 1;
      if (ev.type === 'waveClear') clears += 1;
      if (ev.type === 'waveStart') furthestWave = Math.max(furthestWave, ev.wave);
    }
    assert.ok(finite(g), `non-finite state at step ${i}`);
    if (g.over) {
      deaths += 1;
      g = createGame(12345 + deaths); // instant restart, as the game does
    }
  }
  assert.ok(kills > 0, 'the soak should kill something');
  assert.ok(clears >= 1 && furthestWave >= 2, `waves advanced: cleared ${clears}, furthest wave ${furthestWave}`);
  assert.ok(deaths >= 0);
});

test('60 simulated seconds from the script’s waves cover every enemy kind with no NaN and no exceptions', () => {
  // Waves 1 (drifters), 8 (spitters, shellbacks), and 19 (chargers, splitters, mines) between them
  // script every kind. Each soak restarts at its own start wave after a death.
  const seen = new Set();
  let kills = 0;
  for (const startWave of [1, 8, 19]) {
    const result = soak(31 + startWave, startWave, 60);
    result.kinds.forEach((k) => seen.add(k));
    kills += result.kills;
  }
  assert.ok(kills > 0, 'the soaks should kill something');
  for (const kind of SCRIPTED_KINDS) assert.ok(seen.has(kind), `soak reached ${kind}`);
});

test('the wave script runs to wave 50 with no NaN and no exceptions', () => {
  const result = soak(77, 50, 20);
  assert.ok(result.kinds.size > 0, 'wave 50 spawns enemies');
});

// ---- Dash fairness -------------------------------------------------------------------------
// One deterministic test per rule. Enemies are frozen (stagger stops their think and velocity)
// and marked past the spawn-safe window, so each test places exactly what it checks.

const freeze = (e) => {
  e.stagger = 100;
  e.grace = 0;
  return e;
};
const isWhiff = (ev) => ev.type === 'dashWhiff';

test('reach forgiveness: the blade reaches 26 px from the path, so a drifter 30 px off the line dies (the body alone would miss)', () => {
  const g = quiet();
  place(g, 300, H / 2);
  freeze(spawnEnemy(g, 'drifter', 420, H / 2 + 30));
  update(g, dashAt(900, H / 2), DASH.duration);
  assert.equal(g.kills, 1);
  assert.equal(g.enemies.length, 0);
});

test('final slash arc: an enemy 42 px from the dash end, just outside the blade, dies to the closing arc', () => {
  const g = quiet();
  place(g, 300, H / 2);
  // 42 px from the end point (510, 360): past the blade's 39 px reach, forward, and outside the lunge cone.
  freeze(spawnEnemy(g, 'drifter', 515, H / 2 + 42));
  update(g, dashAt(900, H / 2), SIM_DT);
  steps(g, 14);
  assert.equal(g.kills, 1, 'the arc killed it');
});

test('final slash arc has a limit: an enemy 50 px from the dash end survives', () => {
  const g = quiet();
  place(g, 300, H / 2);
  freeze(spawnEnemy(g, 'drifter', 515, H / 2 + 50));
  update(g, dashAt(900, H / 2), SIM_DT);
  steps(g, 14);
  assert.equal(g.kills, 0);
  assert.equal(g.enemies.length, 1);
});

test('lunge assist: a drifter 240 px out on the aim line dies because the dash extends to pass through it', () => {
  const g = quiet();
  place(g, 300, H / 2);
  const e = freeze(spawnEnemy(g, 'drifter', 540, H / 2));
  update(g, dashAt(900, H / 2), SIM_DT);
  const d = g.player.dash.active;
  assert.equal(d.assisted, true);
  assertNear(d.ex, 540, 1e-6, 'extended to the enemy along the aim line');
  assertNear(d.ey, H / 2, 1e-9, 'aim line unchanged');
  assertNear(d.dur, DASH.duration * (240 / DASH.distance), 1e-9, 'same speed, slightly longer duration');
  seconds(g, 0.2);
  assert.equal(e.alive, false);
  assert.equal(g.kills, 1);
});

test('lunge assist: an enemy 300 px out is not reached and the dash stays 210 px', () => {
  const g = quiet();
  place(g, 300, H / 2);
  const e = freeze(spawnEnemy(g, 'drifter', 600, H / 2));
  update(g, dashAt(900, H / 2), SIM_DT);
  const d = g.player.dash.active;
  assert.equal(d.assisted, false);
  assertNear(d.ex, 300 + DASH.distance, 1e-6, 'dash stays 210 px');
  assertNear(d.dur, DASH.duration, 1e-12, 'duration unchanged');
  seconds(g, 0.2);
  assert.equal(e.alive, true);
  assert.equal(g.kills, 0);
});

test('lunge assist never shortens a dash: an enemy 150 px out on the line is killed and the dash still runs 210 px', () => {
  const g = quiet();
  place(g, 300, H / 2);
  freeze(spawnEnemy(g, 'drifter', 450, H / 2));
  update(g, dashAt(900, H / 2), SIM_DT);
  assertNear(g.player.dash.active.ex, 300 + DASH.distance, 1e-6);
  seconds(g, 0.2);
  assert.equal(g.kills, 1);
});

test('exit grace: no damage for 0.18 s after a dash that killed nothing, damage is possible after', () => {
  const g = quiet();
  place(g, 300, H / 2);
  update(g, dashAt(900, H / 2), SIM_DT);
  steps(g, 14);
  assert.equal(g.player.dash.active, null, 'dash finished');
  assertNear(g.player.dashGrace, DASH.exitGrace, 1e-9, 'grace starts at 0.18 s');
  // 0.18 s is 21.6 steps: still protected after 21, not after 22.
  for (let i = 0; i < 21; i++) {
    update(g, NONE, SIM_DT);
    assert.equal(damagePlayer(g, 300, H / 2), false, `protected at step ${i + 1} after the dash`);
  }
  update(g, NONE, SIM_DT);
  assert.equal(g.player.dashGrace, 0);
  assert.equal(damagePlayer(g, 300, H / 2), true, 'damage again once the grace has run out');
});

test('exit grace is refreshed to 0.25 s by a dash that kills', () => {
  const g = quiet();
  place(g, 300, H / 2);
  freeze(spawnEnemy(g, 'drifter', 400, H / 2));
  g.rng = () => 0.99; // PICKUPS: a kill can roll a drop, which the dash would collect; this test is about grace only
  update(g, dashAt(900, H / 2), SIM_DT);
  steps(g, 14);
  assert.equal(g.kills, 1);
  assertNear(g.player.dashGrace, DASH.killGrace, 1e-9, 'grace refreshed to 0.25 s');
  steps(g, 29); // 0.242 s after the dash: still protected
  assert.equal(damagePlayer(g, 300, H / 2), false);
  steps(g, 2); // 0.258 s after the dash: exposed again
  assert.equal(damagePlayer(g, 300, H / 2), true);
});

test('dashes cut enemy bullets on their path: destroyed, 5 points, no combo, no charge refund', () => {
  const g = quiet();
  place(g, 300, H / 2);
  addBullet(g, 400, H / 2, 0, 0);
  update(g, dashAt(900, H / 2), DASH.duration); // one step covers the whole path
  const events = drainEvents(g);
  assert.equal(g.bullets.length, 0, 'the bullet is gone');
  assert.ok(events.some((ev) => ev.type === 'bulletCut'), 'bulletCut emitted');
  assert.equal(g.score, DASH.bulletCutScore);
  assert.equal(g.combo.count, 0, 'no combo');
  assert.equal(g.player.dash.charges, DASH.maxCharges - 1, 'no charge refund');
});

test('a spitter never starts a wind-up during a dash, or within 0.15 s after one', () => {
  const g = quiet();
  place(g, 300, H / 2);
  const sp = spawnEnemy(g, 'spitter', 700, H / 2);
  sp.shotCd = 0; // ready to fire the whole time
  update(g, dashAt(900, H / 2), SIM_DT);
  for (let i = 0; i < 14; i++) {
    update(g, NONE, SIM_DT);
    assert.notEqual(sp.state, 'windup', `no wind-up during the dash (step ${i + 2})`);
  }
  assert.equal(g.player.dash.active, null);
  seconds(g, 0.1);
  assert.notEqual(sp.state, 'windup', 'no wind-up 0.1 s after the dash');
  seconds(g, 0.1);
  assert.equal(sp.state, 'windup', 'the wind-up starts once the quiet window has passed');
});

test('a spitter winds up for 0.35 s with a rising telegraph, then releases one aimed bullet and emits enemyShoot', () => {
  const g = quiet();
  place(g, 300, H / 2);
  const sp = spawnEnemy(g, 'spitter', 700, H / 2);
  sp.shotCd = 0;
  const seen = [];
  const run = (n) => {
    for (let i = 0; i < n; i++) {
      update(g, NONE, SIM_DT);
      seen.push(...drainEvents(g));
    }
  };
  run(1);
  assert.equal(sp.state, 'windup');
  assert.equal(sp.telegraph, 0, 'telegraph starts at 0');
  run(23); // about 0.19 s in
  assert.ok(sp.telegraph > 0.5 && sp.telegraph < 0.7, `telegraph rising, got ${sp.telegraph}`);
  assert.equal(seen.some((ev) => ev.type === 'enemyShoot'), false, 'no shot yet');
  let extra = 0;
  while (!seen.some((ev) => ev.type === 'enemyShoot') && extra < 60) {
    run(1);
    extra += 1;
  }
  const shot = seen.find((ev) => ev.type === 'enemyShoot');
  assert.ok(shot, 'shot released');
  assert.equal(shot.enemyType, 'spitter');
  // Counted from the start of the wind-up: 0.35 s is 42 steps, and the release lands within a step or two of that.
  const total = 24 + extra;
  assert.ok(total >= 42 && total <= 45, `released after ${total} steps (0.35 s is 42)`);
  const bullets = g.bullets.filter((b) => b.owner === 'enemy');
  assert.equal(bullets.length, 1);
  assert.ok(bullets[0].vx < 0, 'aimed at the player');
});

test('fair contact: a graze at enemy radius + core + 1 px does not hurt, a touch inside the core does', () => {
  const g = quiet();
  place(g, 300, H / 2);
  freeze(spawnEnemy(g, 'drifter', 300 + ENEMY.drifter.radius + PLAYER.coreRadius + 1, H / 2));
  update(g, NONE, SIM_DT);
  assert.equal(g.player.hp, PLAYER.maxHp, 'graze is safe');

  const h = quiet();
  place(h, 300, H / 2);
  freeze(spawnEnemy(h, 'drifter', 300 + ENEMY.drifter.radius + PLAYER.coreRadius - 1, H / 2));
  update(h, NONE, SIM_DT);
  assert.equal(h.player.hp, PLAYER.maxHp - 1, 'a touch inside the core hurts');
});

test('a charger hurts only during its lunge', () => {
  const g = quiet();
  place(g, 300, H / 2);
  const c = spawnEnemy(g, 'charger', 300, H / 2);
  c.grace = 0;
  c.cooldown = 10;
  update(g, NONE, SIM_DT);
  assert.equal(c.state, 'idle');
  assert.equal(g.player.hp, PLAYER.maxHp, 'an idle charger on top of the player is harmless');

  c.state = 'lunge';
  c.stateT = 1;
  c.dirX = 1;
  c.dirY = 0;
  update(g, NONE, SIM_DT);
  assert.equal(g.player.hp, PLAYER.maxHp - 1, 'the lunge hurts');
});

test('a newly spawned enemy cannot hurt for its first 0.4 s', () => {
  const g = quiet();
  place(g, 300, H / 2);
  const d = spawnEnemy(g, 'drifter', 300, H / 2);
  d.stagger = 100; // stays put on top of the player
  for (let i = 0; i < 47; i++) update(g, NONE, SIM_DT); // 0.392 s
  assert.equal(g.player.hp, PLAYER.maxHp, 'safe while new');
  for (let i = 0; i < 10; i++) update(g, NONE, SIM_DT);
  assert.equal(g.player.hp, PLAYER.maxHp - 1, 'hurts once the safe window has passed');
});

test('dashWhiff: a dash that kills nothing but passes within 60 px of an enemy says so; a far miss does not', () => {
  const near = quiet();
  place(near, 300, H / 2);
  freeze(spawnEnemy(near, 'drifter', 500, H / 2 + 50)); // 50 px off the path, outside the 39 px blade
  update(near, dashAt(900, H / 2), SIM_DT);
  steps(near, 14);
  const nearEvents = drainEvents(near);
  assert.equal(near.kills, 0);
  const whiff = nearEvents.find(isWhiff);
  assert.ok(whiff, 'near miss reported');
  assertNear(whiff.x, 300 + DASH.distance, 1e-6, 'reported at the dash end');

  const far = quiet();
  place(far, 300, H / 2);
  freeze(spawnEnemy(far, 'drifter', 500, H / 2 + 120));
  update(far, dashAt(900, H / 2), SIM_DT);
  steps(far, 14);
  assert.equal(drainEvents(far).some(isWhiff), false, 'a far miss is not reported');
});

test('aim preview: dashPreview gives the end point (lunge-assisted), predicts kills, changes nothing, and matches the real dash', () => {
  const g = quiet();
  place(g, 300, H / 2);
  freeze(spawnEnemy(g, 'drifter', 540, H / 2));
  const before = JSON.stringify(g);
  const pv = dashPreview(g, 900, H / 2);
  assert.equal(JSON.stringify(g), before, 'preview is pure');
  assertNear(pv.x, 540, 1e-6, 'preview end includes the lunge assist');
  assertNear(pv.y, H / 2, 1e-9);
  assert.equal(pv.kills, true);

  // The real dash ends exactly where the preview said. The assisted dash is longer, so run it to its end.
  update(g, dashAt(900, H / 2), SIM_DT);
  while (g.player.dash.active) update(g, NONE, SIM_DT);
  assertNear(g.player.x, pv.x, 1e-6, 'real dash ends at the previewed point');

  const miss = quiet();
  place(miss, 300, H / 2);
  freeze(spawnEnemy(miss, 'drifter', 600, H / 2));
  const none = dashPreview(miss, 900, H / 2);
  assertNear(none.x, 300 + DASH.distance, 1e-6);
  assert.equal(none.kills, false, 'preview says no kill when the dash would miss');
});

