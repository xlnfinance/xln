import { devices, expect, test, type BrowserContext, type Page } from './global-setup';
import { ensureE2EBaseline, API_BASE_URL, APP_BASE_URL, waitForNamedHubs } from './utils/e2e-baseline';
import { connectRuntimeToHubWithCredit } from './utils/e2e-connect';
import { createRuntimeIdentity, gotoApp, selectDemoMnemonic } from './utils/e2e-demo-users';
import { resolveRuntimeImportAppUrl } from './utils/e2e-runtime-import';
import { captureLocatorScreenshot, capturePageScreenshot } from './utils/e2e-screenshots';

const SWAP_CONNECT_TOKEN_IDS = [1, 2, 3] as const;

const platformFromPrefix = (prefix: string): 'desktop' | 'mobile' =>
  prefix.startsWith('mobile') ? 'mobile' : 'desktop';

const uxDescription = (description: string): string => description;

async function captureUxPage(
  page: Page,
  output: Parameters<typeof capturePageScreenshot>[1],
  name: string,
  metadata: { title: string; group: string; description: string; platform?: 'desktop' | 'mobile'; tags?: string[] },
): Promise<void> {
  await capturePageScreenshot(page, output, name, {
    fullPage: false,
    ux: {
      title: metadata.title,
      group: metadata.group,
      description: metadata.description,
      platform: metadata.platform ?? (name.startsWith('mobile') ? 'mobile' : 'desktop'),
      tags: metadata.tags,
    },
  });
}

async function waitForRpcProxyReachable(page: Page, timeoutMs = 30_000): Promise<void> {
  const startedAt = Date.now();
  let lastError = '';
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await page.request.post(`${APP_BASE_URL}/rpc`, {
        data: {
          jsonrpc: '2.0',
          id: 1,
          method: 'eth_chainId',
          params: [],
        },
        headers: { 'Cache-Control': 'no-store' },
        timeout: 5_000,
      });
      const body = await response.json().catch(() => null) as { result?: unknown; error?: unknown } | null;
      if (response.ok() && typeof body?.result === 'string' && body.result.length > 0) return;
      lastError = `status=${response.status()} body=${JSON.stringify(body)}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await page.waitForTimeout(250);
  }
  throw new Error(`/rpc did not become reachable before health screenshot: ${lastError}`);
}

async function captureUxLocator(
  locator: Parameters<typeof captureLocatorScreenshot>[0],
  output: Parameters<typeof captureLocatorScreenshot>[1],
  name: string,
  metadata: { title: string; group: string; description: string; platform?: 'desktop' | 'mobile'; tags?: string[] },
): Promise<void> {
  await captureLocatorScreenshot(locator, output, name, {
    ux: {
      title: metadata.title,
      group: metadata.group,
      description: metadata.description,
      platform: metadata.platform ?? (name.startsWith('mobile') ? 'mobile' : 'desktop'),
      tags: metadata.tags,
    },
  });
}

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
  const platform = platformFromPrefix(prefix);
  await openAccountWorkspaceTab(page, 'swap');
  await expect(page.getByTestId('swap-order-amount').first()).toBeVisible({ timeout: 20_000 });
  await expectSwapOrderbookReady(page);
  const swapPanel = page.locator('.swap-panel').first();
  await captureUxLocator(swapPanel, output, `${prefix}-swap-base.png`, {
    title: `${platform} swap ticket`,
    group: 'Swap',
    description: uxDescription('Prepared cross-chain swap ticket with live orderbook depth.'),
    platform,
    tags: ['swap', 'orderbook'],
  });

  const sourceButton = page.locator('.swap-panel .anyswap-builder .entity-select-wrap').first()
    .locator('button.entity-select-button').first();
  await sourceButton.click();
  await expect(page.locator('.swap-panel .entity-menu[aria-label="Source account"]').first()).toBeVisible({ timeout: 10_000 });
  await captureUxLocator(swapPanel, output, `${prefix}-swap-source-menu.png`, {
    title: `${platform} swap source picker`,
    group: 'Swap',
    description: uxDescription('Source account menu while preparing a routed swap.'),
    platform,
    tags: ['swap', 'account-picker'],
  });
  await closeSwapMenus(page);

  const tokenButton = page.locator('.swap-panel .token-select-wrap button.token-select-button').first();
  await tokenButton.click();
  await expect(page.locator('.swap-panel .token-menu').first()).toBeVisible({ timeout: 10_000 });
  await captureUxLocator(swapPanel, output, `${prefix}-swap-token-menu.png`, {
    title: `${platform} swap token picker`,
    group: 'Swap',
    description: uxDescription('Token selector with balances during swap preparation.'),
    platform,
    tags: ['swap', 'token-picker'],
  });
  await closeSwapMenus(page);

  await page.locator('.swap-panel .route-menu-button').first().click();
  await expect(page.locator('.swap-panel .route-menu').first()).toBeVisible({ timeout: 10_000 });
  await captureUxLocator(swapPanel, output, `${prefix}-swap-route-menu.png`, {
    title: `${platform} swap route menu`,
    group: 'Swap',
    description: uxDescription('Route selector for cross-chain liquidity paths.'),
    platform,
    tags: ['swap', 'route'],
  });
  await closeSwapMenus(page);

  await page.locator('.swap-panel .hub-select-wrap button.entity-select-button').first().click();
  await expect(page.locator('.swap-panel .hub-menu').first()).toBeVisible({ timeout: 10_000 });
  await captureUxLocator(swapPanel, output, `${prefix}-swap-hub-menu.png`, {
    title: `${platform} swap hub menu`,
    group: 'Swap',
    description: uxDescription('Hub selector showing available market-making venues.'),
    platform,
    tags: ['swap', 'hub'],
  });
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
  const platform = platformFromPrefix(prefix);
  await openAccountsTab(page);

  await openAccountWorkspaceTab(page, 'send');
  await expect(page.getByTestId('payment-amount-input').first()).toBeVisible({ timeout: 20_000 });
  await captureUxPage(page, output, `${prefix}-accounts-pay.png`, {
    title: `${platform} payment composer`,
    group: 'Payments',
    description: uxDescription('User prepares a payment from an open hub account.'),
    platform,
    tags: ['payment', 'account'],
  });

  await openAccountWorkspaceTab(page, 'receive');
  await expect(page.getByTestId('receive-invoice-amount').first()).toBeVisible({ timeout: 20_000 });
  await captureUxPage(page, output, `${prefix}-accounts-receive.png`, {
    title: `${platform} receive request`,
    group: 'Payments',
    description: uxDescription('User prepares a receive invoice for inbound liquidity.'),
    platform,
    tags: ['payment', 'invoice'],
  });

  await captureSwapVisualStates(page, prefix, output);

  await openAccountWorkspaceTab(page, 'move');
  await expect(page.getByTestId('move-confirm').first()).toBeVisible({ timeout: 20_000 });
  await captureUxPage(page, output, `${prefix}-accounts-move.png`, {
    title: `${platform} asset move ticket`,
    group: 'On-chain Batch',
    description: uxDescription('Move ticket for reserve, collateral, and external token flows.'),
    platform,
    tags: ['move', 'batch'],
  });

  await openAccountWorkspaceTab(page, 'history');
  await expect(page.locator('.history-card').first()).toBeVisible({ timeout: 20_000 });
  await captureUxPage(page, output, `${prefix}-accounts-history.png`, {
    title: `${platform} on-chain batch history`,
    group: 'History',
    description: uxDescription('History view for finalized and pending on-chain account batches.'),
    platform,
    tags: ['history', 'batch'],
  });

  await openAccountWorkspaceTab(page, 'configure');
  const disputeTab = page.locator('[data-testid="configure-tab-dispute"]:visible').first();
  await expect(disputeTab).toBeVisible({ timeout: 20_000 });
  await disputeTab.click();
  await expect(page.locator('[data-testid="configure-dispute-prepare"]:visible, [data-testid="configure-dispute-start"]:visible').first()).toBeVisible({ timeout: 20_000 });
  await captureUxPage(page, output, `${prefix}-accounts-dispute-controls.png`, {
    title: `${platform} dispute controls`,
    group: 'Disputes',
    description: uxDescription('Account management panel for preparing and starting a dispute.'),
    platform,
    tags: ['dispute', 'account'],
  });
}

async function captureMainTabs(
  page: Page,
  prefix: string,
  output: Parameters<typeof capturePageScreenshot>[1],
): Promise<void> {
  const platform = platformFromPrefix(prefix);
  await openAssetsTab(page);
  await expect(page.getByTestId('external-wallet-source').first()).toContainText(/Snapshot J#\d+/, {
    timeout: 30_000,
  });
  await captureUxPage(page, output, `${prefix}-assets.png`, {
    title: `${platform} assets ledger`,
    group: 'Portfolio',
    description: uxDescription('Portfolio ledger with external, reserve, and account balances.'),
    platform,
    tags: ['assets', 'balances'],
  });
  await openAccountsTab(page);
  await captureUxPage(page, output, `${prefix}-accounts.png`, {
    title: `${platform} accounts overview`,
    group: 'Accounts',
    description: uxDescription('Hub account list with balances and counterparty capacity.'),
    platform,
    tags: ['accounts', 'credit'],
  });
  const firstDeltaToggle = page.locator('[data-counterparty-id] .delta-capacity-bar[role="button"]').first();
  if (await firstDeltaToggle.isVisible().catch(() => false)) {
    await firstDeltaToggle.click();
    await expect(
      page.locator('[data-counterparty-id] .inline-detail-row, [data-counterparty-id] .inline-details-stack').first(),
    ).toBeVisible({ timeout: 20_000 });
    await captureUxPage(page, output, `${prefix}-accounts-expanded.png`, {
      title: `${platform} account capacity detail`,
      group: 'Accounts',
      description: uxDescription('Expanded account row showing directional credit capacity.'),
      platform,
      tags: ['accounts', 'capacity'],
    });
  }
  await captureAccountWorkspaces(page, prefix, output);
  await openSettingsTab(page);
  await captureUxPage(page, output, `${prefix}-settings.png`, {
    title: `${platform} wallet settings`,
    group: 'Settings',
    description: uxDescription('Wallet settings and display controls for the runtime.'),
    platform,
    tags: ['settings'],
  });
}

async function captureOnboardingScreens(page: Page, output: Parameters<typeof capturePageScreenshot>[1]): Promise<void> {
  await gotoApp(page, { appBaseUrl: APP_BASE_URL, initTimeoutMs: 60_000, settleMs: 500 });
  await expect(page.getByRole('heading', { name: /Create XLN wallet/i }).first()).toBeVisible({ timeout: 30_000 });
  await captureUxPage(page, output, 'desktop-onboarding-seed.png', {
    title: 'desktop onboarding seed',
    group: 'Onboarding',
    description: uxDescription('New operator creates a browser runtime wallet.'),
    platform: 'desktop',
    tags: ['onboarding', 'wallet'],
  });

  const seed = selectDemoMnemonic('dave');
  await page.evaluate(async ({ label, mnemonic }) => {
    const operations = (window as any).__xln?.vault as {
      createRuntime?: (name: string, seed: string, options?: Record<string, unknown>) => Promise<unknown>;
    } | undefined;
    if (typeof operations?.createRuntime !== 'function') {
      throw new Error('__xln.vault.createRuntime unavailable for onboarding screenshot');
    }
    await operations.createRuntime(label, mnemonic, {
      loginType: 'manual',
      requiresOnboarding: true,
    });
  }, { label: 'visual-onboarding', mnemonic: seed });

  await expect(page.getByRole('heading', { name: /Configure account/i }).first()).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('brainvault-onboarding-recovery').first()).toBeVisible({ timeout: 20_000 });
  await captureUxPage(page, output, 'desktop-onboarding-account-config.png', {
    title: 'desktop account configuration',
    group: 'Onboarding',
    description: uxDescription('Recovery and account setup screen before entering the wallet.'),
    platform: 'desktop',
    tags: ['onboarding', 'recovery'],
  });
}

test('ui screenshot smoke captures onboarding screens', async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  await captureOnboardingScreens(page, testInfo);
});

test('ui screenshot smoke captures operator admin surfaces', async ({ page }, testInfo) => {
  test.setTimeout(120_000);

  await page.goto(`${APP_BASE_URL}/qa`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'Test Cockpit' })).toBeVisible({ timeout: 30_000 });
  await captureUxPage(page, testInfo, 'desktop-qa-cockpit.png', {
    title: 'desktop QA cockpit',
    group: 'QA Cockpit',
    description: uxDescription('Operator QA cockpit with run ledger, gallery, failures, and benchmarks.'),
    platform: 'desktop',
    tags: ['qa', 'cockpit', 'evidence'],
  });

  await waitForRpcProxyReachable(page);
  await page.goto(`${APP_BASE_URL}/health`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: /xln health admin/i })).toBeVisible({ timeout: 30_000 });
  await captureUxPage(page, testInfo, 'desktop-health-admin.png', {
    title: 'desktop health admin',
    group: 'Health',
    description: uxDescription('Health admin summary for runtime, relay, hubs, custody, and QA links.'),
    platform: 'desktop',
    tags: ['health', 'admin'],
  });

  const importUrl = await resolveRuntimeImportAppUrl(page, {
    appBaseUrl: APP_BASE_URL,
    apiBaseUrl: API_BASE_URL,
    access: 'read',
  });
  expect(importUrl).toContain('/app#runtime-import');
  expect(importUrl).not.toContain('/radapter/manage');
  await page.goto(importUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => {
    const raw = sessionStorage.getItem('xln-remote-runtime-import-last-result');
    if (!raw) return false;
    const summary = JSON.parse(raw) as { ok?: boolean; count?: number; failedCount?: number };
    return summary.ok === true && Number(summary.count || 0) >= 5 && Number(summary.failedCount || 0) === 0;
  }, null, { timeout: 120_000 });
  await expect(page.getByTestId('context-current')).toBeVisible({ timeout: 30_000 });
  await captureUxPage(page, testInfo, 'desktop-remote-runtime-import.png', {
    title: 'desktop remote runtime import',
    group: 'Remote Runtime Import',
    description: uxDescription('Wallet app after same-origin remote runtime import adds H1/H2/H3/MM/Custody to the runtime list.'),
    platform: 'desktop',
    tags: ['remote-runtime', 'wallet', 'bulk-import'],
  });

  await page.addInitScript(() => {
    localStorage.setItem('xln-settings', JSON.stringify({ showTimeMachine: true }));
  });
  await page.goto(`${APP_BASE_URL}/embed`, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.time-machine')).toBeVisible({ timeout: 30_000 });
  await captureUxPage(page, testInfo, 'desktop-time-machine.png', {
    title: 'desktop time machine',
    group: 'Time Machine',
    description: uxDescription('Workspace time machine enabled for historical frame scrubbing and replay.'),
    platform: 'desktop',
    tags: ['time-machine', 'debug', 'history'],
  });
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
