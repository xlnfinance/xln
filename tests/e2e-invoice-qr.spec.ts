import { expect, test } from '@playwright/test';
import { APP_BASE_URL, ensureE2EBaseline, waitForNamedHubs } from './utils/e2e-baseline';
import { connectRuntimeToHub } from './utils/e2e-connect';
import { createRuntimeIdentity, gotoApp, selectDemoMnemonic } from './utils/e2e-demo-users';
import { waitForPersistedFrameEvent, getPersistedReceiptCursor } from './utils/e2e-runtime-receipts';

const TEST_TIMEOUT_MS = process.env.E2E_LONG === '1' ? 240_000 : 150_000;

async function faucetOffchain(page: import('@playwright/test').Page, entityId: string, hubId: string): Promise<void> {
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

test.describe('Invoice QR flow', () => {
  test.setTimeout(TEST_TIMEOUT_MS);

  test('creates QR in Receive and scans it into Pay', async ({ browser }) => {
    const aliceContext = await browser.newContext({ ignoreHTTPSErrors: true, acceptDownloads: true });
    const bobContext = await browser.newContext({ ignoreHTTPSErrors: true, acceptDownloads: true });

    try {
      const alicePage = await aliceContext.newPage();
      const bobPage = await bobContext.newPage();

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

      await gotoApp(bobPage);
      const bob = await createRuntimeIdentity(bobPage, 'bob', selectDemoMnemonic('bob'));
      await connectRuntimeToHub(bobPage, bob, hubId);

      await bobPage.getByRole('button', { name: /^Receive$/i }).click();
      await bobPage.locator('.invoice-builder input[placeholder="Optional amount"]').fill('7');
      await bobPage.locator('.invoice-builder input[placeholder="Optional description"]').fill('QR settle');

      const downloadPromise = bobPage.waitForEvent('download');
      await bobPage.getByRole('button', { name: /Download QR/i }).click();
      const download = await downloadPromise;
      const qrPath = test.info().outputPath('invoice-qr.png');
      await download.saveAs(qrPath);

      const paymentCursor = await getPersistedReceiptCursor(bobPage);
      await alicePage.getByRole('button', { name: /^Pay$/i }).click();
      await alicePage.getByRole('button', { name: /Scan QR/i }).click();
      await alicePage.locator('.scanner-file-input').setInputFiles(qrPath);

      await expect(alicePage.locator('#payment-invoice-input')).toHaveValue(/xln:\?/i, { timeout: 30_000 });
      await expect(alicePage.locator('#payment-amount-input')).toHaveValue('7', { timeout: 30_000 });
      await expect(alicePage.locator('.route-option').first()).toBeVisible({ timeout: 60_000 });
      await alicePage.locator('.route-option').first().click();
      const sendOnSelectedRoute = alicePage.getByRole('button', { name: /^Send On Selected Route$/i });
      if (await sendOnSelectedRoute.isVisible().catch(() => false)) {
        await sendOnSelectedRoute.click();
      } else {
        await alicePage.getByRole('button', { name: /^Pay Now$/i }).click();
      }

      await waitForPersistedFrameEvent(bobPage, {
        cursor: paymentCursor,
        eventName: 'HtlcReceived',
        entityId: bob.entityId,
        timeoutMs: 45_000,
      });
    } finally {
      await aliceContext.close();
      await bobContext.close();
    }
  });
});
