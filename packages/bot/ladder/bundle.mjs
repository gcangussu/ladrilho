/**
 * Bundles the arena for the gating lane.
 *
 * Same reason as `bench/bundle.mjs`, but here it is the difference between a
 * lane that meets [M5-20] and one that does not. Through Vitest's module runner
 * every cross-module import is a getter call, and the arena crosses into the
 * search on every node of every ply of every game: measured, the lane takes
 * roughly ten times as long, which is fifty minutes against [M5-20]'s five.
 *
 * The lane still type-checks against the real sources — only the module the
 * runner loads is swapped, by the alias in `vitest.ladder.config.ts`.
 */
import { build } from 'esbuild';

export const BUNDLE = new URL('../node_modules/.bench/arena-lane.js', import.meta.url).pathname;

await build({
  entryPoints: [new URL('../arena/index.ts', import.meta.url).pathname],
  outfile: BUNDLE,
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2025',
});
