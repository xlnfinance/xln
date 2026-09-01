import { haltRuntimeFailure } from "../../../../../../protocol/errors/failure-taxonomy";

import type { EntityState } from '../../../../../types';
import {
  applyCommand,
  bookOrdersOutsidePriceRange,
  commitBookOverlay,
  deriveSide,
  getBestAsk,
  getBestBid,
  getSwapLotScaleForDecimals,
  type BookState,
  type BookOrderState,
  type OrderbookExtState,
} from '../../../../../../orderbook';
import { SWAP_CONSTANTS } from '../../../../../../config/constants';
import type { SwapPairPolicy } from '../../../../../../account/utils';
import { createStructuredLogger, shortId, shortOrder } from '../../../../../../support/logger';
import type {
  NormalizedOrderbookOffer,
  SameJurisdictionWorkingOrderbookOffer,
} from '../../../../../../orderbook/swap-execution';
import { normalizeSwapOfferForOrderbook , swapKey } from '../../../../../../orderbook/swap-execution';
import {
  hasQueuedSwapResolveForEntityState,
  queueUniqueSwapResolveForEntityState,
  type AccountTxTarget,
  type SwapResolveEnqueueData,
} from '../queue';
import { resolveStoredOfferEntityRefs } from '../offers';
import {
  deriveSameOrderbookPriceBandBounds,
  parseNamespacedOrderId,
  resolvePairBandReference,
} from '../helpers';

const orderbookSameLog = createStructuredLogger('orderbook.same');

type RecordDebugProjectionReject = (
  accountId: string,
  offerId: string,
  reason: string,
) => true;
export type SameOrderbookProcessInput = {
  hubState: EntityState;
  ext: OrderbookExtState;
  sameAccountSwapOffers: SameJurisdictionWorkingOrderbookOffer[];
  minTradeSize: bigint;
  swapTakerFeeBps: number;
  bookCache: Map<string, BookState>;
  bookUpdates: { pairId: string; book: BookState }[];
  accountTxs: AccountTxTarget[];
  queuedSwapResolutions: Set<string>;
  debugRebuildProjectionOnly: boolean;
  recordDebugProjectionReject: RecordDebugProjectionReject;
};

export type SameOrderbookPass = SameOrderbookProcessInput & {
  orderbookOfferMeta: Map<string, NormalizedOrderbookOffer>;
  suspendedSameOrderIds: Set<string>;
  sweptPairs: Set<string>;
  pairSweepCount: number;
  zeroFillCancels: Map<string, number>;
};

export const createSameOrderbookPass = (
  input: SameOrderbookProcessInput,
): SameOrderbookPass => ({
  ...input,
  orderbookOfferMeta: new Map(),
  suspendedSameOrderIds: new Set(),
  sweptPairs: new Set(),
  pairSweepCount: 0,
  zeroFillCancels: new Map(),
});

/**
 * Count a committed offer that left the book without a fill.
 *
 * Self-trade prevention, a price band, an out-of-band sweep and a full book all
 * reach that outcome legitimately, so a real market produces them by design and
 * one log line per destroyed offer would drown the Hub log. Aggregate per
 * reason instead; the pass emits a single summary.
 *
 * Reasons carry order-specific detail after the first colon (a price, a lot
 * count). Only the prefix is a category, so the key is bounded and two passes
 * with the same failure mode aggregate into one counter.
 */
export const recordZeroFillCancel = (pass: SameOrderbookPass, reason: string): void => {
  const category = reason.split(':')[0] || 'unknown';
  pass.zeroFillCancels.set(category, (pass.zeroFillCancels.get(category) ?? 0) + 1);
};

/** Total offers this pass destroyed with a zero fill, across every reason. */
export const zeroFillCancelTotal = (pass: SameOrderbookPass): number => {
  let total = 0;
  for (const count of pass.zeroFillCancels.values()) total += count;
  return total;
};

/**
 * Same-j resolve admission and matcher visibility are one atomic invariant.
 * A resolving row may remain in the immutable book projection until its
 * Account frame commits, but it must never participate in another same-pass
 * trade. Always suspend even when an identical resolve was already queued.
 */
export const queueSameSwapResolve = (
  pass: SameOrderbookPass,
  accountId: string,
  data: SwapResolveEnqueueData,
): boolean => {
  const queued = queueUniqueSwapResolveForEntityState(
    pass.accountTxs,
    pass.hubState,
    pass.queuedSwapResolutions,
    accountId,
    data,
  );
  pass.suspendedSameOrderIds.add(swapKey(accountId, data.offerId));
  return queued;
};

export const buildLiveSameOfferMeta = (
  pass: SameOrderbookPass,
  namespacedOrderId: string,
): NormalizedOrderbookOffer | null => {
  const { accountId, offerId } = parseNamespacedOrderId(
    namespacedOrderId,
    'ORDERBOOK_MALFORMED_BOOK_ORDER',
  );
  const account = pass.hubState.accounts.get(accountId);
  const liveOffer = account?.state.swapOffers?.get(offerId);
  if (!account || !liveOffer || liveOffer.crossJurisdiction) return null;
  const entityRefs = resolveStoredOfferEntityRefs(account.state, liveOffer);
  return normalizeSwapOfferForOrderbook(
    {
      offerId,
      makerIsLeft: liveOffer.makerIsLeft,
      fromEntity: entityRefs.fromEntity,
      toEntity: entityRefs.toEntity,
      createdHeight: liveOffer.createdHeight,
      giveTokenId: liveOffer.giveTokenId,
      giveTokenDecimals: liveOffer.giveTokenDecimals,
      giveAmount: liveOffer.giveAmount,
      wantTokenId: liveOffer.wantTokenId,
      wantTokenDecimals: liveOffer.wantTokenDecimals,
      wantAmount: liveOffer.wantAmount,
      maxFee: liveOffer.maxFee,
      minNetReceive: liveOffer.minNetReceive,
      priceTicks: liveOffer.priceTicks,
      timeInForce: liveOffer.timeInForce,
    },
    accountId,
  );
};

export const classifySameBookMaker = (
  pass: SameOrderbookPass,
  pairId: string,
  order: Readonly<BookOrderState>,
): 'eligible' | 'suspended' | 'cancel' => {
  const { accountId } = parseNamespacedOrderId(order.orderId, 'ORDERBOOK_MALFORMED_BOOK_ORDER');
  const account = pass.hubState.accounts.get(accountId);
  if (!account) {
    throw haltRuntimeFailure('ORDERBOOK_SAME_SNAPSHOT_MISSING',
      `ORDERBOOK_SAME_SNAPSHOT_MISSING: pair=${pairId} order=${order.orderId}`);
  }
  if (account.status !== undefined && account.status !== 'active') return 'cancel';
  const meta = pass.orderbookOfferMeta.get(order.orderId) ?? buildLiveSameOfferMeta(pass, order.orderId);
  if (!meta) {
    throw haltRuntimeFailure('ORDERBOOK_SAME_SNAPSHOT_MISSING',
      `ORDERBOOK_SAME_SNAPSHOT_MISSING: pair=${pairId} order=${order.orderId}`);
  }
  if (hasQueuedSwapResolveForEntityState(
    pass.hubState, pass.queuedSwapResolutions, meta.accountId, meta.offerId,
  )) return 'suspended';
  pass.orderbookOfferMeta.set(order.orderId, meta);
  const side = deriveSide(meta.giveTokenId, meta.wantTokenId);
  const baseTokenDecimals = side === 1 ? meta.giveTokenDecimals : meta.wantTokenDecimals;
  const baseAmount = side === 1 ? (meta.quantizedGive ?? meta.giveAmount) : meta.wantAmount;
  const canonicalOwner = meta.makerIsLeft ? meta.fromEntity : meta.toEntity;
  const canonicalQtyLots = baseAmount / getSwapLotScaleForDecimals(baseTokenDecimals);
  if (
    order.side !== side || order.priceTicks !== meta.priceTicks ||
    order.ownerId !== canonicalOwner || order.qtyLots !== canonicalQtyLots
  ) {
    throw haltRuntimeFailure('ORDERBOOK_CACHE_MISMATCH',
      `ORDERBOOK_CACHE_MISMATCH: pair=${pairId} order=${order.orderId} ` +
      `storedOwner=${order.ownerId} canonicalOwner=${canonicalOwner} ` +
      `storedSide=${order.side} canonicalSide=${side} ` +
      `storedPrice=${order.priceTicks.toString()} canonicalPrice=${meta.priceTicks.toString()} ` +
      `storedQtyLots=${order.qtyLots.toString()} canonicalQtyLots=${canonicalQtyLots.toString()}`);
  }
  return 'eligible';
};

export const containSamePairFailure = (
  pass: SameOrderbookPass,
  pairId: string,
  accountId: string,
  offerId: string,
  message: string,
): void => {
  orderbookSameLog.debug('pair.command_failed', {
    pair: pairId,
    offer: shortOrder(offerId, 8),
    account: shortId(accountId, 8),
    error: message,
  });
  if (pass.debugRebuildProjectionOnly) {
    pass.recordDebugProjectionReject(accountId, offerId, `pair-error:${message}`);
    return;
  }
  throw haltRuntimeFailure("ORDERBOOK_PAIR_COMMAND_FAILED", `ORDERBOOK_PAIR_COMMAND_FAILED: pair=${pairId} account=${accountId} ` +
    `offer=${offerId} error=${message}`);
};

export const sweepSamePairOutOfBandOffers = (
  pass: SameOrderbookPass,
  pairId: string,
  pairPolicy: SwapPairPolicy,
  hasExplicitPairPolicy: boolean,
  currentBook: BookState,
): BookState => {
  const bestBid = getBestBid(currentBook);
  const bestAsk = getBestAsk(currentBook);
  const { anchor, label } = resolvePairBandReference(
    pairPolicy,
    hasExplicitPairPolicy,
    bestBid,
    bestAsk,
  );
  if (anchor === null) return currentBook;
  const { minAllowed, maxAllowed } = deriveSameOrderbookPriceBandBounds(anchor);
  let nextBook = currentBook;
  let removed = 0;
  for (const order of bookOrdersOutsidePriceRange(currentBook, minAllowed, maxAllowed)) {
    const disposition = classifySameBookMaker(pass, pairId, order);
    if (disposition === 'suspended') continue;
    const liveOffer = disposition === 'eligible' ? buildLiveSameOfferMeta(pass, order.orderId) : null;
    removed += 1;
    recordZeroFillCancel(pass, 'outside-anchor-band');
    orderbookSameLog.debug('sweep.out_of_band', {
      offer: shortOrder(liveOffer?.offerId ?? order.orderId, 8),
      pair: pairId,
      price: order.priceTicks.toString(),
      rejectPct: SWAP_CONSTANTS.PRICE_REJECT_BPS / 100,
      bandLabel: label,
      bandAnchor: anchor.toString(),
    });
    if (pass.debugRebuildProjectionOnly && liveOffer) {
      pass.recordDebugProjectionReject(
        liveOffer.accountId,
        liveOffer.offerId,
        `outside-anchor-band:${order.priceTicks.toString()}`,
      );
      continue;
    }
    nextBook = commitBookOverlay(applyCommand(nextBook, {
      kind: 1,
      ownerId: order.ownerId,
      orderId: order.orderId,
    }).state);
    if (liveOffer) queueSameSwapResolve(pass, liveOffer.accountId, {
        offerId: liveOffer.offerId,
        fillRatio: 0,
        cancelRemainder: true,
        comment: `outside-anchor-band:${order.priceTicks.toString()}`,
      });
  }
  if (removed === 0) return currentBook;
  pass.pairSweepCount += 1;
  return nextBook;
};
