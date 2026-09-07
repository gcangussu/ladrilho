import { defineConfig } from 'vitest/config';

/**
 * Benchmarks run against the bundled bot — see `bench/bundle.mjs` for why. The
 * benchmark source still imports `../src/index.js`, so it type-checks against
 * the real sources; only the module the runner loads is swapped.
 */
export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^\.\.\/src\/index\.js$/,
        replacement: new URL('node_modules/.bench/bot.js', import.meta.url).pathname,
      },
    ],
  },
});
