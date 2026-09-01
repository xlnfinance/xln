import { defineConfig, devices } from '@playwright/test';

delete process.env['NO_COLOR'];

const host = process.env['PLAYWRIGHT_REACT_HOST'] ?? '127.0.0.1';
const gatewayPort = Number(process.env['PLAYWRIGHT_REACT_PORT'] ?? '19080');
const portOffset = Number(process.env['PLAYWRIGHT_REACT_PORT_OFFSET'] ?? '12000');
const baseURL = `http://${host}:${gatewayPort}`;

const viewportProjects = [
  { name: 'mobile-390x844', viewport: { width: 390, height: 844 } },
  { name: 'laptop-1366x900', viewport: { width: 1366, height: 900 } },
  { name: 'wide-1920x1080', viewport: { width: 1920, height: 1080 } },
] as const;

export default defineConfig({
  testDir: './tests/react-candidate',
  outputDir: '../output/playwright/react-candidate/test-results',
  fullyParallel: false,
  forbidOnly: Boolean(process.env['CI']),
  retries: process.env['CI'] ? 1 : 0,
  workers: 1,
  reporter: [
    ['line'],
    ['html', { open: 'never', outputFolder: '../output/playwright/react-candidate/report' }],
  ],
  use: {
    baseURL,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: viewportProjects.map(({ name, viewport }) => ({
    name,
    use: {
      ...devices['Desktop Chrome'],
      viewport,
    },
  })),
  webServer: {
    command: 'bun run dev:react',
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      ...process.env,
      XLN_REACT_GATEWAY_HOST: host,
      XLN_REACT_GATEWAY_PORT: String(gatewayPort),
      XLN_REACT_PORT_OFFSET: String(portOffset),
    },
  },
});
