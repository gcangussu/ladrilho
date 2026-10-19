/**
 * Bundles the grzhx harness into one module, as tile/bundle.mjs does its own:
 * the engine's sources are TypeScript, and a bundle is what node runs.
 */
import { build } from 'esbuild';

await build({
  entryPoints: { grzhx: new URL('./cli.ts', import.meta.url).pathname },
  outdir: new URL('../node_modules/.alphazero', import.meta.url).pathname,
  outExtension: { '.js': '.mjs' },
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node24',
  logLevel: 'warning',
});
