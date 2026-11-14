#!/usr/bin/env node
// Headless bot harness for Riptide Rush. Plays seeded games of the pure simulation (src/game.js) with
// three scripted policies (beginner, intermediate, expert), checks invariants after every step, and
// prints a Markdown report. No browser, no dependencies (worker_threads is built in).
//
//   node tools/bot/run.mjs                      300 seeds per policy, 300 s cap, parallel
//   node tools/bot/run.mjs --runs 50 --policy expert
//   node tools/bot/run.mjs --json out.json      also write the aggregates as JSON
//   node tools/bot/run.mjs --strict             exit 1 if any invariant is violated
//
// Options: --runs N (default 300), --seed-base N (default 1), --cap S (default 300), --policy a,b,c,
// --jobs N (default: up to 6 threads; 1 runs inline), --json PATH, --strict. Seeds are the same for every
// policy, so the policies are compared on the same maps and wave timings.
import { availableParallelism } from 'node:os';
import { writeFileSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import { POLICIES } from './policies.mjs';
import { runOne } from './sim-run.mjs';
import { aggregatePolicy, renderPolicy } from './report.mjs';

const CHUNK = 50; // seeds per worker task

function parseArgs(argv) {
  const opts = {
    runs: 300,
    seedBase: 1,
    cap: 300,
    policies: null,
    jobs: Math.max(1, Math.min(6, availableParallelism())),
    json: null,
    strict: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--runs') opts.runs = Number(next());
    else if (a === '--seed-base') opts.seedBase = Number(next());
    else if (a === '--cap') opts.cap = Number(next());
    else if (a === '--policy') opts.policies = next().split(',').map((s) => s.trim());
    else if (a === '--jobs') opts.jobs = Math.max(1, Number(next()));
    else if (a === '--json') opts.json = next();
    else if (a === '--strict') opts.strict = true;
    else throw new Error(`unknown option ${a}`);
  }
  if (!(opts.runs > 0) || !(opts.cap > 0)) throw new Error('--runs and --cap must be positive');
  return opts;
}

// Sequential: every run of one policy, in this thread.
export function runPolicy(policy, { runs, seedBase, cap }) {
  const out = [];
  for (let i = 0; i < runs; i++) out.push(runOne(seedBase + i, policy, { capSeconds: cap }));
  return out;
}

function runWorker(task) {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('./worker.mjs', import.meta.url), { workerData: task });
    let done = false;
    w.once('message', (runs) => {
      done = true;
      resolve(runs);
    });
    w.once('error', reject);
    w.once('exit', (code) => {
      if (!done) reject(new Error(`worker for ${task.policy} seeds ${task.seeds[0]}.. exited with ${code}`));
    });
  });
}

// Runs every (policy, seed chunk) task across up to `jobs` worker threads.
async function runAll(chosen, opts) {
  const tasks = [];
  for (const policy of chosen) {
    for (let s = 0; s < opts.runs; s += CHUNK) {
      const seeds = [];
      for (let i = s; i < Math.min(opts.runs, s + CHUNK); i++) seeds.push(opts.seedBase + i);
      tasks.push({ policy: policy.name, seeds, cap: opts.cap });
    }
  }
  const results = new Map(chosen.map((p) => [p.name, []]));
  let next = 0;
  async function lane() {
    while (next < tasks.length) {
      const task = tasks[next++];
      results.get(task.policy).push(...(await runWorker(task)));
    }
  }
  await Promise.all(Array.from({ length: Math.min(opts.jobs, tasks.length) }, lane));
  return results;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const chosen = opts.policies ? POLICIES.filter((p) => opts.policies.includes(p.name)) : POLICIES;
  if (chosen.length === 0) throw new Error(`no policy matches ${opts.policies}`);

  const t0 = performance.now();
  let runsByPolicy;
  if (opts.jobs === 1) {
    runsByPolicy = new Map(chosen.map((p) => [p.name, runPolicy(p, opts)]));
  } else {
    runsByPolicy = await runAll(chosen, opts);
  }
  const perPolicy = {};
  for (const policy of chosen) {
    const runs = runsByPolicy.get(policy.name).sort((a, b) => a.seed - b.seed);
    perPolicy[policy.name] = aggregatePolicy(runs);
  }
  const elapsed = (performance.now() - t0) / 1000;

  const lines = [];
  lines.push('# Bot balance run');
  lines.push('');
  lines.push(
    `Seeds ${opts.seedBase}..${opts.seedBase + opts.runs - 1} per policy, sim cap ${opts.cap} s, ${chosen.length} policies, ${opts.jobs} thread(s), ${elapsed.toFixed(1)} s wall time.`,
  );
  lines.push('');
  for (const policy of chosen) lines.push(renderPolicy(policy.name, perPolicy[policy.name]));
  process.stdout.write(lines.join('\n'));
  process.stdout.write('\n');

  if (opts.json) {
    writeFileSync(opts.json, JSON.stringify({ options: opts, elapsedSeconds: elapsed, policies: perPolicy }, null, 2));
  }

  const violated = Object.values(perPolicy).some((a) => Object.keys(a.violations).length > 0);
  if (opts.strict && violated) process.exitCode = 1;
}

// Runs as a script, not when imported by the tests.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    process.stderr.write(`${err.stack ?? err}\n`);
    process.exitCode = 2;
  });
}
