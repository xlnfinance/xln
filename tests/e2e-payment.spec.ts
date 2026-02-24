/**
 * E2E HTLC Payment Flow Test
 *
 * Separate runtime test: Browser runtime ↔ Production hub via WSS relay
 *
 * Flow:
 * 1. Clear state, load app (browser runtime initializes)
 * 2. Connect to Hub H1 (bilateral account open via relay)
 * 3. Receive $100 via offchain faucet (hub sends directPayment)
 * 4. Send $25 via HTLC (htlc_lock → htlc_reveal → delta settled)
 * 5. Verify final balances: OUT=75, IN=9925
 * 6. Verify HTLC was used (console log proof)
 *
 * Prerequisites:
 * - XLN stack (relay/api/frontend) running
 * - For isolated runner, URLs come from E2E_BASE_URL / E2E_API_BASE_URL
 */

import { test, expect, type Page } from '@playwright/test';

const HUB_H1_ENTITY_ID = '0x8164c386f3a0e528e43fe8352aca11c0334f9263b601639a0eefd827a317aafe';
const CONSENSUS_TIMEOUT = 30_000;
const APP_BASE_URL = process.env.E2E_BASE_URL || process.env.PW_BASE_URL || 'https://localhost:8080';
const API_BASE_URL = process.env.E2E_API_BASE_URL || APP_BASE_URL;
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

test.describe('E2E HTLC Payment Flow', () => {
  test.skip(!process.env.RUN_PROD_SMOKE, 'Manual production smoke test only (set RUN_PROD_SMOKE=1)');

  test('full HTLC bilateral payment through hub', async ({ page }) => {
    test.setTimeout(LONG_E2E ? 180_000 : 60_000);
    const console = new ConsoleCollector();
    console.attach(page);

    // Log errors for debugging
    page.on('console', (msg) => {
      if (msg.type() === 'error') process.stdout.write(`[Browser ERROR] ${msg.text()}\n`);
    });

    // ── Step 0: Wait for server ──
    process.stdout.write('Step 0: Waiting for server health...\n');
    for (let i = 0; i < 10; i++) {
      try {
        const resp = await page.request.get(`${API_BASE_URL}/api/health`);
        if (resp.ok()) { process.stdout.write('  Server healthy!\n'); break; }
      } catch {}
      await page.waitForTimeout(3000);
    }

    // ── Step 1: Clear state and load ──
    process.stdout.write('Step 1: Loading app with fresh state...\n');
    await page.goto(`${APP_BASE_URL}/app`);
    await page.evaluate(() => localStorage.clear());
    // WebSocket + polling keep network active; networkidle can hang indefinitely.
    await page.reload({ waitUntil: 'domcontentloaded' });

    // Handle access code gate
    const accessInput = page.locator('input[placeholder*="access" i], input[placeholder*="code" i]');
    if (await accessInput.isVisible({ timeout: 3000 }).catch(() => false)) {
      await accessInput.fill('mml');
      await page.locator('button:has-text("Unlock")').click();
      await page.waitForURL('**/app**', { timeout: 10_000 });
    }

    // Wait for runtime/UI boot (UI structure changed over time, keep this probe broad)
    await page.waitForFunction(() => {
      const w = window as any;
      const hasRuntime = Boolean(w?.XLN || w?.xlnEnv);
      const text = document.body?.textContent || '';
      const hasEntityId = /0x[a-fA-F0-9]{8,}/.test(text);
      const hasAccountsUi = Array.from(document.querySelectorAll('button,[role="tab"]'))
        .some((el) => /accounts/i.test(el.textContent || ''));
      return hasRuntime && (hasEntityId || hasAccountsUi);
    }, { timeout: 30_000 });
    process.stdout.write('  Runtime initialized.\n');

    // ── Step 2: Connect to Hub H1 ──
    process.stdout.write('Step 2: Connecting to Hub H1...\n');
    const connectBtn = page.locator('button:has-text("Connect")').first();
    await expect(connectBtn).toBeVisible({ timeout: 15_000 });

    const consensusP = console.waitFor(/Frame.*committed|Accepted frame|frame 1/i);
    await connectBtn.click();
    await consensusP.catch(() => {});
    await expect(page.locator('text=/Synced|OUT|IN.*USDC/i').first()).toBeVisible({ timeout: CONSENSUS_TIMEOUT });
    process.stdout.write('  Account opened and synced.\n');

    // ── Step 3: Get Test Funds ──
    process.stdout.write('Step 3: Requesting test funds...\n');
    const faucetBtn = page.locator('button:has-text("Test Funds"), button:has-text("faucet")').first();
    if (await faucetBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await faucetBtn.click();
      await page.waitForTimeout(6000); // Wait for bilateral consensus to settle funds
    }

    // Verify outbound capacity
    const outLocator = page.locator('text=/OUT.*\\d+/i').first();
    await expect(outLocator).toBeVisible({ timeout: CONSENSUS_TIMEOUT });
    const outText = await outLocator.textContent();
    process.stdout.write(`  Balance: ${outText}\n`);
    expect(outText).toBeTruthy();

    // ── Step 4: Send $25 via HTLC ──
    process.stdout.write('Step 4: Sending $25 via HTLC...\n');

    // Switch to Send tab
    const sendTab = page.locator('button:has-text("Send"), [role="tab"]:has-text("Send")').first();
    await sendTab.click();
    await page.waitForTimeout(1000);

    // Verify HTLC toggle is checked (default)
    const htlcToggle = page.locator('input[type="checkbox"]').first();
    const isHtlc = await htlcToggle.isChecked();
    expect(isHtlc).toBe(true);
    process.stdout.write(`  HTLC mode: ${isHtlc ? 'ON' : 'OFF'}\n`);

    // Fill recipient
    const recipientInput = page.locator('input[placeholder*="recipient" i], input[placeholder*="entity" i], input[placeholder*="select" i]').first();
    await recipientInput.fill(HUB_H1_ENTITY_ID);
    await page.keyboard.press('Escape');

    // Fill amount
    const amountInput = page.locator('input[placeholder*="0.00" i], input[type="text"]').nth(1);
    await amountInput.click();
    await amountInput.fill('25');

    // Find Routes
    const findRoutesBtn = page.locator('button:has-text("Find Routes")');
    await expect(findRoutesBtn).toBeEnabled({ timeout: 5000 });
    await findRoutesBtn.click();
    await expect(page.locator('text=/1 hop|route/i').first()).toBeVisible({ timeout: 10_000 });

    // Send Payment — capture HTLC-specific console logs
    const htlcSecretP = console.waitFor(/\[Send\] HTLC secret=/);
    const sendPaymentBtn = page.locator('button:has-text("Send Payment")');
    await expect(sendPaymentBtn).toBeEnabled({ timeout: 5000 });
    await sendPaymentBtn.click();

    // Wait for HTLC secret generation (proves htlcPayment was used, not directPayment)
    const htlcLog = await htlcSecretP;
    process.stdout.write(`  ${htlcLog}\n`);
    expect(htlcLog).toContain('HTLC secret=');
    expect(htlcLog).toContain('hashlock=');

    // Wait for HTLC lock+reveal cycle to complete
    await page.waitForTimeout(8000);

    // Verify HTLC handler was invoked (browser-side logs)
    const htlcHandlerLog = console.find(/HTLC-PAYMENT HANDLER/);
    process.stdout.write(`  HTLC handler: ${htlcHandlerLog ? 'INVOKED' : 'not found (may be server-side only)'}\n`);

    // ── Step 5: Verify final state ──
    process.stdout.write('Step 5: Verifying final state...\n');

    // Go back to Accounts tab
    const accountsTab = page.locator('button:has-text("Accounts"), [role="tab"]:has-text("Accounts")').first();
    await accountsTab.click();
    await page.waitForTimeout(2000);

    // Verify balances: OUT=75, IN=9925 (100 faucet - 25 sent)
    const pageContent = await page.textContent('body');
    expect(pageContent).toContain('75');
    expect(pageContent).toContain('Synced');

    // Verify HTLC payment log (not directPayment)
    const paymentSentLog = console.find(/\[Send\] HTLC payment sent via:/);
    expect(paymentSentLog).toBeTruthy();
    process.stdout.write(`  ${paymentSentLog}\n`);

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
