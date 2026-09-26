import { defineConfig } from 'vitest/config';

/**
 * The tool's suite [C10-44]: everything under `test/`. The checker is built by
 * the `test` script before this runs, so compilation is not in the budget.
 */
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 60_000,
  },
});
