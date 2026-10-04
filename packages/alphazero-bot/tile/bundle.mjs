/**
 * Bundles the tile harness into one module, as tools/bundle.mjs does the
 * lanes: the engine's sources are TypeScript, and a bundle is what node runs.
 * Its worker threads load the same file.
 */
import { build } from 'esbuild';

await build({
  entryPoints: { tile: new URL('./cli.ts', import.meta.url).pathname },
  outdir: new URL('../node_modules/.alphazero', import.meta.url).pathname,
  outExtension: { '.js': '.mjs' },
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node24',
  logLevel: 'warning',
});
