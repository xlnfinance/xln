import { defineConfig, devices } from '@playwright/test';

delete process.env['NO_COLOR'];

const host = process.env['XLN_DEPLOYMENT_SMOKE_HOST'] ?? '127.0.0.1';
const port = Number(process.env['XLN_DEPLOYMENT_SMOKE_PORT'] ?? '19092');
const baseURL = `http://${host}:${port}`;

export default defineConfig({
  testDir: './tests/deployment-candidate',
  outputDir: '../output/playwright/deployment-candidate/test-results',
  fullyParallel: false,
  forbidOnly: Boolean(process.env['CI']),
  retries: 0,
  workers: 1,
  reporter: [
    ['line'],
    ['html', { open: 'never', outputFolder: '../output/playwright/deployment-candidate/report' }],
  ],
  use: {
    ...devices['Desktop Chrome'],
    baseURL,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'bun scripts/deployment-candidate-smoke-server.ts',
    url: `${baseURL}/__xln-deployment/state`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: { ...process.env, XLN_DEPLOYMENT_SMOKE_HOST: host, XLN_DEPLOYMENT_SMOKE_PORT: String(port) },
  },
});
