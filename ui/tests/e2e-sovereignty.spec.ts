/**
 * E2E for the certainty surfaces: Sovereignty (enforceable total, per-account
 * proofs, evidence bundle download), the Desk layout on a wide viewport and
 * the ⌘K palette.
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

test.describe('wallet UI sovereignty and desk', () => {
	test('shows what is enforceable, exports evidence, switches to Desk and jumps with ⌘K', { tag: '@functional' }, async ({ page }) => {
		const pageErrors: string[] = [];
		page.on('pageerror', error => pageErrors.push(error.message));

		await enterSandbox(page);
		// The hub owes the sandbox user 10,000 USDC on credit alone: all of it is at risk.
		await expect(page.getByTestId('home-risk')).toContainText('10,000', { timeout: CHAIN_TIMEOUT });

		await page.getByTestId('home-sovereignty').click();
		await expect(page.getByTestId('sovereignty-hero')).toBeVisible();
		await expect(page.getByTestId('sovereignty-risk')).toContainText('10,000');
		await expect(page.getByTestId('sovereignty-ledger')).toContainText(/co-signed/);
		const download = page.waitForEvent('download');
		await page.getByTestId('evidence-export').click();
		const file = await download;
		expect(file.suggestedFilename()).toMatch(/^xln-evidence-.*\.json$/);
		const text = await (await file.createReadStream()).toArray().then(chunks => Buffer.concat(chunks).toString('utf8'));
		const bundle = JSON.parse(text) as { format: string; accounts: Array<{ ourFrameHanko: string | null; theirFrameHanko: string | null }> };
		expect(bundle.format).toBe('xln-wallet-evidence/1');
		expect(bundle.accounts.length).toBeGreaterThan(0);
		expect(bundle.accounts[0]!.ourFrameHanko).toBeTruthy();
		expect(bundle.accounts[0]!.theirFrameHanko).toBeTruthy();

		// Desk replaces Home on a wide viewport once chosen in Settings.
		await page.getByRole('link', { name: 'Settings' }).first().click();
		await page.getByTestId('density-desk').click();
		await page.getByRole('link', { name: 'Home' }).first().click();
		await expect(page.getByTestId('desk')).toBeVisible();
		await expect(page.getByTestId('desk-table').locator('tbody tr')).not.toHaveCount(0);
		await expect(page.getByTestId('desk-net')).toContainText('$');

		// ⌘K: type "pay", Enter, land on Pay.
		await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k');
		await expect(page.getByTestId('palette')).toBeVisible();
		await page.getByTestId('palette-input').fill('pay');
		await page.keyboard.press('Enter');
		await expect(page).toHaveURL(/\/pay/);

		// Back to Comfort so other specs start from the phone-first Home.
		await page.getByRole('link', { name: 'Settings' }).first().click();
		await page.getByTestId('density-comfort').click();

		expect(pageErrors, 'no uncaught browser errors during the flow').toEqual([]);
	});
});
