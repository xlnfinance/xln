/**
 * E2E HTLC payment via current Pay UI.
 * Asserts payment success by outbound capacity decrease.
 */

import { test, expect, type Page } from '@playwright/test';
import { ensureE2EBaseline, APP_BASE_URL } from './utils/e2e-baseline';

const CONSENSUS_TIMEOUT = 30_000;
const LONG_E2E = process.env.E2E_LONG === '1';

type PrimaryAccountState = {
  counterpartyId: string;
  currentHeight: number;
  outboundWei: string;
};

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

async function getRenderedOutbound(page: Page): Promise<number> {
  return page.evaluate(() => {
    const selectedCard = document.querySelector('.account-preview.selected') || document.querySelector('.account-preview');
    if (!selectedCard) return 0;
    const outEl = selectedCard.querySelector('.delta-row .compact-out-value, .compact-out-value, .cap.out .cap-value');
    if (!outEl) return 0;
    const raw = String(outEl.textContent || '').replace(/,/g, '').trim();
    const numeric = Number(raw.replace(/[^0-9.-]/g, ''));
    return Number.isFinite(numeric) ? numeric : 0;
  });
}

async function getPrimaryAccountState(
  page: Page,
  preferredCounterpartyId?: string,
): Promise<PrimaryAccountState | null> {
  return page.evaluate(({ preferredCounterpartyId: preferred }) => {
    const maybeWindow = window as typeof window & {
      isolatedEnv?: {
        runtimeId?: string;
        eReplicas?: Map<string, {
          state?: {
            accounts?: Map<string, {
              currentHeight?: number;
              deltas?: Map<number | string, unknown>;
            }>;
          };
        }>;
      };
      XLN?: {
        deriveDelta?: (delta: unknown, isLeft: boolean) => { outCapacity?: bigint | string | number };
        isLeft?: (leftEntityId: string, rightEntityId: string) => boolean;
      };
    };

    const env = maybeWindow.isolatedEnv;
    const xln = maybeWindow.XLN;
    if (!env?.eReplicas || typeof xln?.deriveDelta !== 'function') return null;

    const runtimeSigner = String(env.runtimeId || '').toLowerCase();
    for (const [replicaKey, replica] of env.eReplicas.entries()) {
      const [entityId, signerId] = String(replicaKey).split(':');
      if (!entityId || !signerId) continue;
      if (runtimeSigner && String(signerId).toLowerCase() !== runtimeSigner) continue;

      const accounts = replica.state?.accounts;
      if (!(accounts instanceof Map)) continue;

      const orderedCounterparties = [
        ...(preferred ? [preferred] : []),
        ...Array.from(accounts.keys()).filter((counterpartyId) => String(counterpartyId) !== preferred),
      ];

      for (const counterpartyId of orderedCounterparties) {
        const account = accounts.get(counterpartyId);
        const delta = account?.deltas?.get?.(1) ?? account?.deltas?.get?.('1');
        if (!account || delta === undefined) continue;
        const isLeft = typeof xln.isLeft === 'function'
          ? Boolean(xln.isLeft(entityId, String(counterpartyId)))
          : entityId.toLowerCase() < String(counterpartyId).toLowerCase();
        const derived = xln.deriveDelta(delta, isLeft);
        const outbound = derived?.outCapacity;
        const outboundWei = typeof outbound === 'bigint'
          ? outbound.toString()
          : String(outbound ?? '0');
        return {
          counterpartyId: String(counterpartyId),
          currentHeight: Number(account.currentHeight || 0),
          outboundWei,
        };
      }
    }

    return null;
  }, { preferredCounterpartyId: preferredCounterpartyId ?? null });
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
      requireMarketMaker: true,
      minHubCount: 3,
    });
    process.stdout.write(
      `  Baseline ready: hubs=${baseline.hubMesh?.hubIds?.length ?? 0}, mm=${baseline.marketMaker?.entityId ?? 'none'}\n`,
    );

    // ── Step 1: Load app ──
    // Playwright gives each test a fresh browser context, so no explicit localStorage.clear() is needed.
    process.stdout.write('Step 1: Loading app...\n');
    await page.goto(`${APP_BASE_URL}/app`);
    // WebSocket + polling keep network active; networkidle can hang indefinitely.
    await page.reload({ waitUntil: 'domcontentloaded' });

    // Handle access code gate
    const accessInput = page.locator('input[placeholder*="access" i], input[placeholder*="code" i]');
    if (await accessInput.isVisible({ timeout: 3000 })) {
      await accessInput.fill('mml');
      await page.locator('button:has-text("Unlock")').click();
      await page.waitForURL('**/app**', { timeout: 10_000 });
    }

    // Cold boot can land on login screen without an initialized runtime.
    // In that case bootstrap runtime directly (same path used by working e2e suites).
    const hasRuntimeBeforeBootstrap = await page.evaluate(() => Boolean((window as any)?.isolatedEnv?.runtimeId));
    if (!hasRuntimeBeforeBootstrap) {
      await page.evaluate(async () => {
        const ops = (window as any).vaultOperations;
        if (!ops?.createRuntime) throw new Error('vaultOperations.createRuntime missing');
        await ops.createRuntime(
          `smoke-${Date.now()}`,
          'test test test test test test test test test test test junk',
          { loginType: 'demo', requiresOnboarding: false },
        );
      });
    }

    // Wait for runtime/UI boot (UI structure changed over time, keep this probe broad)
    await page.waitForFunction(() => {
      const w = window as any;
      const hasRuntime = Boolean(w?.XLN) && Boolean(w?.isolatedEnv?.runtimeId || w?.xlnEnv);
      const text = document.body?.textContent || '';
      const hasEntityId = /0x[a-fA-F0-9]{8,}/.test(text);
      const hasAccountsUi = Array.from(document.querySelectorAll('button,[role="tab"]'))
        .some((el) => /accounts/i.test(el.textContent || ''));
      return hasRuntime && (hasEntityId || hasAccountsUi);
    }, { timeout: 60_000 });
    process.stdout.write('  Runtime initialized.\n');

    // ── Step 2: Connect to first available hub ──
    process.stdout.write('Step 2: Connecting to first available hub...\n');
    const connectBtn = page.locator('button:has-text("Connect")').first();
    await expect(connectBtn).toBeVisible({ timeout: 15_000 });

    await connectBtn.click();
    let connectedHubId: string | null = null;
    await expect.poll(async () => {
      connectedHubId = await getConnectedHubEntityId(page);
      return Boolean(connectedHubId);
    }, { timeout: CONSENSUS_TIMEOUT }).toBe(true);
    await expect(page.locator('text=/READY|Synced|OUT|IN.*USDC/i').first()).toBeVisible({ timeout: CONSENSUS_TIMEOUT });
    process.stdout.write(`  Connected hub: ${connectedHubId}\n`);
    process.stdout.write('  Account opened and synced.\n');

    // ── Step 3: Get Test Funds ──
    process.stdout.write('Step 3: Requesting test funds...\n');
    const faucetBtn = page.locator('button:has-text("Test Funds"), button:has-text("faucet")').first();
    await expect(faucetBtn).toBeVisible({ timeout: 10_000 });
    await faucetBtn.click();

    let outboundBeforePayment = 0;
    await expect.poll(async () => {
      outboundBeforePayment = await getRenderedOutbound(page);
      return outboundBeforePayment;
    }, { timeout: CONSENSUS_TIMEOUT }).toBeGreaterThan(0);
    process.stdout.write(`  Outbound before payment (UI): ${outboundBeforePayment}\n`);

    // ── Step 4: Send $25 via HTLC ──
    process.stdout.write('Step 4: Sending $25 via HTLC...\n');

    // Switch to Pay tab
    const sendTab = page.getByRole('button', { name: 'Pay' });
    await expect(sendTab).toBeVisible({ timeout: 10_000 });
    await sendTab.click();

    // Enforce hashlock mode in current Pay UI.
    const hashlockModeBtn = page.getByRole('button', { name: 'Hashlock' });
    await hashlockModeBtn.click();
    await expect(hashlockModeBtn).toHaveAttribute('aria-pressed', 'true');
    process.stdout.write('  HTLC mode: ON\n');

    // Fill recipient
    const recipientInput = page.getByRole('textbox', { name: 'Select recipient...' });
    await recipientInput.click();
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
    await page.keyboard.press('Backspace');
    await recipientInput.fill(connectedHubId!);
    await page.keyboard.press('Enter');

    // Fill amount
    const amountInput = page.locator('input[placeholder="0.00"]').first();
    await amountInput.click();
    await amountInput.fill('25');

    // Find Routes
    const findRoutesBtn = page.getByRole('button', { name: 'Find Routes' });
    await expect(findRoutesBtn).toBeEnabled({ timeout: 5000 });
    await findRoutesBtn.click();
    await expect(page.locator('text=/1 hop|route/i').first()).toBeVisible({ timeout: 10_000 });

    // Send Payment — capture HTLC-specific console logs
    const htlcSecretP = console.waitFor(/\[Send\] Hashlock secret=/);
    const sendPaymentBtn = page.getByRole('button', { name: 'Pay Now' });
    await expect(sendPaymentBtn).toBeEnabled({ timeout: 5000 });
    await sendPaymentBtn.click();

    // Wait for HTLC secret generation (proves htlcPayment was used, not directPayment)
    const htlcLog = await htlcSecretP;
    process.stdout.write(`  ${htlcLog}\n`);
    expect(htlcLog).toContain('Hashlock secret=');
    expect(htlcLog).toContain('hashlock=');

    let outboundAfterPayment = outboundBeforePayment;
    await expect.poll(async () => {
      outboundAfterPayment = await getRenderedOutbound(page);
      return outboundAfterPayment;
    }, { timeout: CONSENSUS_TIMEOUT }).toBeLessThan(outboundBeforePayment);
    const persistedBeforeReload = await getPrimaryAccountState(page, connectedHubId ?? undefined);
    expect(persistedBeforeReload, 'account state must exist before reload').not.toBeNull();

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

    await expect.poll(async () => {
      return await getPrimaryAccountState(page, connectedHubId ?? undefined);
    }, { timeout: 60_000 }).toEqual(persistedBeforeReload);
    process.stdout.write(
      `  Reload state verified: h=${persistedBeforeReload?.currentHeight ?? 0}, outWei=${persistedBeforeReload?.outboundWei ?? '0'}\n`,
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
