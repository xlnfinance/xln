#!/usr/bin/env bun
/**
 * Screenshot every main wallet screen in four variants (desktop/mobile ×
 * dark/light) against a running ui dev server, for design review.
 *
 *   cd ui && bun run dev            # in another terminal, serves :5183
 *   bun ui/tools/design-shots.ts    # writes design/screenshots/ui/<variant>/<screen>.png
 *
 * Each variant boots its own sandbox in a fresh browser context, so the shots
 * are reproducible and the payment in the flow never accumulates.
 */
import { HDNodeWallet } from 'ethers';
import { chromium, type Browser, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const BASE_URL = process.env['UI_BASE_URL'] || 'http://localhost:5183';
const OUT_ROOT = resolve(import.meta.dir, '../../design/screenshots/ui');
const BOOT_TIMEOUT = 240_000;
const STEP_TIMEOUT = 60_000;

type Variant = { name: string; width: number; height: number; theme: 'dark' | 'light'; mobile: boolean };

const VARIANTS: Variant[] = [
	{ name: 'desktop-dark', width: 1280, height: 860, theme: 'dark', mobile: false },
	{ name: 'desktop-light', width: 1280, height: 860, theme: 'light', mobile: false },
	{ name: 'mobile-dark', width: 390, height: 844, theme: 'dark', mobile: true },
	{ name: 'mobile-light', width: 390, height: 844, theme: 'light', mobile: true },
];

const only = new Set((process.env['UI_SHOT_VARIANTS'] || '').split(',').map(v => v.trim()).filter(Boolean));

async function assertServer(): Promise<void> {
	try {
		const response = await fetch(BASE_URL);
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
	} catch (error) {
		throw new Error(`UI_DEV_SERVER_UNREACHABLE:${BASE_URL} (start it with: cd ui && bun run dev) — ${String(error)}`);
	}
}

const SHOT_PASSWORD = 'design-shots-local-password';

/** Import a fresh phrase through the public Gate, including the local-password step. */
async function importFresh(page: Page): Promise<void> {
	await page.goto(BASE_URL);
	await page.getByTestId('gate-stack').waitFor({ timeout: 20_000 });
	await page.getByRole('button', { name: /Restore a wallet/ }).click();
	await page.locator('textarea').fill(HDNodeWallet.createRandom().mnemonic?.phrase ?? '');
	await page.locator('button[type="submit"]').click();
	await page.getByRole('heading', { name: 'Set a local password' }).waitFor({ timeout: BOOT_TIMEOUT });
	await page.getByLabel('Password', { exact: true }).fill(SHOT_PASSWORD);
	await page.getByLabel('Confirm password', { exact: true }).fill(SHOT_PASSWORD);
	await page.getByRole('button', { name: 'Save and open', exact: true }).click();
	await page.getByTestId('home-total').waitFor({ timeout: BOOT_TIMEOUT });
}

async function enterSandbox(page: Page): Promise<void> {
	// The wallet is shot on the running stack (bun run dev): a fresh phrase, the account with the stack hub.
	await importFresh(page);
	try {
		await page.getByTestId('account-row').first().waitFor({ timeout: 90_000 });
	} catch (error) {
		// The hub did not answer this wallet in time; a second fresh wallet usually does.
		process.stderr.write(`hub account did not open, retrying with a new wallet: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}\n`);
		await importFresh(page);
		await page.getByTestId('account-row').first().waitFor({ timeout: 90_000 });
	}
}


/** Back to Home through the UI (a reload would lock the vault): the tab where it shows, the back control in a flow. */
async function goHome(page: Page): Promise<void> {
	// A receipt or sheet left open swallows every click that follows.
	const done = page.getByTestId('receipt-done');
	if (await done.isVisible().catch(() => false)) await done.click().catch(() => undefined);
	for (let hops = 0; hops < 4 && !(await page.getByTestId('home-total').isVisible().catch(() => false)); hops += 1) {
		const nav = page.getByTestId('nav-home').locator('visible=true').first();
		const back = page.getByTestId('back').locator('visible=true').first();
		if (await nav.isVisible().catch(() => false)) await nav.click();
		else if (await back.isVisible().catch(() => false)) await back.click();
		else await page.keyboard.press('Escape');
		await page.waitForTimeout(300);
	}
	await page.getByTestId('home-total').waitFor();
}

/** The consent panel: slide to pure credit and extend the limit; gone once the hub countersigns. */
async function grantCapacity(page: Page): Promise<void> {
	const spectrum = page.getByTestId('receive-spectrum');
	if (!(await spectrum.isVisible().catch(() => false))) return;
	// Pure credit: the preset button works with touch emulation too, where End on the slider does not.
	await page.getByRole('button', { name: '0% collateral', exact: true }).click();
	const confirm = page.getByTestId('receive-spectrum-confirm');
	await confirm.waitFor({ timeout: 10_000 });
	await confirm.click();
	await spectrum.waitFor({ state: 'detached', timeout: 60_000 });
}

async function waitEnabled(page: Page, testId: string, timeout = 60_000): Promise<void> {
	await page.waitForFunction(
		id => !(document.querySelector(`[data-testid="${id}"]`) as HTMLButtonElement | null)?.disabled,
		testId,
		{ timeout },
	);
}

async function openAssets(page: Page): Promise<void> {
	await goHome(page);
	await page.getByTestId('nav-manage').locator('visible=true').first().click();
	await page.getByTestId('manage-assets').click();
	await page.getByTestId('faucets').waitFor();
}

/** Text of a Home total, as a number. */
async function homeNumber(page: Page, testId: string): Promise<number> {
	const text = (await page.getByTestId(testId).textContent().catch(() => '')) ?? '';
	return Number(text.replace(/[^0-9.]/g, '')) || 0;
}

/** Live in the wallet for a minute: the same actions the guided tour asks for, on the real stack. */
async function liveIn(page: Page): Promise<void> {
	const at = (step: string): void => { process.stderr.write(`  live-in: ${step}\n`); };
	// Credit line + $100 from the hub.
	at('credit + faucet');
	await openAssets(page);
	await page.getByTestId('faucet-amount').fill('100');
	await grantCapacity(page);
	await waitEnabled(page, 'faucet-offchain', 30_000);
	await page.getByTestId('faucet-offchain').click();
	// Gas and a $100 reserve on the chain.
	await page.getByTestId('faucet-gas').click();
	await page.waitForTimeout(800);
	await page.getByTestId('faucet-reserve').click();
	await goHome(page);
	await page.getByTestId('token-net-USDC').waitFor({ timeout: 90_000 });
	// Pay $25 to another hub.
	at('pay');
	await page.getByTestId('home-pay').click();
	await page.getByTestId('pay-to').click();
	await page.getByTestId('pay-suggestion-H2').first().click();
	await page.getByTestId('pay-amount').fill('25');
	await waitEnabled(page, 'pay-submit', 60_000);
	await page.getByTestId('pay-submit').click();
	await page.getByTestId('payment-receipt').waitFor({ timeout: 60_000 }).catch(() => undefined);
	if (await page.getByTestId('receipt-done').isVisible().catch(() => false)) await page.getByTestId('receipt-done').click();
	// A $40 bill paid by the hub (the network faucet stands in for the payer).
	at('bill');
	await openAssets(page);
	await page.getByTestId('faucet-amount').fill('40');
	await grantCapacity(page);
	await waitEnabled(page, 'faucet-offchain', 30_000);
	await page.getByTestId('faucet-offchain').click();
	await goHome(page);
	// $100 of reserve into the hub account as collateral (the reserve faucet needs a block and a watcher poll to land).
	await page.waitForTimeout(6_000);
	at('move');
	await page.getByTestId('home-move').click();
	await page.getByTestId('move-amount').fill('60');
	await waitEnabled(page, 'move-now', 30_000);
	await page.getByTestId('move-now').click();
	await goHome(page);
	// One swap at the best ask, with consent for the coin we receive.
	await page.getByTestId('home-swap').click();
	const book = page.getByTestId('orderbook').locator('visible=true').first();
	await page.waitForFunction(() => document.querySelector('[data-testid="orderbook"]')?.getAttribute('data-status') === 'live', undefined, { timeout: 60_000 });
	at('swap');
	// A small ticket at the best price: the phone layout keeps the book folded, so the ticket quotes itself.
	const askRow = book.locator('.bk-row.ask').last();
	if (await askRow.isVisible().catch(() => false)) await askRow.click();
	await page.getByTestId('swap-give').fill('20');
	await page.waitForTimeout(600);
	await grantCapacity(page);
	await waitEnabled(page, 'swap-submit', 60_000);
	await page.getByTestId('swap-submit').click();
	await page.waitForTimeout(2_500);
	await goHome(page);
	// Let the fills and receipts land.
	await page.waitForTimeout(4_000);
}

/**
 * Desktop: one full-page frame. Mobile: viewport frames (the fixed tab bar
 * would otherwise be painted mid-page), plus a second frame scrolled one
 * viewport down when the page is taller than the screen.
 */
async function shot(page: Page, dir: string, name: string, variant: Variant): Promise<string[]> {
	await page.waitForTimeout(350);
	if (!variant.mobile) {
		const file = join(dir, `${name}.png`);
		await page.screenshot({ path: file, fullPage: true, animations: 'disabled' });
		return [file];
	}
	await page.evaluate(() => window.scrollTo(0, 0));
	await page.waitForTimeout(150);
	const files = [join(dir, `${name}.png`)];
	await page.screenshot({ path: files[0]!, fullPage: false, animations: 'disabled' });
	const overflow = await page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight);
	if (overflow > 120) {
		await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
		await page.waitForTimeout(250);
		const second = join(dir, `${name}-bottom.png`);
		await page.screenshot({ path: second, fullPage: false, animations: 'disabled' });
		files.push(second);
		await page.evaluate(() => window.scrollTo(0, 0));
	}
	return files;
}

async function captureVariant(browser: Browser, variant: Variant): Promise<string[]> {
	const dir = join(OUT_ROOT, variant.name);
	await mkdir(dir, { recursive: true });
	const context = await browser.newContext({
		baseURL: BASE_URL,
		viewport: { width: variant.width, height: variant.height },
		deviceScaleFactor: variant.mobile ? 2 : 1,
		colorScheme: variant.theme,
		isMobile: variant.mobile,
		hasTouch: variant.mobile,
	});
	await context.addInitScript((theme: string) => {
		window.localStorage.setItem('xln-ui-theme', theme);
	}, variant.theme);
	const page = await context.newPage();
	page.setDefaultTimeout(STEP_TIMEOUT);
	const files: string[] = [];
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.message));

	await enterSandbox(page);
	// A lived-in wallet, the way the tour leaves it: consent, hub credit, a payment, a bill paid, reserve + gas,
	// collateral, one swap. Reviewers judge the product, not an empty $0.00 shell.
	try {
		await liveIn(page);
	} catch (error) {
		process.stderr.write(`[${variant.name}] live-in incomplete: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}\n`);
	}
	await goHome(page);
	files.push(...(await shot(page, dir, '01-home', variant)));

	const home = (): Promise<void> => goHome(page);
	// Each screen is its own attempt: on a live stack a flow may be blocked (no funds yet, a hub offline);
	// the review still gets every other screen, and the skipped ones are named.
	const attempt = async (name: string, flow: () => Promise<void>): Promise<void> => {
		try {
			await flow();
			files.push(...(await shot(page, dir, name, variant)));
		} catch (error) {
			process.stderr.write(`[${variant.name}] skip ${name}: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}\n`);
		}
	};
	await attempt('02-pay', async () => {
		await page.getByTestId('home-pay').click();
		await page.getByTestId('pay-to').fill('H2');
		await page.getByTestId('pay-amount').fill('25');
		await page.getByTestId('pay-submit').waitFor();
		await page.waitForFunction(() => !(document.querySelector('[data-testid="pay-submit"]') as HTMLButtonElement | null)?.disabled, undefined, { timeout: 20_000 });
	});
	await attempt('03-receipt', async () => {
		if (!(await page.getByTestId('pay-submit').isEnabled().catch(() => false))) throw new Error('payment not possible on this stack yet');
		await page.getByTestId('pay-submit').click();
		await page.getByTestId('payment-receipt').waitFor({ timeout: 60_000 });
		await page.getByTestId('receipt-title').waitFor();
		await page.waitForTimeout(500);
	});
	if (await page.getByTestId('receipt-done').isVisible().catch(() => false)) await page.getByTestId('receipt-done').click();
	await home();
	await attempt('04-receive', async () => {
		await page.getByTestId('home-receive').click();
		await page.getByTestId('receive-amount').waitFor();
	});
	await home();
	await attempt('05-swap', async () => {
		await page.getByTestId('home-swap').click();
		await page.getByTestId('swap-give').fill('100');
		await page.waitForTimeout(1_500);
	});
	await home();
	await attempt('05b-swap-cross', async () => {
		await page.getByTestId('home-swap').click();
		const cross = page.getByRole('button', { name: 'Across networks', exact: true });
		await cross.waitFor({ timeout: 10_000 });
		if (await cross.isDisabled()) throw new Error('no entity on another network yet');
		await cross.click();
		const open = page.getByRole('button', { name: /Open incoming account with/ });
		if (await open.isVisible().catch(() => false)) {
			await open.click();
			await open.waitFor({ state: 'detached', timeout: 90_000 }).catch(() => undefined);
		}
		await page.getByTestId('swap-give').fill('20');
		await page.waitForTimeout(1_500);
	});
	await home();
	await attempt('06-account', async () => {
		await page.getByTestId('account-row').first().click();
		await page.getByTestId('account-status').waitFor();
	});
	await attempt('06b-dispute', async () => {
		await page.getByTestId('account-dispute').click();
		await page.getByTestId('dispute-prepare').waitFor({ timeout: 10_000 });
		await page.waitForTimeout(900);
	});
	await page.keyboard.press('Escape');
	await page.waitForTimeout(300);
	await home();
	await attempt('07-activity', async () => {
		await page.getByRole('link', { name: 'Activity' }).first().click();
		await page.getByTestId('activity-row').first().waitFor({ timeout: 20_000 });
	});
	// On a wide screen the detail is the right-hand panel already shown in 07; only the phone opens a separate sheet.
	if (variant.mobile) {
		await attempt('08-activity-detail', async () => {
			await page.getByTestId('activity-row').first().click();
			await page.waitForTimeout(400);
		});
	}
	if (variant.mobile) {
		await page.keyboard.press('Escape');
		await page.waitForTimeout(300);
	}
	await home();
	await attempt('10-move', async () => {
		await page.getByTestId('home-move').click();
		await page.getByTestId('move-amount').waitFor();
		await page.getByTestId('move-amount').fill('25');
	});
	await home();
	await attempt('11-manage', async () => {
		await page.getByRole('link', { name: 'Manage' }).first().click();
		await page.getByTestId('attention').waitFor();
	});
	await attempt('12-assets', async () => {
		await page.getByTestId('manage-assets').click();
		await page.getByTestId('faucets').waitFor();
		await page.waitForTimeout(1_500);
	});
	await home();
	await attempt('13-lend', async () => {
		await page.getByRole('link', { name: 'Manage' }).first().click();
		await page.getByTestId('manage-lend').click();
		await page.getByTestId('lend-submit').waitFor();
	});
	await home();
	await attempt('14-ownership', async () => {
		await page.getByRole('link', { name: 'Manage' }).first().click();
		await page.getByTestId('manage-ownership').click();
		await page.getByTestId('board').waitFor();
	});
	await home();
	await attempt('15-sovereignty', async () => {
		await page.getByRole('link', { name: 'Manage' }).first().click();
		await page.getByTestId('manage-sovereignty').click();
		await page.getByTestId('sovereignty-hero').waitFor();
	});
	if (!variant.mobile) {
		await attempt('16-desk', async () => {
			await page.getByRole('link', { name: 'Settings' }).first().click();
			await page.getByTestId('density-desk').click();
			await page.getByRole('link', { name: 'Home' }).first().click();
			await page.getByTestId('desk-table').waitFor();
		});
		await attempt('17-palette', async () => {
			await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k');
			await page.getByTestId('palette').waitFor();
		});
		await page.keyboard.press('Escape');
		await page.getByRole('link', { name: 'Settings' }).first().click();
		await page.getByTestId('density-comfort').click();
	}
	await attempt('09-settings', async () => {
		await goHome(page);
		const tab = page.getByTestId('nav-settings').locator('visible=true').first();
		if (await tab.isVisible().catch(() => false)) await tab.click({ timeout: 10_000 }).catch(() => undefined);
		if (!page.url().endsWith('/settings')) {
			// Client-side navigation keeps the vault unlocked (a reload would lock it).
			await page.evaluate(() => {
				window.history.pushState({}, '', '/settings');
				window.dispatchEvent(new PopStateEvent('popstate'));
			});
		}
		await page.getByText('Bar scale').waitFor();
	});

	await context.close();
	if (errors.length > 0) {
		await writeFile(join(dir, 'page-errors.txt'), errors.join('\n'));
		process.stderr.write(`[${variant.name}] ${errors.length} page error(s) recorded in page-errors.txt\n`);
	}
	return files;
}

async function main(): Promise<void> {
	await assertServer();
	const browser = await chromium.launch({ args: ['--disable-gpu', '--use-gl=swiftshader'] });
	const started = Date.now();
	const manifest: Record<string, string[]> = {};
	try {
		for (const variant of VARIANTS) {
			if (only.size > 0 && !only.has(variant.name)) continue;
			const t0 = Date.now();
			manifest[variant.name] = await captureVariant(browser, variant);
			process.stdout.write(`${variant.name}: ${manifest[variant.name]!.length} shots in ${((Date.now() - t0) / 1000).toFixed(1)} s\n`);
		}
	} finally {
		await browser.close();
	}
	await writeFile(join(OUT_ROOT, 'manifest.json'), JSON.stringify({ baseUrl: BASE_URL, takenAt: new Date().toISOString(), variants: manifest }, null, 2));
	process.stdout.write(`done in ${((Date.now() - started) / 1000).toFixed(1)} s → ${OUT_ROOT}\n`);
}

main().catch(error => {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
});
