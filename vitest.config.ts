import { fileURLToPath } from 'node:url';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

const migrationsPath = fileURLToPath(new URL('./migrations', import.meta.url));
const migrations = await readD1Migrations(migrationsPath);

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: './src/worker/index.ts',
      miniflare: {
        compatibilityDate: '2026-08-15',
        compatibilityFlags: ['nodejs_compat'],
        d1Databases: ['DB', 'MIGRATION_DB'],
        r2Buckets: ['PHOTOS'],
        bindings: {
          APP_ORIGIN: 'http://localhost:5173',
          TEST_MIGRATIONS: migrations,
        },
      },
    }),
  ],
  test: {
    watch: false,
    setupFiles: ['./test/setup.ts'],
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
