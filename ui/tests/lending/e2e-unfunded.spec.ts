import { expect, test } from '@playwright/test';
import { enterStack } from '../stack';
import { setBankPolicy } from './bank-policy';
import { readAccount } from './financial-evidence';
import { submitLoanRequest } from './loan-request';
import type { RuntimeAdapter } from '../../../core/api/runtime-adapter/types';
import type { RuntimeAdapterViewFrame } from '../../../core/api/public/runtime-module';

test('an unapproved loan request leaves the bank serving real payments', { tag: '@functional' }, async ({ page }) => {
  test.setTimeout(50_000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const wallet = await enterStack(page);
  await page.getByTestId('home-faucet').click();
  await expect(page.getByTestId('test-money-status')).toHaveText('100 USDC received');
  await page.getByTestId('account-row').first().click();
  const hubId = new URL(page.url()).pathname.split('/accounts/')[1];
  if (!hubId) throw new Error('LENDING_HUB_MISSING');
  const ids = { ownerId: wallet.entityId, hubId, tokenId: 1 };
  for (const params of [
    { hubEntityId: hubId, requestId: 'borrow-1111111111111111' },
    { hubEntityId: hubId, userEntityId: wallet.entityId, requestId: 'invalid' },
  ]) {
    expect((await page.request.get('/api/lending/state', { params })).status()).toBe(400);
  }
  await setBankPolicy(page, ids, { termId: '1m', savingsInterestBps: 0, loanInterestBps: 0, maxPrincipal: 0n });
  await submitLoanRequest(page, '1 month', '0');
  await expect
    .poll(() =>
      page.evaluate(async parties => {
        const debug = (window as Window & { __xln?: { adapter: () => RuntimeAdapter | null } }).__xln;
        const adapter = debug?.adapter();
        if (!adapter) throw new Error('LENDING_ADAPTER_MISSING');
        type Account = NonNullable<RuntimeAdapterViewFrame['activeEntity']>['accounts']['items'][number];
        const account = await adapter.read<Account>(`entity/${parties.ownerId}/account/${parties.hubId}`);
        return [...(account.state.lendingIntents ?? [])].filter(
          ([id, kind]) => id.startsWith('borrow:') && kind === 'borrow',
        ).length;
      }, ids),
    )
    .toBe(1);
  await expect(page.getByTestId('lending-request-status')).toContainText('No loan was funded');
  expect((await readAccount(page, ids)).balance).toBe('100000000');
  const response = await page.request.get('/api/lending/state', {
    params: { hubEntityId: hubId, userEntityId: wallet.entityId },
  });
  expect(response.ok()).toBe(true);
  expect(await response.json()).toMatchObject({ loans: [] });
  // A second real faucet payment crosses the same bank after the declined request.
  await page.getByTestId('nav-home').locator('visible=true').first().click();
  await page.getByTestId('home-faucet').click();
  await expect.poll(async () => (await readAccount(page, ids)).balance).toBe('200000000');
  expect(errors).toEqual([]);
});
