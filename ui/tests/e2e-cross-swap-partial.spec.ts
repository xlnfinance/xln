/**
 * Cross-network swap that the market only partly fills, then closed by hand.
 *
 * The wallet sells more WETH on Testnet than the hub's best cross bid (a Tron
 * stablecoin) holds. The bid is consumed, the remainder rests in the hub's
 * public book, and "Cancel rest" closes the order: both legs settle at the
 * hub's committed fill, the remainder returns, and no hold or pull is left.
 */
import { expect, test, type Page } from '@playwright/test';
import { formatUnits } from 'ethers';
import type { RuntimeAdapterViewFrame, RuntimeReplica, XLNModule } from '../../core/api/public/runtime-module';
import type { RuntimeAdapter } from '../../core/api/runtime-adapter/types';
import { getSwapLotScaleForDecimals, requantizeRemainingSwapAtPriceForDimensions } from '../../core/swapbook';
import { safeStringify } from '../../core/protocol/serialization';
import { enterStack, readWalletCheckpoint } from './stack';

type DebugWindow = Window & {
  __xln?: { env(): RuntimeReplica | null; adapter(): RuntimeAdapter | null; xln(): Promise<XLNModule> };
};
type AccountDoc = NonNullable<RuntimeAdapterViewFrame['activeEntity']>['accounts']['items'][number];
type Leg = { entityId: string; hubId: string; tokenId: number };
type Level = { price: string; size: string; orderIds: string[] };
type Book = { pairId: string; bids: Level[]; asks: Level[] };

const WETH = 2;
/** Six-decimal Tron stablecoins the hub quotes against Testnet WETH. */
const RECEIVE_TOKENS = [
  { tokenId: 1, symbol: 'USDC' },
  { tokenId: 3, symbol: 'USDT' },
] as const;
const WETH_LOT = getSwapLotScaleForDecimals(18);
const REMAINDER = 2_000_000_000_000_000_000n; // 2 WETH beyond the best bid
const FAUCET_SPARE = 1_000_000_000_000_000_000n; // covers a collateral fee charged in WETH
const PRICE_SCALE = 10_000n;
const MAX_FILL_RATIO = 65_535n;

/** Committed balance, holds and pulls of one leg plus the owner's route view. */
const readLeg = (page: Page, leg: Leg, atHeight?: number) =>
  page.evaluate(
    async ({ entityId, hubId, tokenId, atHeight }) => {
      const debug = (window as DebugWindow).__xln;
      const env = debug?.env();
      const adapter = debug?.adapter();
      if (!debug || !env || !adapter) throw new Error('Wallet diagnostics unavailable');
      const xln = await debug.xln();
      const account = await adapter.read<AccountDoc>(
        `entity/${entityId}/account/${hubId}`,
        atHeight === undefined ? undefined : { atHeight },
      );
      const delta = account.state.deltas.get(tokenId);
      const derived = delta ? xln.deriveDelta(delta, xln.isLeftEntity(entityId, hubId)) : null;
      const core = await adapter.read<NonNullable<RuntimeAdapterViewFrame['activeEntity']>['core']>(
        `entity/${entityId}`,
        atHeight === undefined ? undefined : { atHeight },
      );
      return {
        height: account.currentHeight,
        owned: derived ? String(derived.outCollateral + derived.outPeerCredit - derived.inOwnCredit) : '0',
        inCapacity: derived ? String(derived.inCapacity) : '0',
        holds: derived ? String(derived.outTotalHold + derived.inTotalHold) : '0',
        pending: Boolean(account.pendingFrame),
        mempool: account.mempoolCount,
        pulls: account.state.pulls?.size ?? 0,
        routes: [...(core.crossJurisdictionSwaps?.values() ?? [])].map(route => ({
          orderId: route.orderId,
          status: route.status,
          filledSource: String(route.filledSourceAmount ?? 0n),
          filledTarget: String(route.filledTargetAmount ?? 0n),
        })),
      };
    },
    { ...leg, atHeight },
  );

/** Collateral fees prepaid inside signed Account frames after `fromHeight`. */
const readCollateralFees = (page: Page, leg: Leg, fromHeight: number, toHeight: number) =>
  page.evaluate(
    async ({ entityId, hubId, tokenId, fromHeight, toHeight }) => {
      const debug = (window as DebugWindow).__xln;
      const env = debug?.env();
      if (!debug || !env) throw new Error('Wallet diagnostics unavailable');
      const frames = await (
        await debug.xln()
      ).readPersistedAccountFrameHistory(env, entityId, hubId, toHeight, { maxAccountHeight: toHeight });
      return frames
        .filter(frame => frame.height > fromHeight)
        .flatMap(frame =>
          frame.accountTxs.flatMap(tx =>
            tx.type === 'request_collateral' && (tx.data.feeTokenId ?? tx.data.tokenId) === tokenId
              ? [String(tx.data.feeAmount)]
              : [],
          ),
        )
        .reduce((sum, fee) => sum + BigInt(fee), 0n)
        .toString();
    },
    { ...leg, fromHeight, toHeight },
  );

async function stackIds(page: Page) {
  const hubs = (await (await page.request.get('/api/hubs')).json()) as {
    hubs: { name: string; entityId: string; metadata?: { jurisdiction?: { chainId?: number } } }[];
  };
  const catalog = (await (await page.request.get('/api/jurisdictions')).json()) as {
    jurisdictions: Record<string, { chainId: number; contracts: { depository: string } }>;
  };
  // Each hub serves its own public book; the wallet origin proxies only the primary one.
  const health = (await (await page.request.get('/api/health')).json()) as { hubs: { name: string; apiUrl: string }[] };
  const apiUrl = (name: string) => {
    const found = health.hubs.find(entry => entry.name === name);
    if (!found) throw new Error(`${name} API unavailable`);
    return found.apiUrl;
  };
  const hub = (name: string, chainId: number) => {
    const found = hubs.hubs.find(entry => entry.name === name && entry.metadata?.jurisdiction?.chainId === chainId);
    if (!found) throw new Error(`${name} on chain ${chainId} unavailable`);
    return found.entityId.toLowerCase();
  };
  const depository = (chainId: number) => {
    const found = Object.values(catalog.jurisdictions).find(entry => entry.chainId === chainId);
    if (!found) throw new Error(`Chain ${chainId} unavailable`);
    return found.contracts.depository.toLowerCase();
  };
  const pairId = (tokenId: number) =>
    `cross:stack:31337:${depository(31337)}:${WETH}/stack:31338:${depository(31338)}:${tokenId}`;
  // Each Testnet hub quotes cross routes into its same-named Tron sibling.
  const routes = ['H1', 'H2', 'H3'].map(name => ({
    name,
    apiUrl: apiUrl(name),
    sourceHubId: hub(name, 31337),
    targetHubId: hub(name, 31338),
  }));
  return { routes, pairId };
}

/** The hub's public cross book; observation only, never a trade. */
async function readBook(page: Page, apiUrl: string, hubId: string, pairId: string): Promise<Book> {
  const response = await page.request.get(
    `${apiUrl}/api/market/snapshots?hubEntityId=${hubId}&pair=${encodeURIComponent(pairId)}&depth=10`,
  );
  expect(response.ok()).toBe(true);
  const payload = (await response.json()) as { snapshots: Book[] };
  const book = payload.snapshots.find(snapshot => snapshot.pairId === pairId);
  if (!book) throw new Error(`Hub publishes no book for ${pairId}`);
  return book;
}

/** Receive WETH from the hub over a credit line the wallet grants first. */
async function faucetWeth(page: Page, hubId: string, amount: string, severalHubs: boolean) {
  await page.getByTestId('nav-manage').locator('visible=true').first().click();
  await page.getByTestId('manage-assets').click();
  if (severalHubs) await page.getByTestId('faucet-hub').selectOption(hubId);
  await page.getByTestId('faucets').getByRole('button', { name: 'WETH', exact: true }).click();
  await page.getByTestId('faucet-amount').fill(amount);
  const spectrum = page.getByTestId('receive-spectrum');
  await expect(spectrum).toBeVisible();
  await page.getByRole('button', { name: '0% collateral', exact: true }).click();
  await page.getByTestId('receive-spectrum-confirm').click();
  await expect(spectrum).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByTestId('faucet-offchain')).toBeEnabled();
  await page.getByTestId('faucet-offchain').click();
}

test(
  'partly filled cross-network swap closes manually with exact legs on both chains',
  { tag: '@functional' },
  async ({ page }) => {
    test.setTimeout(120_000);
    const errors: string[] = [];
    const consoleErrors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    const started = Date.now();
    const { routes, pairId } = await stackIds(page);
    // The first hub, then Tron stablecoin, whose book still bids for Testnet WETH.
    const candidates = routes.flatMap(route => RECEIVE_TOKENS.map(receive => ({ ...route, receive })));
    const books = await Promise.all(
      candidates.map(candidate =>
        readBook(page, candidate.apiUrl, candidate.sourceHubId, pairId(candidate.receive.tokenId)),
      ),
    );
    const index = books.findIndex(book => book.bids.length > 0);
    const chosen = candidates[index];
    const bid = books[index]?.bids[0];
    if (!chosen || !bid) throw new Error(`No live WETH cross bid on any hub: ${safeStringify(books)}`);
    const { name: hubName, apiUrl, sourceHubId, targetHubId, receive } = chosen;
    const bidPrice = BigInt(bid.price);
    const bidWeth = BigInt(bid.size) * WETH_LOT;
    const take = requantizeRemainingSwapAtPriceForDimensions(WETH, receive.tokenId, bidWeth + REMAINDER, bidPrice, {
      giveTokenDecimals: 18,
      wantTokenDecimals: 6,
    });
    if (!take) throw new Error('Order cannot execute at the best bid');
    expect(take.effectiveGive).toBe(bidWeth + REMAINDER);
    // The book executes exactly the bid; both legs then settle at the uint16
    // ladder ratio: the smallest r with floor(want * r / 65535) >= executed
    // target, each leg claiming floor(total * r / 65535). The hub absorbs the step.
    const executedTarget = (bidWeth * bidPrice * 10n ** 6n) / (PRICE_SCALE * 10n ** 18n);
    let ratio = (executedTarget * MAX_FILL_RATIO + take.effectiveWant - 1n) / take.effectiveWant;
    while (ratio > 0n && (take.effectiveWant * (ratio - 1n)) / MAX_FILL_RATIO >= executedTarget) ratio -= 1n;
    const expectedFilledSource = (take.effectiveGive * ratio) / MAX_FILL_RATIO;
    const expectedFilledTarget = (take.effectiveWant * ratio) / MAX_FILL_RATIO;
    console.log(
      'CROSS_PARTIAL_BOOK',
      safeStringify({ hubName, receive, bid, bidWeth, take, ratio, expectedFilledSource, expectedFilledTarget }),
    );

    const wallet = await enterStack(page);
    const source: Leg = { entityId: wallet.entityId, hubId: sourceHubId, tokenId: WETH };
    const opened = (await readWalletCheckpoint(page)).accounts.some(account =>
      [account.leftEntity, account.rightEntity].includes(sourceHubId),
    );
    if (!opened) {
      await page.getByRole('button', { name: 'Connect another account', exact: true }).click();
      const sheet = page.getByRole('dialog', { name: 'Open account', exact: true });
      await sheet.getByPlaceholder('or paste an entity id, 0x…').fill(sourceHubId);
      await sheet.getByRole('button', { name: 'Propose account', exact: true }).click();
      await expect(page.getByTestId('account-row')).toHaveCount(2, { timeout: 20_000 });
    }
    await faucetWeth(page, sourceHubId, formatUnits(take.effectiveGive + FAUCET_SPARE, 18), !opened);
    await expect
      .poll(async () => BigInt((await readLeg(page, source)).owned) >= take.effectiveGive, { timeout: 20_000 })
      .toBe(true);

    await page.getByTestId('nav-home').locator('visible=true').first().click();
    await page.getByTestId('home-swap').click();
    if (!opened) await page.locator('.chips').getByRole('button', { name: hubName, exact: true }).click();
    await page.getByRole('button', { name: 'Across networks', exact: true }).click();
    await page.getByTestId('swap-flip').click();
    const givePicker = page.getByTestId('swap-give').locator('..').getByRole('button').first();
    const wantPicker = page.getByTestId('swap-want').locator('..').getByRole('button').first();
    await expect(givePicker).toContainText('WETH');
    if (!(await wantPicker.innerText()).includes(receive.symbol)) {
      await wantPicker.click();
      await page.getByRole('option', { name: new RegExp(`^${receive.symbol}`) }).click();
    }
    await expect(wantPicker).toContainText(receive.symbol);
    const targetEntityId = await page
      .locator('.kv')
      .filter({ hasText: 'Your other account' })
      .locator('select')
      .inputValue();
    expect(targetEntityId).not.toBe(wallet.entityId);
    await page.locator('.kv').filter({ hasText: 'Hub there' }).locator('select').selectOption(targetHubId);
    await page.getByTestId('swap-give').fill(formatUnits(take.effectiveGive, 18));
    await page.getByTestId('swap-want').fill(formatUnits(take.effectiveWant, 6));
    const target: Leg = { entityId: targetEntityId, hubId: targetHubId, tokenId: receive.tokenId };
    // The current Swap command opens/prepares the target after explicit submit;
    // merely filling the ticket must not grant credit or create an Account.
    const targetExists = await page.evaluate(({ entityId, hubId }) => {
      const env = (window as DebugWindow).__xln?.env();
      const replica = env && [...env.state.eReplicas.values()].find(entry => entry.entityId === entityId);
      if (!replica) throw new Error(`Target owner missing: ${entityId}`);
      return replica.state.accounts.has(hubId);
    }, target);
    expect(targetExists).toBe(false);
    await expect(
      page.getByText(`Placing this order also prepares incoming capacity with ${hubName}.`, { exact: false }),
    ).toBeVisible();
    await expect(page.getByTestId('swap-submit')).toBeEnabled();
    const sourceBefore = await readLeg(page, source);
    expect(sourceBefore.routes).toEqual([]);
    console.log('CROSS_PARTIAL_READY_MS', Date.now() - started);
    await page.getByTestId('swap-submit').click();

    const row = page.getByTestId('cross-order-row');
    await expect(row).toHaveCount(1, { timeout: 20_000 });
    const orderId = await row.getAttribute('data-order-id');
    if (!orderId) throw new Error('Cross order row has no order id');
    // Inspect the actual persisted target just before the paired intent. Live
    // balances may already be locked; they are not a preparation oracle.
    const preparedHeight = await page.evaluate(
      async ({ orderId, targetId, sourceId }) => {
        const debug = (window as DebugWindow).__xln;
        const env = debug?.env();
        if (!debug || !env) throw new Error('Wallet recovery diagnostics unavailable');
        const xln = await debug.xln();
        const latest = await xln.getPersistedLatestHeight(env);
        for (let height = 1; height <= latest; height++) {
          const frame = await xln.readPersistedStorageFrameRecord(env, height);
          if (!frame?.frameHash) throw new Error(`Accepted WAL frame missing: ${height}`);
          const owners = frame.runtimeInput.entityInputs.flatMap(input =>
            (input.entityTxs ?? []).flatMap(tx =>
              tx.type === 'prepareCrossJurisdictionSwap' && tx.data.route.orderId === orderId ? [input.entityId] : [],
            ),
          );
          if (owners.length === 0) continue;
          if (height < 2 || owners.length !== 2 || owners[0] !== targetId || owners[1] !== sourceId)
            throw new Error(`Paired intent order invalid: ${height}:${owners.join(',')}`);
          return height - 1;
        }
        throw new Error(`Accepted cross intent missing: ${orderId}`);
      },
      { orderId, targetId: target.entityId, sourceId: source.entityId },
    );
    const targetBefore = await readLeg(page, target, preparedHeight);
    expect(targetBefore.owned).toBe('0');
    expect(targetBefore.inCapacity).toBe(take.effectiveWant.toString());
    expect(targetBefore.holds).toBe('0');
    expect(targetBefore.routes).toEqual([]);
    // The hub consumed the whole bid; the wallet's remainder rests in its book.
    let remainderLots = 0n;
    await expect
      .poll(
        async () => {
          const book = await readBook(page, apiUrl, sourceHubId, pairId(receive.tokenId));
          const own = book.asks.find(level => level.orderIds.some(id => id.endsWith(`:${orderId}`)));
          remainderLots = BigInt(own?.size ?? '0');
          return {
            bidConsumed: !book.bids.some(level => level.orderIds.some(id => bid.orderIds.includes(id))),
            resting: remainderLots > 0n,
          };
        },
        { timeout: 30_000 },
      )
      .toEqual({ bidConsumed: true, resting: true });
    expect(remainderLots * WETH_LOT).toBeLessThanOrEqual(REMAINDER);
    console.log('CROSS_PARTIAL_MATCHED_MS', Date.now() - started, remainderLots);
    // Fill progress stays hub-internal until the close: the wallet still holds
    // the whole order on both legs.
    expect(BigInt((await readLeg(page, source)).holds)).toBe(take.effectiveGive);

    // Cancel the rest: the hub closes the order at its committed fill.
    await row.getByTestId('cross-order-cancel-clear').click();
    await expect
      .poll(
        async () => {
          const [s, t] = await Promise.all([readLeg(page, source), readLeg(page, target)]);
          return [s, t].map(leg => ({
            status: leg.routes.find(entry => entry.orderId === orderId)?.status,
            holds: leg.holds,
            pulls: leg.pulls,
            pending: leg.pending,
            mempool: leg.mempool,
          }));
        },
        { timeout: 45_000 },
      )
      .toEqual([
        { status: 'settled', holds: '0', pulls: 0, pending: false, mempool: 0 },
        { status: 'settled', holds: '0', pulls: 0, pending: false, mempool: 0 },
      ]);
    await expect(page.getByTestId('cross-order-row')).toHaveCount(0);
    const book = await readBook(page, apiUrl, sourceHubId, pairId(receive.tokenId));
    expect(book.asks.some(level => level.orderIds.some(id => id.endsWith(`:${orderId}`)))).toBe(false);

    const [sourceAfter, targetAfter] = await Promise.all([readLeg(page, source), readLeg(page, target)]);
    const settled = sourceAfter.routes.find(entry => entry.orderId === orderId);
    expect(settled).toEqual({
      orderId,
      status: 'settled',
      filledSource: expectedFilledSource.toString(),
      filledTarget: expectedFilledTarget.toString(),
    });
    expect(targetAfter.routes.find(entry => entry.orderId === orderId)).toEqual(settled);
    const [sourceFees, targetFees] = await Promise.all([
      readCollateralFees(page, source, sourceBefore.height, sourceAfter.height),
      readCollateralFees(page, target, targetBefore.height, targetAfter.height),
    ]);
    // Only the filled part leaves; the unfilled remainder returns to the wallet.
    expect(BigInt(sourceBefore.owned) - BigInt(sourceAfter.owned)).toBe(expectedFilledSource + BigInt(sourceFees));
    expect(BigInt(targetAfter.owned) + BigInt(targetFees)).toBe(expectedFilledTarget);
    expect(errors).toEqual([]);
    expect(consoleErrors).toEqual([]);
    console.log(
      'CROSS_PARTIAL_CLEARED',
      Date.now() - started,
      safeStringify({
        route: settled,
        remainderLots,
        sourceBefore,
        sourceAfter,
        targetBefore,
        targetAfter,
        sourceFees,
        targetFees,
        errors,
        consoleErrors,
      }),
    );
  },
);
