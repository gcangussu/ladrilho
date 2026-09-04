/**
 * Bundles the engine into a single module for benchmarking.
 *
 * Vitest 5 runs test files through Vite's module runner, which turns every
 * cross-module import reference into a getter call. The engine calls across
 * `src/*.ts` in its hottest loops, so that indirection lands inside the
 * measurement and makes [E1-58] read roughly a third of the real throughput
 * (Vitest warns about it too). Bundling collapses those calls back into
 * ordinary local references, so the benchmark measures the engine rather than
 * the harness. `vitest.bench.config.ts` aliases the engine entry point here.
 */
import { build } from 'esbuild';

export const BUNDLE = new URL('../node_modules/.bench/engine.js', import.meta.url).pathname;

await build({
  entryPoints: [new URL('../src/index.ts', import.meta.url).pathname],
  outfile: BUNDLE,
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2025',
});
