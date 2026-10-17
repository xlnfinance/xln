import { expect, type Page, type TestInfo, type Request } from '../../global-setup.mts';
import { parseUnits } from 'ethers';
import type { RuntimeAdapterViewFrame } from '../../../core/api/public/runtime-module';
import { safeStringify } from '../../../core/protocol/serialization';
import { deriveSwapFillPolicyFee } from '../../../core/account/swap/swap-net-authorization';
import { readAccount, readOrders, type DebugWindow } from '../../../ui/tests/swap-evidence';
import { API_BASE_URL } from '../e2e-baseline';

type Account = NonNullable<RuntimeAdapterViewFrame['activeEntity']>['accounts']['items'][number];
const readDeltas = (page: Page, entityId: string, hubId: string) =>
  page.evaluate(
    async ids => {
      const adapter = (window as DebugWindow).__xln?.adapter();
      if (!adapter) throw new Error('SWAP_ADAPTER_MISSING');
      const account = await adapter.read<Account>(`entity/${ids.entityId}/account/${ids.hubId}`);
      return [1, 2].map(tokenId => {
        const delta = account.state.deltas.get(tokenId);
        if (!delta) throw new Error(`SWAP_DELTA_MISSING:${tokenId}`);
        return {
          tokenId,
          hasDelta: true,
          delta: {
            collateral: String(delta.collateral),
            ondelta: String(delta.ondelta),
            offdelta: String(delta.offdelta),
            leftCreditLimit: String(delta.leftCreditLimit),
            rightCreditLimit: String(delta.rightCreditLimit),
            leftHold: String(delta.leftHold),
            rightHold: String(delta.rightHold),
          },
        };
      });
    },
    { entityId, hubId },
  );

/** One actual book click must bind the ticket, signed fill, balances and both Account owners. */
export async function verifyBookAskFill(page: Page, info: TestInfo, entityId: string): Promise<void> {
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
  const displayedPrice = await ask.locator('.bk-price').innerText();
  const priceTicks = parseUnits(displayedPrice.replaceAll(',', ''), 4);
  expect(priceTicks).toBeGreaterThan(0n);
  await ask.click();
  const ticket = {
    give: parseUnits(await page.getByTestId('swap-give').inputValue(), 6).toString(),
    want: parseUnits(await page.getByTestId('swap-want').inputValue(), 18).toString(),
  };
  const prepared = await page.evaluate(async amounts => {
    const debug = (window as DebugWindow).__xln;
    if (!debug) throw new Error('SWAP_DIAGNOSTICS_MISSING');
    const xln = await debug.xln();
    const order = xln.prepareSwapOrder(1, 2, BigInt(amounts.give), BigInt(amounts.want));
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
  expect(before.usdc).toBe('100000000');
  expect(before.weth).toBe('0');
  expect(before.offers).toBe(0);
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
    await submit.click();
    await expect(page.getByRole('status').filter({ hasText: 'Order placed:' })).toHaveCount(1);
    const placedMs = Date.now() - started;
    await expect
      .poll(
        async () => {
          const account = await readAccount(page, hubId);
          return {
            received: BigInt(account.weth) > 0n,
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
    expect(orders.items).toHaveLength(1);
    const [order] = orders.items;
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
    expect(BigInt(before.usdc) - BigInt(after.usdc)).toBe(fill.executionGiveAmount);
    expect(BigInt(after.weth) - BigInt(before.weth)).toBe(fill.executionWantAmount - fill.feeAmount);
    expect(fill.feeTokenId).toBe(2);
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
    const history = page.getByTestId('swap-history-order');
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
    await info.attach('current-book-ask-fill', {
      body: safeStringify({
        entityId,
        hubId,
        displayedPrice,
        priceTicks,
        ticket,
        prepared,
        feeBps,
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
  } finally {
    page.off('request', onRequest);
  }
}
