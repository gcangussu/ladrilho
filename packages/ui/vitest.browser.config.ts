import { playwright } from '@vitest/browser-playwright';
import solid from '@solidjs/vite-plugin';
import { defineConfig } from 'vitest/config';

/**
 * The slow lane [U3-73]. jsdom has neither a layout engine nor a reload, and
 * three requirements that came straight from the intent need both — so they run
 * in a real browser instead of being excused.
 *
 * Expected to run beside the fast suite, not inside [U3-77]'s budget.
 */
export default defineConfig({
  plugins: [solid()],
  test: {
    include: ['test/browser/**/*.test.ts'],
    browser: {
      enabled: true,
      provider: playwright(),
      headless: true,
      instances: [{ browser: 'chromium' }],
    },
  },
});
