import { expect, test } from '@playwright/test';
import { enterStack, reopenStack, readWalletCheckpoint } from '../stack';
import { readAccount, readPools } from './financial-evidence';
import { setBankPolicy } from './bank-policy';

test(
  'demand savings preserve the claim through a rate update, reload and withdrawal',
  { tag: '@functional' },
  async ({ page }, info) => {
    test.setTimeout(60_000);
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => {
      if (message.type() === 'error') errors.push(message.text());
    });
    const wallet = await enterStack(page);
    await page.getByTestId('home-faucet').click();
    await expect(page.getByTestId('test-money-status')).toHaveText('100 USDC received');
    await page.getByTestId('account-row').first().click();
    const hubId = new URL(page.url()).pathname.split('/accounts/')[1];
    if (!hubId) throw new Error('DEMAND_HUB_MISSING');
    const ids = { ownerId: wallet.entityId, hubId, tokenId: 1 };
    await setBankPolicy(page, ids, { termId: 'demand', savingsInterestBps: 500, loanInterestBps: 0 });
    await page.getByTestId('nav-manage').locator('visible=true').first().click();
    await page.getByTestId('manage-lend').click();
    await expect(page.getByRole('button', { name: 'On demand', exact: true })).toHaveClass(/active/);
    await page.getByTestId('lend-amount').fill('5');
    await expect(page.getByTestId('lend-rate')).toHaveValue('500');
    await expect(page.getByTestId('lending-risk-consent')).toContainText('100.25 USDC');
    await page.getByTestId('lending-risk-authorize').click();
    await expect(page.getByTestId('lend-submit')).toBeEnabled();
    await page.getByTestId('lend-submit').click();
    await expect.poll(async () => (await readPools(page, ids)).map(pool => pool.principal)).toEqual(['5000000']);
    await expect(page.getByTestId('savings-rate-coverage')).toContainText('Signed rate coverage ends');
    await setBankPolicy(page, ids, { termId: 'demand', savingsInterestBps: 200, loanInterestBps: 0 });
    await expect(page.getByText(/On demand · 2.00% per year · open/)).toBeVisible();
    await expect.poll(async () => (await readAccount(page, ids)).balance).toBe('95000000');
    const before = await readAccount(page, ids);
    await page.reload();
    await reopenStack(page, wallet);
    await expect.poll(async () => (await readAccount(page, ids)).balance).toBe(before.balance);
    await page.getByTestId('nav-manage').locator('visible=true').first().click();
    await page.getByTestId('manage-lend').click();
    await expect(page.getByText(/On demand · 2.00% per year · open/)).toBeVisible();
    await page.screenshot({ path: info.outputPath('demand-savings.png'), fullPage: true, animations: 'disabled' });
    await page.getByTestId('lending-close').click();
    await expect.poll(async () => (await readPools(page, ids)).map(pool => pool.status)).toEqual(['closed']);
    // The 60-second test at at most 5% APR on 5 USDC earns less than one
    // atomic unit. The covenant floors interest; any extra payout is wrong.
    await expect.poll(async () => (await readAccount(page, ids)).balance).toBe('100000000');
    await expect
      .poll(async () =>
        (await readWalletCheckpoint(page)).accounts.map(account => ({
          pending: account.pending,
          mempool: account.mempool,
        })),
      )
      .toEqual([{ pending: false, mempool: 0 }]);
    expect(errors).toEqual([]);
  },
);
