import { test, expect, type Page } from '@playwright/test';
import { Wallet } from 'ethers';
import {
  gotoApp as gotoSharedApp,
  createRuntime as createSharedRuntime,
} from './utils/e2e-demo-users';
import { requireIsolatedBaseUrl } from './utils/e2e-isolated-env';

const APP_BASE_URL = requireIsolatedBaseUrl('E2E_BASE_URL');
const INIT_TIMEOUT = 30_000;

function randomMnemonic(): string {
  return Wallet.createRandom().mnemonic!.phrase;
}

async function gotoApp(page: Page): Promise<void> {
  await gotoSharedApp(page, {
    appBaseUrl: APP_BASE_URL,
    initTimeoutMs: INIT_TIMEOUT,
    settleMs: 500,
  });
}

async function dismissOnboardingIfVisible(page: Page): Promise<void> {
  const checkbox = page.locator('text=I understand and accept the risks of using this software').first();
  if (await checkbox.isVisible({ timeout: 1000 }).catch(() => false)) {
    await checkbox.click();
    const continueBtn = page.locator('button:has-text("Continue")').first();
    if (await continueBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
      await continueBtn.click();
      await page.waitForTimeout(300);
    }
  }
}

test('settings theme select updates document theme and persists selected option', async ({ page }) => {
  await gotoApp(page);
  await dismissOnboardingIfVisible(page);
  await createSharedRuntime(page, `theme-${Date.now()}`, randomMnemonic());

  await page.getByTestId('tab-settings').click();
  await page.getByRole('button', { name: 'Appearance' }).click();
  const select = page.getByTestId('settings-theme-select');
  await expect(select).toBeVisible({ timeout: 20_000 });

  await select.selectOption('light');
  await expect.poll(async () => {
    return await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  }, { timeout: 10_000 }).toBe('light');
  await expect(select).toHaveValue('light');

  await select.selectOption('dark');
  await expect.poll(async () => {
    return await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  }, { timeout: 10_000 }).toBe('dark');
  await expect(select).toHaveValue('dark');
});
