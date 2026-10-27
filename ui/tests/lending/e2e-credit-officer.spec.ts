import { expect, test } from '@playwright/test';
import { enterStack, fundFromHub } from '../stack';
import { setBankPolicy } from './bank-policy';
import { readPools, setCreditLimit } from './financial-evidence';
import { borrowThroughOfficer } from './credit-officer';

/** Local and isolated testnet launchers enable the officer.
 * Borrow/Repay are real tutorial actions; this scenario never skips them. */
test(
  'credit officer enables the tutorial borrow and repay chapters for a new borrower',
  { tag: '@functional' },
  async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    const status = await page.request.get('/api/credit-officer/status');
    expect(status.ok()).toBe(true);
    expect(await status.json()).toMatchObject({ success: true, enabled: true });
    const wallet = await enterStack(page);
    await fundFromHub(page, '100');
    await page.getByTestId('account-row').first().click();
    const hubId = new URL(page.url()).pathname.split('/accounts/')[1];
    if (!hubId) throw new Error('LENDING_HUB_MISSING');
    const ids = { ownerId: wallet.entityId, hubId, tokenId: 1 };
    await setCreditLimit(page, ids, '100', '100000000');
    // The operator publishes prices, but grants this borrower no facility.
    await setBankPolicy(page, ids, { termId: '1d', savingsInterestBps: 100, loanInterestBps: 200 });
    await page.getByTestId('nav-manage').locator('visible=true').first().click();
    await page.getByTestId('manage-lend').click();
    await page.getByRole('button', { name: '1 day', exact: true }).click();
    await page.getByTestId('lend-amount').fill('5');
    const consent = page.getByTestId('lending-risk-authorize');
    if (await consent.count()) await consent.click();
    await expect(page.getByTestId('lend-submit')).toBeEnabled();
    await page.getByTestId('lend-submit').click();
    await expect.poll(async () => (await readPools(page, ids)).map(pool => pool.status)).toContain('open');
    await page.getByTestId('wallet-tutorial').click();
    await page.getByTestId('tour-chapter').selectOption('borrow');
    await page.getByTestId('lend-side-borrow').click();
    await expect(page.getByTestId('lending-no-facility')).toBeVisible();
    await page.getByTestId('lend-amount').fill('2');
    const receive = page.getByTestId('receive-spectrum');
    await receive.getByRole('button', { name: 'Accept it as credit instead', exact: true }).click();
    await receive.getByRole('checkbox').uncheck();
    await page.getByTestId('receive-spectrum-confirm').click();
    await expect(page.getByTestId('lend-submit')).toBeEnabled();
    await borrowThroughOfficer(page, ids, expect);
    await page.screenshot({ path: 'tests/test-results/credit-officer-borrow.png', fullPage: true });
    await page.getByTestId('tour-chapter').selectOption('repay');
    await page.getByTestId('lending-repay').click();
    await expect(page.getByTestId('lending-request-status')).toContainText('Loan repaid', { timeout: 30_000 });
    await page.screenshot({ path: 'tests/test-results/credit-officer-repaid.png', fullPage: true });
    expect(errors).toEqual([]);
  },
);
