// Top-five local high scores: validation, the one-time migration from the single high-score key, blocked and
// corrupt storage, and where a finished run lands on the list (ties keep the earlier run ahead). Pure, so it
// runs under `node --test` with a stub storage object.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HIGH_SCORE_KEY } from '../src/config.js';
import { SCORES_KEY, TOP_N, loadScores, normalizeEntry, normalizeScores, recordRun, saveScores, topScore } from '../src/scores.js';

// A storage stub backed by a Map. `broken` makes every call throw, as blocked storage does.
function stubStorage(init = {}, broken = false) {
  const store = new Map(Object.entries(init));
  const deny = () => {
    throw new Error('storage denied');
  };
  return {
    store,
    getItem: (k) => (broken ? deny() : store.has(k) ? store.get(k) : null),
    setItem: (k, v) => (broken ? deny() : store.set(k, String(v))),
  };
}

test('key: the list lives under riptide.highscore.v1 and the old single key is the one migrated from', () => {
  assert.equal(SCORES_KEY, 'riptide.highscore.v1');
  assert.equal(HIGH_SCORE_KEY, 'riptide-rush.highScore');
  assert.equal(TOP_N, 5);
});

test('entries: a run needs a positive whole score; missing fields become null, not invented values', () => {
  assert.equal(normalizeEntry(null), null);
  assert.equal(normalizeEntry({ score: 0 }), null);
  assert.equal(normalizeEntry({ score: -5 }), null);
  assert.equal(normalizeEntry({ score: 12.5 }), null);
  assert.equal(normalizeEntry({ score: 'lots' }), null);
  assert.equal(normalizeEntry({ score: 1e12 }), null, 'an absurd score is corrupt');
  assert.deepEqual(normalizeEntry({ score: 900 }), {
    score: 900,
    wave: null,
    kills: null,
    peakCombo: null,
    chain: null,
    seconds: null,
    at: null,
  });
  const full = normalizeEntry({ score: '4200', wave: 7, kills: 30, peakCombo: 12, chain: 4, seconds: 61.6, at: 99 });
  assert.equal(full.score, 4200, 'a numeric string is read as its number');
  assert.equal(full.seconds, 62);
  assert.equal(normalizeEntry({ score: 10, wave: -1, kills: 2.5 }).wave, null, 'a negative or fractional count is dropped');
});

test('normalize: keeps the five best, highest first, and drops anything invalid', () => {
  const raw = [
    { score: 10 },
    { score: 500 },
    'junk',
    { score: 0 },
    { score: 70 },
    { score: 300 },
    { score: 900 },
    { score: 40 },
  ];
  const list = normalizeScores(raw);
  assert.deepEqual(
    list.map((e) => e.score),
    [900, 500, 300, 70, 40],
  );
  assert.deepEqual(normalizeScores('not a list'), []);
  assert.deepEqual(normalizeScores(null), []);
});

test('top score: the best on the list, or zero when there is none', () => {
  assert.equal(topScore([]), 0);
  assert.equal(topScore(normalizeScores([{ score: 30 }, { score: 80 }])), 80);
});

test('round trip: a missing wave, combo or time stays missing across saves, and is never read back as zero', () => {
  const s = stubStorage();
  saveScores(s, [{ score: 600 }]); // a migrated run: every other field is null
  const once = loadScores(s);
  assert.equal(once[0].seconds, null);
  saveScores(s, once); // the next save writes the nulls back out
  const twice = loadScores(s);
  assert.equal(twice[0].seconds, null, 'a saved null must not come back as 0');
  assert.equal(twice[0].at, null);
  assert.equal(twice[0].wave, null);
});

test('load: a saved list round-trips through save and load', () => {
  const s = stubStorage();
  saveScores(s, [{ score: 2000, wave: 5 }, { score: 1000, wave: 2 }]);
  const back = loadScores(s);
  assert.deepEqual(back.map((e) => [e.score, e.wave]), [[2000, 5], [1000, 2]]);
});

test('migration: the old single high score moves into the list on first read and is saved there', () => {
  const s = stubStorage({ [HIGH_SCORE_KEY]: '4200' });
  const list = loadScores(s);
  assert.deepEqual(list.map((e) => e.score), [4200]);
  assert.equal(list[0].wave, null, 'the migrated run has no wave, and says so');
  const saved = JSON.parse(s.store.get(SCORES_KEY));
  assert.equal(saved[0].score, 4200, 'the migration is written, so the next read finds the list');
  assert.equal(s.store.get(HIGH_SCORE_KEY), '4200', 'the old key is left alone');
});

test('migration: a corrupt list falls back to the old single score', () => {
  const s = stubStorage({ [SCORES_KEY]: '{not json', [HIGH_SCORE_KEY]: '777' });
  assert.deepEqual(loadScores(s).map((e) => e.score), [777]);
});

test('migration: an old score that is zero or junk gives an empty list and writes nothing', () => {
  const s = stubStorage({ [HIGH_SCORE_KEY]: 'nope' });
  assert.deepEqual(loadScores(s), []);
  assert.equal(s.store.has(SCORES_KEY), false);
});

test('a list that is already there wins over the old single score', () => {
  const s = stubStorage({ [SCORES_KEY]: JSON.stringify([{ score: 300 }]), [HIGH_SCORE_KEY]: '9999' });
  assert.deepEqual(loadScores(s).map((e) => e.score), [300]);
});

test('blocked storage: loading gives an empty list, and saving does not throw', () => {
  const s = stubStorage({}, true);
  assert.deepEqual(loadScores(s), []);
  assert.doesNotThrow(() => saveScores(s, [{ score: 5 }]));
  assert.deepEqual(loadScores(null), [], 'no storage at all is also empty');
});

test('record: a run that beats the top score is a new best and takes rank 0', () => {
  const before = normalizeScores([{ score: 500 }, { score: 300 }]);
  const r = recordRun(before, { score: 900, wave: 9 });
  assert.equal(r.rank, 0);
  assert.equal(r.newBest, true);
  assert.deepEqual(r.scores.map((e) => e.score), [900, 500, 300]);
});

test('record: a run below the top score is ranked where it falls, and is not a new best', () => {
  const before = normalizeScores([{ score: 900 }, { score: 500 }, { score: 300 }]);
  const r = recordRun(before, { score: 400 });
  assert.equal(r.rank, 2);
  assert.equal(r.newBest, false);
  assert.deepEqual(r.scores.map((e) => e.score), [900, 500, 400, 300]);
});

test('record: a sixth-place run does not make the list and reports rank -1', () => {
  const before = normalizeScores([{ score: 500 }, { score: 400 }, { score: 300 }, { score: 200 }, { score: 100 }]);
  const r = recordRun(before, { score: 50 });
  assert.equal(r.rank, -1);
  assert.equal(r.newBest, false);
  assert.equal(r.scores.length, TOP_N);
  assert.deepEqual(r.scores.map((e) => e.score), [500, 400, 300, 200, 100]);
});

test('record: a run that enters a full list pushes the lowest one off', () => {
  const before = normalizeScores([{ score: 500 }, { score: 400 }, { score: 300 }, { score: 200 }, { score: 100 }]);
  const r = recordRun(before, { score: 250 });
  assert.equal(r.rank, 3);
  assert.deepEqual(r.scores.map((e) => e.score), [500, 400, 300, 250, 200]);
});

test('record: on a tie the earlier run keeps its place, and a tied new best is not a new best', () => {
  const before = normalizeScores([{ score: 700, at: 1 }]);
  const r = recordRun(before, { score: 700, at: 2 });
  assert.equal(r.rank, 1, 'the new run sits behind the equal one');
  assert.equal(r.newBest, false, 'matching the best is not beating it');
  assert.equal(r.scores[0].at, 1);
});

test('record: the first run ever is a new best if it scored, and a zero run is not recorded', () => {
  const first = recordRun([], { score: 120 });
  assert.equal(first.newBest, true);
  assert.equal(first.rank, 0);
  const zero = recordRun([], { score: 0 });
  assert.equal(zero.rank, -1);
  assert.equal(zero.newBest, false);
  assert.deepEqual(zero.scores, []);
});
