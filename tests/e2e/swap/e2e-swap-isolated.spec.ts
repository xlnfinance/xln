import { parseUnits, formatUnits } from 'ethers';
import type { RuntimeReplica, XLNModule } from '../../../core/api/public/runtime-module';
/**
 * E2E: Alice and Bob run in separate browser contexts, connect to the same hub, and trade
 * directly against each other through the hub orderbook with market maker liquidity disabled.
 *
 * Flow and goals:
 * 1. Start on a fresh isolated shard without market maker liquidity so only user orders can match.
 * 2. Open two isolated wallet pages with separate IndexedDB/localStorage state.
 * 3. Create Alice and Bob runtimes, connect both to the same hub, and fund Alice with WETH and Bob with USDC.
 * 4. Alice places a visible WETH/USDC sell order through the swap UI.
 * 5. Bob opens the same swap UI, enters the matching buy order manually, and confirms it.
 * 6. The test proves machine truth from saved account state: both sides record swap resolves and capacities move.
 * 7. The test also proves user-visible truth: Alice's open order appears, gets filled, and stays resolved after reload.
 */

import { test, expect, type BrowserContext, type Page } from '../../global-setup.mts';
import { createWalletIdentity, LOCAL_PASSWORD } from '../../../ui/tests/wallet-ui';
import { ensureE2EBaseline, type E2EHealthResponse } from '../../utils/e2e-baseline';
import { connectRuntimeToHubWithCredit } from '../../utils/e2e-connect';
import { gotoApp, selectDemoMnemonic } from '../../utils/e2e-demo-users';
import { requireIsolatedBaseUrl } from '../../utils/runtime/e2e-isolated-env';
import { timedStep } from '../../utils/e2e-timing.mts';

const INIT_TIMEOUT = 30_000;
const APP_BASE_URL = requireIsolatedBaseUrl('E2E_BASE_URL');
const API_BASE_URL = requireIsolatedBaseUrl('E2E_API_BASE_URL');
const SWAP_CONNECT_TOKEN_IDS = [1, 2] as const;
const SWAP_TOKEN_METADATA = {
  1: { symbol: 'USDC', decimals: 6 },
  2: { symbol: 'WETH', decimals: 18 },
} as const;
type SwapTokenId = keyof typeof SWAP_TOKEN_METADATA;

const wholeSwapTokenUnits = (tokenId: SwapTokenId, amount: bigint): bigint =>
  amount * 10n ** BigInt(SWAP_TOKEN_METADATA[tokenId].decimals);

const SWAP_TOKEN_BY_SYMBOL: Record<string, string> = {
  USDC: '1',
  WETH: '2',
  USDT: '3',
};

type SwapRuntimeWindow = Window & {
  __xln?: { env(): RuntimeReplica | null; xln(): Promise<XLNModule> };
};

type SwapResolveSnapshot = {
  offerId: string;
  fillRatio: number;
  fillNumerator: string;
  fillDenominator: string;
  cancelRemainder: boolean;
  executionGiveAmount: string | null;
  executionWantAmount: string | null;
  feeTokenId: number | null;
  feeAmount: string | null;
  comment: string;
};

function mirrorConsole(page: Page, tag: string): void {
  page.on('console', msg => {
    const text = msg.text();
    if (
      msg.type() === 'error' ||
      text.includes('[E2E]') ||
      text.includes('swap') ||
      text.includes('Swap') ||
      text.includes('Frame consensus')
    ) {
      console.log(`[${tag}] ${text.slice(0, 260)}`);
    }
  });
}

function getPrimaryHubId(health: E2EHealthResponse): string {
  const hubId = health?.hubMesh?.hubIds?.[0];
  expect(typeof hubId === 'string' && hubId.length === 66, 'baseline must expose a primary hub id').toBe(true);
  return hubId!;
}

async function faucetOffchain(
  page: Page,
  entityId: string,
  hubEntityId: string,
  tokenId: number,
  amount: string,
): Promise<void> {
  const runtimeId = await page.evaluate(() => (window as SwapRuntimeWindow).__xln?.env()?.runtimeId);
  if (!runtimeId) throw new Error('SWAP_RUNTIME_UNAVAILABLE');
  const response = await page.request.post(`${API_BASE_URL}/api/faucet/offchain`, {
    data: { userEntityId: entityId, userRuntimeId: runtimeId, hubEntityId, tokenId, amount },
  });
  expect(response.ok(), `SWAP_FAUCET_FAILED:${await response.text()}`).toBe(true);
}

async function outCap(page: Page, entityId: string, counterpartyId: string, tokenId: number): Promise<bigint> {
  return BigInt(
    await page.evaluate(
      async ({ entityId, counterpartyId, tokenId }) => {
        const debug = (window as SwapRuntimeWindow).__xln;
        const env = debug?.env();
        if (!debug || !env) throw new Error('SWAP_RUNTIME_UNAVAILABLE');
        const replicas = [...env.state.eReplicas.values()].filter(replica => replica.entityId === entityId);
        const [replica] = replicas;
        if (replicas.length !== 1 || !replica) throw new Error('SWAP_ENTITY_NOT_UNIQUE');
        const delta = replica.state.accounts.get(counterpartyId)?.state.deltas.get(tokenId);
        if (!delta) throw new Error(`SWAP_DELTA_UNAVAILABLE:${counterpartyId}:${tokenId}`);
        const xln = await debug.xln();
        return xln.deriveDelta(delta, entityId.toLowerCase() < counterpartyId.toLowerCase()).outCapacity.toString();
      },
      { entityId, counterpartyId, tokenId },
    ),
  );
}

async function holdTotal(page: Page, entityId: string, counterpartyId: string, tokenId: number): Promise<bigint> {
  return BigInt(
    await page.evaluate(
      ({ entityId, counterpartyId, tokenId }) => {
        const env = (window as SwapRuntimeWindow).__xln?.env();
        if (!env) throw new Error('SWAP_RUNTIME_UNAVAILABLE');
        const replicas = [...env.state.eReplicas.values()].filter(replica => replica.entityId === entityId);
        const [replica] = replicas;
        if (replicas.length !== 1 || !replica) throw new Error('SWAP_ENTITY_NOT_UNIQUE');
        const delta = replica.state.accounts.get(counterpartyId)?.state.deltas.get(tokenId);
        if (!delta) throw new Error(`SWAP_DELTA_UNAVAILABLE:${counterpartyId}:${tokenId}`);
        return (delta.leftHold + delta.rightHold).toString();
      },
      { entityId, counterpartyId, tokenId },
    ),
  );
}

async function extendCreditToken(
  page: Page,
  hubId: string,
  tokenId: SwapTokenId,
  amountDisplay: string,
): Promise<void> {
  await page.getByTestId('nav-home').locator('visible=true').first().click();
  await page.getByTestId('home-receive').click();
  await page.getByTestId('receive-amount').locator('..').getByRole('button').click();
  await page.getByRole('option', { name: new RegExp(`^${SWAP_TOKEN_METADATA[tokenId].symbol}\\b`) }).click();
  await page.getByTestId('nav-home').locator('visible=true').first().click();
  await page.locator(`[data-testid="account-row"][data-counterparty-id="${hubId}"]`).click();
  await page.getByTestId('account-extend-credit').click();
  const dialog = page.getByRole('dialog', { name: 'Extend credit', exact: true });
  await expect(dialog).toContainText(SWAP_TOKEN_METADATA[tokenId].symbol);
  await dialog.getByPlaceholder('0.00', { exact: true }).fill(amountDisplay);
  await dialog.getByRole('button', { name: 'Extend credit', exact: true }).click();
  await expect(dialog).toBeHidden();
}

async function waitForTokenDeltaActive(
  page: Page,
  entityId: string,
  counterpartyId: string,
  tokenId: number,
  timeoutMs = 30_000,
): Promise<void> {
  await expect
    .poll(
      async () => {
        return await page.evaluate(
          ({ counterpartyId, entityId, tokenId }) => {
            const view = window as SwapRuntimeWindow;
            const env = view.__xln?.env();
            if (!env) throw new Error('SWAP_RUNTIME_UNAVAILABLE');
            for (const [replicaKey, replica] of env.state.eReplicas.entries()) {
              if (!String(replicaKey).startsWith(`${entityId}:`)) continue;
              const account = replica.state?.accounts?.get(counterpartyId);
              const hasDelta = !!account?.state?.deltas?.has(tokenId);
              return hasDelta && Number(account?.currentHeight || 0) > 0;
            }
            return false;
          },
          { counterpartyId, entityId, tokenId },
        );
      },
      {
        timeout: timeoutMs,
        intervals: [250, 500, 750],
        message: `token ${tokenId} must become active on the bilateral account`,
      },
    )
    .toBe(true);
}

async function waitForOutCapAtLeast(
  page: Page,
  entityId: string,
  counterpartyId: string,
  tokenId: number,
  minimum: bigint,
  timeoutMs = 30_000,
): Promise<bigint> {
  const startedAt = Date.now();
  let latest = 0n;
  while (Date.now() - startedAt < timeoutMs) {
    latest = await outCap(page, entityId, counterpartyId, tokenId);
    if (latest >= minimum) return latest;
    await page.waitForTimeout(400);
  }
  throw new Error(
    `Timed out waiting for outCap token=${tokenId} ${entityId.slice(0, 10)}↔${counterpartyId.slice(0, 10)} ` +
      `(latest=${latest.toString()} minimum=${minimum.toString()})`,
  );
}

async function waitForOutCapChange(
  page: Page,
  entityId: string,
  counterpartyId: string,
  tokenId: number,
  baseline: bigint,
  direction: 'up' | 'down',
  timeoutMs = 30_000,
): Promise<bigint> {
  const startedAt = Date.now();
  let latest = baseline;
  while (Date.now() - startedAt < timeoutMs) {
    latest = await outCap(page, entityId, counterpartyId, tokenId);
    if ((direction === 'up' && latest > baseline) || (direction === 'down' && latest < baseline)) {
      return latest;
    }
    await page.waitForTimeout(400);
  }
  throw new Error(
    `Timed out waiting for outCap ${direction} token=${tokenId} ${entityId.slice(0, 10)}↔${counterpartyId.slice(0, 10)} ` +
      `(baseline=${baseline.toString()} latest=${latest.toString()})`,
  );
}

async function readSwapResolveCount(page: Page, entityId: string, counterpartyId: string): Promise<number> {
  return (await readSwapResolveSnapshots(page, entityId, counterpartyId)).length;
}

async function waitForSwapResolveCountAtLeast(
  page: Page,
  entityId: string,
  counterpartyId: string,
  minimum: number,
  timeoutMs = 30_000,
): Promise<number> {
  await expect
    .poll(async () => await readSwapResolveCount(page, entityId, counterpartyId), {
      timeout: timeoutMs,
      intervals: [250, 500, 750],
      message: `swap_resolve count must reach ${minimum}`,
    })
    .toBeGreaterThanOrEqual(minimum);
  return await readSwapResolveCount(page, entityId, counterpartyId);
}

async function openSwapWorkspace(page: Page): Promise<void> {
  await page.getByTestId('nav-home').locator('visible=true').first().click();
  await page.getByTestId('home-swap').click();
  await expect(page.getByTestId('swap-give')).toBeVisible();
}

async function unlockSavedWalletAfterReload(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByLabel('Password', { exact: true }).fill(LOCAL_PASSWORD);
  await page.getByRole('button', { name: 'Unlock', exact: true }).click();
  await expect(page.getByTestId('nav-home').locator('visible=true').first()).toBeVisible();
}

async function selectCounterpartyInSwap(page: Page, preferredAccountId?: string): Promise<void> {
  if (preferredAccountId) {
    await page.getByTestId('nav-home').locator('visible=true').first().click();
    await page.locator(`[data-testid="account-row"][data-counterparty-id="${preferredAccountId}"]`).click();
    await page.getByRole('button', { name: 'Swap', exact: true }).click();
    expect(new URL(page.url()).searchParams.get('hub')).toBe(preferredAccountId);
  }
  await expect(page.getByTestId('swap-give')).toBeVisible();
}

async function configurePair(page: Page, pairLabel: string, side: 'buy' | 'sell'): Promise<void> {
  const [base, quote] = pairLabel.split('/');
  if (!base || !quote || !SWAP_TOKEN_BY_SYMBOL[base] || !SWAP_TOKEN_BY_SYMBOL[quote])
    throw new Error(`SWAP_PAIR_INVALID:${pairLabel}`);
  const give = side === 'buy' ? quote : base;
  const want = side === 'buy' ? base : quote;
  const pill = (input: string) => page.getByTestId(input).locator('..').locator('button.pill');
  await timedStep(`swap_pair.${side}.catalog_ready`, () => expect(page.getByTestId('swap-flip')).toBeEnabled());
  // The registry owns these labels; reading before it loads sees "?" and can miss a required Flip.
  if ((await pill('swap-want').innerText()).includes(give)) {
    await timedStep(`swap_pair.${side}.flip`, async () => {
      await page.getByTestId('swap-flip').click();
      await expect(pill('swap-give')).toContainText(give);
    });
  }
  for (const [input, symbol] of [
    ['swap-give', give],
    ['swap-want', want],
  ] as const) {
    await timedStep(`swap_pair.${side}.${input}.${symbol}`, async () => {
      await pill(input).click();
      const option = page.getByRole('option', { name: new RegExp(`^${symbol}\\b`) });
      await expect(option).toBeVisible();
      await option.click();
      await expect(pill(input)).toContainText(symbol);
    });
  }
}

async function placeAliceSellOffer(page: Page, amount: string, price: string): Promise<void> {
  await configurePair(page, 'WETH/USDC', 'sell');
  await page.getByTestId('swap-give').fill(amount);
  const quoteUnits = (parseUnits(amount, 18) * parseUnits(price, 4)) / 10n ** 16n;
  await page.getByTestId('swap-want').fill(formatUnits(quoteUnits, 6));
  await expect(page.getByTestId('swap-submit')).toBeEnabled();
  await page.getByTestId('swap-submit').click();
  await expect(page.getByText('Your open orders', { exact: true })).toBeVisible();
  await expect(page.getByTestId('swap-offer-cancel').first()).toBeVisible();
}

async function placeBobMatchingBuyOrder(page: Page, spendAmount: string, price: string): Promise<void> {
  await configurePair(page, 'WETH/USDC', 'buy');
  await page.getByTestId('swap-give').fill(spendAmount);
  const baseUnits = (parseUnits(spendAmount, 6) * 10n ** 16n) / parseUnits(price, 4);
  await page.getByTestId('swap-want').fill(formatUnits(baseUnits, 18));
  await expect(page.getByTestId('swap-submit')).toBeEnabled();
  await page.getByTestId('swap-submit').click();
}

function displayPriceToTicks(price: string): string {
  const normalized = String(price || '').trim();
  const match = normalized.match(/^(\d+)(?:\.(\d{0,4}))?$/);
  if (!match) throw new Error(`invalid display price: ${price}`);
  const whole = match[1] || '0';
  const frac = (match[2] || '').padEnd(4, '0').slice(0, 4);
  return `${whole}${frac}`.replace(/^0+(?=\d)/, '');
}

function normalizeDisplayedPriceText(value: string): string {
  return String(value || '')
    .replace(/,/g, '')
    .trim();
}

function ticksToDisplayPrice(priceTicks: number): string {
  return (priceTicks / 10_000).toFixed(4);
}

function priceTicksTextToDisplay(priceTicks: string): string {
  const normalized = String(priceTicks || '').trim();
  if (!/^-?\d+$/.test(normalized)) {
    throw new Error(`invalid priceTicks: ${priceTicks}`);
  }
  return ticksToDisplayPrice(Number.parseInt(normalized, 10));
}

async function readVisibleOrderbookPriceTicks(page: Page, side: 'ask' | 'bid'): Promise<number[]> {
  const rows = page.getByTestId('orderbook').locator('visible=true').first().getByTestId(`book-row-${side}`);
  const count = await rows.count();
  const out: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const text = normalizeDisplayedPriceText(String((await rows.nth(index).locator('.bk-price').textContent()) || ''));
    const value = Number.parseFloat(text);
    if (!Number.isFinite(value) || value <= 0) continue;
    out.push(Math.round(value * 10_000));
  }
  return out;
}

async function chooseVisibleRestingPrices(page: Page): Promise<{ ask: string; bid: string }> {
  const askTicks = await readVisibleOrderbookPriceTicks(page, 'ask');
  const bidTicks = await readVisibleOrderbookPriceTicks(page, 'bid');
  if (askTicks.length === 0 && bidTicks.length === 0) {
    return {
      ask: '2500.0002',
      bid: '2499.9998',
    };
  }
  if (askTicks.length === 0) {
    const bestBidTicks = bidTicks[0]!;
    return {
      ask: ticksToDisplayPrice(bestBidTicks + 4),
      bid: ticksToDisplayPrice(bestBidTicks - 1),
    };
  }
  if (bidTicks.length === 0) {
    const bestAskTicks = askTicks[askTicks.length - 1]!;
    return {
      ask: ticksToDisplayPrice(bestAskTicks + 1),
      bid: ticksToDisplayPrice(bestAskTicks - 4),
    };
  }

  const bestAskTicks = askTicks[askTicks.length - 1]!;
  const bestBidTicks = bidTicks[0]!;
  if (bestAskTicks <= bestBidTicks) {
    throw new Error(`invalid orderbook spread: bestAsk=${bestAskTicks} bestBid=${bestBidTicks}`);
  }

  const occupied = new Set<number>([...askTicks, ...bidTicks]);
  let restingAskTicks = bestAskTicks + 1;
  while (occupied.has(restingAskTicks) && restingAskTicks < bestAskTicks + 64) restingAskTicks += 1;
  let restingBidTicks = bestBidTicks - 1;
  while (occupied.has(restingBidTicks) && restingBidTicks > bestBidTicks - 64) restingBidTicks -= 1;

  if (restingAskTicks <= bestBidTicks || restingBidTicks >= bestAskTicks || restingAskTicks <= restingBidTicks) {
    throw new Error(`unable to choose visible resting prices near mid: ask=${restingAskTicks} bid=${restingBidTicks}`);
  }

  return {
    ask: ticksToDisplayPrice(restingAskTicks),
    bid: ticksToDisplayPrice(restingBidTicks),
  };
}

async function chooseInsideSpreadSelfTradeAskPrice(page: Page): Promise<string> {
  const askTicks = await readVisibleOrderbookPriceTicks(page, 'ask');
  const bidTicks = await readVisibleOrderbookPriceTicks(page, 'bid');
  if (askTicks.length === 0 && bidTicks.length === 0) return '2500.0002';
  if (askTicks.length === 0) return ticksToDisplayPrice((bidTicks[0] || 25_000_000) + 4);
  if (bidTicks.length === 0) return ticksToDisplayPrice((askTicks[askTicks.length - 1] || 25_000_000) - 4);

  const bestAskTicks = askTicks[askTicks.length - 1]!;
  const bestBidTicks = bidTicks[0]!;
  const occupied = new Set<number>([...askTicks, ...bidTicks]);
  for (let ticks = bestBidTicks + 1; ticks < bestAskTicks; ticks += 1) {
    if (!occupied.has(ticks)) return ticksToDisplayPrice(ticks);
  }
  throw new Error(`unable to choose self-trade ask inside spread: bestAsk=${bestAskTicks} bestBid=${bestBidTicks}`);
}

function orderbookLevel(page: Page, side: 'ask' | 'bid', price: string) {
  const formatted = new Intl.NumberFormat('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 }).format(
    Number(price),
  );
  const book = page.getByTestId('orderbook').locator('visible=true').first();
  return book.getByTestId(`book-row-${side}`).filter({ has: page.getByText(formatted, { exact: true }) });
}

async function waitForOrderbookLevelVisible(
  page: Page,
  side: 'ask' | 'bid',
  price: string,
  timeoutMs = 30_000,
): Promise<void> {
  await expect(orderbookLevel(page, side, price)).toBeVisible({ timeout: timeoutMs });
}

async function waitForOrderbookLevelGone(
  page: Page,
  side: 'ask' | 'bid',
  price: string,
  timeoutMs = 30_000,
): Promise<void> {
  await expect(orderbookLevel(page, side, price)).toHaveCount(0, { timeout: timeoutMs });
}

async function waitForOrderbookLevelsVisible(
  page: Page,
  levels: Array<{ side: 'ask' | 'bid'; price: string }>,
  timeoutMs = 30_000,
): Promise<void> {
  for (const level of levels) {
    await waitForOrderbookLevelVisible(page, level.side, level.price, timeoutMs);
  }
}

async function readSwapResolveSnapshotsFrom(
  page: Page,
  entityId: string,
  counterpartyId: string,
  historyField: 'swapOrderHistory' | 'swapClosedOrders',
): Promise<SwapResolveSnapshot[]> {
  return await page.evaluate(
    async ({ entityId, counterpartyId, historyField }) => {
      const view = window as SwapRuntimeWindow;
      const env = view.__xln?.env();
      const reader = (await view.__xln?.xln())?.readPersistedAccountSwapHistoryPage;
      if (!env) throw new Error('SWAP_HISTORY_RUNTIME_ENV_UNAVAILABLE');
      if (!reader) throw new Error('SWAP_HISTORY_PERSISTED_READER_UNAVAILABLE');
      const out: SwapResolveSnapshot[] = [];
      const page = await reader(env, entityId, counterpartyId, { limit: 100 });
      for (const lifecycle of page.items ?? []) {
        if (historyField === 'swapClosedOrders' && lifecycle.closed !== true) continue;
        for (const resolve of lifecycle.resolves ?? []) {
          out.push({
            offerId: String(lifecycle.offerId || ''),
            fillRatio: Number(resolve.fillRatio || 0),
            fillNumerator: String(resolve.fillNumerator ?? '0'),
            fillDenominator: String(resolve.fillDenominator ?? '0'),
            cancelRemainder: Boolean(resolve.cancelRemainder),
            executionGiveAmount: resolve.executionGiveAmount === null ? null : resolve.executionGiveAmount.toString(),
            executionWantAmount: resolve.executionWantAmount === null ? null : resolve.executionWantAmount.toString(),
            feeTokenId: resolve.feeTokenId,
            feeAmount: resolve.feeAmount === null ? null : resolve.feeAmount.toString(),
            comment: String(resolve.comment || ''),
          });
        }
      }
      return out;
    },
    { entityId, counterpartyId, historyField },
  );
}

async function readSwapResolveSnapshots(
  page: Page,
  entityId: string,
  counterpartyId: string,
): Promise<SwapResolveSnapshot[]> {
  return readSwapResolveSnapshotsFrom(page, entityId, counterpartyId, 'swapOrderHistory');
}

async function readClosedSwapResolveSnapshots(
  page: Page,
  entityId: string,
  counterpartyId: string,
): Promise<SwapResolveSnapshot[]> {
  return readSwapResolveSnapshotsFrom(page, entityId, counterpartyId, 'swapClosedOrders');
}

async function waitForLatestSwapResolveSnapshot(
  page: Page,
  entityId: string,
  counterpartyId: string,
  minimumCount: number,
): Promise<SwapResolveSnapshot> {
  await expect
    .poll(async () => (await readSwapResolveSnapshots(page, entityId, counterpartyId)).length, {
      timeout: 30_000,
      intervals: [250, 500, 750],
      message: `swap resolve snapshots must reach ${minimumCount}`,
    })
    .toBeGreaterThanOrEqual(minimumCount);
  const snapshots = await readSwapResolveSnapshots(page, entityId, counterpartyId);
  const latest = snapshots.at(-1);
  expect(latest, 'latest swap resolve snapshot must exist').toBeTruthy();
  return latest!;
}

async function waitForSwapResolveSnapshotByComment(
  page: Page,
  entityId: string,
  counterpartyId: string,
  pattern: RegExp,
): Promise<SwapResolveSnapshot> {
  await expect
    .poll(
      async () => {
        const snapshots = await readSwapResolveSnapshots(page, entityId, counterpartyId);
        return snapshots.some(snapshot => pattern.test(snapshot.comment));
      },
      {
        timeout: 30_000,
        intervals: [250, 500, 750],
        message: `swap resolve history must include ${pattern}`,
      },
    )
    .toBe(true);
  const snapshots = await readSwapResolveSnapshots(page, entityId, counterpartyId);
  const match = snapshots.find(snapshot => pattern.test(snapshot.comment));
  expect(match, `swap resolve snapshot matching ${pattern} must exist`).toBeTruthy();
  return match!;
}

async function waitForRestoredRuntime(page: Page, runtimeId: string): Promise<void> {
  await page.waitForFunction(
    ({ runtimeId }) => {
      const view = window as SwapRuntimeWindow;
      return (
        String(view.__xln?.env()?.runtimeId || '').toLowerCase() === String(runtimeId || '').toLowerCase() &&
        Number(view.__xln?.env()?.state?.eReplicas?.size || 0) > 0
      );
    },
    { runtimeId },
    { timeout: INIT_TIMEOUT },
  );
}

async function readSwapOfferSnapshot(
  page: Page,
  entityId: string,
  signerId: string,
  counterpartyId: string,
): Promise<
  Array<{
    offerId: string;
    giveAmount: string;
    wantAmount: string;
    priceTicks: string;
    giveTokenId: string;
    wantTokenId: string;
  }>
> {
  return page.evaluate(
    ({ entityId, signerId, counterpartyId }) => {
      const env = (window as SwapRuntimeWindow).__xln?.env();
      if (!env) throw new Error('SWAP_RUNTIME_UNAVAILABLE');
      const replicas = [...env.state.eReplicas.values()].filter(
        replica => replica.entityId === entityId && replica.signerId === signerId,
      );
      const [replica] = replicas;
      if (replicas.length !== 1 || !replica) throw new Error('SWAP_SIGNER_NOT_UNIQUE');
      const account = replica.state.accounts.get(counterpartyId);
      if (!account) throw new Error('SWAP_ACCOUNT_UNAVAILABLE');
      return [...account.state.swapOffers.values()].map(offer => ({
        offerId: offer.offerId,
        giveAmount: offer.giveAmount.toString(),
        wantAmount: offer.wantAmount.toString(),
        priceTicks: offer.priceTicks.toString(),
        giveTokenId: String(offer.giveTokenId),
        wantTokenId: String(offer.wantTokenId),
      }));
    },
    { entityId, signerId, counterpartyId },
  );
}

async function readFirstOpenOrderRemainingUi(page: Page): Promise<string> {
  const remainingCell = page
    .locator('.row', { has: page.getByTestId('swap-offer-cancel') })
    .first()
    .locator('.tx .t');
  await expect(remainingCell).toBeVisible({ timeout: 20_000 });
  return String((await remainingCell.textContent()) || '').trim();
}

async function openSwapHistory(page: Page, hubId: string) {
  await page.getByTestId('nav-activity').locator('visible=true').first().click();
  await page.getByRole('button', { name: 'Swaps', exact: true }).click();
  const history = page.getByRole('region', { name: 'Swap history', exact: true });
  await history.getByRole('combobox').selectOption(hubId);
  return history;
}

async function readSwapOfferCount(
  page: Page,
  entityId: string,
  signerId: string,
  counterpartyId: string,
): Promise<number> {
  return page.evaluate(
    ({ entityId, signerId, counterpartyId }) => {
      const env = (window as SwapRuntimeWindow).__xln?.env();
      if (!env) throw new Error('SWAP_RUNTIME_UNAVAILABLE');
      const replicas = [...env.state.eReplicas.values()].filter(
        replica => replica.entityId === entityId && replica.signerId === signerId,
      );
      const [replica] = replicas;
      if (replicas.length !== 1 || !replica) throw new Error('SWAP_SIGNER_NOT_UNIQUE');
      const account = replica.state.accounts.get(counterpartyId);
      if (!account) throw new Error('SWAP_ACCOUNT_UNAVAILABLE');
      return account.state.swapOffers.size;
    },
    { entityId, signerId, counterpartyId },
  );
}

async function readSwapHistoryCount(
  page: Page,
  entityId: string,
  signerId: string,
  counterpartyId: string,
): Promise<number> {
  void signerId;
  return await page.evaluate(
    async ({ entityId, counterpartyId }) => {
      const view = window as SwapRuntimeWindow;
      const env = view.__xln?.env();
      const reader = (await view.__xln?.xln())?.readPersistedAccountSwapHistoryPage;
      if (!env || !reader) throw new Error('SWAP_HISTORY_PERSISTED_READER_UNAVAILABLE');
      const history = await reader(env, entityId, counterpartyId, { limit: 100 });
      return Number(history.items?.length || 0);
    },
    { entityId, counterpartyId },
  );
}

test.describe('E2E Swap Isolated Flow', () => {
  test.setTimeout(240_000);

  test('swap fixtures use canonical token decimals', { tag: '@functional' }, () => {
    expect(wholeSwapTokenUnits(1, 1n), 'USDC uses six decimals').toBe(1_000_000n);
    expect(wholeSwapTokenUnits(2, 1n), 'WETH uses eighteen decimals').toBe(1_000_000_000_000_000_000n);
  });

  test(
    'relay orderbook publishes new resting ask and bid to both subscribed users',
    { tag: '@functional' },
    async ({ browser, page }, testInfo) => {
      let aliceContext: BrowserContext | null = null;
      let bobContext: BrowserContext | null = null;

      try {
        const baseline = await timedStep('swap_book_publish.ensure_baseline', () =>
          ensureE2EBaseline(page, {
            apiBaseUrl: API_BASE_URL,
            requireMarketMaker: false,
            requireHubMesh: true,
            minHubCount: 3,
            forceReset: true,
          }),
        );

        const hubId = getPrimaryHubId(baseline);

        aliceContext = await browser.newContext({ ignoreHTTPSErrors: true });
        bobContext = await browser.newContext({ ignoreHTTPSErrors: true });
        const alicePage = await aliceContext.newPage();
        const bobPage = await bobContext.newPage();

        await Promise.all([
          gotoApp(alicePage, { appBaseUrl: APP_BASE_URL, initTimeoutMs: INIT_TIMEOUT, settleMs: 1200 }),
          gotoApp(bobPage, { appBaseUrl: APP_BASE_URL, initTimeoutMs: INIT_TIMEOUT, settleMs: 1200 }),
        ]);

        const alice = await createWalletIdentity(alicePage, 'alice-book', selectDemoMnemonic('alice'));
        const bob = await createWalletIdentity(bobPage, 'bob-book', selectDemoMnemonic('bob'));

        await timedStep('swap_partial.alice.connect_hub', () =>
          connectRuntimeToHubWithCredit(alicePage, alice, hubId, '10000', SWAP_CONNECT_TOKEN_IDS),
        );
        await timedStep('swap_partial.bob.connect_hub', () =>
          connectRuntimeToHubWithCredit(bobPage, bob, hubId, '10000', SWAP_CONNECT_TOKEN_IDS),
        );

        await extendCreditToken(alicePage, hubId, 2, '10000');
        await waitForTokenDeltaActive(alicePage, alice.entityId, hubId, 2);

        await Promise.all([
          faucetOffchain(alicePage, alice.entityId, hubId, 2, '5'),
          faucetOffchain(bobPage, bob.entityId, hubId, 1, '100'),
        ]);

        await Promise.all([
          waitForOutCapAtLeast(alicePage, alice.entityId, hubId, 2, 1n * 10n ** 18n),
          waitForOutCapAtLeast(bobPage, bob.entityId, hubId, 1, wholeSwapTokenUnits(1, 10n)),
        ]);

        await Promise.all([openSwapWorkspace(alicePage), openSwapWorkspace(bobPage)]);
        await Promise.all([selectCounterpartyInSwap(alicePage, hubId), selectCounterpartyInSwap(bobPage, hubId)]);

        for (const wallet of [alicePage, bobPage]) {
          const book = wallet.getByTestId('orderbook').locator('visible=true').first();
          await expect(book).toHaveAttribute('data-source', 'relay');
          await expect(book).toHaveAttribute('data-status', 'live');
        }
        const visibleRestingPrices = await chooseVisibleRestingPrices(alicePage);

        await placeAliceSellOffer(alicePage, '0.03', visibleRestingPrices.ask);

        await expect
          .poll(async () => await readSwapOfferCount(alicePage, alice.entityId, alice.signerId, hubId), {
            timeout: 30_000,
            intervals: [250, 500, 750],
            message: 'alice resting ask should exist in swap offers',
          })
          .toBeGreaterThan(0);
        const [aliceOffer] = await readSwapOfferSnapshot(alicePage, alice.entityId, alice.signerId, hubId);
        expect(aliceOffer?.priceTicks, 'alice resting ask snapshot missing').toBeTruthy();
        expect(aliceOffer!.priceTicks, 'alice resting ask price must remain exactly the user-entered limit price').toBe(
          String(displayPriceToTicks(visibleRestingPrices.ask)),
        );
        const restingAskPrice = priceTicksTextToDisplay(aliceOffer!.priceTicks);

        await Promise.all([
          waitForOrderbookLevelVisible(alicePage, 'ask', restingAskPrice),
          waitForOrderbookLevelVisible(bobPage, 'ask', restingAskPrice),
        ]);

        await placeBobMatchingBuyOrder(bobPage, '50', visibleRestingPrices.bid);
        await expect(bobPage.getByTestId('swap-offer-cancel')).toBeVisible();
        await expect
          .poll(async () => await readSwapOfferCount(bobPage, bob.entityId, bob.signerId, hubId), {
            timeout: 30_000,
            intervals: [250, 500, 750],
            message: 'bob resting bid should exist in swap offers',
          })
          .toBeGreaterThan(0);
        const [bobOffer] = await readSwapOfferSnapshot(bobPage, bob.entityId, bob.signerId, hubId);
        expect(bobOffer?.priceTicks, 'bob resting bid snapshot missing').toBeTruthy();
        expect(bobOffer!.priceTicks, 'bob resting bid price must remain exactly the user-entered limit price').toBe(
          String(displayPriceToTicks(visibleRestingPrices.bid)),
        );
        const restingBidPrice = priceTicksTextToDisplay(bobOffer!.priceTicks);

        await Promise.all([
          waitForOrderbookLevelVisible(alicePage, 'bid', restingBidPrice),
          waitForOrderbookLevelVisible(bobPage, 'bid', restingBidPrice),
        ]);

        await Promise.all([
          waitForOrderbookLevelsVisible(alicePage, [
            { side: 'ask', price: restingAskPrice },
            { side: 'bid', price: restingBidPrice },
          ]),
          waitForOrderbookLevelsVisible(bobPage, [
            { side: 'ask', price: restingAskPrice },
            { side: 'bid', price: restingBidPrice },
          ]),
        ]);

        await Promise.all([alicePage.waitForTimeout(1200), bobPage.waitForTimeout(1200)]);

        await Promise.all([
          waitForOrderbookLevelsVisible(alicePage, [
            { side: 'ask', price: restingAskPrice },
            { side: 'bid', price: restingBidPrice },
          ]),
          waitForOrderbookLevelsVisible(bobPage, [
            { side: 'ask', price: restingAskPrice },
            { side: 'bid', price: restingBidPrice },
          ]),
        ]);

        await alicePage.getByTestId('swap-offer-cancel').first().click();
        await expect
          .poll(async () => await readSwapOfferCount(alicePage, alice.entityId, alice.signerId, hubId), {
            timeout: 30_000,
            intervals: [250, 500, 750],
            message: 'alice resting ask should be removable from the UI',
          })
          .toBe(0);
        await Promise.all([
          waitForOrderbookLevelGone(alicePage, 'ask', restingAskPrice),
          waitForOrderbookLevelGone(bobPage, 'ask', restingAskPrice),
        ]);

        await bobPage.getByTestId('swap-offer-cancel').first().click();
        await expect
          .poll(async () => await readSwapOfferCount(bobPage, bob.entityId, bob.signerId, hubId), {
            timeout: 30_000,
            intervals: [250, 500, 750],
            message: 'bob resting bid should be removable from the UI',
          })
          .toBe(0);
        await Promise.all([
          waitForOrderbookLevelGone(alicePage, 'bid', restingBidPrice),
          waitForOrderbookLevelGone(bobPage, 'bid', restingBidPrice),
        ]);

        for (const peer of [
          { page: alicePage, entityId: alice.entityId },
          { page: bobPage, entityId: bob.entityId },
        ]) {
          const closed = await readClosedSwapResolveSnapshots(peer.page, peer.entityId, hubId);
          expect(closed).toHaveLength(1);
          expect(closed[0]?.cancelRemainder).toBe(true);
          const history = await openSwapHistory(peer.page, hubId);
          const order = history.getByTestId('swap-history-order');
          await expect(order).toHaveCount(1);
          await expect(order.locator('summary')).toContainText('Closed');
          await order.locator('summary').click();
          await expect(order).toContainText('Remainder cancelled');
          expect(await holdTotal(peer.page, peer.entityId, hubId, 1)).toBe(0n);
          expect(await holdTotal(peer.page, peer.entityId, hubId, 2)).toBe(0n);
        }
        await alicePage.screenshot({ path: testInfo.outputPath('peer-book-cancel.png'), fullPage: true });
      } finally {
        await Promise.all([
          aliceContext ? aliceContext.close().catch(() => {}) : Promise.resolve(),
          bobContext ? bobContext.close().catch(() => {}) : Promise.resolve(),
        ]);
      }
    },
  );

  test(
    'self-trade protection cancels a user taker before matching their own resting order',
    { tag: '@resilience' },
    async ({ browser, page }, testInfo) => {
      let aliceContext: BrowserContext | null = null;

      try {
        const baseline = await timedStep('swap_self_trade.ensure_baseline', () =>
          ensureE2EBaseline(page, {
            apiBaseUrl: API_BASE_URL,
            requireMarketMaker: false,
            requireHubMesh: true,
            minHubCount: 3,
            forceReset: true,
          }),
        );

        const hubId = getPrimaryHubId(baseline);

        aliceContext = await browser.newContext({ ignoreHTTPSErrors: true });
        const alicePage = await aliceContext.newPage();
        mirrorConsole(alicePage, 'SWAP-STP');

        await gotoApp(alicePage, { appBaseUrl: APP_BASE_URL, initTimeoutMs: INIT_TIMEOUT, settleMs: 1200 });
        const alice = await createWalletIdentity(alicePage, 'alice-self-trade', selectDemoMnemonic('alice'));

        await connectRuntimeToHubWithCredit(alicePage, alice, hubId, '10000', SWAP_CONNECT_TOKEN_IDS);
        await extendCreditToken(alicePage, hubId, 2, '10000');
        await waitForTokenDeltaActive(alicePage, alice.entityId, hubId, 2);

        await Promise.all([
          faucetOffchain(alicePage, alice.entityId, hubId, 2, '5'),
          faucetOffchain(alicePage, alice.entityId, hubId, 1, '100'),
        ]);
        await Promise.all([
          waitForOutCapAtLeast(alicePage, alice.entityId, hubId, 2, 1n * 10n ** 18n),
          waitForOutCapAtLeast(alicePage, alice.entityId, hubId, 1, wholeSwapTokenUnits(1, 75n)),
        ]);

        await openSwapWorkspace(alicePage);
        await selectCounterpartyInSwap(alicePage, hubId);

        const selfTradeAskPrice = await chooseInsideSpreadSelfTradeAskPrice(alicePage);
        await placeAliceSellOffer(alicePage, '0.03', selfTradeAskPrice);
        await waitForOrderbookLevelVisible(alicePage, 'ask', selfTradeAskPrice);
        await expect
          .poll(async () => await readSwapOfferCount(alicePage, alice.entityId, alice.signerId, hubId), {
            timeout: 30_000,
            intervals: [250, 500, 750],
            message: 'Alice maker ask should remain open before the self-trade attempt',
          })
          .toBe(1);

        // The cancelled taker records no execution amount. Prove zero economic
        // movement from the real Account instead of inventing zeros in history.
        const beforeSelfTrade = await Promise.all([
          outCap(alicePage, alice.entityId, hubId, 1),
          outCap(alicePage, alice.entityId, hubId, 2),
          holdTotal(alicePage, alice.entityId, hubId, 1),
          holdTotal(alicePage, alice.entityId, hubId, 2),
        ]);
        await placeBobMatchingBuyOrder(alicePage, '80', selfTradeAskPrice);
        const stpResolve = await waitForSwapResolveSnapshotByComment(alicePage, alice.entityId, hubId, /^STP:/);
        expect(stpResolve.cancelRemainder, 'self-trade taker must close without resting against own maker').toBe(true);
        expect(stpResolve.comment, 'self-trade resolve must identify STP in machine state').toMatch(/^STP:/);
        expect(stpResolve.fillRatio, 'self-trade taker executes no fill').toBe(0);
        expect(
          stpResolve.executionGiveAmount,
          'cancel-only history must not fabricate a monetary execution',
        ).toBeNull();
        expect(stpResolve.executionWantAmount).toBeNull();

        await expect
          .poll(async () => await readSwapOfferCount(alicePage, alice.entityId, alice.signerId, hubId), {
            timeout: 30_000,
            intervals: [250, 500, 750],
            message: 'self-trade protection must leave the original maker order resting',
          })
          .toBe(1);
        await waitForOrderbookLevelVisible(alicePage, 'ask', selfTradeAskPrice);

        await expect
          .poll(
            async () => {
              const closed = await readClosedSwapResolveSnapshots(alicePage, alice.entityId, hubId);
              return closed.some(snapshot => /^STP:/.test(snapshot.comment));
            },
            {
              timeout: 30_000,
              intervals: [250, 500, 750],
              message: 'committed Account state must close the STP-cancelled taker',
            },
          )
          .toBe(true);
        await expect
          .poll(
            () =>
              Promise.all([
                outCap(alicePage, alice.entityId, hubId, 1),
                outCap(alicePage, alice.entityId, hubId, 2),
                holdTotal(alicePage, alice.entityId, hubId, 1),
                holdTotal(alicePage, alice.entityId, hubId, 2),
              ]),
            { message: 'self-trade must preserve both token capacities and the original maker holds' },
          )
          .toEqual(beforeSelfTrade);
        const history = await openSwapHistory(alicePage, hubId);
        const stpOrder = history.getByTestId('swap-history-order').filter({ hasText: /STP:/ });
        await expect(stpOrder).toHaveCount(1);
        await expect(stpOrder.locator('summary')).toContainText('Closed');
        await stpOrder.locator('summary').click();
        await expect(stpOrder.getByText(/^STP:/)).toBeVisible();
        await expect(stpOrder.locator('[data-field="gave"]')).toHaveText('Not recorded');
        await expect(stpOrder.locator('[data-field="received"]')).toHaveText('Not recorded');
        await alicePage.screenshot({ path: testInfo.outputPath('peer-self-trade.png'), fullPage: true });
      } finally {
        await aliceContext?.close().catch(() => {});
      }
    },
  );

  test(
    'two isolated users trade against each other through one hub orderbook without market maker liquidity',
    { tag: '@functional' },
    async ({ browser, page }) => {
      let aliceContext: BrowserContext | null = null;
      let bobContext: BrowserContext | null = null;

      try {
        const baseline = await timedStep('swap_isolated.ensure_baseline', () =>
          ensureE2EBaseline(page, {
            apiBaseUrl: API_BASE_URL,
            requireMarketMaker: false,
            requireHubMesh: true,
            minHubCount: 3,
            forceReset: true,
          }),
        );

        const hubId = getPrimaryHubId(baseline);

        aliceContext = await browser.newContext({ ignoreHTTPSErrors: true });
        bobContext = await browser.newContext({ ignoreHTTPSErrors: true });
        const alicePage = await aliceContext.newPage();
        const bobPage = await bobContext.newPage();
        mirrorConsole(alicePage, 'SWAP-ALICE');
        mirrorConsole(bobPage, 'SWAP-BOB');

        await Promise.all([
          timedStep('swap_isolated.alice.goto_app', () =>
            gotoApp(alicePage, { appBaseUrl: APP_BASE_URL, initTimeoutMs: INIT_TIMEOUT, settleMs: 1200 }),
          ),
          timedStep('swap_isolated.bob.goto_app', () =>
            gotoApp(bobPage, { appBaseUrl: APP_BASE_URL, initTimeoutMs: INIT_TIMEOUT, settleMs: 1200 }),
          ),
        ]);

        const alice = await timedStep('swap_isolated.alice.create_runtime', () =>
          createWalletIdentity(alicePage, 'alice', selectDemoMnemonic('alice')),
        );
        const bob = await timedStep('swap_isolated.bob.create_runtime', () =>
          createWalletIdentity(bobPage, 'bob', selectDemoMnemonic('bob')),
        );
        expect(alice.entityId).not.toBe(bob.entityId);

        await Promise.all([
          timedStep('swap_isolated.alice.connect_hub', () =>
            connectRuntimeToHubWithCredit(alicePage, alice, hubId, '10000', SWAP_CONNECT_TOKEN_IDS),
          ),
          timedStep('swap_isolated.bob.connect_hub', () =>
            connectRuntimeToHubWithCredit(bobPage, bob, hubId, '10000', SWAP_CONNECT_TOKEN_IDS),
          ),
        ]);

        await timedStep('swap_isolated.alice.extend_credit_weth', async () => {
          await extendCreditToken(alicePage, hubId, 2, '10000');
          await waitForTokenDeltaActive(alicePage, alice.entityId, hubId, 2);
        });

        await Promise.all([
          faucetOffchain(alicePage, alice.entityId, hubId, 2, '5'),
          faucetOffchain(bobPage, bob.entityId, hubId, 1, '100'),
        ]);

        const aliceToken2Before = await waitForOutCapAtLeast(alicePage, alice.entityId, hubId, 2, 1n * 10n ** 18n);
        const bobToken1Before = await waitForOutCapAtLeast(
          bobPage,
          bob.entityId,
          hubId,
          1,
          wholeSwapTokenUnits(1, 10n),
        );
        const aliceToken1Before = await outCap(alicePage, alice.entityId, hubId, 1);
        const bobToken2Before = await outCap(bobPage, bob.entityId, hubId, 2);
        await openSwapWorkspace(alicePage);
        await selectCounterpartyInSwap(alicePage, hubId);
        await placeAliceSellOffer(alicePage, '0.03', '2500');
        await waitForOrderbookLevelVisible(alicePage, 'ask', '2500');

        await openSwapWorkspace(bobPage);
        await selectCounterpartyInSwap(bobPage, hubId);
        await waitForOrderbookLevelVisible(bobPage, 'ask', '2500');
        await placeBobMatchingBuyOrder(bobPage, '78', '2600');

        await expect
          .poll(async () => await readSwapOfferCount(alicePage, alice.entityId, alice.signerId, hubId), {
            timeout: 30_000,
            intervals: [250, 500, 750],
            message: 'Alice swapOffers state must clear after Bob fills the order',
          })
          .toBe(0);
        await Promise.all([
          waitForOrderbookLevelGone(alicePage, 'ask', '2500'),
          waitForOrderbookLevelGone(bobPage, 'ask', '2500'),
        ]);

        const aliceToken1After = await waitForOutCapChange(
          alicePage,
          alice.entityId,
          hubId,
          1,
          aliceToken1Before,
          'up',
        );
        const aliceToken2After = await waitForOutCapChange(
          alicePage,
          alice.entityId,
          hubId,
          2,
          aliceToken2Before,
          'down',
        );
        const bobToken1After = await waitForOutCapChange(bobPage, bob.entityId, hubId, 1, bobToken1Before, 'down');
        const bobToken2After = await waitForOutCapChange(bobPage, bob.entityId, hubId, 2, bobToken2Before, 'up');

        expect(aliceToken1After).toBeGreaterThan(aliceToken1Before);
        expect(aliceToken2After).toBeLessThan(aliceToken2Before);
        expect(bobToken1After).toBeLessThan(bobToken1Before);
        expect(bobToken2After).toBeGreaterThan(bobToken2Before);

        const aliceResolve = await waitForLatestSwapResolveSnapshot(alicePage, alice.entityId, hubId, 1);
        expect(aliceResolve.executionGiveAmount, 'maker gives exactly 0.03 WETH').toBe('30000000000000000');
        expect(aliceResolve.executionWantAmount, 'maker receives execution quote at resting ask, not taker limit').toBe(
          wholeSwapTokenUnits(1, 75n).toString(),
        );
        expect(aliceResolve.fillRatio, 'maker order is fully filled').toBe(65_535);
        expect(aliceResolve.cancelRemainder, 'maker order closes after full fill').toBe(true);

        const bobResolve = await waitForLatestSwapResolveSnapshot(bobPage, bob.entityId, hubId, 1);
        expect(bobResolve.executionGiveAmount, 'buyer spends execution quote at 2500, not the 2600 limit').toBe(
          wholeSwapTokenUnits(1, 75n).toString(),
        );
        expect(bobResolve.executionWantAmount, 'buyer receives full 0.03 WETH target').toBe('30000000000000000');
        if (bobResolve.executionGiveAmount === null) throw new Error('EXECUTED_GIVE_AMOUNT_MISSING');
        expect(BigInt(bobResolve.executionGiveAmount), 'buyer source savings must be positive').toBeLessThan(
          wholeSwapTokenUnits(1, 78n),
        );
        expect(
          BigInt(bobResolve.fillNumerator),
          'source-savings exact ratio should be below full source spend',
        ).toBeLessThan(BigInt(bobResolve.fillDenominator));
        expect(bobResolve.cancelRemainder, 'current taker closes unused source remainder after price improvement').toBe(
          true,
        );

        // Runtime persistence/reload is covered by dedicated persistence specs.
        // This isolated swap case stays focused on cross-user no-MM execution.
      } finally {
        await Promise.all([
          aliceContext ? aliceContext.close().catch(() => {}) : Promise.resolve(),
          bobContext ? bobContext.close().catch(() => {}) : Promise.resolve(),
        ]);
      }
    },
  );

  test(
    'resting maker order can fill partially, stay open, then cancel remainder',
    { tag: '@functional' },
    async ({ browser, page }, testInfo) => {
      let aliceContext: BrowserContext | null = null;
      let bobContext: BrowserContext | null = null;

      try {
        const baseline = await timedStep('swap_partial.ensure_baseline', () =>
          ensureE2EBaseline(page, {
            apiBaseUrl: API_BASE_URL,
            requireMarketMaker: false,
            requireHubMesh: true,
            minHubCount: 3,
            forceReset: true,
          }),
        );

        const hubId = getPrimaryHubId(baseline);

        aliceContext = await browser.newContext({ ignoreHTTPSErrors: true });
        bobContext = await browser.newContext({ ignoreHTTPSErrors: true });
        const alicePage = await aliceContext.newPage();
        const bobPage = await bobContext.newPage();

        await Promise.all([
          gotoApp(alicePage, { appBaseUrl: APP_BASE_URL, initTimeoutMs: INIT_TIMEOUT, settleMs: 1200 }),
          gotoApp(bobPage, { appBaseUrl: APP_BASE_URL, initTimeoutMs: INIT_TIMEOUT, settleMs: 1200 }),
        ]);

        const alice = await createWalletIdentity(alicePage, 'alice-partial', selectDemoMnemonic('alice'));
        const bob = await createWalletIdentity(bobPage, 'bob-partial', selectDemoMnemonic('bob'));

        await timedStep('swap_roundtrip.alice.connect_hub', () =>
          connectRuntimeToHubWithCredit(alicePage, alice, hubId, '10000', SWAP_CONNECT_TOKEN_IDS),
        );
        await timedStep('swap_roundtrip.bob.connect_hub', () =>
          connectRuntimeToHubWithCredit(bobPage, bob, hubId, '10000', SWAP_CONNECT_TOKEN_IDS),
        );

        await extendCreditToken(alicePage, hubId, 2, '10000');
        await waitForTokenDeltaActive(alicePage, alice.entityId, hubId, 2);

        await Promise.all([
          faucetOffchain(alicePage, alice.entityId, hubId, 2, '5'),
          faucetOffchain(bobPage, bob.entityId, hubId, 1, '100'),
        ]);

        await waitForOutCapAtLeast(alicePage, alice.entityId, hubId, 2, 1n * 10n ** 18n);
        await waitForOutCapAtLeast(bobPage, bob.entityId, hubId, 1, wholeSwapTokenUnits(1, 10n));

        await openSwapWorkspace(alicePage);
        await selectCounterpartyInSwap(alicePage, hubId);
        await placeAliceSellOffer(alicePage, '0.04', '2500');

        await openSwapWorkspace(bobPage);
        await selectCounterpartyInSwap(bobPage, hubId);
        await placeBobMatchingBuyOrder(bobPage, '50', '2500');

        await waitForSwapResolveCountAtLeast(alicePage, alice.entityId, hubId, 1);
        await waitForSwapResolveCountAtLeast(bobPage, bob.entityId, hubId, 1);

        await expect
          .poll(async () => await readSwapOfferCount(alicePage, alice.entityId, alice.signerId, hubId), {
            timeout: 30_000,
            intervals: [250, 500, 750],
          })
          .toBe(1);

        const aliceOffersAfterPartial = await readSwapOfferSnapshot(alicePage, alice.entityId, alice.signerId, hubId);
        expect(aliceOffersAfterPartial).toHaveLength(1);
        expect(BigInt(aliceOffersAfterPartial[0]!.giveAmount)).toBe(20_000_000_000_000_000n);

        const remainingText = await readFirstOpenOrderRemainingUi(alicePage);
        expect(
          remainingText.includes('0.02'),
          `expected remaining UI amount around 0.02 WETH, got ${remainingText}`,
        ).toBe(true);

        await alicePage.reload({ waitUntil: 'domcontentloaded' });
        await unlockSavedWalletAfterReload(alicePage);
        await waitForRestoredRuntime(alicePage, alice.runtimeId);
        await openSwapWorkspace(alicePage);
        await selectCounterpartyInSwap(alicePage, hubId);

        await expect
          .poll(async () => await readSwapOfferCount(alicePage, alice.entityId, alice.signerId, hubId), {
            timeout: 30_000,
            intervals: [250, 500, 750],
          })
          .toBe(1);
        const remainingTextAfterReload = await readFirstOpenOrderRemainingUi(alicePage);
        expect(
          remainingTextAfterReload.includes('0.02'),
          `expected remaining UI amount around 0.02 WETH after reload, got ${remainingTextAfterReload}`,
        ).toBe(true);

        // The taker can disappear after receiving the partial fill; the maker must still be
        // able to cancel/resolve the remaining committed order without counterparty UI help.
        await bobContext.close();
        bobContext = null;

        const cancelButton = alicePage.getByTestId('swap-offer-cancel').first();
        await expect(cancelButton).toBeVisible({ timeout: 20_000 });
        await cancelButton.click();

        await expect
          .poll(async () => await readSwapOfferCount(alicePage, alice.entityId, alice.signerId, hubId), {
            timeout: 30_000,
            intervals: [250, 500, 750],
          })
          .toBe(0);

        await expect
          .poll(async () => await alicePage.getByTestId('swap-offer-cancel').count(), {
            timeout: 30_000,
            intervals: [250, 500, 750],
          })
          .toBe(0);

        const closed = await readClosedSwapResolveSnapshots(alicePage, alice.entityId, hubId);
        const filledGive = closed.reduce(
          (sum, fill) => (fill.executionGiveAmount === null ? sum : sum + BigInt(fill.executionGiveAmount)),
          0n,
        );
        const filledWant = closed.reduce(
          (sum, fill) => (fill.executionWantAmount === null ? sum : sum + BigInt(fill.executionWantAmount)),
          0n,
        );
        expect(filledGive, 'exactly half of the original0.04WETH maker order executes').toBe(20_000_000_000_000_000n);
        expect(filledWant).toBe(50_000_000n);
        expect(closed.some(fill => fill.cancelRemainder)).toBe(true);
        await alicePage.getByTestId('nav-activity').locator('visible=true').first().click();
        await alicePage.getByRole('button', { name: 'Swaps', exact: true }).click();
        const history = alicePage.getByRole('region', { name: 'Swap history', exact: true });
        await history.getByRole('combobox').selectOption(hubId);
        const partialClosedRow = history.getByTestId('swap-history-order').first();
        await expect(partialClosedRow.locator('summary')).toContainText('Closed');
        await partialClosedRow.locator('summary').click();
        await expect(partialClosedRow.locator('[data-field="gave"][data-amount="20000000000000000"]')).toBeVisible();
        await expect(partialClosedRow.locator('[data-field="received"][data-amount="50000000"]')).toBeVisible();
        await alicePage.screenshot({ path: testInfo.outputPath('peer-swap-partial-recovery.png'), fullPage: true });
      } finally {
        await Promise.all([
          aliceContext ? aliceContext.close().catch(() => {}) : Promise.resolve(),
          bobContext ? bobContext.close().catch(() => {}) : Promise.resolve(),
        ]);
      }
    },
  );

  test(
    'one resting maker order can be matched by two isolated takers until fully closed',
    { tag: '@functional' },
    async ({ browser, page }, testInfo) => {
      test.setTimeout(240_000);
      let aliceContext: BrowserContext | null = null;
      let bobContext: BrowserContext | null = null;
      let carolContext: BrowserContext | null = null;

      try {
        const baseline = await timedStep('swap_multi.ensure_baseline', () =>
          ensureE2EBaseline(page, {
            apiBaseUrl: API_BASE_URL,
            requireMarketMaker: false,
            requireHubMesh: true,
            minHubCount: 3,
            forceReset: true,
          }),
        );

        const hubId = getPrimaryHubId(baseline);

        aliceContext = await browser.newContext({ ignoreHTTPSErrors: true });
        bobContext = await browser.newContext({ ignoreHTTPSErrors: true });
        carolContext = await browser.newContext({ ignoreHTTPSErrors: true });
        const alicePage = await aliceContext.newPage();
        const bobPage = await bobContext.newPage();
        const carolPage = await carolContext.newPage();

        await Promise.all([
          gotoApp(alicePage, { appBaseUrl: APP_BASE_URL, initTimeoutMs: INIT_TIMEOUT, settleMs: 1200 }),
          gotoApp(bobPage, { appBaseUrl: APP_BASE_URL, initTimeoutMs: INIT_TIMEOUT, settleMs: 1200 }),
          gotoApp(carolPage, { appBaseUrl: APP_BASE_URL, initTimeoutMs: INIT_TIMEOUT, settleMs: 1200 }),
        ]);

        const alice = await createWalletIdentity(alicePage, 'alice-multi', selectDemoMnemonic('alice'));
        const bob = await createWalletIdentity(bobPage, 'bob-multi', selectDemoMnemonic('bob'));
        const carol = await createWalletIdentity(carolPage, 'carol-multi', selectDemoMnemonic('carol'));

        await Promise.all([
          connectRuntimeToHubWithCredit(alicePage, alice, hubId, '10000', SWAP_CONNECT_TOKEN_IDS),
          connectRuntimeToHubWithCredit(bobPage, bob, hubId, '10000', SWAP_CONNECT_TOKEN_IDS),
          connectRuntimeToHubWithCredit(carolPage, carol, hubId, '10000', SWAP_CONNECT_TOKEN_IDS),
        ]);

        await extendCreditToken(alicePage, hubId, 2, '10000');
        await waitForTokenDeltaActive(alicePage, alice.entityId, hubId, 2);

        await Promise.all([
          faucetOffchain(alicePage, alice.entityId, hubId, 2, '5'),
          faucetOffchain(bobPage, bob.entityId, hubId, 1, '100'),
          faucetOffchain(carolPage, carol.entityId, hubId, 1, '100'),
        ]);

        await Promise.all([
          waitForOutCapAtLeast(alicePage, alice.entityId, hubId, 2, 1n * 10n ** 18n),
          waitForOutCapAtLeast(bobPage, bob.entityId, hubId, 1, wholeSwapTokenUnits(1, 10n)),
          waitForOutCapAtLeast(carolPage, carol.entityId, hubId, 1, wholeSwapTokenUnits(1, 10n)),
        ]);

        await openSwapWorkspace(alicePage);
        await selectCounterpartyInSwap(alicePage, hubId);
        await placeAliceSellOffer(alicePage, '0.06', '2500');

        await openSwapWorkspace(bobPage);
        await selectCounterpartyInSwap(bobPage, hubId);
        await placeBobMatchingBuyOrder(bobPage, '50', '2500');

        await waitForSwapResolveCountAtLeast(alicePage, alice.entityId, hubId, 1);
        await waitForSwapResolveCountAtLeast(bobPage, bob.entityId, hubId, 1);

        await expect
          .poll(async () => await readSwapOfferCount(alicePage, alice.entityId, alice.signerId, hubId), {
            timeout: 30_000,
            intervals: [250, 500, 750],
          })
          .toBe(1);

        await expect
          .poll(
            async () => {
              const offers = await readSwapOfferSnapshot(alicePage, alice.entityId, alice.signerId, hubId);
              return offers.length === 1 ? offers[0]!.giveAmount : '0';
            },
            {
              timeout: 30_000,
              intervals: [250, 500, 750],
              message: 'Alice remainder should snap to 0.04 WETH after Bob partial fill',
            },
          )
          .toBe('40000000000000000');

        await openSwapWorkspace(carolPage);
        await selectCounterpartyInSwap(carolPage, hubId);
        await placeBobMatchingBuyOrder(carolPage, '100', '2500');

        await expect
          .poll(async () => await readSwapOfferCount(alicePage, alice.entityId, alice.signerId, hubId), {
            timeout: 30_000,
            intervals: [250, 500, 750],
          })
          .toBe(0);

        await waitForSwapResolveCountAtLeast(alicePage, alice.entityId, hubId, 2);
        await waitForSwapResolveCountAtLeast(bobPage, bob.entityId, hubId, 1);
        await waitForSwapResolveCountAtLeast(carolPage, carol.entityId, hubId, 1);

        await expect(alicePage.getByTestId('swap-offer-cancel')).toHaveCount(0);
        const closed = await readClosedSwapResolveSnapshots(alicePage, alice.entityId, hubId);
        expect(closed).toHaveLength(2);
        expect(closed.map(fill => [fill.executionGiveAmount, fill.executionWantAmount])).toEqual([
          ['20000000000000000', '50000000'],
          ['40000000000000000', '100000000'],
        ]);
        await alicePage.getByTestId('nav-activity').locator('visible=true').first().click();
        await alicePage.getByRole('button', { name: 'Swaps', exact: true }).click();
        const history = alicePage.getByRole('region', { name: 'Swap history', exact: true });
        await history.getByRole('combobox').selectOption(hubId);
        const order = history.getByTestId('swap-history-order');
        await expect(order).toHaveCount(1);
        await expect(order.locator('summary')).toContainText('Closed · 2 executions');
        await order.locator('summary').click();
        for (const fill of closed) {
          await expect(order.locator(`[data-field="gave"][data-amount="${fill.executionGiveAmount}"]`)).toBeVisible();
          await expect(
            order.locator(`[data-field="received"][data-amount="${fill.executionWantAmount}"]`),
          ).toBeVisible();
        }
        await alicePage.screenshot({ path: testInfo.outputPath('peer-swap-multi.png'), fullPage: true });
      } finally {
        await Promise.all([
          aliceContext ? aliceContext.close().catch(() => {}) : Promise.resolve(),
          bobContext ? bobContext.close().catch(() => {}) : Promise.resolve(),
          carolContext ? carolContext.close().catch(() => {}) : Promise.resolve(),
        ]);
      }
    },
  );

  test(
    'repeated maker and taker cycles accumulate closed swap rows',
    { tag: '@functional' },
    async ({ browser, page }, testInfo) => {
      let aliceContext: BrowserContext | null = null;
      let bobContext: BrowserContext | null = null;

      try {
        const baseline = await ensureE2EBaseline(page, {
          apiBaseUrl: API_BASE_URL,
          requireMarketMaker: false,
          requireHubMesh: true,
          minHubCount: 3,
          forceReset: true,
        });

        const hubId = getPrimaryHubId(baseline);

        aliceContext = await browser.newContext({ ignoreHTTPSErrors: true });
        bobContext = await browser.newContext({ ignoreHTTPSErrors: true });
        const alicePage = await aliceContext.newPage();
        const bobPage = await bobContext.newPage();

        await Promise.all([
          gotoApp(alicePage, { appBaseUrl: APP_BASE_URL, initTimeoutMs: INIT_TIMEOUT, settleMs: 1200 }),
          gotoApp(bobPage, { appBaseUrl: APP_BASE_URL, initTimeoutMs: INIT_TIMEOUT, settleMs: 1200 }),
        ]);

        const alice = await createWalletIdentity(alicePage, 'alice-bench', selectDemoMnemonic('alice'));
        const bob = await createWalletIdentity(bobPage, 'bob-bench', selectDemoMnemonic('bob'));

        await Promise.all([
          connectRuntimeToHubWithCredit(alicePage, alice, hubId, '10000', SWAP_CONNECT_TOKEN_IDS),
          connectRuntimeToHubWithCredit(bobPage, bob, hubId, '10000', SWAP_CONNECT_TOKEN_IDS),
        ]);

        await extendCreditToken(alicePage, hubId, 2, '10000');
        await waitForTokenDeltaActive(alicePage, alice.entityId, hubId, 2);

        await Promise.all([
          faucetOffchain(alicePage, alice.entityId, hubId, 2, '5'),
          faucetOffchain(bobPage, bob.entityId, hubId, 1, '200'),
        ]);

        await Promise.all([
          waitForOutCapAtLeast(alicePage, alice.entityId, hubId, 2, 1n * 10n ** 18n),
          waitForOutCapAtLeast(bobPage, bob.entityId, hubId, 1, wholeSwapTokenUnits(1, 10n)),
        ]);

        await Promise.all([openSwapWorkspace(alicePage), openSwapWorkspace(bobPage)]);
        await Promise.all([selectCounterpartyInSwap(alicePage, hubId), selectCounterpartyInSwap(bobPage, hubId)]);

        for (let round = 1; round <= 3; round += 1) {
          await placeAliceSellOffer(alicePage, '0.01', '2500');
          await placeBobMatchingBuyOrder(bobPage, '25', '2500');

          await expect
            .poll(async () => await readSwapOfferCount(alicePage, alice.entityId, alice.signerId, hubId), {
              timeout: 30_000,
              intervals: [250, 500, 750],
              message: `alice offer should fully close on round ${round}`,
            })
            .toBe(0);

          await expect
            .poll(async () => (await readClosedSwapResolveSnapshots(alicePage, alice.entityId, hubId)).length, {
              timeout: 30_000,
              intervals: [250, 500, 750],
              message: `Alice swapClosedOrders should accumulate round ${round}`,
            })
            .toBeGreaterThanOrEqual(round);

          await expect
            .poll(async () => (await readClosedSwapResolveSnapshots(bobPage, bob.entityId, hubId)).length, {
              timeout: 30_000,
              intervals: [250, 500, 750],
              message: `Bob swapClosedOrders should accumulate round ${round}`,
            })
            .toBeGreaterThanOrEqual(round);

          // History remains an explicit Activity read, never an automatic
          // Account-frame scan during the financial transition.
          for (const peer of [
            { page: alicePage, entityId: alice.entityId, give: '10000000000000000', want: '25000000', fee: null },
            {
              page: bobPage,
              entityId: bob.entityId,
              give: '25000000',
              want: '10000000000000000',
              fee: '1000000000000',
            },
          ]) {
            const closed = await readClosedSwapResolveSnapshots(peer.page, peer.entityId, hubId);
            expect(closed).toHaveLength(round);
            for (const fill of closed) {
              expect(fill.executionGiveAmount).toBe(peer.give);
              expect(fill.executionWantAmount).toBe(peer.want);
              expect(fill.feeAmount).toBe(peer.fee);
              expect(fill.feeTokenId).toBe(peer.fee === null ? null : 2);
            }
            const history = await openSwapHistory(peer.page, hubId);
            const rows = history.getByTestId('swap-history-order');
            await expect(rows).toHaveCount(round);
            const newest = rows.first();
            await expect(newest.locator('summary')).toContainText('Closed');
            await newest.locator('summary').click();
            await expect(newest.locator(`[data-field="gave"][data-amount="${peer.give}"]`)).toBeVisible();
            await expect(newest.locator(`[data-field="received"][data-amount="${peer.want}"]`)).toBeVisible();
            if (peer.fee === null) await expect(newest.locator('[data-field="fee"]')).toHaveCount(0);
            else await expect(newest.locator(`[data-field="fee"][data-amount="${peer.fee}"]`)).toBeVisible();
            if (round < 3) {
              await openSwapWorkspace(peer.page);
              await selectCounterpartyInSwap(peer.page, hubId);
            }
          }
        }
        for (const userPage of [alicePage, bobPage]) {
          await expect(userPage.getByTestId('swap-history-order')).toHaveCount(3);
        }
        await bobPage.screenshot({ path: testInfo.outputPath('peer-swap-cycles.png'), fullPage: true });
      } finally {
        await Promise.all([
          aliceContext ? aliceContext.close().catch(() => {}) : Promise.resolve(),
          bobContext ? bobContext.close().catch(() => {}) : Promise.resolve(),
        ]);
      }
    },
  );

  test(
    'swap round-trip both directions clears holds and updates closed history on both peers',
    { tag: '@functional' },
    async ({ browser, page }, testInfo) => {
      let aliceContext: BrowserContext | null = null;
      let bobContext: BrowserContext | null = null;

      try {
        const baseline = await ensureE2EBaseline(page, {
          apiBaseUrl: API_BASE_URL,
          requireMarketMaker: false,
          requireHubMesh: true,
          minHubCount: 3,
          forceReset: true,
        });

        const hubId = getPrimaryHubId(baseline);

        aliceContext = await browser.newContext({ ignoreHTTPSErrors: true });
        bobContext = await browser.newContext({ ignoreHTTPSErrors: true });
        const alicePage = await aliceContext.newPage();
        const bobPage = await bobContext.newPage();

        await Promise.all([
          gotoApp(alicePage, { appBaseUrl: APP_BASE_URL, initTimeoutMs: INIT_TIMEOUT, settleMs: 1200 }),
          gotoApp(bobPage, { appBaseUrl: APP_BASE_URL, initTimeoutMs: INIT_TIMEOUT, settleMs: 1200 }),
        ]);

        const alice = await createWalletIdentity(alicePage, 'alice-roundtrip', selectDemoMnemonic('alice'));
        const bob = await createWalletIdentity(bobPage, 'bob-roundtrip', selectDemoMnemonic('bob'));

        await Promise.all([
          connectRuntimeToHubWithCredit(alicePage, alice, hubId, '10000', SWAP_CONNECT_TOKEN_IDS),
          connectRuntimeToHubWithCredit(bobPage, bob, hubId, '10000', SWAP_CONNECT_TOKEN_IDS),
        ]);

        await extendCreditToken(alicePage, hubId, 1, '10000');
        await extendCreditToken(bobPage, hubId, 1, '10000');
        await waitForTokenDeltaActive(alicePage, alice.entityId, hubId, 1);
        await waitForTokenDeltaActive(bobPage, bob.entityId, hubId, 1);

        await Promise.all([
          faucetOffchain(alicePage, alice.entityId, hubId, 2, '5'),
          faucetOffchain(bobPage, bob.entityId, hubId, 1, '200'),
        ]);

        await Promise.all([
          waitForOutCapAtLeast(alicePage, alice.entityId, hubId, 2, 1n * 10n ** 18n),
          waitForOutCapAtLeast(bobPage, bob.entityId, hubId, 1, wholeSwapTokenUnits(1, 10n)),
        ]);

        await Promise.all([openSwapWorkspace(alicePage), openSwapWorkspace(bobPage)]);
        await Promise.all([selectCounterpartyInSwap(alicePage, hubId), selectCounterpartyInSwap(bobPage, hubId)]);

        await placeAliceSellOffer(alicePage, '0.01', '2500');
        await placeBobMatchingBuyOrder(bobPage, '25', '2500');

        await expect
          .poll(async () => await readSwapOfferCount(alicePage, alice.entityId, alice.signerId, hubId), {
            timeout: 30_000,
            intervals: [250, 500, 750],
          })
          .toBe(0);
        await expect
          .poll(async () => await readSwapHistoryCount(alicePage, alice.entityId, alice.signerId, hubId), {
            timeout: 30_000,
            intervals: [250, 500, 750],
          })
          .toBeGreaterThanOrEqual(1);
        await expect
          .poll(async () => await readSwapHistoryCount(bobPage, bob.entityId, bob.signerId, hubId), {
            timeout: 30_000,
            intervals: [250, 500, 750],
          })
          .toBeGreaterThanOrEqual(1);

        await Promise.all([
          waitForOutCapAtLeast(bobPage, bob.entityId, hubId, 2, 1n * 10n ** 15n),
          waitForOutCapAtLeast(alicePage, alice.entityId, hubId, 1, wholeSwapTokenUnits(1, 20n)),
        ]);

        await placeAliceSellOffer(bobPage, '0.0095', '2600');
        await placeBobMatchingBuyOrder(alicePage, '24.7', '2600');

        await expect
          .poll(async () => await readSwapOfferCount(bobPage, bob.entityId, bob.signerId, hubId), {
            timeout: 30_000,
            intervals: [250, 500, 750],
          })
          .toBe(0);
        await expect
          .poll(async () => await readSwapHistoryCount(alicePage, alice.entityId, alice.signerId, hubId), {
            timeout: 30_000,
            intervals: [250, 500, 750],
          })
          .toBeGreaterThanOrEqual(2);
        await expect
          .poll(async () => await readSwapHistoryCount(bobPage, bob.entityId, bob.signerId, hubId), {
            timeout: 30_000,
            intervals: [250, 500, 750],
          })
          .toBeGreaterThanOrEqual(2);

        const peerExecutions = [
          {
            page: alicePage,
            entityId: alice.entityId,
            amounts: [
              ['10000000000000000', '25000000'],
              ['24700000', '9500000000000000'],
            ],
          },
          {
            page: bobPage,
            entityId: bob.entityId,
            amounts: [
              ['25000000', '10000000000000000'],
              ['9500000000000000', '24700000'],
            ],
          },
        ];
        for (const peer of peerExecutions) {
          const closed = await readClosedSwapResolveSnapshots(peer.page, peer.entityId, hubId);
          expect(closed).toHaveLength(2);
          expect(closed.map(fill => [fill.executionGiveAmount, fill.executionWantAmount])).toEqual(
            expect.arrayContaining(peer.amounts),
          );
          await peer.page.getByTestId('nav-activity').locator('visible=true').first().click();
          await peer.page.getByRole('button', { name: 'Swaps', exact: true }).click();
          const history = peer.page.getByRole('region', { name: 'Swap history', exact: true });
          await history.getByRole('combobox').selectOption(hubId);
          const orders = history.getByTestId('swap-history-order');
          await expect(orders).toHaveCount(2);
          for (const order of await orders.all()) {
            await expect(order.locator('summary')).toContainText('Closed · 1 executions');
            await order.locator('summary').click();
          }
          for (const [give, want] of peer.amounts) {
            await expect(history.locator(`[data-field="gave"][data-amount="${give}"]`)).toBeVisible();
            await expect(history.locator(`[data-field="received"][data-amount="${want}"]`)).toBeVisible();
          }
        }
        await alicePage.screenshot({ path: testInfo.outputPath('peer-swap-roundtrip.png'), fullPage: true });

        await expect
          .poll(async () => await holdTotal(alicePage, alice.entityId, hubId, 1), {
            timeout: 20_000,
            intervals: [250, 500, 750],
          })
          .toBe(0n);
        await expect
          .poll(async () => await holdTotal(alicePage, alice.entityId, hubId, 2), {
            timeout: 20_000,
            intervals: [250, 500, 750],
          })
          .toBe(0n);
        await expect
          .poll(async () => await holdTotal(bobPage, bob.entityId, hubId, 1), {
            timeout: 20_000,
            intervals: [250, 500, 750],
          })
          .toBe(0n);
        await expect
          .poll(async () => await holdTotal(bobPage, bob.entityId, hubId, 2), {
            timeout: 20_000,
            intervals: [250, 500, 750],
          })
          .toBe(0n);
      } finally {
        await Promise.all([
          aliceContext ? aliceContext.close().catch(() => {}) : Promise.resolve(),
          bobContext ? bobContext.close().catch(() => {}) : Promise.resolve(),
        ]);
      }
    },
  );
});
