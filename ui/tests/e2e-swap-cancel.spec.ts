import { expect, test, type Page } from '@playwright/test';
import { formatUnits, parseUnits } from 'ethers';
import { safeStringify } from '../../core/protocol/serialization';
import { enterStack, reopenStack } from './stack';
import { readAccount, readOrders } from './swap-evidence';

const expectDeliveryDrained = async (page: Page): Promise<void> => {
  await expect.poll(() => page.evaluate(() => {
    const env = (window as Window & { __xln: { env(): import('../../core/api/public/runtime-module').RuntimeReplica } }).__xln.env();
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
  }), { timeout: 15_000 }).toEqual({ network: 0, outputs: 0, inbox: 0, entityInputs: 0, pendingAccounts: 0, accountMempool: 0 });
};

// Recovery must preserve the live obligation, not merely the displayed balance.
// Cancellation must then release that exact hold without executing a trade.
test('mobile resting swap survives reload and cancellation restores exact spendable funds', { tag: '@resilience' }, async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 390, height: 844 });
  const wallet = await enterStack(page);
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
  const requested = quotedWant * 25_000_000n * 11n / (quotedGive * 10n);
  await give.fill('25');
  await want.fill(formatUnits(requested, 18));
  const spectrum = page.getByTestId('receive-spectrum');
  await spectrum.getByRole('button', { name: 'Accept it as credit instead', exact: true }).click();
  await page.getByTestId('receive-spectrum-confirm').click();
  await expect(spectrum).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByTestId('swap-submit')).toBeEnabled();
  const before = await readAccount(page, hubId);
  expect(before.usdc).toBe('100000000');
  expect(before.weth).toBe('0');
  expect(before.offers).toBe(0);
  await page.getByTestId('swap-submit').click();
  await expect.poll(async () => {
    const account = await readAccount(page, hubId);
    return { offers: account.offers, pending: account.pending, mempool: account.mempool };
  }, { timeout: 15_000 }).toEqual({ offers: 1, pending: false, mempool: 0 });
  const resting = await readAccount(page, hubId);
  const history = await readOrders(page, hubId);
  expect(history.items).toHaveLength(1);
  const order = history.items[0]!;
  expect(order.closed).toBe(false);
  expect(order.resolves).toHaveLength(0);
  expect(resting.usdc).toBe(before.usdc);
  expect(resting.weth).toBe(before.weth);
  expect(BigInt(before.usdcSpendable) - BigInt(resting.usdcSpendable)).toBe(order.originalGiveAmount);
  expect(resting.holds.find(hold => hold.tokenId === 1)?.outgoing).toBe(String(order.originalGiveAmount));

  await page.getByTestId('back').click();
  await expect(page.getByTestId('home-total')).toBeVisible();
  await expectDeliveryDrained(page);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await reopenStack(page, wallet);
  expect(await readAccount(page, hubId)).toEqual(resting);
  expect(await readOrders(page, hubId)).toEqual(history);
  await page.getByTestId('home-swap').click();
  const cancel = page.getByRole('button', { name: 'Cancel', exact: true });
  await expect(cancel).toHaveCount(1);
  await cancel.click();
  await expect.poll(async () => {
    const account = await readAccount(page, hubId);
    return { offers: account.offers, pending: account.pending, mempool: account.mempool };
  }, { timeout: 15_000 }).toEqual({ offers: 0, pending: false, mempool: 0 });
  const canceled = await readAccount(page, hubId);
  expect(canceled.usdc).toBe(before.usdc);
  expect(canceled.weth).toBe(before.weth);
  expect(canceled.usdcSpendable).toBe(before.usdcSpendable);
  expect(canceled.wethCredit).toBe(before.wethCredit);
  expect(canceled.holds.every(hold => hold.outgoing === '0' && hold.incoming === '0')).toBe(true);
  const closed = await readOrders(page, hubId);
  expect(closed.items).toHaveLength(1);
  expect(closed.items[0]!.offerId).toBe(order.offerId);
  expect(closed.items[0]!.closed).toBe(true);
  expect(closed.items[0]!.cancelRequested).toBe(true);
  expect(closed.items[0]!.resolves).toHaveLength(1);
  expect(closed.items[0]!.resolves[0]!.fillRatio).toBe(0);
  expect(closed.items[0]!.resolves[0]!.cancelRemainder).toBe(true);
  expect(closed.items[0]!.resolves[0]!.comment).toBe('cancel_request');
  await expect(cancel).toHaveCount(0);
  await page.getByTestId('back').click();
  await expect(page.getByTestId('home-total')).toBeVisible();
  await expectDeliveryDrained(page);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await reopenStack(page, wallet);
  expect(await readAccount(page, hubId)).toEqual(canceled);
  expect(await readOrders(page, hubId)).toEqual(closed);
  await test.info().attach('mobile-resting-swap-cancellation', { body: safeStringify({ before, resting, history, canceled, closed }), contentType: 'application/json' });
});
