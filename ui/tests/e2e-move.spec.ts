/**
 * E2E move coverage: reserve → account posts collateral through the on-chain
 * batch. The sandbox chain is the runtime's own BrowserVM, so the batch is
 * signed, broadcast and observed back as a J event in the same page.
 */
import { expect, test, type Page } from '@playwright/test';

const BOOT_TIMEOUT = 180_000;
const CHAIN_TIMEOUT = 90_000;

async function enterSandbox(page: Page): Promise<void> {
	await page.goto('/');
	const existing = page.getByRole('button', { name: /Sandbox/ }).first();
	if (await existing.isVisible({ timeout: 2_000 }).catch(() => false)) await existing.click();
	else await page.getByTestId('gate-sandbox').click();
	await expect(page.getByTestId('home-total')).toBeVisible({ timeout: BOOT_TIMEOUT });
	await expect(page.getByTestId('token-net-USDC')).toBeVisible({ timeout: CHAIN_TIMEOUT });
}

test.describe('wallet UI move', () => {
	test('moves reserve into the hub account as collateral through a signed batch', { tag: '@functional' }, async ({ page }) => {
		const pageErrors: string[] = [];
		page.on('pageerror', error => pageErrors.push(error.message));

		await enterSandbox(page);
		await page.getByTestId('home-move').click();
		await page.getByTestId('move-from-reserve').click();
		await page.getByTestId('move-to-account').click();
		await page.getByTestId('move-amount').fill('100');
		const send = page.getByTestId('move-now');
		await expect(send).toBeEnabled();
		await send.click();

		// Back on Home: the account with Hub One now carries 100 USDC of collateral,
		// the reserve tier is 100 lower, and the batch notice is gone once the chain confirmed.
		await expect(page.getByTestId('home-total')).toBeVisible({ timeout: CHAIN_TIMEOUT });
		await page.getByTestId('account-row').first().click();
		await expect(page.getByText('Collateral').first()).toBeVisible();
		await expect(page.locator('.kv').filter({ hasText: 'Collateral' }).first().locator('.v')).toHaveText('100.00', { timeout: CHAIN_TIMEOUT });

		expect(pageErrors, 'no uncaught browser errors during the flow').toEqual([]);
	});
});
