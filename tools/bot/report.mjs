// Aggregates per-run metrics (sim-run.mjs) into per-policy statistics and renders them as Markdown.
// Pure functions: no I/O here, so the report can be tested and re-rendered from saved JSON.

export function percentile(sorted, p) {
  if (sorted.length === 0) return NaN;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))));
  return sorted[i];
}

export function summarize(values) {
  const s = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  const mean = s.length ? s.reduce((a, b) => a + b, 0) / s.length : NaN;
  return {
    n: s.length,
    min: s[0] ?? NaN,
    p10: percentile(s, 0.1),
    p25: percentile(s, 0.25),
    p50: percentile(s, 0.5),
    p75: percentile(s, 0.75),
    p90: percentile(s, 0.9),
    max: s[s.length - 1] ?? NaN,
    mean,
  };
}

const BUCKETS = ['no dash yet', '0-0.2s', '0.2-0.5s', 'later'];
const TYPES = ['drifter', 'spitter', 'charger', 'shellback', 'splitter', 'mini', 'mine', 'unknown'];

function add(map, key, n = 1) {
  map[key] = (map[key] ?? 0) + n;
}

function share(n, total) {
  return total > 0 ? n / total : 0;
}

// Per-policy aggregate of a list of run metrics.
export function aggregatePolicy(runs) {
  const hitsByType = {};
  const hitsByBucket = {};
  const hitsByTypeBucket = {};
  const hitsAfterDeflectByType = {};
  const bucketSeconds = { 'no dash yet': 0, '0-0.2s': 0, '0.2-0.5s': 0, later: 0 };
  let hitsSameStep = 0;
  let hitsAfterDeflect = 0;
  const killsByCause = {};
  const killsByType = {};
  const killsByTypeCause = {};
  const violations = {};
  const observations = {};
  let dashes = 0;
  let dashesWithKill = 0;
  let dashKills = 0;
  let pulses = 0;
  let perfectPulses = 0;
  let deflects = 0;
  let hits = 0;
  let totalSeconds = 0;
  let totalSteps = 0;
  let stepsNoEnemyNear = 0;
  let stepsIdleFull = 0;
  let survivedToCap = 0;
  let died = 0;
  const apm = [];
  const waves = {};

  for (const r of runs) {
    dashes += r.dashes;
    dashesWithKill += r.dashesWithKill;
    pulses += r.pulses;
    perfectPulses += r.perfectPulses;
    deflects += r.deflects;
    totalSeconds += r.time;
    totalSteps += r.steps;
    for (const b of Object.keys(bucketSeconds)) bucketSeconds[b] += r.bucketSeconds[b];
    stepsNoEnemyNear += r.stepsNoEnemyNear;
    stepsIdleFull += r.stepsIdleFull;
    if (r.survivedToCap) survivedToCap += 1;
    if (r.died) died += 1;
    if (r.time > 0) apm.push(((r.dashes + r.pulses) * 60) / r.time);
    for (const [k, n] of Object.entries(r.killsByCause)) add(killsByCause, k, n);
    for (const [k, n] of Object.entries(r.killsByType)) add(killsByType, k, n);
    for (const [k, n] of Object.entries(r.killsByTypeCause)) add(killsByTypeCause, k, n);
    dashKills += r.killsByCause.dash ?? 0;

    for (const h of r.hits) {
      hits += 1;
      add(hitsByType, h.type);
      add(hitsByBucket, h.bucket);
      add(hitsByTypeBucket, `${h.type}|${h.bucket}`);
      if (h.sameStep) hitsSameStep += 1;
      if (h.afterDeflect) {
        hitsAfterDeflect += 1;
        add(hitsAfterDeflectByType, h.type);
      }
    }

    for (const [code, v] of Object.entries(r.violations)) {
      const cur = violations[code] ?? { runs: 0, count: 0, sample: null };
      cur.runs += 1;
      cur.count += v.count;
      if (!cur.sample) cur.sample = { seed: r.seed, ...v.first };
      violations[code] = cur;
    }
    for (const [code, n] of Object.entries(r.observations)) {
      const cur = observations[code] ?? { runs: 0, count: 0 };
      cur.runs += 1;
      cur.count += n;
      observations[code] = cur;
    }

    for (const [wn, info] of Object.entries(r.waves)) {
      const w = (waves[wn] ??= { reached: 0, died: 0, cleared: 0, clearSeconds: [], hpLost: 0, hits: 0 });
      w.reached += 1;
      if (info.clearAt !== null) {
        w.cleared += 1;
        w.clearSeconds.push(info.clearAt - info.startAt);
      }
      w.hpLost += info.hpLost;
      if (r.died && Number(wn) === r.wave) w.died += 1;
    }
  }

  const waveRows = Object.keys(waves)
    .map(Number)
    .sort((a, b) => a - b)
    .map((wn) => {
      const w = waves[wn];
      const cs = summarize(w.clearSeconds);
      return {
        wave: wn,
        reached: w.reached,
        reachedShare: share(w.reached, runs.length),
        died: w.died,
        deathRate: share(w.died, w.reached),
        cleared: w.cleared,
        clearP50: cs.p50,
        clearP90: cs.p90,
        hpLostPerRun: share(w.hpLost, w.reached),
      };
    });

  return {
    runs: runs.length,
    survival: summarize(runs.map((r) => r.time)),
    survivedToCapShare: share(survivedToCap, runs.length),
    diedShare: share(died, runs.length),
    wave: summarize(runs.map((r) => r.wave)),
    score: summarize(runs.map((r) => r.score)),
    peakCombo: summarize(runs.map((r) => r.peakCombo)),
    apm: summarize(apm),
    apmPooled: totalSeconds > 0 ? ((dashes + pulses) * 60) / totalSeconds : NaN,
    noEnemyNearShare: share(stepsNoEnemyNear, totalSteps),
    idleFullShare: share(stepsIdleFull, totalSteps),
    dashesPerRun: share(dashes, runs.length),
    pulsesPerRun: share(pulses, runs.length),
    perfectPulses,
    deflects,
    dashes,
    dashKillsPerDash: share(dashKills, dashes),
    dashesWithKillShare: share(dashesWithKill, dashes),
    kills: summarize(runs.map((r) => r.kills)),
    killsByCause,
    killsByType,
    killsByTypeCause,
    hits,
    hitsByType,
    hitsByBucket,
    hitsByTypeBucket,
    hitsSameStep,
    hitsAfterDeflect,
    hitsAfterDeflectByType,
    bucketSeconds,
    waveRows,
    violations,
    observations,
  };
}

function f(v, digits = 1) {
  if (!Number.isFinite(v)) return 'n/a';
  return v.toFixed(digits);
}

function pct(v) {
  return `${(v * 100).toFixed(1)}%`;
}

function dist(s, digits = 1) {
  return `p10 ${f(s.p10, digits)} / p50 ${f(s.p50, digits)} / p90 ${f(s.p90, digits)} / max ${f(s.max, digits)} (mean ${f(s.mean, digits)})`;
}

// Markdown for one policy's aggregate.
export function renderPolicy(name, a) {
  const out = [];
  out.push(`### ${name} (${a.runs} runs)`);
  out.push('');
  out.push('| Metric | Value |');
  out.push('| --- | --- |');
  out.push(`| Survival, seconds | ${dist(a.survival)} |`);
  out.push(`| Died / survived to cap | ${pct(a.diedShare)} / ${pct(a.survivedToCapShare)} |`);
  out.push(`| Wave reached | ${dist(a.wave, 1)} |`);
  out.push(`| Score | ${dist(a.score, 0)} |`);
  out.push(`| Peak combo | ${dist(a.peakCombo, 0)} |`);
  out.push(`| Kills per run | ${dist(a.kills, 0)} |`);
  out.push(`| APM, dashes + pulses per minute (per run) | ${dist(a.apm, 1)}; pooled ${f(a.apmPooled, 1)} |`);
  out.push(`| Dashes per run / pulses per run | ${f(a.dashesPerRun, 1)} / ${f(a.pulsesPerRun, 1)} |`);
  out.push(`| Dash kill rate (dash kills per dash) | ${f(a.dashKillsPerDash, 2)} |`);
  out.push(`| Dashes that killed at least once | ${pct(a.dashesWithKillShare)} |`);
  out.push(`| Perfect pulses / deflected dashes (total) | ${a.perfectPulses} / ${a.deflects} |`);
  out.push(`| Time with no enemy within 250 px / with no enemy and full charges | ${pct(a.noEnemyNearShare)} / ${pct(a.idleFullShare)} |`);
  out.push('');
  out.push(`Hit points lost in total: ${a.hits}. In the same step a dash ended: ${a.hitsSameStep} (${pct(share(a.hitsSameStep, a.hits))}). Within 0.5 s of a deflected dash: ${a.hitsAfterDeflect} (${pct(share(a.hitsAfterDeflect, a.hits))}).`);
  out.push('');
  out.push('| Cause (enemy type) | Hits | Share |');
  out.push('| --- | --- | --- |');
  for (const t of TYPES) {
    const n = a.hitsByType[t] ?? 0;
    out.push(`| ${t} | ${n} | ${pct(share(n, a.hits))} |`);
  }
  out.push('');
  const totalBucketSeconds = Object.values(a.bucketSeconds).reduce((x, y) => x + y, 0);
  out.push('| Time since last dash ended | Hits | Share of hits | Share of time | Hits per 100 s in bucket |');
  out.push('| --- | --- | --- | --- | --- |');
  for (const b of BUCKETS) {
    const n = a.hitsByBucket[b] ?? 0;
    const sec = a.bucketSeconds[b] ?? 0;
    out.push(`| ${b} | ${n} | ${pct(share(n, a.hits))} | ${pct(share(sec, totalBucketSeconds))} | ${f(sec > 0 ? (100 * n) / sec : NaN, 2)} |`);
  }
  out.push('');
  out.push('| Enemy type x time since dash | 0-0.2 s | 0.2-0.5 s | later | no dash yet |');
  out.push('| --- | --- | --- | --- | --- |');
  for (const t of TYPES) {
    const cells = ['0-0.2s', '0.2-0.5s', 'later', 'no dash yet'].map((b) => a.hitsByTypeBucket[`${t}|${b}`] ?? 0);
    if (cells.every((c) => c === 0)) continue;
    out.push(`| ${t} | ${cells.join(' | ')} |`);
  }
  out.push('');
  out.push('| Kill (enemy:cause) | Count |');
  out.push('| --- | --- |');
  for (const [k, n] of Object.entries(a.killsByTypeCause).sort((x, y) => y[1] - x[1])) out.push(`| ${k} | ${n} |`);
  out.push('');
  out.push('| Wave | Reached | Died here | Death rate | Cleared | Clear s p50 / p90 | HP lost per run reaching |');
  out.push('| --- | --- | --- | --- | --- | --- | --- |');
  for (const w of a.waveRows) {
    out.push(
      `| ${w.wave} | ${w.reached} (${pct(w.reachedShare)}) | ${w.died} | ${pct(w.deathRate)} | ${w.cleared} | ${f(w.clearP50)} / ${f(w.clearP90)} | ${f(w.hpLostPerRun, 2)} |`,
    );
  }
  out.push('');
  if (Object.keys(a.violations).length === 0) {
    out.push('Invariant violations: none.');
  } else {
    out.push('| Invariant violation | Runs affected | Steps | First sample (seed, t, detail) |');
    out.push('| --- | --- | --- | --- |');
    for (const [code, v] of Object.entries(a.violations)) {
      out.push(`| ${code} | ${v.runs} | ${v.count} | seed ${v.sample.seed}, t ${v.sample.time}: ${v.sample.detail} |`);
    }
  }
  out.push('');
  if (Object.keys(a.observations).length > 0) {
    out.push('| Observation (not a bug) | Runs | Count |');
    out.push('| --- | --- | --- |');
    for (const [code, v] of Object.entries(a.observations)) out.push(`| ${code} | ${v.runs} | ${v.count} |`);
    out.push('');
  }
  return out.join('\n');
}

// The balance targets from the balance pass brief (#97), checked against a full run. Each row names the
// measured value, the target and whether it holds. Thresholds are the brief's; nothing is tuned to them here.
export function targetRows(perPolicy) {
  const rows = [];
  const add = (policy, name, value, target, ok) => rows.push({ policy, name, value, target, ok });
  const b = perPolicy.beginner;
  if (b) {
    const p50 = b.survival.p50;
    add('beginner', 'median survival, s', p50, '75-120', p50 >= 75 && p50 <= 120);
    // Only waves that at least 30 runs reach: a wave one run reaches tells nothing about the wall.
    const worstWave = Math.max(0, ...b.waveRows.filter((w) => w.reached >= 30).map((w) => w.deathRate));
    add('beginner', 'worst wave death rate (waves reached by 30+ runs)', worstWave, '<= 40%', worstWave <= 0.4);
    const worstType = Math.max(0, ...Object.values(b.hitsByType).map((n) => (b.hits > 0 ? n / b.hits : 0)));
    add('beginner', 'largest single-type share of HP lost', worstType, '<= 60%', worstType <= 0.6);
  }
  const i = perPolicy.intermediate;
  if (i) {
    const p50 = i.survival.p50;
    add('intermediate', 'median survival, s', p50, '150-270', p50 >= 150 && p50 <= 270);
    add('intermediate', 'share reaching the 300 s cap', i.survivedToCapShare, '< 15%', i.survivedToCapShare < 0.15);
  }
  const e = perPolicy.expert;
  if (e) {
    add('expert', 'median survival, s', e.survival.p50, '>= 240', e.survival.p50 >= 240);
    add('expert', 'median APM (dashes + pulses / min)', e.apm.p50, '>= 110', e.apm.p50 >= 110);
    add('expert', 'average dash kills per dash', e.dashKillsPerDash, '>= 1.8', e.dashKillsPerDash >= 1.8);
  }
  for (const [name, a] of Object.entries(perPolicy)) {
    const violated = Object.keys(a.violations).length;
    const stalls = a.violations.WAVE_STALL?.runs ?? 0;
    add(name, 'invariant violations (codes)', violated, '0', violated === 0);
    add(name, 'runs with a stalled wave', stalls, '0', stalls === 0);
  }
  return rows;
}

export function renderTargets(perPolicy) {
  const lines = ['## Balance targets', '', '| Policy | Measure | Value | Target | Holds |', '| --- | --- | --- | --- | --- |'];
  const fmt = (v) => (typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toFixed(v < 5 ? 2 : 1)) : String(v));
  for (const r of targetRows(perPolicy)) {
    const shown = r.name.includes('share') || r.name.includes('rate') ? `${(r.value * 100).toFixed(1)}%` : fmt(r.value);
    lines.push(`| ${r.policy} | ${r.name} | ${shown} | ${r.target} | ${r.ok ? 'yes' : '**no**'} |`);
  }
  return lines.join('\n');
}
