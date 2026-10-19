import { defineConfig } from 'vitest/config';

/**
 * test:grzhx ([0013 G13-51]): what needs their cache, the host's environment
 * and their build. Not the root suite's, which is `test/`.
 */
export default defineConfig({
  test: {
    include: ['grzhx/test/**/*.test.ts'],
    testTimeout: 1_200_000,
    hookTimeout: 1_200_000,
    fileParallelism: false,
  },
});
