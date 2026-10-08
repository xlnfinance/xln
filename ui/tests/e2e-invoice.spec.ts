/**
 * Request and pay by link: the counterpart of the SvelteKit
 * tests/e2e/payments/e2e-invoice-qr.spec.ts and e2e-pay-deeplink.spec.ts.
 *
 * Bob (fresh wallet) asks for 7 USDC with a note on Receive, prepares the
 * incoming capacity and copies the canonical wallet link. Alice (fresh wallet,
 * funded by the hub faucet) opens that link: Pay opens with Bob, the amount and
 * the note filled in, and her payment moves exactly 7 USDC to Bob. The second
 * test opens the same kind of link while Alice's vault is locked; the request
 * survives the unlock.
 *
 * The copied link targets the production wallet origin. Locally the test keeps
 * its path and `#pay/...` payload and only swaps the origin for the dev stack.
 */
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import type { RuntimeAdapterViewFrame, XLNModule } from '../../core/api/public/runtime-module';
import type { RuntimeAdapter } from '../../core/api/runtime-adapter/types';
import { enterStack, LOCAL_PASSWORD, readWalletCheckpoint, type StackWallet } from './stack';
import { readCommittedPayment } from './payment-evidence';

const USDC = 1;
const FAUCET_UNITS = 100_000_000n;
const INVOICE_AMOUNT = '7';
const INVOICE_UNITS = 7_000_000n;
const MEMO = 'Lunch invoice 7';
const CONSENSUS_TIMEOUT = 15_000;
const CANONICAL_WALLET_ORIGIN = 'https://xln.finance';

type Party = Readonly<{ context: BrowserContext; page: Page; wallet: StackWallet; errors: string[] }>;

/** Exact USDC the entity owns across its Accounts, from committed state via canonical deriveDelta. */
async function usdcPosition(page: Page, entityId: string) {
  return page.evaluate(
    async ({ owner, tokenId }) => {
      const debug = (window as Window & { __xln?: { adapter(): RuntimeAdapter | null; xln(): Promise<XLNModule> } })
        .__xln;
      const adapter = debug?.adapter();
      if (!debug || !adapter) throw new Error('Wallet adapter unavailable');
      const view = await adapter.read<RuntimeAdapterViewFrame>('view-frame', { entityId: owner, accountsLimit: 100 });
      const accounts = view.activeEntity?.accounts;
      if (!accounts || view.activeEntityId !== owner) throw new Error('Wallet Accounts unavailable');
      if (accounts.nextCursor !== null) throw new Error('Invoice fixture exceeds one Account page');
      const xln = await debug.xln();
      let owned = 0n;
      for (const account of accounts.items) {
        const delta = account.state.deltas.get(tokenId);
        if (!delta) continue;
        const derived = xln.deriveDelta(delta, account.state.leftEntity === owner);
        owned += derived.outCollateral + derived.outPeerCredit - derived.inOwnCredit;
      }
      return {
        owned: owned.toString(),
        pending: accounts.items.some(account => Boolean(account.pendingFrame)),
        mempool: accounts.items.reduce((sum, account) => sum + account.mempoolCount, 0),
      };
    },
    { owner: entityId, tokenId: USDC },
  );
}

async function settled(page: Page, entityId: string, owned: bigint): Promise<void> {
  await expect
    .poll(() => usdcPosition(page, entityId), { timeout: CONSENSUS_TIMEOUT })
    .toEqual({ owned: owned.toString(), pending: false, mempool: 0 });
}

/** Two fresh sovereign wallets on the running stack; Bob may read back what he copies. */
async function openPair(browser: Browser, baseURL: string): Promise<{ alice: Party; bob: Party }> {
  const open = async (permissions: string[]): Promise<Party> => {
    const context = await browser.newContext({ baseURL, permissions });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    const wallet = await enterStack(page);
    return { context, page, wallet, errors };
  };
  const [alice, bob] = await Promise.all([open([]), open(['clipboard-read', 'clipboard-write'])]);
  expect(alice.wallet.runtimeId).not.toBe(bob.wallet.runtimeId);
  return { alice, bob };
}

async function fundWithFaucet(party: Party): Promise<void> {
  await party.page.getByTestId('home-faucet').click();
  await expect(party.page.getByTestId('test-money-status')).toHaveText('100 USDC received', {
    timeout: CONSENSUS_TIMEOUT,
  });
  await settled(party.page, party.wallet.entityId, FAUCET_UNITS);
}

/** Bob requests 7 USDC with a note, accepts the missing capacity as credit and copies the wallet link. */
async function requestByLink(bob: Party): Promise<string> {
  const page = bob.page;
  await page.getByTestId('home-receive').click();
  await page.getByTestId('receive-amount').fill(INVOICE_AMOUNT);
  const spectrum = page.getByTestId('receive-spectrum');
  await expect(spectrum).toBeVisible();
  await spectrum.getByRole('button', { name: '0% collateral', exact: true }).click();
  await expect(page.getByTestId('receive-spectrum-confirm')).toHaveText('Extend credit limit');
  await page.getByTestId('receive-spectrum-confirm').click();
  await expect(spectrum).toHaveCount(0, { timeout: CONSENSUS_TIMEOUT });
  await settled(page, bob.wallet.entityId, 0n);
  await page.getByTestId('receive-note').fill(MEMO);
  await page.getByTestId('receive-copy-link').click();
  await expect(page.getByText('Payment link copied', { exact: true })).toBeVisible();
  const link = await page.evaluate(() => navigator.clipboard.readText());
  const invoice = `${bob.wallet.entityId}?${new URLSearchParams({ token: String(USDC), amount: INVOICE_AMOUNT, desc: MEMO })}`;
  expect(link).toBe(`${CANONICAL_WALLET_ORIGIN}/app#pay/${encodeURIComponent(invoice)}`);
  return link;
}

/** Same path and `#pay/...` payload as the canonical link, on the local wallet origin. */
function onLocalWallet(link: string, page: Page, keepPath: boolean): string {
  const canonical = new URL(link);
  expect(canonical.origin).toBe(CANONICAL_WALLET_ORIGIN);
  expect(canonical.hash.startsWith('#pay/')).toBe(true);
  const local = new URL(page.url());
  return `${local.origin}${keepPath ? canonical.pathname : local.pathname}${canonical.hash}`;
}

async function expectPrefilledPay(alice: Party, bob: Party): Promise<void> {
  const page = alice.page;
  await expect(page).toHaveURL(/\/pay$/, { timeout: CONSENSUS_TIMEOUT });
  await expect(page.getByTestId('pay-to')).toHaveValue(bob.wallet.entityId);
  await expect(page.getByTestId('pay-amount')).toHaveValue(INVOICE_AMOUNT);
  await expect(page.getByTestId('pay-note')).toHaveValue(MEMO);
}

/** Alice pays the prefilled request; both sides settle on the exact committed amounts. */
async function payPrefilled(alice: Party, bob: Party): Promise<void> {
  const a = alice.page;
  const submit = a.getByTestId('pay-submit');
  await expect(submit).toBeEnabled({ timeout: CONSENSUS_TIMEOUT });
  await expect(submit).toHaveText(/^Pay 7\.\d{2} USDC$/);
  const quote = a.getByTestId('pay-quote');
  const quotedSender = BigInt((await quote.getAttribute('data-sender-amount')) ?? '');
  const quotedRecipient = BigInt((await quote.getAttribute('data-recipient-amount')) ?? '');
  const quotedFee = BigInt((await quote.getAttribute('data-fee-amount')) ?? '');
  expect(quotedRecipient).toBe(INVOICE_UNITS);
  expect(quotedSender).toBe(INVOICE_UNITS + quotedFee);
  const fromHeight = (await readWalletCheckpoint(a)).frame.height + 1;

  await submit.click();
  const receipt = a.getByTestId('payment-receipt');
  await expect(receipt.getByTestId('receipt-kicker')).toHaveText('Paid', { timeout: CONSENSUS_TIMEOUT });
  await expect(receipt.getByTestId('receipt-amount')).toHaveText('7.00 USDC');
  await expect(receipt.getByTestId('receipt-title')).toContainText(MEMO);
  const payment = await readCommittedPayment(a, alice.wallet.entityId, fromHeight);
  expect(payment.amount).toBe(INVOICE_UNITS.toString());
  expect(BigInt(payment.senderAmount)).toBe(INVOICE_UNITS + BigInt(payment.fee));
  // The quote authorizes a ceiling; admission may recompute a smaller exact debit.
  expect(BigInt(payment.senderAmount)).toBeLessThanOrEqual(quotedSender);
  await settled(a, alice.wallet.entityId, FAUCET_UNITS - BigInt(payment.senderAmount));

  const b = bob.page;
  const received = b.getByTestId('payment-receipt');
  await expect(received.getByTestId('receipt-kicker')).toHaveText('Received', { timeout: CONSENSUS_TIMEOUT });
  await expect(received.getByTestId('receipt-amount')).toHaveText('7.00 USDC');
  await settled(b, bob.wallet.entityId, INVOICE_UNITS);
  await received.getByTestId('receipt-done').click();
  await b.getByTestId('nav-home').locator('visible=true').first().click();
  await expect(b.getByTestId('token-net-USDC')).toHaveText('7.00');
}

test.describe('request and pay by link', () => {
  test(
    'an unlocked payer opens the request link and pays exactly 7 USDC with the note',
    { tag: '@functional' },
    async ({ browser, baseURL }) => {
      test.setTimeout(120_000);
      if (!baseURL) throw new Error('Wallet test URL missing');
      const started = Date.now();
      const { alice, bob } = await openPair(browser, baseURL);
      try {
        const [link] = await Promise.all([requestByLink(bob), fundWithFaucet(alice)]);
        console.log('INVOICE_READY_MS', Date.now() - started);
        await expect(alice.page).toHaveURL(/\/$/);
        // A same-document hash navigation: the unlocked runtime keeps running.
        await alice.page.goto(onLocalWallet(link, alice.page, false));
        await expectPrefilledPay(alice, bob);
        await payPrefilled(alice, bob);
        expect([...alice.errors, ...bob.errors]).toEqual([]);
        console.log('INVOICE_PAID_MS', Date.now() - started);
      } finally {
        await alice.context.close();
        await bob.context.close();
      }
    },
  );

  test(
    'a locked payer unlocks into the prefilled request and pays it',
    { tag: '@functional' },
    async ({ browser, baseURL }) => {
      test.setTimeout(120_000);
      if (!baseURL) throw new Error('Wallet test URL missing');
      const started = Date.now();
      const { alice, bob } = await openPair(browser, baseURL);
      try {
        const [link] = await Promise.all([requestByLink(bob), fundWithFaucet(alice)]);
        const a = alice.page;
        await a.reload();
        const resume = a.getByRole('button', { name: 'Continue', exact: true });
        await expect(resume).toBeVisible();
        // A fresh document load at the link's own path, exactly like following it.
        await a.goto(onLocalWallet(link, a, true));
        await expect(a.getByTestId('pay-amount')).toHaveCount(0);
        await resume.click();
        await a.getByLabel('Password', { exact: true }).fill(LOCAL_PASSWORD);
        await a.getByRole('button', { name: 'Unlock', exact: true }).click();
        await expectPrefilledPay(alice, bob);
        console.log('INVOICE_UNLOCKED_MS', Date.now() - started);
        await settled(a, alice.wallet.entityId, FAUCET_UNITS);
        await payPrefilled(alice, bob);
        expect([...alice.errors, ...bob.errors]).toEqual([]);
        console.log('INVOICE_LOCKED_PAID_MS', Date.now() - started);
      } finally {
        await alice.context.close();
        await bob.context.close();
      }
    },
  );
});
