import type { EntityState } from '../../../types';
import {
  applyCommand,
  deriveSide,
  getBookOrder,
  getBestAsk,
  getBestBid,
  SWAP_LOT_SCALE,
  type BookState,
  type OrderbookExtState,
} from '../../../orderbook';
import { SWAP as SWAP_CONSTANTS } from '../../../constants';
import type { SwapPairPolicy } from '../../../account-utils';
import { createStructuredLogger, shortId, shortOrder } from '../../../logger';
import { type NormalizedOrderbookOffer, type WorkingOrderbookOffer, swapKey } from '../../../swap-execution';
import {
  markCrossJurisdictionBookAdmissionClosed,
  type CrossJurisdictionFillInstruction,
} from '../../../cross-jurisdiction-orderbook';
import {
  hasQueuedSwapResolveForEntityState,
  queueUniqueSwapResolveForEntityState,
  type MempoolOp,
} from './orderbook-queue';
import {
  normalizeSwapOfferForOrderbook,
  resolveStoredOfferEntityRefs,
  type MatchResult,
} from './orderbook-offers';
import {
  parseNamespacedOrderId,
  resolvePairBandReference,
  splitWorkingOrderbookOffers,
  type OrderbookProcessOptions,
} from './orderbook-matching-helpers';
import { processCrossJurisdictionOrderbookOffers } from './orderbook-matching-cross';
import { processSameAccountOrderbookOffers } from './orderbook-matching-same';

const orderbookLog = createStructuredLogger('orderbook');

/**
 * Process swap offers through hub's orderbook (PURE - returns events, no mutations)
 * Called at entity level after aggregating all swap events
 */
export function processOrderbookSwaps(
  hubState: EntityState,
  swapOffers: WorkingOrderbookOffer[],
  options: OrderbookProcessOptions = {},
): MatchResult {
  const mempoolOps: MempoolOp[] = [];
  const crossJurisdictionFills: CrossJurisdictionFillInstruction[] = [];
  const bookUpdates: { pairId: string; book: BookState }[] = [];
  const debugProjectionRejects: Array<{ offerId: string; accountId: string; reason: string }> = [];
  const ext = hubState.orderbookExt as OrderbookExtState | undefined;
  if (!ext) return { mempoolOps, crossJurisdictionFills, bookUpdates, debugProjectionRejects };
  const debugRebuildProjectionOnly = options.debugRebuildProjectionOnly === true;
  const { sameAccountSwapOffers, crossJurisdictionSwapOffers } = splitWorkingOrderbookOffers(swapOffers);
  const minTradeSize = ext.hubProfile?.minTradeSize ?? 0n;
  const swapTakerFeeBpsRaw = hubState.hubRebalanceConfig?.swapTakerFeeBps;
  const swapTakerFeeBps = Number.isFinite(Number(swapTakerFeeBpsRaw))
    ? Math.max(0, Math.min(10_000, Math.floor(Number(swapTakerFeeBpsRaw))))
    : 0;
  const debugProjectionRejectKeys = new Set<string>();
  const recordDebugProjectionReject = (accountId: string, offerId: string, reason: string): true => {
    if (!debugRebuildProjectionOnly) {
      throw new Error(`ORDERBOOK_LIVE_PROJECTION_REJECT: account=${accountId} offer=${offerId} reason=${reason}`);
    }
    const key = swapKey(accountId, offerId);
    if (debugProjectionRejectKeys.has(key)) return true;
    debugProjectionRejectKeys.add(key);
    debugProjectionRejects.push({ accountId, offerId, reason });
    return true;
  };
  const rejectInvalidCrossOffer = (accountId: string, offerId: string, reason: string): void => {
    // Cross-j orders settle through fill notices and pull clearing. Rehydrate
    // can report debug projection rejects; live matching must surface malformed
    // routes as invariant failures instead of silently cancelling liquidity.
    recordDebugProjectionReject(accountId, offerId, reason);
    orderbookLog.warn('crossj.offer_rejected', {
      offer: shortOrder(offerId, 8),
      account: shortId(accountId, 8),
      reason,
    });
  };
  const rejectInvalidOffer = (accountId: string, offerId: string, reason: string): void => {
    if (debugRebuildProjectionOnly) {
      recordDebugProjectionReject(accountId, offerId, reason);
      return;
    }
    queueUniqueSwapResolveForEntityState(mempoolOps, hubState, queuedSwapResolutions, accountId, {
      offerId,
      fillRatio: 0,
      cancelRemainder: true,
      comment: reason,
    });
  };

  // Pair books stay hot within this pass so same-tick offers see each other's exact fills.
  // The book is a deterministic projection of account swapOffers, not a second owner of order lifecycle.
  const bookCache = new Map<string, BookState>();
  const orderbookOfferMeta = new Map<string, NormalizedOrderbookOffer>();
  let pairSweepCount = 0;
  const queuedSwapResolutions = new Set<string>();
  const sweptPairs = new Set<string>();

  const cancelNonWorkingBookOrder = (
    pairId: string,
    book: BookState,
    order: NonNullable<ReturnType<typeof getBookOrder>>,
    reason: string,
  ): BookState => {
    const parsed = parseNamespacedOrderId(order.orderId, 'ORDERBOOK_MALFORMED_BOOK_ORDER');
    if (debugRebuildProjectionOnly) {
      recordDebugProjectionReject(parsed.accountId, parsed.offerId, reason);
      return book;
    }
    const result = applyCommand(book, {
      kind: 1,
      ownerId: order.ownerId,
      orderId: order.orderId,
    });
    const cancelled = result.events.some(event => event.type === 'CANCELED' && event.orderId === order.orderId);
    if (!cancelled) {
      throw new Error(`ORDERBOOK_CANCEL_NONWORKING_FAILED: pair=${pairId} order=${order.orderId} reason=${reason}`);
    }
    const route = hubState.accounts.get(parsed.accountId)?.swapOffers?.get(parsed.offerId)?.crossJurisdiction;
    if (route) {
      markCrossJurisdictionBookAdmissionClosed(
        hubState,
        route.source.entityId,
        parsed.offerId,
        Number(hubState.timestamp || 0),
        reason,
      );
    }
    bookCache.set(pairId, result.state);
    bookUpdates.push({ pairId, book: result.state });
    orderbookLog.debug('book.cancel_nonworking', {
      pair: pairId,
      order: shortOrder(order.orderId, 20),
      reason,
    });
    return result.state;
  };

  const buildLiveOfferMeta = (namespacedOrderId: string): NormalizedOrderbookOffer | null => {
    const { accountId, offerId } = parseNamespacedOrderId(namespacedOrderId, 'ORDERBOOK_MALFORMED_BOOK_ORDER');
    const account = hubState.accounts.get(accountId);
    const liveOffer = account?.swapOffers?.get(offerId);
    if (!account || !liveOffer) return null;
    if (liveOffer.crossJurisdiction) return null;
    const entityRefs = resolveStoredOfferEntityRefs(account, liveOffer);
    return normalizeSwapOfferForOrderbook(
      {
        offerId,
        makerIsLeft: liveOffer.makerIsLeft,
        fromEntity: entityRefs.fromEntity,
        toEntity: entityRefs.toEntity,
        createdHeight: liveOffer.createdHeight,
        giveTokenId: liveOffer.giveTokenId,
        giveAmount: liveOffer.giveAmount,
        wantTokenId: liveOffer.wantTokenId,
        wantAmount: liveOffer.wantAmount,
        priceTicks: liveOffer.priceTicks,
        timeInForce: liveOffer.timeInForce,
        minFillRatio: liveOffer.minFillRatio,
        ...(liveOffer.crossJurisdiction ? { crossJurisdiction: liveOffer.crossJurisdiction } : {}),
      },
      accountId,
    );
  };

  const containCurrentOfferPairFailure = (
    pairId: string,
    currentAccountId: string,
    currentOfferId: string,
    message: string,
  ): void => {
    console.error(
      `❌ ORDERBOOK: pair-local failure pair=${pairId} offer=${currentOfferId} account=${currentAccountId.slice(-8)} error=${message}`,
    );
    if (debugRebuildProjectionOnly) {
      recordDebugProjectionReject(currentAccountId, currentOfferId, `pair-error:${message}`);
      return;
    }
    throw new Error(
      `ORDERBOOK_PAIR_COMMAND_FAILED: pair=${pairId} account=${currentAccountId} offer=${currentOfferId} error=${message}`,
    );
  };

  const sweepPairOutOfBandOffers = (
    pairId: string,
    pairPolicy: SwapPairPolicy,
    hasExplicitPairPolicy: boolean,
    currentBook: BookState,
  ): BookState => {
    const REJECT_BPS = SWAP_CONSTANTS.PRICE_REJECT_BPS;
    const BPS_BASE = SWAP_CONSTANTS.BPS_BASE;
    const bestBid = getBestBid(currentBook);
    const bestAsk = getBestAsk(currentBook);
    const { anchor: bandAnchor, label: bandLabel } = resolvePairBandReference(
      pairPolicy,
      hasExplicitPairPolicy,
      bestBid,
      bestAsk,
    );
    if (bandAnchor === null) return currentBook;

    const minAllowed = bandAnchor - (bandAnchor * BigInt(REJECT_BPS)) / BigInt(BPS_BASE);
    const maxAllowed = bandAnchor + (bandAnchor * BigInt(REJECT_BPS)) / BigInt(BPS_BASE);
    let removed = 0;
    let nextBook = currentBook;

    for (const order of [...currentBook.orders.values()]) {
      const liveOffer = buildLiveOfferMeta(order.orderId);
      if (!liveOffer) {
        removed += 1;
        nextBook = cancelNonWorkingBookOrder(pairId, nextBook, order, 'orphan-book-order');
        continue;
      }
      if (order.priceTicks < minAllowed || order.priceTicks > maxAllowed) {
        removed += 1;
        console.warn(
          `⚠️ ORDERBOOK: sweeping out-of-band resting offer=${liveOffer.offerId} pair=${pairId} price=${order.priceTicks.toString()} ` +
            `outside ±${REJECT_BPS / 100}% of ${bandLabel} ${bandAnchor.toString()}`,
        );
        if (debugRebuildProjectionOnly) {
          recordDebugProjectionReject(
            liveOffer.accountId,
            liveOffer.offerId,
            `outside-anchor-band:${order.priceTicks.toString()}`,
          );
        } else {
          const cancelResult = applyCommand(nextBook, {
            kind: 1,
            ownerId: order.ownerId,
            orderId: order.orderId,
          });
          nextBook = cancelResult.state;
          queueUniqueSwapResolveForEntityState(mempoolOps, hubState, queuedSwapResolutions, liveOffer.accountId, {
            offerId: liveOffer.offerId,
            fillRatio: 0,
            cancelRemainder: true,
          });
        }
        continue;
      }
    }

    if (removed === 0) return currentBook;
    pairSweepCount += 1;
    return nextBook;
  };

  const assertBookMatchesKnownAccountOffers = (pairId: string, book: BookState): BookState => {
    let currentBook = book;
    for (const order of [...book.orders.values()]) {
      const orderId = order.orderId;
      const meta = orderbookOfferMeta.get(orderId) ?? buildLiveOfferMeta(orderId);
      if (!meta) {
        currentBook = cancelNonWorkingBookOrder(pairId, currentBook, order, 'orphan-book-order');
        continue;
      }
      if (hasQueuedSwapResolveForEntityState(hubState, queuedSwapResolutions, meta.accountId, meta.offerId)) {
        currentBook = cancelNonWorkingBookOrder(pairId, currentBook, order, 'pending-swap-resolve');
        continue;
      }
      orderbookOfferMeta.set(orderId, meta);
      const metaSide = deriveSide(meta.giveTokenId, meta.wantTokenId);
      const metaBaseAmount = metaSide === 1 ? (meta.quantizedGive ?? meta.giveAmount) : meta.wantAmount;
      if (
        order.priceTicks !== meta.priceTicks ||
        order.ownerId !== (meta.makerIsLeft ? meta.fromEntity : meta.toEntity) ||
        BigInt(order.qtyLots) !== metaBaseAmount / SWAP_LOT_SCALE
      ) {
        throw new Error(
          `ORDERBOOK_CACHE_MISMATCH: pair=${pairId} order=${orderId} ` +
            `storedPrice=${order.priceTicks.toString()} canonicalPrice=${meta.priceTicks.toString()}`,
        );
      }
    }
    return currentBook;
  };

  processCrossJurisdictionOrderbookOffers({
    hubState,
    ext,
    crossJurisdictionSwapOffers,
    bookCache,
    bookUpdates,
    mempoolOps,
    crossJurisdictionFills,
    queuedSwapResolutions,
    debugRebuildProjectionOnly,
    cancelNonWorkingBookOrder,
    rejectInvalidCrossOffer,
    recordDebugProjectionReject,
  });
  processSameAccountOrderbookOffers({
    hubState,
    ext,
    sameAccountSwapOffers,
    minTradeSize,
    swapTakerFeeBps,
    bookCache,
    bookUpdates,
    mempoolOps,
    orderbookOfferMeta,
    sweptPairs,
    queuedSwapResolutions,
    debugRebuildProjectionOnly,
    recordDebugProjectionReject,
    rejectInvalidOffer,
    containCurrentOfferPairFailure,
    sweepPairOutOfBandOffers,
    assertBookMatchesKnownAccountOffers,
  });

  if (pairSweepCount > 0) {
    orderbookLog.debug('pass.summary', { pairSweep: pairSweepCount });
  }

  return { mempoolOps, crossJurisdictionFills, bookUpdates, debugProjectionRejects };
}
