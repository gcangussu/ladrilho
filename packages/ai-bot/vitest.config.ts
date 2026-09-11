import { defineConfig } from 'vitest/config';

/**
 * The fast suite [A8-46]: everything under `test/`. The fixture generator of
 * [A8-34] and the gate of [A8-30] run outside it, by their own scripts.
 */
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
  },
});
