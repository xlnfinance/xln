import { defineConfig, devices } from '@playwright/test';

const PW_BASE_URL = process.env['PW_BASE_URL'] || 'https://localhost:8080';
const PW_WORKERS_RAW = Number(process.env['PW_WORKERS'] || '1');
const PW_WORKERS = Number.isFinite(PW_WORKERS_RAW) && PW_WORKERS_RAW > 0 ? Math.floor(PW_WORKERS_RAW) : 1;
const PW_SKIP_WEBSERVER = process.env['PW_SKIP_WEBSERVER'] === '1';
const PW_ONLY_CHROMIUM = process.env['PW_ONLY_CHROMIUM'] === '1';
const PW_SIMPLE_REPORTER = process.env['PW_SIMPLE_REPORTER'] === '1';
const PW_OUTPUT_DIR = process.env['PW_OUTPUT_DIR'] || './tests/test-results';
const PW_FAST = process.env['PW_FAST'] === '1';
const PW_TRACE = process.env['PW_TRACE'] || (PW_FAST ? 'off' : 'on-first-retry');
const PW_SCREENSHOT = process.env['PW_SCREENSHOT'] || (PW_FAST ? 'off' : 'only-on-failure');
const PW_VIDEO = process.env['PW_VIDEO'] || (PW_FAST ? 'off' : 'retain-on-failure');
const PW_REPORTER = process.env['PW_REPORTER'];

export default defineConfig({
  // testDir is relative to this config file's directory
  reporter: PW_REPORTER
    ? [[PW_REPORTER]]
    : PW_SIMPLE_REPORTER
      ? [['line']]
      : [
          ['list'],
          ['github'],
          ['html', { open: 'never' }],
          ['json'],
        ],
  testDir: './tests',
  testIgnore: ['**/ux-flow-verification.spec.js'],
  timeout: 60000, // 60s for AHB prepopulate
  workers: PW_WORKERS,
  // retries: 1,
  outputDir: PW_OUTPUT_DIR,
  use: {
    baseURL: PW_BASE_URL,
    headless: process.env['HEADED'] !== 'true', // Headless by default, use HEADED=true for visual
    ignoreHTTPSErrors: true, // Ignore self-signed cert errors
    trace: PW_TRACE as any,
    screenshot: PW_SCREENSHOT as any,
    viewport: { width: 1920, height: 1080 },
    video: PW_VIDEO === 'off'
      ? 'off'
      : { mode: PW_VIDEO as 'on' | 'retain-on-failure' | 'on-first-retry', size: { width: 1920, height: 1080 } },
    launchOptions: {
      args: [
        '--start-maximized',
        '--disable-gpu',
        '--use-gl=swiftshader',
        '--disable-dev-shm-usage',
      ],
    },
  },
  projects: PW_ONLY_CHROMIUM ? [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], channel: 'chromium' },
    },
  ] : [
    {
      name: 'chromium',
      // Force full Chromium instead of chromium_headless_shell (regressed WebGL in 1.58+)
      use: { ...devices['Desktop Chrome'], channel: 'chromium' },
    },
    {
      name: 'brainvault',
      testDir: './frontend/tests',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  // Run dev server before tests
  ...(PW_SKIP_WEBSERVER ? {} : {
    webServer: {
      // Prebuild runtime once (fresh artifact), then run dev pipeline with runtime --watch.
      command: './scripts/build-runtime.sh && SKIP_TYPECHECK=1 bun run dev',
      url: PW_BASE_URL,
      ignoreHTTPSErrors: true,  // Self-signed cert
      reuseExistingServer: true,
      timeout: 120 * 1000,
    },
  }),
});
