/**
 * E2E for the design presets: each axis is one attribute on <html>, the
 * tokens follow, the choice survives a reload, and the default comes back.
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

const cssVar = (page: Page, name: string): Promise<string> => page.evaluate(variable => getComputedStyle(document.documentElement).getPropertyValue(variable).trim(), name);

test.describe('wallet UI design presets', () => {
	test('material, accent, numbers and risk color switch live and persist', { tag: '@functional' }, async ({ page }) => {
		const pageErrors: string[] = [];
		page.on('pageerror', error => pageErrors.push(error.message));

		await enterSandbox(page);
		await page.getByRole('link', { name: 'Settings' }).first().click();
		await expect(page.getByTestId('design-sample')).toBeVisible();
		const html = page.locator('html');
		await expect(html).toHaveAttribute('data-material', 'obsidian');
		const indigo = await cssVar(page, '--accent');

		await page.getByTestId('design-material-terminal').click();
		await expect(html).toHaveAttribute('data-material', 'terminal');
		expect(await cssVar(page, '--accent')).not.toBe(indigo);

		await page.getByTestId('design-material-obsidian').click();
		await page.getByTestId('design-accent-brass').click();
		await expect(html).toHaveAttribute('data-accent', 'brass');
		expect(await cssVar(page, '--accent')).toBe('#c9a962');

		await page.getByTestId('design-risk-red').click();
		await expect(html).toHaveAttribute('data-risk', 'red');
		expect(await cssVar(page, '--risk')).toBe('#f26d6d');

		await page.getByTestId('design-numbers-serif').click();
		await expect(html).toHaveAttribute('data-numbers', 'serif');
		expect(await cssVar(page, '--font-num')).toContain('Fraunces');

		// Survives a reload, before React mounts.
		await page.reload();
		await expect(html).toHaveAttribute('data-accent', 'brass');
		await expect(html).toHaveAttribute('data-risk', 'red');
		await expect(html).toHaveAttribute('data-numbers', 'serif');

		// The reload locks the vault; re-enter the sandbox, then put the stock look back for other specs.
		await enterSandbox(page);
		await page.getByRole('link', { name: 'Settings' }).first().click();
		await page.getByTestId('design-accent-indigo').click();
		await page.getByTestId('design-risk-violet').click();
		await page.getByTestId('design-numbers-sans').click();
		await expect(html).toHaveAttribute('data-accent', 'indigo');

		expect(pageErrors, 'no uncaught browser errors during the flow').toEqual([]);
	});
});
