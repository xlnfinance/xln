/**
 * Direct credit account E2E between two unaffiliated entities (MML commercial edge):
 * 1. Fresh Alice and Bob open on the same stack without funding through a hub.
 * 2. Bob opens a direct bilateral Account with Alice and extends a 50 USDC credit line through the visible UI.
 * 3. Alice pays Bob 20 USDC directly over that credit line (zero routing fee, zero hub intermediary).
 * 4. Both sides verify exact bilateral balances (-20 USDC / +20 USDC), Desk MML exposure ($10.00 = 0.5 * $20 unsecured), and survive reload.
 */
import { expect, test, type Page } from '@playwright/test';
import type { RuntimeAdapterViewFrame, XLNModule } from '../../core/api/public/runtime-module';
import type { RuntimeAdapter } from '../../core/api/runtime-adapter/types';
import { enterStack, reopenStack } from './stack';

const WAIT = { timeout: 20_000 };

async function directAccountBalance(page: Page, ownerId: string, peerId: string) {
  return page.evaluate(
    async ({ owner, peer }) => {
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
      const account = view.activeEntity?.accounts.items.find(item => {
        const left = item.state.leftEntity.toLowerCase();
        const right = item.state.rightEntity.toLowerCase();
        return (left === owner && right === peer) || (left === peer && right === owner);
      });
      const delta = account?.state.deltas.get(1);
      if (!account || !delta) return null;
      const derived = (await debug.xln()).deriveDelta(delta, account.state.leftEntity.toLowerCase() === owner);
      return {
        signed: String(derived.outCollateral + derived.outPeerCredit - derived.inOwnCredit),
        ownCreditLimit: String(derived.ownCreditLimit),
        peerCreditLimit: String(derived.peerCreditLimit),
        inCapacity: String(derived.inCapacity),
        outCapacity: String(derived.outCapacity),
        pending: Boolean(account.pendingFrame),
        mempool: account.mempoolCount,
      };
    },
    { owner: ownerId.toLowerCase(), peer: peerId.toLowerCase() },
  );
}

test(
  'two unaffiliated wallets open a direct credit account through the UI and settle a commercial payment',
  { tag: '@functional' },
  async ({ browser, baseURL }) => {
    test.setTimeout(90_000);
    if (!baseURL) throw new Error('Wallet test URL missing');
    const aliceContext = await browser.newContext({ baseURL });
    const bobContext = await browser.newContext({ baseURL });
    const a = await aliceContext.newPage();
    const b = await bobContext.newPage();
    const errors: string[] = [];
    for (const page of [a, b]) page.on('pageerror', error => errors.push(error.message));

    try {
      const [alice, bob] = await Promise.all([enterStack(a), enterStack(b)]);
      expect(alice.entityId).not.toBe(bob.entityId);

      // Bob opens a direct bilateral Account with Alice and extends a 50 USDC credit line.
      await b.getByRole('button', { name: 'Connect another account', exact: true }).click();
      await b.getByTestId('open-account-target').fill(alice.entityId);
      await b.getByTestId('open-account-credit').fill('50');
      await expect(b.getByTestId('open-account-submit')).toBeEnabled(WAIT);
      // Wait until Bob's runtime discovers Alice's gossiped non-hub profile so role evidence is verified.
      await expect
        .poll(
          () =>
            b.evaluate(
              async ({ self, target }) => {
                const adapter = (window as Window & { __xln?: { adapter(): RuntimeAdapter | null } }).__xln?.adapter();
                if (!adapter) return false;
                const view = await adapter.read<RuntimeAdapterViewFrame>('view-frame', { entityId: self });
                return view.entities.some(e => e.entityId.toLowerCase() === target && e.isHub === false);
              },
              { self: bob.entityId, target: alice.entityId.toLowerCase() },
            ),
          WAIT,
        )
        .toBe(true);

      await b.getByTestId('open-account-submit').click();

      // Both sides converge on the direct bilateral Account with 50 USDC credit from Bob to Alice.
      await expect
        .poll(() => directAccountBalance(b, bob.entityId, alice.entityId), WAIT)
        .toEqual({
          signed: '0',
          ownCreditLimit: '0',
          peerCreditLimit: '50000000',
          inCapacity: '50000000',
          outCapacity: '0',
          pending: false,
          mempool: 0,
        });
      await expect
        .poll(() => directAccountBalance(a, alice.entityId, bob.entityId), WAIT)
        .toEqual({
          signed: '0',
          ownCreditLimit: '50000000',
          peerCreditLimit: '0',
          inCapacity: '0',
          outCapacity: '50000000',
          pending: false,
          mempool: 0,
        });

      // Alice pays Bob 20 USDC directly over the credit line (0 routing fee).
      await a.getByTestId('home-pay').click();
      await a.getByTestId('pay-to').fill(bob.entityId);
      await a.getByTestId('pay-amount').fill('20');
      await expect(a.getByTestId('pay-submit')).toBeEnabled(WAIT);
      const quote = a.getByTestId('pay-quote');
      await expect(quote).toHaveAttribute('data-fee-amount', '0');
      await expect(quote).toHaveAttribute('data-sender-amount', '20000000');
      await a.getByTestId('pay-submit').click();
      await a.getByTestId('receipt-open').click();
      await expect(a.getByTestId('receipt-kicker')).toHaveText('Paid', WAIT);
      await a.getByTestId('receipt-done').click();

      // Both peers must retain the exact money, authority and settled state after reload.
      const aliceAfterPayment = {
        signed: '-20000000',
        ownCreditLimit: '50000000',
        peerCreditLimit: '0',
        inCapacity: '20000000',
        outCapacity: '30000000',
        pending: false,
        mempool: 0,
      };
      const bobAfterPayment = {
        signed: '20000000',
        ownCreditLimit: '0',
        peerCreditLimit: '50000000',
        inCapacity: '30000000',
        outCapacity: '20000000',
        pending: false,
        mempool: 0,
      };
      await expect.poll(() => directAccountBalance(a, alice.entityId, bob.entityId), WAIT).toEqual(aliceAfterPayment);
      await expect.poll(() => directAccountBalance(b, bob.entityId, alice.entityId), WAIT).toEqual(bobAfterPayment);

      // Check Desk MML exposure ($10.00 = 0.5 * $20 unsecured commercial obligation).
      await b.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k');
      await b.getByTestId('palette-input').fill('desk');
      await b.getByRole('option', { name: 'Desk dense console', exact: true }).click();
      await expect(b.getByTestId('desk-revenue')).toContainText('$10.00', WAIT);

      // Reload both wallets and confirm the direct commercial obligation persists.
      await Promise.all([a.reload(), b.reload()]);
      await Promise.all([reopenStack(a, alice), reopenStack(b, bob)]);
      await expect.poll(() => directAccountBalance(a, alice.entityId, bob.entityId), WAIT).toEqual(aliceAfterPayment);
      await expect.poll(() => directAccountBalance(b, bob.entityId, alice.entityId), WAIT).toEqual(bobAfterPayment);
      expect(errors).toEqual([]);
    } finally {
      await Promise.all([aliceContext.close(), bobContext.close()]);
    }
  },
);
