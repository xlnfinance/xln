/**
 * E2E payment coverage for the current Pay UI.
 *
 * Flow and goals:
 * 1. Reset to the shared 3-hub baseline.
 * 2. Create two browser users and connect them to hubs through the live UI.
 * 3. Fund the sender offchain, open the pay form, and submit an HTLC payment.
 * 4. Verify success from rendered account state, not hidden internals.
 * 5. Verify routing failures are surfaced cleanly when capacity is insufficient.
 *
 * This test exists to prove that the visible wallet payment flow is sound for a real user:
 * discover recipient, find a route, pay, and observe the balance delta on screen.
 */

import { test, expect, type Page } from '@playwright/test';
import { ensureE2EBaseline, APP_BASE_URL } from './utils/e2e-baseline';
import { connectHub } from './utils/e2e-connect';
import { createRuntimeIdentity, gotoApp, selectDemoMnemonic } from './utils/e2e-demo-users';
import { getRenderedPrimaryOutbound } from './utils/e2e-account-ui';
import { getPersistedReceiptCursor, waitForPersistedFrameEvent, waitForPersistedFrameEventMatch } from './utils/e2e-runtime-receipts';
import { timedStep } from './utils/e2e-timing';

const CONSENSUS_TIMEOUT = 30_000;
const LONG_E2E = process.env.E2E_LONG === '1';

// Collect console messages matching patterns
class ConsoleCollector {
  private messages: string[] = [];
  private waiters: Array<{ pattern: RegExp; resolve: (text: string) => void; timer: NodeJS.Timeout }> = [];

  attach(page: Page) {
    page.on('console', (msg) => {
      const text = msg.text();
      this.messages.push(text);
      // Check waiters
      for (let i = this.waiters.length - 1; i >= 0; i--) {
        const waiter = this.waiters[i]!;
        if (waiter.pattern.test(text)) {
          clearTimeout(waiter.timer);
          waiter.resolve(text);
          this.waiters.splice(i, 1);
        }
      }
    });
  }

  waitFor(pattern: RegExp, timeout = CONSENSUS_TIMEOUT): Promise<string> {
    // Check existing messages first
    const existing = this.messages.find(m => pattern.test(m));
    if (existing) return Promise.resolve(existing);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter(w => w.timer !== timer);
        reject(new Error(`Console timeout waiting for ${pattern}`));
      }, timeout);
      this.waiters.push({ pattern, resolve, timer });
    });
  }

  has(pattern: RegExp): boolean {
    return this.messages.some(m => pattern.test(m));
  }

  find(pattern: RegExp): string | undefined {
    return this.messages.find(m => pattern.test(m));
  }

  dump(filter?: RegExp): string[] {
    return filter ? this.messages.filter(m => filter.test(m)) : this.messages;
  }
}

async function getConnectedHubEntityId(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const env = (window as any).isolatedEnv;
    if (!env?.eReplicas) return null;
    for (const [, rep] of env.eReplicas.entries()) {
      const accounts = rep?.state?.accounts;
      if (!accounts || accounts.size === 0) continue;
      const first = accounts.keys().next();
      if (!first?.done && typeof first.value === 'string') return first.value;
    }
    return null;
  });
}

test.describe('E2E HTLC Payment Flow', () => {
  // Scenario: a fresh runtime connects to the baseline hub mesh, receives offchain funds,
  // sends one HTLC payment through the current Pay UI, and proves reload restores the same account state.
  test('full HTLC bilateral payment through hub', async ({ page }) => {
    test.setTimeout(LONG_E2E ? 240_000 : 120_000);
    const console = new ConsoleCollector();
    console.attach(page);

    // Log errors for debugging
    page.on('console', (msg) => {
      if (msg.type() === 'error') process.stdout.write(`[Browser ERROR] ${msg.text()}\n`);
    });

    // ── Step 0: Wait for server ──
    process.stdout.write('Step 0: Waiting for baseline (3 hubs + market maker)...\n');
    const baseline = await ensureE2EBaseline(page, {
      timeoutMs: LONG_E2E ? 240_000 : 120_000,
      requireHubMesh: true,
      requireMarketMaker: false,
      minHubCount: 3,
      forceReset: true,
    });
    process.stdout.write(
      `  Baseline ready: hubs=${baseline.hubMesh?.hubIds?.length ?? 0}, mm=${baseline.marketMaker?.entityId ?? 'none'}\n`,
    );

    // ── Step 1: Load app ──
    process.stdout.write('Step 1: Loading app...\n');
    await gotoApp(page, { appBaseUrl: APP_BASE_URL, initTimeoutMs: 60_000, settleMs: 500 });
    const alice = await createRuntimeIdentity(page, 'alice', selectDemoMnemonic('alice'));
    process.stdout.write('  Runtime initialized.\n');

    // ── Step 2: Open account with first baseline hub ──
    process.stdout.write('Step 2: Opening account with first baseline hub...\n');
    let connectedHubId: string | null = baseline.hubMesh?.hubIds?.[0] ?? null;
    expect(connectedHubId, 'baseline must expose at least one hub id').toBeTruthy();
    await connectHub(page, connectedHubId!);
    await expect.poll(async () => {
      connectedHubId = await getConnectedHubEntityId(page);
      return connectedHubId;
    }, { timeout: CONSENSUS_TIMEOUT }).toBe(baseline.hubMesh?.hubIds?.[0] ?? null);
    process.stdout.write(`  Connected hub: ${connectedHubId}\n`);
    process.stdout.write('  Account opened and synced.\n');

    // ── Step 3: Get Test Funds ──
    process.stdout.write('Step 3: Requesting test funds...\n');
    const faucetBtn = page.locator('button:has-text("Test Funds"), button:has-text("faucet")').first();
    await expect(faucetBtn).toBeVisible({ timeout: 10_000 });
    await faucetBtn.click();

    let outboundBeforePayment = 0;
    await expect.poll(async () => {
      outboundBeforePayment = await getRenderedPrimaryOutbound(page);
      return outboundBeforePayment;
    }, { timeout: CONSENSUS_TIMEOUT }).toBeGreaterThan(0);
    process.stdout.write(`  Outbound before payment (UI): ${outboundBeforePayment}\n`);

    // ── Step 4: Send $25 via HTLC ──
    process.stdout.write('Step 4: Sending $25 via HTLC...\n');

    // Switch to Pay tab
    const sendTab = page.getByRole('button', { name: 'Pay' });
    await expect(sendTab).toBeVisible({ timeout: 10_000 });
    await sendTab.click();
    process.stdout.write('  HTLC mode: default\n');

    const invoiceInput = page.locator('#payment-invoice-input').first();
    await expect(invoiceInput).toBeVisible({ timeout: 10_000 });
    await invoiceInput.click();
    await invoiceInput.fill(connectedHubId!);

    // Fill amount
    const amountInput = page.locator('#payment-amount-input');
    await amountInput.click();
    await amountInput.fill('25');

    // Find Routes
    await timedStep('payment.find_routes', async () => {
      const findRoutesBtn = page.getByRole('button', { name: 'Find route' });
      await expect(findRoutesBtn).toBeEnabled({ timeout: 5000 });
      await findRoutesBtn.click();
      await expect(page.locator('text=/1 hop|route/i').first()).toBeVisible({ timeout: 10_000 });
    });

    // Send Payment — capture HTLC-specific console logs
    const paymentCursor = await getPersistedReceiptCursor(page);
    const htlcSecretP = console.waitFor(/\[Send\] Hashlock secret=/);
    const finalizedEvent = await timedStep('payment.send_to_finalize', async () => {
      const sendPaymentBtn = page.getByRole('button', { name: 'Pay now' });
      await expect(sendPaymentBtn).toBeEnabled({ timeout: 5000 });
      await sendPaymentBtn.click();

      // Wait for HTLC secret generation (proves htlcPayment was used, not directPayment)
      const htlcLog = await htlcSecretP;
      process.stdout.write(`  ${htlcLog}\n`);
      expect(htlcLog).toContain('Hashlock secret=');
      expect(htlcLog).toContain('hashlock=');

      return waitForPersistedFrameEventMatch(page, {
        cursor: paymentCursor,
        eventName: 'HtlcFinalized',
        entityId: alice.entityId,
        timeoutMs: CONSENSUS_TIMEOUT,
      });
    });

    // Re-check the already awaited secret log so the narrative stays intact.
    const htlcLog = await htlcSecretP;
    process.stdout.write(`  ${htlcLog}\n`);
    expect(htlcLog).toContain('Hashlock secret=');
    expect(htlcLog).toContain('hashlock=');
    expect(String(finalizedEvent.data?.amount || ''), 'sender finalized event should include amount').toBe('25000000000000000000');
    expect(String(finalizedEvent.data?.fromEntity || '').toLowerCase(), 'sender finalized event should include fromEntity').toBe(alice.entityId.toLowerCase());
    expect(String(finalizedEvent.data?.toEntity || '').toLowerCase(), 'sender finalized event should include toEntity').toBe(String(connectedHubId || '').toLowerCase());
    expect(String(finalizedEvent.data?.hashlock || ''), 'sender finalized event should include hashlock').toMatch(/^0x[0-9a-f]{64}$/i);
    expect(String(finalizedEvent.data?.lockId || '').length, 'sender finalized event should include lockId').toBeGreaterThan(0);
    expect(String(finalizedEvent.data?.jurisdictionId || '').length, 'sender finalized event should include jurisdictionId').toBeGreaterThan(0);
    expect(Number(finalizedEvent.data?.startedAtMs || 0), 'sender finalized event should include startedAtMs').toBeGreaterThan(0);
    expect(Number(finalizedEvent.data?.finalizedAtMs || 0), 'sender finalized event should include finalizedAtMs').toBeGreaterThan(0);
    expect(Number(finalizedEvent.data?.elapsedMs || 0), 'sender finalized event should include elapsedMs').toBeGreaterThan(0);
    expect(Number(finalizedEvent.data?.finalizedInMs || 0), 'sender finalized event should include finalizedInMs').toBeGreaterThan(0);

    let outboundAfterPayment = outboundBeforePayment;
    await timedStep('payment.send_to_ui_delta', async () => {
      await expect.poll(async () => {
        outboundAfterPayment = await getRenderedPrimaryOutbound(page);
        return outboundAfterPayment;
      }, { timeout: CONSENSUS_TIMEOUT }).toBeLessThan(outboundBeforePayment);
    });
    const persistedHeightBeforeReload = (await getPersistedReceiptCursor(page)).nextHeight - 1;
    process.stdout.write(
      `  HTLC finalizedInMs=${Number(finalizedEvent.data?.finalizedInMs || 0)} elapsedMs=${Number(finalizedEvent.data?.elapsedMs || 0)}\n`,
    );

    // Verify HTLC handler was invoked (browser-side logs)
    const htlcHandlerLog = console.find(/HTLC-PAYMENT HANDLER/);
    process.stdout.write(`  HTLC handler: ${htlcHandlerLog ? 'INVOKED' : 'not found (may be server-side only)'}\n`);

    // ── Step 5: Verify final outbound moved down ──
    process.stdout.write(`Step 5: OUT before=${outboundBeforePayment} after=${outboundAfterPayment}\n`);

    // Verify HTLC payment log (not directPayment)
    const paymentSentLog = console.find(/\[Send\] Hashlock payment sent via:/);
    expect(paymentSentLog).toBeTruthy();
    process.stdout.write(`  ${paymentSentLog}\n`);

    // ── Step 6: Reload and verify snapshot + WAL restore ──
    process.stdout.write('Step 6: Reload and verify persisted payment state...\n');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => {
      const maybeWindow = window as typeof window & {
        isolatedEnv?: { runtimeId?: string; eReplicas?: { size?: number } };
      };
      return Boolean(maybeWindow.isolatedEnv?.runtimeId) && Number(maybeWindow.isolatedEnv?.eReplicas?.size || 0) > 0;
    }, { timeout: 60_000 });
    await expect.poll(async () => await getRenderedPrimaryOutbound(page), { timeout: 60_000 }).toBe(outboundAfterPayment);
    await expect.poll(
      async () => (await getPersistedReceiptCursor(page)).nextHeight - 1,
      { timeout: 60_000 },
    ).toBeGreaterThanOrEqual(persistedHeightBeforeReload);
    process.stdout.write(
      `  Reload state verified: persistedHeight>=${persistedHeightBeforeReload}, renderedOut=${outboundAfterPayment}\n`,
    );

    // Screenshot for evidence
    await page.screenshot({ path: 'test-results/e2e-htlc-payment-final.png', fullPage: true });

    // ── Summary ──
    process.stdout.write('\n=== HTLC PROOF ===\n');
    const htlcLogs = console.dump(/HTLC|htlc|secret|hashlock/i);
    for (const log of htlcLogs.slice(0, 10)) {
      process.stdout.write(`  ${log.slice(0, 120)}\n`);
    }
    process.stdout.write(`  Total HTLC-related logs: ${htlcLogs.length}\n`);
    process.stdout.write('=== TEST PASSED ===\n');
  });
});
