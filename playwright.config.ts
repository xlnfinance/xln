import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  // testDir is relative to this config file's directory
  reporter: [
    ['list'], // nice, minimal output in CI logs
    ['github'], // adds inline annotations to PRs & Actions logs
    ['html', { open: 'never' }], // artifact
    ['json'], // optional, for parsing
  ],
  testDir: './tests',
  timeout: 60000, // 60s for AHB prepopulate
  workers: 1,
  // retries: 1,
  outputDir: './tests/test-results',
  use: {
    baseURL: 'https://localhost:8080',
    headless: process.env['HEADED'] !== 'true', // Headless by default, use HEADED=true for visual
    ignoreHTTPSErrors: true, // Ignore self-signed cert errors
    trace: 'on-first-retry',
    screenshot: 'on',
    viewport: { width: 1920, height: 1080 },
    video: { mode: 'on', size: { width: 1920, height: 1080 } },
    launchOptions: {
      args: ['--start-maximized'], // optional, maximizes the window
    },
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'brainvault',
      testDir: './frontend/tests',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  // Run dev server before tests
  webServer: {
    command: 'cd frontend && SKIP_TYPECHECK=1 bun run dev',
    url: 'https://localhost:8080',
    ignoreHTTPSErrors: true,  // Self-signed cert
    reuseExistingServer: true,  // Reuse if already running (from dev-full.sh)
    timeout: 120 * 1000,
  },
});
