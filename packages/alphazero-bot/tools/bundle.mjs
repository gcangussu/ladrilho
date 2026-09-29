/**
 * Bundles the lanes into one module, for the reason `bot`'s lanes give:
 * through Vitest's module runner every cross-module import is a getter call,
 * and a milestone crosses into `sharp`'s search on every node of every ply of
 * four hundred games.
 */
import { build } from 'esbuild';

await build({
  entryPoints: [new URL('../eval/cli.ts', import.meta.url).pathname],
  outfile: new URL('../node_modules/.alphazero/cli.mjs', import.meta.url).pathname,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node24',
  logLevel: 'warning',
});
