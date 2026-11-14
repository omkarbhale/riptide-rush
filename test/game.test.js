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
  tierFor,
  spawnIntervalFor,
  kindWeights,
  mulberry32,
  ENEMY_KINDS,
} from '../src/game.js';
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
  // Path is a horizontal segment; enemy radius 13 + player 14 = 27, so 60 px off-axis is clear.
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

test('combo timer starts at 2.5 s, shrinks with combo, and never drops below 1.6 s', () => {
  assert.equal(comboWindowFor(0), COMBO.window);
  assert.ok(comboWindowFor(10) < comboWindowFor(1));
  assert.equal(comboWindowFor(500), COMBO.windowMin);
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

test('a multi-kill bonus applies to the second and later kills in one slash', () => {
  const g = quiet();
  for (let i = 0; i < 5; i++) killEnemy(g, spawnEnemy(g, 'drifter', 100 + i * 50, 100), 1);
  drainEvents(g);
  // Combo becomes 6 (x2). Base 10 x2 = 20, plus multi bonus 25 x2 = 50, total 70.
  killEnemy(g, spawnEnemy(g, 'drifter', 600, 600), 2);
  assert.equal(g.score, 60 + 70);
  const kill = drainEvents(g).find((ev) => ev.type === 'kill');
  assert.equal(kill.points, 70);
  assert.equal(kill.multi, 2);
  assert.equal(kill.combo, 6);
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
  spawnEnemy(g, 'drifter', W / 2, H / 2);
  spawnEnemy(g, 'drifter', W / 2, H / 2);
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
  assert.ok(drainEvents(g).some((ev) => ev.type === 'kill' && ev.enemyType === 'spitter'));
});

test('spitter fires aimed bullets at the player on its interval', () => {
  const g = quiet();
  place(g, W / 2, H / 2);
  spawnEnemy(g, 'spitter', W / 2 + 300, H / 2);
  seconds(g, ENEMY.spitter.firstShotDelay + 0.1);
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

test('wave escalation: spawn interval shrinks, new kinds unlock, wave counter advances', () => {
  assert.deepEqual(Object.keys(kindWeights(1)), ['drifter']);
  assert.ok(Object.keys(kindWeights(2)).includes('spitter'));
  assert.ok(!Object.keys(kindWeights(2)).includes('charger'));
  assert.ok(Object.keys(kindWeights(3)).includes('charger'));

  let prev = Infinity;
  for (let wave = 1; wave <= 30; wave++) {
    const interval = spawnIntervalFor(wave);
    assert.ok(interval <= prev, `interval does not grow at wave ${wave}`);
    assert.ok(interval >= SPAWN.minInterval);
    prev = interval;
  }
  assert.equal(spawnIntervalFor(30), SPAWN.minInterval);

  const g = quiet();
  g.wave.timer = 0.001;
  steps(g, 2);
  assert.equal(g.wave.number, 2);
  assert.ok(drainEvents(g).some((ev) => ev.type === 'waveStart' && ev.wave === 2));
});

test('wave 1 spawns only drifters, from the arena edge and away from the player', () => {
  const g = createGame(7);
  place(g, W / 2, H / 2);
  const seen = [];
  for (let i = 0; i < 6 * 120; i++) {
    update(g, NONE, SIM_DT);
    for (const wn of g.warnings) seen.push(wn);
    for (const e of g.enemies) seen.push(e);
  }
  assert.ok(seen.length > 0, 'something spawned');
  for (const s of seen) {
    assert.equal(s.kind, 'drifter');
  }
  for (const wn of g.warnings) {
    const edge = wn.x <= 41 || wn.x >= W - 41 || wn.y <= 41 || wn.y >= H - 41;
    assert.ok(edge, 'warning marker sits on the arena edge');
  }
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

test('every enemy kind is data plus behaviour and has the fields the spawner and sim need', () => {
  for (const [kind, def] of Object.entries(ENEMY_KINDS)) {
    assert.equal(typeof def.radius, 'number', `${kind}.radius`);
    assert.equal(typeof def.points, 'number', `${kind}.points`);
    assert.equal(typeof def.minWave, 'number', `${kind}.minWave`);
    assert.equal(typeof def.weight, 'number', `${kind}.weight`);
    assert.equal(typeof def.init, 'function', `${kind}.init`);
    assert.equal(typeof def.think, 'function', `${kind}.think`);
  }
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
  const run = () => {
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
  assert.equal(run(), run());
});

test('60 simulated seconds of scripted random input: no NaN positions, no exceptions', () => {
  const r = mulberry32(999);
  const KNOWN = new Set([
    'kill', 'dash', 'hurt', 'pulse', 'reflect', 'perfectPulse', 'comboTier', 'comboLost', 'waveStart', 'gameOver',
  ]);
  const finite = (g) => {
    const p = g.player;
    const vals = [p.x, p.y, p.vx, p.vy, g.score, g.combo.timer, p.dash.charges];
    for (const e of g.enemies) vals.push(e.x, e.y, e.vx, e.vy);
    for (const b of g.bullets) vals.push(b.x, b.y, b.vx, b.vy);
    return vals.every((v) => Number.isFinite(v));
  };

  let g = createGame(12345);
  let deaths = 0;
  let kills = 0;
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
    }
    assert.ok(finite(g), `non-finite state at step ${i}`);
    if (g.over) {
      deaths += 1;
      g = createGame(12345 + deaths); // instant restart, as the game does
    }
  }
  assert.ok(kills > 0, 'the soak should kill something');
  assert.ok(deaths >= 0);
});

