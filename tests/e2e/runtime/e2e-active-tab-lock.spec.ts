import type { RuntimeAdapterInspection } from '../../../ui/src/runtime/adapter';
import type { RuntimeReplica } from '../../../core/api/public/runtime-module';
import { createWalletIdentity, LOCAL_PASSWORD } from '../../../ui/tests/wallet-ui';
import { gotoApp, selectDemoMnemonic } from '../../utils/e2e-demo-users';
import { expect, test, type BrowserContext, type Page } from '../../global-setup.mts';
import { APP_BASE_URL, ensureE2EBaseline } from '../../utils/e2e-baseline';
import { closeRuntimeContext } from '../../utils/runtime/e2e-runtime-shutdown.mts';

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
  const read = () =>
    page.evaluate(() => {
      const debug = (
        window as Window & {
          __xln?: { adapter: () => RuntimeAdapterInspection | null };
        }
      ).__xln;
      if (!debug) throw new Error('WALLET_DIAGNOSTICS_UNAVAILABLE');
      const adapter = debug.adapter();
      if (!adapter || adapter.status !== 'connected') return null;
      return adapter.runtimeId;
    });
  await expect.poll(read, { timeout: 30_000 }).toMatch(/^0x[a-fA-F0-9]{40}$/);
  const runtimeId = await read();
  if (!runtimeId) throw new Error('ACTIVE_TAB_RUNTIME_DISCONNECTED');
  return runtimeId;
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

  test(
    'projection route cannot evict an active embedded Runtime owner',
    { tag: '@resilience' },
    async ({ browser }, testInfo) => {
      const context: BrowserContext = await browser.newContext({ ignoreHTTPSErrors: true });
      const wallet = await context.newPage();
      const projection = await context.newPage();
      const projectionRelays: string[] = [];
      const projectionWorkers: string[] = [];
      projection.on('websocket', socket => {
        if (new URL(socket.url()).pathname === '/relay') projectionRelays.push(socket.url());
      });
      projection.on('worker', worker => projectionWorkers.push(worker.url()));
      const runtimeLock = () =>
        wallet.evaluate(async () => {
          const snapshot = await navigator.locks.query();
          if (!snapshot.held) throw new Error('WEB_LOCK_SNAPSHOT_MISSING');
          return snapshot.held.filter(lock => lock.name === 'xln-active-runtime');
        });

      try {
        await ensureE2EBaseline(wallet, { requireHubMesh: true });
        await gotoApp(wallet);
        const identity = await createWalletIdentity(wallet, 'projection-owner', selectDemoMnemonic('alice'));
        await waitUntilOwnsActiveLock(wallet);
        const runtimeId = await waitForEmbeddedRuntime(wallet);
        expect(runtimeId).toBe(identity.runtimeId);
        const originalLock = await runtimeLock();
        expect(originalLock).toHaveLength(1);

        await wallet.evaluate(() => {
          (window as Window & { __xlnDocumentMarker?: string }).__xlnDocumentMarker = 'same-document';
        });
        // React owns wallet navigation; /address is a separate read-only observer.
        await wallet.getByTestId('nav-manage').locator('visible=true').first().click();
        await wallet.getByTestId('nav-home').locator('visible=true').first().click();
        expect(
          await wallet.evaluate(() => (window as Window & { __xlnDocumentMarker?: string }).__xlnDocumentMarker),
        ).toBe('same-document');
        await expect(wallet.getByTestId('home-entity-id')).toHaveText(identity.entityId);
        expect(await waitForEmbeddedRuntime(wallet)).toBe(runtimeId);

        await openApp(projection, '/address');
        await expect(projection.getByRole('heading', { name: 'XLN Address Directory' })).toBeVisible();

        await expect(projection.getByText('LOCAL_RUNTIME_ACTIVE_IN_ANOTHER_TAB')).toBeVisible({ timeout: 10_000 });
        await waitUntilOwnsActiveLock(wallet);
        expect(await waitForEmbeddedRuntime(wallet)).toBe(runtimeId);
        await projection.getByRole('button', { name: 'Refresh', exact: true }).click();
        await expect(projection.getByText('LOCAL_RUNTIME_ACTIVE_IN_ANOTHER_TAB')).toBeVisible();
        await waitUntilOwnsActiveLock(wallet);
        expect(await waitForEmbeddedRuntime(wallet)).toBe(runtimeId);
        await projection.waitForTimeout(1_500);
        // The deployed observer intentionally has no development adapter diagnostics.
        // Observe its real authority and transports instead of treating missing debug as disconnected.
        expect(await projection.evaluate(() => sessionStorage.getItem('xln-active-tab-owned'))).toBeNull();
        const finalLock = await runtimeLock();
        expect(finalLock).toEqual(originalLock);
        expect(await waitForEmbeddedRuntime(wallet)).toBe(runtimeId);
        expect(projectionRelays).toEqual([]);
        expect(projectionWorkers).toEqual([]);
        await testInfo.attach('projection-owner-evidence', {
          body: JSON.stringify({ runtimeId, originalLock, finalLock, projectionRelays, projectionWorkers }),
          contentType: 'application/json',
        });
      } finally {
        await closeRuntimeContext(context);
      }
    },
  );
});

test(
  "React wallet transfers ownership only after the previous Runtime drains",
  { tag: "@resilience" },
  async ({ browser }) => {
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const first = await context.newPage();
    const second = await context.newPage();
    let phase = "create-first";
    for (const [name, page] of [
      ["first", first],
      ["second", second],
    ] as const) {
      page.on("console", (message) => {
        if (message.type() === "warning" || message.type() === "error")
          console.log(`[E2E ownership ${name} ${phase}] ${message.text()}`);
      });
    }
    try {
      await ensureE2EBaseline(first, { requireHubMesh: true });
      await gotoApp(first);
      const identity = await createWalletIdentity(
        first,
        "tab-owner",
        selectDemoMnemonic("alice"),
      );
      const previous = await first.evaluateHandle(() => {
        const debug = (
          window as Window & { __xln?: { env: () => RuntimeReplica | null } }
        ).__xln;
        const env = debug?.env();
        if (!env) throw new Error("ACTIVE_TAB_RUNTIME_MISSING");
        return env;
      });
      const projection = await context.newPage();
      await openApp(projection, "/address");
      await expect(
        projection.getByText("LOCAL_RUNTIME_ACTIVE_IN_ANOTHER_TAB"),
      ).toBeVisible();
      await expect(first.getByTestId("home-entity-id")).toHaveText(
        identity.entityId,
      );
      expect(
        await previous.evaluate((env) => env.runtimeSeed !== undefined),
      ).toBe(true);
      await projection.close();
      phase = "open-second";
      await gotoApp(second);
      await second.getByRole("button", { name: /Continue/ }).click();
      await second
        .getByLabel("Password", { exact: true })
        .fill("wrong-password");
      await second.getByRole("button", { name: "Unlock", exact: true }).click();
      await expect(second.getByRole("alert")).toContainText(
        "Incorrect password",
      );
      await expect(first.getByTestId("home-entity-id")).toHaveText(
        identity.entityId,
      );
      expect(
        await previous.evaluate((env) => env.runtimeSeed !== undefined),
      ).toBe(true);
      await second.getByLabel("Password", { exact: true }).fill(LOCAL_PASSWORD);
      phase = "unlock-second";
      await second.getByRole("button", { name: "Unlock", exact: true }).click();
      await expect(second.getByTestId("home-entity-id")).toHaveText(
        identity.entityId,
      );
      const retired = () =>
        previous.evaluate((env) => ({
          paused: env.infrastructure?.persistencePaused === true,
          loopStopped: env.infrastructure?.loopActive !== true,
          seedRemoved: env.runtimeSeed === undefined,
        }));
      console.log(
        "[E2E] previous React Runtime after second unlock",
        await retired(),
      );
      await expect
        .poll(retired)
        .toEqual({ paused: true, loopStopped: true, seedRemoved: true });
      await expect(first.getByTestId("nav-home")).toHaveCount(0);
      await previous.dispose();
    } finally {
      await closeRuntimeContext(context);
    }
  },
);
