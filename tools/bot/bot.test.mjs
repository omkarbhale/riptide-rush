// Tests for the bot harness itself: determinism, the statistics helpers, that the invariant checker
// really catches broken state, and that every policy returns usable intents. Kept fast: well under a
// second, so it can run in `npm test` alongside the game tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGame, drainEvents, spawnEnemy } from '../../src/game.js';
import { ARENA, LOGICAL_WIDTH as W, LOGICAL_HEIGHT as H, PLAYER } from '../../src/config.js';
import { POLICIES } from './policies.mjs';
import { runOne } from './sim-run.mjs';
import { createChecker, EVENT_FIELDS } from './invariants.mjs';
import { percentile, summarize } from './report.mjs';

test('the same seed and policy give the same game', () => {
  for (const policy of POLICIES) {
    const a = runOne(42, policy, { capSeconds: 20 });
    const b = runOne(42, policy, { capSeconds: 20 });
    assert.equal(a.steps, b.steps, `${policy.name} steps`);
    assert.equal(a.score, b.score, `${policy.name} score`);
    assert.equal(a.wave, b.wave, `${policy.name} wave`);
    assert.deepEqual(a.hits, b.hits, `${policy.name} hits`);
  }
});

test('each policy plays a short game without throwing or breaking invariants on the first 10 s', () => {
  for (const policy of POLICIES) {
    const run = runOne(3, policy, { capSeconds: 10 });
    assert.ok(run.steps > 0, `${policy.name} took steps`);
    assert.ok(Number.isFinite(run.score), `${policy.name} score is finite`);
    // The early game has no known defects: a violation here means the harness or the sim regressed.
    const codes = Object.keys(run.violations);
    assert.deepEqual(codes, [], `${policy.name} violations in the first 10 s: ${codes.join(', ')}`);
  }
});

test('percentiles and summaries use the nearest-rank index', () => {
  const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  assert.equal(percentile(sorted, 0), 1);
  assert.equal(percentile(sorted, 0.5), 5);
  assert.equal(percentile(sorted, 1), 10);
  const s = summarize([3, 1, 2, NaN]);
  assert.equal(s.n, 3);
  assert.equal(s.min, 1);
  assert.equal(s.max, 3);
  assert.equal(s.mean, 2);
});

test('the checker flags a non-finite player position', () => {
  const g = createGame(5);
  drainEvents(g);
  const c = createChecker(g);
  g.player.x = NaN;
  c.afterStep([]);
  assert.ok(c.violations.has('NAN'));
});

test('the checker flags Rip outside the arena', () => {
  const g = createGame(5);
  drainEvents(g);
  const c = createChecker(g);
  g.player.x = ARENA.inset - 5;
  c.afterStep([]);
  assert.ok(c.violations.has('PLAYER_OUT_OF_ARENA'));
});

test('the checker flags an enemy outside its clamp', () => {
  const g = createGame(5);
  drainEvents(g);
  g.spawning = false;
  g.enemies = [];
  const e = spawnEnemy(g, 'splitter', W / 2, H / 2);
  e.y = H + 50; // spawns are clamped now (#82), so push it out after the spawn
  const c = createChecker(g);
  c.afterStep([]);
  assert.ok(c.violations.has('ENEMY_OUT_OF_ARENA'));
  assert.equal(e.kind, 'splitter');
});

test('the checker flags an event that is missing a required field', () => {
  const g = createGame(5);
  drainEvents(g);
  const c = createChecker(g);
  c.afterStep([{ type: 'kill', x: 1, y: 2, enemyType: 'drifter' }]);
  assert.ok(c.violations.has('EVENT_MISSING_FIELD'));
  assert.ok(EVENT_FIELDS.kill.includes('points'));
});

test('the checker flags a kill whose points do not match the score formula', () => {
  const g = createGame(5);
  drainEvents(g);
  g.spawning = false;
  const c = createChecker(g);
  g.combo.count = 1;
  g.combo.timer = 2.5;
  g.score = 999;
  c.afterStep([
    { type: 'kill', x: 300, y: 300, enemyType: 'drifter', combo: 2, multi: 1, bonus: 0, points: 1, hitStopMs: 40, cause: 'dash' },
  ]);
  assert.ok(c.violations.has('KILL_POINTS_MISMATCH') || c.violations.has('SCORE_CHANGE_NOT_FROM_KILLS'));
});

test('dash and pulse intents are plain booleans and move values are finite', () => {
  const g = createGame(9);
  drainEvents(g);
  for (const policy of POLICIES) {
    const mem = policy.createMemory();
    for (let i = 0; i < 50; i++) {
      const intent = policy.decide(g, () => 0.5, mem);
      assert.equal(typeof intent.dash, 'boolean');
      assert.equal(typeof intent.pulse, 'boolean');
      assert.ok(Number.isFinite(intent.moveX) && Number.isFinite(intent.moveY), `${policy.name} move`);
    }
  }
  assert.ok(PLAYER.radius > 0);
});
