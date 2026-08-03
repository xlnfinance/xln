import { defineConfig } from '@playwright/test';

const port = 4187;
const baseURL = `http://127.0.0.1:${port}`;
process.env['PW_REACT_WALLET_CANDIDATE'] = '1';

export default defineConfig({
  testDir: '..',
  testMatch: 'wallet-shell-onboarding.spec.ts',
  timeout: 45_000,
  workers: 1,
  retries: 0,
  outputDir: './test-results',
  reporter: 'line',
  use: {
    baseURL,
    headless: true,
    trace: 'off',
    video: 'off',
    screenshot: 'off',
  },
  webServer: {
    command: `XLN_FRONTEND_SURFACE=wallet node node_modules/vite/bin/vite.js build --config vite.react.config.ts && XLN_FRONTEND_SURFACE=wallet node node_modules/vite/bin/vite.js preview --config vite.react.config.ts --host 127.0.0.1 --port ${port} --strictPort`,
    cwd: '../../frontend',
    url: `${baseURL}/app`,
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
