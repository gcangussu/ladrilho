/**
 * Bundles the bot and the engine into a single module for benchmarking.
 *
 * Same reason `packages/engine/bench/bundle.mjs` exists, and it bites harder
 * here: Vitest 5 runs test files through Vite's module runner, which turns
 * every cross-module import reference into a getter call — and the bot crosses
 * into the engine on *every node* it expands, for `clone`, `apply`,
 * `legalActions` and four scoring primitives. Measured through the runner the
 * search reads about a tenth of its real throughput.
 */
import { build } from 'esbuild';

export const BUNDLE = new URL('../node_modules/.bench/bot.js', import.meta.url).pathname;

await build({
  entryPoints: [new URL('../src/index.ts', import.meta.url).pathname],
  outfile: BUNDLE,
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2025',
});
