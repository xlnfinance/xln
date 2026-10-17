import { expect, type Page, type TestInfo } from '../../global-setup.mts';
import { parseUnits } from 'ethers';
import { safeStringify } from '../../../core/protocol/serialization';
import { readAccount, readOrders } from '../../../ui/tests/swap-evidence';
import { capturePageScreenshot } from '../e2e-screenshots';

/** A selected asset changes the units of the ticket, so an old explicit quote must not survive it. */
export async function verifySwapTokenSelection(page: Page, info: TestInfo): Promise<void> {
  await page.getByTestId('home-faucet').click();
  await expect(page.getByTestId('test-money-status')).toHaveText('100 USDC received');
  await page.getByTestId('account-row').first().click();
  const hubId = new URL(page.url()).pathname.split('/accounts/')[1];
  if (!hubId || !/^0x[0-9a-f]{64}$/.test(hubId)) throw new Error('TOKEN_SELECTION_ACCOUNT_MISSING');
  await expect
    .poll(async () => {
      const account = await readAccount(page, hubId);
      return { pending: account.pending, mempool: account.mempool, usdc: account.usdc };
    })
    .toEqual({ pending: false, mempool: 0, usdc: '100000000' });
  const before = await readAccount(page, hubId);
  const ordersBefore = await readOrders(page, hubId);
  await page.getByTestId('back').click();
  await page.getByTestId('home-swap').click();
  const book = page.getByTestId('orderbook').locator('visible=true').first();
  await expect(book).toHaveAttribute('data-status', 'live');
  await book.getByTestId('book-row-ask').last().click();
  const give = page.getByTestId('swap-give');
  const want = page.getByTestId('swap-want');
  const givePicker = page.locator('.field-row').filter({ has: give }).getByRole('button');
  const wantPicker = page.locator('.field-row').filter({ has: want }).getByRole('button');
  const previous = { give: await give.inputValue(), want: await want.inputValue() };
  expect(parseUnits(previous.want, 18)).toBeGreaterThan(0n);
  await wantPicker.click();
  await page.getByRole('option', { name: /USDT/ }).click();
  await expect(book.locator('.bk-head .caps')).toHaveText('USDC/USDT · H1');
  await expect(book).toHaveAttribute('data-status', 'live');
  await info.attach('token-selection-before-assertion', {
    body: safeStringify({
      previous,
      next: {
        give: await give.inputValue(),
        want: await want.inputValue(),
        placeholder: await want.getAttribute('placeholder'),
      },
    }),
    contentType: 'application/json',
  });
  await expect(want, 'changing the receive asset invalidates the old WETH limit').toHaveValue('');
  await expect(give).toHaveValue(previous.give);
  await expect(want).toHaveAttribute('placeholder', '99.99');
  await expect(page.getByTestId('swap-submit')).toBeEnabled();
  // Preserve the original root case's USDT -> USDC orientation using the real flip action.
  await page.getByTestId('swap-flip').click();
  await expect(givePicker).toContainText('USDT');
  await expect(wantPicker).toContainText('USDC');
  await expect(book.locator('.bk-head .caps')).toHaveText('USDC/USDT · H1');
  await page.getByTestId('swap-flip').click();
  await want.fill('99.98');
  await givePicker.click();
  await page.getByRole('option', { name: /WETH/ }).click();
  await expect(want, 'changing the pay asset invalidates the old USDC/USDT limit').toHaveValue('');
  await give.fill('0.01');
  await expect(book.locator('.bk-head .caps')).toHaveText('WETH/USDT · H1');
  await expect(book).toHaveAttribute('data-status', 'live');
  await expect(want).toHaveAttribute('placeholder', '24.995');
  expect(await readAccount(page, hubId)).toEqual(before);
  expect(await readOrders(page, hubId)).toEqual(ordersBefore);
  await capturePageScreenshot(page, info, 'swap-token-selection-current-quote.png', { fullPage: false });
  await info.attach('token-selection-proof', {
    body: safeStringify({
      hubId,
      before,
      after: await readAccount(page, hubId),
      ordersBefore,
      previous,
      final: {
        give: await give.inputValue(),
        want: await want.inputValue(),
        placeholder: await want.getAttribute('placeholder'),
      },
    }),
    contentType: 'application/json',
  });
}
