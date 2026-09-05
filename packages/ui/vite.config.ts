import solid from '@solidjs/vite-plugin';
import { defineConfig } from 'vite';

/**
 * [U3-9]: the build output is static files, servable from any file host.
 * `base: './'` keeps every emitted asset reference relative, which is also what
 * [U3-8] wants — no asset addressed by an absolute URL.
 */
export default defineConfig({
  base: './',
  plugins: [solid()],
});
