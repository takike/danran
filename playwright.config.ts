import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  expect: {
    timeout: 10_000,
  },
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: 'list',
  projects: [
    {
      name: 'production',
      testMatch: [
        '**/pwa.spec.ts',
        '**/pwa-update.spec.ts',
        '**/auth.spec.ts',
        '**/family.spec.ts',
        '**/week.spec.ts',
        '**/events.spec.ts',
      ],
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 390, height: 844 },
        baseURL: 'http://127.0.0.1:4173',
      },
    },
    {
      name: 'dev-ui',
      testMatch: '**/ui.spec.ts',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 390, height: 844 },
        baseURL: 'http://127.0.0.1:5174',
      },
    },
  ],
  webServer: [
    {
      command:
        'pnpm build && node node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port 4173 --strictPort',
      port: 4173,
      reuseExistingServer: false,
      stdout: 'ignore',
      stderr: 'pipe',
      env: {
        DANRAN_PERSIST_PATH: '.wrangler/e2e/preview',
      },
    },
    {
      command: 'node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5174 --strictPort',
      port: 5174,
      reuseExistingServer: false,
      stdout: 'ignore',
      stderr: 'pipe',
      env: {
        DANRAN_PERSIST_PATH: '.wrangler/e2e/dev',
      },
    },
  ],
});
