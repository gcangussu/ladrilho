import solid from '@solidjs/vite-plugin';
import { defineConfig } from 'vitest/config';

/** The fast lane [U3-77]: jsdom, per the Solid v2 testing guide. */
export default defineConfig({
  plugins: [solid()],
  test: {
    environment: 'jsdom',
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    // The browser lane of [U3-73] runs under its own config, in a real browser.
    exclude: ['test/browser/**'],
    setupFiles: ['test/setup.ts'],
    // A property game is around 150 rendered plies; the default 5s is a budget
    // for a unit test, not for [U3-70].
    testTimeout: 20_000,
  },
});
