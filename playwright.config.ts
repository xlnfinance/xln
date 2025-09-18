import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  // testDir is relative to this config file's directory
  reporter: [
    ['list'], // nice, minimal output in CI logs
    ['github'], // adds inline annotations to PRs & Actions logs
    ['html', { open: 'never' }], // artifact
    ['json'], // optional, for parsing
  ],
  testDir: './e2e',
  timeout: 20000,
  workers: 1,
  // retries: 1,
  outputDir: './e2e/test-results',
  testIgnore: 'ignored-tests/**',
  use: {
    baseURL: 'http://localhost:8080',
    headless: process.env.HEADED !== 'true', // Headless by default, use HEADED=true for visual
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
  ],
});
