import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env['DEBATES_PORT'] || '8097');
const BASE_URL = process.env['DEBATES_BASE_URL'] || `http://127.0.0.1:${PORT}`;
const DB_PATH = process.env['DEBATES_DB_PATH'] || './db-tmp/debates-e2e.sqlite';

export default defineConfig({
  testDir: './tests',
  timeout: 45_000,
  workers: 1,
  reporter: [['list']],
  outputDir: './test-results',
  use: {
    baseURL: BASE_URL,
    headless: process.env['HEADED'] !== 'true',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    viewport: { width: 1440, height: 920 },
    deviceScaleFactor: 1,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], channel: 'chromium' },
    },
  ],
  webServer: {
    command: `rm -f ${DB_PATH} ${DB_PATH}-wal ${DB_PATH}-shm; DEBATES_PORT=${PORT} DEBATES_DB_PATH=${DB_PATH} DEBATES_DEV_MODE=1 DEBATES_OFFLINE_XLN=1 DEBATES_AI_SERVER_URL=http://127.0.0.1:1 bun server.ts`,
    url: BASE_URL,
    reuseExistingServer: false,
    timeout: 20_000,
  },
});
