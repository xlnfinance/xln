import { test, expect, type Page } from './global-setup';
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

  await page.goto(`${APP_BASE_URL}/app#settings/display`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('tab-settings')).toBeVisible({ timeout: INIT_TIMEOUT });
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

test('settings toggles the xln guide without leaving the workspace', async ({ page }, testInfo) => {
  await gotoApp(page);
  await dismissOnboardingIfVisible(page);
  await createSharedRuntime(page, `guide-${Date.now()}`, randomMnemonic());

  await page.goto(`${APP_BASE_URL}/app#settings/display`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('tab-settings')).toBeVisible({ timeout: INIT_TIMEOUT });
  const toggle = page.getByTestId('settings-xln-mascot-toggle');
  await expect(toggle).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('xln-mascot-root')).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath('laptop-settings-guide-visible.png'),
    animations: 'disabled',
  });

  await toggle.uncheck();
  await expect(toggle).not.toBeChecked();
  await expect(page.getByTestId('xln-mascot-root')).toHaveCount(0);
  await page.waitForTimeout(200);
  await page.screenshot({
    path: testInfo.outputPath('laptop-settings-guide-hidden.png'),
    animations: 'disabled',
  });
  await toggle.check();
  await expect(toggle).toBeChecked();
  await expect(page.getByTestId('xln-mascot-root')).toBeVisible();

  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('settings-xln-mascot-toggle')).toBeChecked({ timeout: 20_000 });
  await expect(page.getByTestId('xln-mascot-root')).toBeVisible();
  await page.setViewportSize({ width: 393, height: 852 });
  await expect(page.getByTestId('settings-xln-mascot-toggle')).toBeVisible();
  const mobileToggleBox = await page.getByTestId('settings-xln-mascot-toggle').boundingBox();
  const mobileMascotBox = await page.getByTestId('xln-mascot-root').boundingBox();
  expect(mobileToggleBox).not.toBeNull();
  expect(mobileMascotBox).not.toBeNull();
  expect(
    mobileToggleBox!.x + mobileToggleBox!.width <= mobileMascotBox!.x ||
      mobileToggleBox!.x >= mobileMascotBox!.x + mobileMascotBox!.width ||
      mobileToggleBox!.y + mobileToggleBox!.height <= mobileMascotBox!.y ||
      mobileToggleBox!.y >= mobileMascotBox!.y + mobileMascotBox!.height,
    'the mobile mascot must not cover its own visibility toggle',
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath('iphone-settings-guide-visible.png'),
    animations: 'disabled',
  });
});
