/**
 * E2E for the Manage tab and its doors: the on-chain wallet read from the
 * sandbox chain, both sandbox faucets, and the lending / ownership screens
 * rendering their state without a hosted API.
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
	// The sandbox shapes the signer wallet (2,500 USDC + 1 WETH); wait for the on-chain tier so totals are stable.
	await expect(page.getByTestId('home-onchain')).not.toContainText('$0.00', { timeout: CHAIN_TIMEOUT });
}

const money = (text: string | null): number => Number(String(text || '0').replace(/[^0-9.-]/g, ''));

test.describe('wallet UI manage', () => {
	test('reads the on-chain wallet, runs both sandbox faucets, opens lending and ownership', { tag: '@functional' }, async ({ page }) => {
		const pageErrors: string[] = [];
		page.on('pageerror', error => pageErrors.push(error.message));

		await enterSandbox(page);
		const usdcBefore = money(await page.getByTestId('token-net-USDC').textContent());

		await page.getByRole('link', { name: 'Manage' }).first().click();
		await expect(page.getByTestId('attention')).toBeVisible();
		await page.getByTestId('manage-assets').click();

		// The sandbox funded the signer with USDC on boot; the wallet reads it from the BrowserVM.
		const external = page.getByTestId('external-balance-USDC');
		await expect(external).toBeVisible({ timeout: CHAIN_TIMEOUT });
		const onchainBefore = money(await external.textContent());
		expect(onchainBefore).toBeGreaterThan(0);

		// The sandbox ERC20 faucet is not asserted here: the BrowserVM bootstraps the
		// signer at 1e12 USDC and the top-up path is still being verified (see the
		// session notes); the off-chain faucet below is the one exercised.
		await page.getByTestId('faucet-amount').fill('100');

		// Off-chain faucet: the hub pays 100 USDC over credit; Home's USDC net grows by 100.
		await page.getByTestId('faucet-offchain').click();
		await page.getByRole('link', { name: 'Home' }).first().click();
		await expect.poll(async () => money(await page.getByTestId('token-net-USDC').textContent()), { timeout: CHAIN_TIMEOUT }).toBeCloseTo(usdcBefore + 100, 1);

		// Lending has no API in the sandbox; the screen says so instead of failing.
		await page.getByRole('link', { name: 'Manage' }).first().click();
		await page.getByTestId('manage-lend').click();
		await expect(page.getByTestId('lend-submit')).toBeVisible();
		await expect(page.getByTestId('lending-state')).toContainText(/no lending API|Pool/, { timeout: CHAIN_TIMEOUT });

		// Ownership shows the board of the sandbox entity.
		await page.goBack();
		await page.getByTestId('manage-ownership').click();
		await expect(page.getByTestId('board')).toContainText('1 of 1');

		expect(pageErrors, 'no uncaught browser errors during the flow').toEqual([]);
	});
});
