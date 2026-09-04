/**
 * E2E for the guided tour, played the way a person would: every action and
 * every navigation is done through the real controls the ring points at. The
 * tour must release each step from the runtime's state and finish.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';

const BOOT_TIMEOUT = 180_000;
const STEP_TIMEOUT = 90_000;

async function currentStep(tour: Locator): Promise<string> {
	return (await tour.isVisible().catch(() => false)) ? (await tour.getAttribute('data-step')) ?? '' : 'closed';
}

async function untilNot(tour: Locator, step: string): Promise<string> {
	await expect.poll(() => currentStep(tour), { timeout: STEP_TIMEOUT }).not.toBe(step);
	return currentStep(tour);
}

/** Follow the ring: press whatever the tour points at until it points at `wanted`. */
async function followTo(page: Page, tour: Locator, wanted: string): Promise<void> {
	await expect.poll(() => tour.getAttribute('data-target'), { timeout: 20_000 }).not.toBe('');
	for (let hops = 0; hops < 6; hops += 1) {
		const target = (await tour.getAttribute('data-target')) ?? '';
		if (target === wanted) return;
		if (!target) throw new Error(`tour points at nothing while heading to ${wanted}`);
		await page.getByTestId(target).locator('visible=true').first().click({ timeout: 15_000 });
		await expect.poll(() => tour.getAttribute('data-target'), { timeout: 20_000 }).not.toBe(target);
	}
	throw new Error(`could not reach ${wanted}`);
}

async function answerQuiz(page: Page): Promise<void> {
	const options = page.getByTestId('tour-quiz-option');
	const count = await options.count();
	for (let position = 0; position < count; position += 1) {
		await options.nth(position).click();
		if (await page.getByTestId('tour-next').isEnabled()) break;
	}
	await page.getByTestId('tour-next').click();
}

async function takeLevel(page: Page, side: 'ask' | 'bid'): Promise<void> {
	const book = page.getByTestId('orderbook').locator('visible=true').first();
	await expect(book).toHaveAttribute('data-status', 'live', { timeout: STEP_TIMEOUT });
	const rows = book.locator(`.bk-row.${side}`);
	await expect(rows.first()).toBeVisible({ timeout: STEP_TIMEOUT });
	await (side === 'ask' ? rows.last() : rows.first()).click();
	const submit = page.getByTestId('swap-submit');
	await expect(submit).toBeEnabled({ timeout: STEP_TIMEOUT });
	await submit.click();
}

test.describe('wallet UI guided tour', () => {
	test('a person walks the whole tour with the real controls', { tag: '@functional' }, async ({ page }) => {
		test.setTimeout(900_000);
		const pageErrors: string[] = [];
		page.on('pageerror', error => pageErrors.push(error.message));
		// A halted runtime looks like a stuck tour; the browser console names the invariant that halted it.
		page.on('console', message => {
			if (message.type() === 'error') process.stdout.write(`[browser] ${message.text().slice(0, 400)}\n`);
		});

		await page.goto('/');
		const existing = page.getByRole('button', { name: /^Sandbox/ }).first();
		if (await existing.isVisible({ timeout: 2_000 }).catch(() => false)) {
			await existing.click();
			await expect(page.getByTestId('home-total')).toBeVisible({ timeout: BOOT_TIMEOUT });
			await page.getByTestId('nav-settings').locator('visible=true').first().click();
			await page.getByTestId('tour-replay').click();
			await page.getByTestId('nav-home').locator('visible=true').first().click();
		} else {
			await page.getByTestId('gate-learn').click();
			await expect(page.getByTestId('home-total')).toBeVisible({ timeout: BOOT_TIMEOUT });
		}
		const tour = page.getByTestId('tour');
		await expect(tour).toHaveAttribute('data-step', 'welcome', { timeout: STEP_TIMEOUT });
		await expect(page.locator('.tour-scrim')).toHaveCount(0);
		// The tour never presses anything for the user.
		await expect(page.getByTestId('tour-auto')).toHaveCount(0);

		const visited: string[] = [];
		let step = 'welcome';
		for (let guard = 0; guard < 40 && step !== 'closed'; guard += 1) {
			visited.push(step);
			switch (step) {
				case 'quiz-colors':
				case 'quiz-hub-dark':
					await answerQuiz(page);
					break;
				case 'keys':
					await followTo(page, tour, 'home-sovereignty');
					await page.getByTestId('home-sovereignty').click();
					break;
				case 'faucet':
					await followTo(page, tour, 'faucet-offchain');
					await page.getByTestId('faucet-offchain').click();
					break;
				case 'pay':
					await followTo(page, tour, 'pay-to');
					await page.getByTestId('pay-to').click();
					await page.locator('[data-testid^="pay-suggestion-Meridian"]').first().click();
					await page.getByTestId('pay-amount').fill('25');
					await expect(page.getByTestId('pay-submit')).toBeEnabled({ timeout: STEP_TIMEOUT });
					await page.getByTestId('pay-submit').click();
					break;
				case 'receipt':
					await expect(page.getByTestId('tour-next')).toBeEnabled({ timeout: STEP_TIMEOUT });
					if (await page.getByTestId('receipt-done').isVisible().catch(() => false)) await page.getByTestId('receipt-done').click();
					await page.getByTestId('tour-next').click();
					break;
				case 'receive':
					await followTo(page, tour, 'receive-amount');
					await page.getByTestId('receive-amount').fill('40');
					break;
				case 'move':
					// Reserve → Account are the defaults; the ring goes straight to the amount when they already hold.
					await followTo(page, tour, 'move-amount');
					await page.getByTestId('move-amount').fill('100');
					await expect(page.getByTestId('move-now')).toBeEnabled();
					await page.getByTestId('move-now').click();
					break;
				case 'rebalance':
					await followTo(page, tour, 'account-manage');
					await page.getByTestId('account-manage').click();
					await page.getByTestId('collateral-amount').fill('500');
					await expect(page.getByTestId('collateral-request')).toBeEnabled({ timeout: STEP_TIMEOUT });
					await page.getByTestId('collateral-request').click();
					break;
				case 'trade': {
					await followTo(page, tour, 'orderbook');
					await takeLevel(page, 'ask');
					await expect(page.getByTestId('tour-count')).toContainText('1 / 3', { timeout: STEP_TIMEOUT });
					await takeLevel(page, 'bid');
					await expect(page.getByTestId('tour-count')).toContainText('2 / 3', { timeout: STEP_TIMEOUT });
					await takeLevel(page, 'ask');
					break;
				}
				case 'dispute':
					await followTo(page, tour, 'account-manage');
					await page.getByTestId('account-manage').click();
					await page.getByTestId('manage-tab-dispute').click();
					await page.getByTestId('dispute-prepare').click();
					await page.getByTestId('dispute-prepare-confirm').click();
					break;
				case 'dispute-batch':
					await followTo(page, tour, 'batch-broadcast');
					await expect(page.getByTestId('batch-broadcast')).toBeEnabled({ timeout: STEP_TIMEOUT });
					await page.getByTestId('batch-broadcast').click();
					break;
				default: {
					// A read step: walk to where the ring points, then turn the page.
					await expect.poll(() => tour.getAttribute('data-target'), { timeout: 20_000 }).not.toBe('');
					for (let hops = 0; hops < 6 && !(await page.getByTestId('tour-next').isEnabled()); hops += 1) {
						const target = (await tour.getAttribute('data-target')) ?? '';
						if (!target) break;
						const control = page.getByTestId(target).locator('visible=true').first();
						if (!(await control.isVisible().catch(() => false))) {
							await page.waitForTimeout(400);
							continue;
						}
						await control.click({ timeout: 15_000 });
						await page.waitForTimeout(400);
					}
					await expect(page.getByTestId('tour-next')).toBeEnabled({ timeout: STEP_TIMEOUT });
					await page.getByTestId('tour-next').click();
				}
			}
			step = await untilNot(tour, step);
		}

		console.log('TOUR STEPS:', visited.join(' → '));
		expect(visited).toEqual(expect.arrayContaining(['faucet', 'pay', 'receive', 'move', 'trade', 'quiz-hub-dark', 'dispute', 'dispute-batch', 'watchtower', 'finish']));
		expect(step).toBe('closed');
		await page.getByTestId('nav-settings').locator('visible=true').first().click();
		await expect(page.getByText('Finished once.')).toBeVisible();
		expect(pageErrors, 'no uncaught browser errors during the flow').toEqual([]);
	});
});
