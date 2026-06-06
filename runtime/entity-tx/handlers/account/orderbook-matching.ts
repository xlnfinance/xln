import type { EntityState } from '../../../types';
import {
  applyCommand,
  getBookOrder,
  type BookState,
  type OrderbookExtState,
} from '../../../orderbook';
import { createStructuredLogger, shortId, shortOrder } from '../../../logger';
import { type WorkingOrderbookOffer, swapKey } from '../../../swap-execution';
import {
  markCrossJurisdictionBookAdmissionClosed,
  type CrossJurisdictionFillInstruction,
} from '../../../cross-jurisdiction-orderbook';
import {
  queueUniqueSwapResolveForEntityState,
  type MempoolOp,
} from './orderbook-queue';
import {
  sortSwapOffersForOrderbook,
  type MatchResult,
} from './orderbook-offers';
import {
  parseNamespacedOrderId,
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
  const splitOffers = splitWorkingOrderbookOffers(swapOffers);
  const sameAccountSwapOffers = sortSwapOffersForOrderbook(splitOffers.sameAccountSwapOffers);
  const crossJurisdictionSwapOffers = sortSwapOffersForOrderbook(splitOffers.crossJurisdictionSwapOffers);
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
  const queuedSwapResolutions = new Set<string>();

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
    queuedSwapResolutions,
    debugRebuildProjectionOnly,
    recordDebugProjectionReject,
    rejectInvalidOffer,
    cancelNonWorkingBookOrder,
  });

  return { mempoolOps, crossJurisdictionFills, bookUpdates, debugProjectionRejects };
}
