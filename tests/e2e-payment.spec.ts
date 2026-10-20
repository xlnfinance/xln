/**
 * E2E payment coverage for the current Pay UI.
 *
 * Flow and goals:
 * 1. Reset to the shared 3-hub baseline.
 * 2. Import a browser wallet and connect it to a hub through the live React UI.
 * 3. Fund the sender offchain, open the pay form, and submit an HTLC payment.
 * 4. Verify success from rendered account state, not hidden internals.
 * 5. Reload and unlock the same wallet; verify durable state and no duplicate receipt.
 *
 * This test exists to prove that the visible wallet payment flow is sound for a real user:
 * discover recipient, find a route, pay, and observe the balance delta on screen.
 */

import type { Page } from '@playwright/test';
import type { RuntimeReplica } from '../core/runtime/types';
import { createWalletIdentity, LOCAL_PASSWORD } from '../ui/tests/wallet-ui';
import { test, expect } from './global-setup.mts';
import { ensureE2EBaseline, APP_BASE_URL } from './utils/e2e-baseline';
import { connectRuntimeToHub } from './utils/e2e-connect';
import { gotoApp, selectDemoMnemonic } from './utils/e2e-demo-users';
import { getRenderedOutboundForAccount } from './utils/runtime/e2e-account-ui';
import { getPersistedReceiptCursor, waitForPersistedFrameEventMatch } from './utils/e2e-runtime-receipts';
import { timedStep } from './utils/e2e-timing.mts';
import { prepareUiPayment } from './utils/runtime/e2e-pay-ui';

const CONSENSUS_TIMEOUT = 30_000;
const LONG_E2E = process.env.E2E_LONG === '1';
const USDC_DECIMALS = 6n;
const PAYMENT_AMOUNT = 25n * 10n ** USDC_DECIMALS;

type CurrentWalletWindow = Window & {
  __xln?: {
    env(): RuntimeReplica | null;
    store: { getState(): { activeEntityId: string | null } };
  };
};

async function reloadWallet(page: Page, identity: { entityId: string; runtimeId: string }): Promise<void> {
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByLabel('Password', { exact: true }).fill(LOCAL_PASSWORD);
  await page.getByRole('button', { name: 'Unlock', exact: true }).click();
  await page.waitForFunction(
    ({ entityId, runtimeId }) => {
      const debug = (window as CurrentWalletWindow).__xln;
      return debug?.env()?.runtimeId === runtimeId && debug.store.getState().activeEntityId === entityId;
    },
    identity,
    { timeout: 60_000 },
  );
  await page.getByTestId('nav-home').locator('visible=true').first().click();
  await expect(page.getByTestId('home-pay')).toBeVisible();
}

test.describe('E2E HTLC Payment Flow', () => {
  // Scenario: a fresh runtime connects to the baseline hub mesh, receives offchain funds,
  // sends one HTLC payment through the current Pay UI, and proves reload restores the same account state.
  test('full HTLC bilateral payment through hub', { tag: '@functional' }, async ({ page }) => {
    test.setTimeout(LONG_E2E ? 240_000 : 180_000);

    // Log errors for debugging
    page.on('console', msg => {
      if (msg.type() === 'error') process.stdout.write(`[Browser ERROR] ${msg.text()}\n`);
    });

    // ── Step 0: Wait for server ──
    process.stdout.write('Step 0: Waiting for baseline (3 hubs + market maker)...\n');
    const baseline = await ensureE2EBaseline(page, {
      timeoutMs: LONG_E2E ? 240_000 : 180_000,
      requireHubMesh: true,
      requireMarketMaker: false,
      minHubCount: 3,
    });
    process.stdout.write(
      `  Baseline ready: hubs=${baseline.hubMesh?.hubIds?.length ?? 0}, mm=${baseline.marketMaker?.entityId ?? 'none'}\n`,
    );

    // ── Step 1: Load app ──
    process.stdout.write('Step 1: Loading app...\n');
    await gotoApp(page, { appBaseUrl: APP_BASE_URL, initTimeoutMs: 60_000, settleMs: 500 });
    const alice = await timedStep('payment.import_wallet', () =>
      createWalletIdentity(page, 'alice', selectDemoMnemonic('alice')),
    );
    // Unlock the same encrypted wallet before funding, then again after payment.
    await timedStep('payment.initial_reload', () => reloadWallet(page, alice));
    process.stdout.write('  Runtime initialized.\n');

    // ── Step 2: Open account with first baseline hub ──
    process.stdout.write('Step 2: Opening account with first baseline hub...\n');
    const connectedHubId = baseline.hubMesh?.hubIds?.[0];
    if (!connectedHubId) throw new Error('PAYMENT_BASELINE_HUB_MISSING');
    await timedStep('payment.connect_hub', () => connectRuntimeToHub(page, alice, connectedHubId));
    await expect(page.locator(`[data-testid="account-row"][data-counterparty-id="${connectedHubId}"]`)).toBeVisible();
    process.stdout.write(`  Connected hub: ${connectedHubId}\n`);
    process.stdout.write('  Account opened and synced.\n');

    // ── Step 3: Get Test Funds ──
    process.stdout.write('Step 3: Requesting test funds...\n');
    const faucetBtn = page.getByTestId('home-faucet');
    await expect(faucetBtn).toBeVisible({ timeout: 10_000 });
    await faucetBtn.click();
    await expect(page.getByTestId('test-money-status')).toHaveText('100 USDC received', { timeout: CONSENSUS_TIMEOUT });

    let outboundBeforePayment = 0;
    await expect
      .poll(
        async () => {
          outboundBeforePayment = await getRenderedOutboundForAccount(page, connectedHubId);
          return outboundBeforePayment;
        },
        { timeout: CONSENSUS_TIMEOUT },
      )
      .toBeGreaterThan(0);
    process.stdout.write(`  Outbound before payment (UI): ${outboundBeforePayment}\n`);

    // ── Step 4: Send $25 via HTLC ──
    process.stdout.write('Step 4: Sending $25 via HTLC...\n');

    // React quotes automatically; the displayed route must authorize this exact direct payment.
    await timedStep('payment.find_routes', async () => {
      await prepareUiPayment(page, {
        recipientEntityId: connectedHubId,
        amount: PAYMENT_AMOUNT,
        tokenId: 1,
        routeEntityIds: [connectedHubId],
      });
      const quote = page.getByTestId('pay-quote');
      await expect(quote).toBeVisible({ timeout: 10_000 });
      await expect(quote).toHaveAttribute('data-route-path', `${alice.entityId},${connectedHubId}`);
      await expect(quote).toHaveAttribute('data-sender-amount', PAYMENT_AMOUNT.toString());
      await expect(quote).toHaveAttribute('data-recipient-amount', PAYMENT_AMOUNT.toString());
      await expect(quote).toHaveAttribute('data-fee-amount', '0');
    });

    // Send payment and assert durable HTLC finalize on the sender side.
    const paymentCursor = await getPersistedReceiptCursor(page);
    const finalizedEvent = await timedStep('payment.send_to_finalize', async () => {
      const sendPaymentBtn = page.getByTestId('pay-submit');
      await expect(sendPaymentBtn).toHaveAccessibleName('Pay 25.00 USDC');
      await expect(sendPaymentBtn).toBeEnabled({ timeout: 5000 });
      await sendPaymentBtn.click();

      return waitForPersistedFrameEventMatch(page, {
        cursor: paymentCursor,
        eventName: 'HtlcFinalized',
        entityId: alice.entityId,
        timeoutMs: CONSENSUS_TIMEOUT,
      });
    });

    expect(String(finalizedEvent.data?.amount || ''), 'sender finalized event should include amount').toBe(
      PAYMENT_AMOUNT.toString(),
    );
    expect(
      String(finalizedEvent.data?.fromEntity || '').toLowerCase(),
      'sender finalized event should include fromEntity',
    ).toBe(alice.entityId.toLowerCase());
    expect(
      String(finalizedEvent.data?.toEntity || '').toLowerCase(),
      'sender finalized event should include toEntity',
    ).toBe(String(connectedHubId || '').toLowerCase());
    expect(String(finalizedEvent.data?.hashlock || ''), 'sender finalized event should include hashlock').toMatch(
      /^0x[0-9a-f]{64}$/i,
    );
    expect(
      String(finalizedEvent.data?.lockId || '').length,
      'sender finalized event should include lockId',
    ).toBeGreaterThan(0);
    expect(
      String(finalizedEvent.data?.jurisdictionId || '').length,
      'sender finalized event should include jurisdictionId',
    ).toBeGreaterThan(0);
    expect(
      Number(finalizedEvent.data?.startedAtMs || 0),
      'sender finalized event should include startedAtMs',
    ).toBeGreaterThan(0);
    expect(
      Number(finalizedEvent.data?.finalizedAtMs || 0),
      'sender finalized event should include finalizedAtMs',
    ).toBeGreaterThan(0);
    expect(
      Number(finalizedEvent.data?.elapsedMs || 0),
      'sender finalized event should include elapsedMs',
    ).toBeGreaterThan(0);
    expect(
      Number(finalizedEvent.data?.finalizedInMs || 0),
      'sender finalized event should include finalizedInMs',
    ).toBeGreaterThan(0);
    // The terminal event raises a short notice; the receipt opens on demand.
    const paymentNotice = page.getByTestId('payment-notification');
    await expect(paymentNotice).toContainText('Paid', { timeout: 10_000 });
    await expect(paymentNotice).toContainText('25');
    await paymentNotice.getByTestId('receipt-open').click();
    const terminalSpotlight = page.getByTestId('payment-receipt');
    await expect(terminalSpotlight).toBeVisible();
    await expect(terminalSpotlight.getByTestId('receipt-kicker')).toHaveText('Paid');
    await expect(terminalSpotlight.getByTestId('receipt-amount')).toContainText('25');
    await expect(terminalSpotlight.getByTestId('receipt-title')).toContainText('to');
    await page.screenshot({ path: 'test-results/e2e-payment-terminal.png', fullPage: true });
    await terminalSpotlight.getByRole('button', { name: 'Done' }).click();
    let outboundAfterPayment = outboundBeforePayment;
    await timedStep('payment.send_to_ui_delta', async () => {
      await expect
        .poll(
          async () => {
            outboundAfterPayment = await getRenderedOutboundForAccount(page, connectedHubId);
            return outboundAfterPayment;
          },
          { timeout: CONSENSUS_TIMEOUT },
        )
        .toBe(outboundBeforePayment - 25);
    });
    const persistedHeightBeforeReload = (await getPersistedReceiptCursor(page)).nextHeight - 1;
    process.stdout.write(
      `  HTLC finalizedInMs=${Number(finalizedEvent.data?.finalizedInMs || 0)} elapsedMs=${Number(finalizedEvent.data?.elapsedMs || 0)}\n`,
    );

    // ── Step 5: Verify final outbound moved down ──
    process.stdout.write(`Step 5: OUT before=${outboundBeforePayment} after=${outboundAfterPayment}\n`);

    // ── Step 6: Reload and verify snapshot + WAL restore ──
    process.stdout.write('Step 6: Reload and verify persisted payment state...\n');
    await timedStep('payment.final_reload', () => reloadWallet(page, alice));
    await expect
      .poll(async () => await getRenderedOutboundForAccount(page, connectedHubId), { timeout: 60_000 })
      .toBe(outboundAfterPayment);
    await expect
      .poll(async () => (await getPersistedReceiptCursor(page)).nextHeight - 1, { timeout: 60_000 })
      .toBeGreaterThanOrEqual(persistedHeightBeforeReload);
    await expect(page.getByTestId('payment-receipt')).toHaveCount(0);
    await page.waitForTimeout(750);
    await expect(page.getByTestId('payment-receipt')).toHaveCount(0);
    await expect(page.getByTestId('payment-notification')).toHaveCount(0);
    process.stdout.write(
      `  Reload state verified: persistedHeight>=${persistedHeightBeforeReload}, renderedOut=${outboundAfterPayment}\n`,
    );

    // Screenshot for evidence
    await page.screenshot({ path: 'test-results/e2e-htlc-payment-final.png', fullPage: true });

    // ── Summary ──
    process.stdout.write('=== TEST PASSED ===\n');
  });
});
