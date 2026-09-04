/**
 * The wallet resolves to the stack that serves it, like the SvelteKit app:
 * /api/jurisdictions → importJ over RPC, /relay → gossip, /api/hubs → an
 * account with the real hub. Runs against `bun run dev` (UI_E2E_BASE_URL=
 * http://localhost:5183) or any origin with an xln API; skips on a static host.
 */
import { expect, test } from '@playwright/test';

const BOOT_TIMEOUT = 180_000;
const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

test.describe('wallet UI on a hosted stack', () => {
	test('imports a phrase and opens an account with the stack hub', { tag: '@functional' }, async ({ page, baseURL }) => {
		const probe = await page.request.get(new URL('/api/jurisdictions', baseURL ?? 'http://localhost:5183').toString()).catch(() => null);
		test.skip(!probe || !String(probe.headers()['content-type'] || '').includes('json'), 'no xln stack behind this origin');

		const pageErrors: string[] = [];
		page.on('pageerror', error => pageErrors.push(error.message));
		page.on('console', message => {
			if (message.type() === 'error') process.stdout.write(`[browser] ${message.text().slice(0, 300)}\n`);
		});

		await page.goto('/');
		const stack = page.getByTestId('gate-stack');
		await expect(stack).toHaveAttribute('data-state', 'online', { timeout: 20_000 });
		await expect(stack).toContainText('hub');

		await page.getByRole('button', { name: /Import a phrase/ }).click();
		await page.locator('textarea').fill(PHRASE);
		await page.locator('button[type="submit"]').click();
		await expect(page.getByTestId('home-total')).toBeVisible({ timeout: BOOT_TIMEOUT });

		// The account with the stack hub exists on our side once the hub answered over the relay.
		const hubRow = page.getByTestId('account-row').first();
		await expect(hubRow).toBeVisible({ timeout: 90_000 });
		await expect(hubRow).toContainText('hub');
		expect(pageErrors, 'no uncaught browser errors during the flow').toEqual([]);
	});
});
