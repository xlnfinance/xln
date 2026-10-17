import { expect, type Page, type TestInfo } from '../../global-setup.mts';
import { parseUnits } from 'ethers';
import { safeStringify } from '../../../core/protocol/serialization';
import { readAccount, readOrders } from '../../../ui/tests/swap-evidence';
import { fundFromHubUi } from '../../../ui/tests/fund-from-hub';

/** Flipping an explicit book quote swaps amounts and units; it must never admit an order or grant credit. */
export async function verifySwapFlip(page: Page, info: TestInfo, side: 'ask' | 'bid'): Promise<void> {
  await page.getByTestId('home-faucet').click();
  await expect(page.getByTestId('test-money-status')).toHaveText('100 USDC received');
  await fundFromHubUi(page, expect, '1', 'WETH');
  await page.getByTestId('account-row').first().click();
  const hubId = new URL(page.url()).pathname.split('/accounts/')[1];
  if (!hubId || !/^0x[0-9a-f]{64}$/.test(hubId)) throw new Error('FLIP_ACCOUNT_MISSING');
  await expect
    .poll(async () => {
      const account = await readAccount(page, hubId);
      return { pending: account.pending, mempool: account.mempool, usdc: account.usdc, weth: account.weth };
    })
    .toEqual({ pending: false, mempool: 0, usdc: '100000000', weth: '1000000000000000000' });
  const before = await readAccount(page, hubId);
  const ordersBefore = await readOrders(page, hubId);
  expect(before.offers).toBe(0);
  expect(ordersBefore.items).toHaveLength(0);
  await page.getByTestId('back').click();
  await page.getByTestId('home-swap').click();
  const book = page.getByTestId('orderbook').locator('visible=true').first();
  await expect(book).toHaveAttribute('data-status', 'live');
  const level = side === 'ask' ? book.getByTestId('book-row-ask').last() : book.getByTestId('book-row-bid').first();
  await level.click();
  const give = page.getByTestId('swap-give');
  const want = page.getByTestId('swap-want');
  const givePicker = page.locator('.field-row').filter({ has: give }).getByRole('button');
  const wantPicker = page.locator('.field-row').filter({ has: want }).getByRole('button');
  const sourceSymbol = side === 'ask' ? 'USDC' : 'WETH';
  const targetSymbol = side === 'ask' ? 'WETH' : 'USDC';
  const sourceDecimals = side === 'ask' ? 6 : 18;
  const targetDecimals = side === 'ask' ? 18 : 6;
  await expect(givePicker).toContainText(sourceSymbol);
  await expect(wantPicker).toContainText(targetSymbol);
  const quoted = { give: await give.inputValue(), want: await want.inputValue() };
  expect(parseUnits(quoted.give, sourceDecimals)).toBeGreaterThan(0n);
  expect(parseUnits(quoted.want, targetDecimals)).toBeGreaterThan(0n);
  await page.getByTestId('swap-flip').click();
  await expect(givePicker).toContainText(targetSymbol);
  await expect(wantPicker).toContainText(sourceSymbol);
  await expect(give).toHaveValue(quoted.want);
  await expect(want).toHaveValue(quoted.give);
  const flipped = { give: await give.inputValue(), want: await want.inputValue() };
  expect(parseUnits(flipped.give, targetDecimals)).toBe(parseUnits(quoted.want, targetDecimals));
  expect(parseUnits(flipped.want, sourceDecimals)).toBe(parseUnits(quoted.give, sourceDecimals));
  if (side === 'ask') expect(parseUnits(flipped.give, 18) * 100n).toBeLessThan(parseUnits(quoted.give, 18));
  else expect(parseUnits(flipped.give, 18)).toBeGreaterThan(parseUnits(quoted.give, 18) * 100n);
  // A second click is the exact inverse, including all decimal digits. No submission occurs.
  await page.getByTestId('swap-flip').click();
  await expect(givePicker).toContainText(sourceSymbol);
  await expect(wantPicker).toContainText(targetSymbol);
  await expect(give).toHaveValue(quoted.give);
  await expect(want).toHaveValue(quoted.want);
  expect(await readAccount(page, hubId)).toEqual(before);
  expect(await readOrders(page, hubId)).toEqual(ordersBefore);
  await info.attach('current-swap-flip', {
    body: safeStringify({
      side,
      hubId,
      sourceSymbol,
      targetSymbol,
      sourceDecimals,
      targetDecimals,
      quoted,
      flipped,
      before,
      ordersBefore,
    }),
    contentType: 'application/json',
  });
}
