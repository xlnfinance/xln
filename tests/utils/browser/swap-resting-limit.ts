import { expect, type Page, type TestInfo } from '../../global-setup.mts';
import { formatUnits, parseUnits } from 'ethers';
import { quoteAmountAtPriceForDecimals } from '../../../core/swapbook/types';
import { safeStringify } from '../../../core/protocol/serialization';
import { readAccount, readOrders, expectDeliveryDrained, type DebugWindow } from '../../../ui/tests/swap-evidence';
import { LOCAL_PASSWORD } from '../../../ui/tests/wallet-ui';
import { capturePageScreenshot } from '../e2e-screenshots';

/** Bind the edited limit to a real signed unfilled obligation, then release exactly that hold. */
export async function verifyRestingLimit(
  page: Page,
  info: TestInfo,
  entityId: string,
  baseAmount: bigint,
  editPrice: (clickedPrice: bigint) => bigint,
): Promise<void> {
  await page.getByTestId('home-faucet').click();
  await expect(page.getByTestId('test-money-status')).toHaveText('100 USDC received');
  await page.getByTestId('account-row').first().click();
  const hubId = new URL(page.url()).pathname.split('/accounts/')[1];
  if (!hubId || !/^0x[0-9a-f]{64}$/.test(hubId)) throw new Error('SWAP_HUB_ID_MISSING');
  await page.getByTestId('back').click();
  await page.getByTestId('home-swap').click();
  const book = page.getByTestId('orderbook').locator('visible=true').first();
  await expect(book).toHaveAttribute('data-status', 'live');
  const ask = book.getByTestId('book-row-ask').last();
  await expect(ask).toBeVisible();
  const clickedPrice = parseUnits((await ask.locator('.bk-price').innerText()).replaceAll(',', ''), 4);
  expect(clickedPrice).toBeGreaterThan(0n);
  await ask.click();
  const preview = page.locator('.kv').filter({ hasText: 'Limit price' });
  const readPreviewPrice = async () => {
    const [price] = (await preview.locator('.v').innerText()).split(' ');
    if (!price) throw new Error('SWAP_LIMIT_PREVIEW_MISSING');
    return parseUnits(price.replaceAll(',', ''), 4);
  };
  expect(await readPreviewPrice()).toBe(clickedPrice);
  const editedPrice = editPrice(clickedPrice);
  expect(editedPrice).toBeGreaterThan(0n);
  expect(editedPrice).toBeLessThan(clickedPrice);
  const quoteAmount = quoteAmountAtPriceForDecimals(18, 6, baseAmount, editedPrice);
  expect(quoteAmount).toBeLessThanOrEqual(25_000_000n);
  const give = page.getByTestId('swap-give');
  const want = page.getByTestId('swap-want');
  await give.fill(formatUnits(quoteAmount, 6));
  await want.fill(formatUnits(baseAmount, 18));
  await expect.poll(readPreviewPrice).toBe(editedPrice);
  expect(parseUnits(await give.inputValue(), 6)).toBe(quoteAmount);
  expect(parseUnits(await want.inputValue(), 18)).toBe(baseAmount);
  const runtimeId = await page.evaluate(() => {
    const adapter = (window as DebugWindow).__xln?.adapter();
    if (!adapter) throw new Error('RESTING_RUNTIME_MISSING');
    return adapter.runtimeId;
  });
  const before = await readAccount(page, hubId);
  expect(before.usdc).toBe('100000000');
  expect(before.weth).toBe('0');
  expect(before.offers).toBe(0);
  expect((await readOrders(page, hubId)).items).toHaveLength(0);
  const submit = page.getByTestId('swap-submit');
  await expect(submit).toBeEnabled();
  await capturePageScreenshot(page, info, 'swap-form-filled-resting-limit-desktop.png', {
    fullPage: false,
    ux: {
      title: 'desktop resting limit form',
      group: 'Swap',
      description: 'Limit order configured inside the current orderbook band.',
      platform: 'desktop',
      tags: ['swap', 'limit-order'],
    },
  });
  await submit.click();
  await expect
    .poll(async () => {
      const account = await readAccount(page, hubId);
      return { offers: account.offers, pending: account.pending, mempool: account.mempool };
    })
    .toEqual({ offers: 1, pending: false, mempool: 0 });
  const resting = await readAccount(page, hubId);
  const history = await readOrders(page, hubId);
  expect(history.items).toHaveLength(1);
  const [order] = history.items;
  if (!order) throw new Error('EDITED_LIMIT_ORDER_MISSING');
  expect(order.priceTicks).toBe(editedPrice);
  expect(order.priceTicks).not.toBe(clickedPrice);
  expect(order.originalGiveAmount).toBe(quoteAmount);
  expect(order.originalWantAmount).toBe(baseAmount);
  expect(order.resolves).toHaveLength(0);
  expect(order.closed).toBe(false);
  expect(order.liveGiveAmount).toBe(order.originalGiveAmount);
  expect(order.liveWantAmount).toBe(order.originalWantAmount);
  expect(resting.usdc).toBe(before.usdc);
  expect(resting.weth).toBe(before.weth);
  expect(BigInt(before.usdcSpendable) - BigInt(resting.usdcSpendable)).toBe(order.originalGiveAmount);
  const cancel = page.getByTestId('swap-offer-cancel');
  await expect(cancel).toHaveCount(1);
  await expect(cancel.locator('xpath=ancestor::div[contains(@class,"row")][1]')).toContainText(
    `${formatUnits(quoteAmount, 6)} USDC for ${formatUnits(baseAmount, 18)} WETH`,
  );
  // Account acceptance precedes hub matching. Observe the actual published book
  // before cancellation so a not-yet-admitted offer cannot masquerade as resting.
  const workingBid = book.locator('.bk-row.bid.own');
  await expect(workingBid).toHaveCount(1);
  expect(parseUnits((await workingBid.locator('.bk-price').innerText()).replaceAll(',', ''), 4)).toBe(editedPrice);
  expect(parseUnits((await workingBid.locator('.bk-size').innerText()).replaceAll(',', ''), 18)).toBe(baseAmount);
  // Recovery must preserve the exact signed obligation and its published limit.
  // Drain accepted work before closing the browser; never recreate or resubmit it.
  await page.getByTestId('back').click();
  await expect(page.getByTestId('home-total')).toBeVisible();
  await expectDeliveryDrained(page, expect);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByLabel('Password', { exact: true }).fill(LOCAL_PASSWORD);
  await page.getByRole('button', { name: 'Unlock', exact: true }).click();
  await page.getByTestId('nav-home').locator('visible=true').first().click();
  await expect(page.getByTestId('home-entity-id')).toHaveText(entityId);
  expect(
    await page.evaluate(() => {
      const adapter = (window as DebugWindow).__xln?.adapter();
      if (!adapter) throw new Error('RESTORED_RESTING_RUNTIME_MISSING');
      return adapter.runtimeId;
    }),
  ).toBe(runtimeId);
  const recovered = await readAccount(page, hubId);
  const recoveredHistory = await readOrders(page, hubId);
  expect(recovered).toEqual(resting);
  expect(recoveredHistory).toEqual(history);
  await page.getByTestId('home-swap').click();
  await expect(book).toHaveAttribute('data-status', 'live');
  await expect(cancel).toHaveCount(1);
  await expect(cancel.locator('xpath=ancestor::div[contains(@class,"row")][1]')).toContainText(
    `${formatUnits(quoteAmount, 6)} USDC for ${formatUnits(baseAmount, 18)} WETH`,
  );
  await expect(workingBid).toHaveCount(1);
  expect(parseUnits((await workingBid.locator('.bk-price').innerText()).replaceAll(',', ''), 4)).toBe(editedPrice);
  expect(parseUnits((await workingBid.locator('.bk-size').innerText()).replaceAll(',', ''), 18)).toBe(baseAmount);
  await capturePageScreenshot(page, info, 'swap-resting-order-open-desktop.png', {
    fullPage: false,
    ux: {
      title: 'desktop open resting order',
      group: 'Swap',
      description: 'Exact unfilled obligation in the canonical React wallet.',
      platform: 'desktop',
      tags: ['swap', 'open-order'],
    },
  });
  await cancel.click();
  await expect
    .poll(async () => {
      const account = await readAccount(page, hubId);
      return { offers: account.offers, pending: account.pending, mempool: account.mempool };
    })
    .toEqual({ offers: 0, pending: false, mempool: 0 });
  const canceled = await readAccount(page, hubId);
  const closed = await readOrders(page, hubId);
  expect(closed.items).toHaveLength(1);
  const [closedOrder] = closed.items;
  if (!closedOrder) throw new Error('EDITED_LIMIT_CANCELLATION_MISSING');
  expect(closedOrder.offerId).toBe(order.offerId);
  expect(closedOrder.priceTicks).toBe(editedPrice);
  expect(closedOrder.closed).toBe(true);
  expect(closedOrder.cancelRequested).toBe(true);
  expect(closedOrder.resolves).toHaveLength(1);
  expect(closedOrder.resolves[0]).toMatchObject({ fillRatio: 0, cancelRemainder: true, comment: 'cancel_request' });
  expect(canceled.usdc).toBe(before.usdc);
  expect(canceled.weth).toBe(before.weth);
  expect(canceled.usdcSpendable).toBe(before.usdcSpendable);
  expect(canceled.holds.every(hold => hold.outgoing === '0' && hold.incoming === '0')).toBe(true);
  await expect(cancel).toHaveCount(0);
  await expect(workingBid).toHaveCount(0);
  await info.attach('current-edited-limit', {
    body: safeStringify({
      entityId,
      baseAmount,
      quoteAmount,
      clickedPrice,
      editedPrice,
      before,
      resting,
      history,
      runtimeId,
      recovered,
      recoveredHistory,
      canceled,
      closed,
    }),
    contentType: 'application/json',
  });
}
