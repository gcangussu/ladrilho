/**
 * The master opponent's latency lane ([0012 T12-25]): `Master.choose` timed
 * in Node — V8, the engine Chrome runs the module on — on every non-terminal
 * latency-corpus position, single-threaded, from the call to its return, with
 * the endgame proof at the shipped cap ([T12-33]) and the shipped past-deal
 * refinement ([T12-36]), at each simulations count asked for, twice. The
 * module's memory after the corpus, which only grows, so it is the most any
 * of those moves held. Then, for the default, one search at the maximum on
 * the position slowest at the default, and one on the position whose tree is
 * the largest, each on a fresh module, and the memory after it.
 *
 * The budgets ([T12-25]): at the default, p95 at most 3 s, p99 at most 5 s
 * and no move over 10 s, on the slower of two passes — p99 is the 20th
 * slowest of about 2 000 moves, and one pass moves about a tenth between
 * runs; at `quick`, every move under 1 s; `deep` is timed and reported
 * only. pN is the time at rank ⌈N/100 · n⌉, as [0011 Z11-40] ranks it.
 *
 * `--simulations a,b,…` times other counts, report only unless they are a
 * configuration's; `--past-deal <file>|none` another refinement, or none;
 * `--endgame <nodes>` another cap: the way a setting is measured before it is
 * shipped. The figures the spec records come from the shipped ones.
 *
 * On purpose, on an idle machine: it takes the package's lock, so it does not
 * run beside the loop, a gate or a ship match, and it will not start while
 * the machine's load average says something else is running. Printed, not
 * written: intent 0016 promises a speed on the machine of record only.
 */

import { fromCanonical, toJSON, type AzulJSON } from 'engine';
import { readFileSync, writeFileSync } from 'node:fs';
import { loadavg } from 'node:os';
import { parseArgs } from 'node:util';
import { createMaster, MASTER_SIMULATIONS, SHIPPED } from '../web/index.js';
import { corpusBlocks, parseBlock } from './blocks.js';
import { acquire } from './lock.js';

/** [T12-25]'s budgets at the default, on the machine of record. */
export const BUDGET = Object.freeze({ p95: 3000, p99: 5000, max: 10_000 });
/** At `quick`: every move, as intent 0010 first promised. */
export const QUICK_MAX_MS = 1000;
/** The budget for memory, at every count and at the maximum. */
export const MAX_MEMORY_MB = 512;
/**
 * The one-minute load average above which the lane will not start: the
 * desktop alone keeps it near 1 to 2 on the machine of record.
 */
export const MAX_LOAD = 2.5;
/** Passes over the corpus; the slower decides. */
export const PASSES = 2;
/**
 * The non-terminal corpus position whose search holds the most memory, found
 * on 10-22 by a sweep of every third position at 50 000 simulations and
 * confirmed at 200 000 and 1 000 000. The slowest at the default is usually a
 * late position whose proof is slow but whose tree is small, so it alone
 * would not test the budget. Re-found when the corpus is re-recorded.
 */
const HEAVIEST = 498;

/** [Z11-40]'s rank: the value at `⌈p/100 · n⌉` of the sorted times. */
export const pct = (sorted: readonly number[], p: number): number => sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];

export interface PassFigures {
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

export function figures(times: readonly number[]): PassFigures {
  const sorted = [...times].sort((a, b) => a - b);
  return { p50: pct(sorted, 50), p95: pct(sorted, 95), p99: pct(sorted, 99), max: sorted.at(-1) ?? 0 };
}

/** What a count must meet: the default's budget, `quick`'s ceiling, or nothing. */
export type Budget = 'default' | 'quick' | 'report';

export function budgetOf(simulations: number): Budget {
  if (simulations === MASTER_SIMULATIONS.default) return 'default';
  const quick = (MASTER_SIMULATIONS as { quick?: number }).quick;
  return simulations === quick ? 'quick' : 'report';
}

/** Why a count's passes fail its budget; empty when they meet it. Every pass must. */
export function faults(budget: Budget, passes: readonly PassFigures[]): string[] {
  const out: string[] = [];
  passes.forEach((f, i) => {
    if (budget === 'default') {
      if (f.p95 > BUDGET.p95) out.push(`pass ${i + 1}: p95 ${f.p95.toFixed(0)} ms over ${BUDGET.p95}`);
      if (f.p99 > BUDGET.p99) out.push(`pass ${i + 1}: p99 ${f.p99.toFixed(0)} ms over ${BUDGET.p99}`);
      if (f.max > BUDGET.max) out.push(`pass ${i + 1}: a move of ${f.max.toFixed(0)} ms, over ${BUDGET.max}`);
    }
    if (budget === 'quick' && !(f.max < QUICK_MAX_MS)) out.push(`pass ${i + 1}: a move of ${f.max.toFixed(0)} ms, not under ${QUICK_MAX_MS}`);
  });
  return out;
}

/** The corpus's games, as index ranges: each starts at a first move, the first round (index 0) with every display full. */
export function games(positions: readonly AzulJSON[]): [number, number][] {
  const starts = positions.flatMap((p, i) => (p.round === 0 && p.tilesLeft === 20 && p.scores.every((s) => s === 0) ? [i] : []));
  return starts.map((s, k) => [s, starts[k + 1] ?? positions.length]);
}

/** Round 4 (index 3) with at least four tiles left and a bag that can deal: where the refinement can apply ([0011 Z11-91]). */
export function gated(p: AzulJSON): boolean {
  return p.round === 3 && p.tilesLeft >= 4 && p.bag.reduce((a, b) => a + b, 0) >= 20;
}

const ms = (x: number): string => `${x.toFixed(0)} ms`;
const line = (f: PassFigures): string => `p50 ${ms(f.p50)}, p95 ${ms(f.p95)}, p99 ${ms(f.p99)}, max ${ms(f.max)}`;

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      endgame: { type: 'string' },
      'past-deal': { type: 'string' },
      simulations: { type: 'string' },
      json: { type: 'string' },
      force: { type: 'boolean' },
    },
  });
  const endgame = values.endgame === undefined ? SHIPPED.endgameNodes : Number(values.endgame);
  const pd = values['past-deal'];
  const pastDeal = pd === undefined ? undefined : pd === 'none' ? new Uint8Array(0) : new Uint8Array(readFileSync(pd));
  const counts =
    values.simulations === undefined
      ? [...new Set([(MASTER_SIMULATIONS as { quick?: number }).quick, MASTER_SIMULATIONS.default].filter((n): n is number => n !== undefined))]
      : values.simulations.split(',').map(Number);
  if (counts.some((n) => !Number.isInteger(n) || n < MASTER_SIMULATIONS.min || n > MASTER_SIMULATIONS.max)) {
    throw new Error(`--simulations takes counts in [${MASTER_SIMULATIONS.min}, ${MASTER_SIMULATIONS.max}]`);
  }
  const load = loadavg()[0];
  if (load > MAX_LOAD && values.force !== true) {
    throw new Error(`the load average is ${load.toFixed(2)}, over ${MAX_LOAD}: something else is running, so the figures would not be the machine's`);
  }
  const release = acquire('web-latency');
  try {
    const positions = corpusBlocks()
      .map((w) => toJSON(fromCanonical(parseBlock(w), 0)))
      .filter((p) => p.legalActions.length > 0);
    const ranges = games(positions);
    const refinement = pastDeal === undefined ? (SHIPPED.pastDeal === null ? 'none (shipped)' : 'shipped') : pd;
    console.log(
      `${SHIPPED.run}/${SHIPPED.generation}, ${positions.length} positions in ${ranges.length} games, ` +
        `endgame proof ${endgame === 0 ? 'off' : `at ${endgame} nodes`}${endgame === SHIPPED.endgameNodes ? ' (shipped)' : ''}, ` +
        `past-deal refinement ${refinement}; load average ${loadavg().map((x) => x.toFixed(2)).join(' ')}`,
    );
    const record: Record<string, unknown>[] = [];
    let failed = false;
    for (const n of counts) {
      const budget = budgetOf(n);
      const passes: number[][] = [];
      let memory = 0;
      for (let pass = 0; pass < PASSES; pass++) {
        const master = await createMaster(undefined, endgame, pastDeal);
        const times: number[] = [];
        for (const position of positions) {
          const t = performance.now();
          master.choose(position, n);
          times.push(performance.now() - t);
        }
        passes.push(times);
        memory = Math.max(memory, master.memoryBytes());
      }
      const each = passes.map(figures);
      console.log(`\n${n} simulations (${budget === 'report' ? 'report only' : `the ${budget}'s budget`}):`);
      each.forEach((f, i) => console.log(`  pass ${i + 1}: ${line(f)}`));
      // Every pass's own slowest moves, and the slower time of each position.
      const slower = passes[0].map((_, i) => Math.max(...passes.map((p) => p[i])));
      const four = slower.filter((_, i) => gated(positions[i]));
      console.log(`  round 4, where the refinement can apply (${four.length}): ${line(figures(four))}`);
      const perGame = ranges.map(([a, b]) => Math.max(...slower.slice(a, b)));
      const over = (x: number): number => perGame.filter((t) => t > x).length;
      console.log(
        `  the slowest move of each game: p50 ${ms(pct([...perGame].sort((a, b) => a - b), 50))}; ` +
          `games with a move over 3 s ${over(3000)}, over 5 s ${over(5000)}, of ${ranges.length}`,
      );
      const slowest = slower.indexOf(Math.max(...slower));
      console.log(`  slowest: position ${slowest} of the non-terminal corpus, ${ms(slower[slowest])}`);
      console.log(`  module memory after the corpus ${(memory / 2 ** 20).toFixed(0)} MB (budget ${MAX_MEMORY_MB})`);
      const why = faults(budget, each);
      if (memory / 2 ** 20 >= MAX_MEMORY_MB) why.push(`${(memory / 2 ** 20).toFixed(0)} MB after the corpus`);
      if (budget === 'default') {
        for (const [what, at] of [['slowest', slowest], ['heaviest', HEAVIEST]] as const) {
          const fresh = await createMaster(undefined, endgame, pastDeal);
          const t = performance.now();
          fresh.choose(positions[at], MASTER_SIMULATIONS.max);
          // The module's own linear memory, which only grows: its size after the search
          // is the most the search held. Node's `arrayBuffers` figure does not count it.
          const bytes = fresh.memoryBytes();
          console.log(
            `  ${MASTER_SIMULATIONS.max} simulations on the ${what} position (${at}): ${((performance.now() - t) / 1000).toFixed(1)} s, ` +
              `module memory ${(bytes / 2 ** 20).toFixed(0)} MB (budget ${MAX_MEMORY_MB})`,
          );
          if (bytes / 2 ** 20 >= MAX_MEMORY_MB) why.push(`${(bytes / 2 ** 20).toFixed(0)} MB at the maximum on the ${what} position`);
        }
      }
      for (const w of why) console.log(`  FAILED: ${w}`);
      failed ||= why.length > 0;
      record.push({ simulations: n, budget, passes: each, memoryBytes: memory, milliseconds: passes });
    }
    console.log(`\nload average after: ${loadavg().map((x) => x.toFixed(2)).join(' ')}`);
    if (values.json !== undefined) {
      writeFileSync(values.json, `${JSON.stringify({ shipped: SHIPPED, endgame, pastDeal: refinement, counts: record })}\n`);
    }
    console.log(failed ? 'FAILED' : 'passed');
    process.exitCode = failed ? 1 : 0;
  } finally {
    release();
  }
}

await main();
