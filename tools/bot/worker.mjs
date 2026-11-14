// Worker thread for run.mjs: plays one chunk of seeds for one policy and posts the run metrics back.
// Each run depends only on its seed and policy, so the result does not depend on which thread ran it.
import { parentPort, workerData } from 'node:worker_threads';
import { POLICIES } from './policies.mjs';
import { runOne } from './sim-run.mjs';

const { policy, seeds, cap } = workerData;
const chosen = POLICIES.find((p) => p.name === policy);
if (!chosen) throw new Error(`unknown policy ${policy}`);
parentPort.postMessage(seeds.map((seed) => runOne(seed, chosen, { capSeconds: cap })));
