// Behaviour tests for the #114 enemies: Puffer, Shield Bearer, Ink Squid, Phase Eel, Anglerfish Warden.
// Each test places exactly what it checks. Enemies that must not move are frozen (stagger stops their think),
// as in game.test.js. The file runs in well under a second.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LOGICAL_WIDTH as W, LOGICAL_HEIGHT as H, SIM_DT, PLAYER, DASH, PULSE, ENEMY, SPAWN } from '../src/config.js';
import { createGame, update, drainEvents, spawnEnemy, killEnemy, ENEMY_KINDS, multiplierFor } from '../src/game.js';
import { countsFor, BOSS_WAVES, SCRIPTED_KINDS } from '../src/waves.js';
import { EXTRA_KINDS } from '../src/enemies-extra.js';

const NONE = { moveX: 0, moveY: 0, aimX: W / 2, aimY: H / 2, dash: false, pulse: false };
const dashAt = (aimX, aimY) => ({ ...NONE, aimX, aimY, dash: true });
const PULSE_IN = { ...NONE, pulse: true };
const quiet = (seed = 1) => createGame(seed, { spawning: false });
const seconds = (s) => Math.round(s / SIM_DT);
const kindOf = (events, type) => events.filter((ev) => ev.type === type);

function place(g, x, y) {
  const p = g.player;
  p.x = p.px = x;
  p.y = p.py = y;
  p.vx = 0;
  p.vy = 0;
}

// Runs n steps, draining events each step. Returns every event seen.
function run(g, n, input = NONE) {
  const events = [];
  for (let i = 0; i < n; i++) {
    update(g, input, SIM_DT);
    events.push(...drainEvents(g));
  }
  return events;
}

// A frozen enemy: its think does not run and it does not move; it is still hit by dashes and shards.
const freeze = (e) => {
  e.stagger = 100;
  e.grace = 0;
  return e;
};

// ---- Script wiring -------------------------------------------------------------------------------

test('the second round is scripted at low counts: Puffers 12, Bearers 13, Squid 14, Eel 16, the Warden at 10 and 20', () => {
  assert.equal(countsFor(12).puffer, 2);
  assert.equal(countsFor(13).shieldbearer, 1);
  assert.equal(countsFor(14).inksquid, 1);
  assert.equal(countsFor(16).phaseeel, 1);
  assert.equal(countsFor(10).warden, 1);
  assert.equal(countsFor(20).warden, 1);
  for (const w of [1, 5, 9, 11, 19]) assert.equal(countsFor(w).warden, 0, `no Warden at wave ${w}`);
  for (const w of [1, 11, 12, 13, 14, 15]) assert.equal(countsFor(w).phaseeel, 0, `no eel at wave ${w}`);
  assert.deepEqual(BOSS_WAVES, { 10: 'warden', 20: 'warden' });
  for (const kind of ['puffer', 'shieldbearer', 'inksquid', 'phaseeel', 'warden']) {
    assert.ok(SCRIPTED_KINDS.includes(kind), `${kind} is scripted`);
    assert.ok(ENEMY_KINDS[kind], `${kind} is in the sim`);
  }
});

test('existing kinds keep their counts: the new rows only add the new kinds', () => {
  assert.equal(countsFor(12).drifter, 20);
  assert.equal(countsFor(12).shellback, 1);
  assert.equal(countsFor(14).charger, 4);
  assert.equal(countsFor(16).mine, 4);
  assert.equal(countsFor(10).splitter, 2);
});

test('every new kind has the fields the sim needs and a hit-free contact model', () => {
  for (const [kind, def] of Object.entries(EXTRA_KINDS)) {
    assert.equal(typeof def.radius, 'number', `${kind}.radius`);
    assert.equal(typeof def.points, 'number', `${kind}.points`);
    assert.equal(typeof def.init, 'function', `${kind}.init`);
    assert.equal(typeof def.think, 'function', `${kind}.think`);
  }
});

// ---- Puffer --------------------------------------------------------------------------------------

test('a Puffer burst makes eight shards at 260 px/s, evenly spaced, and says so', () => {
  const g = quiet();
  const p = freeze(spawnEnemy(g, 'puffer', 600, H / 2));
  killEnemy(g, p, 1, 'dash');
  assert.equal(g.extras.shards.length, ENEMY.puffer.shardCount);
  const angles = g.extras.shards.map((s) => Math.atan2(s.vy, s.vx)).sort((a, b) => a - b);
  const step = (2 * Math.PI) / ENEMY.puffer.shardCount;
  for (let i = 1; i < angles.length; i++) assert.ok(Math.abs(angles[i] - angles[i - 1] - step) < 1e-9, 'even spacing');
  for (const s of g.extras.shards) assert.ok(Math.abs(Math.hypot(s.vx, s.vy) - ENEMY.puffer.shardSpeed) < 1e-9);
  const burst = kindOf(drainEvents(g), 'puffBurst');
  assert.equal(burst.length, 1);
  assert.equal(burst[0].count, 8);
  assert.equal(burst[0].range, ENEMY.puffer.shardRange);
  assert.ok(Number.isFinite(burst[0].x) && Number.isFinite(burst[0].y));
});

test('a shard travels its 90 px range and fades; the arena and the shard list stay clean', () => {
  const g = quiet();
  const p = freeze(spawnEnemy(g, 'puffer', 600, H / 2));
  killEnemy(g, p, 1, 'dash');
  run(g, seconds(0.5));
  assert.equal(g.extras.shards.length, 0, 'every shard has faded after its range');
});

test('a dash that kills a Puffer refunds its charge, and the burst still happens', () => {
  const g = quiet();
  place(g, 300, H / 2);
  freeze(spawnEnemy(g, 'puffer', 380, H / 2));
  update(g, dashAt(1000, H / 2), SIM_DT);
  const events = [...drainEvents(g), ...run(g, 20)];
  const kill = kindOf(events, 'kill');
  assert.equal(kill.length, 1);
  assert.equal(kill[0].enemyType, 'puffer');
  assert.equal(kill[0].cause, 'dash');
  assert.equal(kindOf(events, 'puffBurst').length, 1, 'the burst still happens');
  assert.equal(g.player.dash.charges, 3, 'spent one, refunded one');
});

test('a dash over one Puffer whose shards reach two more: a chain of three, each a kill that counts for the combo', () => {
  const g = quiet();
  place(g, 250, H / 2);
  const a = freeze(spawnEnemy(g, 'puffer', 400, H / 2)); // on the dash line
  const b = freeze(spawnEnemy(g, 'puffer', 440, H / 2 + 50)); // off the blade, on a shard's path
  const c = freeze(spawnEnemy(g, 'puffer', 440, H / 2 + 90)); // off the blade, on the path of b's shard
  update(g, dashAt(1000, H / 2), SIM_DT);
  const events = [...drainEvents(g), ...run(g, seconds(1))];
  assert.equal(a.alive, false);
  assert.equal(b.alive, false, 'b dies to a shard');
  assert.equal(c.alive, false, 'c dies to a shard from b');
  const kills = kindOf(events, 'kill');
  assert.equal(kills.length, 3);
  assert.deepEqual(kills.map((k) => k.cause), ['dash', 'shard', 'shard']);
  assert.equal(g.combo.count, 3, 'every kill is a combo kill');
  assert.ok(kills[2].multi > kills[0].multi, 'the chain counts as a multi-kill, so the bonus and hit-stop grow');
});

test('a Pulse knocks a Puffer 40 px back and does not burst it', () => {
  const g = quiet();
  place(g, 600, H / 2);
  const p = spawnEnemy(g, 'puffer', 650, H / 2);
  p.grace = 0;
  update(g, PULSE_IN, SIM_DT);
  const d = Math.hypot(p.x - g.player.x, p.y - g.player.y);
  assert.ok(d > 50 + 38 && d < 50 + 42, `knocked back about 40 px, got ${d.toFixed(1)}`);
  const events = run(g, seconds(0.5));
  assert.equal(p.alive, true, 'it survives the stagger');
  assert.equal(kindOf(events, 'puffBurst').length, 0, 'no burst');
});

test('a Puffer swells for 0.6 s within 40 px of Rip, then bursts', () => {
  const g = quiet();
  place(g, 600, H / 2);
  const p = spawnEnemy(g, 'puffer', 630, H / 2); // 30 px away: close, but outside its contact reach
  p.grace = 0;
  const early = run(g, seconds(0.4));
  assert.equal(p.alive, true);
  assert.ok(p.swell > 0.5 && p.swell < 0.8, `swell is growing: ${p.swell}`);
  assert.equal(kindOf(early, 'puffSwell').length, 1, 'the swell is announced once');
  const late = run(g, seconds(0.3));
  assert.equal(p.alive, false, 'bursts when the swell completes');
  assert.equal(kindOf(late, 'puffBurst').length, 1);
});

test('a Puffer that touches Rip bursts with no score, and the touch hurts her', () => {
  const g = quiet();
  place(g, 600, H / 2);
  const p = spawnEnemy(g, 'puffer', 615, H / 2);
  p.grace = 0;
  const score = g.score;
  const events = run(g, 2);
  assert.equal(p.alive, false);
  assert.equal(g.score, score, 'a contact death scores nothing');
  assert.equal(g.player.hp, PLAYER.maxHp - 1);
  assert.equal(kindOf(events, 'puffBurst').length, 1);
});

test('a shard that reaches Rip hurts her, but not while she dashes', () => {
  const g = quiet();
  place(g, 600, H / 2);
  g.extras.shards.push({ id: 1, x: 612, y: H / 2, vx: 0, vy: 0, travelled: 0, chain: { n: 1 }, alive: true });
  run(g, 1);
  assert.equal(g.player.hp, PLAYER.maxHp - 1, 'a shard hurts Rip');

  const h = quiet();
  place(h, 300, H / 2);
  update(h, dashAt(1000, H / 2), SIM_DT);
  h.extras.shards.push({ id: 2, x: 400, y: H / 2, vx: 0, vy: 0, travelled: 0, chain: { n: 1 }, alive: true });
  run(h, 10);
  assert.equal(h.player.hp, PLAYER.maxHp, 'a dashing Rip is untouchable');
});

test('a shard kills what it touches, but passes the Warden: only a dash hurts the boss', () => {
  const g = quiet();
  const w = freeze(spawnEnemy(g, 'warden', 800, 300, 10));
  w.exposed = true;
  g.extras.shards.push({ id: 3, x: 800, y: 300, vx: 0, vy: 0, travelled: 0, chain: { n: 1 }, alive: true });
  run(g, 1);
  assert.equal(w.alive, true, 'the Warden is not a shard target');
  assert.equal(w.hp, ENEMY.warden.hp);
});

// ---- Shield Bearer -------------------------------------------------------------------------------

test('a Barrier takes one dash and nothing else: no kill, no refund; the next dash kills it normally', () => {
  const g = quiet();
  place(g, 300, H / 2);
  const bearer = spawnEnemy(g, 'shieldbearer', 420, 460); // 100 px below the dash line, aura 120 px
  bearer.grace = 0;
  const d = freeze(spawnEnemy(g, 'drifter', 420, H / 2));
  run(g, 1);
  assert.equal(d.barrier, true, 'the Drifter carries a Barrier in the aura');

  update(g, dashAt(1000, H / 2), SIM_DT);
  const first = [...drainEvents(g), ...run(g, 20)];
  assert.equal(d.alive, true, 'the first dash does not kill it');
  assert.equal(d.barrier, false, 'the Barrier is gone');
  assert.equal(kindOf(first, 'barrierBreak').length, 1);
  assert.equal(g.kills, 0);
  assert.equal(g.player.dash.charges, 2, 'the first dash spent a charge and got nothing back');

  place(g, 300, H / 2);
  update(g, dashAt(1000, H / 2), SIM_DT);
  run(g, 20);
  assert.equal(d.alive, false, 'the next dash kills it');
  assert.equal(g.player.dash.charges, 2, 'the kill refunds one: 3 - 1 - 1 + 1');
});

test('killing the Bearer removes every Barrier in the same frame', () => {
  const g = quiet();
  const bearer = spawnEnemy(g, 'shieldbearer', 500, 360);
  const d1 = freeze(spawnEnemy(g, 'drifter', 440, 360));
  const d2 = freeze(spawnEnemy(g, 'spitter', 560, 360));
  run(g, 1);
  assert.equal(d1.barrier, true);
  assert.equal(d2.barrier, true);
  killEnemy(g, bearer, 1, 'dash');
  assert.equal(d1.barrier, false, 'no update needed: removed in the kill');
  assert.equal(d2.barrier, false);
});

test('Barriers do not stack: one Barrier per enemy, and one dash takes it and it is not given back', () => {
  const g = quiet();
  const b1 = spawnEnemy(g, 'shieldbearer', 400, 300);
  const b2 = spawnEnemy(g, 'shieldbearer', 440, 420);
  const d = freeze(spawnEnemy(g, 'drifter', 420, 360));
  run(g, 1);
  assert.equal(d.barrier, true);
  assert.equal(d.barrierBy, b1.id, 'the first Bearer in the list gives it, and the second adds nothing');
  assert.ok(b2.alive);
  place(g, 300, H / 2);
  update(g, dashAt(1000, H / 2), SIM_DT);
  const events = [...drainEvents(g), ...run(g, 40)];
  assert.equal(kindOf(events, 'barrierBreak').length, 1, 'one Barrier, one break');
  assert.equal(d.barrier, false);
  assert.equal(d.barrierSpent, true, 'a spent Drifter is not given a new Barrier while in the aura');
});

test('a Shield Bearer takes two dashes: the first costs a hit point and no refund, the second kills it', () => {
  const g = quiet();
  place(g, 300, H / 2);
  const b = freeze(spawnEnemy(g, 'shieldbearer', 420, H / 2));
  update(g, dashAt(1000, H / 2), SIM_DT);
  run(g, 20);
  assert.equal(b.alive, true);
  assert.equal(b.hp, 1);
  assert.equal(g.player.dash.charges, 2, 'no refund for a hit that does not kill');
  place(g, 300, H / 2);
  update(g, dashAt(1000, H / 2), SIM_DT);
  run(g, 20);
  assert.equal(b.alive, false);
  assert.equal(g.player.dash.charges, 2, 'the kill refunds one');
});

test('a Pulse stagger drops the Bearer\'s aura for 1 s', () => {
  const g = quiet();
  place(g, 600, H / 2);
  const b = spawnEnemy(g, 'shieldbearer', 650, H / 2);
  b.grace = 0;
  update(g, PULSE_IN, SIM_DT);
  assert.equal(b.aura, false, 'aura down in the stagger');
  run(g, seconds(0.5));
  assert.equal(b.aura, false);
  run(g, seconds(0.6));
  assert.equal(b.aura, true, 'aura back after the second');
});

// ---- Ink Squid -----------------------------------------------------------------------------------

// A squid that lobs on the next step, placed 340 px from Rip (inside its 320..420 band).
function squidAndRip(g, vx = 0) {
  place(g, 640, H / 2);
  g.player.vx = vx;
  const sq = spawnEnemy(g, 'inksquid', 300, H / 2);
  sq.grace = 0;
  sq.lobCd = 0;
  return sq;
}

// Stops a squid lobbing again, so a test sees one arc at a time.
function oneLob(sq) {
  sq.lobCd = 1e9;
}

test('a lob lands 0.4 s ahead of Rip\'s velocity, 1.0 s after it is thrown, and leaves a puddle that lasts 3 s', () => {
  const g = quiet();
  const sq = squidAndRip(g, 300);
  update(g, NONE, SIM_DT);
  oneLob(sq);
  const s = g.extras.shells[0];
  assert.ok(s, 'a shell is in the air');
  assert.ok(Math.abs(s.lx - (g.player.x + g.player.vx * ENEMY.inksquid.lobLead)) < 1e-6, 'lands at the predicted point');
  assert.ok(Math.abs(s.ly - g.player.y) < 1e-6);
  const thrown = kindOf(drainEvents(g), 'lobThrow');
  assert.equal(thrown.length, 1);
  assert.equal(thrown[0].flightTime, ENEMY.inksquid.flightTime);

  const landed = kindOf(run(g, seconds(1.05)), 'lobLand');
  assert.equal(landed.length, 1, 'lands after the flight time');
  assert.equal(landed[0].radius, ENEMY.inksquid.puddleRadius);
  assert.equal(g.extras.puddles.length, 1);
  run(g, seconds(3.1));
  assert.equal(g.extras.puddles.length, 0, 'the puddle lasts 3 s');
});

test('Rip is half as fast inside a puddle', () => {
  const g = quiet();
  place(g, 600, H / 2);
  g.extras.puddles.push({ id: 90, x: 600, y: H / 2, r: 2000, t: 0, dur: 3, alive: true }); // covers the run
  run(g, seconds(1.5), { ...NONE, moveX: 1 });
  const speed = Math.hypot(g.player.vx, g.player.vy);
  assert.ok(speed <= PLAYER.maxSpeed * ENEMY.inksquid.puddleSlow + 1e-6, `slowed to ${speed.toFixed(1)}`);
  assert.ok(speed > PLAYER.maxSpeed * ENEMY.inksquid.puddleSlow - 5, 'and at the slowed top speed');
});

test('a perfect Pulse reflects an arc back at the squid and kills it, with the perfect slow-motion', () => {
  const g = quiet();
  const sq = squidAndRip(g, 0);
  update(g, NONE, SIM_DT);
  oneLob(sq);
  const s = g.extras.shells[0];
  // Wait until the arc is 0.12 s or less from landing. Rip stands on the landing point, inside the pulse radius.
  run(g, seconds(1.0 - 0.12) - 1);
  while (s.dur - s.t > PULSE.perfectWindow) update(g, NONE, SIM_DT);
  drainEvents(g);
  update(g, PULSE_IN, SIM_DT);
  const events = drainEvents(g);
  assert.equal(s.state, 'reflect');
  assert.equal(kindOf(events, 'lobReflect').length, 1);
  assert.equal(kindOf(events, 'perfectPulse').length, 1, 'the perfect-pulse slow-motion event');
  assert.ok(g.slowmo > 0, 'slow-motion runs');
  const killed = [...kindOf(events, 'kill'), ...kindOf(run(g, seconds(1.5)), 'kill')];
  assert.equal(sq.alive, false, 'the squid is killed by its own arc');
  assert.ok(killed.some((k) => k.enemyType === 'inksquid' && k.cause === 'reflect'));
});

test('a normal Pulse deflects an arc in flight without killing the squid', () => {
  const g = quiet();
  const sq = squidAndRip(g, 0);
  update(g, NONE, SIM_DT);
  oneLob(sq);
  const s = g.extras.shells[0];
  // The arc is within the pulse radius of Rip from about 0.66 s; stop at 0.75 s, short of perfect.
  while (s.t < 0.75) update(g, NONE, SIM_DT);
  drainEvents(g);
  assert.ok(s.dur - s.t > PULSE.perfectWindow, 'not yet perfect');
  update(g, PULSE_IN, SIM_DT);
  const events = drainEvents(g);
  assert.equal(kindOf(events, 'lobDeflect').length, 1);
  assert.equal(kindOf(events, 'lobDeflect')[0].cause, 'pulse');
  assert.equal(s.alive, false, 'the arc is gone: no puddle');
  assert.equal(kindOf(events, 'perfectPulse').length, 0);
  run(g, seconds(1));
  assert.equal(sq.alive, true, 'the squid lives');
  assert.equal(g.extras.puddles.length, 0);
});

test('a dash clears a puddle it passes through, and cuts an arc in flight', () => {
  const g = quiet();
  place(g, 400, H / 2);
  g.extras.puddles.push({ id: 91, x: 480, y: H / 2, r: ENEMY.inksquid.puddleRadius, t: 0, dur: 3, alive: true });
  g.extras.shells.push({
    id: 92, from: 0, sx: 480, sy: H / 2, lx: 480, ly: H / 2, x: 480, y: H / 2, t: 0.2, dur: 1, state: 'flight', alive: true,
  });
  update(g, dashAt(1000, H / 2), SIM_DT);
  const events = [...drainEvents(g), ...run(g, 20)];
  assert.equal(kindOf(events, 'puddleDispel').length, 1);
  assert.equal(g.extras.puddles.length, 0);
  const deflect = kindOf(events, 'lobDeflect');
  assert.equal(deflect.length, 1);
  assert.equal(deflect[0].cause, 'dash');
  assert.equal(g.extras.shells.length, 0);
});

// ---- Phase Eel -----------------------------------------------------------------------------------

test('a hidden eel cannot be dashed: the dash passes it, and nothing is refunded', () => {
  const g = quiet();
  place(g, 300, H / 2);
  const eel = freeze(spawnEnemy(g, 'phaseeel', 420, H / 2));
  assert.equal(eel.state, 'hidden');
  update(g, dashAt(1000, H / 2), SIM_DT);
  run(g, 20);
  assert.equal(eel.alive, true);
  assert.equal(g.player.dash.charges, 2, 'no refund');
});

test('the eel cycle runs hidden 1.6 s, ripple 0.5 s, visible 1.2 s, and reappears 180 to 300 px from Rip', () => {
  const g = quiet();
  place(g, W / 2, H / 2);
  const eel = spawnEnemy(g, 'phaseeel', 200, 200);
  eel.grace = 0;
  const seen = [];
  for (let i = 0; i < seconds(3.5); i++) {
    update(g, NONE, SIM_DT);
    for (const ev of drainEvents(g)) if (ev.type.startsWith('eel')) seen.push([ev.type, i * SIM_DT]);
  }
  const at = (type) => seen.find(([t]) => t === type)?.[1];
  assert.ok(Math.abs(at('eelRipple') - 1.6) < 0.02, `ripple at 1.6 s, got ${at('eelRipple')}`);
  assert.ok(Math.abs(at('eelSurface') - 2.1) < 0.02, `surfaces at 2.1 s, got ${at('eelSurface')}`);
  assert.ok(Math.abs(at('eelHide') - 3.3) < 0.02, `hides at 3.3 s, got ${at('eelHide')}`);
  const d = Math.hypot(eel.x - g.player.x, eel.y - g.player.y);
  assert.ok(d >= ENEMY.phaseeel.placeMin - 1 && d <= ENEMY.phaseeel.placeMax + 1, `reappears ${d.toFixed(1)} px from Rip`);
});

test('a dash in the visible window kills the eel and refunds a charge', () => {
  const g = quiet();
  place(g, 300, H / 2);
  const eel = spawnEnemy(g, 'phaseeel', 420, H / 2);
  eel.grace = 0;
  eel.state = 'visible';
  eel.stateT = ENEMY.phaseeel.visibleTime;
  update(g, dashAt(1000, H / 2), SIM_DT);
  const events = [...drainEvents(g), ...run(g, 20)];
  assert.equal(eel.alive, false);
  assert.equal(kindOf(events, 'kill')[0].enemyType, 'phaseeel');
  assert.equal(g.player.dash.charges, 3, 'the kill refunds');
});

test('a Pulse during the ripple stuns the eel: it stays visible and killable for 0.8 s, then goes under', () => {
  const g = quiet();
  place(g, 600, H / 2);
  const eel = spawnEnemy(g, 'phaseeel', 650, H / 2);
  eel.grace = 0;
  eel.state = 'ripple';
  eel.stateT = ENEMY.phaseeel.rippleTime;
  update(g, PULSE_IN, SIM_DT);
  assert.equal(eel.state, 'stunned');
  assert.equal(kindOf(drainEvents(g), 'eelStun').length, 1);
  assert.equal(eel.visible, true, 'visible during the stun');
  run(g, seconds(0.5));
  assert.equal(eel.state, 'stunned', 'still stunned');
  run(g, seconds(0.4));
  assert.equal(eel.state, 'hidden', 'under again after the stun');
});

test('a Pulse on a hidden or visible eel does nothing: no stagger, no state change', () => {
  const g = quiet();
  place(g, 600, H / 2);
  const hidden = spawnEnemy(g, 'phaseeel', 650, H / 2);
  hidden.grace = 0;
  update(g, PULSE_IN, SIM_DT);
  assert.equal(hidden.state, 'hidden');
  assert.equal(hidden.stagger, 0, 'the stagger is cleared');
  const h = quiet();
  place(h, 600, H / 2);
  const visible = spawnEnemy(h, 'phaseeel', 650, H / 2);
  visible.grace = 0;
  visible.state = 'visible';
  visible.stateT = 1;
  update(h, PULSE_IN, SIM_DT);
  assert.equal(visible.state, 'visible');
  assert.equal(visible.stagger, 0);
});

test('the bite runs straight at Rip\'s position at the surfacing, at 280 px/s', () => {
  const g = quiet();
  place(g, 600, H / 2);
  const eel = spawnEnemy(g, 'phaseeel', 300, H / 2);
  eel.grace = 0;
  eel.state = 'ripple';
  eel.stateT = 0;
  update(g, NONE, SIM_DT); // ripple ends: surfaces and sets the bite
  const events = drainEvents(g);
  assert.equal(eel.state, 'visible');
  assert.equal(kindOf(events, 'eelBite').length, 1);
  const speed = Math.hypot(eel.vx, eel.vy);
  assert.ok(Math.abs(speed - ENEMY.phaseeel.biteSpeed) < 1e-6, `speed ${speed}`);
  assert.ok(eel.vx > 0 && Math.abs(eel.vy) < 1e-6, 'straight at Rip, who is to the right');
});

test('a hidden eel does not touch Rip, even on top of her', () => {
  const g = quiet();
  place(g, 600, H / 2);
  const eel = spawnEnemy(g, 'phaseeel', 600, H / 2);
  eel.grace = 0;
  run(g, seconds(0.1));
  assert.equal(g.player.hp, PLAYER.maxHp);
});

// ---- Anglerfish Warden ---------------------------------------------------------------------------

test('the Warden spawns with 14 hit points, in phase 1 at wave 10 and phase 2 at wave 20, and announces itself', () => {
  const g = quiet();
  const w10 = spawnEnemy(g, 'warden', 640, H / 2, 10);
  assert.equal(w10.hp, ENEMY.warden.hp);
  assert.equal(w10.maxHp, ENEMY.warden.hp);
  assert.equal(w10.phase, 1);
  const intro = kindOf(drainEvents(g), 'bossIntro');
  assert.equal(intro.length, 1);
  assert.equal(intro[0].enemyType, 'warden');
  const w20 = spawnEnemy(g, 'warden', 640, H / 2, 20);
  assert.equal(w20.phase, 2, 'wave 20 starts in phase 2');
});

test('a dash through the exposed body takes one hit point, at most once per dash, and refunds nothing', () => {
  const g = quiet();
  place(g, 200, H / 2);
  const w = spawnEnemy(g, 'warden', 380, H / 2, 10);
  w.state = 'expose';
  w.stateT = ENEMY.warden.exposeTime;
  w.exposed = true;
  update(g, dashAt(1000, H / 2), SIM_DT);
  const events = [...drainEvents(g), ...run(g, 20)];
  assert.equal(w.hp, ENEMY.warden.hp - 1, 'one hit, not one per step');
  assert.equal(kindOf(events, 'bossHit').length, 1);
  assert.equal(w.alive, true);
  assert.equal(g.player.dash.charges, 2, 'no refund for a boss hit');
  place(g, 200, H / 2);
  update(g, dashAt(1000, H / 2), SIM_DT);
  run(g, 20);
  assert.equal(w.hp, ENEMY.warden.hp - 2, 'a second dash is a second hit');
});

test('a dash outside the exposure does nothing to the Warden', () => {
  const g = quiet();
  place(g, 200, H / 2);
  const w = spawnEnemy(g, 'warden', 380, H / 2, 10);
  assert.equal(w.exposed, false);
  update(g, dashAt(1000, H / 2), SIM_DT);
  run(g, 20);
  assert.equal(w.hp, ENEMY.warden.hp);
  assert.equal(w.alive, true);
});

test('the Warden telegraphs, snaps, exposes for 0.6 s, then recovers: the weak point is only open after the attack', () => {
  const g = quiet();
  const w = spawnEnemy(g, 'warden', 900, H / 2, 10);
  const seen = [];
  for (let i = 0; i < seconds(4.1); i++) {
    update(g, NONE, SIM_DT);
    for (const ev of drainEvents(g)) if (ev.type === 'bossTelegraph' || ev.type === 'bossExpose') seen.push(ev.type);
    if (w.exposed) assert.equal(w.state, 'expose');
  }
  // The opening telegraph is announced at spawn; then snap (expose), recover, telegraph, snap again.
  assert.deepEqual(seen.slice(0, 4), ['bossTelegraph', 'bossExpose', 'bossTelegraph', 'bossExpose']);
});

test('phase 2 starts at half hit points: it moves at 90 px/s and cycles faster', () => {
  const g = quiet();
  place(g, 200, H / 2);
  const w = spawnEnemy(g, 'warden', 380, H / 2, 10);
  w.hp = 8;
  w.state = 'expose';
  w.stateT = ENEMY.warden.exposeTime;
  w.exposed = true;
  update(g, dashAt(1000, H / 2), SIM_DT);
  const events = [...drainEvents(g), ...run(g, 20)];
  assert.equal(w.hp, 7);
  assert.equal(w.phase, 2);
  assert.equal(kindOf(events, 'bossPhase').length, 1);
  assert.equal(ENEMY.warden.phase2Speed, 90);
});

test('the Warden lures four Drifters every 6 s, at 220 px/s; a lure Drifter killed while it lives is worth 50 more', () => {
  const g = quiet();
  const w = spawnEnemy(g, 'warden', 300, 200, 10);
  let lures = 0;
  const lureDrifters = [];
  for (let i = 0; i < seconds(12.5); i++) {
    g.player.invuln = 1e9; // the lure is what this checks, not Rip's health
    update(g, NONE, SIM_DT);
    for (const ev of drainEvents(g)) {
      if (ev.type === 'lureSpawn') {
        lures += 1;
        assert.equal(ev.count, ENEMY.warden.lureCount);
      }
    }
  }
  for (const e of g.enemies) if (e.lureOf === w.id) lureDrifters.push(e);
  assert.equal(lures, 2, 'two lures in 12 s: at 4 s and 10 s');
  assert.equal(lureDrifters.length, 8);
  for (const d of lureDrifters) {
    assert.equal(d.kind, 'drifter');
    assert.equal(d.lureSpeed, ENEMY.warden.lureSpeed);
    assert.equal(d.killBonus, ENEMY.warden.lureBonus);
  }
  const score = g.score;
  const combo = g.combo.count;
  killEnemy(g, lureDrifters[0], 1, 'dash');
  assert.equal(g.score - score, ENEMY.drifter.points * multiplierFor(combo + 1) + ENEMY.warden.lureBonus);
});

test('the Warden\'s death heals Rip, pays its score, and fades the lure without score', () => {
  const g = quiet();
  const w = spawnEnemy(g, 'warden', 300, 200, 10);
  g.player.hp = 1;
  for (let i = 0; i < seconds(6.5); i++) {
    g.player.invuln = 1e9;
    update(g, NONE, SIM_DT);
    drainEvents(g);
  }
  const lure = g.enemies.filter((e) => e.lureOf === w.id && e.alive).length;
  assert.ok(lure > 0, 'a lure is out');
  const score = g.score;
  killEnemy(g, w, 1, 'dash');
  const events = drainEvents(g);
  assert.equal(g.score - score, ENEMY.warden.points * multiplierFor(1), 'base x multiplier');
  assert.equal(g.player.hp, 2, 'a guaranteed heal');
  assert.equal(kindOf(events, 'heal').length, 1);
  const down = kindOf(events, 'bossDown');
  assert.equal(down.length, 1);
  assert.equal(down[0].lures, lure);
  assert.equal(g.enemies.filter((e) => e.lureOf === w.id && e.alive).length, 0, 'the lure is gone');
});

test('a boss wave holds until its Warden dies: the next wave does not start while it lives', () => {
  const g = createGame(7, { startWave: 10 });
  g.time = SPAWN.drifterOnlyUntil;
  let boss = null;
  for (let i = 0; i < seconds(60) && !boss; i++) {
    g.player.invuln = 1e9;
    update(g, NONE, SIM_DT);
    drainEvents(g);
    boss = g.enemies.find((e) => e.kind === 'warden') ?? null;
  }
  assert.ok(boss, 'the Warden is released in wave 10');
  for (let i = 0; i < seconds(10) && boss.alive; i++) {
    g.player.invuln = 1e9;
    update(g, NONE, SIM_DT);
    drainEvents(g);
    assert.equal(g.wave.number, 10, 'still wave 10 while the boss lives');
  }
  killEnemy(g, boss, 1, 'dash');
  let cleared = false;
  let started = false;
  for (let i = 0; i < seconds(15) && !started; i++) {
    for (const e of g.enemies) if (e.alive && e.wave === 10) killEnemy(g, e, 1, 'dash');
    update(g, NONE, SIM_DT);
    for (const ev of drainEvents(g)) {
      if (ev.type === 'waveClear' && ev.wave === 10) cleared = true;
      if (ev.type === 'waveStart' && ev.wave === 11) started = true;
    }
  }
  assert.ok(cleared, 'wave 10 clears when its boss and the rest are down');
  assert.ok(started, 'wave 11 then starts');
});

// ---- Feedback fields and the soak ----------------------------------------------------------------

const NEW_TYPES = new Set([
  'puffSwell', 'puffBurst', 'bearerHit', 'barrierBreak', 'lobThrow', 'lobLand', 'lobReflect', 'lobDeflect',
  'puddleDispel', 'eelRipple', 'eelSurface', 'eelBite', 'eelHide', 'eelStun', 'lureSpawn', 'bossIntro',
  'bossTelegraph', 'bossExpose', 'bossHit', 'bossPhase', 'bossStun', 'bossDown',
]);

test('every event of the second round carries finite x and y, and an enemy type where it names one', () => {
  const r = (() => {
    let a = 99;
    return () => {
      a = (a * 1103515245 + 12345) & 0x7fffffff;
      return a / 0x7fffffff;
    };
  })();
  const seen = new Set();
  for (const startWave of [10, 16]) {
    const g = createGame(40 + startWave, { startWave });
    g.time = SPAWN.drifterOnlyUntil;
    for (let i = 0; i < seconds(12); i++) {
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
        if (!NEW_TYPES.has(ev.type)) continue;
        seen.add(ev.type);
        assert.ok(Number.isFinite(ev.x) && Number.isFinite(ev.y), `${ev.type} has x, y`);
        if (ev.type !== 'lobReflect' && ev.type !== 'lobDeflect') assert.ok(typeof ev.enemyType === 'string', `${ev.type} names its enemy`);
      }
      if (g.over) break;
    }
  }
  assert.ok(seen.size >= 5, `the soak reached several new events: ${[...seen].join(', ')}`);
});
