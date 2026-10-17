import { expect, type Page, type TestInfo } from '../../global-setup.mts';
import { formatUnits, parseUnits } from 'ethers';
import { safeStringify } from '../../../core/protocol/serialization';
import { readAccount, readOrders } from '../../../ui/tests/swap-evidence';
import { fundFromHubUi } from '../../../ui/tests/fund-from-hub';

/** An out-of-band manual limit must never become a signed financial obligation. */
export async function verifyPriceBandRejection(page: Page, info: TestInfo, side: 'ask' | 'bid'): Promise<void> {
  await page.getByTestId('home-faucet').click();
  await expect(page.getByTestId('test-money-status')).toHaveText('100 USDC received');
  if (side === 'bid') await fundFromHubUi(page, expect, '1', 'WETH');
  await page.getByTestId('account-row').first().click();
  const hubId = new URL(page.url()).pathname.split('/accounts/')[1];
  if (!hubId || !/^0x[0-9a-f]{64}$/.test(hubId)) throw new Error('SWAP_HUB_ID_MISSING');
  await page.getByTestId('back').click();
  await expect
    .poll(async () => {
      const account = await readAccount(page, hubId);
      return { pending: account.pending, mempool: account.mempool };
    })
    .toEqual({ pending: false, mempool: 0 });
  const before = await readAccount(page, hubId);
  expect(before.offers).toBe(0);
  expect((await readOrders(page, hubId)).items).toHaveLength(0);
  await page.getByTestId('home-swap').click();
  const book = page.getByTestId('orderbook').locator('visible=true').first();
  await expect(book).toHaveAttribute('data-status', 'live');
  const level = side === 'ask' ? book.getByTestId('book-row-ask').last() : book.getByTestId('book-row-bid').first();
  const marketPrice = parseUnits((await level.locator('.bk-price').innerText()).replaceAll(',', ''), 4);
  await level.click();
  const badPrice = (marketPrice * (side === 'ask' ? 140n : 59n)) / 100n;
  // For a 0.01-WETH lot, raw USDC units equal four-decimal price ticks.
  await page.getByTestId('swap-give').fill(side === 'ask' ? formatUnits(badPrice, 6) : '0.01');
  await page.getByTestId('swap-want').fill(side === 'ask' ? '0.01' : formatUnits(badPrice, 6));
  await expect(page.getByTestId('swap-submit')).toBeDisabled();
  await expect(page.getByText('Price must stay within 30% of the current orderbook.', { exact: true })).toBeVisible();
  expect(await readAccount(page, hubId)).toEqual(before);
  expect((await readOrders(page, hubId)).items).toHaveLength(0);
  await info.attach('current-price-band-rejection', {
    body: safeStringify({ side, marketPrice, badPrice, before, after: await readAccount(page, hubId) }),
    contentType: 'application/json',
  });
}
