import { devices, expect, test, type BrowserContext, type Page } from '@playwright/test';
import { ensureE2EBaseline, APP_BASE_URL, waitForNamedHubs } from './utils/e2e-baseline';
import { connectRuntimeToHubWithCredit } from './utils/e2e-connect';
import { createRuntimeIdentity, gotoApp, selectDemoMnemonic } from './utils/e2e-demo-users';
import { captureLocatorScreenshot, capturePageScreenshot } from './utils/e2e-screenshots';

const SWAP_CONNECT_TOKEN_IDS = [1, 2, 3] as const;

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

async function readSwapScopeMode(page: Page): Promise<'aggregated' | 'selected' | ''> {
  const raw = String(await page.getByTestId('swap-scope-toggle').first().getAttribute('data-scope-mode') || '').trim();
  return raw === 'aggregated' || raw === 'selected' ? raw : '';
}

async function ensureSwapScope(page: Page, desired: 'aggregated' | 'selected'): Promise<void> {
  const scopeToggle = page.getByTestId('swap-scope-toggle').first();
  await expect(scopeToggle).toBeVisible({ timeout: 20_000 });
  if (await readSwapScopeMode(page) === desired) return;
  if (!await scopeToggle.isEnabled().catch(() => false)) return;
  try {
    await expect
      .poll(async () => {
        const current = await readSwapScopeMode(page);
        if (current !== desired) {
          await scopeToggle.click({ force: true });
          await page.waitForTimeout(150);
        }
        return await readSwapScopeMode(page);
      }, { timeout: 5_000, intervals: [50, 100, 200] })
      .toBe(desired);
  } catch {
    // Mobile layouts can make the scope control hard to operate; the screenshot
    // gate below still requires a terminal ready book with visible ask/bid rows.
  }
}

async function expectSwapOrderbookReady(page: Page): Promise<void> {
  const orderbook = page.getByTestId('swap-orderbook').first();
  const panel = orderbook.locator('.orderbook-panel').first();
  await expect(orderbook).toBeVisible({ timeout: 20_000 });
  await expect(panel).toBeVisible({ timeout: 20_000 });
  await ensureSwapScope(page, 'aggregated');
  await expect
    .poll(async () => String(await panel.getAttribute('data-source-status') || ''), {
      timeout: 30_000,
      intervals: [250, 500, 1000],
      message: 'swap visual evidence must not capture a loading orderbook',
    })
    .toBe('ready');
  await expect
    .poll(async () => ({
      asks: await page.getByTestId('orderbook-ask-row').count(),
      bids: await page.getByTestId('orderbook-bid-row').count(),
    }), {
      timeout: 30_000,
      intervals: [250, 500, 1000],
      message: 'swap visual evidence must include visible ask and bid depth',
    })
    .toEqual({ asks: expect.any(Number), bids: expect.any(Number) });
  await expect
    .poll(async () => {
      const asks = await page.getByTestId('orderbook-ask-row').count();
      const bids = await page.getByTestId('orderbook-bid-row').count();
      return asks > 0 && bids > 0;
    }, {
      timeout: 30_000,
      intervals: [250, 500, 1000],
      message: 'swap visual evidence must include visible ask and bid depth',
    })
    .toBe(true);
  await expect(page.getByTestId('orderbook-source-status').first()).not.toContainText(/syncing|loading/i, {
    timeout: 5_000,
  });
}

async function closeSwapMenus(page: Page): Promise<void> {
  await page.keyboard.press('Escape').catch(() => {});
  await page.locator('.swap-panel').first().click({ position: { x: 4, y: 4 } }).catch(() => {});
}

async function captureSwapVisualStates(
  page: Page,
  prefix: string,
  output: Parameters<typeof capturePageScreenshot>[1],
): Promise<void> {
  await openAccountWorkspaceTab(page, 'swap');
  await expect(page.getByTestId('swap-order-amount').first()).toBeVisible({ timeout: 20_000 });
  await expectSwapOrderbookReady(page);
  const swapPanel = page.locator('.swap-panel').first();
  await captureLocatorScreenshot(swapPanel, output, `${prefix}-swap-base.png`);

  const sourceButton = page.locator('.swap-panel .anyswap-builder .entity-select-wrap').first()
    .locator('button.entity-select-button').first();
  await sourceButton.click();
  await expect(page.locator('.swap-panel .entity-menu[aria-label="Source account"]').first()).toBeVisible({ timeout: 10_000 });
  await captureLocatorScreenshot(swapPanel, output, `${prefix}-swap-source-menu.png`);
  await closeSwapMenus(page);

  const tokenButton = page.locator('.swap-panel .token-select-wrap button.token-select-button').first();
  await tokenButton.click();
  await expect(page.locator('.swap-panel .token-menu').first()).toBeVisible({ timeout: 10_000 });
  await captureLocatorScreenshot(swapPanel, output, `${prefix}-swap-token-menu.png`);
  await closeSwapMenus(page);

  await page.locator('.swap-panel .route-menu-button').first().click();
  await expect(page.locator('.swap-panel .route-menu').first()).toBeVisible({ timeout: 10_000 });
  await captureLocatorScreenshot(swapPanel, output, `${prefix}-swap-route-menu.png`);
  await closeSwapMenus(page);

  await page.locator('.swap-panel .hub-select-wrap button.entity-select-button').first().click();
  await expect(page.locator('.swap-panel .hub-menu').first()).toBeVisible({ timeout: 10_000 });
  await captureLocatorScreenshot(swapPanel, output, `${prefix}-swap-hub-menu.png`);
  await closeSwapMenus(page);
}

async function connectVisualRuntimeToHubs(
  page: Page,
  identity: { entityId: string; signerId: string },
  hubIds: string[],
): Promise<void> {
  for (const hubId of hubIds) {
    await connectRuntimeToHubWithCredit(page, identity, hubId, '10000', SWAP_CONNECT_TOKEN_IDS);
  }
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

  await captureSwapVisualStates(page, prefix, output);

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

async function captureOnboardingScreens(page: Page, output: Parameters<typeof capturePageScreenshot>[1]): Promise<void> {
  await gotoApp(page, { appBaseUrl: APP_BASE_URL, initTimeoutMs: 60_000, settleMs: 500 });
  await expect(page.getByRole('heading', { name: /Create XLN wallet/i }).first()).toBeVisible({ timeout: 30_000 });
  await capturePageScreenshot(page, output, 'desktop-onboarding-seed.png');

  const seed = selectDemoMnemonic('dave');
  await page.evaluate(async ({ label, mnemonic }) => {
    const operations = (window as typeof window & {
      __xlnVaultOperations?: {
        createRuntime?: (name: string, seed: string, options?: Record<string, unknown>) => Promise<unknown>;
      };
    }).__xlnVaultOperations;
    if (typeof operations?.createRuntime !== 'function') {
      throw new Error('__xlnVaultOperations.createRuntime unavailable for onboarding screenshot');
    }
    await operations.createRuntime(label, mnemonic, {
      loginType: 'manual',
      requiresOnboarding: true,
    });
  }, { label: 'visual-onboarding', mnemonic: seed });

  await expect(page.getByRole('heading', { name: /Configure account/i }).first()).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('brainvault-onboarding-recovery').first()).toBeVisible({ timeout: 20_000 });
  await capturePageScreenshot(page, output, 'desktop-onboarding-account-config.png');
}

test('ui screenshot smoke captures onboarding screens', async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  await captureOnboardingScreens(page, testInfo);
});

test('ui screenshot smoke captures desktop and mobile main tabs', async ({ browser, page }, testInfo) => {
  test.setTimeout(240_000);

  await ensureE2EBaseline(page, {
    timeoutMs: 120_000,
    requireHubMesh: true,
    requireMarketMaker: true,
    minHubCount: 3,
  });

  const hubs = await waitForNamedHubs(page, ['H1', 'H2', 'H3'], { timeoutMs: 60_000 });
  const hubIds = [hubs.h1, hubs.h2, hubs.h3];

  await gotoApp(page, { appBaseUrl: APP_BASE_URL, initTimeoutMs: 60_000, settleMs: 500 });
  const alice = await createRuntimeIdentity(page, 'alice-visual', selectDemoMnemonic('alice'));
  await connectVisualRuntimeToHubs(page, { entityId: alice.entityId, signerId: alice.signerId }, hubIds);
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
    await connectVisualRuntimeToHubs(mobilePage, { entityId: bob.entityId, signerId: bob.signerId }, hubIds);
    await captureMainTabs(mobilePage, 'mobile-iphone15pro', testInfo);
  } finally {
    await mobileContext?.close().catch(() => {});
  }
});
