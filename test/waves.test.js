import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  WAVE_TABLE,
  SCRIPTED_KINDS,
  LAST_TABLE_WAVE,
  FORMATIONS,
  budgetFor,
  cadenceFor,
  countsFor,
  isReleaseWave,
  planWave,
  chunkSchools,
  schoolCapFor,
  formationOffsets,
  POINT_COSTS,
} from '../src/waves.js';
import { SPAWN } from '../src/config.js';

const sum = (counts) => Object.values(counts).reduce((a, b) => a + b, 0);
const schoolTotal = (plan) => plan.schools.reduce((a, s) => a + s.size, 0);

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
    assert.ok(row.cadence >= 0.5 && row.cadence <= 2.0, `wave ${row.wave} cadence ${row.cadence}`);
  }
});

test('table waves match the design: the design release waves, and drifter-only wave 1', () => {
  const release = WAVE_TABLE.filter((r) => r.release).map((r) => r.wave);
  assert.deepEqual(release, [3, 5, 9, 11, 15, 18]);
  assert.deepEqual(WAVE_TABLE[0].counts, { drifter: 16 });
  assert.equal(WAVE_TABLE[6].counts.mine, 3, 'wave 7 introduces mines');
  assert.equal(WAVE_TABLE[7].counts.shellback, 2, 'wave 8 introduces shellbacks');
  assert.equal(WAVE_TABLE[4].counts.splitter, 2, 'wave 5 introduces splitters');
});

test('wave 14 has four chargers, not two (#88: it was skipped in 3.5 s)', () => {
  assert.equal(WAVE_TABLE[13].counts.charger, 4);
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

test('the point budget beyond wave 20 is 60 + 9k and has no cap, so waves keep scaling (#97)', () => {
  assert.equal(budgetFor(21), 69);
  assert.equal(budgetFor(30), 150);
  assert.equal(budgetFor(40), 240);
  assert.ok(budgetFor(500) > budgetFor(40), 'the budget keeps growing');
});

test('cadence beyond 20 falls from 0.59 s to a floor of 0.5 s between schools', () => {
  assert.ok(Math.abs(cadenceFor(21) - 0.59) < 1e-9);
  assert.equal(cadenceFor(200), 0.5, 'the cadence floors at 0.5 s');
});

test('release waves beyond 20 fall on every 5th wave that is not a 10th (the boss wave is not in the sim)', () => {
  assert.equal(isReleaseWave(25), true);
  assert.equal(isReleaseWave(30), false, 'wave 30 is a boss wave in the design; a tension wave here');
  assert.equal(isReleaseWave(35), true);
  assert.equal(isReleaseWave(22), false);
});

test('chunkSchools splits Drifters into schools of 4-8 that sum to the count', () => {
  assert.deepEqual(chunkSchools(9, 4), [5, 4]);
  assert.deepEqual(chunkSchools(31, 8), [8, 8, 8, 7]);
  assert.deepEqual(chunkSchools(3), [3], 'a remainder under 4 is a school of its own');
  assert.deepEqual(chunkSchools(0), []);
  for (let cap = 4; cap <= 8; cap++) {
    for (let n = 4; n <= 200; n++) {
      const sizes = chunkSchools(n, cap);
      assert.equal(sizes.reduce((a, b) => a + b, 0), n, `n ${n} cap ${cap} sums`);
      assert.ok(sizes.every((s) => s >= SPAWN.schoolMin && s <= SPAWN.schoolMax), `n ${n} cap ${cap} sizes ${sizes}`);
      assert.ok(Math.max(...sizes) - Math.min(...sizes) <= 1, `n ${n} cap ${cap} sizes differ by at most one`);
    }
  }
});

test('the school cap grows with the wave: 4 at wave 1, 8 from wave 17 on', () => {
  assert.equal(schoolCapFor(1), 4);
  assert.equal(schoolCapFor(5), 5);
  assert.equal(schoolCapFor(17), 8);
  assert.equal(schoolCapFor(200), 8);
});

test('a plan is built from the table: every enemy is in a school, and every Drifter school is 4-8 (1 only for a remainder)', () => {
  for (const row of WAVE_TABLE) {
    const plan = planWave(row.wave);
    assert.equal(schoolTotal(plan), sum(row.counts), `wave ${row.wave} enemy count`);
    assert.equal(plan.cadence, row.cadence);
    for (const school of plan.schools) {
      if (school.kind !== 'drifter') assert.equal(school.size, 1, `wave ${row.wave} ${school.kind} comes alone`);
      else assert.ok(school.size >= 1 && school.size <= SPAWN.schoolMax, `wave ${row.wave} drifter school of ${school.size}`);
    }
  }
  const w1 = planWave(1);
  assert.deepEqual(w1.schools.map((s) => s.size), [4, 4, 4, 4], 'wave 1 is four schools of four');
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
  assert.equal(schoolTotal(plan), sum(plan.counts), 'the schools hold every enemy in the counts');
  assert.ok(sum(plan.counts) > 60, 'wave 50 is large');
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

test('formation offsets: a line runs across the front, a wedge leads with one member, a ring has the spacing', () => {
  const line = formationOffsets('line', 5, 20);
  assert.equal(line.length, 5);
  assert.ok(line.every((o) => o.x === 0), 'a line has no depth');
  assert.deepEqual(line.map((o) => o.y), [-40, -20, 0, 20, 40]);

  const wedge = formationOffsets('wedge', 5, 20);
  assert.deepEqual(wedge[0], { x: 0, y: 0 }, 'the leader is at the centre');
  assert.ok(wedge.slice(1).every((o) => o.x < 0), 'followers trail behind the leader');

  const ring = formationOffsets('ring', 8, 20);
  for (const o of ring) assert.ok(Math.abs(Math.hypot(o.x, o.y) - Math.max(20, (8 * 20) / (2 * Math.PI))) < 1e-9);
  assert.deepEqual([...FORMATIONS], ['line', 'wedge', 'ring']);
});
