import type { Page, TestInfo, expect as PlaywrightExpect } from '@playwright/test';
type Expect = typeof PlaywrightExpect;
import { formatUnits, parseUnits } from 'ethers';
import { safeStringify } from '../../core/protocol/serialization';
import { readAccount, readOrders, type DebugWindow } from './swap-evidence';

const expectDeliveryDrained = async (page: Page, expect: Expect): Promise<void> => {
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const debug = (
            window as Window & {
              __xln?: { env(): import('../../core/api/public/runtime-module').RuntimeReplica | null };
            }
          ).__xln;
          const env = debug?.env();
          if (!env) throw new Error('SWAP_RUNTIME_UNAVAILABLE');
          const entities = [...env.state.eReplicas.values()];
          const accounts = entities.flatMap(entity => [...entity.state.accounts.values()]);
          return {
            network: env.pendingNetworkOutputs?.length ?? 0,
            outputs: env.pendingOutputs?.length ?? 0,
            inbox: env.networkInbox?.length ?? 0,
            entityInputs: env.runtimeMempool.entityInputs.length,
            pendingAccounts: accounts.filter(account => account.pendingFrame || account.pendingAccountInput).length,
            accountMempool: accounts.reduce((count, account) => count + account.mempool.length, 0),
          };
        }),
      { timeout: 15_000 },
    )
    .toEqual({ network: 0, outputs: 0, inbox: 0, entityInputs: 0, pendingAccounts: 0, accountMempool: 0 });
};

// Recovery must preserve the live obligation, not merely the displayed balance.
// Cancellation must then release that exact hold without executing a trade.
export async function verifyRestingSwapCancellation(
  page: Page,
  info: TestInfo,
  expect: Expect,
  enter: () => Promise<() => Promise<void>>,
): Promise<void> {
  await page.setViewportSize({ width: 390, height: 844 });
  const reopen = await enter();
  await page.getByTestId('home-faucet').click();
  await expect(page.getByTestId('test-money-status')).toHaveText('100 USDC received');
  await page.getByTestId('account-row').first().click();
  const hubId = new URL(page.url()).pathname.split('/accounts/')[1];
  if (!hubId || !/^0x[0-9a-f]{64}$/.test(hubId)) throw new Error('Expected fresh wallet hub Account');
  await page.getByTestId('back').click();
  await page.getByTestId('home-swap').click();
  const book = page.getByTestId('orderbook').locator('visible=true').first();
  await expect(book).toHaveAttribute('data-status', 'live', { timeout: 15_000 });
  await book.locator('.bk-row.ask').last().click();
  const give = page.getByTestId('swap-give');
  const want = page.getByTestId('swap-want');
  const quotedGive = parseUnits(await give.inputValue(), 6);
  const quotedWant = parseUnits(await want.inputValue(), 18);
  expect(quotedGive).toBeGreaterThan(0n);
  expect(quotedWant).toBeGreaterThan(0n);
  // Request 10% more base than the best ask offers: the buy limit rests below it.
  const requested = (quotedWant * 25_000_000n * 11n) / (quotedGive * 10n);
  await give.fill('25');
  await want.fill(formatUnits(requested, 18));
  await expect(page.getByText(/Placing this order also prepares incoming capacity/)).toBeVisible();
  await expect(page.getByTestId('swap-submit')).toBeEnabled();
  const ticket = {
    give: parseUnits(await give.inputValue(), 6).toString(),
    want: parseUnits(await want.inputValue(), 18).toString(),
  };
  const prepared = await page.evaluate(async amounts => {
    const debug = (window as DebugWindow).__xln;
    if (!debug) throw new Error('SWAP_DIAGNOSTICS_UNAVAILABLE');
    const xln = await debug.xln();
    const order = xln.prepareSwapOrder(1, 2, BigInt(amounts.give), BigInt(amounts.want));
    if (!order) throw new Error('SWAP_ORDER_NORMALIZATION_FAILED');
    return { give: order.effectiveGive.toString(), want: order.effectiveWant.toString() };
  }, ticket);
  expect(BigInt(prepared.give)).toBeGreaterThan(0n);
  expect(BigInt(prepared.give)).toBeLessThanOrEqual(parseUnits('25', 6));
  const before = await readAccount(page, hubId);
  expect(before.usdc).toBe('100000000');
  expect(before.weth).toBe('0');
  expect(before.offers).toBe(0);
  expect(before.wethCredit).toBe('0');
  await page.getByTestId('swap-submit').click();
  await expect
    .poll(
      async () => {
        const account = await readAccount(page, hubId);
        return { offers: account.offers, pending: account.pending, mempool: account.mempool };
      },
      { timeout: 15_000 },
    )
    .toEqual({ offers: 1, pending: false, mempool: 0 });
  const resting = await readAccount(page, hubId);
  const history = await readOrders(page, hubId);
  expect(history.items).toHaveLength(1);
  const [order] = history.items;
  if (!order) throw new Error('RESTING_ORDER_HISTORY_MISSING');
  expect(order.closed).toBe(false);
  expect(String(order.originalGiveAmount)).toBe(prepared.give);
  expect(String(order.originalWantAmount)).toBe(prepared.want);
  expect(order.resolves).toHaveLength(0);
  expect(resting.usdc).toBe(before.usdc);
  expect(resting.weth).toBe(before.weth);
  expect(resting.wethCredit).toBe(String(order.originalWantAmount));
  expect(BigInt(before.usdcSpendable) - BigInt(resting.usdcSpendable)).toBe(order.originalGiveAmount);
  expect(resting.holds.find(hold => hold.tokenId === 1)?.outgoing).toBe(String(order.originalGiveAmount));

  await page.getByTestId('back').click();
  await expect(page.getByTestId('home-total')).toBeVisible();
  await expectDeliveryDrained(page, expect);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await reopen();
  expect(await readAccount(page, hubId)).toEqual(resting);
  expect(await readOrders(page, hubId)).toEqual(history);
  await page.getByTestId('home-swap').click();
  const cancel = page.getByRole('button', { name: 'Cancel', exact: true });
  await expect(cancel).toHaveCount(1);
  await cancel.click();
  await expect
    .poll(
      async () => {
        const account = await readAccount(page, hubId);
        return { offers: account.offers, pending: account.pending, mempool: account.mempool };
      },
      { timeout: 15_000 },
    )
    .toEqual({ offers: 0, pending: false, mempool: 0 });
  const canceled = await readAccount(page, hubId);
  expect(canceled.usdc).toBe(before.usdc);
  expect(canceled.weth).toBe(before.weth);
  expect(canceled.usdcSpendable).toBe(before.usdcSpendable);
  expect(canceled.wethCredit).toBe(resting.wethCredit);
  expect(canceled.holds.every(hold => hold.outgoing === '0' && hold.incoming === '0')).toBe(true);
  const closed = await readOrders(page, hubId);
  expect(closed.items).toHaveLength(1);
  const [closedOrder] = closed.items;
  if (!closedOrder) throw new Error('CANCELED_ORDER_HISTORY_MISSING');
  expect(closedOrder.offerId).toBe(order.offerId);
  expect(closedOrder.closed).toBe(true);
  expect(closedOrder.cancelRequested).toBe(true);
  expect(closedOrder.resolves).toHaveLength(1);
  const [cancelResolution] = closedOrder.resolves;
  if (!cancelResolution) throw new Error('CANCEL_RESOLUTION_MISSING');
  expect(cancelResolution.fillRatio).toBe(0);
  expect(cancelResolution.cancelRemainder).toBe(true);
  expect(cancelResolution.comment).toBe('cancel_request');
  await expect(cancel).toHaveCount(0);
  await page.getByTestId('back').click();
  await expectCancellationHistory(page, hubId, expect);
  await page.getByTestId('nav-home').locator('visible=true').first().click();
  await expect(page.getByTestId('home-total')).toBeVisible();
  await expectDeliveryDrained(page, expect);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await reopen();
  expect(await readAccount(page, hubId)).toEqual(canceled);
  expect(await readOrders(page, hubId)).toEqual(closed);
  await expectCancellationHistory(page, hubId, expect);
  await page.getByTestId('nav-home').locator('visible=true').first().click();
  await page.getByTestId('home-swap').click();
  await expect(page.getByTestId('swap-offer-cancel')).toHaveCount(0);
  await info.attach('mobile-resting-swap-cancellation', {
    body: safeStringify({ ticket, prepared, before, resting, history, canceled, closed }),
    contentType: 'application/json',
  });
}

async function expectCancellationHistory(page: Page, hubId: string, expect: Expect): Promise<void> {
  await page.getByTestId('nav-activity').locator('visible=true').first().click();
  await page.getByRole('button', { name: 'Swaps', exact: true }).click();
  const history = page.getByRole('region', { name: 'Swap history', exact: true });
  await history.getByRole('combobox').selectOption(hubId);
  const order = history.getByTestId('swap-history-order');
  await expect(order).toHaveCount(1);
  await expect(order.locator('summary')).toContainText('Closed');
  await order.locator('summary').click();
  await expect(order).toContainText('Remainder cancelled');
}
