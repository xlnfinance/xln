/**
 * Recovery that keeps working: a wallet restored from its watchtower backup on
 * a clean device pays from the recovered Account, and the exact post-payment
 * balance survives closing the tab and unlocking the wallet again.
 */
import { expect, test, type Page } from '@playwright/test';
import type { RuntimeAdapterViewFrame, XLNModule } from '../../core/api/public/runtime-module';
import type { RuntimeAdapter } from '../../core/api/runtime-adapter/types';
import { safeStringify } from '../../core/protocol/serialization';
import { readCommittedPayment } from './payment-evidence';
import { LOCAL_PASSWORD, enterStack, readWalletCheckpoint, reopenStack } from './stack';

type DebugWindow = Window & { __xln?: { adapter(): RuntimeAdapter | null; xln(): Promise<XLNModule> } };

const TOWER = 'http://127.0.0.1:9100';
const FUNDED = 100_000_000n;
const PAYMENT = 25_000_000n;

/** The committed primary USDC Account, independently of rendered text. */
const readUsdc = (page: Page, owner: string) =>
  page.evaluate(async entityId => {
    const debug = (window as DebugWindow).__xln;
    const adapter = debug?.adapter();
    if (!debug || !adapter) throw new Error('Wallet diagnostics unavailable');
    const view = await adapter.read<RuntimeAdapterViewFrame>('view-frame', { entityId });
    const account = view.activeEntity?.accounts.items[0];
    const delta = account?.state.deltas.get(1);
    if (!account || !delta || view.activeEntity?.accounts.items.length !== 1)
      throw new Error('Wallet USDC Account unavailable');
    const derived = (await debug.xln()).deriveDelta(delta, account.state.leftEntity === entityId);
    return {
      owned: String(derived.outCollateral + derived.outPeerCredit - derived.inOwnCredit),
      pending: Boolean(account.pendingFrame),
      mempool: account.mempoolCount,
    };
  }, owner);

test(
  'tower-restored wallet pays exactly and keeps the balance across tab close and unlock',
  { tag: '@functional' },
  async ({ browser }) => {
    test.setTimeout(120_000);
    const source = await browser.newContext();
    const target = await browser.newContext();
    const errors: string[] = [];
    const started = Date.now();
    const mark = (label: string) => console.log(`TOWER_PAY_${label}_MS`, Date.now() - started);
    try {
      const page = await source.newPage();
      const wallet = await enterStack(page);
      await page.getByTestId('home-faucet').click();
      await expect(page.getByTestId('test-money-status')).toHaveText('100 USDC received', { timeout: 20_000 });
      await expect
        .poll(() => readUsdc(page, wallet.entityId), { timeout: 15_000 })
        .toEqual({ owned: FUNDED.toString(), pending: false, mempool: 0 });
      await page.getByTestId('home-sovereignty').click();
      await page.getByTestId('watchtower-url').fill(TOWER);
      await page.getByTestId('watchtower-add').click();
      await expect(page.getByTestId('sovereignty-watchtower')).toHaveAttribute('data-covered', 'yes', {
        timeout: 20_000,
      });
      const coverage = await page.getByTestId('watchtower-coverage-backup').innerText();
      const match = coverage.match(/#([\d,]+)/);
      if (!match?.[1]) throw new Error(`Tower supplied no backup height: ${coverage}`);
      const backed = await readWalletCheckpoint(page, Number(match[1].replaceAll(',', '')));
      mark('BACKED_UP');
      // Stop the original device's Runtime; its browser profile stays untouched until teardown.
      await page.close();
      mark('SOURCE_CLOSED');

      // Clean device: only the phrase and the tower URL.
      const restored = await target.newPage();
      restored.on('pageerror', error => errors.push(error.message));
      await restored.goto('/');
      await expect(restored.getByTestId('gate-stack')).toHaveAttribute('data-state', 'online', { timeout: 20_000 });
      await restored.getByRole('button', { name: /Restore a wallet/ }).click();
      await restored.locator('textarea').fill(wallet.phrase);
      await restored.getByTestId('restore-from-tower').check();
      await restored.getByTestId('restore-tower-url').fill(TOWER);
      await restored.getByRole('button', { name: 'Restore wallet', exact: true }).click();
      await restored.getByLabel('Password', { exact: true }).fill(LOCAL_PASSWORD);
      await restored.getByLabel('Confirm password', { exact: true }).fill(LOCAL_PASSWORD);
      await restored.getByRole('button', { name: 'Save and open', exact: true }).click();
      await expect(restored.locator('[data-testid="nav-home"]:visible, .gate-error').first()).toBeVisible({
        timeout: 25_000,
      });
      await expect(restored.locator('.gate-error')).toHaveCount(0);
      mark('RESTORE_OPEN');
      const recovered = await readWalletCheckpoint(restored, backed.frame.height);
      expect(recovered.runtimeId).toBe(wallet.runtimeId);
      expect(recovered.entityId).toBe(wallet.entityId);
      expect(recovered.accounts).toEqual(backed.accounts);
      await expect
        .poll(() => readUsdc(restored, wallet.entityId), { timeout: 20_000 })
        .toEqual({ owned: FUNDED.toString(), pending: false, mempool: 0 });
      mark('RESTORED');

      await restored.getByTestId('home-pay').click();
      await restored.getByTestId('pay-to').fill('H2');
      await restored.getByTestId('pay-amount').fill('25');
      await expect(restored.getByTestId('pay-submit')).toBeEnabled({ timeout: 20_000 });
      const quote = restored.getByTestId('pay-quote');
      const [senderText, recipientText, feeText] = await Promise.all(
        ['data-sender-amount', 'data-recipient-amount', 'data-fee-amount'].map(name => quote.getAttribute(name)),
      );
      if (!senderText || !recipientText || !feeText) throw new Error('Displayed payment quote incomplete');
      expect(BigInt(recipientText)).toBe(PAYMENT);
      expect(BigInt(senderText)).toBe(PAYMENT + BigInt(feeText));
      const fromHeight = (await readWalletCheckpoint(restored)).frame.height + 1;
      await restored.getByTestId('pay-submit').click();
      await expect(restored.getByTestId('receipt-kicker')).toHaveText('Paid', { timeout: 20_000 });
      await expect(restored.getByTestId('receipt-title')).toContainText('H2');
      const payment = await readCommittedPayment(restored, wallet.entityId, fromHeight);
      expect(payment.amount).toBe(recipientText);
      expect(BigInt(payment.senderAmount)).toBe(PAYMENT + BigInt(payment.fee));
      expect(BigInt(payment.senderAmount)).toBeLessThanOrEqual(BigInt(senderText));
      const expectedOwned = (FUNDED - BigInt(payment.senderAmount)).toString();
      await expect
        .poll(() => readUsdc(restored, wallet.entityId), { timeout: 15_000 })
        .toEqual({ owned: expectedOwned, pending: false, mempool: 0 });
      await restored.getByTestId('receipt-done').click();
      const paid = await readWalletCheckpoint(restored);
      mark('PAID');
      expect(paid.accounts.every(account => !account.pending && account.mempool === 0)).toBe(true);

      // Close the tab: the next tab must unlock the same durable wallet, not restore again.
      await restored.close();
      mark('TAB_CLOSED');
      const reopened = await target.newPage();
      reopened.on('pageerror', error => errors.push(error.message));
      await reopened.goto('/');
      await reopenStack(reopened, wallet);
      mark('UNLOCKED');
      const afterUnlock = await readWalletCheckpoint(reopened, paid.frame.height);
      expect(afterUnlock.frame).toEqual(paid.frame);
      expect(afterUnlock.accounts).toEqual(paid.accounts);
      mark('CHECKPOINT');
      await expect
        .poll(() => readUsdc(reopened, wallet.entityId), { timeout: 15_000 })
        .toEqual({ owned: expectedOwned, pending: false, mempool: 0 });
      expect(await readCommittedPayment(reopened, wallet.entityId, fromHeight)).toEqual(payment);
      expect(errors).toEqual([]);
      console.log(
        'TOWER_RESTORE_PAY',
        safeStringify({ backup: backed.frame, quote: { senderText, recipientText, feeText }, payment, expectedOwned }),
      );
    } finally {
      await Promise.all([source.close(), target.close()]);
    }
  },
);
