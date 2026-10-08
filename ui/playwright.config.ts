import { defineConfig, devices } from '@playwright/test';

/**
 * Browser E2E for the wallet UI. The wallet talks to the real dev stack — two
 * anvil chains, the orchestrator and the relay — through the ordinary RPC
 * jurisdiction adapter. There is no in-page chain: `bun run dev` below brings
 * the whole stand up, and the tests assert against the Depository on chain.
 */
const PORT = process.env['UI_E2E_PORT'] || '5183';
const BASE_URL = process.env['UI_E2E_BASE_URL'] || process.env['PW_BASE_URL'] || `http://localhost:${PORT}`;

export default defineConfig({
	testDir: './tests',
	timeout: 240_000,
	workers: 1,
	retries: 0,
	reporter: [['list']],
	outputDir: process.env['PW_OUTPUT_DIR'] || './tests/test-results',
	use: {
		baseURL: BASE_URL,
		headless: process.env['HEADED'] !== 'true',
		viewport: { width: 1280, height: 860 },
		deviceScaleFactor: 1,
		colorScheme: 'dark',
		trace: 'retain-on-failure',
		screenshot: 'only-on-failure',
		video: 'retain-on-failure',
		launchOptions: { args: ['--disable-gpu', '--use-gl=swiftshader', '--disable-dev-shm-usage'] },
	},
	projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], channel: 'chromium' } }],
	// The wallet is tested against the real stack: `bun run dev` serves it on :5183 with /api proxied.
	webServer: process.env['PW_SKIP_WEBSERVER'] === '1' ? undefined : {
		command: 'cd .. && bun run dev',
		url: `${BASE_URL.replace(/\/$/, '')}/api/jurisdictions`,
		reuseExistingServer: true,
		// Let the dev launcher stop its separately owned service groups before exit.
		gracefulShutdown: { signal: 'SIGTERM', timeout: 60_000 },
		timeout: 240_000,
	},
});
