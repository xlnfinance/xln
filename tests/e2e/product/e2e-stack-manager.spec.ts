import { Wallet } from 'ethers';

import { expect, test, type Page } from '../../global-setup.mts';
import { createRuntime, gotoApp } from '../../utils/e2e-demo-users';
import { requireIsolatedBaseUrl } from '../../utils/runtime/e2e-isolated-env';

const APP_BASE_URL = requireIsolatedBaseUrl('E2E_BASE_URL');
const INIT_TIMEOUT = 30_000;

async function openStackManager(page: Page): Promise<void> {
  await gotoApp(page, {
    appBaseUrl: APP_BASE_URL,
    initTimeoutMs: INIT_TIMEOUT,
    settleMs: 500,
  });
  const mnemonic = Wallet.createRandom().mnemonic;
  if (!mnemonic) throw new Error('STACK_MANAGER_E2E_MNEMONIC_UNAVAILABLE');
  await createRuntime(page, `stack-manager-${Date.now()}`, mnemonic.phrase);

  const settingsTab = page.getByTestId('tab-settings').first();
  await expect(settingsTab).toBeVisible({ timeout: INIT_TIMEOUT });
  await settingsTab.click();
  await page.getByTestId('settings-stack-manager-tab').click();
  await expect(page.getByTestId('stack-manager-v1')).toBeVisible({ timeout: INIT_TIMEOUT });
}

test('Stack Manager exposes the canonical deployment workflow at every supported viewport', { tag: '@functional' }, async ({ page }, testInfo) => {
  test.setTimeout(5 * 60 * 1000);
  await openStackManager(page);

  await page.getByTestId('stack-manager-rpc').fill('https://arbitrum.example/rpc');
  await page.getByTestId('stack-manager-name').fill('Community Arbitrum');
  await page.getByText('Advanced deployment parameters', { exact: true }).click();
  await page.getByTestId('stack-manager-key').fill('community-arbitrum');
  await page.getByTestId('stack-manager-publication').selectOption('community');

  for (const viewport of [
    { name: 'iphone', width: 393, height: 852 },
    { name: 'desktop', width: 1440, height: 900 },
    { name: 'wide', width: 1920, height: 1080 },
  ] as const) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await expect(page.getByText('Jurisdiction deployment', { exact: true })).toBeVisible();
    await expect(page.getByTestId('stack-manager-deploy')).toBeDisabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
    expect(await page.getByTestId('stack-manager-v1').evaluate((root) =>
      [...root.querySelectorAll('*')].some((element) => element.getBoundingClientRect().right > window.innerWidth + 1),
    )).toBe(false);
    await page.screenshot({
      path: testInfo.outputPath(`stack-manager-${viewport.name}.png`),
      animations: 'disabled',
      fullPage: true,
    });
  }
});
