import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  WAVE_TABLE,
  SCRIPTED_KINDS,
  LAST_TABLE_WAVE,
  budgetFor,
  cadenceFor,
  countsFor,
  isReleaseWave,
  planWave,
  spawnQueue,
  POINT_COSTS,
} from '../src/waves.js';

const sum = (counts) => Object.values(counts).reduce((a, b) => a + b, 0);

test('the table covers waves 1-20 exactly once, in order', () => {
  assert.equal(WAVE_TABLE.length, LAST_TABLE_WAVE);
  WAVE_TABLE.forEach((row, i) => assert.equal(row.wave, i + 1));
});

test('every table row uses only kinds that exist in the sim, with whole non-negative counts', () => {
  for (const row of WAVE_TABLE) {
    for (const [kind, n] of Object.entries(row.counts)) {
      assert.ok(SCRIPTED_KINDS.includes(kind), `wave ${row.wave} has unknown kind ${kind}`);
      assert.ok(Number.isInteger(n) && n >= 0, `wave ${row.wave} ${kind} count ${n}`);
    }
    assert.ok(sum(row.counts) > 0, `wave ${row.wave} is not empty`);
    assert.ok(row.cadence >= 1.0 && row.cadence <= 4.0, `wave ${row.wave} cadence ${row.cadence}`);
  }
});

test('table waves match the design: the design release waves, and drifter-only wave 1', () => {
  const release = WAVE_TABLE.filter((r) => r.release).map((r) => r.wave);
  assert.deepEqual(release, [3, 5, 9, 11, 15, 18]);
  assert.deepEqual(WAVE_TABLE[0].counts, { drifter: 10 });
  assert.deepEqual(WAVE_TABLE[6].counts, { drifter: 16, mine: 3 }, 'wave 7 introduces mines');
  assert.equal(WAVE_TABLE[7].counts.shellback, 2, 'wave 8 introduces shellbacks');
  assert.equal(WAVE_TABLE[4].counts.splitter, 2, 'wave 5 introduces splitters');
});

test('pacing: no more than three tension waves (intensity 6+) in a row, and each release wave is followed by intensity 4+', () => {
  let run = 0;
  let longest = 0;
  for (const row of WAVE_TABLE) {
    run = row.intensity >= 6 ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  assert.ok(longest <= 3, `longest tension run is ${longest}`);
  for (const row of WAVE_TABLE) {
    if (!row.release) continue;
    const next = WAVE_TABLE[row.wave];
    assert.ok(next && next.intensity >= 4, `wave after release ${row.wave} has intensity ${next?.intensity}`);
  }
});

test('the point budget beyond wave 20 is min(120, 60 + 3k)', () => {
  assert.equal(budgetFor(21), 63);
  assert.equal(budgetFor(30), 90);
  assert.equal(budgetFor(40), 120);
  assert.equal(budgetFor(50), 120);
  assert.equal(budgetFor(500), 120, 'the budget is capped');
});

test('cadence beyond 20 is max(1.2, 3.0 - 0.05k)', () => {
  assert.ok(Math.abs(cadenceFor(21) - 2.95) < 1e-9);
  assert.equal(cadenceFor(200), 1.2, 'the cadence floors at 1.2 s');
});

test('release waves beyond 20 fall on every 5th wave that is not a 10th (the boss wave is not in the sim)', () => {
  assert.equal(isReleaseWave(25), true);
  assert.equal(isReleaseWave(30), false, 'wave 30 is a boss wave in the design; a tension wave here');
  assert.equal(isReleaseWave(35), true);
  assert.equal(isReleaseWave(22), false);
});

test('wave 50 is a valid, bounded plan: every kind is scripted, the budget is respected, and it has enemies', () => {
  const counts = countsFor(50);
  assert.deepEqual(Object.keys(counts).sort(), [...SCRIPTED_KINDS].sort());
  let points = 0;
  for (const kind of SCRIPTED_KINDS) {
    assert.ok(Number.isInteger(counts[kind]) && counts[kind] >= 0, `${kind} count ${counts[kind]}`);
    points += counts[kind] * POINT_COSTS[kind];
  }
  assert.equal(points, budgetFor(50), 'every point of the budget is spent, leftovers buy drifters');

  const plan = planWave(50);
  assert.equal(plan.release, false);
  assert.equal(sum(plan.counts), plan.groups.flat().length, 'the groups hold every enemy in the counts');
  assert.ok(plan.groups.every((g) => g.length >= 1 && g.length <= 3), 'groups are 1-3 enemies');
  assert.ok(plan.groups.flat().length > 20, 'wave 50 is large');
});

test('beyond wave 20 every wave is a valid plan, and release waves carry 60% of the budget', () => {
  for (let wave = 21; wave <= 60; wave++) {
    const counts = countsFor(wave);
    let points = 0;
    for (const kind of SCRIPTED_KINDS) {
      assert.ok(counts[kind] >= 0, `wave ${wave} ${kind}`);
      points += counts[kind] * POINT_COSTS[kind];
    }
    const budget = isReleaseWave(wave) ? Math.floor(budgetFor(wave) * 0.6) : budgetFor(wave);
    assert.equal(points, budget, `wave ${wave} spends its budget`);
  }
});

test('plans are built from the table for waves 1-20: sizes match and groups are 2 or 3 (1 only when a plan is tiny)', () => {
  for (const row of WAVE_TABLE) {
    const plan = planWave(row.wave);
    assert.equal(plan.groups.flat().length, sum(row.counts), `wave ${row.wave} size`);
    assert.equal(plan.cadence, row.cadence);
    for (const group of plan.groups) {
      assert.ok(group.length >= 2 && group.length <= 3, `wave ${row.wave} group of ${group.length}`);
    }
  }
});

test('the spawn queue has one entry per enemy; each group ends with the cadence gap, the rest are 0', () => {
  const plan = planWave(1);
  const queue = spawnQueue(plan);
  assert.equal(queue.length, 10);
  assert.ok(queue.every((q) => q.kind === 'drifter'));
  const gaps = queue.map((q) => q.gap);
  assert.equal(gaps.filter((g) => g === plan.cadence).length, plan.groups.length);
  assert.equal(gaps.filter((g) => g === 0).length, 10 - plan.groups.length);
});
