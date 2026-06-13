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
  crossJurisdictionBookAdmissionKeyFor,
  type CrossJurisdictionFillInstruction,
  type CrossMarketOffer,
} from '../../../cross-jurisdiction-orderbook';
import {
  buildCrossJurisdictionPendingFillFromAck,
  CROSS_J_PENDING_FILL_ACK_TTL_MS,
} from '../../../cross-jurisdiction-fill-ack';
import { safeStringify } from '../../../serialization-utils';
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

const cloneCrossBookForSimulation = (book: BookState): BookState => structuredClone(book) as BookState;

const crossBookQtyLots = (baseAmount: bigint): bigint => {
  if (baseAmount <= 0n) return 0n;
  return (baseAmount + SWAP_LOT_SCALE - 1n) / SWAP_LOT_SCALE;
};

const isWorkingCrossRouteStatus = (status: string | undefined): boolean =>
  status === 'resting' || status === 'partially_filled';

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
  const workingBookCache = new Map<string, BookState>();
  const speculativeTradePairs = new Set<string>();

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

  const getWorkingBook = (pairId: string, committedBook: BookState): BookState => {
    const cached = workingBookCache.get(pairId);
    if (cached) return cached;
    const workingBook = cloneCrossBookForSimulation(committedBook);
    workingBookCache.set(pairId, workingBook);
    return workingBook;
  };

  const getCrossAdmission = (accountId: string, offerId: string) =>
    hubState.crossJurisdictionBookAdmissions?.get(
      crossJurisdictionBookAdmissionKeyFor(accountId, offerId),
    );

  const assertPendingBookFillAckLive = (accountId: string, offerId: string): boolean => {
    const admission = getCrossAdmission(accountId, offerId);
    const pendingFill = admission?.pendingFill;
    if (!pendingFill) return false;
    const now = Number(hubState.timestamp || 0);
    const updatedAt = Number(pendingFill.updatedAt || admission.updatedAt || 0);
    const ageMs = Math.max(0, now - updatedAt);
    if (ageMs > CROSS_J_PENDING_FILL_ACK_TTL_MS) {
      const payload = {
        entityId: hubState.entityId,
        accountId,
        offerId,
        routeHash: admission.routeHash || admission.route?.routeHash || '',
        bookOwnerEntityId: admission.bookOwnerEntityId,
        sourceEntityId: admission.sourceEntityId,
        pendingFill,
        ageMs,
        ttlMs: CROSS_J_PENDING_FILL_ACK_TTL_MS,
      };
      orderbookCrossLog.error('pending_fill_ack_expired_fatal', payload);
      throw new Error(`ORDERBOOK_CROSS_J_PENDING_FILL_ACK_EXPIRED_FATAL: ${safeStringify(payload)}`);
    }
    return true;
  };

  const committedCrossRouteStatus = (accountId: string, offerId: string): string | undefined => {
    const admission = getCrossAdmission(accountId, offerId);
    if (admission && admission.status !== 'admitted') return `admission:${admission.status}`;
    const entityRoute = hubState.crossJurisdictionSwaps?.get(offerId);
    if (entityRoute?.status) return entityRoute.status;
    const offerRoute = hubState.accounts.get(accountId)?.swapOffers?.get(offerId)?.crossJurisdiction;
    if (offerRoute?.status) return offerRoute.status;
    return admission?.route?.status;
  };

  const assertCrossBookMatchesCommittedOffers = (pairId: string, book: BookState): BookState => {
    if (assertedCrossJurisdictionPairs.has(pairId)) return book;
    assertedCrossJurisdictionPairs.add(pairId);

    for (const order of [...book.orders.values()]) {
      const orderId = order.orderId;
      const { accountId, offerId } = parseNamespacedOrderId(orderId, 'ORDERBOOK_CROSS_J_MALFORMED_BOOK_ORDER');
      const account = hubState.accounts.get(accountId);
      if ((account?.status ?? 'active') !== 'active') {
        const removed = applyCommand(book, {
          kind: 1,
          ownerId: order.ownerId,
          orderId,
        }).state;
        bookCache.set(pairId, removed);
        bookUpdates.push({ pairId, book: removed });
        orderbookCrossLog.debug('book.remove_disputed_account', {
          pair: pairId,
          order: shortOrder(orderId, 20),
          account: accountId.slice(-8),
        });
        book = removed;
        continue;
      }
      const queuedPendingAck = findQueuedCrossSwapAckForEntityState(hubState, accountId, offerId);
      const pendingBookAck = assertPendingBookFillAckLive(accountId, offerId);
      const pendingAck = queuedPendingAck?.data ?? null;
      const committedStatus = committedCrossRouteStatus(accountId, offerId);
      if (committedStatus && !isWorkingCrossRouteStatus(committedStatus)) {
        // Terminal/clearing cross-j routes must disappear from the book
        // permanently. Matching a stale row would fill an already claimed
        // hash-ledger route instead of the next live order at the same price.
        const removed = applyCommand(book, {
          kind: 1,
          ownerId: order.ownerId,
          orderId,
        }).state;
        bookCache.set(pairId, removed);
        bookUpdates.push({ pairId, book: removed });
        orderbookCrossLog.debug('book.remove_non_working', {
          pair: pairId,
          order: shortOrder(orderId, 20),
          status: committedStatus,
        });
        continue;
      }
      const meta = crossLiveOfferMeta.get(orderId) ?? buildCrossMarketOfferFromBookOrder(hubState, orderId);
      if (!meta) {
        throw new Error(
          `ORDERBOOK_CROSS_J_SNAPSHOT_MISSING: pair=${pairId} order=${orderId} ` +
            `account=${accountId} offer=${offerId} pendingAck=${pendingAck ? 'yes' : 'no'}`,
        );
      }

      crossLiveOfferMeta.set(orderId, meta);
      if (pendingBookAck) {
        suspendedCrossOrderIds.add(orderId);
        continue;
      }
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
      if (staticMismatch) {
        throw new Error(
          `ORDERBOOK_CROSS_J_CACHE_MISMATCH: pair=${pairId} order=${orderId} ` +
            `storedPair=${pairId} canonicalPair=${meta.pairId} ` +
            `storedOwner=${order.ownerId} canonicalOwner=${meta.makerId} ` +
            `storedQty=${storedQtyLots.toString()} canonicalQty=${canonicalQtyLots.toString()} ` +
            `storedPrice=${order.priceTicks.toString()} canonicalPrice=${meta.priceTicks.toString()}`,
        );
      }
      if (storedQtyLots !== canonicalQtyLots) {
        // The matcher must never repair cross-j book quantity from route state.
        // Account consensus owns fill progress; book-owner progress events resize
        // the hot book. If this assertion fires, one of those committed events was
        // dropped or applied out of order and matching must stop loudly.
        throw new Error(
          `ORDERBOOK_CROSS_J_CACHE_MISMATCH: pair=${pairId} order=${orderId} ` +
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
    if (assertPendingBookFillAckLive(currentAccountId, rawOffer.offerId)) {
      suspendedCrossOrderIds.add(currentNamespacedOrderId);
      continue;
    }
    if (hasQueuedCrossSwapAckForEntityState(hubState, currentAccountId, rawOffer.offerId)) {
      suspendedCrossOrderIds.add(currentNamespacedOrderId);
      continue;
    }
    if (hasQueuedSwapResolveForEntityState(hubState, queuedSwapResolutions, currentAccountId, rawOffer.offerId)) {
      continue;
    }
    let committedBook = bookCache.get(marketOffer.pairId) || ext.books.get(marketOffer.pairId);
    if (!committedBook) {
      committedBook = createEmptyPairBook(
        getSwapPairPolicyByBaseQuote(rawOffer.giveTokenId, rawOffer.wantTokenId).bookBucketWidthTicks,
      );
    } else {
      committedBook = assertCrossBookMatchesCommittedOffers(marketOffer.pairId, committedBook);
    }
    const existingOrder = getBookOrder(committedBook, currentNamespacedOrderId);
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
      bookCache.set(marketOffer.pairId, committedBook);
      continue;
    }

    const workingBook = getWorkingBook(marketOffer.pairId, committedBook);
    let result: ReturnType<typeof applyCommand>;
    try {
      result = applyCommand(workingBook, {
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
    if (tradeEvents.length === 0 && !speculativeTradePairs.has(marketOffer.pairId)) {
      const committedResult = applyCommand(committedBook, {
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
      if (collectTradeEvents(committedResult.events).length > 0) {
        throw new Error(`ORDERBOOK_CROSS_J_COMMITTED_WRITE_TRADED: order=${currentNamespacedOrderId}`);
      }
      committedBook = committedResult.state;
      bookCache.set(marketOffer.pairId, committedBook);
      bookUpdates.push({ pairId: marketOffer.pairId, book: committedBook });
    }
    if (tradeEvents.length > 0) speculativeTradePairs.add(marketOffer.pairId);
    for (const event of tradeEvents) {
      orderbookCrossLog.debug('trade', {
        maker: shortOrder(event.makerOrderId, 20),
        taker: shortOrder(event.takerOrderId, 20),
        qty: event.qty,
        price: event.price.toString(),
      });
      // Cross-j fills are not a local book-only event. Each matched order now
      // has an account/hash-ledger ACK in flight, so further same-pass matching
      // must stop until committed state reflects that ACK. This keeps the book
      // a projection of terminal account outcomes instead of letting a single
      // matcher pass over-consume a route before its first fill is committed.
      suspendedCrossOrderIds.add(event.makerOrderId);
      suspendedCrossOrderIds.add(event.takerOrderId);
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
    if (!ack) {
      throw new Error(
        `ORDERBOOK_CROSS_J_FILL_ACK_MISSING: order=${namespacedOrderId} ` +
          `account=${accountId} offer=${offerId} filledLots=${fill.filledLots}`,
      );
    }
    const admission = getCrossAdmission(accountId, offerId);
    if (admission) {
      const pendingFill = buildCrossJurisdictionPendingFillFromAck(ack.tx, Number(hubState.timestamp || 0));
      if (pendingFill) {
        admission.pendingFill = pendingFill;
      } else {
        delete admission.pendingFill;
      }
      admission.updatedAt = Number(hubState.timestamp || admission.updatedAt || 0);
    }
    orderbookCrossLog.debug('ack', {
      account: shortOrder(accountId, 12),
      offer: shortOrder(offerId, 12),
      cancel: ack.tx.data.cancelRemainder,
      ratio: ack.tx.data.cumulativeFillRatio,
      exact: ack.tx.data.fillNumerator !== undefined && ack.tx.data.fillDenominator !== undefined
        ? `${ack.tx.data.fillNumerator}/${ack.tx.data.fillDenominator}`
        : 'none',
      source: ack.tx.data.cumulativeSourceAmount?.toString(),
    });
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
