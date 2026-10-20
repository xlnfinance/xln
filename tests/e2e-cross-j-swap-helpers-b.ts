import { formatUnits, parseUnits } from 'ethers';
import { getTokenInfo } from '../core/account/utils';
import { deriveTransferOffdeltaChange } from '../core/protocol/transform/delta-movement';
import {
  API_BASE_URL,
  CROSS_J_SOURCE_COMMITTED_OR_ADVANCED_STATUSES,
  CrossDeltaSnapshot,
  CrossCloseSnapshot,
  CrossRuntimeWindow,
  RuntimeIdentity,
  TOKEN_SYMBOL_BY_ID,
  USDC,
  WETH,
  configureTokens,
  dismissSwapCompletionModal,
  escapeRegex,
  flushRuntime,
  openSwapWorkspace,
  selectCounterpartyInSwap,
  selectCrossRoute,
  selectSourceChainInSwap,
} from './e2e-cross-j-swap-helpers-a';
import { expect, type Page } from './global-setup.mts';
import { enqueueEntityTxs } from './utils/runtime/e2e-runtime-input';

export async function expectCrossOrderbookReady(
  page: Page,
  options: { titlePattern?: RegExp; pairIdPattern?: RegExp } = {},
): Promise<void> {
  const orderbook = page.getByTestId('orderbook').locator('visible=true').first();
  await expect(orderbook, 'cross route must keep its orderbook visible').toBeVisible({ timeout: 20_000 });
  await expect(
    orderbook,
    'cross route must subscribe to its canonical venue, never a numeric same-chain pair',
  ).toHaveAttribute('data-pair-id', options.pairIdPattern ?? /^cross:/, { timeout: 20_000 });
  await expect(orderbook.locator('.bk-head .caps'), 'cross title must disambiguate token jurisdictions').toContainText(
    options.titlePattern ?? /\((Testnet|Tron)\)\s*-\s*.*\((Testnet|Tron)\)/,
    { timeout: 10_000 },
  );
  // The current wallet selects each asset with its real token picker, not a second pair selector.
  await expect(page.getByTestId('swap-give').locator('..').getByRole('button', { name: /./ })).toBeVisible();
  await expect(page.getByTestId('swap-want').locator('..').getByRole('button', { name: /./ })).toBeVisible();
  await expect(orderbook, 'cross orderbook must resolve to a current (possibly empty) snapshot').toHaveAttribute(
    'data-status',
    'live',
    { timeout: 20_000 },
  );
  const relayCheck = await orderbook.evaluate(node => {
    const normalizeWs = (value: string): string => {
      if (!value) return '';
      const parsed = new URL(value, window.location.origin);
      if (parsed.protocol === 'http:') parsed.protocol = 'ws:';
      if (parsed.protocol === 'https:') parsed.protocol = 'wss:';
      parsed.searchParams.set('protocol', 'market');
      return parsed.toString();
    };
    const hubId = String(node.getAttribute('data-hub-id') || '');
    const relayUrl = normalizeWs(String(node.getAttribute('data-relay-url') || ''));
    const profile = (window as CrossRuntimeWindow).__xln?.env()?.gossip?.getProfile(hubId);
    return { hubId, relayUrl, expectedRelayUrl: normalizeWs(profile?.relays[0] ?? '') };
  });
  expect(relayCheck.hubId, 'cross orderbook must expose the canonical book owner').toMatch(/^0x[a-f0-9]{64}$/);
  const connectedRelay = new URL(relayCheck.relayUrl);
  expect(connectedRelay.pathname).toBe('/relay');
  expect(connectedRelay.searchParams.get('protocol')).toBe('market');
  expect(relayCheck.expectedRelayUrl, 'the selected book owner must advertise its relay').not.toBe('');
  expect(relayCheck.relayUrl).toBe(relayCheck.expectedRelayUrl);
  await expect(orderbook.getByTestId('orderbook-source-status')).not.toContainText(/syncing/i);
}

export async function expectDirectCrossOrderbookReady(page: Page): Promise<void> {
  await expectCrossOrderbookReady(page);
}

export async function expectSwapTokens(page: Page, fromTokenId: number, toTokenId: number): Promise<void> {
  const fromSymbol = TOKEN_SYMBOL_BY_ID[fromTokenId];
  const toSymbol = TOKEN_SYMBOL_BY_ID[toTokenId];
  expect(fromSymbol, `missing token symbol for ${fromTokenId}`).toBeTruthy();
  expect(toSymbol, `missing token symbol for ${toTokenId}`).toBeTruthy();
  const fromToken = page.getByTestId('swap-give').locator('..').getByRole('button');
  const toToken = page.getByTestId('swap-want').locator('..').getByRole('button');
  await expect(fromToken).toHaveAccessibleName(new RegExp(`^${fromSymbol}(?:\\s|$)`), { timeout: 10_000 });
  await expect(toToken).toHaveAccessibleName(new RegExp(`^${toSymbol}(?:\\s|$)`), { timeout: 10_000 });
}

export async function expectSwapAssetRoute(
  page: Page,
  fromTokenId: number,
  sourceJurisdiction: string,
  toTokenId: number,
  targetJurisdiction: string,
): Promise<void> {
  await expectSwapTokens(page, fromTokenId, toTokenId);
  const routeFlow = page.getByTestId('swap-screen');
  await expect
    .poll(
      async () => ({
        mode: String((await routeFlow.getAttribute('data-route-mode')) || ''),
        sourceJurisdiction: String((await routeFlow.getAttribute('data-source-jurisdiction')) || ''),
        targetJurisdiction: String((await routeFlow.getAttribute('data-target-jurisdiction')) || ''),
      }),
      {
        timeout: 10_000,
        intervals: [100, 250, 500],
        message: 'swap asset identity must include both token and jurisdiction',
      },
    )
    .toMatchObject({
      mode: 'cross',
      sourceJurisdiction,
      targetJurisdiction,
    });
}

export function visibleOrderbookRow(page: Page, side: 'ask' | 'bid') {
  return page
    .getByTestId('orderbook')
    .locator('visible=true')
    .first()
    .getByTestId(side === 'ask' ? 'book-row-ask' : 'book-row-bid')
    .first();
}

async function readSwapLimitPrice(page: Page): Promise<string> {
  const price = page.getByTestId('swap-limit-price');
  if ((await price.count()) === 0) return '';
  return String(await price.textContent())
    .trim()
    .split(/\s+/)[0]!
    .replace(/,/g, '');
}

export async function clickCrossOrderbookLevel(
  page: Page,
  side: 'ask' | 'bid',
  expectedFromTokenId: number,
  expectedToTokenId: number,
): Promise<void> {
  const row = visibleOrderbookRow(page, side);
  await expect(row, `cross ${side} row must be visible before clicking the orderbook`).toBeVisible({ timeout: 30_000 });
  const clickedDisplayedPrice = String((await row.locator('.bk-price').textContent()) || '').trim();
  // A fill completed while this wallet was configuring the next order can
  // legitimately surface its confirmation dialog now. A real user closes it
  // before interacting with the book; the E2E must do the same, never click
  // through the modal overlay.
  await dismissSwapCompletionModal(page);
  await row.click({ timeout: 10_000 });
  await expectSwapTokens(page, expectedFromTokenId, expectedToTokenId);
  await expect
    .poll(async () => String(await page.getByTestId('swap-give').inputValue()).trim(), {
      timeout: 10_000,
      intervals: [50, 100, 200],
    })
    .not.toBe('');
  if (clickedDisplayedPrice) {
    await expect
      .poll(async () => String(await readSwapLimitPrice(page)).trim(), {
        timeout: 10_000,
        intervals: [50, 100, 200],
      })
      .toBe(clickedDisplayedPrice.replace(/,/g, '').trim());
  }
}

export async function expectCrossNonTakeableClickNoop(
  page: Page,
  side: 'ask' | 'bid',
  expectedFromTokenId: number,
  expectedToTokenId: number,
): Promise<void> {
  const panel = page.getByTestId('orderbook').locator('visible=true').first();
  const row = visibleOrderbookRow(page, side);
  await expect(row, `cross ${side} row must be visible to prove wrong-side click behavior`).toBeVisible({
    timeout: 20_000,
  });
  const before = {
    pairId: String((await panel.getAttribute('data-pair-id')) || ''),
    hubIds: String((await panel.getAttribute('data-hub-id')) || ''),
    amount: String(await page.getByTestId('swap-give').inputValue()).trim(),
    price: String(await readSwapLimitPrice(page)).trim(),
    minimum: await page.getByTestId('swap-want').inputValue(),
  };
  expect(before.pairId, 'cross wrong-side click guard needs an active cross venue').toMatch(/^cross:/);

  await row.click({ timeout: 10_000 });
  await expectSwapTokens(page, expectedFromTokenId, expectedToTokenId);
  await expect(page.getByTestId('swap-want')).toHaveValue(before.minimum);
  await expect
    .poll(async () => String((await panel.getAttribute('data-pair-id')) || ''), {
      timeout: 5_000,
      intervals: [50, 100, 200],
      message: 'cross wrong-side click must not switch the visible venue',
    })
    .toBe(before.pairId);
  await expect
    .poll(async () => String((await panel.getAttribute('data-hub-id')) || ''), {
      timeout: 5_000,
      intervals: [50, 100, 200],
      message: 'cross wrong-side click must not switch the visible book hub',
    })
    .toBe(before.hubIds);
  await expect
    .poll(async () => String(await page.getByTestId('swap-give').inputValue()).trim(), {
      timeout: 5_000,
      intervals: [50, 100, 200],
      message: 'cross wrong-side click must not pin an amount from a non-takeable level',
    })
    .toBe(before.amount);
  await expect
    .poll(async () => String(await readSwapLimitPrice(page)).trim(), {
      timeout: 5_000,
      intervals: [50, 100, 200],
      message: 'cross wrong-side click must not pin a stale price from another route',
    })
    .toBe(before.price);
}

export async function placeCrossOrder(
  page: Page,
  params: {
    source: RuntimeIdentity;
    hubId: string;
    targetEntityId: string;
    side: 'buy' | 'sell';
    amount: string;
    price: string;
    fromTokenId?: number;
    toTokenId?: number;
    screenshotPath?: string;
  },
): Promise<string> {
  const flowStartedAt = Date.now();
  const emitPhaseTiming = (phase: string, startedAt: number): void => {
    console.log(`[E2E-TIMING] cross_j_order.${phase} ${Date.now() - startedAt}ms`);
  };
  const fromTokenId = params.fromTokenId ?? (params.side === 'buy' ? USDC : WETH);
  const toTokenId = params.toTokenId ?? (params.side === 'buy' ? WETH : USDC);
  const giveDecimals = getTokenInfo(fromTokenId).decimals;
  const wantDecimals = getTokenInfo(toTokenId).decimals;
  const give = parseUnits(params.amount, giveDecimals);
  const {
    requantizeRemainingSwapAtPriceForDimensions,
  }: typeof import('../core/swapbook/types') = require('../core/swapbook/types');
  const take = requantizeRemainingSwapAtPriceForDimensions(fromTokenId, toTokenId, give, parseUnits(params.price, 4), {
    giveTokenDecimals: giveDecimals,
    wantTokenDecimals: wantDecimals,
  });
  if (!take) throw new Error('CROSS_ORDER_NOT_REPRESENTABLE');
  expect(take.effectiveGive, 'the requested source amount must be exactly representable').toBe(give);
  await openSwapWorkspace(page);
  await selectSourceChainInSwap(page, params.source.entityId);
  await selectCrossRoute(page, params.targetEntityId);
  await configureTokens(page, fromTokenId, toTokenId);
  await selectCounterpartyInSwap(page, params.hubId);
  const safety = page.getByTestId('cross-swap-safety');
  await expect(safety).toContainText('Stay online');
  await expect(safety).toContainText('Cancel rest');
  // React deliberately has no live cross-network quote. The caller supplies an
  // explicit limit; the public book is only an observation, never an order UI.
  await expect(page.getByTestId('swap-quote-note')).toContainText('not a live cross-network quote');
  const amountInput = page.getByTestId('swap-give');
  const minimumInput = page.getByTestId('swap-want');
  const submit = page.getByTestId('swap-submit');
  await amountInput.fill(params.amount);
  await minimumInput.fill(formatUnits(take.effectiveWant, wantDecimals));
  await expect(amountInput).toHaveValue(params.amount);
  await expect(minimumInput).toHaveValue(formatUnits(take.effectiveWant, wantDecimals));
  const beforeSubmit = await readCrossState(page, params.source, params.hubId);
  const beforeHeight = beforeSubmit.currentHeight;
  const beforeRouteIds = new Set(beforeSubmit.routeSummaries.map(route => route.orderId));
  const beforeOfferIds = new Set(beforeSubmit.offerSummaries.map(offer => offer.offerId));
  if (params.screenshotPath) await page.screenshot({ path: params.screenshotPath, fullPage: true });
  await expect(submit).toBeEnabled({ timeout: 30_000 });
  emitPhaseTiming('pre_submit', flowStartedAt);
  const clickStartedAt = Date.now();
  await page.evaluate(() => {
    (window as CrossRuntimeWindow & { __crossJClickAt?: number }).__crossJClickAt = Date.now();
  });
  await submit.click();
  emitPhaseTiming('click_dispatch', clickStartedAt);
  let lastSubmitState: unknown = null;
  let createdOrderId = '';
  try {
    await expect
      .poll(
        async () => {
          const state = await readCrossState(page, params.source, params.hubId);
          const newRoutes = state.routeSummaries.filter(route => !beforeRouteIds.has(route.orderId));
          const newOffers = state.offerSummaries.filter(offer => !beforeOfferIds.has(offer.offerId));
          lastSubmitState = {
            ok: newRoutes.length > 0 || newOffers.length > 0,
            routes: state.routes,
            offers: state.offers,
            newRoutes: newRoutes.map(route => ({ orderId: route.orderId, status: route.status })),
            newOffers: newOffers.map(offer => ({ offerId: offer.offerId, status: offer.status })),
            recentMessages: state.messages.slice(-8),
          };
          createdOrderId = newRoutes[0]?.orderId || newOffers[0]?.offerId || '';
          return lastSubmitState;
        },
        {
          message: 'cross-j order submit must create a route or a cross-j offer in live runtime',
          timeout: 30_000,
          intervals: [500, 1_000, 2_000],
        },
      )
      .toMatchObject({ ok: true });
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\nlastSubmitState=${JSON.stringify(lastSubmitState, null, 2)}`,
    );
  }
  expect(createdOrderId, 'cross-j order submit must return exact created orderId').toBeTruthy();
  emitPhaseTiming('click_to_route', clickStartedAt);
  const browserMeasures = await page.evaluate(() =>
    performance
      .getEntriesByType('measure')
      .filter(entry => entry.name.startsWith('xln.cross_j.'))
      .slice(-8)
      .map(entry => ({ name: entry.name, duration: Math.round(entry.duration) })),
  );
  for (const measure of browserMeasures) {
    console.log(`[E2E-TIMING] ${measure.name} ${measure.duration}ms`);
  }
  let lastCommitState: unknown = null;
  try {
    await expect
      .poll(
        async () => {
          await flushRuntime(page, 1);
          const state = await readCrossState(page, params.source, params.hubId);
          lastCommitState = {
            currentHeight: state.currentHeight,
            beforeHeight,
            hasPendingFrame: state.hasPendingFrame,
            pendingTxs: state.pendingTxs,
            mempoolTxs: state.mempoolTxs,
            offers: state.offers,
            route: state.routeSummaries.find(route => route.orderId === createdOrderId) || null,
            pendingOutputs: state.pendingOutputs,
            pendingNetworkOutputs: state.pendingNetworkOutputs,
            runtimeMempoolInputs: state.runtimeMempoolInputs,
            p2pState: state.p2pState,
            messages: state.messages.slice(-10),
          };
          const route = state.routeSummaries.find(candidate => candidate.orderId === createdOrderId);
          // The User Runtime commits both Account legs atomically after matching
          // the Hub-signed proposal pair. The human-readable terminal message is
          // emitted later by the Hub when both ACKs commit, so waiting for the old
          // source-only message here adds a protocol round trip that no longer
          // exists. The paired pull bindings and canonical route status are the
          // state-level proof of User-side admission.
          const accountPairCommittedOrAdvanced =
            Boolean(route?.sourcePull && route?.targetPull) &&
            CROSS_J_SOURCE_COMMITTED_OR_ADVANCED_STATUSES.has(String(route?.status || ''));
          const sourceQueuesDrained =
            !state.hasPendingFrame &&
            state.pendingTxs.length === 0 &&
            state.mempoolTxs.length === 0 &&
            state.runtimeMempoolInputs.length === 0;
          return {
            committed: state.currentHeight > beforeHeight && accountPairCommittedOrAdvanced && sourceQueuesDrained,
            currentHeight: state.currentHeight,
            hasPendingFrame: state.hasPendingFrame,
            routeStatus: route?.status || '',
            sourcePull: Boolean(route?.sourcePull),
            targetPull: Boolean(route?.targetPull),
          };
        },
        {
          message: `cross-j order ${createdOrderId} must reach source-committed state before matching or advance through a valid fill path`,
          timeout: 75_000,
          intervals: [250, 500, 1000],
        },
      )
      .toMatchObject({ committed: true });
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\nlastCommitState=${JSON.stringify(lastCommitState, null, 2)}`,
    );
  }
  emitPhaseTiming('click_to_source_commit', clickStartedAt);
  return createdOrderId;
}

export async function readCrossState(
  page: Page,
  identity: RuntimeIdentity,
  hubId: string,
): Promise<{
  offers: number;
  routes: number;
  pulls: number;
  currentHeight: number;
  hasPendingFrame: boolean;
  pendingTxs: string[];
  mempoolTxs: string[];
  settledRoutes: number;
  claimedRoutes: number;
  replicaFound: boolean;
  accountFound: boolean;
  accountKeys: string[];
  messages: string[];
  routeSummaries: Array<{
    orderId: string;
    status: string;
    fillSeq: number;
    cumulativeFillRatio: number;
    filledSourceAmount: string;
    filledTargetAmount: string;
    sourcePull: boolean;
    targetPull: boolean;
    sourcePullId: string;
    targetPullId: string;
    bookOwnerEntityId: string;
    sourceEntityId: string;
    sourceCounterpartyEntityId: string;
    targetEntityId: string;
    targetCounterpartyEntityId: string;
    venueId: string;
    priceTicks: string;
    pendingClearRequestedAt: number;
    updatedAt: number;
  }>;
  offerSummaries: Array<{
    offerId: string;
    status: string;
    amount: string;
    cross: boolean;
  }>;
  pullIds: string[];
  pendingOutputs: Array<{ entityId: string; signerId: string; txTypes: string[]; frame: boolean; precommits: number }>;
  pendingNetworkOutputs: Array<{
    entityId: string;
    signerId: string;
    runtimeId: string;
    txTypes: string[];
    frame: boolean;
    precommits: number;
  }>;
  runtimeMempoolInputs: Array<{
    entityId: string;
    signerId: string;
    txTypes: string[];
    frame: boolean;
    precommits: number;
  }>;
  p2pState: { exists: boolean; connected: boolean; queue: unknown; directPeers: unknown };
  ownerIsLeft: boolean;
  deltas: Record<string, CrossDeltaSnapshot>;
}> {
  return await page.evaluate(
    ({ identity, hubId }) => {
      const view = window as CrossRuntimeWindow;
      const env = view.__xln?.env();
      const connectivity = view.__xln?.runtimeConnectivity;
      const entityNeedle = String(identity.entityId || '').toLowerCase();
      const signerNeedle = String(identity.signerId || '').toLowerCase();
      const hubNeedle = String(hubId || '').toLowerCase();
      let replica = env?.state.eReplicas?.get(`${entityNeedle}:${signerNeedle}`);
      if (!replica && env?.state.eReplicas instanceof Map) {
        for (const [key, candidate] of env.state.eReplicas.entries()) {
          const keyText = String(key || '').toLowerCase();
          const candidateEntity = String(candidate?.state?.entityId || candidate?.entityId || '').toLowerCase();
          const candidateSigner = String(candidate?.signerId || '').toLowerCase();
          if (
            candidateEntity === entityNeedle ||
            keyText.startsWith(`${entityNeedle}:`) ||
            (keyText.includes(entityNeedle) &&
              (!signerNeedle || keyText.includes(signerNeedle) || candidateSigner === signerNeedle))
          ) {
            replica = candidate;
            break;
          }
        }
      }
      const state = replica?.state;
      let account = state?.accounts?.get(hubId) || state?.accounts?.get(hubNeedle);
      if (!account && state?.accounts instanceof Map) {
        for (const [key, candidate] of state.accounts.entries()) {
          const keyText = String(key || '').toLowerCase();
          const left = String(candidate?.leftEntity || '').toLowerCase();
          const right = String(candidate?.rightEntity || '').toLowerCase();
          const cp = String(candidate?.counterpartyEntityId || '').toLowerCase();
          if (keyText === hubNeedle || cp === hubNeedle || left === hubNeedle || right === hubNeedle) {
            account = candidate;
            break;
          }
        }
      }
      let offers = 0;
      for (const offer of account?.state?.swapOffers?.values?.() || []) {
        if (offer?.crossJurisdiction) offers += 1;
      }
      let settledRoutes = 0;
      let claimedRoutes = 0;
      const routeSummaries = [];
      for (const route of state?.crossJurisdictionSwaps?.values?.() || []) {
        const status = String(route?.status || '');
        const orderId = String(route?.orderId || '');
        const filledTargetAmount = BigInt(route?.filledTargetAmount ?? route?.targetClaimed ?? 0n);
        if (status === 'settled') settledRoutes += 1;
        if (status === 'settled') claimedRoutes += 1;
        routeSummaries.push({
          orderId,
          status,
          fillSeq: Number(route?.fillSeq || 0),
          cumulativeFillRatio: Number(route?.cumulativeFillRatio || route?.claimedRatio || 0),
          filledSourceAmount: String(route?.filledSourceAmount ?? route?.sourceClaimed ?? '0'),
          filledTargetAmount: String(filledTargetAmount),
          sourcePull: Boolean(route?.sourcePull),
          targetPull: Boolean(route?.targetPull),
          sourcePullId: String(route?.sourcePull?.pullId || ''),
          targetPullId: String(route?.targetPull?.pullId || ''),
          bookOwnerEntityId: String(route?.bookOwnerEntityId || route?.source?.counterpartyEntityId || ''),
          sourceEntityId: String(route?.source?.entityId || ''),
          sourceCounterpartyEntityId: String(route?.source?.counterpartyEntityId || ''),
          targetEntityId: String(route?.target?.entityId || ''),
          targetCounterpartyEntityId: String(route?.target?.counterpartyEntityId || ''),
          venueId: String(route?.venueId || ''),
          priceTicks: String(route?.priceTicks ?? '0'),
          pendingClearRequestedAt: Number(route?.pendingClearRequestedAt || 0),
          updatedAt: Number(route?.updatedAt || route?.createdAt || 0),
        });
      }
      const ownerIsLeft = entityNeedle === String(account?.state?.leftEntity || '').toLowerCase();
      return {
        offers,
        routes: Number(state?.crossJurisdictionSwaps?.size || 0),
        pulls: Number(account?.state?.pulls?.size || 0),
        currentHeight: Number(account?.currentHeight || 0),
        hasPendingFrame: Boolean(account?.pendingFrame),
        pendingTxs: Array.from(account?.pendingFrame?.accountTxs || []).map((tx: any) => String(tx?.type || '')),
        mempoolTxs: Array.from(account?.mempool || []).map((tx: any) => String(tx?.type || '')),
        settledRoutes,
        claimedRoutes,
        replicaFound: Boolean(replica),
        accountFound: Boolean(account),
        accountKeys: Array.from(state?.accounts?.keys?.() || []).map((key: unknown) => String(key)),
        messages: Array.from(state?.messages || []).map((message: unknown) => String(message)),
        routeSummaries,
        offerSummaries: Array.from(account?.state?.swapOffers?.entries?.() || []).map(
          ([offerId, offer]: [string, any]) => ({
            offerId: String(offerId),
            status: String(offer?.crossJurisdiction?.status || ''),
            amount: String(offer?.amount ?? '0'),
            cross: Boolean(offer?.crossJurisdiction),
          }),
        ),
        pullIds: Array.from(account?.state?.pulls?.keys?.() || []).map((pullId: unknown) => String(pullId)),
        pendingOutputs: Array.from(env?.pendingOutputs || []).map((input: any) => ({
          entityId: String(input?.entityId || ''),
          signerId: String(input?.signerId || ''),
          txTypes: Array.from(input?.entityTxs || []).map((tx: any) => String(tx?.type || '')),
          frame: Boolean(input?.proposedFrame),
          precommits: Number(input?.hashPrecommits?.size || 0),
        })),
        pendingNetworkOutputs: Array.from(env?.pendingNetworkOutputs || []).map((input: any) => ({
          entityId: String(input?.entityId || ''),
          signerId: String(input?.signerId || ''),
          runtimeId: String(input?.runtimeId || ''),
          txTypes: Array.from(input?.entityTxs || []).map((tx: any) => String(tx?.type || '')),
          frame: Boolean(input?.proposedFrame),
          precommits: Number(input?.hashPrecommits?.size || 0),
        })),
        runtimeMempoolInputs: Array.from(
          env?.runtimeMempool?.entityInputs || env?.runtimeInput?.entityInputs || [],
        ).map((input: any) => ({
          entityId: String(input?.entityId || ''),
          signerId: String(input?.signerId || ''),
          txTypes: Array.from(input?.entityTxs || []).map((tx: any) => String(tx?.type || '')),
          frame: Boolean(input?.proposedFrame),
          precommits: Number(input?.hashPrecommits?.size || 0),
        })),
        p2pState: {
          exists: Boolean(connectivity),
          connected: connectivity?.connected === true,
          queue: connectivity?.queue ?? null,
          directPeers: connectivity?.directPeers ?? null,
        },
        ownerIsLeft,
        deltas: Object.fromEntries(
          Array.from(account?.state?.deltas?.entries?.() || []).map(([tokenId, delta]: [unknown, any]) => [
            String(tokenId),
            {
              tokenId: Number(tokenId),
              collateral: String(delta?.collateral ?? 0n),
              ondelta: String(delta?.ondelta ?? 0n),
              offdelta: String(delta?.offdelta ?? 0n),
              leftCreditLimit: String(delta?.leftCreditLimit ?? 0n),
              rightCreditLimit: String(delta?.rightCreditLimit ?? 0n),
              leftAllowance: String(delta?.leftAllowance ?? 0n),
              rightAllowance: String(delta?.rightAllowance ?? 0n),
              leftHold: String(delta?.leftHold ?? 0n),
              rightHold: String(delta?.rightHold ?? 0n),
            },
          ]),
        ),
      };
    },
    { identity, hubId },
  );
}

export async function readHubCrossDeltas(
  page: Page,
  hubEntityId: string,
  counterpartyEntityId: string,
  tokenIds: readonly number[],
): Promise<Record<string, CrossDeltaSnapshot>> {
  const response = await page.request.get(`${API_BASE_URL}/api/hub/account-status`, {
    params: {
      hubEntityId,
      counterpartyEntityId,
      tokenIds: tokenIds.join(','),
    },
  });
  const body = (await response.json().catch(() => null)) as any;
  expect(response.ok(), `hub Account financial status failed: ${JSON.stringify(body)}`).toBe(true);
  expect(body?.success).toBe(true);
  return Object.fromEntries(
    (Array.isArray(body?.tokens) ? body.tokens : []).map((token: any) => [
      String(token?.tokenId),
      {
        ...token?.delta,
        tokenId: Number(token?.tokenId),
        leftAllowance: String(token?.delta?.leftAllowance ?? 0),
        rightAllowance: String(token?.delta?.rightAllowance ?? 0),
      },
    ]),
  );
}

export function expectCrossTransfer(
  before: CrossDeltaSnapshot,
  after: CrossDeltaSnapshot,
  amount: bigint,
  ownerIsLeft: boolean,
  direction: 'spend' | 'receive',
  label: string,
  feeAmount = 0n,
): void {
  expect(amount, `${label} amount must be positive`).toBeGreaterThan(0n);
  expect(feeAmount, `${label} fee must not be negative`).toBeGreaterThanOrEqual(0n);
  expect(feeAmount, `${label} fee must not consume the transfer`).toBeLessThan(amount);
  const senderIsLeft = direction === 'spend' ? ownerIsLeft : !ownerIsLeft;
  expect(
    BigInt(after.offdelta) - BigInt(before.offdelta),
    `${label} must apply the exact canonical offdelta movement net of its signed fee`,
  ).toBe(deriveTransferOffdeltaChange(senderIsLeft, amount - feeAmount));
  expect({ leftHold: after.leftHold, rightHold: after.rightHold }, `${label} must clear both bilateral holds`).toEqual({
    leftHold: '0',
    rightHold: '0',
  });
}

export async function waitForCrossPullFlow(
  page: Page,
  source: RuntimeIdentity,
  target: RuntimeIdentity,
  sourceHubId: string,
  targetHubId: string,
  options: { sourceRouteId?: string; targetRouteId?: string } = {},
): Promise<void> {
  try {
    await expect
      .poll(
        async () => {
          const sourceState = await readCrossState(page, source, sourceHubId);
          const targetState = await readCrossState(page, target, targetHubId);
          const sourceRoute = options.sourceRouteId
            ? sourceState.routeSummaries.find(route => route.orderId === options.sourceRouteId)
            : sourceState.routeSummaries.find(
                route => route.sourcePull || route.targetPull || ['settled'].includes(route.status),
              );
          const targetRoute = options.targetRouteId
            ? targetState.routeSummaries.find(route => route.orderId === options.targetRouteId)
            : targetState.routeSummaries.find(
                route => route.sourcePull || route.targetPull || ['settled'].includes(route.status),
              );
          const routeHasProgress = (route: typeof sourceRoute): boolean =>
            Boolean(route) && (route.cumulativeFillRatio > 0 || ['settled'].includes(route.status));
          const targetHasDurablePreparedPull = Boolean(
            targetRoute?.targetPullId &&
            targetState.pullIds.includes(targetRoute.targetPullId) &&
            ['target_prepared', 'resting', 'partially_filled', 'clear_requested', 'clearing'].includes(
              targetRoute.status,
            ),
          );
          const sourceHasCommittedFill = routeHasProgress(sourceRoute);
          const targetHasClaimedFill = routeHasProgress(targetRoute);
          const targetHasPreparedOrClaimedPull = targetHasDurablePreparedPull || targetHasClaimedFill;
          return {
            ok: sourceHasCommittedFill && targetHasPreparedOrClaimedPull,
            sourceHasCommittedFill,
            targetHasDurablePreparedPull,
            targetHasClaimedFill,
            targetHasPreparedOrClaimedPull,
            sourceRouteStatus: sourceRoute?.status || '',
            targetRouteStatus: targetRoute?.status || '',
            sourceRouteId: sourceRoute?.orderId || '',
            targetRouteId: targetRoute?.orderId || '',
            sourceRoutes: sourceState.routes,
            targetRoutes: targetState.routes,
            sourcePulls: sourceState.pulls,
            targetPulls: targetState.pulls,
            sourceClaimed: sourceState.claimedRoutes,
            targetClaimed: targetState.claimedRoutes,
            sourceReplicaFound: sourceState.replicaFound,
            sourceAccountFound: sourceState.accountFound,
            targetReplicaFound: targetState.replicaFound,
            targetAccountFound: targetState.accountFound,
            sourceAccountKeys: sourceState.accountKeys,
            targetAccountKeys: targetState.accountKeys,
          };
        },
        {
          timeout: 60_000,
          intervals: [250, 500, 1000],
          message: 'cross-j match must materialize prepared pull routes or settled pull claims',
        },
      )
      .toMatchObject({
        ok: true,
        sourceHasCommittedFill: true,
        targetHasPreparedOrClaimedPull: true,
      });
  } catch (error) {
    const [sourceState, targetState] = await Promise.all([
      readCrossState(page, source, sourceHubId),
      readCrossState(page, target, targetHubId),
    ]);
    const replicas = await page.evaluate(() => {
      const env = (window as CrossRuntimeWindow).__xln?.env();
      return Array.from(env?.state.eReplicas?.entries?.() || []).map(([key, replica]: [string, any]) => {
        const state = replica?.state;
        return {
          key: String(key || ''),
          entityId: String(state?.entityId || replica?.entityId || ''),
          signerId: String(replica?.signerId || ''),
          profileName: String(state?.profile?.name || ''),
          jurisdiction: String(state?.config?.jurisdiction?.name || ''),
          accounts: Array.from(state?.accounts?.entries?.() || []).map(([accountId, account]: [string, any]) => ({
            accountId: String(accountId || ''),
            currentHeight: Number(account?.currentHeight || 0),
            mempool: Array.from(account?.mempool || []).map((tx: any) => String(tx?.type || '')),
            pendingFrame: Array.from(account?.pendingFrame?.accountTxs || []).map((tx: any) => String(tx?.type || '')),
            offers: Array.from(account?.state?.swapOffers?.entries?.() || []).map(
              ([offerId, offer]: [string, any]) => ({
                offerId: String(offerId || ''),
                cross: Boolean(offer?.crossJurisdiction),
                status: String(offer?.crossJurisdiction?.status || ''),
              }),
            ),
            pulls: Array.from(account?.state?.pulls?.keys?.() || []).map(String),
          })),
          routes: Array.from(state?.crossJurisdictionSwaps?.entries?.() || []).map(
            ([orderId, route]: [string, any]) => ({
              orderId: String(orderId || ''),
              status: String(route?.status || ''),
              source: String(route?.source?.entityId || ''),
              sourceHub: String(route?.source?.counterpartyEntityId || ''),
              targetHub: String(route?.target?.entityId || ''),
              target: String(route?.target?.counterpartyEntityId || ''),
            }),
          ),
          messages: Array.from(state?.messages || [])
            .slice(-20)
            .map(String),
        };
      });
    });
    console.log(
      '[E2E cross pull flow debug]',
      JSON.stringify(
        {
          source: {
            entityId: source.entityId,
            hubId: sourceHubId,
            routes: sourceState.routeSummaries,
            offers: sourceState.offerSummaries,
            pulls: sourceState.pullIds,
            accountKeys: sourceState.accountKeys,
            messages: sourceState.messages.slice(-20),
          },
          target: {
            entityId: target.entityId,
            hubId: targetHubId,
            routes: targetState.routeSummaries,
            offers: targetState.offerSummaries,
            pulls: targetState.pullIds,
            accountKeys: targetState.accountKeys,
            messages: targetState.messages.slice(-20),
          },
          replicas,
        },
        null,
        2,
      ),
    );
    throw error;
  }
}

export async function readCrossCloseSnapshots(
  page: Page,
  entityId: string,
  counterpartyId: string,
  orderId: string,
): Promise<CrossCloseSnapshot[]> {
  return await page.evaluate(
    async ({ entityId, counterpartyId, orderId }) => {
      const runtime = (window as CrossRuntimeWindow).__xln;
      const env = runtime?.env();
      if (!runtime || !env) throw new Error('CROSS_CLOSE_RUNTIME_MISSING');
      const api = await runtime.xln();
      const owner = entityId.toLowerCase();
      const cp = counterpartyId.toLowerCase();
      const accounts = Array.from(env.state.eReplicas.values())
        .filter(replica => replica.state.entityId.toLowerCase() === owner)
        .flatMap(replica => {
          const account = replica.state.accounts.get(cp);
          return account ? [account] : [];
        });
      if (accounts.length === 0) throw new Error(`CROSS_CLOSE_ACCOUNT_MISSING:${owner}:${cp}`);
      const height = Math.max(...accounts.map(account => account.currentHeight));
      // This reader admits only persisted proposals with the other party's ACK.
      // Match the order's signed lock before its close: an earlier USDT close or
      // a live route status cannot establish this order's financial outcome.
      const frames = await api.readPersistedAccountFrameHistory(env, owner, cp, height, {
        maxAccountHeight: height,
      });
      const pullIds = new Set(
        frames.flatMap(frame =>
          frame.accountTxs.flatMap(tx =>
            tx.type === 'cross_pull_lock' && tx.data.crossJurisdictionRoute.orderId === orderId ? [tx.data.pullId] : [],
          ),
        ),
      );
      return frames.flatMap(frame =>
        frame.accountTxs.flatMap(tx => {
          if (tx.type !== 'cross_pull_close' || !pullIds.has(tx.data.pullId)) return [];
          const proof = tx.data.proof;
          if (proof.orderId !== orderId || ![proof.sourcePullId, proof.targetPullId].includes(tx.data.pullId)) {
            throw new Error(`CROSS_CLOSE_PROOF_IDENTITY_MISMATCH:${orderId}:${tx.data.pullId}`);
          }
          return [
            {
              orderId: proof.orderId,
              height: frame.height,
              stateHash: frame.stateHash,
              pullId: tx.data.pullId,
              fillRatio: proof.fillRatio,
              closeMode: proof.closeMode,
              cumulativeSourceAmount: proof.cumulativeSourceAmount.toString(),
              cumulativeTargetAmount: proof.cumulativeTargetAmount.toString(),
            },
          ];
        }),
      );
    },
    { entityId, counterpartyId, orderId },
  );
}

export async function waitForCrossCloseSnapshot(
  page: Page,
  entityId: string,
  counterpartyId: string,
  orderId: string,
): Promise<CrossCloseSnapshot> {
  let snapshots: CrossCloseSnapshot[] = [];
  await expect
    .poll(
      async () => {
        snapshots = await readCrossCloseSnapshots(page, entityId, counterpartyId, orderId);
        return snapshots.length;
      },
      {
        timeout: 45_000,
        intervals: [250, 500, 1000],
        message: `signed cross close must exist exactly once for ${orderId}`,
      },
    )
    .toBe(1);
  const snapshot = snapshots[0];
  if (!snapshot) throw new Error(`CROSS_CLOSE_PROOF_MISSING:${orderId}`);
  console.log('[E2E cross close proof]', JSON.stringify({ entityId, counterpartyId, ...snapshot }));
  return snapshot;
}

export async function waitForCrossOffersCleared(
  page: Page,
  identity: RuntimeIdentity,
  hubId: string,
  label: string,
  options: { orderId?: string } = {},
): Promise<void> {
  try {
    await expect
      .poll(
        async () => {
          const state = await readCrossState(page, identity, hubId);
          const matchingOfferOpen = options.orderId
            ? state.offerSummaries.some(offer => offer.offerId === options.orderId)
            : state.offers > 0;
          return {
            offers: options.orderId ? (matchingOfferOpen ? 1 : 0) : state.offers,
            hasPendingFrame: state.hasPendingFrame,
            mempoolTxs: state.mempoolTxs,
            replicaFound: state.replicaFound,
            accountFound: state.accountFound,
            accountKeys: state.accountKeys,
            openOfferIds: state.offerSummaries.map(offer => offer.offerId),
          };
        },
        {
          timeout: 45_000,
          intervals: [250, 500, 1000],
          message: `${label} cross order should resolve/cancel after match`,
        },
      )
      .toMatchObject({ offers: 0, hasPendingFrame: false, mempoolTxs: [] });
  } catch (error) {
    const debug = await page.evaluate(
      ({ identity, hubId }) => {
        const env = (window as CrossRuntimeWindow).__xln?.env();
        const out: any[] = [];
        for (const [key, replica] of env?.state.eReplicas?.entries?.() || []) {
          const state = replica?.state;
          const entityId = String(state?.entityId || replica?.entityId || '').toLowerCase();
          if (
            entityId !== String(identity.entityId).toLowerCase() &&
            !Array.from(state?.accounts?.keys?.() || []).some(
              accountId => String(accountId).toLowerCase() === String(hubId).toLowerCase(),
            )
          ) {
            continue;
          }
          out.push({
            key: String(key),
            entityId,
            signerId: String(replica?.signerId || ''),
            profileName: String(state?.profile?.name || ''),
            jurisdiction: String(state?.config?.jurisdiction?.name || ''),
            messages: Array.from(state?.messages || [])
              .slice(-12)
              .map(String),
            routes: Array.from(state?.crossJurisdictionSwaps?.entries?.() || []).map(
              ([routeId, route]: [string, any]) => ({
                routeId,
                status: String(route?.status || ''),
                source: String(route?.source?.entityId || '').slice(0, 10),
                sourceHub: String(route?.source?.counterpartyEntityId || '').slice(0, 10),
                targetHub: String(route?.target?.entityId || '').slice(0, 10),
                target: String(route?.target?.counterpartyEntityId || '').slice(0, 10),
                sourcePull: Boolean(route?.sourcePull),
                targetPull: Boolean(route?.targetPull),
              }),
            ),
            accounts: Array.from(state?.accounts?.entries?.() || []).map(([accountId, account]: [string, any]) => ({
              accountId,
              currentHeight: Number(account?.currentHeight || 0),
              mempool: Array.from(account?.mempool || []).map((tx: any) => String(tx?.type || '')),
              pendingFrame: Array.from(account?.pendingFrame?.accountTxs || []).map((tx: any) =>
                String(tx?.type || ''),
              ),
              offers: Array.from(account?.state?.swapOffers?.entries?.() || []).map(
                ([offerId, offer]: [string, any]) => ({
                  offerId,
                  cross: Boolean(offer?.crossJurisdiction),
                  status: String(offer?.crossJurisdiction?.status || ''),
                }),
              ),
              pulls: Array.from(account?.state?.pulls?.keys?.() || []),
            })),
          });
        }
        return out;
      },
      { identity, hubId },
    );
    console.log(`[E2E ${label} offer debug]`, JSON.stringify(debug, null, 2));
    throw error;
  }
}

export async function waitForCrossPendingFill(
  page: Page,
  identity: RuntimeIdentity,
  hubId: string,
  label: string,
  options: { routeId?: string; minFillSeq?: number; minRatioExclusive?: number } = {},
): Promise<{ routeId: string; ratio: number; fillSeq: number }> {
  let routeId = '';
  let ratio = 0;
  let fillSeq = 0;
  try {
    await expect
      .poll(
        async () => {
          const state = await readCrossState(page, identity, hubId);
          const route = state.routeSummaries
            .filter(
              candidate =>
                candidate.status === 'partially_filled' &&
                candidate.cumulativeFillRatio > 0 &&
                candidate.cumulativeFillRatio < 65_535 &&
                (!options.routeId || candidate.orderId === options.routeId) &&
                candidate.fillSeq >= (options.minFillSeq ?? 1) &&
                candidate.cumulativeFillRatio > (options.minRatioExclusive ?? 0),
            )
            .sort((a, b) => b.updatedAt - a.updatedAt)[0];
          routeId = route?.orderId || '';
          ratio = route?.cumulativeFillRatio || 0;
          fillSeq = route?.fillSeq || 0;
          return {
            offers: state.offers,
            pulls: state.pulls,
            routeStatus: route?.status || '',
            ratio,
            fillSeq,
          };
        },
        {
          timeout: 75_000,
          intervals: [250, 500, 1000],
          message: `${label} cross-j partial fill must remain pending in the book without clearing pulls`,
        },
      )
      .toMatchObject({
        offers: expect.any(Number),
        pulls: expect.any(Number),
        routeStatus: 'partially_filled',
        fillSeq: expect.any(Number),
      });
  } catch (error) {
    const state = await readCrossState(page, identity, hubId);
    console.log(
      `[E2E ${label} pending fill debug]`,
      JSON.stringify(
        {
          offers: state.offers,
          pulls: state.pulls,
          routes: state.routeSummaries.map((candidate: any) => ({
            orderId: String(candidate.orderId || ''),
            status: candidate.status,
            ratio: candidate.cumulativeFillRatio,
            fillSeq: candidate.fillSeq,
            filledSourceAmount: candidate.filledSourceAmount,
            filledTargetAmount: candidate.filledTargetAmount,
            sourcePull: candidate.sourcePull,
            targetPull: candidate.targetPull,
            bookOwnerEntityId: candidate.bookOwnerEntityId,
            venueId: candidate.venueId,
          })),
          offerSummaries: state.offerSummaries,
          pullIds: state.pullIds,
          accountKeys: state.accountKeys,
          messages: state.messages.slice(-20),
        },
        null,
        2,
      ),
    );
    throw error;
  }
  expect(routeId, `${label} partial route id must be available`).toBeTruthy();
  const state = await readCrossState(page, identity, hubId);
  const route = state.routeSummaries.find(candidate => candidate.orderId === routeId);
  expect(state.offers, `${label} partial order must stay open`).toBeGreaterThan(0);
  expect(state.pulls, `${label} partial pull must stay locked until explicit clear`).toBeGreaterThan(0);
  expect(route?.cumulativeFillRatio || 0, `${label} partial ratio must be positive`).toBeGreaterThan(0);
  expect(route?.cumulativeFillRatio || 0, `${label} partial ratio must not be full`).toBeLessThan(65_535);
  return { routeId, ratio, fillSeq };
}

export async function requestCrossClear(
  page: Page,
  identity: RuntimeIdentity,
  orderId: string,
  options: { cancelRemainder?: boolean } = {},
): Promise<void> {
  await enqueueEntityTxs(page, identity.entityId, identity.signerId, [
    {
      type: 'requestCrossJurisdictionClear',
      data: {
        orderId,
        cancelRemainder: Boolean(options.cancelRemainder),
      },
    },
  ]);
  await flushRuntime(page, 5);
}

export async function waitForCrossRouteStatus(
  page: Page,
  identity: RuntimeIdentity,
  hubId: string,
  orderId: string,
  statuses: readonly string[],
  label: string,
): Promise<void> {
  try {
    await expect
      .poll(
        async () => {
          const state = await readCrossState(page, identity, hubId);
          const route = state.routeSummaries.find(candidate => candidate.orderId === orderId);
          return {
            status: route?.status || '',
            offers: state.offers,
            pulls: state.pulls,
            ratio: route?.cumulativeFillRatio || 0,
          };
        },
        {
          timeout: 75_000,
          intervals: [250, 500, 1000],
          message: `${label} route ${orderId.slice(0, 10)} must reach ${statuses.join('/')}`,
        },
      )
      .toMatchObject({
        status: expect.stringMatching(new RegExp(`^(${statuses.map(escapeRegex).join('|')})$`)),
      });
  } catch (error) {
    const state = await readCrossState(page, identity, hubId);
    console.log(
      `[E2E ${label} route status debug]`,
      JSON.stringify(
        {
          orderId,
          expected: statuses,
          offers: state.offers,
          pulls: state.pulls,
          route: state.routeSummaries.find(candidate => candidate.orderId === orderId),
          offerSummaries: state.offerSummaries,
          pullIds: state.pullIds,
          messages: state.messages.slice(-24),
        },
        null,
        2,
      ),
    );
    throw error;
  }
}

export async function waitForCrossRouteMaterialized(
  page: Page,
  identity: RuntimeIdentity,
  hubId: string,
  orderId: string,
  label: string,
): Promise<void> {
  try {
    await expect
      .poll(
        async () => {
          const state = await readCrossState(page, identity, hubId);
          const route = state.routeSummaries.find(candidate => candidate.orderId === orderId);
          return {
            present: Boolean(route),
            sourcePull: Boolean(route?.sourcePull),
            targetPull: Boolean(route?.targetPull),
            status: route?.status || '',
          };
        },
        {
          timeout: 45_000,
          intervals: [250, 500, 1000],
          message: `${label} route ${orderId.slice(0, 10)} must materialize before dispute salvage`,
        },
      )
      .toMatchObject({ present: true, targetPull: true });
  } catch (error) {
    const state = await readCrossState(page, identity, hubId);
    console.log(
      `[E2E ${label} route materialization debug]`,
      JSON.stringify(
        {
          orderId,
          routes: state.routeSummaries,
          accountKeys: state.accountKeys,
          messages: state.messages.slice(-24),
        },
        null,
        2,
      ),
    );
    throw error;
  }
}
