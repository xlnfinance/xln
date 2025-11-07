import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright Configuration for XLN Frontend
 *
 * Landing page tests MUST pass before deploy.
 */
export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'html',
  use: {
    baseURL: 'https://localhost:8080',
    trace: 'on-first-retry',
    ignoreHTTPSErrors: true,  // Dev server uses self-signed cert
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  // Run dev server before tests
  webServer: {
    command: 'SKIP_TYPECHECK=1 bun run dev',
    url: 'https://localhost:8080',
    reuseExistingServer: true,  // Always reuse - dev server runs separately
    timeout: 120 * 1000,
  },
});
