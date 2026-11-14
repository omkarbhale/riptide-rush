import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HIGH_SCORE_KEY, SIM_DT, SIM_HZ, LOGICAL_WIDTH as W, LOGICAL_HEIGHT as H } from '../src/config.js';
import { createGame, update, drainEvents, spawnEnemy, speedScaleFor, damagePlayer } from '../src/game.js';
import { dashMaxCharges, onKill } from '../src/pickups.js';
import { SCORES_KEY } from '../src/scores.js';
import {
  CHALLENGE_KEY,
  DAILY_KEEP,
  DAILY_KEY,
  MODE_KEY,
  MUTATORS,
  bestScore,
  dailyEntry,
  dailyMutator,
  dailySeed,
  dailyShareText,
  decodeShare,
  encodeShare,
  fnv1a32,
  formatScore,
  loadMode,
  medalFor,
  recordModeRun,
  rulesFor,
  saveMode,
  seedFor,
  utcDayKey,
  waveBar,
} from '../src/modes.js';

// An in-memory localStorage stand-in.
function memoryStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    raw: map,
  };
}

// Storage that refuses every call, as blocked or private-mode storage does.
const blockedStorage = Object.freeze({
  getItem() {
    throw new Error('blocked');
  },
  setItem() {
    throw new Error('blocked');
  },
});

// ---- daily seed --------------------------------------------------------------------------------

test('FNV-1a matches the published 32-bit test vectors', () => {
  assert.equal(fnv1a32(''), 0x811c9dc5);
  assert.equal(fnv1a32('a'), 0xe40c292c);
  assert.equal(fnv1a32('foobar'), 0xbf9cf968);
});

test('the daily seed is stable for a date and changes across dates', () => {
  assert.equal(dailySeed('2026-11-14'), dailySeed('2026-11-14'));
  assert.notEqual(dailySeed('2026-11-14'), dailySeed('2026-11-15'));
  assert.notEqual(dailySeed('2026-11-14'), dailySeed('2026-12-14'));
  assert.ok(Number.isInteger(dailySeed('2026-11-14')) && dailySeed('2026-11-14') >= 0);
});

test('the day key is the UTC date, whatever the local time zone', () => {
  assert.equal(utcDayKey(new Date('2026-11-14T00:00:00Z')), '2026-11-14');
  assert.equal(utcDayKey(new Date('2026-11-14T23:59:59Z')), '2026-11-14');
  assert.equal(utcDayKey(new Date('2026-11-15T00:00:00Z')), '2026-11-15');
});

test('the daily mutator is seed mod 3, and every mutator keeps the telegraphs (no hidden danger)', () => {
  assert.equal(MUTATORS.length, 3);
  for (let s = 0; s < 9; s++) assert.equal(dailyMutator(s), MUTATORS[s % 3]);
  assert.deepEqual(MUTATORS.map((m) => m.name), ['Swift School', 'Short Fuse', 'Thin Reserve']);
  // No mutator hides a telegraph: none of them touches the telegraph timings or turns off a warning.
  for (const m of MUTATORS) assert.ok(!('telegraph' in m.rules) && !('spawnWarning' in m.rules));
});

test('Daily Tide uses the day seed, the other modes use the caller seed', () => {
  assert.equal(seedFor('daily', '2026-11-14', 999), dailySeed('2026-11-14'));
  assert.equal(seedFor('classic', '2026-11-14', 999), 999);
  assert.equal(seedFor('one-life', '2026-11-14', 999), 999);
});

// ---- share string ------------------------------------------------------------------------------

test('the share string matches the spec layout, with the medal block and mutator', () => {
  const text = encodeShare({ dayKey: '2026-11-14', score: 4812, wave: 9, combo: 23, mutatorName: 'Short Fuse' });
  assert.equal(text, 'RIPTIDE RUSH 2026-11-14 · 4,812 · wave 9 ▮▮▮▮▮▮▮▮▮▯ · combo 23 · 🟫 · Short Fuse');
});

test('the share string round-trips through decodeShare for every medal and wave range', () => {
  const cases = [
    { dayKey: '2026-11-14', score: 0, wave: 0, combo: 0, mutatorName: 'Thin Reserve' },
    { dayKey: '2026-01-02', score: 1999, wave: 3, combo: 4, mutatorName: 'Swift School' },
    { dayKey: '2026-11-14', score: 2000, wave: 9, combo: 10, mutatorName: 'Short Fuse' },
    { dayKey: '2026-11-14', score: 6000, wave: 10, combo: 40, mutatorName: 'Swift School' },
    { dayKey: '2026-11-14', score: 1234567, wave: 15, combo: 99, mutatorName: 'Thin Reserve' },
  ];
  for (const c of cases) {
    const text = encodeShare(c);
    const back = decodeShare(text);
    assert.deepEqual(back, {
      dayKey: c.dayKey,
      score: c.score,
      wave: c.wave,
      combo: c.combo,
      medal: medalFor(c.score),
      mutatorName: c.mutatorName,
    });
    assert.equal(encodeShare({ ...back, mutatorName: back.mutatorName }), text, 'encode(decode(text)) is the same text');
  }
});

test('the wave bar fills ten cells up to min(wave, 10)', () => {
  assert.equal(waveBar(0), '▯'.repeat(10));
  assert.equal(waveBar(9), '▮'.repeat(9) + '▯');
  assert.equal(waveBar(10), '▮'.repeat(10));
  assert.equal(waveBar(14), '▮'.repeat(10));
});

test('scores are shown with thousands separators and medals follow the thresholds', () => {
  assert.equal(formatScore(0), '0');
  assert.equal(formatScore(999), '999');
  assert.equal(formatScore(1000), '1,000');
  assert.equal(formatScore(1234567), '1,234,567');
  assert.equal(medalFor(1999), 'none');
  assert.equal(medalFor(2000), 'bronze');
  assert.equal(medalFor(6000), 'silver');
  assert.equal(medalFor(12000), 'gold');
});

test('decodeShare rejects anything that is not a share line', () => {
  assert.equal(decodeShare(''), null);
  assert.equal(decodeShare('RIPTIDE RUSH'), null);
  assert.equal(decodeShare('RIPTIDE RUSH 2026-11-14 · 4,812 · wave 9 ▮▮▮▮▮▮▮▮▮▯ · combo 23 · 🟫 · Short Fuse extra'), null);
});

test('a daily share text carries no seed input, only the result and the mutator name', () => {
  const day = '2026-11-14';
  const text = dailyShareText(day, { score: 4812, wave: 9, combo: 23 });
  assert.ok(text.startsWith('RIPTIDE RUSH 2026-11-14 · 4,812 · wave 9 '));
  assert.ok(!text.includes(String(dailySeed(day))), 'the seed number is not in the share text');
  assert.ok(text.endsWith(dailyMutator(dailySeed(day)).name));
});

// ---- rule overrides ----------------------------------------------------------------------------

test('each mode yields its rule overrides; Daily Tide adds the day mutator', () => {
  assert.deepEqual(rulesFor('classic', '2026-11-14'), {});
  assert.deepEqual(rulesFor('one-life', '2026-11-14'), { maxHp: 1 });
  assert.deepEqual(rulesFor('no-pulse', '2026-11-14'), { pulse: false });
  const day = '2026-11-14';
  assert.deepEqual(rulesFor('daily', day), dailyMutator(dailySeed(day)).rules);
  assert.deepEqual(rulesFor('nonsense', day), {}, 'an unknown mode plays as Classic');
});

test('One Life starts with 1 HP and a single hit ends the run', () => {
  const g = createGame(7, { rules: rulesFor('one-life', '2026-11-14'), spawning: false });
  assert.equal(g.player.maxHp, 1);
  assert.equal(g.player.hp, 1);
  assert.equal(damagePlayer(g, g.player.x - 40, g.player.y), true, 'the hit lands');
  assert.equal(g.player.hp, 0);
  assert.equal(g.over, true, 'the run is over after one hit');
  assert.ok(drainEvents(g).some((ev) => ev.type === 'gameOver'));
});

test('One Life: no heal orb is ever dropped, while modifier drops still happen', () => {
  const g = createGame(11, { rules: { maxHp: 1 }, spawning: false });
  const seen = new Set();
  for (let i = 0; i < 400; i++) {
    g.time += 5; // past the drop spacing, so a roll is allowed every kill
    onKill(g, { x: W / 2, y: H / 2 });
    for (const it of g.pickups.items) seen.add(it.kind);
    g.pickups.items.length = 0;
  }
  assert.ok(!seen.has('heal'), 'no heal orb in One Life');
  assert.ok([...seen].some((k) => ['sparkCoral', 'riptideCoal', 'shieldScale', 'frenzy', 'undertow'].includes(k)), 'modifiers still drop');
});

test('No Pulse: pressing Pulse makes no pulse, no cooldown and no reflection', () => {
  const g = createGame(5, { rules: rulesFor('no-pulse', '2026-11-14'), spawning: false });
  assert.equal(g.rules.pulse, false);
  update(g, { moveX: 0, moveY: 0, aimX: W / 2, aimY: H / 2, dash: false, pulse: true }, SIM_DT);
  const events = drainEvents(g);
  assert.ok(!events.some((ev) => ev.type === 'pulse' || ev.type === 'reflect'), 'no pulse event');
  assert.equal(g.player.pulseCooldown, 0, 'no cooldown is started');
});

test('Pulse still works in the standard rules (the override is the only change)', () => {
  const g = createGame(5, { rules: rulesFor('classic', '2026-11-14'), spawning: false });
  update(g, { moveX: 0, moveY: 0, aimX: W / 2, aimY: H / 2, dash: false, pulse: true }, SIM_DT);
  assert.ok(drainEvents(g).some((ev) => ev.type === 'pulse'), 'classic pulses');
});

test('Thin Reserve caps the base dash charges at 2, and the cap holds on the HUD count', () => {
  const g = createGame(3, { rules: { maxCharges: 2 }, spawning: false });
  assert.equal(g.player.dash.charges, 2);
  assert.equal(dashMaxCharges(g), 2);
});

test('Short Fuse arms a mine with a 0.4 s fuse', () => {
  const g = createGame(9, { rules: { mineFuse: 0.4 }, spawning: false });
  const mine = spawnEnemy(g, 'mine', W / 2 + 300, H / 2);
  g.player.x = mine.x + 50;
  g.player.y = mine.y;
  update(g, { moveX: 0, moveY: 0, aimX: g.player.x, aimY: g.player.y, dash: false, pulse: false }, SIM_DT);
  assert.equal(mine.state, 'armed');
  assert.equal(mine.stateT, 0.4);
});

test('Swift School scales Drifter speed by its factor', () => {
  const plain = createGame(13, { spawning: false });
  const fast = createGame(13, { rules: { driftSpeedScale: 1.25 }, spawning: false });
  for (const g of [plain, fast]) {
    spawnEnemy(g, 'drifter', 120, 120, 1);
    g.player.x = W - 120;
    g.player.y = H - 120;
  }
  for (let i = 0; i < SIM_HZ * 3; i++) {
    update(plain, { moveX: 0, moveY: 0, aimX: 0, aimY: 0, dash: false, pulse: false }, SIM_DT);
    update(fast, { moveX: 0, moveY: 0, aimX: 0, aimY: 0, dash: false, pulse: false }, SIM_DT);
  }
  const vp = Math.hypot(plain.enemies[0].vx, plain.enemies[0].vy);
  const vf = Math.hypot(fast.enemies[0].vx, fast.enemies[0].vy);
  assert.ok(Math.abs(vf / vp - 1.25) < 0.01, `ratio ${vf / vp}`);
  assert.ok(speedScaleFor(1) === 1);
});

// ---- determinism -------------------------------------------------------------------------------

// A fixed input script: steer in slow loops, dash every 1.75 s, pulse now and then.
function scriptedInput(step) {
  const t = step / SIM_HZ;
  return {
    moveX: Math.round(Math.cos(t * 0.6)),
    moveY: Math.round(Math.sin(t * 0.45)),
    aimX: W / 2 + Math.cos(t * 0.9) * 400,
    aimY: H / 2 + Math.sin(t * 0.7) * 250,
    dash: step % 210 === 0,
    pulse: step % 330 === 100,
  };
}

// Plays the script for `seconds` of simulated time and returns the full event log and the final state.
function playScripted(seed, rules, seconds) {
  const g = createGame(seed, { rules });
  const log = [];
  const steps = Math.round(seconds * SIM_HZ);
  for (let s = 0; s < steps; s++) {
    update(g, scriptedInput(s), SIM_DT);
    for (const ev of drainEvents(g)) log.push(JSON.stringify(ev));
  }
  const state = JSON.stringify({
    score: g.score,
    kills: g.kills,
    player: g.player,
    enemies: g.enemies,
    bullets: g.bullets,
    combo: g.combo,
    wave: g.wave,
    pickups: g.pickups,
    schools: g.schools,
    spawnQueue: g.spawnQueue,
    liveWaves: g.liveWaves,
    time: g.time,
    nextId: g.nextId,
  });
  return { state, log, g };
}

test('two Daily Tide games on the same date produce identical state after 30 simulated seconds', () => {
  const day = '2026-11-14';
  const a = playScripted(seedFor('daily', day, 0), rulesFor('daily', day), 30);
  const b = playScripted(seedFor('daily', day, 0), rulesFor('daily', day), 30);
  assert.equal(a.state, b.state);
  assert.deepEqual(a.log, b.log);
  // The run must be non-trivial, or the check proves nothing: enemies spawned and events fired.
  assert.ok(a.log.length > 0, 'events fired');
  assert.ok(a.g.wave.number >= 2, `waves ran (wave ${a.g.wave.number})`);
});

test('the same seed also matches in the standard and challenge rule sets', () => {
  for (const mode of ['classic', 'one-life', 'no-pulse']) {
    const a = playScripted(4242, rulesFor(mode, '2026-11-14'), 10);
    const b = playScripted(4242, rulesFor(mode, '2026-11-14'), 10);
    assert.equal(a.state, b.state, mode);
    assert.deepEqual(a.log, b.log, mode);
  }
});

test('Daily Tide on another date plays a different run', () => {
  const a = playScripted(seedFor('daily', '2026-11-14', 0), rulesFor('daily', '2026-11-14'), 10);
  const b = playScripted(seedFor('daily', '2026-11-15', 0), rulesFor('daily', '2026-11-15'), 10);
  assert.notEqual(a.state, b.state);
});

// ---- per-mode bests and the daily record ------------------------------------------------------

test('the existing single best is Classic best, read from the same key', () => {
  const s = memoryStorage();
  s.setItem(HIGH_SCORE_KEY, '12400');
  assert.equal(bestScore(s, 'classic', '2026-11-14'), 12400);
  assert.equal(loadMode(s), 'classic', 'no saved mode defaults to Classic');
});

test('a challenge best is stored under its own key and never touches Classic', () => {
  const s = memoryStorage();
  s.setItem(HIGH_SCORE_KEY, '12400');
  const r = recordModeRun(s, 'one-life', '2026-11-14', { score: 3100, wave: 7, combo: 20 });
  assert.equal(r.newBest, true);
  assert.equal(bestScore(s, 'one-life', '2026-11-14'), 3100);
  assert.equal(bestScore(s, 'classic', '2026-11-14'), 12400, 'Classic best unchanged');
  assert.ok(s.raw.get(CHALLENGE_KEY).includes('"one-life"'));
  const low = recordModeRun(s, 'one-life', '2026-11-14', { score: 100, wave: 1, combo: 0 });
  assert.equal(low.newBest, false);
  assert.equal(bestScore(s, 'one-life', '2026-11-14'), 3100, 'a lower run does not overwrite the best');
  const np = recordModeRun(s, 'no-pulse', '2026-11-14', { score: 2480, wave: 6, combo: 9 });
  assert.equal(np.newBest, true);
  assert.equal(bestScore(s, 'one-life', '2026-11-14'), 3100, 'no-pulse does not overwrite one-life');
});

test('Classic best is the top of the existing top-five list, not a second key', () => {
  const s = memoryStorage();
  s.setItem(SCORES_KEY, JSON.stringify([{ score: 500 }, { score: 300 }]));
  assert.equal(bestScore(s, 'classic', '2026-11-14'), 500);
  // Classic runs go onto that list in main.js (scores.js), so this module leaves Classic and its key alone.
  assert.deepEqual(recordModeRun(s, 'classic', '2026-11-14', { score: 900, wave: 3, combo: 4 }), {
    newBest: false,
    official: false,
    best: 500,
  });
  assert.equal(s.getItem(HIGH_SCORE_KEY), null, 'the old single key is not written');
});

test('Daily Tide records one official attempt per UTC day; later attempts are practice', () => {
  const s = memoryStorage();
  const day = '2026-11-14';
  const first = recordModeRun(s, 'daily', day, { score: 4812, wave: 9, combo: 23 });
  assert.equal(first.official, true);
  const second = recordModeRun(s, 'daily', day, { score: 9000, wave: 12, combo: 40 });
  assert.equal(second.official, false, 'a later attempt is practice');
  const entry = dailyEntry(s, day);
  assert.deepEqual(entry.official, { score: 4812, wave: 9, combo: 23 }, 'the official result is the first attempt');
  assert.equal(entry.plays, 2);
  assert.equal(bestScore(s, 'daily', day), 4812, 'the day best is the official score');
  // The next UTC day starts a fresh official attempt.
  assert.equal(recordModeRun(s, 'daily', '2026-11-15', { score: 10, wave: 1, combo: 0 }).official, true);
});

test('the daily record keeps the last 30 dates and drops older ones', () => {
  const s = memoryStorage();
  for (let i = 0; i < DAILY_KEEP + 5; i++) {
    const day = new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10);
    recordModeRun(s, 'daily', day, { score: 100, wave: 1, combo: 0 });
  }
  const kept = Object.keys(JSON.parse(s.getItem(DAILY_KEY)));
  assert.equal(kept.length, DAILY_KEEP);
  assert.ok(!kept.includes('2026-01-01'), 'the oldest date is dropped');
  assert.ok(kept.includes(new Date(Date.UTC(2026, 0, DAILY_KEEP + 5)).toISOString().slice(0, 10)), 'the newest is kept');
});

test('the remembered mode round-trips and rejects unknown values', () => {
  const s = memoryStorage();
  assert.equal(loadMode(s), 'classic');
  assert.equal(saveMode(s, 'no-pulse'), true);
  assert.equal(s.getItem(MODE_KEY), 'no-pulse');
  assert.equal(loadMode(s), 'no-pulse');
  s.setItem(MODE_KEY, 'bogus');
  assert.equal(loadMode(s), 'classic');
  assert.equal(saveMode(s, 'bogus'), false);
});

test('blocked or missing localStorage gives the defaults and never throws', () => {
  for (const s of [null, undefined, blockedStorage]) {
    assert.equal(loadMode(s), 'classic');
    assert.equal(saveMode(s, 'daily'), false);
    assert.equal(bestScore(s, 'classic', '2026-11-14'), 0);
    assert.equal(bestScore(s, 'one-life', '2026-11-14'), 0);
    assert.equal(bestScore(s, 'daily', '2026-11-14'), 0);
    const r = recordModeRun(s, 'daily', '2026-11-14', { score: 50, wave: 1, combo: 1 });
    assert.equal(r.official, true, 'the run still counts for this page');
    recordModeRun(s, 'classic', '2026-11-14', { score: 50, wave: 1, combo: 1 });
    recordModeRun(s, 'one-life', '2026-11-14', { score: 50, wave: 1, combo: 1 });
  }
});
