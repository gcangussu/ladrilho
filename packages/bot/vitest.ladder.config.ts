import { defineConfig } from 'vitest/config';

/**
 * The gating lane of [M5-13] and [M5-19], run by `pnpm -F bot ladder`.
 *
 * Separate from the fast suite because strength measurement is slow by nature:
 * [B4-60] budgets `test` at 30 seconds and [M5-20] budgets this at five
 * minutes, and running them together would make one of those numbers a lie.
 *
 * Runs against the bundled arena — see `ladder/bundle.mjs`. That is not an
 * optimisation but the difference between meeting [M5-20] and missing it by an
 * order of magnitude.
 */
export default defineConfig({
  test: {
    include: ['ladder/**/*.test.ts'],
    testTimeout: 600_000,
    hookTimeout: 600_000,
  },
  resolve: {
    alias: [
      {
        find: /^\.\.\/arena\/index\.js$/,
        replacement: new URL('node_modules/.bench/arena-lane.js', import.meta.url).pathname,
      },
    ],
  },
});
