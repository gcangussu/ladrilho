import { defineConfig } from 'vitest/config';

/**
 * The lanes' suite: everything under `test/`. It runs after `cargo test`,
 * whose build leaves the debug binary the adapter's test plays through.
 */
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 20_000,
  },
});
