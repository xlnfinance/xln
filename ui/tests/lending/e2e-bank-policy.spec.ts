import { expect, test } from '@playwright/test';
import { enterStack } from '../stack';
import { readBankOwnerConnection } from './bank-policy';

test('bank officer publishes prices, approves and revokes a real borrower facility', { tag: '@functional' }, async ({ page, browser }) => {
  test.setTimeout(60_000);
  const wallet = await enterStack(page);
  await page.getByTestId('home-faucet').click();
  await expect(page.getByTestId('test-money-status')).toHaveText('100 USDC received');
  await page.getByTestId('account-row').first().click();
  const hubId = new URL(page.url()).pathname.split('/accounts/')[1];
  if (!hubId) throw new Error('BANK_UI_HUB_MISSING');
  const { entry } = await readBankOwnerConnection(page, hubId);
  const context = await browser.newContext();
  const officer = await context.newPage();
  const errors: string[] = [];
  officer.on('pageerror', cause => errors.push(cause.message));
  try {
    await officer.goto(new URL('/', page.url()).href);
    await officer.getByText('Advanced connection', { exact: true }).click();
    await officer.getByRole('button', { name: 'Connect a remote runtime', exact: true }).click();
    await officer.getByLabel('Runtime endpoint', { exact: true }).fill(entry.wsUrl);
    await officer.getByLabel('Access key · optional', { exact: true }).fill(entry.token);
    await officer.getByRole('button', { name: 'Connect', exact: true }).click();
    await officer.locator('button.gate-card').filter({ hasText: hubId.slice(0, 18) }).click();
    await expect(officer.getByTestId('home-total')).toBeVisible();
    await officer.getByTestId('nav-manage').locator('visible=true').first().click();
    await officer.getByTestId('manage-lend').click();
    await officer.getByText('Bank administration', { exact: true }).click();
    await officer.getByTestId('bank-borrower').selectOption(wallet.entityId);
    await officer.getByTestId('bank-savings-rate').fill('100');
    await officer.getByTestId('bank-loan-rate').fill('200');
    await officer.getByTestId('bank-late-hours').fill('12');
    await officer.getByTestId('bank-publish-rates').click();
    await expect(officer.getByTestId('bank-committed-rates')).toContainText('savings 1.00% · loans 2.00%');
    await expect(officer.getByTestId('bank-committed-rates')).toContainText('Late interest ends 12 hours after maturity');
    await officer.getByTestId('bank-facility-principal').fill('2');
    await officer.getByTestId('bank-approve').click();
    await expect(officer.getByTestId('bank-committed-facility')).toContainText('Principal cap: 2 USDC');
    await officer.getByTestId('bank-revoke').click();
    await expect(officer.getByTestId('bank-committed-facility')).toContainText('New draws revoked');
    await page.getByTestId('nav-manage').locator('visible=true').first().click();
    await page.getByTestId('manage-lend').click();
    await expect(page.getByTestId('lend-rate')).toHaveValue('100');
    await expect(page.getByTestId('bank-lending-policy')).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally { await context.close(); }
});
