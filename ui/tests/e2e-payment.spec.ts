/**
 * E2E payment coverage for the wallet UI, the counterpart of the SvelteKit
 * tests/e2e-payment.spec.ts.
 *
 * Flow:
 * 1. Enter the sandbox: an embedded runtime boots three funded actors in the page.
 * 2. Read the rendered USDC position, open Pay, pick the merchant, pay 25 USDC.
 * 3. The receipt sheet appears only from the committed HtlcFinalized frame log.
 * 4. The rendered position drops by exactly the payment; Activity lists it.
 * 5. Reload: the persisted runtime restores the same rendered position.
 *
 * Everything asserted is what a user sees. No window globals, no mocks.
 */
import { expect, test, type Page } from '@playwright/test';

const PAYMENT_AMOUNT = '25';
const BOOT_TIMEOUT = 180_000;
const CONSENSUS_TIMEOUT = 60_000;

const parseMoney = (text: string): number => Number(text.replace(/[^0-9.\-−]/g, '').replace('−', '-'));

async function enterSandbox(page: Page): Promise<void> {
	await page.goto('/');
	const existing = page.getByRole('button', { name: /Sandbox/ }).first();
	if (await existing.isVisible({ timeout: 2_000 }).catch(() => false)) {
		await existing.click();
	} else {
		await page.getByTestId('gate-sandbox').click();
	}
	await expect(page.getByTestId('home-total')).toBeVisible({ timeout: BOOT_TIMEOUT });
	await expect(page.getByTestId('token-net-USDC')).toBeVisible({ timeout: CONSENSUS_TIMEOUT });
	// The sandbox shapes the signer wallet (2,500 USDC + 1 WETH); wait for the on-chain tier so totals are stable.
	await expect(page.getByTestId('home-onchain')).not.toContainText('$0.00', { timeout: CONSENSUS_TIMEOUT });
}

async function readUsdcNet(page: Page): Promise<number> {
	return parseMoney(await page.getByTestId('token-net-USDC').innerText());
}

test.describe('wallet UI payment', () => {
	test('pays the merchant through the hub and shows the committed receipt', { tag: '@functional' }, async ({ page }) => {
		const pageErrors: string[] = [];
		page.on('pageerror', error => pageErrors.push(error.message));
		page.on('console', message => {
			if (message.type() === 'error') process.stdout.write(`[browser] ${message.text()}\n`);
		});
		page.on('response', response => {
			if (response.status() >= 400) process.stdout.write(`[http ${response.status()}] ${response.url()}\n`);
		});

		await enterSandbox(page);
		await page.screenshot({ path: 'tests/test-results/ui-home.png', fullPage: true });
		const netBefore = await readUsdcNet(page);
		expect(netBefore, 'the sandbox funds the user through the hub').toBeGreaterThan(Number(PAYMENT_AMOUNT));

		await page.getByTestId('home-pay').click();
		await page.getByTestId('pay-to').fill('Meridian Desk');
		await page.getByTestId('pay-amount').fill(PAYMENT_AMOUNT);
		const submit = page.getByTestId('pay-submit');
		await expect(submit).toBeEnabled({ timeout: CONSENSUS_TIMEOUT });
		await expect(submit).toHaveText(new RegExp(`Pay ${PAYMENT_AMOUNT}\\.00 USDC`));
		await page.screenshot({ path: 'tests/test-results/ui-pay.png', fullPage: true });
		await submit.click();

		const receipt = page.getByTestId('payment-receipt');
		await expect(receipt).toBeVisible({ timeout: CONSENSUS_TIMEOUT });
		await expect(receipt.getByTestId('receipt-kicker')).toHaveText('Paid');
		await expect(receipt.getByTestId('receipt-amount')).toContainText(`${PAYMENT_AMOUNT}.00`);
		await expect(receipt.getByTestId('receipt-title')).toContainText('Meridian Desk');
		await page.waitForTimeout(400);
		await page.screenshot({ path: 'tests/test-results/ui-receipt.png', fullPage: true });
		await receipt.getByTestId('receipt-done').click();
		await expect(receipt).toHaveCount(0);

		await expect
			.poll(async () => readUsdcNet(page), { timeout: CONSENSUS_TIMEOUT })
			.toBeCloseTo(netBefore - Number(PAYMENT_AMOUNT), 2);
		const netAfter = await readUsdcNet(page);

		// In-app navigation: a full page load would drop the embedded runtime.
		await page.getByRole('link', { name: 'Activity' }).first().click();
		await expect(page).toHaveURL(/\/activity$/);
		await expect(page.getByTestId('activity-row').filter({ hasText: 'Meridian Desk' }).first()).toBeVisible({ timeout: CONSENSUS_TIMEOUT });
		await page.screenshot({ path: 'tests/test-results/ui-activity.png', fullPage: true });

		await page.reload({ waitUntil: 'domcontentloaded' });
		await enterSandbox(page);
		await expect.poll(async () => readUsdcNet(page), { timeout: CONSENSUS_TIMEOUT }).toBeCloseTo(netAfter, 2);
		await expect(page.getByTestId('payment-receipt')).toHaveCount(0);

		expect(pageErrors, 'no uncaught browser errors during the flow').toEqual([]);
	});
});
