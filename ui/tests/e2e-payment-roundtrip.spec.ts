/**
 * Two fresh wallets pay each other back and forth through the stack hub: the
 * React counterpart of the SvelteKit tests/e2e/payments/e2e-ahb-payment.spec.ts.
 *
 * Alice gets 100 USDC from the faucet; Bob accepts 100 USDC of incoming credit
 * on Receive. Alice pays Bob 20, Bob pays 5 back, Alice pays Bob 5 more. After
 * every hop both committed positions are exact: the recipient gains exactly the
 * amount, the sender loses exactly amount + committed fee (never above the fee
 * quoted on screen), and Alice + Bob always equals 100 USDC minus those fees.
 * Finally an amount above Alice's sending capacity is refused before submit.
 */
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import type { RuntimeAdapterViewFrame, XLNModule } from '../../core/api/public/runtime-module';
import type { RuntimeAdapter, RuntimeAdapterPaymentRoutesResponse } from '../../core/api/runtime-adapter/types';
import { safeStringify } from '../../core/protocol/serialization';
import { enterStack, readWalletCheckpoint, type StackWallet } from './stack';
import { readCommittedPayment } from './payment-evidence';

const USDC = 1;
const UNIT = 1_000_000n;
const CONSENSUS_TIMEOUT = 15_000;

type Party = Readonly<{ name: string; context: BrowserContext; page: Page; wallet: StackWallet; errors: string[] }>;
type Payment = Awaited<ReturnType<typeof readCommittedPayment>>;

/** Exact USDC position and largest single-account sending capacity, from committed state via deriveDelta. */
async function usdcState(page: Page, entityId: string) {
  return page.evaluate(
    async ({ owner, tokenId }) => {
      const debug = (window as Window & { __xln?: { adapter(): RuntimeAdapter | null; xln(): Promise<XLNModule> } })
        .__xln;
      const adapter = debug?.adapter();
      if (!debug || !adapter) throw new Error('Wallet adapter unavailable');
      const view = await adapter.read<RuntimeAdapterViewFrame>('view-frame', { entityId: owner, accountsLimit: 100 });
      const accounts = view.activeEntity?.accounts;
      if (!accounts || view.activeEntityId !== owner) throw new Error('Wallet Accounts unavailable');
      if (accounts.nextCursor !== null) throw new Error('Round-trip fixture exceeds one Account page');
      const xln = await debug.xln();
      let owned = 0n;
      let outCapacity = 0n;
      let inCapacity = 0n;
      for (const account of accounts.items) {
        const delta = account.state.deltas.get(tokenId);
        if (!delta) continue;
        const derived = xln.deriveDelta(delta, account.state.leftEntity === owner);
        owned += derived.outCollateral + derived.outPeerCredit - derived.inOwnCredit;
        if (derived.outCapacity > outCapacity) outCapacity = derived.outCapacity;
        if (derived.inCapacity > inCapacity) inCapacity = derived.inCapacity;
      }
      return {
        owned: owned.toString(),
        outCapacity: outCapacity.toString(),
        inCapacity: inCapacity.toString(),
        pending: accounts.items.some(account => Boolean(account.pendingFrame)),
        mempool: accounts.items.reduce((sum, account) => sum + account.mempoolCount, 0),
      };
    },
    { owner: entityId, tokenId: USDC },
  );
}

/** Home prints whole cents as "20.00" and any sub-cent position in full ("19.999995"); never rounded. */
function homeUsdc(units: bigint): string {
  const whole = (units / UNIT).toLocaleString('en-US');
  const fraction = (units % UNIT).toString().padStart(6, '0');
  return units % (UNIT / 100n) === 0n ? `${whole}.${fraction.slice(0, 2)}` : `${whole}.${fraction.replace(/0+$/, '')}`;
}

/** The canonical quote through Alice's only Account, which the top-up card prices against. */
async function fundedQuote(page: Page, source: string, target: string, amount: bigint) {
  return page.evaluate(
    async ({ owner, to, units, tokenId }) => {
      const adapter = (window as Window & { __xln?: { adapter(): RuntimeAdapter | null } }).__xln?.adapter();
      if (!adapter) throw new Error('Wallet adapter unavailable');
      const view = await adapter.read<RuntimeAdapterViewFrame>('view-frame', { entityId: owner, accountsLimit: 100 });
      const accounts = view.activeEntity?.accounts.items ?? [];
      if (accounts.length !== 1) throw new Error(`Expected one hub Account, found ${accounts.length}`);
      const state = accounts[0]!.state;
      const hub = state.leftEntity === owner ? state.rightEntity : state.leftEntity;
      const quote = await adapter.read<RuntimeAdapterPaymentRoutesResponse>('payment-routes', {
        sourceEntityId: owner,
        targetEntityId: to,
        tokenId,
        amount: units,
        fundingAccountId: hub,
      });
      const route = quote.routes[0];
      if (quote.routes.length !== 1 || !route)
        throw new Error(`Expected one funded route, found ${quote.routes.length}`);
      return { senderAmount: String(route.senderAmount), path: route.path.map(id => id.toLowerCase()) };
    },
    { owner: source, to: target, units: amount.toString(), tokenId: USDC },
  );
}

async function settled(party: Party, owned: bigint): Promise<void> {
  await expect
    .poll(
      async () => {
        const state = await usdcState(party.page, party.wallet.entityId);
        return { owned: state.owned, pending: state.pending, mempool: state.mempool };
      },
      { timeout: CONSENSUS_TIMEOUT, message: `${party.name} settles on ${owned} USDC units` },
    )
    .toEqual({ owned: owned.toString(), pending: false, mempool: 0 });
}

async function openParty(browser: Browser, baseURL: string, name: string): Promise<Party> {
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const wallet = await enterStack(page);
  return { name, context, page, wallet, errors };
}

async function goHome(page: Page): Promise<void> {
  await page.getByTestId('nav-home').locator('visible=true').first().click();
  await expect(page.getByTestId('home-total')).toBeVisible();
}

/** Pay through the UI and return the committed initiation after both receipts are shown. */
async function pay(from: Party, to: Party, amount: string): Promise<Payment> {
  const units = BigInt(amount) * UNIT;
  const page = from.page;
  await goHome(page);
  await page.getByTestId('home-pay').click();
  await page.getByTestId('pay-to').fill(to.wallet.entityId);
  await page.getByTestId('pay-amount').fill(amount);
  const submit = page.getByTestId('pay-submit');
  await expect(submit).toBeEnabled({ timeout: CONSENSUS_TIMEOUT });
  const quote = page.getByTestId('pay-quote');
  const quotedSender = BigInt((await quote.getAttribute('data-sender-amount')) ?? '');
  const quotedRecipient = BigInt((await quote.getAttribute('data-recipient-amount')) ?? '');
  const quotedFee = BigInt((await quote.getAttribute('data-fee-amount')) ?? '');
  expect(quotedRecipient).toBe(units);
  expect(quotedSender).toBe(units + quotedFee);
  const fromHeight = (await readWalletCheckpoint(page)).frame.height + 1;

  await submit.click();
  const paid = page.getByTestId('payment-receipt');
  await expect(paid.getByTestId('receipt-kicker')).toHaveText('Paid', { timeout: CONSENSUS_TIMEOUT });
  await expect(paid.getByTestId('receipt-amount')).toHaveText(`${amount}.00 USDC`);
  const received = to.page.getByTestId('payment-receipt');
  await expect(received.getByTestId('receipt-kicker')).toHaveText('Received', { timeout: CONSENSUS_TIMEOUT });
  await expect(received.getByTestId('receipt-amount')).toHaveText(`${amount}.00 USDC`);
  const payment = await readCommittedPayment(page, from.wallet.entityId, fromHeight);
  expect(payment.amount).toBe(units.toString());
  expect(BigInt(payment.senderAmount)).toBe(units + BigInt(payment.fee));
  // The displayed quote is the authorized ceiling; admission may charge less, never more.
  expect(BigInt(payment.fee)).toBeLessThanOrEqual(quotedFee);
  await paid.getByTestId('receipt-done').click();
  await received.getByTestId('receipt-done').click();
  return payment;
}

test(
  'two wallets pay 20 there, 5 back and 5 again with exact balances; overspend is refused',
  { tag: '@functional' },
  async ({ browser, baseURL }) => {
    test.setTimeout(120_000);
    if (!baseURL) throw new Error('Wallet test URL missing');
    const started = Date.now();
    const [alice, bob] = await Promise.all([openParty(browser, baseURL, 'Alice'), openParty(browser, baseURL, 'Bob')]);
    try {
      expect(alice.wallet.runtimeId).not.toBe(bob.wallet.runtimeId);
      const prepareBob = async (): Promise<void> => {
        const page = bob.page;
        await page.getByTestId('home-receive').click();
        // Ample incoming credit, so only Alice's own capacity can limit the overspend below.
        await page.getByTestId('receive-amount').fill('100');
        const spectrum = page.getByTestId('receive-spectrum');
        await expect(spectrum).toBeVisible();
        await spectrum.getByRole('button', { name: '0% collateral', exact: true }).click();
        await page.getByTestId('receive-spectrum-confirm').click();
        await expect(spectrum).toHaveCount(0, { timeout: CONSENSUS_TIMEOUT });
        await settled(bob, 0n);
      };
      const fundAlice = async (): Promise<void> => {
        await alice.page.getByTestId('home-faucet').click();
        await expect(alice.page.getByTestId('test-money-status')).toHaveText('100 USDC received', {
          timeout: CONSENSUS_TIMEOUT,
        });
        await settled(alice, 100n * UNIT);
      };
      await Promise.all([prepareBob(), fundAlice()]);
      console.log('ROUNDTRIP_READY_MS', Date.now() - started);

      let aliceOwned = 100n * UNIT;
      let bobOwned = 0n;
      let fees = 0n;
      const ledger: { hop: string; payment: Payment; alice: string; bob: string }[] = [];
      const hop = async (from: Party, to: Party, amount: string): Promise<void> => {
        const payment = await pay(from, to, amount);
        if (from === alice) aliceOwned -= BigInt(payment.senderAmount);
        else bobOwned -= BigInt(payment.senderAmount);
        if (to === alice) aliceOwned += BigInt(payment.amount);
        else bobOwned += BigInt(payment.amount);
        fees += BigInt(payment.fee);
        await Promise.all([settled(alice, aliceOwned), settled(bob, bobOwned)]);
        expect(aliceOwned + bobOwned).toBe(100n * UNIT - fees);
        ledger.push({ hop: `${from.name}->${to.name} ${amount}`, payment, alice: `${aliceOwned}`, bob: `${bobOwned}` });
        console.log('ROUNDTRIP_HOP', Date.now() - started, safeStringify(ledger.at(-1)));
      };

      await hop(alice, bob, '20');
      expect(bobOwned).toBe(20n * UNIT);
      await hop(bob, alice, '5');
      expect(bobOwned).toBe(20n * UNIT - 5n * UNIT - BigInt(ledger[1]!.payment.fee));
      await hop(alice, bob, '5');
      await Promise.all([goHome(alice.page), goHome(bob.page)]);
      await expect(alice.page.getByTestId('token-net-USDC')).toHaveText(homeUsdc(aliceOwned));
      await expect(bob.page.getByTestId('token-net-USDC')).toHaveText(homeUsdc(bobOwned));

      // Overspend: the "Up to … instantly" shortcut fills Alice's exact capacity;
      // one more USDC must be refused before anything is submitted.
      const before = await usdcState(alice.page, alice.wallet.entityId);
      const paymentsFrom = (await readWalletCheckpoint(alice.page)).frame.height + 1;
      await goHome(alice.page);
      await alice.page.getByTestId('home-pay').click();
      await alice.page.getByTestId('pay-to').fill(bob.wallet.entityId);
      await alice.page.getByRole('button', { name: /^Up to [\d,.]+ instantly$/ }).click();
      const maxText = await alice.page.getByTestId('pay-amount').inputValue();
      const [whole = '0', fraction = ''] = maxText.split('.');
      expect(BigInt(whole) * UNIT + BigInt(fraction.padEnd(6, '0'))).toBe(BigInt(before.outCapacity));
      const over = BigInt(before.outCapacity) + UNIT;
      // Bob can still receive more than the attempt: only Alice's sending side is short.
      expect(BigInt((await usdcState(bob.page, bob.wallet.entityId)).inCapacity)).toBeGreaterThan(over + UNIT);
      const overText = `${over / UNIT}.${(over % UNIT).toString().padStart(6, '0')}`.replace(/\.?0+$/, '');
      await alice.page.getByTestId('pay-amount').fill(overText);
      // Canonical refusal: no route is quoted, the exact route error is shown,
      // Pay stays disabled and the top-up card prices the exact shortfall.
      await expect(
        alice.page.getByText(`no payment route from ${alice.wallet.entityId} to ${bob.wallet.entityId}`, {
          exact: true,
        }),
      ).toBeVisible({ timeout: CONSENSUS_TIMEOUT });
      await expect(alice.page.getByTestId('pay-quote')).toHaveCount(0);
      await expect(alice.page.getByTestId('pay-submit')).toBeDisabled();
      await expect(alice.page.getByTestId('pay-submit')).toHaveText('Pay');
      const funded = await fundedQuote(alice.page, alice.wallet.entityId, bob.wallet.entityId, over);
      expect(funded.path.at(0)).toBe(alice.wallet.entityId);
      expect(funded.path.at(-1)).toBe(bob.wallet.entityId);
      const shortfall = BigInt(funded.senderAmount) - BigInt(before.outCapacity);
      expect(shortfall).toBeGreaterThan(UNIT);
      const topup = alice.page.getByTestId('pay-topup');
      await expect(topup).toContainText(
        `Move ${shortfall / UNIT}.${(shortfall % UNIT).toString().padStart(6, '0')} USDC from your on-chain wallet into`,
        { timeout: CONSENSUS_TIMEOUT },
      );
      await alice.page.screenshot({ path: test.info().outputPath('overspend.png'), fullPage: true });
      expect(await usdcState(alice.page, alice.wallet.entityId)).toEqual(before);
      await expect(alice.page.getByTestId('payment-receipt')).toHaveCount(0);
      await expect(readCommittedPayment(alice.page, alice.wallet.entityId, paymentsFrom)).rejects.toThrow(
        'Expected one started/finalized payment: 0/0',
      );
      await settled(bob, bobOwned);
      expect([...alice.errors, ...bob.errors]).toEqual([]);
      console.log('ROUNDTRIP_DONE_MS', Date.now() - started);
    } finally {
      await alice.context.close();
      await bob.context.close();
    }
  },
);
