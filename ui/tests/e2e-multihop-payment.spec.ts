/**
 * A payment that crosses two hubs. Alice holds an account only with H1; Bob's
 * only incoming capacity is the credit line he grants H2, so the Runtime's
 * pathfinder must route Alice → H1 → H2 → Bob. The UI quote is the fee
 * authority; the committed HTLC receipt and both Accounts must agree with it.
 */
import { expect, test, type Page } from '@playwright/test';
import type { RuntimeAdapterViewFrame, XLNModule } from '../../core/api/public/runtime-module';
import type {
  RuntimeAdapter,
  RuntimeAdapterFrameReceiptResponse,
  RuntimeAdapterPaymentRoutesResponse,
} from '../../core/api/runtime-adapter/types';
import { safeStringify } from '../../core/protocol/serialization';
import { readCommittedPayment } from './payment-evidence';
import { enterStack, readWalletCheckpoint } from './stack';

type DebugWindow = Window & { __xln?: { adapter(): RuntimeAdapter | null; xln(): Promise<XLNModule> } };
type AccountDoc = NonNullable<RuntimeAdapterViewFrame['activeEntity']>['accounts']['items'][number];

const USDC = 1;
const BOB_CREDIT = 50_000_000n;
const PAYMENT = 25_000_000n;

/** One committed bilateral USDC position, from the owner's perspective. */
const readUsdc = (page: Page, owner: string, counterparty: string) =>
  page.evaluate(
    async ({ owner, counterparty, tokenId }) => {
      const debug = (window as DebugWindow).__xln;
      const adapter = debug?.adapter();
      if (!debug || !adapter) throw new Error('Wallet diagnostics unavailable');
      const xln = await debug.xln();
      const account = await adapter.read<AccountDoc>(`entity/${owner}/account/${counterparty}`);
      const delta = account.state.deltas.get(tokenId);
      if (!delta)
        return {
          owned: '0',
          inCapacity: '0',
          outCapacity: '0',
          pending: Boolean(account.pendingFrame),
          mempool: account.mempoolCount,
        };
      const derived = xln.deriveDelta(delta, xln.isLeftEntity(owner, counterparty));
      return {
        owned: String(derived.outCollateral + derived.outPeerCredit - derived.inOwnCredit),
        inCapacity: String(derived.inCapacity),
        outCapacity: String(derived.outCapacity),
        pending: Boolean(account.pendingFrame),
        mempool: account.mempoolCount,
      };
    },
    { owner, counterparty, tokenId: USDC },
  );

/** The same Runtime pathfinder read the Pay screen quotes from. */
const readRoutes = (page: Page, source: string, target: string, amount: bigint) =>
  page.evaluate(
    async ({ source, target, amount, tokenId }) => {
      const adapter = (window as DebugWindow).__xln?.adapter();
      if (!adapter) throw new Error('Wallet adapter unavailable');
      const response = await adapter.read<RuntimeAdapterPaymentRoutesResponse>('payment-routes', {
        sourceEntityId: source,
        targetEntityId: target,
        tokenId,
        amount,
      });
      return response.routes.map(route => ({
        path: route.path.map(id => id.toLowerCase()),
        fees: route.hops.map(hop => String(hop.fee)),
        totalFee: String(route.totalFee),
        senderAmount: String(route.senderAmount),
        recipientAmount: String(route.recipientAmount),
      }));
    },
    { source, target, amount: amount.toString(), tokenId: USDC },
  );

const readReceived = (page: Page, owner: string, fromHeight: number, hashlock: string) =>
  page.evaluate(
    async ({ owner, from, hash }) => {
      const adapter = (window as DebugWindow).__xln?.adapter();
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
      return receipts.receipts
        .flatMap(row => row.logs)
        .filter(log => log.data?.['hashlock'] === hash)
        .map(log => ({ amount: String(log.data?.['amount']), entityId: String(log.data?.['entityId']) }));
    },
    { owner, from: fromHeight, hash: hashlock },
  );

const hubId = async (page: Page, name: string): Promise<string> => {
  const payload = (await (await page.request.get('/api/hubs')).json()) as {
    hubs: { name: string; entityId: string; metadata?: { jurisdiction?: { chainId?: number } } }[];
  };
  const hub = payload.hubs.find(entry => entry.name === name && entry.metadata?.jurisdiction?.chainId === 31337);
  if (!hub) throw new Error(`Stack hub ${name} unavailable`);
  return hub.entityId.toLowerCase();
};

test(
  'Alice pays Bob across H1 and H2 at the quoted fee; a payment beyond her capacity is refused before submit',
  { tag: '@functional' },
  async ({ browser }) => {
    test.setTimeout(120_000);
    const aliceContext = await browser.newContext();
    const bobContext = await browser.newContext();
    const errors: string[] = [];
    const started = Date.now();
    try {
      const a = await aliceContext.newPage();
      const b = await bobContext.newPage();
      for (const page of [a, b]) page.on('pageerror', error => errors.push(error.message));
      const [h1, h2] = await Promise.all([hubId(a, 'H1'), hubId(a, 'H2')]);
      const [alice, bob] = await Promise.all([enterStack(a), enterStack(b)]);
      await a.getByTestId('home-faucet').click();
      await expect(a.getByTestId('test-money-status')).toHaveText('100 USDC received', { timeout: 20_000 });

      // Bob grants H2, and only H2, a 50 USDC line: his sole incoming capacity.
      await b.getByRole('button', { name: 'Connect another account', exact: true }).click();
      const sheet = b.getByRole('dialog', { name: 'Open account', exact: true });
      await sheet.getByPlaceholder('or paste an entity id, 0x…').fill(h2);
      await sheet.getByPlaceholder('0.00').fill('50');
      await sheet.getByRole('button', { name: 'Propose account', exact: true }).click();
      await expect(b.getByTestId('account-row')).toHaveCount(2, { timeout: 20_000 });
      await expect
        .poll(() => readUsdc(b, bob.entityId, h2), { timeout: 20_000 })
        .toMatchObject({ owned: '0', inCapacity: BOB_CREDIT.toString(), pending: false, mempool: 0 });
      expect(await readUsdc(b, bob.entityId, h1)).toMatchObject({ owned: '0', inCapacity: '0' });
      await expect
        .poll(() => readUsdc(a, alice.entityId, h1), { timeout: 20_000 })
        .toMatchObject({ owned: '100000000', pending: false, mempool: 0 });

      await a.getByTestId('home-pay').click();
      await a.getByTestId('pay-to').fill(bob.entityId);
      await a.getByTestId('pay-amount').fill('25');
      await expect(a.getByTestId('pay-submit')).toBeEnabled({ timeout: 20_000 });
      const quote = a.getByTestId('pay-quote');
      const [senderText, recipientText, feeText] = await Promise.all(
        ['data-sender-amount', 'data-recipient-amount', 'data-fee-amount'].map(name => quote.getAttribute(name)),
      );
      if (!senderText || !recipientText || !feeText) throw new Error('Displayed payment quote incomplete');
      const routes = await readRoutes(a, alice.entityId, bob.entityId, PAYMENT);
      console.log('MULTIHOP_ROUTES', safeStringify(routes));
      const [best] = routes;
      if (!best) throw new Error('Pathfinder returned no route');
      // The displayed quote is the pathfinder's best route: two forwarding hubs.
      expect(best.path).toEqual([alice.entityId, h1, h2, bob.entityId]);
      expect(best.senderAmount).toBe(senderText);
      expect(best.recipientAmount).toBe(recipientText);
      expect(best.totalFee).toBe(feeText);
      expect(best.fees.reduce((sum, fee) => sum + BigInt(fee), 0n)).toBe(BigInt(feeText));
      expect(BigInt(recipientText)).toBe(PAYMENT);
      expect(BigInt(senderText)).toBe(PAYMENT + BigInt(feeText));
      expect(BigInt(feeText)).toBeGreaterThan(0n);
      await expect(a.getByTestId('pay-submit')).toHaveText(
        new RegExp(`^Pay ${(Number(senderText) / 1e6).toFixed(2)} USDC$`),
      );

      const [fromA, fromB] = await Promise.all([readWalletCheckpoint(a), readWalletCheckpoint(b)]);
      await a.getByTestId('pay-submit').click();
      await expect(a.getByTestId('receipt-kicker')).toHaveText('Paid', { timeout: 20_000 });
      await expect(a.getByTestId('receipt-amount')).toContainText('25.00');
      const committed = await readCommittedPayment(a, alice.entityId, fromA.frame.height + 1);
      expect(committed.amount).toBe(recipientText);
      expect(BigInt(committed.senderAmount)).toBe(BigInt(committed.amount) + BigInt(committed.fee));
      // The quote authorizes a maximum debit; admission may only lower it.
      expect(BigInt(committed.senderAmount)).toBeLessThanOrEqual(BigInt(senderText));
      expect(BigInt(committed.fee)).toBeLessThanOrEqual(BigInt(feeText));
      const aliceAfter = (100_000_000n - BigInt(committed.senderAmount)).toString();
      await expect
        .poll(() => readUsdc(a, alice.entityId, h1), { timeout: 20_000 })
        .toMatchObject({ owned: aliceAfter, pending: false, mempool: 0 });
      await expect
        .poll(() => readUsdc(b, bob.entityId, h2), { timeout: 20_000 })
        .toMatchObject({
          owned: PAYMENT.toString(),
          inCapacity: (BOB_CREDIT - PAYMENT).toString(),
          pending: false,
          mempool: 0,
        });
      expect(await readUsdc(b, bob.entityId, h1)).toMatchObject({ owned: '0', inCapacity: '0' });
      expect(await readReceived(b, bob.entityId, fromB.frame.height + 1, committed.hashlock)).toEqual([
        { amount: PAYMENT.toString(), entityId: bob.entityId },
      ]);
      await a.getByTestId('receipt-done').click();
      console.log(
        'MULTIHOP_PAID',
        Date.now() - started,
        safeStringify({ quote: { senderText, recipientText, feeText }, committed, aliceAfter }),
      );

      // 80 USDC exceeds what Alice can still send through H1: the pathfinder
      // finds no route and Pay never becomes a submission.
      await a.getByTestId('home-pay').click();
      await a.getByTestId('pay-to').fill(bob.entityId);
      await a.getByTestId('pay-amount').fill('80');
      const spendable = BigInt((await readUsdc(a, alice.entityId, h1)).outCapacity);
      expect(spendable).toBe(BigInt(aliceAfter));
      const cents = spendable / 10_000n;
      const limit = `Up to ${cents / 100n}.${(cents % 100n).toString().padStart(2, '0')} instantly`;
      await expect(a.getByText(limit, { exact: true })).toBeVisible();
      const noRoute = `no payment route from ${alice.entityId} to ${bob.entityId}`;
      await expect(a.getByText(noRoute, { exact: true })).toHaveCount(2, { timeout: 20_000 });
      const topUp = a.getByTestId('pay-topup');
      await expect(topUp).toContainText('Top up for this payment');
      await expect(topUp.getByTestId('pay-topup-move')).toBeDisabled();
      await expect(a.getByTestId('pay-quote')).toHaveCount(0);
      await expect(a.getByTestId('pay-submit')).toBeDisabled();
      await expect(a.getByTestId('pay-submit')).toHaveText('Pay');
      await a.getByTestId('pay-submit').click({ force: true });
      await expect(a.getByTestId('payment-receipt')).toHaveCount(0);
      expect(await readUsdc(a, alice.entityId, h1)).toMatchObject({ owned: aliceAfter, pending: false, mempool: 0 });
      expect(await readCommittedPayment(a, alice.entityId, fromA.frame.height + 1)).toEqual(committed);
      expect(errors).toEqual([]);
      console.log('MULTIHOP_MS', Date.now() - started);
    } finally {
      await Promise.all([aliceContext.close(), bobContext.close()]);
    }
  },
);
