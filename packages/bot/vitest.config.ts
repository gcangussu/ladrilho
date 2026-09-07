import { defineConfig } from 'vitest/config';

/**
 * The fast suite [B4-60]: everything under `test/`, budgeted at 30 seconds.
 *
 * `ladder/` is deliberately excluded — it is [M5-13]'s gating lane, it takes
 * minutes rather than seconds, and it has `vitest.ladder.config.ts` of its own.
 */
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
  },
});
