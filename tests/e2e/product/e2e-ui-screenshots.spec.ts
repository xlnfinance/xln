import { devices, expect, test, type BrowserContext, type Page } from '../../global-setup.mts';
import { ensureE2EBaseline, API_BASE_URL, APP_BASE_URL, waitForNamedHubs } from '../../utils/e2e-baseline';
import { gotoApp, selectDemoMnemonic } from '../../utils/e2e-demo-users';
import { resolveRuntimeImportAppUrl } from '../../utils/runtime/e2e-runtime-import';
import { capturePageScreenshot } from '../../utils/e2e-screenshots';
import { captureReactWalletScreens } from '../../utils/browser/visual/wallet-screenshots';

const LAPTOP_VIEWPORT = { width: 1440, height: 900 } as const;
const WIDE_VIEWPORT = { width: 2560, height: 1440 } as const;

const platformFromPrefix = (prefix: string): 'desktop' | 'mobile' =>
  prefix.startsWith('mobile') ? 'mobile' : 'desktop';

const uxDescription = (description: string): string => description;

async function captureUxPage(
  page: Page,
  output: Parameters<typeof capturePageScreenshot>[1],
  name: string,
  metadata: {
    title: string;
    group: string;
    description: string;
    platform?: 'desktop' | 'mobile';
    tags?: string[];
    fullPage?: boolean;
  },
): Promise<void> {
  await capturePageScreenshot(page, output, name, {
    fullPage: metadata.fullPage ?? false,
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
  let lastError = '';
  await expect.poll(async () => {
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
      const body = await response.text();
      if (response.ok() && /^\s*\{.*"result"\s*:\s*"0x[0-9a-f]+".*\}\s*$/i.test(body)) return true;
      lastError = `status=${response.status()} body=${body}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    return false;
  }, {
    timeout: timeoutMs,
    intervals: [100, 250, 500, 1_000],
    message: `/rpc did not become reachable before health screenshot: ${lastError}`,
  }).toBe(true);
}

async function captureTestnetTools(
  page: Page,
  output: Parameters<typeof capturePageScreenshot>[1],
  prefix: string,
): Promise<void> {
  const platform = platformFromPrefix(prefix);
  await page.goto(`${APP_BASE_URL}/testnet`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'xln Testnet' })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('heading', { name: 'Test identities' })).toBeVisible({ timeout: 30_000 });
  await captureUxPage(page, output, `${prefix}-testnet-tools.png`, {
    title: `${prefix} testnet tools`,
    group: 'Testnet',
    description: uxDescription('Testnet entry points, disposable identities, and explicit local reset control.'),
    platform,
    tags: ['testnet', 'demo identities', 'reset'],
    fullPage: true,
  });
}

async function captureOnboardingScreens(
  page: Page,
  output: Parameters<typeof capturePageScreenshot>[1],
  prefix: string,
): Promise<void> {
  const platform = platformFromPrefix(prefix);
  await gotoApp(page, { appBaseUrl: APP_BASE_URL, initTimeoutMs: 60_000, settleMs: 500 });
  await expect(page.getByRole('heading', { name: /Create XLN wallet/i }).first()).toBeVisible({ timeout: 30_000 });
  await captureUxPage(page, output, `${prefix}-onboarding-seed.png`, {
    title: `${prefix} onboarding seed`,
    group: 'Onboarding',
    description: uxDescription('New operator creates a browser runtime wallet.'),
    platform,
    tags: ['onboarding', 'wallet'],
    fullPage: true,
  });

  const demoIdentity = prefix.startsWith('mobile')
    ? 'bob'
    : prefix === 'wide'
      ? 'carol'
      : prefix === 'laptop'
        ? 'alice'
        : 'dave';
  const seed = selectDemoMnemonic(demoIdentity);
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
  await expect(page.getByRole('heading', { name: /Default limits/i }).first()).toBeVisible({ timeout: 20_000 });
  await captureUxPage(page, output, `${prefix}-onboarding-account-config.png`, {
    title: `${prefix} account configuration`,
    group: 'Onboarding',
    description: uxDescription('Minimal public identity and default account limits before entering the wallet.'),
    platform,
    tags: ['onboarding', 'account limits'],
    fullPage: true,
  });
}

test('ui screenshot smoke captures onboarding and testnet tools across viewports', { tag: '@functional' }, async ({ browser, page }, testInfo) => {
  test.setTimeout(360_000);
  await captureTestnetTools(page, testInfo, 'desktop');
  await captureOnboardingScreens(page, testInfo, 'desktop');

  let laptopContext: BrowserContext | null = null;
  let wideContext: BrowserContext | null = null;
  let mobileContext: BrowserContext | null = null;
  try {
    laptopContext = await browser.newContext({
      viewport: LAPTOP_VIEWPORT,
      ignoreHTTPSErrors: true,
    });
    const laptopPage = await laptopContext.newPage();
    await captureTestnetTools(laptopPage, testInfo, 'laptop');
    await captureOnboardingScreens(laptopPage, testInfo, 'laptop');

    wideContext = await browser.newContext({
      viewport: WIDE_VIEWPORT,
      ignoreHTTPSErrors: true,
    });
    const widePage = await wideContext.newPage();
    await captureTestnetTools(widePage, testInfo, 'wide');
    await captureOnboardingScreens(widePage, testInfo, 'wide');

    mobileContext = await browser.newContext({
      ...devices['iPhone 15 Pro'],
      ignoreHTTPSErrors: true,
    });
    const mobilePage = await mobileContext.newPage();
    await captureTestnetTools(mobilePage, testInfo, 'mobile-iphone15pro');
    await captureOnboardingScreens(mobilePage, testInfo, 'mobile-iphone15pro');
  } finally {
    await mobileContext?.close();
    await wideContext?.close();
    await laptopContext?.close();
  }
});

test('ui screenshot smoke captures operator admin surfaces', { tag: '@functional' }, async ({ page }, testInfo) => {
  test.setTimeout(120_000);

  // QA tooling is deliberately absent from production servers (2b2c1081c).
  // Its direct handler tests own the cockpit; this stand owns Health and Observer.
  const qaResponse = await page.request.get(`${APP_BASE_URL}/api/qa/catalog`);
  expect(qaResponse.status(), 'Production must not expose the offline QA API').toBe(404);

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

  await ensureE2EBaseline(page, {
    timeoutMs: 120_000,
    requireHubMesh: true,
    requireMarketMaker: true,
    requireCustody: true,
    minHubCount: 3,
  });

  const importUrl = await resolveRuntimeImportAppUrl(page, {
    appBaseUrl: APP_BASE_URL,
    apiBaseUrl: API_BASE_URL,
    access: 'admin',
  });
  expect(importUrl).toContain('/app#runtime-import');
  expect(importUrl).not.toContain('/radapter/manage');
  // Operator selectors and Time Machine belong to Observer; /app alone opens the React wallet.
  const observerUrl = new URL(importUrl);
  observerUrl.searchParams.set('observer', '1');
  await page.goto(observerUrl.toString(), { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => sessionStorage.getItem('xln-remote-runtime-import-last-result') !== null, null, {
    timeout: 30_000,
  });
  const importSummary = await page.evaluate(
    () =>
      JSON.parse(sessionStorage.getItem('xln-remote-runtime-import-last-result')!) as {
        ok: boolean;
        count: number;
        failedCount: number;
        entries: Array<{ label: string }>;
        failed: unknown[];
      },
  );
  const nativeH1 = process.env['XLN_HLT_ENGINE'] === 'rust';
  const expectedLabels = ['Custody', 'H1', 'H2', 'H3', 'MM'];
  expect(importSummary, 'Every supported admin adapter must import without failures').toMatchObject({
    ok: true,
    count: expectedLabels.length,
    failedCount: 0,
    failed: [],
  });
  expect(importSummary.entries.map(entry => entry.label).sort()).toEqual(expectedLabels);
  if (nativeH1) {
    const healthResponse = await page.request.get(`${API_BASE_URL}/api/health`);
    expect(healthResponse.ok()).toBe(true);
    const aggregate = await healthResponse.json();
    const h1 = aggregate.hubs.find((hub: { name: string }) => hub.name === 'H1');
    expect(h1).toMatchObject({ name: 'H1', online: true });
    const infoResponse = await page.request.get(`${h1.apiUrl}/api/info`);
    const nativeHealthResponse = await page.request.get(`${h1.apiUrl}/api/health`);
    expect(infoResponse.ok()).toBe(true);
    expect(nativeHealthResponse.ok()).toBe(true);
    const info = await infoResponse.json();
    const health = await nativeHealthResponse.json();
    expect(info).toMatchObject({ name: 'H1', runtimeId: h1.runtimeId, entityId: h1.entityId, deliveryReady: true });
    expect(info.height).toBeGreaterThan(0);
    expect(info.workers).toBeGreaterThan(0);
    expect(info.runtimeFrameHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(info.accountsRoot).toMatch(/^0x[0-9a-f]{64}$/);
    expect(health).toMatchObject({
      ok: true,
      runtimeId: h1.runtimeId,
      entityId: h1.entityId,
      runtime: { halted: false, lifecyclePhase: 'ready' },
    });
    await testInfo.attach('native-h1-operator.json', {
      body: JSON.stringify({ info, health }),
      contentType: 'application/json',
    });
  }
  const runtimeSelect = page.getByRole('combobox', { name: 'Graph runtime view', exact: true });
  await expect(runtimeSelect).toBeVisible({ timeout: 30_000 });
  // Import registers adapters before their authenticated graph projections finish loading.
  await expect(runtimeSelect.locator('option')).toHaveText(
    ['Merged (5)', ...expectedLabels.map(label => `${label} · remote`)],
    { timeout: 30_000 },
  );
  await runtimeSelect.selectOption({ label: 'H1 · remote' });
  await expect(runtimeSelect.locator('option:checked')).toHaveText('H1 · remote');
  const h1RuntimeId = await runtimeSelect.inputValue();
  await expect(page.getByTestId('time-machine-remote-runtime')).toHaveValue(h1RuntimeId);
  await captureUxPage(page, testInfo, 'desktop-remote-runtime-import.png', {
    title: 'desktop remote runtime import',
    group: 'Remote Runtime Import',
    description: uxDescription(
      'Observer after importing every supported remote admin adapter; native H1 uses its verified operator HTTP surface.',
    ),
    platform: 'desktop',
    tags: ['remote-runtime', 'wallet', 'bulk-import'],
  });
  await page.goto(`${APP_BASE_URL}/app?observer=1`, { waitUntil: 'domcontentloaded' });
  await runtimeSelect.selectOption({ label: 'H1 · remote' });
  await expect(runtimeSelect).toHaveValue(h1RuntimeId);
  await expect(page.getByTestId('time-machine-remote-runtime')).toHaveValue(h1RuntimeId);
  await expect(page.locator('.time-machine')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('time-machine-remote-scan')).toBeVisible({ timeout: 30_000 });
  await page.getByRole('tab', { name: '🩺 Diagnostics', exact: true }).click();
  const diagnostics = page.getByTestId('runtime-diagnostics-panel');
  await expect(diagnostics).toBeVisible();
  const persisted = diagnostics
    .locator('article')
    .filter({
      has: page.getByText('Persisted', { exact: true }),
    })
    .locator('strong');
  await expect(persisted).toHaveText(/^[1-9]\d*$/);
  const persistedHeight = Number(await persisted.textContent());
  expect(persistedHeight).toBeGreaterThan(0);
  const heightInput = page.getByTestId('time-machine-remote-height');
  await heightInput.fill(String(persistedHeight));
  await page.getByTestId('time-machine-remote-scan-button').click();
  await expect(page.getByTestId('time-machine-remote-scan-status')).toContainText(`h${persistedHeight}`, {
    timeout: 30_000,
  });
  await expect(page.getByTestId('time-machine-remote-scan-status')).not.toContainText(/failed|not found/i);
  await captureUxPage(page, testInfo, 'desktop-time-machine.png', {
    title: 'desktop time machine',
    group: 'Time Machine',
    description: uxDescription('Workspace time machine enabled for historical frame scrubbing and replay.'),
    platform: 'desktop',
    tags: ['time-machine', 'debug', 'history'],
  });
});

test('ui screenshot smoke captures main tabs across viewports', { tag: '@functional' }, async ({ browser, page }, testInfo) => {
  test.setTimeout(600_000);

  await ensureE2EBaseline(page, {
    timeoutMs: 120_000,
    requireHubMesh: true,
    requireMarketMaker: true,
    minHubCount: 3,
  });

  const hubs = await waitForNamedHubs(page, ['H1', 'H2', 'H3'], { timeoutMs: 60_000 });
  const hubIds = [hubs.h1, hubs.h2, hubs.h3];

  await captureReactWalletScreens(page, APP_BASE_URL, hubIds, 'desktop', testInfo);

  let laptopContext: BrowserContext | null = null;
  let wideContext: BrowserContext | null = null;
  let mobileContext: BrowserContext | null = null;
  try {
    laptopContext = await browser.newContext({
      viewport: LAPTOP_VIEWPORT,
      ignoreHTTPSErrors: true,
    });
    const laptopPage = await laptopContext.newPage();
    await captureReactWalletScreens(laptopPage, APP_BASE_URL, hubIds, 'laptop', testInfo);

    wideContext = await browser.newContext({
      viewport: WIDE_VIEWPORT,
      ignoreHTTPSErrors: true,
    });
    const widePage = await wideContext.newPage();
    await captureReactWalletScreens(widePage, APP_BASE_URL, hubIds, 'wide', testInfo);

    mobileContext = await browser.newContext({
      ...devices['iPhone 15 Pro'],
      ignoreHTTPSErrors: true,
    });
    const mobilePage = await mobileContext.newPage();
    await captureReactWalletScreens(mobilePage, APP_BASE_URL, hubIds, 'mobile-iphone15pro', testInfo);
  } finally {
    await mobileContext?.close();
    await wideContext?.close();
    await laptopContext?.close();
  }
});
