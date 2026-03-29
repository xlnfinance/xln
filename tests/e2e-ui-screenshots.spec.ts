import { devices, expect, test, type BrowserContext, type Page } from '@playwright/test';
import { ensureE2EBaseline, APP_BASE_URL, waitForNamedHubs } from './utils/e2e-baseline';
import { connectRuntimeToHub } from './utils/e2e-connect';
import { createRuntimeIdentity, gotoApp, selectDemoMnemonic } from './utils/e2e-demo-users';
import { capturePageScreenshot } from './utils/e2e-screenshots';

async function openAssetsTab(page: Page): Promise<void> {
  const tab = page.getByTestId('tab-assets').first();
  await expect(tab).toBeVisible({ timeout: 20_000 });
  await tab.click();
  await expect(page.getByTestId('asset-ledger-refresh').first()).toBeVisible({ timeout: 20_000 });
}

async function openAccountsTab(page: Page): Promise<void> {
  const tab = page.getByTestId('tab-accounts').first();
  await expect(tab).toBeVisible({ timeout: 20_000 });
  await tab.click();
  await expect(page.getByTestId('account-list-wrapper').first()).toBeVisible({ timeout: 20_000 });
}

async function openSettingsTab(page: Page): Promise<void> {
  const tab = page.getByTestId('tab-settings').first();
  await expect(tab).toBeVisible({ timeout: 20_000 });
  await tab.click();
  await expect(page.getByRole('button', { name: 'Display' }).first()).toBeVisible({ timeout: 20_000 });
}

async function openAccountWorkspaceTab(page: Page, tabId: string): Promise<void> {
  const testId = `account-workspace-tab-${tabId}`;
  const visibleTab = page.locator(`[data-testid="${testId}"]:visible`).first();
  if (!(await visibleTab.isVisible().catch(() => false))) {
    const mobileToggle = page.getByTestId('account-workspace-mobile-toggle').first();
    if (await mobileToggle.isVisible().catch(() => false)) {
      await mobileToggle.click();
    }
  }
  const tab = page.locator(`[data-testid="${testId}"]:visible`).first();
  await expect(tab).toBeVisible({ timeout: 20_000 });
  await tab.click();
}

async function captureAccountWorkspaces(
  page: Page,
  prefix: string,
  output: Parameters<typeof capturePageScreenshot>[1],
): Promise<void> {
  await openAccountsTab(page);

  await openAccountWorkspaceTab(page, 'send');
  await expect(page.getByTestId('payment-amount-input').first()).toBeVisible({ timeout: 20_000 });
  await capturePageScreenshot(page, output, `${prefix}-accounts-pay.png`);

  await openAccountWorkspaceTab(page, 'receive');
  await expect(page.getByTestId('receive-invoice-amount').first()).toBeVisible({ timeout: 20_000 });
  await capturePageScreenshot(page, output, `${prefix}-accounts-receive.png`);

  await openAccountWorkspaceTab(page, 'swap');
  await expect(page.getByTestId('swap-order-amount').first()).toBeVisible({ timeout: 20_000 });
  await capturePageScreenshot(page, output, `${prefix}-accounts-swap.png`);

  await openAccountWorkspaceTab(page, 'move');
  await expect(page.getByTestId('move-confirm').first()).toBeVisible({ timeout: 20_000 });
  await capturePageScreenshot(page, output, `${prefix}-accounts-move.png`);
}

async function captureMainTabs(
  page: Page,
  prefix: string,
  output: Parameters<typeof capturePageScreenshot>[1],
): Promise<void> {
  await openAssetsTab(page);
  await capturePageScreenshot(page, output, `${prefix}-assets.png`);
  await openAccountsTab(page);
  await capturePageScreenshot(page, output, `${prefix}-accounts.png`);
  const firstDeltaToggle = page.locator('[data-counterparty-id] .delta-capacity-bar[role="button"]').first();
  if (await firstDeltaToggle.isVisible().catch(() => false)) {
    await firstDeltaToggle.click();
    await expect(
      page.locator('[data-counterparty-id] .inline-detail-row, [data-counterparty-id] .inline-details-stack').first(),
    ).toBeVisible({ timeout: 20_000 });
    await capturePageScreenshot(page, output, `${prefix}-accounts-expanded.png`);
  }
  await captureAccountWorkspaces(page, prefix, output);
  await openSettingsTab(page);
  await capturePageScreenshot(page, output, `${prefix}-settings.png`);
}

test('ui screenshot smoke captures desktop and mobile main tabs', async ({ browser, page }, testInfo) => {
  test.setTimeout(240_000);

  await ensureE2EBaseline(page, {
    timeoutMs: 120_000,
    requireHubMesh: true,
    requireMarketMaker: false,
    minHubCount: 3,
  });

  const hubs = await waitForNamedHubs(page, ['H1'], { timeoutMs: 60_000 });

  await gotoApp(page, { appBaseUrl: APP_BASE_URL, initTimeoutMs: 60_000, settleMs: 500 });
  const alice = await createRuntimeIdentity(page, 'alice-visual', selectDemoMnemonic('alice'));
  await connectRuntimeToHub(page, { entityId: alice.entityId, signerId: alice.signerId }, hubs.h1);
  await captureMainTabs(page, 'desktop', testInfo);

  let mobileContext: BrowserContext | null = null;
  try {
    mobileContext = await browser.newContext({
      ...devices['iPhone 15 Pro'],
      ignoreHTTPSErrors: true,
    });
    const mobilePage = await mobileContext.newPage();
    await gotoApp(mobilePage, { appBaseUrl: APP_BASE_URL, initTimeoutMs: 60_000, settleMs: 500 });
    const bob = await createRuntimeIdentity(mobilePage, 'bob-visual', selectDemoMnemonic('bob'));
    await connectRuntimeToHub(mobilePage, { entityId: bob.entityId, signerId: bob.signerId }, hubs.h1);
    await captureMainTabs(mobilePage, 'mobile-iphone15pro', testInfo);
  } finally {
    await mobileContext?.close().catch(() => {});
  }
});
