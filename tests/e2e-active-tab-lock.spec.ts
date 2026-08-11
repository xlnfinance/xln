import { expect, test, type BrowserContext, type Page } from './global-setup.mts';
import { APP_BASE_URL, ensureE2EBaseline } from './utils/e2e-baseline';
import { closeRuntimeContext } from './utils/e2e-runtime-shutdown.mts';

async function openApp(page: Page, path: string): Promise<void> {
  await page.goto(`${APP_BASE_URL}${path}`, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('body')).toBeVisible({ timeout: 30_000 });
}

async function waitUntilOwnsActiveLock(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const tabId = window.sessionStorage.getItem('xln-tab-id');
    const owner = window.sessionStorage.getItem('xln-active-tab-owned');
    return Boolean(tabId && owner === tabId);
  }, undefined, { timeout: 10_000 });
}

async function waitForEmbeddedRuntime(page: Page): Promise<string> {
  await expect
    .poll(() => page.evaluate(() => {
      const debug = window as typeof window & {
        isolatedEnv?: { runtimeId?: unknown };
        __xln?: { adapter?: { status?: () => { connected?: boolean; runtimeId?: unknown } } };
      };
      const status = debug.__xln?.adapter?.status?.();
      const runtimeId = String(status?.runtimeId || debug.isolatedEnv?.runtimeId || '').trim();
      return status?.connected === true && runtimeId.length > 0;
    }), { timeout: 30_000, intervals: [250, 500, 1000] })
    .toBe(true);
  return page.evaluate(() => {
    const debug = window as typeof window & {
      isolatedEnv?: { runtimeId?: unknown };
      __xln?: { adapter?: { status?: () => { runtimeId?: unknown } } };
    };
    return String(debug.__xln?.adapter?.status?.().runtimeId || debug.isolatedEnv?.runtimeId || '').trim();
  });
}

function inactiveTabScreen(page: Page) {
  return page.getByTestId('inactive-tab-screen');
}

test.describe('Active tab lock handoff', () => {
  test('second /app tab takes ownership and first becomes inactive', { tag: '@resilience' }, async ({ browser }) => {
    const context: BrowserContext = await browser.newContext({ ignoreHTTPSErrors: true });
    const first = await context.newPage();
    const second = await context.newPage();

    try {
      await ensureE2EBaseline(first, { requireHubMesh: true });
      await openApp(first, '/app?locktest=1');
      await waitUntilOwnsActiveLock(first);
      await openApp(second, '/app?locktest=1');
      await waitUntilOwnsActiveLock(second);

      await expect(inactiveTabScreen(first)).toBeVisible({ timeout: 30_000 });
      await expect(inactiveTabScreen(second)).toHaveCount(0);
    } finally {
      await closeRuntimeContext(context);
    }
  });

  test('inactive tab stays inert until explicit active-lock claim', { tag: '@resilience' }, async ({ browser }) => {
    const context: BrowserContext = await browser.newContext({ ignoreHTTPSErrors: true });
    const first = await context.newPage();
    const second = await context.newPage();

    try {
      await ensureE2EBaseline(first, { requireHubMesh: true });
      await openApp(first, '/app?locktest=1');
      await waitUntilOwnsActiveLock(first);
      await openApp(second, '/app?locktest=1');
      await waitUntilOwnsActiveLock(second);

      await expect(inactiveTabScreen(first)).toBeVisible({ timeout: 30_000 });
      await expect(inactiveTabScreen(second)).toHaveCount(0);

      await first.bringToFront();
      await first.waitForTimeout(1500);
      await expect(inactiveTabScreen(first)).toBeVisible();
      await expect(inactiveTabScreen(second)).toHaveCount(0);

      await first.getByTestId('inactive-tab-acquire').click();
      await expect(inactiveTabScreen(second)).toBeVisible({ timeout: 30_000 });
      await expect(inactiveTabScreen(first)).toHaveCount(0);
    } finally {
      await closeRuntimeContext(context);
    }
  });

  test('pay deeplink path also participates in ownership handoff', { tag: '@resilience' }, async ({ browser }) => {
    const context: BrowserContext = await browser.newContext({ ignoreHTTPSErrors: true });
    const first = await context.newPage();
    const second = await context.newPage();
    const targetEntityId = `0x${'1'.repeat(64)}`;

    try {
      await ensureE2EBaseline(first, { requireHubMesh: true });
      await openApp(first, '/app?locktest=1');
      await waitUntilOwnsActiveLock(first);
      await openApp(
        second,
        `/app?locktest=1#pay/${encodeURIComponent(`${targetEntityId}?token=1&amount=1`)}`,
      );
      await waitUntilOwnsActiveLock(second);

      await expect(inactiveTabScreen(first)).toBeVisible({ timeout: 30_000 });
      await expect(inactiveTabScreen(second)).toHaveCount(0);
    } finally {
      await closeRuntimeContext(context);
    }
  });

  test('projection route cannot evict an active embedded Runtime owner', { tag: '@resilience' }, async ({ browser }) => {
    const context: BrowserContext = await browser.newContext({ ignoreHTTPSErrors: true });
    const wallet = await context.newPage();
    const projection = await context.newPage();

    try {
      await ensureE2EBaseline(wallet, { requireHubMesh: true });
      await openApp(wallet, '/app');
      await waitUntilOwnsActiveLock(wallet);
      const runtimeId = await waitForEmbeddedRuntime(wallet);

      await wallet.evaluate(() => {
        const view = window as typeof window & { __xlnDocumentMarker?: string };
        view.__xlnDocumentMarker = 'same-document';
        const link = document.createElement('a');
        link.href = '/address';
        document.body.appendChild(link);
        link.click();
      });
      await wallet.waitForURL((url) => url.pathname === '/address', { timeout: 10_000 });
      expect(await wallet.evaluate(() => (
        window as typeof window & { __xlnDocumentMarker?: string }
      ).__xlnDocumentMarker)).toBe('same-document');
      await expect(wallet.getByRole('heading', { name: 'XLN Address Directory' })).toBeVisible();
      expect(await waitForEmbeddedRuntime(wallet)).toBe(runtimeId);

      await openApp(projection, '/address');

      await expect(projection.getByText('LOCAL_RUNTIME_ACTIVE_IN_ANOTHER_TAB')).toBeVisible({ timeout: 10_000 });
      await waitUntilOwnsActiveLock(wallet);
      expect(await waitForEmbeddedRuntime(wallet)).toBe(runtimeId);
      await projection.waitForTimeout(1_500);
      expect(await projection.evaluate(() => {
        const debug = window as typeof window & {
          __xln?: { adapter?: { status?: () => { connected?: boolean } } };
        };
        return debug.__xln?.adapter?.status?.().connected === true;
      })).toBe(false);
    } finally {
      await closeRuntimeContext(context);
    }
  });
});
