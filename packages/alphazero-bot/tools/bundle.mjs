/**
 * Bundles the lanes into one module, for the reason `bot`'s lanes give:
 * through Vitest's module runner every cross-module import is a getter call,
 * and a milestone crosses into `sharp`'s search on every node of every ply of
 * four hundred games.
 */
import { build } from 'esbuild';

await build({
  // The master's latency lane ([0012 T12-25]) is bundled beside the lanes.
  entryPoints: {
    cli: new URL('../eval/cli.ts', import.meta.url).pathname,
    'web-latency': new URL('../eval/web-latency.ts', import.meta.url).pathname,
  },
  outdir: new URL('../node_modules/.alphazero', import.meta.url).pathname,
  outExtension: { '.js': '.mjs' },
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node24',
  logLevel: 'warning',
});
