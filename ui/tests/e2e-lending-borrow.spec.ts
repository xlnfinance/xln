/**
 * Borrowing is inside this release's admission profile, so the Lending screen
 * runs the whole loan through real UI controls: fund a hub pool, borrow from
 * it, see the loan with its exact repayment, repay, and close the pool so no
 * open position is left on the shared hub.
 */
import { expect, test, type Page } from '@playwright/test';
import { isAccountTxKindAvailable } from '../../core/account/tx/admission-policy';
import type { RuntimeAdapterViewFrame, XLNModule } from '../../core/api/public/runtime-module';
import type { RuntimeAdapter } from '../../core/api/runtime-adapter/types';
import { safeStringify } from '../../core/protocol/serialization';
import { enterStack } from './stack';

type DebugWindow = Window & { __xln?: { adapter: () => RuntimeAdapter | null; xln: () => Promise<XLNModule> } };
type Parties = { ownerId: string; hubId: string };
const USDC = 1;
// A 1 hour term keeps this pool apart from the 1 day pools other wallet specs open.
const LEND = { amount: 50_000_000n, text: '50', bps: '100' };
const BORROW = { amount: 25_000_000n, text: '25', interest: 250_000n, repayment: 25_250_000n };

/** Committed USDC money on the hub Account; every mutation below goes through the UI. */
const readAccount = (page: Page, parties: Parties) =>
  page.evaluate(async ids => {
    const debug = (window as DebugWindow).__xln;
    const adapter = debug?.adapter();
    if (!debug || !adapter) throw new Error('Lending Account diagnostics unavailable');
    const account = await adapter.read<
      NonNullable<RuntimeAdapterViewFrame['activeEntity']>['accounts']['items'][number]
    >(`entity/${ids.ownerId}/account/${ids.hubId}`);
    const delta = account.state.deltas.get(1);
    if (!delta) throw new Error('Lending USDC lane unavailable');
    const xln = await debug.xln();
    const derived = xln.deriveDelta(delta, xln.isLeftEntity(ids.ownerId, ids.hubId));
    return {
      height: account.currentHeight,
      owned: (derived.outCollateral + derived.outPeerCredit - derived.inOwnCredit).toString(),
      hubCredit: derived.ownCreditLimit.toString(),
      sendCapacity: derived.outCapacity.toString(),
      pending: Boolean(account.pendingFrame),
      mempool: account.mempoolCount,
    };
  }, parties);

const text = (value: unknown, field: string): string => {
  if (typeof value !== 'string') throw new Error(`LENDING_STATE_FIELD_INVALID:${field}`);
  return value;
};

async function readLending(page: Page, ids: Parties) {
  const response = await page.request.get('/api/lending/state', {
    params: { hubEntityId: ids.hubId, userEntityId: ids.ownerId, tokenId: String(USDC) },
  });
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as { success?: unknown; pools?: unknown; loans?: unknown };
  if (body.success !== true || !Array.isArray(body.pools) || !Array.isArray(body.loans))
    throw new Error(`Invalid lending state: ${safeStringify(body)}`);
  const pools = (body.pools as Record<string, unknown>[]).map(pool => ({
    positionId: text(pool['positionId'], 'positionId'),
    lender: text(pool['lenderEntityId'], 'lenderEntityId'),
    status: text(pool['status'], 'status'),
    principal: text(pool['principalAmount'], 'principalAmount'),
    available: text(pool['availableAmount'], 'availableAmount'),
    borrowed: text(pool['borrowedAmount'], 'borrowedAmount'),
  }));
  const loans = (body.loans as Record<string, unknown>[])
    .filter(loan => loan['borrowerEntityId'] === ids.ownerId)
    .map(loan => ({
      loanId: text(loan['loanId'], 'loanId'),
      positionId: text(loan['positionId'], 'positionId'),
      lender: text(loan['lenderEntityId'], 'lenderEntityId'),
      status: text(loan['status'], 'status'),
      principal: text(loan['principalAmount'], 'principalAmount'),
      interest: text(loan['interestAmount'], 'interestAmount'),
      repayment: text(loan['repaymentAmount'], 'repaymentAmount'),
      repaid: text(loan['repaidAmount'], 'repaidAmount'),
      interestBps: loan['interestBps'],
      termId: loan['termId'],
    }));
  return { pools, loans };
}

const settledOwned = async (page: Page, ids: Parties) => {
  const account = await readAccount(page, ids);
  return { owned: account.owned, pending: account.pending, mempool: account.mempool };
};

async function chooseTerm(page: Page): Promise<void> {
  const term = page.locator('button.mode-card', { hasText: '1 hour' });
  await term.click();
  await expect(term).toHaveClass(/active/);
}

test(
  'borrow from a hub pool, see the exact repayment, repay and close the pool',
  { tag: '@functional' },
  async ({ page }) => {
    test.setTimeout(60_000);
    expect(isAccountTxKindAvailable('lending_borrow_request')).toBe(true);
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    const wallet = await enterStack(page);
    const funding = page.waitForResponse(
      response => new URL(response.url()).pathname === '/api/faucet/offchain' && response.request().method() === 'POST',
    );
    await page.getByTestId('home-faucet').click();
    const funded = await funding;
    expect(funded.ok(), await funded.text()).toBe(true);
    await expect(page.getByTestId('test-money-status')).toHaveText('100 USDC received');
    await page.getByTestId('account-row').first().click();
    const hubId = new URL(page.url()).pathname.split('/accounts/')[1];
    if (!hubId || !/^0x[0-9a-f]{64}$/.test(hubId)) throw new Error('Borrower hub Account unavailable');
    const ids = { ownerId: wallet.entityId, hubId };
    await expect
      .poll(() => settledOwned(page, ids), { timeout: 15_000 })
      .toEqual({ owned: '100000000', pending: false, mempool: 0 });
    const start = await readAccount(page, ids);
    expect(await readLending(page, ids)).toEqual({ pools: [], loans: [] });

    await page.getByTestId('nav-manage').locator('visible=true').first().click();
    await expect(page.getByTestId('manage-lend')).toContainText('Lend to a hub pool or borrow');
    await page.getByTestId('manage-lend').click();
    await expect(page.getByTestId('lending-unavailable')).toHaveCount(0);
    await expect(page.getByTestId('lending-state')).toBeVisible();

    // Fund the pool this wallet will borrow from.
    await page.getByTestId('lend-side-lend').click();
    await page.getByTestId('lend-amount').fill(LEND.text);
    await chooseTerm(page);
    await page.getByTestId('lend-rate').fill(LEND.bps);
    await page.getByTestId('lend-submit').click();
    await expect
      .poll(async () => (await readLending(page, ids)).pools.map(pool => pool.status), { timeout: 15_000 })
      .toEqual(['open']);
    const [pool] = (await readLending(page, ids)).pools;
    if (!pool) throw new Error('Funded lending pool missing');
    expect(pool).toMatchObject({
      lender: wallet.entityId,
      principal: '50000000',
      available: '50000000',
      borrowed: '0',
    });
    await expect
      .poll(() => settledOwned(page, ids), { timeout: 15_000 })
      .toEqual({ owned: '50000000', pending: false, mempool: 0 });
    const lent = await readAccount(page, ids);
    expect(lent.hubCredit).toBe(start.hubCredit);
    const offers = page.locator('.card', { has: page.getByRole('heading', { name: 'Your offers' }) });
    await expect(offers.locator('.row .t')).toHaveText('50.00 USDC');
    await expect(offers.locator('.row .s')).toHaveText('1h · 1.00% · open · 50.00 free');

    // Borrow: the hub matches the request against the pool and grants credit.
    await page.getByTestId('lend-side-borrow').click();
    await expect(
      page.getByText('Approval grants account credit for spending; it does not deposit principal.', { exact: false }),
    ).toBeVisible();
    await page.getByTestId('lend-amount').fill(BORROW.text);
    await chooseTerm(page);
    await page.getByTestId('lend-rate').fill(LEND.bps);
    await page.getByTestId('lend-submit').click();
    await expect
      .poll(async () => (await readLending(page, ids)).loans.map(loan => loan.status), { timeout: 15_000 })
      .toEqual(['active']);
    const borrowed = await readLending(page, ids);
    const loan = borrowed.loans[0]!;
    expect(loan).toMatchObject({
      positionId: pool.positionId,
      lender: wallet.entityId,
      principal: BORROW.amount.toString(),
      interest: BORROW.interest.toString(),
      repayment: BORROW.repayment.toString(),
      repaid: '0',
      interestBps: 100,
      termId: '1h',
    });
    expect(borrowed.pools).toEqual([
      { ...pool, available: (LEND.amount - BORROW.amount).toString(), borrowed: BORROW.amount.toString() },
    ]);
    await expect
      .poll(async () => (await readAccount(page, ids)).hubCredit, { timeout: 15_000 })
      .toBe((BigInt(start.hubCredit) + BORROW.amount).toString());
    await expect
      .poll(() => settledOwned(page, ids), { timeout: 15_000 })
      .toEqual({ owned: '50000000', pending: false, mempool: 0 });
    const granted = await readAccount(page, ids);
    // Approval adds spendable credit; it moves no principal into the Account.
    expect(BigInt(granted.sendCapacity) - BigInt(lent.sendCapacity)).toBe(BORROW.amount);

    const loans = page.locator('.card', { has: page.getByRole('heading', { name: 'Your loans' }) });
    const loanRow = loans.locator('.row');
    await expect(loanRow).toHaveCount(1);
    await expect(loanRow.locator('.t')).toHaveText('25.00 USDC');
    await expect(loanRow.locator('.s')).toContainText('1h · 1.00% · active · due ');
    await expect(loanRow.locator('.s')).toContainText('repaid 0.00 of 25.25');
    await expect(page.getByTestId('lending-repay')).toBeEnabled();
    await page.getByTestId('lending-repay').click();

    await expect
      .poll(async () => (await readLending(page, ids)).loans.map(entry => entry.status), { timeout: 15_000 })
      .toEqual(['repaid']);
    const repaid = await readLending(page, ids);
    expect(repaid.loans).toEqual([{ ...loan, status: 'repaid', repaid: BORROW.repayment.toString() }]);
    expect(repaid.pools).toEqual([{ ...pool, available: (LEND.amount + BORROW.interest).toString(), borrowed: '0' }]);
    await expect.poll(async () => (await readAccount(page, ids)).hubCredit, { timeout: 15_000 }).toBe(start.hubCredit);
    // lending_repay is a direct payment of the full repayment amount to the hub.
    await expect
      .poll(() => settledOwned(page, ids), { timeout: 15_000 })
      .toEqual({ owned: (50_000_000n - BORROW.repayment).toString(), pending: false, mempool: 0 });
    await expect(page.getByTestId('lending-repay')).toHaveCount(0);
    await expect(loanRow.locator('.s')).toContainText('1h · 1.00% · repaid · due ');
    await expect(loanRow.locator('.s')).toContainText('repaid 25.25 of 25.25');

    // Close the funded position; the repaid principal and interest pay out.
    const close = page.getByTestId('lending-close');
    await expect(close).toHaveText('Close & receive 50.25 USDC');
    await expect(close).toBeEnabled();
    await close.click();
    await expect
      .poll(async () => (await readLending(page, ids)).pools.map(entry => entry.status), { timeout: 15_000 })
      .toEqual(['closed']);
    const closed = await readLending(page, ids);
    expect(closed.pools).toEqual([{ ...pool, status: 'closed', available: '0', borrowed: '0' }]);
    await expect
      .poll(() => settledOwned(page, ids), { timeout: 15_000 })
      .toEqual({
        owned: (50_000_000n - BORROW.repayment + LEND.amount + BORROW.interest).toString(),
        pending: false,
        mempool: 0,
      });
    await expect(close).toHaveCount(0);
    const finished = await readAccount(page, ids);
    expect(finished.hubCredit).toBe(start.hubCredit);
    expect(errors).toEqual([]);
    await test.info().attach('lending-borrow-repay', {
      body: safeStringify({ ids, start, pool, lent, loan, granted, repaid, closed, finished }, 2),
      contentType: 'application/json',
    });
  },
);
