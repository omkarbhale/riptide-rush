// Top-five local high scores: pure storage with validation, and a one-time migration from the single
// high-score key the game used before (HIGH_SCORE_KEY in config.js). Nothing here touches window or document
// at import time. The caller passes the storage object (window.localStorage in the game, a stub in tests),
// so `node --test` runs every function directly.
import { HIGH_SCORE_KEY } from './config.js';

// Issue #37: the list lives under its own versioned key. The old single value is read once, then left alone.
export const SCORES_KEY = 'riptide.highscore.v1';
export const TOP_N = 5;

const MAX_SCORE = 1e9; // above this a record is corrupt, not a run
const MAX_WAVE = 999;

const countOrNull = (v, max = 1e9) => (Number.isInteger(v) && v >= 0 && v <= max ? v : null);

// A stored field as a number. null, undefined and '' are missing, not zero: Number(null) is 0, which would turn a
// saved null into a real 0 on the next read.
const num = (v) => (v === null || v === undefined || v === '' ? NaN : Number(v));

// One stored run. A field a run does not carry (the migrated single score has no wave, combo or time) is
// null, and the table shows it as a dash rather than inventing a value. Anything that is not a positive
// whole score is dropped.
export function normalizeEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const score = num(raw.score);
  if (!Number.isInteger(score) || score <= 0 || score > MAX_SCORE) return null;
  const seconds = num(raw.seconds);
  const at = num(raw.at);
  return {
    score,
    wave: countOrNull(raw.wave, MAX_WAVE),
    kills: countOrNull(raw.kills),
    peakCombo: countOrNull(raw.peakCombo),
    chain: countOrNull(raw.chain),
    seconds: Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds) : null,
    at: Number.isFinite(at) && at >= 0 ? at : null,
  };
}

// A list of runs, cleaned: invalid entries removed, highest score first, at most TOP_N. Ties keep their order.
export function normalizeScores(raw) {
  if (!Array.isArray(raw)) return [];
  const entries = raw.map(normalizeEntry).filter((e) => e !== null);
  entries.sort((a, b) => b.score - a.score);
  return entries.slice(0, TOP_N);
}

// The best score on the list, or 0 when there is none.
export function topScore(list) {
  return list && list.length > 0 ? list[0].score : 0;
}

function readLegacyScore(storage) {
  try {
    const text = storage ? storage.getItem(HIGH_SCORE_KEY) : null;
    return text === null ? 0 : Number(text) || 0;
  } catch {
    return 0;
  }
}

// Reads the top five. A missing or unreadable list is rebuilt from the old single high score, if there was one,
// and that migrated list is saved at once, so the best score survives the change. Blocked storage gives [].
export function loadScores(storage) {
  let list = null; // stays null unless a readable list record was found
  try {
    const text = storage ? storage.getItem(SCORES_KEY) : null;
    if (text !== null) {
      const raw = JSON.parse(text);
      if (Array.isArray(raw)) list = normalizeScores(raw);
    }
  } catch {
    list = null;
  }
  if (list !== null) return list;
  const migrated = normalizeScores([{ score: readLegacyScore(storage) }]);
  if (migrated.length > 0) saveScores(storage, migrated);
  return migrated;
}

export function saveScores(storage, list) {
  try {
    if (storage) storage.setItem(SCORES_KEY, JSON.stringify(normalizeScores(list)));
  } catch {
    // Storage can be blocked; the top five then lasts for this page only.
  }
}

// Puts a finished run on the list. `rank` is its place (0 is the top) or -1 when it did not make the top five.
// `newBest` is true when it beats the previous top score and scored at all.
export function recordRun(list, run) {
  const before = normalizeScores(list);
  const entry = normalizeEntry(run);
  if (!entry) return { scores: before, rank: -1, newBest: false };
  const prevTop = topScore(before);
  // Insert after any equal score, so an earlier run keeps its place on a tie.
  let at = before.findIndex((e) => e.score < entry.score);
  if (at === -1) at = before.length;
  if (at >= TOP_N) return { scores: before, rank: -1, newBest: false };
  const scores = [...before.slice(0, at), entry, ...before.slice(at)].slice(0, TOP_N);
  return { scores, rank: at, newBest: entry.score > prevTop };
}
