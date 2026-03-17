import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { APP_BASE_URL, ensureE2EBaseline, waitForNamedHubs } from './utils/e2e-baseline';
import { connectRuntimeToHub } from './utils/e2e-connect';
import { createRuntimeIdentity, gotoApp, selectDemoMnemonic } from './utils/e2e-demo-users';

const TEST_TIMEOUT_MS = process.env.E2E_LONG === '1' ? 240_000 : 150_000;

async function faucetOffchain(page: Page, entityId: string, hubId: string): Promise<void> {
  const result = await page.evaluate(async ({ entityId, hubId }) => {
    const response = await fetch('/api/faucet/offchain', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userEntityId: entityId, hubEntityId: hubId, tokenSymbol: 'USDC', amount: '100' }),
    });
    const data = await response.json().catch(() => ({}));
    return { ok: response.ok, status: response.status, data };
  }, { entityId, hubId });

  expect(result.ok, `offchain faucet failed: ${JSON.stringify(result.data)}`).toBe(true);
}

test.describe('Embedded Pay Button', () => {
  test.setTimeout(TEST_TIMEOUT_MS);

  test('mode=embed handles empty, no-route, and no-capacity states', async ({ browser }) => {
    const missingEntityId = `0x${'f'.repeat(64)}`;
    let aliceContext: BrowserContext | null = null;
    let emptyContext: BrowserContext | null = null;

    try {
      emptyContext = await browser.newContext({ ignoreHTTPSErrors: true });
      const emptyPage = await emptyContext.newPage();
      const emptyUrl =
        `${APP_BASE_URL}/app#pay?` +
        `id=${encodeURIComponent(missingEntityId)}` +
        `&token=1` +
        `&amt=10` +
        `&desc=${encodeURIComponent('E2E empty state')}` +
        `&locked=1` +
        `&jId=arrakis` +
        `&mode=embed` +
        `&segment=left`;
      await emptyPage.goto(emptyUrl, { waitUntil: 'domcontentloaded' });
      const emptyButton = emptyPage.locator('button.paybutton').first();
      await expect(emptyButton).toBeVisible({ timeout: 30_000 });
      await expect
        .poll(async () => (await emptyButton.textContent())?.trim() || '', {
          timeout: 30_000,
          intervals: [250, 500, 1000],
        })
        .toBe('No runtimes');
      await emptyContext.close();
      emptyContext = null;

      aliceContext = await browser.newContext({ ignoreHTTPSErrors: true });
      const alicePage = await aliceContext.newPage();
      alicePage.on('console', (msg) => {
        console.log(`[alice:${msg.type()}] ${msg.text()}`);
      });

      await ensureE2EBaseline(alicePage, {
        requireHubMesh: true,
        requireMarketMaker: false,
        minHubCount: 3,
        forceReset: true,
      });
      const hubs = await waitForNamedHubs(alicePage, ['H1']);
      const hubId = hubs.h1;

      await gotoApp(alicePage);
      const alice = await createRuntimeIdentity(alicePage, 'alice', selectDemoMnemonic('alice'));
      await connectRuntimeToHub(alicePage, alice, hubId);
      await faucetOffchain(alicePage, alice.entityId, hubId);

      const noRouteUrl =
        `${APP_BASE_URL}/app#pay?` +
        `id=${encodeURIComponent(missingEntityId)}` +
        `&token=1` +
        `&amt=5` +
        `&desc=${encodeURIComponent('E2E no route')}` +
        `&locked=1` +
        `&jId=arrakis` +
        `&mode=embed` +
        `&segment=left`;
      await alicePage.goto(noRouteUrl, { waitUntil: 'domcontentloaded' });
      const payButton = alicePage.locator('button.paybutton').first();
      await expect(payButton).toBeVisible({ timeout: 60_000 });
      await expect
        .poll(async () => (await payButton.textContent())?.trim() || '', {
          timeout: 60_000,
          intervals: [250, 500, 1000],
          message: 'embed pay button must report no route found',
        })
        .toBe('No route found');

      const noOutboundUrl =
        `${APP_BASE_URL}/app#pay?` +
        `id=${encodeURIComponent(hubId)}` +
        `&token=1` +
        `&amt=100000` +
        `&desc=${encodeURIComponent('E2E no outbound')}` +
        `&locked=1` +
        `&jId=arrakis` +
        `&mode=embed` +
        `&segment=left`;
      await alicePage.goto(noOutboundUrl, { waitUntil: 'domcontentloaded' });
      await expect
        .poll(async () => (await payButton.textContent())?.trim() || '', {
          timeout: 60_000,
          intervals: [250, 500, 1000],
          message: 'embed pay button must report no outbound',
        })
        .toMatch(/^No (outbound|route found)$/i);

    } finally {
      await emptyContext?.close();
      await aliceContext?.close();
    }
  });
});
