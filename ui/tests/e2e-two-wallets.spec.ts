import { expect, test, type Page } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import type { RuntimeAdapterViewFrame, XLNModule } from '../../core/api/public/runtime-module';
import type { RuntimeAdapter, RuntimeAdapterFrameReceiptResponse } from '../../core/api/runtime-adapter/types';
import { safeStringify } from '../../core/protocol/serialization';
import { enterStack, readWalletCheckpoint, reopenStack, type StackWallet } from './stack';
import { readCommittedPayment } from './payment-evidence';

// Separate bounded processes may prepare and reopen these real browser databases.
// No seed-only reconstruction: storageState includes the actual IndexedDB WAL.
const directory = process.env['XLN_TWO_WALLET_DIR'] ?? '/tmp/xln-two-wallet-e2e';
const file = (role: string, kind: string) => `${directory}/${role}-${kind}.json`;

async function balance(page: Page, entityId: string) {
  return page.evaluate(async owner => {
    const debug = (
      window as Window & {
        __xln?: {
          adapter(): RuntimeAdapter | null;
          xln(): Promise<XLNModule>;
        };
      }
    ).__xln;
    const adapter = debug?.adapter();
    if (!debug || !adapter) throw new Error('Wallet adapter unavailable');
    const view = await adapter.read<RuntimeAdapterViewFrame>('view-frame', { entityId: owner });
    const account = view.activeEntity?.accounts.items[0];
    const delta = account?.state.deltas.get(1);
    if (!account || !delta) throw new Error('Wallet USDC Account unavailable');
    const derived = (await debug.xln()).deriveDelta(delta, account.state.leftEntity === owner);
    return {
      owned: String(derived.outCollateral + derived.outPeerCredit - derived.inOwnCredit),
      pending: Boolean(account.pendingFrame),
      mempool: account.mempoolCount,
    };
  }, entityId);
}

for (const role of ['alice', 'bob']) {
  test(`prepare fresh ${role} with 100 USDC`, { tag: '@functional' }, async ({ page }) => {
    test.setTimeout(50_000);
    const wallet = await enterStack(page);
    await page.getByTestId('home-faucet').click();
    await expect(page.getByTestId('test-money-status')).toHaveText('100 USDC received');
    await expect.poll(() => balance(page, wallet.entityId)).toEqual({ owned: '100000000', pending: false, mempool: 0 });
    const checkpoint = await readWalletCheckpoint(page);
    await mkdir(directory, { recursive: true });
    await page.context().storageState({ path: file(role, 'storage'), indexedDB: true });
    await writeFile(file(role, 'evidence'), safeStringify({ wallet, checkpoint }));
    console.log('FRESH_WALLET_FUNDED', role, wallet.entityId, checkpoint.frame.height);
  });
}

test(
  'Alice pays Bob exactly once and both balances survive reload',
  { tag: '@functional' },
  async ({ browser, baseURL }) => {
    test.setTimeout(50_000);
    if (!baseURL) throw new Error('Wallet test URL missing');
    const alice = JSON.parse(await readFile(file('alice', 'evidence'), 'utf8')) as { wallet: StackWallet };
    const bob = JSON.parse(await readFile(file('bob', 'evidence'), 'utf8')) as { wallet: StackWallet };
    expect(alice.wallet.runtimeId).not.toBe(bob.wallet.runtimeId);
    const aliceContext = await browser.newContext({ baseURL, storageState: file('alice', 'storage') });
    const bobContext = await browser.newContext({ baseURL, storageState: file('bob', 'storage') });
    const a = await aliceContext.newPage();
    const b = await bobContext.newPage();
    const errors: string[] = [];
    for (const page of [a, b]) page.on('pageerror', error => errors.push(error.message));
    const started = Date.now();
    try {
      await Promise.all([a.goto('/'), b.goto('/')]);
      await Promise.all([reopenStack(a, alice.wallet), reopenStack(b, bob.wallet)]);
      console.log('TWO_WALLETS_OPEN_MS', Date.now() - started);
      for (const [page, wallet] of [
        [a, alice.wallet],
        [b, bob.wallet],
      ] as const) {
        await expect
          .poll(() => balance(page, wallet.entityId))
          .toEqual({ owned: '100000000', pending: false, mempool: 0 });
      }
      // Faucet filled Bob's explicitly granted 100-USDC receive limit. Bob
      // prepares the next invoice through Receive; no implicit credit increase.
      await b.getByTestId('home-receive').click();
      await b.getByTestId('receive-amount').fill('25');
      await expect(b.getByTestId('receive-spectrum')).toBeVisible();
      await b.getByRole('button', { name: '0% collateral', exact: true }).click();
      await b.getByTestId('receive-spectrum-confirm').click();
      await expect(b.getByTestId('receive-spectrum')).toHaveCount(0, { timeout: 10_000 });
      expect((await balance(b, bob.wallet.entityId)).owned).toBe('100000000');
      const [beforeA, beforeB] = await Promise.all([readWalletCheckpoint(a), readWalletCheckpoint(b)]);
      await a.getByTestId('home-pay').click();
      await a.getByTestId('pay-to').fill(bob.wallet.entityId);
      await a.getByTestId('pay-amount').fill('25');
      await expect(a.getByTestId('pay-submit')).toBeEnabled({ timeout: 10_000 });
      const ceiling = await a.getByTestId('pay-quote').getAttribute('data-sender-amount');
      if (!ceiling) throw new Error('Displayed sender debit missing');
      await a.getByTestId('pay-submit').dblclick();
      await a.getByTestId('receipt-open').click();
      await expect(a.getByTestId('receipt-kicker')).toHaveText('Paid', { timeout: 10_000 });
      const payment = await readCommittedPayment(a, alice.wallet.entityId, beforeA.frame.height + 1);
      expect(payment.amount).toBe('25000000');
      expect(BigInt(payment.senderAmount)).toBe(25_000_000n + BigInt(payment.fee));
      expect(BigInt(payment.senderAmount)).toBeLessThanOrEqual(BigInt(ceiling));
      const expectedAlice = String(100_000_000n - BigInt(payment.senderAmount));
      await expect
        .poll(() => balance(a, alice.wallet.entityId))
        .toEqual({ owned: expectedAlice, pending: false, mempool: 0 });
      await expect
        .poll(() => balance(b, bob.wallet.entityId))
        .toEqual({ owned: '125000000', pending: false, mempool: 0 });
      console.log(
        'TWO_WALLETS_PAID_MS',
        Date.now() - started,
        safeStringify({ payment, alice: expectedAlice, bob: '125000000' }),
      );
      await a.getByTestId('receipt-done').click();
      const [paidA, paidB] = await Promise.all([readWalletCheckpoint(a), readWalletCheckpoint(b)]);
      await Promise.all([a.reload(), b.reload()]);
      await Promise.all([reopenStack(a, alice.wallet), reopenStack(b, bob.wallet)]);
      const [restoredA, restoredB] = await Promise.all([readWalletCheckpoint(a), readWalletCheckpoint(b)]);
      expect(restoredA.accounts).toEqual(paidA.accounts);
      expect(restoredB.accounts).toEqual(paidB.accounts);
      expect(await balance(a, alice.wallet.entityId)).toEqual({ owned: expectedAlice, pending: false, mempool: 0 });
      expect(await balance(b, bob.wallet.entityId)).toEqual({ owned: '125000000', pending: false, mempool: 0 });
      expect(await readCommittedPayment(a, alice.wallet.entityId, beforeA.frame.height + 1)).toEqual(payment);
      const received = await b.evaluate(
        async ({ owner, from, hash }) => {
          const adapter = (window as Window & { __xln?: { adapter(): RuntimeAdapter | null } }).__xln?.adapter();
          if (!adapter) throw new Error('Receiver adapter unavailable');
          const view = await adapter.read<RuntimeAdapterViewFrame>('view-frame', { entityId: owner });
          const receipts = await adapter.read<RuntimeAdapterFrameReceiptResponse>('frame-receipts', {
            entityId: owner,
            fromHeight: from,
            toHeight: view.height,
            limit: 500,
            eventNames: ['HtlcReceived'],
          });
          if (receipts.toHeight !== view.height) throw new Error('Receiver history is incomplete');
          return receipts.receipts.flatMap(row => row.logs).filter(log => log.data?.['hashlock'] === hash);
        },
        { owner: bob.wallet.entityId, from: beforeB.frame.height + 1, hash: payment.hashlock },
      );
      expect(received).toHaveLength(1);
      expect(received[0]?.data?.['amount']).toBe('25000000');
      expect(received[0]?.data?.['entityId']).toBe(bob.wallet.entityId);
      expect(errors).toEqual([]);
      await writeFile(
        `${directory}/payment-proof.json`,
        safeStringify({ payment, paidA, paidB, restoredA, restoredB, received }),
      );
      console.log('TWO_WALLETS_RECOVERED_MS', Date.now() - started);
    } finally {
      await aliceContext.close();
      await bobContext.close();
    }
  },
);
