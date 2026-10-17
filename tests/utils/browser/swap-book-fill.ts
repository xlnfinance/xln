import { readDeltas, readCollateralPolicy, readCollateralFees } from './swap-account-evidence';
import { rebalanceFeeFor } from '../../../core/account/tx/handlers/rebalance/request-collateral';
import { fundFromHubUi } from '../../../ui/tests/fund-from-hub';
import { expect, type Page, type TestInfo, type Request } from '../../global-setup.mts';
import { parseUnits } from 'ethers';
import { safeStringify } from '../../../core/protocol/serialization';
import { deriveSwapFillPolicyFee } from '../../../core/account/swap/swap-net-authorization';
import { readAccount, readOrders, type DebugWindow } from '../../../ui/tests/swap-evidence';
import { API_BASE_URL } from '../e2e-baseline';

/** One actual book click must bind the ticket, signed fill, balances and both Account owners. */
export async function verifyBookFill(page: Page, info: TestInfo, entityId: string, side: 'ask' | 'bid') {
  await page.getByTestId('home-faucet').click();
  await expect(page.getByTestId('test-money-status')).toHaveText('100 USDC received');
  await page.getByTestId('account-row').first().click();
  const hubId = new URL(page.url()).pathname.split('/accounts/')[1];
  if (!hubId || !/^0x[0-9a-f]{64}$/.test(hubId)) throw new Error('SWAP_HUB_ID_MISSING');
  await page.getByTestId('back').click();
  if (side === 'bid') await fundFromHubUi(page, expect, '1', 'WETH');
  await expect
    .poll(async () => {
      const account = await readAccount(page, hubId);
      return { usdc: account.usdc, weth: account.weth, pending: account.pending, mempool: account.mempool };
    })
    .toEqual({ usdc: '100000000', weth: side === 'ask' ? '0' : '1000000000000000000', pending: false, mempool: 0 });
  return executeBookFill(page, info, entityId, hubId, side, side === 'ask' ? 0 : 1);
}

/** The second trade uses the existing Account; no faucet or replacement identity is allowed here. */
export async function executeBookFill(
  page: Page,
  info: TestInfo,
  entityId: string,
  hubId: string,
  side: 'ask' | 'bid',
  expectedCollateralRequests: 0 | 1,
) {
  await page.getByTestId('home-swap').click();
  const book = page.getByTestId('orderbook').locator('visible=true').first();
  await expect(book).toHaveAttribute('data-status', 'live');
  const ask = side === 'ask' ? book.getByTestId('book-row-ask').last() : book.getByTestId('book-row-bid').first();
  await expect(ask).toBeVisible();
  const displayedPrice = await ask.locator('.bk-price').innerText();
  const priceTicks = parseUnits(displayedPrice.replaceAll(',', ''), 4);
  expect(priceTicks).toBeGreaterThan(0n);
  await ask.click();
  const giveTokenId = side === 'ask' ? 1 : 2;
  const wantTokenId = side === 'ask' ? 2 : 1;
  const ticket = {
    giveTokenId,
    wantTokenId,
    give: parseUnits(await page.getByTestId('swap-give').inputValue(), side === 'ask' ? 6 : 18).toString(),
    want: parseUnits(await page.getByTestId('swap-want').inputValue(), side === 'ask' ? 18 : 6).toString(),
  };
  const prepared = await page.evaluate(async amounts => {
    const debug = (window as DebugWindow).__xln;
    if (!debug) throw new Error('SWAP_DIAGNOSTICS_MISSING');
    const xln = await debug.xln();
    const order = xln.prepareSwapOrder(
      amounts.giveTokenId,
      amounts.wantTokenId,
      BigInt(amounts.give),
      BigInt(amounts.want),
    );
    if (!order) throw new Error('SWAP_PREPARATION_FAILED');
    return {
      give: order.effectiveGive.toString(),
      want: order.effectiveWant.toString(),
      priceTicks: order.priceTicks.toString(),
    };
  }, ticket);
  expect(prepared.priceTicks).toBe(String(priceTicks));
  await expect(page.locator('.kv').filter({ hasText: 'Limit price' })).toContainText(displayedPrice);
  const feeText = await page.locator('.kv').filter({ hasText: 'Hub fee' }).innerText();
  const feeMatch = feeText.match(/(\d+) bps/);
  if (!feeMatch?.[1]) throw new Error('SWAP_FEE_POLICY_MISSING');
  const feeBps = Number(feeMatch[1]);
  const before = await readAccount(page, hubId);
  const priorOrders = await readOrders(page, hubId);
  const priorIds = new Set(priorOrders.items.map(order => order.offerId));
  expect(before.offers).toBe(0);
  const collateralPolicy = await readCollateralPolicy(page, entityId, hubId, wantTokenId);
  const submit = page.getByTestId('swap-submit');
  await expect(submit).toBeEnabled();
  const started = Date.now();
  const rpcRequests: Array<{ atMs: number; path: string }> = [];
  const onRequest = (request: Request): void => {
    const path = new URL(request.url()).pathname;
    if (/^\/rpc\d*$/.test(path)) rpcRequests.push({ atMs: Date.now() - started, path });
  };
  page.on('request', onRequest);
  try {
    await expect(page.getByRole('status').filter({ hasText: 'Order placed:' })).toHaveCount(0);
    await submit.click();
    await expect(page.getByRole('status').filter({ hasText: 'Order placed:' })).toHaveCount(1);
    const placedMs = Date.now() - started;
    await expect
      .poll(
        async () => {
          const account = await readAccount(page, hubId);
          return {
            received:
              side === 'ask' ? BigInt(account.weth) > BigInt(before.weth) : BigInt(account.usdc) > BigInt(before.usdc),
            pending: account.pending,
            mempool: account.mempool,
            offers: account.offers,
          };
        },
        { timeout: 15_000 },
      )
      .toEqual({ received: true, pending: false, mempool: 0, offers: 0 });
    const closedMs = Date.now() - started;
    const after = await readAccount(page, hubId);
    const orders = await readOrders(page, hubId);
    expect(orders.items).toHaveLength(priorOrders.items.length + 1);
    expect(orders.items.filter(order => priorIds.has(order.offerId))).toEqual(priorOrders.items);
    const freshOrders = orders.items.filter(order => !priorIds.has(order.offerId));
    expect(freshOrders).toHaveLength(1);
    const [order] = freshOrders;
    if (!order) throw new Error('FILLED_ORDER_MISSING');
    expect(order.closed).toBe(true);
    expect(order.cancelRequested).toBe(false);
    expect(order.priceTicks).toBe(priceTicks);
    expect(order.originalGiveAmount).toBe(BigInt(prepared.give));
    expect(order.originalWantAmount).toBe(BigInt(prepared.want));
    expect(order.resolves).toHaveLength(1);
    const [fill] = order.resolves;
    if (!fill || fill.executionGiveAmount === null || fill.executionWantAmount === null || fill.feeAmount === null)
      throw new Error('SIGNED_FILL_AMOUNTS_MISSING');
    expect(fill.fillRatio).toBe(65535);
    expect(fill.executionGiveAmount).toBe(order.originalGiveAmount);
    expect(fill.executionWantAmount).toBe(order.originalWantAmount);
    const debit = side === 'ask' ? BigInt(before.usdc) - BigInt(after.usdc) : BigInt(before.weth) - BigInt(after.weth);
    const received =
      side === 'ask' ? BigInt(after.weth) - BigInt(before.weth) : BigInt(after.usdc) - BigInt(before.usdc);
    expect(debit).toBe(fill.executionGiveAmount);
    const collateralFees = await readCollateralFees(page, entityId, hubId, before.height, after.height);
    expect(collateralFees).toHaveLength(expectedCollateralRequests);
    for (const fee of collateralFees) {
      if (!collateralPolicy) throw new Error('SIGNED_COLLATERAL_POLICY_MISSING');
      expect(fee.feeTokenId).toBe(wantTokenId);
      expect(fee.tokenId).toBe(wantTokenId);
      expect(fee.policyVersion).toBe(collateralPolicy.policyVersion);
      expect(fee.fee).toBe(rebalanceFeeFor(collateralPolicy, fee.amount));
    }
    const collateralFee = collateralFees.reduce((sum, fee) => sum + fee.fee, 0n);
    expect(received + collateralFee).toBe(fill.executionWantAmount - fill.feeAmount);
    expect(fill.feeTokenId).toBe(wantTokenId);
    expect(fill.feeAmount).toBe(
      deriveSwapFillPolicyFee(
        { giveAmount: order.originalGiveAmount, wantAmount: order.originalWantAmount },
        fill.executionGiveAmount,
        fill.executionWantAmount,
        feeBps,
        fill.cancelRemainder,
      ),
    );
    expect(after.height).toBeGreaterThan(before.height);
    expect(after.holds.every(hold => hold.incoming === '0' && hold.outgoing === '0')).toBe(true);
    const tokens = await readDeltas(page, entityId, hubId);
    await expect(async () => {
      const response = await page.request.get(`${API_BASE_URL}/api/hub/account-status`, {
        params: { hubEntityId: hubId, counterpartyEntityId: entityId, tokenIds: '1,2' },
      });
      expect(response.ok()).toBe(true);
      const body: unknown = await response.json();
      expect(body).toMatchObject({
        success: true,
        hubEntityId: hubId,
        counterpartyEntityId: entityId,
        ready: true,
        currentHeight: after.height,
        mempool: 0,
        pendingFrameHeight: null,
        tokens,
      });
    }).toPass({ timeout: 10_000, intervals: [100, 250, 500] });
    await expect(page.getByTestId('swap-offer-cancel')).toHaveCount(0);
    await page.getByTestId('back').click();
    await page.getByTestId('nav-activity').locator('visible=true').first().click();
    await page.getByRole('button', { name: 'Swaps', exact: true }).click();
    const historyRows = page.getByTestId('swap-history-order');
    await expect(historyRows).toHaveCount(orders.items.length);
    const history = historyRows.filter({ has: page.getByTitle(`${order.offerId} · tap to copy`, { exact: true }) });
    await expect(history).toHaveCount(1);
    await expect(history.locator('summary')).toContainText('Closed');
    await expect(history.locator('summary')).toContainText('1 executions');
    await history.locator('summary').click();
    await expect(history.locator('[data-field="gave"]')).toHaveAttribute(
      'data-amount',
      String(fill.executionGiveAmount),
    );
    await expect(history.locator('[data-field="received"]')).toHaveAttribute(
      'data-amount',
      String(fill.executionWantAmount),
    );
    await expect(history.locator('[data-field="fee"]')).toHaveAttribute('data-amount', String(fill.feeAmount));
    const idleStartMs = Date.now() - started;
    await page.waitForTimeout(6_000);
    const idleEndMs = Date.now() - started;
    await info.attach(`current-book-${side}-fill`, {
      body: safeStringify({
        entityId,
        hubId,
        displayedPrice,
        priceTicks,
        ticket,
        prepared,
        feeBps,
        collateralPolicy,
        collateralFees,
        collateralFee,
        before,
        after,
        orders,
        tokens,
        placedMs,
        closedMs,
        idleStartMs,
        idleEndMs,
        rpcRequests,
      }),
      contentType: 'application/json',
    });
    return {
      hubId,
      before,
      after,
      orders,
      debit,
      received,
      gross: fill.executionWantAmount,
      swapFee: fill.feeAmount,
      collateralFee,
    };
  } finally {
    page.off('request', onRequest);
  }
}
