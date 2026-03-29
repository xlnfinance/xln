import { expect, test, type BrowserContext } from '@playwright/test';
import { APP_BASE_URL, ensureE2EBaseline, waitForNamedHubs } from './utils/e2e-baseline';
import { connectRuntimeToHub } from './utils/e2e-connect';
import { createRuntimeIdentity, gotoApp, selectDemoMnemonic } from './utils/e2e-demo-users';
import { getPersistedReceiptCursor, waitForPersistedFrameEvent } from './utils/e2e-runtime-receipts';

const TEST_TIMEOUT_MS = process.env.E2E_LONG === '1' ? 240_000 : 150_000;

async function faucetOffchain(page: Page, entityId: string, hubId: string): Promise<void> {
  const result = await page.evaluate(async ({ entityId, hubId }) => {
    const response = await fetch('/api/faucet/offchain', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userEntityId: entityId, hubEntityId: hubId, tokenSymbol: 'USDC', amount: '100' }),
    });
    const data = await response.json().catch(() => ({}));
    return { ok: response.ok, data };
  }, { entityId, hubId });

  expect(result.ok, JSON.stringify(result.data)).toBe(true);
}

test.describe('Canonical /app#pay deep link', () => {
  test.setTimeout(TEST_TIMEOUT_MS);

  test('restores runtime and opens the pay screen from hash params', async ({ browser }) => {
    let aliceContext: BrowserContext | null = null;
    let bobContext: BrowserContext | null = null;

    try {
      aliceContext = await browser.newContext({ ignoreHTTPSErrors: true });
      bobContext = await browser.newContext({ ignoreHTTPSErrors: true });
      const aliceSetupPage = await aliceContext.newPage();
      const bobPage = await bobContext.newPage();

      await ensureE2EBaseline(aliceSetupPage, {
        requireHubMesh: true,
        requireMarketMaker: false,
        minHubCount: 3,
        forceReset: true,
      });
      const hubs = await waitForNamedHubs(aliceSetupPage, ['H1']);
      const hubId = hubs.h1;

      await gotoApp(aliceSetupPage);
      const alice = await createRuntimeIdentity(aliceSetupPage, 'alice', selectDemoMnemonic('alice'));
      await connectRuntimeToHub(aliceSetupPage, alice, hubId);
      await faucetOffchain(aliceSetupPage, alice.entityId, hubId);

      await gotoApp(bobPage);
      const bob = await createRuntimeIdentity(bobPage, 'bob', selectDemoMnemonic('bob'));
      await connectRuntimeToHub(bobPage, bob, hubId);
      await aliceSetupPage.close();

      const payPage = await aliceContext.newPage();
      const invoiceParams = new URLSearchParams({
        token: '1',
        amount: '5',
        desc: 'E2E direct pay deep link',
        jId: 'arrakis',
      });
      const payUrl = `${APP_BASE_URL}/app#pay/${encodeURIComponent(`${bob.entityId}?${invoiceParams.toString()}`)}`;
      await payPage.goto(payUrl, { waitUntil: 'domcontentloaded' });

      await expect(payPage.locator('.payment-panel')).toBeVisible({ timeout: 60_000 });
      await expect(payPage.locator('#payment-amount-input')).toHaveValue('5');

      const paymentCursor = await getPersistedReceiptCursor(bobPage);
      const findRoutesBtn = payPage.getByRole('button', { name: /^Find route$/i });
      await expect(findRoutesBtn).toBeVisible({ timeout: 30_000 });
      await findRoutesBtn.click();
      await expect(payPage.locator('.route-option').first()).toBeVisible({ timeout: 30_000 });
      await payPage.locator('.route-option').first().click();
      const payNowBtn = payPage.getByRole('button', { name: /^Pay Now$/i });
      await expect(payNowBtn).toBeEnabled({ timeout: 15_000 });
      await payNowBtn.click();

      await waitForPersistedFrameEvent(bobPage, {
        cursor: paymentCursor,
        eventName: 'HtlcReceived',
        entityId: bob.entityId,
        timeoutMs: 45_000,
      });
    } finally {
      await aliceContext?.close();
      await bobContext?.close();
    }
  });
});
