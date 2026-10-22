import { expect, test } from '@playwright/test';
import { enterStack } from '../stack';
import { readBankOwnerConnection } from './bank-policy';
import { readAccount } from './financial-evidence';
import { submitLoanRequest } from './loan-request';

test(
  'bank officer publishes prices, approves and revokes a real borrower facility',
  { tag: '@functional' },
  async ({ page, browser }) => {
    test.setTimeout(60_000);
    const wallet = await enterStack(page);
    await page.getByTestId('home-faucet').click();
    await expect(page.getByTestId('test-money-status')).toHaveText('100 USDC received');
    await page.getByTestId('account-row').first().click();
    const hubId = new URL(page.url()).pathname.split('/accounts/')[1];
    if (!hubId) throw new Error('BANK_UI_HUB_MISSING');
    const ids = { ownerId: wallet.entityId, hubId, tokenId: 1 };
    const readPolicy = async (): Promise<unknown> => {
      const response = await page.request.get('/api/lending/state', {
        params: { hubEntityId: hubId, userEntityId: wallet.entityId, tokenId: '1' },
      });
      expect(response.ok()).toBe(true);
      return response.json();
    };
    const { entry } = await readBankOwnerConnection(page, hubId);
    const context = await browser.newContext();
    const officer = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', cause => errors.push(cause.message));
    officer.on('pageerror', cause => errors.push(cause.message));
    try {
      await officer.goto(new URL('/', page.url()).href);
      await officer.getByText('Advanced connection', { exact: true }).click();
      await officer.getByRole('button', { name: 'Connect a remote runtime', exact: true }).click();
      await officer.getByLabel('Runtime endpoint', { exact: true }).fill(entry.wsUrl);
      await officer.getByLabel('Access key · optional', { exact: true }).fill(entry.token);
      await officer.getByRole('button', { name: 'Connect', exact: true }).click();
      await officer
        .locator('button.gate-card')
        .filter({ hasText: hubId.slice(0, 18) })
        .click();
      await expect(officer.getByTestId('home-total')).toBeVisible();
      await officer.getByTestId('nav-manage').locator('visible=true').first().click();
      await officer.getByTestId('manage-lend').click();
      await officer.getByRole('button', { name: '1 day', exact: true }).click();
      await officer.getByText('Bank administration', { exact: true }).click();
      await officer.getByTestId('bank-borrower').selectOption(wallet.entityId);
      await officer.getByTestId('bank-savings-rate').fill('100');
      await officer.getByTestId('bank-loan-rate').fill('200');
      await officer.getByTestId('bank-late-hours').fill('12');
      await officer.getByTestId('bank-publish-rates').click();
      await expect(officer.getByTestId('bank-committed-rates')).toContainText('savings 1.00% · loans 2.00%');
      await expect(officer.getByTestId('bank-committed-rates')).toContainText(
        'Late interest ends 12 hours after maturity',
      );
      await officer.getByTestId('bank-facility-principal').fill('2');
      await officer.getByTestId('bank-approve').click();
      await expect(officer.getByTestId('bank-committed-facility')).toContainText('Principal cap: 2 USDC');
      const facility = { borrowerEntityId: wallet.entityId, tokenId: 1, termId: '1d' };
      await expect.poll(readPolicy).toMatchObject({
        facilities: expect.arrayContaining([expect.objectContaining({ ...facility, maxPrincipal: '2000000' })]),
      });
      await officer.getByTestId('bank-revoke').click();
      await expect(officer.getByTestId('bank-committed-facility')).toContainText('New draws revoked');
      await expect.poll(readPolicy).toMatchObject({
        facilities: expect.arrayContaining([expect.objectContaining({ ...facility, maxPrincipal: '0' })]),
      });
      await page.getByTestId('nav-manage').locator('visible=true').first().click();
      await page.getByTestId('manage-lend').click();
      await page.getByRole('button', { name: '1 day', exact: true }).click();
      await expect(page.getByTestId('lend-rate')).toHaveValue('100');
      await expect(page.getByTestId('bank-lending-policy')).toHaveCount(0);
      await expect.poll(async () => (await readAccount(page, ids)).balance).toBe('100000000');
      await submitLoanRequest(page, '1 day', '200');
      await expect(page.getByTestId('lending-request-status')).toContainText('No loan was funded');
      await expect.poll(readPolicy).toMatchObject({ loans: [] });
      await expect
        .poll(async () => {
          const account = await readAccount(page, ids);
          return { balance: account.balance, pending: account.pending, mempool: account.mempool };
        })
        .toEqual({ balance: '100000000', pending: false, mempool: 0 });
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  },
);
