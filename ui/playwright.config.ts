import { defineConfig, devices } from '@playwright/test';

/**
 * Browser E2E for the wallet UI. The app boots its own embedded runtime in the
 * sandbox, so no anvil, orchestrator or relay is needed: one dev server, one
 * browser, real consensus in the page.
 */
const PORT = Number(process.env['UI_E2E_PORT'] || '5183');
const BASE_URL = process.env['UI_E2E_BASE_URL'] || `http://localhost:${PORT}`;

export default defineConfig({
	testDir: './tests',
	timeout: 240_000,
	workers: 1,
	retries: 0,
	reporter: [['list']],
	outputDir: './tests/test-results',
	use: {
		baseURL: BASE_URL,
		headless: process.env['HEADED'] !== 'true',
		viewport: { width: 1280, height: 860 },
		deviceScaleFactor: 1,
		trace: 'retain-on-failure',
		screenshot: 'only-on-failure',
		video: 'retain-on-failure',
		launchOptions: { args: ['--disable-gpu', '--use-gl=swiftshader', '--disable-dev-shm-usage'] },
	},
	projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], channel: 'chromium' } }],
	webServer: {
		command: 'bun run dev',
		url: BASE_URL,
		reuseExistingServer: true,
		timeout: 240_000,
	},
});
