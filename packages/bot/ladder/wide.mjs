/**
 * The wide lane [M5-16]: every ladder match over 200 recorded seeds at the
 * **shipped** budgets, printing a `Result` per match.
 *
 *   node ladder/wide.mjs > arena/baseline.json
 *
 * Run on demand, never in a suite. At `sharp`'s shipped 400 000 nodes this is
 * hours, not minutes — which is the whole reason [M5-13]'s gating lane runs
 * reduced budgets and is honest about measuring the ordering rather than the
 * opponent. What this produces is what [M5-15] commits and what the strength
 * claims in the README are allowed to cite.
 */

import { build } from 'esbuild';
import { execSync } from 'node:child_process';

const HERE = new URL('.', import.meta.url).pathname;
const BUNDLE = new URL('../node_modules/.bench/arena-wide.js', import.meta.url).pathname;

await build({
  entryPoints: [new URL('../arena/index.ts', import.meta.url).pathname],
  outfile: BUNDLE,
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2025',
});

const { WIDE_SEEDS, RANDOM_CHOOSER_SEED, greedy, match, summarise, tier, uniformRandom } =
  await import(BUNDLE);

const easy = () => tier({ tier: 'easy' });
const steady = () => tier({ tier: 'steady' });
const sharp = () => tier({ tier: 'sharp' });

const MATCHES = [
  ['easy vs random', easy, () => uniformRandom(RANDOM_CHOOSER_SEED)],
  ['steady vs easy', steady, easy],
  ['sharp vs steady', sharp, steady],
  ['sharp vs easy', sharp, easy],
  ['greedy vs random', greedy, () => uniformRandom(RANDOM_CHOOSER_SEED)],
];

const results = {};
for (const [label, a, b] of MATCHES) {
  const started = Date.now();
  // Choosers are built per match: `uniformRandom` carries a stream [M5-4].
  const result = match({ a: a(), b: b(), seeds: WIDE_SEEDS });
  results[label] = result;
  process.stderr.write(`${summarise(label, result)}  [${((Date.now() - started) / 1000) | 0}s]\n`);
}

process.stdout.write(
  `${JSON.stringify(
    {
      botCommit: execSync('git rev-parse HEAD', { cwd: HERE }).toString().trim(),
      machine: `${process.platform} ${process.arch}, node ${process.version}`,
      generatedAt: new Date().toISOString().slice(0, 10),
      seeds: WIDE_SEEDS.length,
      budgets: 'shipped (BUDGETS)',
      results,
    },
    null,
    2,
  )}\n`,
);
