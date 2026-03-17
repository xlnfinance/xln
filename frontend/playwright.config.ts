import { defineConfig, devices } from '@playwright/test';

const host = process.env.PLAYWRIGHT_FRONTEND_HOST || '127.0.0.1';
const port = Number(process.env.PLAYWRIGHT_FRONTEND_PORT || 4173);
const baseURL = `https://${host}:${port}`;

/**
 * Playwright Configuration for XLN Frontend
 *
 * Landing page tests MUST pass before deploy.
 */
export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: 'html',
  use: {
    baseURL,
    trace: 'on-first-retry',
    ignoreHTTPSErrors: true,
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  // Run dev server before tests
  webServer: {
    command: `SKIP_TYPECHECK=1 VITE_DEV_PORT=${port} bun run dev -- --host ${host} --port ${port} --strictPort`,
    url: baseURL,
    ignoreHTTPSErrors: true,
    reuseExistingServer: false,
    timeout: 120 * 1000,
  },
});
