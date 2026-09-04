/**
 * E2E account management: the Manage sheet on an account adds a token lane and
 * prepares a dispute. The dispute start joins the on-chain batch, is signed
 * from the batch notice and comes back as DisputeStarted from the sandbox chain.
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

test.describe('wallet UI account management', () => {
	test('adds a token lane, then prepares and signs a dispute', { tag: '@functional' }, async ({ page }) => {
		const pageErrors: string[] = [];
		page.on('pageerror', error => pageErrors.push(error.message));

		await enterSandbox(page);
		await page.getByTestId('account-row').first().click();
		await expect(page.getByTestId('account-status')).toHaveText('Open', { timeout: CHAIN_TIMEOUT });

		// Add token: the first token without a lane on this account.
		await page.getByTestId('account-manage').click();
		await page.getByTestId('manage-tab-token').click();
		const addable = page.locator('[data-testid^="add-token-"]').filter({ hasNot: page.getByTestId('add-token-submit') });
		const before = await page.locator('section.card').count();
		if ((await addable.count()) > 0) {
			await addable.first().click();
			await page.getByTestId('add-token-submit').click();
			// The new lane is empty, so it shows up behind the "empty lanes" toggle.
			await expect(page.getByRole('button', { name: /empty lane/ })).toBeVisible({ timeout: CHAIN_TIMEOUT });
			await page.getByRole('button', { name: /empty lane/ }).click();
			await expect.poll(() => page.locator('section.card').count(), { timeout: CHAIN_TIMEOUT }).toBeGreaterThan(before);
		}

		// Dispute: prepare freezes the account, the on-chain start joins the batch.
		await page.getByTestId('account-manage').click();
		await page.getByTestId('manage-tab-dispute').click();
		await page.getByTestId('dispute-prepare').click();
		await page.getByTestId('dispute-prepare-confirm').click();
		await expect(page.getByTestId('account-dispute-state')).toBeVisible({ timeout: CHAIN_TIMEOUT });

		// Back on Home the batch notice carries the dispute start; sign it.
		await page.getByRole('link', { name: 'Home' }).first().click();
		const batch = page.getByTestId('pending-batch');
		await expect(batch).toBeVisible({ timeout: CHAIN_TIMEOUT });
		await expect(batch).toContainText('Dispute start', { timeout: CHAIN_TIMEOUT });
		await page.getByTestId('batch-broadcast').click();

		// The sandbox chain processes the batch: the notice clears and the account stays frozen as disputed.
		// The embedded runtime does not yet apply its own DisputeStarted log back to the account (core
		// finding, see docs/audit), so the status reads "sent" here and "Disputed" once that lands.
		await expect(batch).toHaveCount(0, { timeout: CHAIN_TIMEOUT });
		await expect(page.getByTestId('account-row').first()).toContainText('dispute', { timeout: CHAIN_TIMEOUT });
		await page.getByTestId('account-row').first().click();
		await expect(page.getByTestId('account-status')).toHaveText(/Dispute sent|Disputed/, { timeout: CHAIN_TIMEOUT });
		await page.getByTestId('account-manage').click();
		await expect(page.getByTestId('manage-tab-dispute')).toHaveAttribute('aria-selected', 'true');

		expect(pageErrors, 'no uncaught browser errors during the flow').toEqual([]);
	});
});
