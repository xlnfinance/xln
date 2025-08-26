import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  // testDir is relative to this config file's directory
  testDir: '.',
  timeout: 60000,
  retries: 1,
  outputDir: 'e2e/test-results',
  use: {
    baseURL: 'http://localhost:5173',
    headless: process.env.HEADED !== 'true', // Headless by default, use HEADED=true for visual
    trace: 'on-first-retry',
    screenshot: 'on',
    viewport: { width: 1920, height: 1080 },
    video: { mode: 'on', size: { width: 1920, height: 1080 } },
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});


