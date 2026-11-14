// Mode logic for Riptide Rush: the mode table, the Daily Tide seed and mutator, the spoiler-free share string,
// and per-mode best storage. Pure: no DOM, no window at import time. Storage functions take any object with
// getItem/setItem (or null) and never throw, so blocked or missing localStorage gives the defaults.
// Spec: docs/design/replayability.md §5.1 (Daily Tide), §5.2 (challenges); issues #115, #116; task #124.
import { loadScores, topScore } from './scores.js';

export const MODE_KEY = 'riptide.mode.v1';
export const CHALLENGE_KEY = 'riptide.challenges.v1';
export const DAILY_KEY = 'riptide.daily.v1';
// Daily records kept, by date. Older dates are dropped.
export const DAILY_KEEP = 30;

// Rule overrides a mode applies through createGame(seed, { rules }). Keys not listed keep the config values
// (see DEFAULT_RULES in game.js). `pulse: false` disables Pulse input, reflection and stagger.
export const MODES = Object.freeze({
  classic: Object.freeze({ id: 'classic', key: '1', name: 'Classic', rules: Object.freeze({}) }),
  daily: Object.freeze({ id: 'daily', key: '2', name: 'Daily Tide', rules: Object.freeze({}) }),
  'one-life': Object.freeze({ id: 'one-life', key: '3', name: 'One Life', rules: Object.freeze({ maxHp: 1 }) }),
  'no-pulse': Object.freeze({ id: 'no-pulse', key: '4', name: 'No Pulse', rules: Object.freeze({ pulse: false }) }),
});
export const MODE_IDS = Object.freeze(['classic', 'daily', 'one-life', 'no-pulse']);
export const CHALLENGE_IDS = Object.freeze(['one-life', 'no-pulse']);

// The daily mutator is MUTATORS[seed % 3]. Each keeps every telegraph (DESIGN §8).
export const MUTATORS = Object.freeze([
  Object.freeze({ id: 'swift-school', name: 'Swift School', rules: Object.freeze({ driftSpeedScale: 1.25 }) }),
  Object.freeze({ id: 'short-fuse', name: 'Short Fuse', rules: Object.freeze({ mineFuse: 0.4 }) }),
  Object.freeze({ id: 'thin-reserve', name: 'Thin Reserve', rules: Object.freeze({ maxCharges: 2 }) }),
]);

// Medal thresholds, as in replayability §5.4 (proposed). Shown on the daily share string.
export const MEDAL_MIN = Object.freeze({ bronze: 2000, silver: 6000, gold: 12000 });
const MEDAL_BLOCK = Object.freeze({ gold: '🟨', silver: '⬜', bronze: '🟫', none: '⬛' });
const MEDAL_FROM_BLOCK = Object.freeze({ '🟨': 'gold', '⬜': 'silver', '🟫': 'bronze', '⬛': 'none' });

export const SHARE_PREFIX = 'RIPTIDE RUSH';
const BAR_CELLS = 10;

export function isModeId(id) {
  return Object.prototype.hasOwnProperty.call(MODES, id);
}

// ---- daily seed --------------------------------------------------------------------------------

// The UTC calendar day as YYYY-MM-DD. Everyone on the same UTC day gets the same daily run.
export function utcDayKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

// FNV-1a, 32 bit. The seed for a day is the hash of its YYYY-MM-DD key.
export function fnv1a32(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h = (h ^ text.charCodeAt(i)) >>> 0;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function dailySeed(dayKey) {
  return fnv1a32(dayKey);
}

export function dailyMutator(seed) {
  return MUTATORS[seed % MUTATORS.length];
}

// The seed a run starts with: the day's seed for Daily Tide, the caller's random seed for every other mode.
export function seedFor(modeId, dayKey, randomSeed) {
  return modeId === 'daily' ? dailySeed(dayKey) : randomSeed;
}

// The rule overrides for one run. Daily Tide adds the day's mutator on top of the (empty) daily mode rules.
export function rulesFor(modeId, dayKey) {
  const mode = MODES[isModeId(modeId) ? modeId : 'classic'];
  if (mode.id !== 'daily') return { ...mode.rules };
  return { ...mode.rules, ...dailyMutator(dailySeed(dayKey)).rules };
}

// ---- share string ------------------------------------------------------------------------------

// 4812 -> "4,812"
export function formatScore(n) {
  return String(Math.max(0, Math.floor(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export function medalFor(score) {
  if (score >= MEDAL_MIN.gold) return 'gold';
  if (score >= MEDAL_MIN.silver) return 'silver';
  if (score >= MEDAL_MIN.bronze) return 'bronze';
  return 'none';
}

// The ten-cell wave bar, filled to min(wave, 10).
export function waveBar(wave) {
  const filled = Math.max(0, Math.min(BAR_CELLS, Math.floor(wave)));
  return '▮'.repeat(filled) + '▯'.repeat(BAR_CELLS - filled);
}

// One line, spoiler-free: the date, score, wave, peak combo, medal and mutator. It holds no seed input.
// Example: RIPTIDE RUSH 2026-11-14 · 4,812 · wave 9 ▮▮▮▮▮▮▮▮▮▯ · combo 23 · 🟨 · Short Fuse
export function encodeShare({ dayKey, score, wave, combo, mutatorName }) {
  const medal = MEDAL_BLOCK[medalFor(score)];
  return [
    `${SHARE_PREFIX} ${dayKey}`,
    formatScore(score),
    `wave ${wave} ${waveBar(wave)}`,
    `combo ${combo}`,
    medal,
    mutatorName,
  ].join(' · ');
}

const SHARE_RE = /^RIPTIDE RUSH (\d{4}-\d{2}-\d{2}) · ([\d,]+) · wave (\d+) [▮▯]{10} · combo (\d+) · (🟨|⬜|🟫|⬛) · (.+)$/u;

// The inverse of encodeShare. Returns null for anything that is not a share line.
export function decodeShare(text) {
  const m = SHARE_RE.exec(String(text ?? '').trim());
  if (!m) return null;
  const mutatorName = m[6];
  if (!MUTATORS.some((mut) => mut.name === mutatorName)) return null;
  const score = Number(m[2].replace(/,/g, ''));
  return {
    dayKey: m[1],
    score,
    wave: Number(m[3]),
    combo: Number(m[4]),
    medal: MEDAL_FROM_BLOCK[m[5]],
    mutatorName,
  };
}

// The share line for one finished daily run.
export function dailyShareText(dayKey, run) {
  const mutator = dailyMutator(dailySeed(dayKey));
  return encodeShare({
    dayKey,
    score: run.score,
    wave: run.wave,
    combo: run.combo,
    mutatorName: mutator.name,
  });
}

// ---- storage -----------------------------------------------------------------------------------

function readJson(storage, key, fallback) {
  try {
    const raw = storage?.getItem(key);
    if (!raw) return fallback;
    const value = JSON.parse(raw);
    return value && typeof value === 'object' ? value : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(storage, key, value) {
  if (!storage) return false;
  try {
    storage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function loadMode(storage) {
  try {
    const raw = storage?.getItem(MODE_KEY);
    return isModeId(raw) ? raw : 'classic';
  } catch {
    return 'classic';
  }
}

export function saveMode(storage, modeId) {
  if (!storage || !isModeId(modeId)) return false;
  try {
    storage.setItem(MODE_KEY, modeId);
    return true;
  } catch {
    return false;
  }
}

// Classic's best is the top of the existing top-five list (scores.js), so there is no second key to keep in step.
export function loadClassicBest(storage) {
  return topScore(loadScores(storage));
}

function loadChallenges(storage) {
  return readJson(storage, CHALLENGE_KEY, {});
}

export function loadDaily(storage) {
  return readJson(storage, DAILY_KEY, {});
}

// The daily entry for one date: { official: {score, wave, combo} | null, plays }.
export function dailyEntry(storage, dayKey) {
  const entry = loadDaily(storage)[dayKey];
  if (!entry || typeof entry !== 'object') return { official: null, plays: 0 };
  return { official: entry.official ?? null, plays: Number(entry.plays) || 0 };
}

// The number shown as a mode's best: Classic's best score, a challenge's best score, or the day's official score.
export function bestScore(storage, modeId, dayKey) {
  if (modeId === 'classic') return loadClassicBest(storage);
  if (modeId === 'daily') return dailyEntry(storage, dayKey).official?.score ?? 0;
  if (CHALLENGE_IDS.includes(modeId)) return Number(loadChallenges(storage)[modeId]?.best) || 0;
  return 0;
}

// Records a finished run for the modes that keep their own best and returns what it counted as. A challenge
// run is compared with that mode's own best and never touches another mode's. Daily Tide records one official
// attempt per UTC day: the first finished run. Later runs that day are practice and do not change the record.
// Classic runs go onto the top-five list in main.js (scores.js), so this does nothing for Classic.
// run: { score, wave, combo }. Returns { newBest, official, best }.
export function recordModeRun(storage, modeId, dayKey, run) {
  const score = Math.max(0, Math.floor(Number(run.score) || 0));
  const wave = Math.max(0, Math.floor(Number(run.wave) || 0));
  const combo = Math.max(0, Math.floor(Number(run.combo) || 0));

  if (modeId === 'daily') {
    const all = loadDaily(storage);
    const entry = { official: null, plays: 0, ...(all[dayKey] ?? {}) };
    entry.plays = (Number(entry.plays) || 0) + 1;
    const first = !entry.official;
    if (first) entry.official = { score, wave, combo };
    all[dayKey] = entry;
    const kept = Object.keys(all).sort().slice(-DAILY_KEEP);
    const pruned = {};
    for (const k of kept) pruned[k] = all[k];
    writeJson(storage, DAILY_KEY, pruned);
    return { newBest: first, official: first, best: entry.official.score };
  }

  if (CHALLENGE_IDS.includes(modeId)) {
    const all = loadChallenges(storage);
    const prev = Number(all[modeId]?.best) || 0;
    const newBest = score > prev;
    if (newBest) {
      all[modeId] = { best: score, wave };
      writeJson(storage, CHALLENGE_KEY, all);
    }
    return { newBest, official: false, best: Math.max(prev, score) };
  }

  return { newBest: false, official: false, best: loadClassicBest(storage) };
}
