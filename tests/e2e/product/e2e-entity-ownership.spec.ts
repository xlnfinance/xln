import { Wallet } from 'ethers';

import { expect, test, type Page } from '../../global-setup.mts';
import { createRuntime, gotoApp } from '../../utils/e2e-demo-users';
import { requireIsolatedBaseUrl } from '../../utils/runtime/e2e-isolated-env';

const APP_BASE_URL = requireIsolatedBaseUrl('E2E_BASE_URL');
const INIT_TIMEOUT = 30_000;

async function openOwnership(page: Page): Promise<void> {
  await gotoApp(page, {
    appBaseUrl: APP_BASE_URL,
    initTimeoutMs: INIT_TIMEOUT,
    settleMs: 500,
  });
  const mnemonic = Wallet.createRandom().mnemonic;
  if (!mnemonic) throw new Error('ENTITY_OWNERSHIP_E2E_MNEMONIC_UNAVAILABLE');
  await createRuntime(page, `ownership-${Date.now()}`, mnemonic.phrase);
  await page.getByTestId('tab-ownership').click();
  await expect(page.getByTestId('ownership-panel')).toBeVisible({ timeout: INIT_TIMEOUT });
}

test('Entity ownership keeps share issuance optional and separate from hub listing', { tag: '@functional' }, async ({ page }, testInfo) => {
  test.setTimeout(5 * 60 * 1000);
  await openOwnership(page);

  await expect(page.getByText('No shares issued', { exact: true })).toBeVisible();
  await expect(page.getByText(/Both classes first land in this Entity's Depository reserve/)).toBeVisible();
  await expect(page.getByText(/open an Account with the chosen hub/i)).toHaveCount(0);
  await expect(page.getByRole('button', { name: /join hub|create market|list shares/i })).toHaveCount(0);
  await expect(page.getByTestId('ownership-control-takeover')).toBeVisible();
  await expect(page.getByText('CONTROL governance', { exact: true })).toBeVisible();
  await expect(page.getByText(/First join the target board as a minority validator/i)).toBeVisible();
  await expect(page.getByTestId('ownership-takeover-propose')).toHaveCount(0);
  await expect(page.getByTestId('ownership-takeover-activate')).toHaveCount(0);

  for (const viewport of [
    { name: 'iphone', width: 393, height: 852 },
    { name: 'desktop', width: 1440, height: 900 },
    { name: 'wide', width: 1920, height: 1080 },
  ] as const) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await expect(page.getByTestId('ownership-panel')).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath(`entity-ownership-${viewport.name}.png`),
      animations: 'disabled',
      fullPage: true,
    });
  }
});
