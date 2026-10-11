import { expect, test, type Page } from '@playwright/test';
import { safeStringify } from '../../../core/protocol/serialization';
import { enterStack } from '../stack';
import { readAccount, readPools, readRoutingEvidence, requestEarlyClose, type Parties } from './financial-evidence';
import { setBankPolicy } from './bank-policy';

const lending = async (page: Page) => {
  await page.getByTestId('nav-manage').locator('visible=true').first().click();
  await page.getByTestId('manage-lend').click();
};
const home = async (page: Page) => {
  await page.getByTestId('nav-home').locator('visible=true').first().click();
};
async function fundedWallet(page: Page): Promise<Parties> {
  const wallet = await enterStack(page);
  await page.getByTestId('home-faucet').click();
  await expect(page.getByTestId('test-money-status')).toHaveText('100 USDC received');
  await page.getByTestId('account-row').first().click();
  const hubId = new URL(page.url()).pathname.split('/accounts/')[1];
  if (!hubId) throw new Error('LENDING_HUB_MISSING');
  const ids = { ownerId: wallet.entityId, hubId, tokenId: 1 };
  await expect.poll(async () => (await readAccount(page, ids)).balance).toBe('100000000');
  return ids;
}
async function loans(page: Page, ids: Parties) {
  const response = await page.request.get('/api/lending/state', { params: { hubEntityId: ids.hubId, userEntityId: ids.ownerId } });
  expect(response.ok()).toBe(true);
  const value: unknown = await response.json();
  if (!value || typeof value !== 'object' || !('loans' in value) || !Array.isArray(value.loans)) throw new Error('LENDING_RESPONSE_INVALID');
  return value.loans.map((loan: unknown) => {
    if (!loan || typeof loan !== 'object' || !('status' in loan) || typeof loan.status !== 'string'
      || !('repaymentAmount' in loan) || typeof loan.repaymentAmount !== 'string') throw new Error('LENDING_LOAN_INVALID');
    return { status: loan.status, repaymentAmount: loan.repaymentAmount };
  });
}

test('term loan transfers principal once, spends it, repays and returns lender money', { tag: '@functional' }, async ({ page, browser, baseURL }) => {
  test.setTimeout(60_000);
  const borrowerContext = await browser.newContext({ baseURL });
  const borrower = await borrowerContext.newPage();
  const errors: string[] = [];
  for (const wallet of [page, borrower]) wallet.on('pageerror', error => errors.push(error.message));
  try {
    const lenderIds = await fundedWallet(page);
    const borrowerIds = await fundedWallet(borrower);
    expect(borrowerIds.hubId).toBe(lenderIds.hubId);
    await setBankPolicy(page, borrowerIds, { termId: '1h', savingsInterestBps: 100, loanInterestBps: 200, loanLateMs: 3_600_000, maxPrincipal: 2_000_000n });
    const before = await readAccount(borrower, borrowerIds);
    await page.getByTestId('wallet-tutorial').click();
    await page.getByTestId('tour-chapter').selectOption('lending');
    await page.getByRole('button', { name: '1 hour', exact: true }).click();
    await page.getByTestId('lend-amount').fill('5');
    await expect(page.getByTestId('lend-rate')).toHaveValue('100');
    await expect(page.getByTestId('lend-submit')).toBeDisabled();
    await expect(page.getByTestId('lending-risk-consent')).toContainText('100.05 USDC');
    await page.getByTestId('lending-risk-authorize').click();
    await expect.poll(async () => (await readAccount(page, lenderIds)).credit).toBe('100050000');
    await expect(page.getByTestId('lend-submit')).toBeEnabled();
    await page.getByTestId('lend-submit').click();
    await expect.poll(async () => (await readPools(page, lenderIds)).map(pool => pool.available)).toEqual(['5000000']);
    await home(page);
    await expect(page.getByTestId('home-total')).toContainText('100.00');
    // Receiving the borrower's later 2 USDC also needs saver-approved bank risk.
    // Include that payment and the coupon in a deliberate 103 USDC limit.
    await page.getByTestId('account-row').first().click();
    await page.getByRole('button', { name: 'Extend credit', exact: true }).click();
    const credit = page.getByRole('dialog', { name: 'Extend credit', exact: true });
    await credit.locator('input').fill('103');
    await credit.getByRole('button', { name: 'Extend credit', exact: true }).click();
    await expect.poll(async () => (await readAccount(page, lenderIds)).credit).toBe('103000000');
    await home(page);
    await borrower.getByTestId('wallet-tutorial').click();
    await borrower.getByTestId('tour-chapter').selectOption('borrow');
    await borrower.getByTestId('lend-side-borrow').click();
    await borrower.getByRole('button', { name: '1 hour', exact: true }).click();
    await borrower.getByTestId('lend-amount').fill('2');
    await borrower.getByTestId('lend-rate').fill('200');
    await expect(borrower.getByTestId('lending-borrow-preview')).toContainText('Term repayment: 2.04 USDC, due 1 hour after approval.');
    await expect(borrower.getByTestId('lending-borrow-preview')).toContainText('Maximum repayment: 2.08 USDC');
    await expect(borrower.getByTestId('lend-submit')).toBeDisabled();
    const receive = borrower.getByTestId('receive-spectrum');
    await receive.getByRole('button', { name: 'Accept it as credit instead', exact: true }).click();
    await receive.getByRole('checkbox').uncheck();
    await borrower.getByTestId('receive-spectrum-confirm').click();
    await expect.poll(async () => (await readAccount(borrower, borrowerIds)).credit).toBe('102000000');
    await expect(borrower.getByTestId('lend-submit')).toBeEnabled();
    await borrower.getByTestId('lend-submit').click();
    await expect.poll(() => loans(borrower, borrowerIds)).toEqual([{ status: 'active', repaymentAmount: '2040000' }]);
    await expect(borrower.getByTestId('lending-request-status')).toContainText('Loan active');
    await expect.poll(async () => (await readAccount(borrower, borrowerIds)).balance).toBe('102000000');
    await expect.poll(async () => (await readPools(page, lenderIds)).map(pool => pool.borrowed)).toEqual(['2000000']);
    const [fundedPool] = await readPools(page, lenderIds);
    if (!fundedPool) throw new Error('LENDING_POOL_MISSING');
    // The bank must survive this valid but premature signed request. After loan
    // repayment, the ordinary Close UI retries the same position successfully.
    await requestEarlyClose(page, lenderIds, fundedPool.positionId);
    await expect.poll(async () => (await readAccount(page, lenderIds)).closeRequests).toEqual([`close:${fundedPool.positionId}`]);
    expect((await readPools(page, lenderIds))[0]).toMatchObject({ status: 'open', borrowed: '2000000' });
    const disbursed = await readAccount(borrower, borrowerIds);
    expect(disbursed.borrowingLimit).toBe(before.borrowingLimit);
    await home(borrower);
    await expect(borrower.getByTestId('home-total')).toContainText('99.96');
    await borrower.getByTestId('home-pay').click();
    await borrower.getByTestId('pay-to').fill(lenderIds.ownerId);
    await borrower.getByTestId('pay-amount').fill('2');
    await expect(borrower.getByTestId('pay-submit')).toBeEnabled();
    const debitText = await borrower.getByTestId('pay-quote').getAttribute('data-sender-amount');
    if (!debitText) throw new Error('LENDING_SPEND_QUOTE_MISSING');
    const debit = BigInt(debitText);
    await borrower.getByTestId('pay-submit').click();
    await borrower.getByTestId('receipt-open').click();
    await expect(borrower.getByTestId('payment-receipt')).toBeVisible();
    await borrower.getByTestId('receipt-done').click();
    await expect.poll(async () => (await readAccount(page, lenderIds)).balance).toBe('97000000');
    await expect(page.getByTestId('payment-notification')).toContainText('Received');
    await page.getByRole('button', { name: 'Dismiss payment notification' }).click();
    await borrower.getByTestId('tour-chapter').selectOption('repay');
    await borrower.getByTestId('lending-repay').click();
    await expect.poll(() => loans(borrower, borrowerIds)).toEqual([{ status: 'repaid', repaymentAmount: '2040000' }]);
    await expect.poll(async () => (await readAccount(borrower, borrowerIds)).balance).toBe((100000000n - debit - 40000n).toString());
    const repaid = await readAccount(borrower, borrowerIds);
    expect(repaid.borrowingLimit).toBe(before.borrowingLimit);
    expect(repaid.debt).toBe('0');
    await lending(page);
    await expect(page.getByTestId('lending-close')).toBeEnabled();
    await page.getByTestId('lending-close').click();
    await expect.poll(async () => (await readPools(page, lenderIds)).map(pool => pool.status)).toEqual(['closed']);
    // The saver cancels before its one-hour maturity. Its principal is returned;
    // the borrower's 0.04 interest belongs to the bank, not this early withdrawal.
    await expect.poll(async () => (await readAccount(page, lenderIds)).balance).toBe('102000000');
    await home(page);
    await expect(page.getByTestId('home-total')).toContainText('102.00');
    await test.info().attach('lending-money-evidence', { body: safeStringify({ before, disbursed, repaid, debit }), contentType: 'application/json' });
    expect(errors).toEqual([]);
  } catch (error) {
    await test.info().attach('lending-route-failure', {
      body: safeStringify({ lender: await readRoutingEvidence(page), borrower: await readRoutingEvidence(borrower) }),
      contentType: 'application/json',
    });
    throw error;
  } finally { await borrowerContext.close(); }
});
