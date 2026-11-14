// Wave script for Riptide Rush. Pure data and functions: no DOM, no window, no game state.
// Source: docs/design/enemies-and-waves.md, Part 3.1 (waves 1-20) and Part 3.2 (beyond 20).
// Scripted kinds: drifter, spitter, charger, shellback, splitter, mine, and (#114) puffer, shieldbearer,
// inksquid, phaseeel and the warden boss. The second round enters one kind at a time from wave 10 at
// low counts; no existing kind's count changes. Splitter minis are not scripted; the splitter makes them.
//
// A wave is released as schools (#97). A school is one spawn: Drifters come in schools of 4-8 that
// swim in a formation (line, wedge or ring), and every other kind comes alone (a school of one).
// `cadence` is the seconds between one school's release and the next.

import { SPAWN } from './config.js';

export const SCRIPTED_KINDS = [
  'drifter',
  'spitter',
  'charger',
  'shellback',
  'splitter',
  'mine',
  'puffer',
  'shieldbearer',
  'inksquid',
  'phaseeel',
  'warden',
];

// The boss each boss wave holds for (#114). A boss wave ends when its boss dies.
export const BOSS_WAVES = Object.freeze({ 10: 'warden', 20: 'warden' });

// Kinds that only the table scripts: past wave 20 the budget never buys them.
const TABLE_ONLY_KINDS = ['puffer', 'shieldbearer', 'inksquid', 'phaseeel', 'warden'];

export const LAST_TABLE_WAVE = 20;

// One row per wave 1-20. `release` marks the design's release waves (3, 5, 9, 11, 15, 18).
// Counts are the number of enemies of each kind.
export const WAVE_TABLE = [
  { wave: 1, intensity: 1, release: false, cadence: 0.70, counts: { drifter: 16 } },
  { wave: 2, intensity: 2, release: false, cadence: 0.20, counts: { drifter: 24, spitter: 1 } },
  { wave: 3, intensity: 2, release: true, cadence: 0.20, counts: { drifter: 150 } },
  { wave: 4, intensity: 4, release: false, cadence: 0.20, counts: { drifter: 180, spitter: 2, charger: 1 } },
  { wave: 5, intensity: 3, release: true, cadence: 0.20, counts: { drifter: 180, splitter: 2 } },
  { wave: 6, intensity: 5, release: false, cadence: 0.20, counts: { drifter: 210, charger: 2 } },
  { wave: 7, intensity: 4, release: false, cadence: 0.20, counts: { drifter: 210, mine: 3 } },
  { wave: 8, intensity: 6, release: false, cadence: 0.20, counts: { drifter: 210, spitter: 2, shellback: 2 } },
  { wave: 9, intensity: 5, release: true, cadence: 0.20, counts: { drifter: 240 } },
  { wave: 10, intensity: 8, release: false, cadence: 0.20, counts: { drifter: 210, splitter: 2, shellback: 2 , warden: 1} },
  { wave: 11, intensity: 3, release: true, cadence: 0.20, counts: { drifter: 210, spitter: 2, charger: 2 } },
  { wave: 12, intensity: 6, release: false, cadence: 0.20, counts: { drifter: 210, shellback: 1 , puffer: 2} },
  { wave: 13, intensity: 6, release: false, cadence: 0.20, counts: { drifter: 180, shellback: 2, spitter: 1 , shieldbearer: 1} },
  { wave: 14, intensity: 7, release: false, cadence: 0.20, counts: { drifter: 180, charger: 4 , inksquid: 1} }, // #88: was two chargers
  { wave: 15, intensity: 4, release: true, cadence: 0.20, counts: { drifter: 240, shellback: 2 } },
  { wave: 16, intensity: 7, release: false, cadence: 0.20, counts: { drifter: 150, splitter: 2, mine: 4, spitter: 1 , phaseeel: 1} },
  { wave: 17, intensity: 8, release: false, cadence: 0.20, counts: { drifter: 180, charger: 4, shellback: 4 } },
  { wave: 18, intensity: 5, release: true, cadence: 0.20, counts: { drifter: 240, spitter: 3, shellback: 2 } },
  { wave: 19, intensity: 9, release: false, cadence: 0.20, counts: { drifter: 150, charger: 4, splitter: 3, spitter: 3, mine: 4 } },
  { wave: 20, intensity: 10, release: false, cadence: 0.20, counts: { drifter: 210, spitter: 3, charger: 3, shellback: 4 , warden: 1} },
];

// Point cost per enemy, from Part 3.2.
// The #114 kinds carry their design costs (Part 3.2) so every kind has one. The budget past wave 20 never
// buys them (TABLE_ONLY_KINDS), so their counts there are zero.
export const POINT_COSTS = {
  drifter: 1,
  mine: 1,
  spitter: 2,
  splitter: 3,
  charger: 3,
  shellback: 5,
  puffer: 2,
  shieldbearer: 4,
  inksquid: 3,
  phaseeel: 4,
  warden: 25,
};

// How a wave beyond 20 splits its point budget between kinds. Leftover points go to drifters.
const BEYOND_SHARES = { drifter: 0.6, spitter: 0.12, charger: 0.08, mine: 0.02, splitter: 0.06, shellback: 0.12 };

const RELEASE_BUDGET_SHARE = 0.6;
const CADENCE_BEYOND = 0.20;
// Budget growth past wave 20. It has no cap, so the wave keeps scaling (#97); the entity cap still holds.
const BUDGET_BASE = 120;
const BUDGET_PER_WAVE = 12;

export const FORMATIONS = Object.freeze(['line', 'wedge', 'ring']);

function tableRow(wave) {
  return WAVE_TABLE[wave - 1];
}

// Release waves beyond 20 are every 5th wave. Every 10th wave is a boss wave in the design; with no
// boss in the sim those waves stay tension waves, so only the 5-mod-10 waves are release waves.
export function isReleaseWave(wave) {
  if (wave <= LAST_TABLE_WAVE) return tableRow(wave).release;
  return wave % 5 === 0 && wave % 10 !== 0;
}

// Point budget for a wave beyond 20: 60 + 9k, where k = wave - 20. Uncapped (#97: keeps scaling).
export function budgetFor(wave) {
  const k = Math.max(0, wave - LAST_TABLE_WAVE);
  return BUDGET_BASE + BUDGET_PER_WAVE * k;
}

// Seconds between school releases. Beyond 20 it stays at the table's fast cadence (#105: the crowd comes from
// a quick supply of schools, held near the crowd target by the director).
export function cadenceFor(wave) {
  if (wave <= LAST_TABLE_WAVE) return tableRow(wave).cadence;
  return CADENCE_BEYOND;
}

// Enemy counts for a wave, every scripted kind present (zero when absent).
export function countsFor(wave) {
  const counts = {};
  if (wave <= LAST_TABLE_WAVE) {
    for (const kind of SCRIPTED_KINDS) counts[kind] = tableRow(wave).counts[kind] ?? 0;
    return counts;
  }
  const scale = isReleaseWave(wave) ? RELEASE_BUDGET_SHARE : 1;
  const budget = Math.floor(budgetFor(wave) * scale);
  let spent = 0;
  for (const kind of TABLE_ONLY_KINDS) counts[kind] = 0;
  for (const kind of Object.keys(BEYOND_SHARES)) {
    const n = Math.floor((budget * BEYOND_SHARES[kind]) / POINT_COSTS[kind]);
    counts[kind] = n;
    spent += n * POINT_COSTS[kind];
  }
  counts.drifter += budget - spent; // every leftover point buys one Drifter
  return counts;
}

// Largest school a wave releases: 4 at wave 1, one more every schoolCapGrowEvery waves, capped at schoolMax.
export function schoolCapFor(wave) {
  return Math.min(SPAWN.schoolMax, SPAWN.schoolMin + Math.floor((Math.max(1, wave) - 1) / SPAWN.schoolCapGrowEvery));
}

// Simultaneous caps for the shooting and lunging kinds (#105). Spitters: 2 early, one more every
// spitterCapGrowEvery waves, up to spitterCapMax (5 late). Chargers: 2 early, up to 4.
export function spitterCapFor(wave) {
  return Math.min(SPAWN.spitterCapMax, SPAWN.spitterCapStart + Math.floor((Math.max(1, wave) - 1) / SPAWN.spitterCapGrowEvery));
}

export function chargerCapFor(wave) {
  return Math.min(SPAWN.chargerCapMax, SPAWN.chargerCapStart + Math.floor((Math.max(1, wave) - 1) / SPAWN.chargerCapGrowEvery));
}

// The crowd director's target: live Drifters (alive plus warned) a school may not push past (#105).
export function crowdTargetFor(wave) {
  return Math.min(SPAWN.crowdMax, SPAWN.crowdBase + SPAWN.crowdPerWave * (Math.max(1, wave) - 1));
}

// Splits n Drifters into schools. Every school holds schoolMin..schoolMax (a remainder under schoolMin
// is a school of its own), and sizes differ by at most one. Sizes sum to n.
export function chunkSchools(n, cap = SPAWN.schoolMax, schoolMin = SPAWN.schoolMin) {
  if (n <= 0) return [];
  if (n < schoolMin) return [n];
  let k = Math.ceil(n / cap);
  if (Math.floor(n / k) < schoolMin) k = Math.floor(n / schoolMin);
  const base = Math.floor(n / k);
  const extra = n % k;
  const sizes = [];
  for (let i = 0; i < k; i++) sizes.push(i < extra ? base + 1 : base);
  return sizes;
}

// The wave's school plan. Kinds are interleaved round-robin, school by school, so a Spitter is never
// first in a wave: the sim also holds the first Spitter until the Drifter schools are cleared.
export function planWave(wave) {
  const counts = countsFor(wave);
  const cap = schoolCapFor(wave);
  const lists = SCRIPTED_KINDS.map((kind) => {
    if (kind === 'drifter') return chunkSchools(counts.drifter, cap).map((size) => ({ kind, size }));
    return Array.from({ length: counts[kind] }, () => ({ kind, size: 1 }));
  });
  const schools = [];
  let more = true;
  for (let i = 0; more; i++) {
    more = false;
    for (const list of lists) {
      if (i < list.length) {
        schools.push(list[i]);
        more = true;
      }
    }
  }
  return {
    wave,
    release: isReleaseWave(wave),
    boss: BOSS_WAVES[wave] ?? null,
    cadence: cadenceFor(wave),
    counts,
    schoolCap: cap,
    schools,
  };
}

// Offsets of a formation's members from its centre, in the school's own frame: x points forward (at Rip),
// y is lateral. The sim rotates them to the school's heading. Shapes: a line across the front, a wedge
// with the leader in front, and a ring. Consecutive members sit `spacing` px apart.
export function formationOffsets(shape, n, spacing) {
  const out = [];
  for (let i = 0; i < n; i++) {
    if (shape === 'line') {
      out.push({ x: 0, y: (i - (n - 1) / 2) * spacing });
    } else if (shape === 'wedge') {
      if (i === 0) {
        out.push({ x: 0, y: 0 });
      } else {
        const rank = Math.ceil(i / 2);
        const side = i % 2 === 1 ? 1 : -1;
        out.push({ x: -rank * spacing * 0.9, y: side * rank * spacing * 0.7 });
      }
    } else {
      const r = Math.max(spacing, (n * spacing) / (2 * Math.PI));
      const a = (2 * Math.PI * i) / n;
      out.push({ x: r * Math.cos(a), y: r * Math.sin(a) });
    }
  }
  return out;
}
