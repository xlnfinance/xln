import type { RuntimeReplica } from '../../../core/api/public/runtime-module';
import { createWalletIdentity, LOCAL_PASSWORD } from '../../../ui/tests/wallet-ui';
import { chooseVisibleRoute } from '../../utils/runtime/e2e-pay-ui';
import { waitForRenderedOutboundForAccountDelta } from '../../utils/runtime/e2e-account-ui';
import { expect, test, type BrowserContext, type Page } from '../../global-setup.mts';
import { APP_BASE_URL, ensureE2EBaseline, waitForNamedHubs } from '../../utils/e2e-baseline';
import { connectRuntimeToHub, waitForReceiveReadyGossipProfiles } from '../../utils/e2e-connect';
import { gotoApp, selectDemoMnemonic } from '../../utils/e2e-demo-users';
import { getPersistedReceiptCursor, waitForPersistedFrameEventMatch } from '../../utils/e2e-runtime-receipts';

const TEST_TIMEOUT_MS = process.env.E2E_LONG === '1' ? 240_000 : 210_000;

async function faucetOffchain(page: Page, entityId: string, hubId: string, runtimeId: string): Promise<void> {
  const result = await page.evaluate(
    async ({ entityId, hubId, runtimeId }) => {
      const response = await fetch('/api/faucet/offchain', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userEntityId: entityId,
          userRuntimeId: runtimeId,
          hubEntityId: hubId,
          tokenSymbol: 'USDC',
          amount: '100',
        }),
      });
      const data = await response.json().catch(() => ({}));
      return { ok: response.ok, data };
    },
    { entityId, hubId, runtimeId },
  );

  expect(result.ok, JSON.stringify(result.data)).toBe(true);
}

test.describe('Canonical /app#pay deep link', () => {
  test.setTimeout(TEST_TIMEOUT_MS);

  test('restores runtime and opens the pay screen from hash params', { tag: '@functional' }, async ({ browser }) => {
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
      });
      const hubs = await waitForNamedHubs(aliceSetupPage, ['H1']);
      const hubId = hubs.h1;

      await gotoApp(aliceSetupPage);
      const alice = await createWalletIdentity(aliceSetupPage, 'alice', selectDemoMnemonic('alice'));
      await connectRuntimeToHub(aliceSetupPage, alice, hubId);
      await faucetOffchain(aliceSetupPage, alice.entityId, hubId, alice.runtimeId);
      await waitForRenderedOutboundForAccountDelta(aliceSetupPage, hubId, 0, 100);

      await gotoApp(bobPage);
      const bob = await createWalletIdentity(bobPage, 'bob', selectDemoMnemonic('bob'));
      await connectRuntimeToHub(bobPage, bob, hubId);
      await aliceSetupPage.close();

      const payPage = await aliceContext.newPage();
      const invoiceParams = new URLSearchParams({
        token: '1',
        amount: '5',
        desc: 'E2E direct pay deep link',
      });
      const payUrl = `${APP_BASE_URL}/app#pay/${encodeURIComponent(`${bob.entityId}?${invoiceParams.toString()}`)}`;
      await payPage.goto(payUrl, { waitUntil: 'domcontentloaded' });

      await payPage.getByRole('button', { name: 'Continue', exact: true }).click();
      await payPage.getByLabel('Password', { exact: true }).fill(LOCAL_PASSWORD);
      await payPage.getByRole('button', { name: 'Unlock', exact: true }).click();
      // Unlock starts checkpoint/WAL restore and authenticated chain sync. The
      // navigation shell appears only after both finish; preserve the invoice route.
      await payPage.getByTestId('nav-home').locator('visible=true').waitFor({ state: 'visible', timeout: 30_000 });
      await expect(payPage.getByTestId('pay-to')).toHaveValue(bob.entityId);
      await expect(payPage.getByTestId('pay-amount')).toHaveValue('5');
      await expect(payPage.getByTestId('pay-note')).toHaveValue('E2E direct pay deep link');
      const restoredId = await payPage.evaluate(() => {
        const env = (window as Window & { __xln?: { env(): RuntimeReplica | null } }).__xln?.env();
        if (!env) throw new Error('CURRENT_WALLET_RUNTIME_MISSING');
        return env.runtimeId;
      });
      expect(restoredId).toBe(alice.runtimeId);
      await waitForReceiveReadyGossipProfiles(payPage, [alice.entityId, hubId, bob.entityId], hubId);
      await chooseVisibleRoute(payPage, [hubId, bob.entityId]);
      const [senderCursor, recipientCursor] = await Promise.all([
        getPersistedReceiptCursor(payPage),
        getPersistedReceiptCursor(bobPage),
      ]);
      const payNowBtn = payPage.getByTestId('pay-submit');
      await expect(payNowBtn).toBeEnabled();
      await payNowBtn.click();
      const [sent, received] = await Promise.all([
        waitForPersistedFrameEventMatch(payPage, {
          cursor: senderCursor,
          eventName: 'HtlcFinalized',
          entityId: alice.entityId,
          predicate: event => String(event.data?.amount) === '5000000',
          timeoutMs: 15_000,
        }),
        waitForPersistedFrameEventMatch(bobPage, {
          cursor: recipientCursor,
          eventName: 'HtlcReceived',
          entityId: bob.entityId,
          predicate: event => String(event.data?.amount) === '5000000',
          timeoutMs: 15_000,
        }),
      ]);
      expect(String(sent.data?.toEntity).toLowerCase()).toBe(hubId.toLowerCase());
      expect(String(received.data?.fromEntity).toLowerCase()).toBe(hubId.toLowerCase());
    } finally {
      await aliceContext?.close();
      await bobContext?.close();
    }
  });
});
