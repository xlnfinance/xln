import type { EntityState } from '../../../types';
import {
  applyCommand,
  getBookOrder,
  refreshRestingOrder,
  SWAP_LOT_SCALE,
  type BookState,
  type OrderbookExtState,
} from '../../../orderbook';
import { getSwapPairPolicyByBaseQuote } from '../../../account-utils';
import { createStructuredLogger, shortOrder } from '../../../logger';
import { compareCanonicalText, swapKey, type CrossJurisdictionWorkingOrderbookOffer } from '../../../swap-execution';
import {
  buildCrossJurisdictionFillAck,
  type CrossJurisdictionFillInstruction,
  type CrossMarketOffer,
} from '../../../cross-jurisdiction-orderbook';
import {
  findQueuedCrossSwapAckForEntityState,
  hasQueuedCrossSwapAckForEntityState,
  hasQueuedSwapResolveForEntityState,
  type MempoolOp,
} from './orderbook-queue';
import { sortSwapOffersForOrderbook } from './orderbook-offers';
import {
  aggregateCrossTradeFills,
  buildCrossMarketOfferForHub,
  buildCrossMarketOfferFromBookOrder,
  createEmptyPairBook,
  MAX_ORDERBOOK_QTY_LOTS,
  parseNamespacedOrderId,
  rejectEventsForOrder,
  tradeEvents as collectTradeEvents,
} from './orderbook-matching-helpers';

const orderbookCrossLog = createStructuredLogger('orderbook.cross');

type CancelNonWorkingBookOrder = (
  pairId: string,
  book: BookState,
  order: NonNullable<ReturnType<typeof getBookOrder>>,
  reason: string,
) => BookState;

type RejectInvalidCrossOffer = (accountId: string, offerId: string, reason: string) => void;
type RecordDebugProjectionReject = (accountId: string, offerId: string, reason: string) => true;

export type CrossOrderbookProcessInput = {
  hubState: EntityState;
  ext: OrderbookExtState;
  crossJurisdictionSwapOffers: CrossJurisdictionWorkingOrderbookOffer[];
  bookCache: Map<string, BookState>;
  bookUpdates: { pairId: string; book: BookState }[];
  mempoolOps: MempoolOp[];
  crossJurisdictionFills: CrossJurisdictionFillInstruction[];
  queuedSwapResolutions: Set<string>;
  debugRebuildProjectionOnly: boolean;
  cancelNonWorkingBookOrder: CancelNonWorkingBookOrder;
  rejectInvalidCrossOffer: RejectInvalidCrossOffer;
  recordDebugProjectionReject: RecordDebugProjectionReject;
};

export const processCrossJurisdictionOrderbookOffers = (input: CrossOrderbookProcessInput): void => {
  const {
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
  } = input;

  const crossLiveOfferMeta = new Map<string, CrossMarketOffer>();
  const assertedCrossJurisdictionPairs = new Set<string>();
  const crossAggregatedFills = new Map<string, { filledLots: number; weightedCost: bigint }>();

  const getCrossMarketOffer = (offer: CrossJurisdictionWorkingOrderbookOffer): CrossMarketOffer | null => {
    const key = swapKey(offer.accountId, offer.offerId);
    const cached = crossLiveOfferMeta.get(key);
    if (cached) return cached;
    const marketOffer = buildCrossMarketOfferForHub(hubState.entityId, offer);
    if (marketOffer) crossLiveOfferMeta.set(key, marketOffer);
    return marketOffer;
  };

  const refreshExistingCrossBookOrder = (pairId: string, namespacedOrderId: string, meta: CrossMarketOffer): void => {
    let book = bookCache.get(pairId) || ext.books.get(pairId);
    if (!book || !getBookOrder(book, namespacedOrderId)) return;

    const qtyLots = meta.baseAmount / SWAP_LOT_SCALE;
    if (qtyLots > MAX_ORDERBOOK_QTY_LOTS) {
      throw new Error(
        `ORDERBOOK_CROSS_J_REFRESH_QTY_INVALID: pair=${pairId} order=${namespacedOrderId} qty=${qtyLots.toString()}`,
      );
    }
    if (qtyLots > 0n) {
      book = refreshRestingOrder(book, {
        ownerId: meta.makerId,
        orderId: namespacedOrderId,
        side: meta.side,
        priceTicks: meta.priceTicks,
        qtyLots: Number(qtyLots),
      });
    } else {
      book = applyCommand(book, {
        kind: 1,
        ownerId: meta.makerId,
        orderId: namespacedOrderId,
      }).state;
    }

    bookCache.set(pairId, book);
    bookUpdates.push({ pairId, book });
  };

  const removeCrossBookOrderAfterFill = (pairId: string, namespacedOrderId: string, reason: string): void => {
    let book = bookCache.get(pairId) || ext.books.get(pairId);
    if (!book) return;
    const order = getBookOrder(book, namespacedOrderId);
    if (!order) return;
    book = applyCommand(book, {
      kind: 1,
      ownerId: order.ownerId,
      orderId: namespacedOrderId,
    }).state;
    bookCache.set(pairId, book);
    bookUpdates.push({ pairId, book });
    orderbookCrossLog.debug('book.remove_resolving', {
      pair: pairId,
      order: shortOrder(namespacedOrderId, 20),
      reason,
    });
  };

  const assertCrossBookMatchesKnownRoutes = (pairId: string, book: BookState): BookState => {
    if (assertedCrossJurisdictionPairs.has(pairId)) return book;
    assertedCrossJurisdictionPairs.add(pairId);
    let currentBook = book;

    for (const order of [...book.orders.values()]) {
      const orderId = order.orderId;
      const { accountId, offerId } = parseNamespacedOrderId(orderId, 'ORDERBOOK_CROSS_J_MALFORMED_BOOK_ORDER');
      const queuedPendingAck = findQueuedCrossSwapAckForEntityState(hubState, accountId, offerId);
      const pendingAck = queuedPendingAck?.data ?? null;
      const meta = crossLiveOfferMeta.get(orderId) ?? buildCrossMarketOfferFromBookOrder(hubState, orderId);
      if (!meta) {
        currentBook = cancelNonWorkingBookOrder(
          pairId,
          currentBook,
          order,
          pendingAck ? 'pending-cross-ack-orphan' : 'orphan-cross-route',
        );
        continue;
      }

      crossLiveOfferMeta.set(orderId, meta);
      const canonicalQtyLots = meta.baseAmount / SWAP_LOT_SCALE;
      if (pendingAck) {
        currentBook = cancelNonWorkingBookOrder(pairId, currentBook, order, 'resolving-cross-fill');
        continue;
      }
      const staticMismatch =
        meta.pairId !== pairId || order.priceTicks !== meta.priceTicks || order.ownerId !== meta.makerId;
      const storedQtyLots = BigInt(order.qtyLots);
      const committedPartialNeedsRefresh =
        !staticMismatch && meta.route.status === 'partially_filled' && storedQtyLots > canonicalQtyLots;
      if (committedPartialNeedsRefresh) {
        if (canonicalQtyLots > MAX_ORDERBOOK_QTY_LOTS) {
          throw new Error(
            `ORDERBOOK_CROSS_J_REFRESH_QTY_INVALID: pair=${pairId} order=${orderId} qty=${canonicalQtyLots.toString()}`,
          );
        }
        currentBook =
          canonicalQtyLots > 0n
            ? refreshRestingOrder(currentBook, {
                ownerId: meta.makerId,
                orderId,
                side: meta.side,
                priceTicks: meta.priceTicks,
                qtyLots: Number(canonicalQtyLots),
              })
            : applyCommand(currentBook, {
                kind: 1,
                ownerId: meta.makerId,
                orderId,
              }).state;
        bookUpdates.push({ pairId, book: currentBook });
        continue;
      }
      if (staticMismatch || storedQtyLots !== canonicalQtyLots) {
        throw new Error(
          `ORDERBOOK_CROSS_J_CACHE_MISMATCH: pair=${pairId} order=${orderId} ` +
            `storedPair=${pairId} canonicalPair=${meta.pairId} ` +
            `storedOwner=${order.ownerId} canonicalOwner=${meta.makerId} ` +
            `storedQty=${storedQtyLots.toString()} canonicalQty=${canonicalQtyLots.toString()} ` +
            `storedPrice=${order.priceTicks.toString()} canonicalPrice=${meta.priceTicks.toString()}`,
        );
      }
    }
    return currentBook;
  };

  for (const rawOffer of sortSwapOffersForOrderbook(crossJurisdictionSwapOffers)) {
    const marketOffer = getCrossMarketOffer(rawOffer);
    if (!marketOffer) continue;
    refreshExistingCrossBookOrder(marketOffer.pairId, swapKey(rawOffer.accountId, rawOffer.offerId), marketOffer);
  }

  for (const [pairId, book] of ext.books) {
    if (!String(pairId).startsWith('cross:')) continue;
    const currentBook = bookCache.get(pairId) || book;
    const checkedBook = assertCrossBookMatchesKnownRoutes(pairId, currentBook);
    bookCache.set(pairId, checkedBook);
  }

  for (const rawOffer of sortSwapOffersForOrderbook(crossJurisdictionSwapOffers)) {
    const currentAccountId = rawOffer.accountId;
    const currentNamespacedOrderId = swapKey(currentAccountId, rawOffer.offerId);
    const marketOffer = getCrossMarketOffer(rawOffer);
    if (!marketOffer) {
      rejectInvalidCrossOffer(currentAccountId, rawOffer.offerId, 'invalid-cross-j-route');
      continue;
    }
    const qtyLots = marketOffer.baseAmount / SWAP_LOT_SCALE;
    if (qtyLots <= 0n) {
      rejectInvalidCrossOffer(
        currentAccountId,
        rawOffer.offerId,
        `cross-dust-remainder:${marketOffer.baseAmount.toString()}`,
      );
      continue;
    }
    if (qtyLots > MAX_ORDERBOOK_QTY_LOTS) {
      rejectInvalidCrossOffer(currentAccountId, rawOffer.offerId, `invalid-cross-qty:${qtyLots.toString()}`);
      continue;
    }

    crossLiveOfferMeta.set(currentNamespacedOrderId, marketOffer);
    if (hasQueuedSwapResolveForEntityState(hubState, queuedSwapResolutions, currentAccountId, rawOffer.offerId)) {
      continue;
    }
    let book = bookCache.get(marketOffer.pairId) || ext.books.get(marketOffer.pairId);
    if (!book) {
      book = createEmptyPairBook(
        getSwapPairPolicyByBaseQuote(rawOffer.giveTokenId, rawOffer.wantTokenId).bookBucketWidthTicks,
      );
    } else {
      book = assertCrossBookMatchesKnownRoutes(marketOffer.pairId, book);
    }
    const existingOrder = getBookOrder(book, currentNamespacedOrderId);
    if (existingOrder) {
      book = applyCommand(book, {
        kind: 1,
        ownerId: marketOffer.makerId,
        orderId: currentNamespacedOrderId,
      }).state;
      bookCache.set(marketOffer.pairId, book);
      bookUpdates.push({ pairId: marketOffer.pairId, book });
    }

    let result: ReturnType<typeof applyCommand>;
    try {
      result = applyCommand(book, {
        kind: 0,
        ownerId: marketOffer.makerId,
        orderId: currentNamespacedOrderId,
        side: marketOffer.side,
        tif: rawOffer.timeInForce,
        postOnly: debugRebuildProjectionOnly,
        priceTicks: marketOffer.priceTicks,
        qtyLots: Number(qtyLots),
        minFillRatio: rawOffer.minFillRatio,
      });
    } catch (error) {
      rejectInvalidCrossOffer(
        currentAccountId,
        rawOffer.offerId,
        `cross-pair-error:${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }

    book = result.state;
    bookCache.set(marketOffer.pairId, book);
    bookUpdates.push({ pairId: marketOffer.pairId, book });

    const rejectEvents = rejectEventsForOrder(result.events, currentNamespacedOrderId);
    const tradeEvents = collectTradeEvents(result.events);
    if (rejectEvents.length > 0 && tradeEvents.length === 0) {
      rejectInvalidCrossOffer(
        currentAccountId,
        rawOffer.offerId,
        `cross-post-only-reject:${rejectEvents.map(event => event.reason).join(',')}`,
      );
      continue;
    }
    if (debugRebuildProjectionOnly) {
      if (tradeEvents.length > 0) {
        recordDebugProjectionReject(
          currentAccountId,
          rawOffer.offerId,
          `debug-rebuild-cross-trade:${tradeEvents.length}`,
        );
      }
      continue;
    }

    for (const [namespacedOrderId, fill] of aggregateCrossTradeFills(tradeEvents)) {
      const meta = crossLiveOfferMeta.get(namespacedOrderId) ?? buildCrossMarketOfferFromBookOrder(hubState, namespacedOrderId);
      if (!meta) {
        throw new Error(`ORDERBOOK_CROSS_J_FILL_META_MISSING: order=${namespacedOrderId}`);
      }
      const { accountId, offerId } = parseNamespacedOrderId(
        namespacedOrderId,
        'ORDERBOOK_CROSS_J_MALFORMED_FILL_ORDER',
      );
      if (hasQueuedCrossSwapAckForEntityState(hubState, accountId, offerId)) continue;
      const aggregatedFill = crossAggregatedFills.get(namespacedOrderId);
      if (aggregatedFill) {
        aggregatedFill.filledLots += fill.filledLots;
        aggregatedFill.weightedCost += fill.weightedCost;
      } else {
        crossAggregatedFills.set(namespacedOrderId, {
          filledLots: fill.filledLots,
          weightedCost: fill.weightedCost,
        });
      }
    }
  }

  for (const namespacedOrderId of [...crossAggregatedFills.keys()].sort(compareCanonicalText)) {
    const fill = crossAggregatedFills.get(namespacedOrderId);
    if (!fill) continue;
    const meta = crossLiveOfferMeta.get(namespacedOrderId) ?? buildCrossMarketOfferFromBookOrder(hubState, namespacedOrderId);
    if (!meta) {
      throw new Error(`ORDERBOOK_CROSS_J_FILL_META_MISSING: order=${namespacedOrderId}`);
    }
    const { accountId, offerId } = parseNamespacedOrderId(
      namespacedOrderId,
      'ORDERBOOK_CROSS_J_MALFORMED_FILL_ORDER',
    );
    if (hasQueuedCrossSwapAckForEntityState(hubState, accountId, offerId)) {
      removeCrossBookOrderAfterFill(meta.pairId, namespacedOrderId, 'queued-cross-fill-ack');
      continue;
    }
    const ack = buildCrossJurisdictionFillAck(accountId, offerId, namespacedOrderId, meta, fill);
    if (!ack) continue;
    removeCrossBookOrderAfterFill(meta.pairId, namespacedOrderId, 'cross-fill-ack-created');
    crossJurisdictionFills.push(ack.instruction);
    mempoolOps.push({ accountId, tx: ack.tx });
  }
};
