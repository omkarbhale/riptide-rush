// Wave script for Riptide Rush. Pure data and functions: no DOM, no window, no game state.
// Source: docs/design/enemies-and-waves.md, Part 3.1 (waves 1-20) and Part 3.2 (beyond 20).
// Only the kinds that exist in the simulation are scripted: drifter, spitter, charger, shellback,
// splitter, mine. The design's puffer, shield bearer, lobber, eel and boss rows are dropped, so some
// waves are smaller than the design table. Splitter minis are not scripted; the splitter makes them.

export const SCRIPTED_KINDS = ['drifter', 'spitter', 'charger', 'shellback', 'splitter', 'mine'];

export const LAST_TABLE_WAVE = 20;

// One row per wave 1-20. `release` marks the design's release waves (3, 5, 9, 11, 15, 18).
// `cadence` is the seconds between spawn groups. Counts are the number of enemies of each kind.
export const WAVE_TABLE = [
  { wave: 1, intensity: 1, release: false, cadence: 3.0, counts: { drifter: 10 } },
  { wave: 2, intensity: 2, release: false, cadence: 2.5, counts: { drifter: 14, spitter: 1 } },
  { wave: 3, intensity: 2, release: true, cadence: 1.8, counts: { drifter: 12 } },
  { wave: 4, intensity: 4, release: false, cadence: 2.2, counts: { drifter: 10, spitter: 2, charger: 1 } },
  { wave: 5, intensity: 3, release: true, cadence: 2.5, counts: { drifter: 12, splitter: 2 } },
  { wave: 6, intensity: 5, release: false, cadence: 2.0, counts: { drifter: 14, charger: 2 } },
  { wave: 7, intensity: 4, release: false, cadence: 2.0, counts: { drifter: 16, mine: 3 } },
  { wave: 8, intensity: 6, release: false, cadence: 2.0, counts: { drifter: 12, spitter: 2, shellback: 2 } },
  { wave: 9, intensity: 5, release: true, cadence: 1.6, counts: { drifter: 18 } },
  { wave: 10, intensity: 8, release: false, cadence: 2.0, counts: { drifter: 12, splitter: 2 } },
  { wave: 11, intensity: 3, release: true, cadence: 1.8, counts: { drifter: 16, spitter: 2 } },
  { wave: 12, intensity: 6, release: false, cadence: 1.8, counts: { drifter: 12 } },
  { wave: 13, intensity: 6, release: false, cadence: 2.0, counts: { drifter: 8, shellback: 1 } },
  { wave: 14, intensity: 7, release: false, cadence: 2.0, counts: { charger: 2 } },
  { wave: 15, intensity: 4, release: true, cadence: 1.4, counts: { drifter: 20 } },
  { wave: 16, intensity: 7, release: false, cadence: 2.0, counts: { splitter: 2, mine: 4 } },
  { wave: 17, intensity: 8, release: false, cadence: 1.8, counts: { charger: 3, shellback: 2 } },
  { wave: 18, intensity: 5, release: true, cadence: 1.4, counts: { drifter: 22, spitter: 2 } },
  { wave: 19, intensity: 9, release: false, cadence: 1.6, counts: { charger: 3, splitter: 3, mine: 4 } },
  { wave: 20, intensity: 10, release: false, cadence: 1.5, counts: { drifter: 12, spitter: 2, charger: 2, shellback: 2 } },
];

// Point cost per enemy, from Part 3.2. The boss (25 points) is not in the script.
export const POINT_COSTS = { drifter: 1, mine: 1, spitter: 2, splitter: 3, charger: 3, shellback: 5 };

// How a wave beyond 20 splits its point budget between kinds. Leftover points go to drifters.
const BEYOND_SHARES = { drifter: 0.35, spitter: 0.15, charger: 0.15, mine: 0.1, splitter: 0.15, shellback: 0.1 };

const RELEASE_BUDGET_SHARE = 0.6;
const BUDGET_CAP = 120;

function tableRow(wave) {
  return WAVE_TABLE[wave - 1];
}

// Release waves beyond 20 are every 5th wave. Every 10th wave is a boss wave in the design; with no
// boss in the sim those waves stay tension waves, so only the 5-mod-10 waves are release waves.
export function isReleaseWave(wave) {
  if (wave <= LAST_TABLE_WAVE) return tableRow(wave).release;
  return wave % 5 === 0 && wave % 10 !== 0;
}

// Point budget for a wave beyond 20: min(120, 60 + 3k), k = wave - 20.
export function budgetFor(wave) {
  const k = Math.max(0, wave - LAST_TABLE_WAVE);
  return Math.min(BUDGET_CAP, 60 + 3 * k);
}

// Seconds between spawn groups. Beyond 20: max(1.2, 3.0 - 0.05k).
export function cadenceFor(wave) {
  if (wave <= LAST_TABLE_WAVE) return tableRow(wave).cadence;
  const k = wave - LAST_TABLE_WAVE;
  return Math.max(1.2, 3.0 - 0.05 * k);
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
  for (const kind of SCRIPTED_KINDS) {
    const n = Math.floor((budget * BEYOND_SHARES[kind]) / POINT_COSTS[kind]);
    counts[kind] = n;
    spent += n * POINT_COSTS[kind];
  }
  counts.drifter += budget - spent; // every leftover point buys one Drifter
  return counts;
}

// The wave's spawn plan: kinds interleaved round-robin, then chunked into groups of 2 or 3.
export function planWave(wave) {
  const counts = countsFor(wave);
  const left = SCRIPTED_KINDS.map((kind) => ({ kind, n: counts[kind] }));
  const order = [];
  let more = true;
  while (more) {
    more = false;
    for (const q of left) {
      if (q.n > 0) {
        order.push(q.kind);
        q.n -= 1;
        more = true;
      }
    }
  }
  const groups = [];
  for (let i = 0; i < order.length; ) {
    const remaining = order.length - i;
    const size = remaining === 4 ? 2 : Math.min(3, remaining);
    groups.push(order.slice(i, i + size));
    i += size;
  }
  return {
    wave,
    release: isReleaseWave(wave),
    cadence: cadenceFor(wave),
    counts,
    groups,
  };
}

// Flattens a plan into the sim's spawn queue. Each entry is one enemy, and `gap` is the seconds the
// sim waits after releasing it before releasing the next. Enemies inside a group have gap 0; the
// last enemy of a group waits the cadence.
export function spawnQueue(plan) {
  const queue = [];
  plan.groups.forEach((group) => {
    group.forEach((kind, i) => {
      const last = i === group.length - 1;
      queue.push({ kind, gap: last ? plan.cadence : 0 });
    });
  });
  return queue;
}
