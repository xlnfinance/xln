import type { EntityState } from '../../../types';
import {
  type BookState,
  type OrderbookExtState,
} from '../../../orderbook';
import { createStructuredLogger, shortId, shortOrder } from '../../../logger';
import { type WorkingOrderbookOffer, swapKey } from '../../../swap-execution';
import { type CrossJurisdictionFillInstruction } from '../../../cross-jurisdiction-orderbook';
import {
  queueUniqueSwapResolveForEntityState,
  type MempoolOp,
} from './orderbook-queue';
import {
  sortSwapOffersForOrderbook,
  type MatchResult,
} from './orderbook-offers';
import {
  splitWorkingOrderbookOffers,
  type OrderbookProcessOptions,
} from './orderbook-matching-helpers';
import { processCrossJurisdictionOrderbookOffers } from './orderbook-matching-cross';
import { processSameAccountOrderbookOffers } from './orderbook-matching-same';

const orderbookLog = createStructuredLogger('orderbook');

/**
 * Shared orderbook matcher for both same-chain and cross-chain swaps.
 *
 * Hard invariants:
 * - same-chain rows require an offer already stored in accountMachine.swapOffers
 * - cross-chain rows require accountMachine.swapOffers or an admitted cross book route
 * - same-chain fills settle with account-level swap_resolve
 * - cross-chain fills settle with cross_swap_fill_ack plus hash-ledger pull clear
 * - cross-chain partial fills keep the existing book row alive; terminal fills
 *   and explicit cancels remove it permanently
 * - never refresh/repair a book row from route data; admitted cross routes may
 *   only validate existing row metadata and produce fill notices
 *
 * The orderbook is one hot-cache matcher. Same/cross differ only in
 * materialization and post-match settlement.
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
  // Pair books stay hot within this pass so same-tick offers see each other's exact fills.
  // The book is a deterministic projection of account swapOffers, not a second owner of order lifecycle.
  const bookCache = new Map<string, BookState>();
  const queuedSwapResolutions = new Set<string>();
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
    // Cross-j orders settle through fill notices and pull clearing. The book
    // row is never refreshed from route/admission data: the account swapOffer
    // or admitted route must validate the existing row exactly.
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
  });

  return { mempoolOps, crossJurisdictionFills, bookUpdates, debugProjectionRejects };
}
