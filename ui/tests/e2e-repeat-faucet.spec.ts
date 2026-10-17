import { expect, test } from '@playwright/test';
import type { RuntimeAdapterViewFrame, XLNModule } from '../../core/api/public/runtime-module';
import type { RuntimeAdapter } from '../../core/api/runtime-adapter/types';
import { expectDollarScale } from './balance-scale';
import { enterStack } from './stack';

test('faucet can fund twice on the same page without duplicate payments', { tag: '@functional' }, async ({ page }) => {
  test.setTimeout(50_000);
  const requests: string[] = [];
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (request.method() === 'POST' && request.url().endsWith('/api/faucet/offchain')) requests.push(request.url());
  });
  const wallet = await enterStack(page);
  const faucet = page.getByTestId('home-faucet');
  for (const count of [1, 2]) {
    await expect(faucet).toBeEnabled();
    // A double click must still submit one payment, including after prior success.
    await faucet.dblclick();
    await expect(page.getByTestId('test-money-status')).toHaveText('100 USDC received');
    await expect
      .poll(() =>
        page.evaluate(async owner => {
          const debug = (
            window as Window & {
              __xln?: { adapter(): RuntimeAdapter | null; xln(): Promise<XLNModule> };
            }
          ).__xln;
          const adapter = debug?.adapter();
          if (!debug || !adapter) throw new Error('Wallet adapter unavailable');
          const view = await adapter.read<RuntimeAdapterViewFrame>('view-frame', { entityId: owner });
          const account = view.activeEntity?.accounts.items[0];
          const delta = account?.state.deltas.get(1);
          if (!account || !delta) throw new Error('Wallet USDC Account unavailable');
          const derived = (await debug.xln()).deriveDelta(delta, account.state.leftEntity === owner);
          return {
            owned: String(derived.outCollateral + derived.outPeerCredit - derived.inOwnCredit),
            pending: Boolean(account.pendingFrame),
            mempool: account.mempoolCount,
          };
        }, wallet.entityId),
      )
      .toEqual({ owned: String(count * 100_000_000), pending: false, mempool: 0 });
    expect(requests).toHaveLength(count);
    await expect(page.getByTestId('home-balance-breakdown')).toBeVisible();
    await expect(page.getByTestId('home-secured')).toHaveText('Collateral-backed$0.00');
    await expect(page.getByTestId('home-risk')).toHaveText(`At risk$${count * 100}.00`);
    await expect(page.getByTestId('token-row-USDC').locator('.account-funding .bw')).toBeVisible();
    await expect(page.getByTestId('token-row-USDC').locator('.account-limits')).toContainText(
      `Can send now${count * 100}.00 USDC`,
    );
    await expect(page.getByTestId('token-row-USDC').locator('.account-limits')).toContainText(
      'Can receive now0.00 USDC',
    );
    await expect(faucet).toBeEnabled();
    await expect(faucet).toHaveText('Get 100 USDC');
    await expect(page).toHaveURL(/\/$/);
    await expectDollarScale(page);
    console.log('REPEAT_FAUCET_COMMITTED', count, count * 100_000_000);
  }
  expect(errors).toEqual([]);
  await page.screenshot({ path: '/tmp/xln-wallet-bars-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByTestId('home-balance-breakdown')).toBeVisible();
  await expect(page.getByTestId('token-row-USDC').locator('.account-funding .bw')).toBeVisible();
  await expectDollarScale(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: '/tmp/xln-wallet-bars-mobile.png', fullPage: true });
});
