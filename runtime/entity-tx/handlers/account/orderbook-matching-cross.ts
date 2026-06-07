import type { EntityState } from '../../../types';
import {
  applyCommand,
  getBookOrder,
  SWAP_LOT_SCALE,
  type BookState,
  type OrderbookExtState,
} from '../../../orderbook';
import { getSwapPairPolicyByBaseQuote } from '../../../account-utils';
import { createStructuredLogger, shortOrder } from '../../../logger';
import { compareCanonicalText, swapKey, type CrossJurisdictionWorkingOrderbookOffer } from '../../../swap-execution';
import {
  buildCrossJurisdictionMarketOffer,
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
import {
  aggregateCrossTradeFills,
  buildCrossMarketOfferFromBookOrder,
  createEmptyPairBook,
  MAX_ORDERBOOK_QTY_LOTS,
  parseNamespacedOrderId,
  rejectEventsForOrder,
  tradeEvents as collectTradeEvents,
} from './orderbook-matching-helpers';

const orderbookCrossLog = createStructuredLogger('orderbook.cross');

const crossBookQtyLots = (baseAmount: bigint): bigint => {
  if (baseAmount <= 0n) return 0n;
  return (baseAmount + SWAP_LOT_SCALE - 1n) / SWAP_LOT_SCALE;
};

type RejectInvalidCrossOffer = (accountId: string, offerId: string, reason: string) => void;
type RecordDebugProjectionReject = (accountId: string, offerId: string, reason: string) => true;

type CrossOrderbookProcessInput = {
  hubState: EntityState;
  ext: OrderbookExtState;
  crossJurisdictionSwapOffers: CrossJurisdictionWorkingOrderbookOffer[];
  bookCache: Map<string, BookState>;
  bookUpdates: { pairId: string; book: BookState }[];
  mempoolOps: MempoolOp[];
  crossJurisdictionFills: CrossJurisdictionFillInstruction[];
  queuedSwapResolutions: Set<string>;
  debugRebuildProjectionOnly: boolean;
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
    rejectInvalidCrossOffer,
    recordDebugProjectionReject,
  } = input;

  const crossLiveOfferMeta = new Map<string, CrossMarketOffer>();
  const assertedCrossJurisdictionPairs = new Set<string>();
  const crossAggregatedFills = new Map<string, { filledLots: number; weightedCost: bigint }>();
  const suspendedCrossOrderIds = new Set<string>();

  const getCrossMarketOffer = (offer: CrossJurisdictionWorkingOrderbookOffer): CrossMarketOffer | null => {
    const key = swapKey(offer.accountId, offer.offerId);
    const cached = crossLiveOfferMeta.get(key);
    if (cached) return cached;
    const marketOffer = buildCrossJurisdictionMarketOffer(offer, hubState.entityId);
    if (marketOffer) crossLiveOfferMeta.set(key, marketOffer);
    return marketOffer;
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

  const assertCrossBookMatchesCommittedOffers = (pairId: string, book: BookState): BookState => {
    if (assertedCrossJurisdictionPairs.has(pairId)) return book;
    assertedCrossJurisdictionPairs.add(pairId);

    for (const order of [...book.orders.values()]) {
      const orderId = order.orderId;
      const { accountId, offerId } = parseNamespacedOrderId(orderId, 'ORDERBOOK_CROSS_J_MALFORMED_BOOK_ORDER');
      const queuedPendingAck = findQueuedCrossSwapAckForEntityState(hubState, accountId, offerId);
      const pendingAck = queuedPendingAck?.data ?? null;
      const meta = crossLiveOfferMeta.get(orderId) ?? buildCrossMarketOfferFromBookOrder(hubState, orderId);
      if (!meta) {
        throw new Error(
          `ORDERBOOK_CROSS_J_SNAPSHOT_MISSING: pair=${pairId} order=${orderId} ` +
            `account=${accountId} offer=${offerId} pendingAck=${pendingAck ? 'yes' : 'no'}`,
        );
      }

      crossLiveOfferMeta.set(orderId, meta);
      // Cross-j fill ratios are exact account/hash-ledger state, while the
      // matcher stores whole lots. Use a ceiling lot count for the live row:
      // the route cap still prevents over-settlement, and dropping the final
      // fractional lot would silently remove working liquidity.
      const canonicalQtyLots = crossBookQtyLots(meta.baseAmount);
      if (pendingAck) {
        // A cross-j partial fill ACK is an in-flight account settlement, not a
        // book cancel. Keep the row as the canonical hot-cache remainder, but
        // suspend it until accountMachine.swapOffers reflects the ACK.
        suspendedCrossOrderIds.add(orderId);
        continue;
      }
      const staticMismatch =
        meta.pairId !== pairId || order.priceTicks !== meta.priceTicks || order.ownerId !== meta.makerId;
      const storedQtyLots = BigInt(order.qtyLots);
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
    return book;
  };

  for (const [pairId, book] of ext.books) {
    if (!String(pairId).startsWith('cross:')) continue;
    const currentBook = bookCache.get(pairId) || book;
    const checkedBook = assertCrossBookMatchesCommittedOffers(pairId, currentBook);
    bookCache.set(pairId, checkedBook);
  }

  for (const rawOffer of crossJurisdictionSwapOffers) {
    const currentAccountId = rawOffer.accountId;
    const currentNamespacedOrderId = swapKey(currentAccountId, rawOffer.offerId);
    const marketOffer = getCrossMarketOffer(rawOffer);
    if (!marketOffer) {
      rejectInvalidCrossOffer(currentAccountId, rawOffer.offerId, 'invalid-cross-j-route');
      continue;
    }
    const qtyLots = crossBookQtyLots(marketOffer.baseAmount);
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
    if (hasQueuedCrossSwapAckForEntityState(hubState, currentAccountId, rawOffer.offerId)) {
      suspendedCrossOrderIds.add(currentNamespacedOrderId);
      continue;
    }
    if (hasQueuedSwapResolveForEntityState(hubState, queuedSwapResolutions, currentAccountId, rawOffer.offerId)) {
      continue;
    }
    let book = bookCache.get(marketOffer.pairId) || ext.books.get(marketOffer.pairId);
    if (!book) {
      book = createEmptyPairBook(
        getSwapPairPolicyByBaseQuote(rawOffer.giveTokenId, rawOffer.wantTokenId).bookBucketWidthTicks,
      );
    } else {
      book = assertCrossBookMatchesCommittedOffers(marketOffer.pairId, book);
    }
    const existingOrder = getBookOrder(book, currentNamespacedOrderId);
    if (existingOrder) {
      const storedQtyLots = BigInt(existingOrder.qtyLots);
      if (
        existingOrder.ownerId !== marketOffer.makerId ||
        existingOrder.side !== marketOffer.side ||
        existingOrder.priceTicks !== marketOffer.priceTicks ||
        storedQtyLots !== qtyLots
      ) {
        throw new Error(
          `ORDERBOOK_CROSS_J_DUPLICATE_SNAPSHOT_MISMATCH: pair=${marketOffer.pairId} order=${currentNamespacedOrderId} ` +
            `storedOwner=${existingOrder.ownerId} canonicalOwner=${marketOffer.makerId} ` +
            `storedQty=${storedQtyLots.toString()} canonicalQty=${qtyLots.toString()} ` +
            `storedPrice=${existingOrder.priceTicks.toString()} canonicalPrice=${marketOffer.priceTicks.toString()}`,
        );
      }
      bookCache.set(marketOffer.pairId, book);
      continue;
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
      }, { suspendedOrderIds: suspendedCrossOrderIds });
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
      suspendedCrossOrderIds.add(namespacedOrderId);
      continue;
    }
    const ack = buildCrossJurisdictionFillAck(accountId, offerId, namespacedOrderId, meta, fill);
    if (!ack) continue;
    // Do not remove a partial cross-j maker row. The core book already reduced
    // its lot quantity during matching, and the pending ACK suspends it until
    // accountMachine.swapOffers reflects the ACK. Removing it here would make
    // the live book lose a still-working order.
    if (ack.tx.data.cancelRemainder) {
      removeCrossBookOrderAfterFill(meta.pairId, namespacedOrderId, 'cross-fill-ack-terminal');
    }
    crossJurisdictionFills.push(ack.instruction);
    mempoolOps.push({ accountId, tx: ack.tx });
  }
};
