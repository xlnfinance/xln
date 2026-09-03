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
import { chromium, type Browser, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const BASE_URL = process.env['UI_BASE_URL'] || 'http://localhost:5183';
const OUT_ROOT = resolve(import.meta.dir, '../../design/screenshots/ui');
const BOOT_TIMEOUT = 180_000;
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

async function enterSandbox(page: Page): Promise<void> {
	await page.goto('/');
	const existing = page.getByRole('button', { name: /Sandbox/ }).first();
	if (await existing.isVisible({ timeout: 2_000 }).catch(() => false)) await existing.click();
	else await page.getByTestId('gate-sandbox').click();
	await page.getByTestId('home-total').waitFor({ timeout: BOOT_TIMEOUT });
	await page.getByTestId('token-net-USDC').waitFor({ timeout: STEP_TIMEOUT });
	// Let the entrance animations finish before the first frame.
	await page.waitForTimeout(600);
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
		await page.screenshot({ path: file, fullPage: true });
		return [file];
	}
	await page.evaluate(() => window.scrollTo(0, 0));
	await page.waitForTimeout(150);
	const files = [join(dir, `${name}.png`)];
	await page.screenshot({ path: files[0]!, fullPage: false });
	const overflow = await page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight);
	if (overflow > 120) {
		await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
		await page.waitForTimeout(250);
		const second = join(dir, `${name}-bottom.png`);
		await page.screenshot({ path: second, fullPage: false });
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
	files.push(...(await shot(page, dir, '01-home', variant)));

	await page.getByTestId('home-pay').click();
	await page.getByTestId('pay-to').fill('Meridian Desk');
	await page.getByTestId('pay-amount').fill('25');
	await page.getByTestId('pay-submit').waitFor();
	await page.getByTestId('pay-submit').isEnabled();
	await page.waitForFunction(() => !(document.querySelector('[data-testid="pay-submit"]') as HTMLButtonElement | null)?.disabled);
	files.push(...(await shot(page, dir, '02-pay', variant)));

	await page.getByTestId('pay-submit').click();
	await page.getByTestId('payment-receipt').waitFor({ timeout: STEP_TIMEOUT });
	await page.getByTestId('receipt-title').waitFor();
	await page.waitForTimeout(500);
	files.push(...(await shot(page, dir, '03-receipt', variant)));
	await page.getByTestId('receipt-done').click();

	await page.getByTestId('home-receive').click();
	files.push(...(await shot(page, dir, '04-receive', variant)));
	await page.goBack();
	await page.getByTestId('home-total').waitFor();

	await page.getByTestId('home-swap').click();
	await page.getByTestId('swap-give').fill('100');
	files.push(...(await shot(page, dir, '05-swap', variant)));
	await page.goBack();
	await page.getByTestId('home-total').waitFor();

	await page.getByTestId('account-row').first().click();
	files.push(...(await shot(page, dir, '06-account', variant)));
	await page.goBack();
	await page.getByTestId('home-total').waitFor();

	await page.getByRole('link', { name: 'Activity' }).first().click();
	await page.getByTestId('activity-row').first().waitFor();
	files.push(...(await shot(page, dir, '07-activity', variant)));
	await page.getByTestId('activity-row').first().click();
	files.push(...(await shot(page, dir, '08-activity-detail', variant)));
	// On mobile the detail opens as a sheet over the tab bar; close it before navigating on.
	if (variant.mobile) {
		await page.keyboard.press('Escape');
		await page.waitForTimeout(300);
	}

	await page.getByRole('link', { name: 'Home' }).first().click();
	await page.getByTestId('home-total').waitFor();
	await page.getByTestId('home-move').click();
	await page.getByTestId('move-amount').waitFor();
	await page.getByTestId('move-amount').fill('250');
	files.push(...(await shot(page, dir, '10-move', variant)));
	// Flows hide the phone tab bar; leave through the back control.
	await page.goBack();
	await page.getByTestId('home-total').waitFor();

	await page.getByRole('link', { name: 'Settings' }).first().click();
	await page.getByText('Dollars per pixel').waitFor();
	files.push(...(await shot(page, dir, '09-settings', variant)));

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
