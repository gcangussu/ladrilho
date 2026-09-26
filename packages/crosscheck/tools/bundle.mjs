/**
 * Bundles the driver's command line into one module Node can run directly.
 *
 * The engine's sources import each other as `./x.js` while the files are
 * `x.ts`, which a bundler resolves and Node's type stripping does not. The
 * suite needs none of this: Vitest resolves the same imports itself.
 */
import { build } from 'esbuild';

await build({
  entryPoints: [new URL('../src/cli.ts', import.meta.url).pathname],
  outfile: new URL('../node_modules/.crosscheck/cli.mjs', import.meta.url).pathname,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node24',
});
