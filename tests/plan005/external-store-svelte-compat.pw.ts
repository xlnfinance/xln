import { expect, test } from '@playwright/test';

test('Svelte compatibility adapter boots the wallet entry without browser errors', async ({ page }, testInfo) => {
  await page.route('**/api/jurisdictions**', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      deployVersion: 'plan005-browser-contract',
      networkVersion: 'plan005-browser-contract',
      defaults: {},
      jurisdictions: {},
    }),
  }));
  await page.route('**/api/runtime-import**', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ ready: true, manifest: { entries: [] } }),
  }));

  const browserErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') browserErrors.push(`console:${message.text()}`);
  });
  page.on('pageerror', (error) => browserErrors.push(`page:${error.message}`));

  await page.goto('/app', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: /Create XLN wallet/i }).first()).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: testInfo.outputPath('wallet-entry.png'), fullPage: true });

  expect(browserErrors).toEqual([]);
});
