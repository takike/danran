import { fileURLToPath } from 'node:url';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: {
        configPath: './wrangler.jsonc',
      },
    }),
  ],
  test: {
    watch: false,
    include: [
      'src/shared/**/*.{test,spec}.ts',
      'src/worker/**/*.{test,spec}.ts',
      'test/**/*.{test,spec}.ts',
    ],
  },
  resolve: {
    alias: {
      '@client': fileURLToPath(new URL('./src/client', import.meta.url)),
      '@worker': fileURLToPath(new URL('./src/worker', import.meta.url)),
      '@shared': fileURLToPath(new URL('./src/shared', import.meta.url)),
    },
  },
});
