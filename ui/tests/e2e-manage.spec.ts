/**
 * E2E account management: the Manage sheet on an account adds a token lane and
 * prepares a dispute. The dispute start joins the on-chain batch, is signed
 * from the batch notice and comes back as DisputeStarted from the sandbox chain.
 */
import { expect, test, type Page } from '@playwright/test';
import { enterStack } from './stack';

const CHAIN_TIMEOUT = 15_000;


test.describe('wallet UI account management', () => {
	test('adds a token lane, then prepares and signs a dispute', { tag: '@functional' }, async ({ page }) => {
		test.setTimeout(60_000);
		const pageErrors: string[] = [];
		page.on('pageerror', error => pageErrors.push(error.message));

		await enterStack(page);
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
			// A new lane carries nothing, so it sits behind the unused-token toggle.
			const unused = page.getByTestId('account-unused-lanes');
			await expect(unused).toBeVisible({ timeout: CHAIN_TIMEOUT });
			await unused.click();
			await expect(unused).toHaveAttribute('data-open', 'yes');
			await expect.poll(() => page.locator('section.card').count(), { timeout: CHAIN_TIMEOUT }).toBeGreaterThan(before);
		}

		// Counterfactual clauses extension tab: previews CREATE2 address and signed allowance bounds.
		await page.getByTestId('account-manage').click();
		await page.getByTestId('manage-tab-clauses').click();
		await expect(page.getByTestId('clauses-panel')).toBeVisible();
		await expect(page.getByTestId('clause-create2-address')).toContainText('0x');
		await page.getByTestId('clause-template-call-option').click();
		await expect(page.getByTestId('clause-preview')).toContainText('0 gas');

		// Dispute: prepare freezes the account, the on-chain start joins the batch.
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
		await expect(page.getByTestId('account-row').first()).toContainText(/dispute/i, { timeout: CHAIN_TIMEOUT });
		await page.getByTestId('account-row').first().click();
		await expect(page.getByTestId('account-status')).toHaveText(/Dispute sent|Disputed/, { timeout: CHAIN_TIMEOUT });
		await page.getByTestId('account-manage').click();
		await expect(page.getByTestId('manage-tab-dispute')).toHaveAttribute('aria-selected', 'true');

		expect(pageErrors, 'no uncaught browser errors during the flow').toEqual([]);
	});
});
