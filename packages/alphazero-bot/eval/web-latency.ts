/**
 * The master opponent's latency lane ([0012 T12-25]): `Master.choose` timed
 * in Node — V8, the engine Chrome runs the module on — on every non-terminal
 * latency-corpus position at the default setting, single-threaded, from the
 * call to its return. Then one search at the maximum on the position slowest
 * at the default, and the module's memory after it.
 *
 * On purpose, on an idle machine. Printed, not written: intent 0010 promises
 * a speed on the machine of record only, and the figures move only when the
 * shipped milestone's architecture does.
 */

import { fromCanonical, toJSON } from 'engine';
import { createMaster, MASTER_SIMULATIONS, SHIPPED } from '../web/index.js';
import { corpusBlocks, parseBlock } from './blocks.js';

/** The budget at the default, on the machine of record. */
const MAX_MS = 1000;
/** The budget for memory at the maximum. */
const MAX_MEMORY_MB = 512;

const pct = (sorted: number[], p: number): number => sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];

const positions = corpusBlocks()
  .map((w) => toJSON(fromCanonical(parseBlock(w), 0)))
  .filter((p) => p.legalActions.length > 0);
const master = await createMaster();
console.log(`${SHIPPED.run}/${SHIPPED.generation}, ${positions.length} positions at ${MASTER_SIMULATIONS.default} simulations`);
const times: { ms: number; at: number }[] = [];
for (const [at, position] of positions.entries()) {
  const t = performance.now();
  master.choose(position, MASTER_SIMULATIONS.default);
  times.push({ ms: performance.now() - t, at });
}
const sorted = times.map((t) => t.ms).sort((a, b) => a - b);
const max = sorted.at(-1) as number;
console.log(`p50 ${pct(sorted, 50).toFixed(0)} ms, p95 ${pct(sorted, 95).toFixed(0)} ms, max ${max.toFixed(0)} ms (budget ${MAX_MS})`);

const slowest = times.reduce((a, b) => (b.ms > a.ms ? b : a));
const fresh = await createMaster();
const t = performance.now();
fresh.choose(positions[slowest.at], MASTER_SIMULATIONS.max);
// The module's own linear memory, which only grows: its size after the search
// is the most the search held. Node's `arrayBuffers` figure does not count it.
const memory = fresh.memoryBytes();
console.log(
  `${MASTER_SIMULATIONS.max} simulations on the slowest position: ${((performance.now() - t) / 1000).toFixed(1)} s, ` +
    `module memory ${(memory / 2 ** 20).toFixed(0)} MB (budget ${MAX_MEMORY_MB})`,
);
const passed = max < MAX_MS && memory / 2 ** 20 < MAX_MEMORY_MB;
console.log(passed ? 'passed' : 'FAILED');
process.exitCode = passed ? 0 : 1;
