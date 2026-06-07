import type { EntityState } from '../../../types';
import {
  applyCommand,
  deriveSide,
  getBestAsk,
  getBestBid,
  getBookOrder,
  SWAP_LOT_SCALE,
  type BookState,
  type OrderbookExtState,
} from '../../../orderbook';
import { SWAP as SWAP_CONSTANTS } from '../../../constants';
import type { SwapPairPolicy } from '../../../account-utils';
import { createStructuredLogger, shortId, shortOrder, shouldLogFullPayloads } from '../../../logger';
import { HEAVY_LOGS } from '../../../utils';
import {
  type NormalizedOrderbookOffer,
  type SameJurisdictionWorkingOrderbookOffer,
} from '../../../swap-execution';
import {
  hasQueuedSwapResolveForEntityState,
  queueUniqueSwapResolveForEntityState,
  type MempoolOp,
} from './orderbook-queue';
import { normalizeSwapOfferForOrderbook, resolveStoredOfferEntityRefs } from './orderbook-offers';
import {
  aggregateSameTradeFills,
  buildSameFillResolvePlan,
  createEmptyPairBook,
  deriveSameOrderbookMaterialization,
  evaluateSameOrderbookPriceBand,
  extractOfferIdForLog,
  parseNamespacedOrderId,
  rejectEventsForOrder,
  resolvePairBandReference,
  tradeEvents as collectTradeEvents,
} from './orderbook-matching-helpers';

const orderbookSameLog = createStructuredLogger('orderbook.same');

type RecordDebugProjectionReject = (accountId: string, offerId: string, reason: string) => true;
type RejectInvalidOffer = (accountId: string, offerId: string, reason: string) => void;
type CancelNonWorkingBookOrder = (
  pairId: string,
  book: BookState,
  order: NonNullable<ReturnType<typeof getBookOrder>>,
  reason: string,
) => BookState;

type SameOrderbookProcessInput = {
  hubState: EntityState;
  ext: OrderbookExtState;
  sameAccountSwapOffers: SameJurisdictionWorkingOrderbookOffer[];
  minTradeSize: bigint;
  swapTakerFeeBps: number;
  bookCache: Map<string, BookState>;
  bookUpdates: { pairId: string; book: BookState }[];
  mempoolOps: MempoolOp[];
  queuedSwapResolutions: Set<string>;
  debugRebuildProjectionOnly: boolean;
  recordDebugProjectionReject: RecordDebugProjectionReject;
  rejectInvalidOffer: RejectInvalidOffer;
  cancelNonWorkingBookOrder: CancelNonWorkingBookOrder;
};

export const processSameAccountOrderbookOffers = (input: SameOrderbookProcessInput): void => {
  // Same-chain orders are account-local: the committed swap offer and committed
  // token hold are the source of truth. Fills/cancels are expressed only as
  // swap_resolve with an exact ratio; fillRatio=0 is a cancel with a reason.
  // This path must not borrow cross-j hash-ledger behavior.
  const {
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
  } = input;

  const orderbookOfferMeta = new Map<string, NormalizedOrderbookOffer>();
  const sweptPairs = new Set<string>();
  let pairSweepCount = 0;

  const buildLiveOfferMeta = (namespacedOrderId: string): NormalizedOrderbookOffer | null => {
    const { accountId, offerId } = parseNamespacedOrderId(namespacedOrderId, 'ORDERBOOK_MALFORMED_BOOK_ORDER');
    const account = hubState.accounts.get(accountId);
    const liveOffer = account?.swapOffers?.get(offerId);
    if (!account || !liveOffer || liveOffer.crossJurisdiction) return null;
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
      `ORDERBOOK_PAIR_ERROR: pair=${pairId} offer=${currentOfferId} ` +
        `account=${currentAccountId.slice(-8)} error=${message}`,
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
    const rejectBps = SWAP_CONSTANTS.PRICE_REJECT_BPS;
    const bpsBase = SWAP_CONSTANTS.BPS_BASE;
    const bestBid = getBestBid(currentBook);
    const bestAsk = getBestAsk(currentBook);
    const { anchor: bandAnchor, label: bandLabel } = resolvePairBandReference(
      pairPolicy,
      hasExplicitPairPolicy,
      bestBid,
      bestAsk,
    );
    if (bandAnchor === null) return currentBook;

    const minAllowed = bandAnchor - (bandAnchor * BigInt(rejectBps)) / BigInt(bpsBase);
    const maxAllowed = bandAnchor + (bandAnchor * BigInt(rejectBps)) / BigInt(bpsBase);
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
          `ORDERBOOK_SWEEP_OUT_OF_BAND: offer=${liveOffer.offerId} pair=${pairId} ` +
            `price=${order.priceTicks.toString()} outside +/-${rejectBps / 100}% of ` +
            `${bandLabel} ${bandAnchor.toString()}`,
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
            comment: `outside-anchor-band:${order.priceTicks.toString()}`,
          });
        }
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

  for (const offer of sameAccountSwapOffers) {
    const currentAccountId = offer.accountId;
    if (hasQueuedSwapResolveForEntityState(hubState, queuedSwapResolutions, currentAccountId, offer.offerId)) {
      continue;
    }
    orderbookSameLog.debug('offer.process', { offer: shortOrder(offer.offerId), account: shortId(currentAccountId, 8) });

    const materialized = deriveSameOrderbookMaterialization(offer, minTradeSize);
    if (materialized.kind === 'reject') {
      console.warn(materialized.message);
      rejectInvalidOffer(currentAccountId, offer.offerId, materialized.reason);
      continue;
    }
    const {
      pairId: bookKey,
      base,
      quote,
      side,
      priceTicks,
      qtyLots,
      makerId,
      namespacedOrderId: currentNamespacedOrderId,
      pairPolicy,
      hasExplicitPairPolicy,
      bucketWidthTicks,
    } = materialized.order;

    let book = bookCache.get(bookKey) || ext.books.get(bookKey);
    if (!book) {
      book = createEmptyPairBook(bucketWidthTicks);
    } else {
      book = assertBookMatchesKnownAccountOffers(bookKey, book);
    }

    if (!sweptPairs.has(bookKey)) {
      sweptPairs.add(bookKey);
      const sweptBook = sweepPairOutOfBandOffers(bookKey, pairPolicy, hasExplicitPairPolicy, book);
      if (sweptBook !== book) {
        book = sweptBook;
        bookCache.set(bookKey, book);
        bookUpdates.push({ pairId: bookKey, book });
      }
    }

    const bestBid = getBestBid(book);
    const bestAsk = getBestAsk(book);
    const priceBand = evaluateSameOrderbookPriceBand({
      priceTicks,
      side,
      bestBid,
      bestAsk,
      pairPolicy,
      hasExplicitPairPolicy,
    });
    if (priceBand.rejectReason) {
      console.warn(`${priceBand.rejectMessage} offer=${offer.offerId}`);
      if (debugRebuildProjectionOnly) {
        recordDebugProjectionReject(currentAccountId, offer.offerId, priceBand.rejectReason);
        continue;
      }
      queueUniqueSwapResolveForEntityState(mempoolOps, hubState, queuedSwapResolutions, currentAccountId, {
        offerId: offer.offerId,
        fillRatio: 0,
        cancelRemainder: true,
        comment: priceBand.rejectReason,
      });
      continue;
    }
    if (priceBand.warnMessage) console.warn(priceBand.warnMessage);

    orderbookOfferMeta.set(currentNamespacedOrderId, {
      ...offer,
      accountId: currentAccountId,
      priceTicks,
    });
    const existingOrder = getBookOrder(book, currentNamespacedOrderId);
    if (existingOrder) {
      if (
        existingOrder.ownerId === makerId &&
        existingOrder.side === side &&
        BigInt(existingOrder.qtyLots) === qtyLots &&
        existingOrder.priceTicks === priceTicks
      ) {
        console.log(
          `ORDERBOOK-RESTING: already materialized offer=${offer.offerId} account=${currentAccountId.slice(-8)} ` +
            `price=${priceTicks.toString()} qty=${qtyLots.toString()}`,
        );
        bookCache.set(bookKey, book);
        continue;
      }
      console.warn(
        `ORDERBOOK_CACHE_MISMATCH: live offer=${offer.offerId} account=${currentAccountId.slice(-8)} ` +
          `storedPrice=${existingOrder.priceTicks.toString()} canonicalPrice=${priceTicks.toString()} ` +
          `storedQty=${existingOrder.qtyLots.toString()} canonicalQty=${qtyLots.toString()}`,
      );
      throw new Error(`ORDERBOOK_CACHE_MISMATCH: pair=${bookKey} order=${currentNamespacedOrderId}`);
    }
    orderbookSameLog.debug('order.add', {
      maker: shortId(makerId),
      order: shortOrder(currentNamespacedOrderId, 20),
      side,
      price: priceTicks.toString(),
      qty: qtyLots.toString(),
    });

    let result: ReturnType<typeof applyCommand>;
    try {
      result = applyCommand(book, {
        kind: 0,
        ownerId: makerId,
        orderId: currentNamespacedOrderId,
        side,
        tif: offer.timeInForce,
        postOnly: debugRebuildProjectionOnly,
        priceTicks,
        qtyLots: Number(qtyLots),
        minFillRatio: offer.minFillRatio,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message === 'Out of order slots') {
        console.warn(
          `ORDERBOOK_FULL: pair=${bookKey} maxOrders=${book.params.maxOrders} offer=${offer.offerId} account=${currentAccountId.slice(-8)}`,
        );
        if (debugRebuildProjectionOnly) {
          recordDebugProjectionReject(currentAccountId, offer.offerId, `book-full:${book.params.maxOrders}`);
          continue;
        }
        if (
          queueUniqueSwapResolveForEntityState(mempoolOps, hubState, queuedSwapResolutions, currentAccountId, {
            offerId: offer.offerId,
            fillRatio: 0,
            cancelRemainder: true,
            comment: `book-full:${book.params.maxOrders}`,
          })
        ) {
          orderbookSameLog.debug('resolve.queued_cancel_full_book', {
            offer: shortOrder(offer.offerId, 8),
            account: shortId(currentAccountId, 8),
          });
        }
        continue;
      }
      containCurrentOfferPairFailure(bookKey, currentAccountId, offer.offerId, message);
      continue;
    }

    book = result.state;
    bookCache.set(bookKey, book);
    bookUpdates.push({ pairId: bookKey, book });

    try {
      const rejectEvents = rejectEventsForOrder(result.events, currentNamespacedOrderId);
      const tradeEvents = collectTradeEvents(result.events);
      const stpRejectEvent = rejectEvents.find(event => event.reason === 'STP cancel taker');
      const resolveComment = stpRejectEvent ? `STP:${String(stpRejectEvent.blockingOrderId || '')}` : undefined;
      const offerRejectedWithoutFill = rejectEvents.length > 0 && tradeEvents.length === 0;
      if (offerRejectedWithoutFill) {
        const rejectReasons = rejectEvents
          .map(event => event.reason)
          .filter(Boolean)
          .join(', ');
        console.warn(
          `ORDERBOOK_REJECT: offer=${offer.offerId} account=${currentAccountId.slice(-8)} side=${side} ` +
            `price=${priceTicks.toString()} qty=${qtyLots.toString()} bestBid=${String(bestBid)} ` +
            `bestAsk=${String(bestAsk)} reason=${rejectReasons || 'unknown'}`,
        );
        if (debugRebuildProjectionOnly) {
          recordDebugProjectionReject(
            currentAccountId,
            offer.offerId,
            `post-only-reject:${rejectReasons || 'unknown'}`,
          );
          continue;
        }
        if (
          queueUniqueSwapResolveForEntityState(mempoolOps, hubState, queuedSwapResolutions, currentAccountId, {
            offerId: offer.offerId,
            fillRatio: 0,
            cancelRemainder: true,
            comment: resolveComment ?? `post-only-reject:${rejectReasons || 'unknown'}`,
          })
        ) {
          orderbookSameLog.debug('resolve.queued_cancel_reject', {
            offer: shortOrder(offer.offerId, 8),
            account: shortId(currentAccountId, 8),
          });
        }
        continue;
      }

      if (debugRebuildProjectionOnly) {
        continue;
      }

      for (const event of tradeEvents) {
        orderbookSameLog.debug('trade', {
          maker: shortOrder(extractOfferIdForLog(event.makerOrderId)),
          taker: shortOrder(extractOfferIdForLog(event.takerOrderId)),
          price: event.price.toString(),
          qty: event.qty,
        });
      }

      for (const [namespacedOrderId, fill] of aggregateSameTradeFills(tradeEvents)) {
        const { accountId, offerId } = parseNamespacedOrderId(namespacedOrderId, 'ORDERBOOK_FILL_LOOKUP_FAILED');
        if (hasQueuedSwapResolveForEntityState(hubState, queuedSwapResolutions, accountId, offerId)) {
          continue;
        }

        if (HEAVY_LOGS) {
          orderbookSameLog.trace('lookup', {
            account: shortId(accountId, 8),
            known: Array.from(hubState.accounts.keys()).map(id => shortId(id, 8)),
            found: hubState.accounts.has(accountId),
          });
        }
        const account = hubState.accounts.get(accountId);
        if (!account) {
          throw new Error(
            `ORDERBOOK_ACCOUNT_LOOKUP_FAILED: offer=${offerId} accountId=${accountId} ` +
              `known=[${Array.from(hubState.accounts.keys()).join(',')}]`,
          );
        }
        orderbookSameLog.debug('lookup.found', { account: shortId(accountId, 8), offer: shortOrder(offerId, 8) });

        const plan = buildSameFillResolvePlan({
          accountId,
          offerId,
          namespacedOrderId,
          fill,
          currentNamespacedOrderId,
          currentOffer: offer,
          batchOffer: orderbookOfferMeta.get(namespacedOrderId) ?? null,
          accountOffer: account.swapOffers?.get(offerId) ?? null,
          book,
          bookKey,
          ...(resolveComment ? { resolveComment } : {}),
          takerFeeBps: swapTakerFeeBps,
        });

        if (
          queueUniqueSwapResolveForEntityState(
            mempoolOps,
            hubState,
            queuedSwapResolutions,
            accountId,
            plan.resolveEnqueueData,
          )
        ) {
          orderbookSameLog.debug('resolve.queued', {
            offer: shortOrder(offerId, 8),
            fillPct: plan.fillPct,
            cancel: plan.cancelRemainder,
            source: plan.offerSource,
          });
        }
        if (shouldLogFullPayloads()) {
          orderbookSameLog.trace('resolve.payload', {
            accountId,
            offerId,
            namespacedOrderId,
            offerSource: plan.offerSource,
            side,
            baseTokenId: base,
            quoteTokenId: quote,
            originalLots: fill.originalLots,
            filledLots: fill.filledLots,
            weightedCost: fill.weightedCost.toString(),
            executionBaseWei: plan.trace.executionBaseWei.toString(),
            executionQuoteWei: plan.trace.executionQuoteWei.toString(),
            orderStillInBook: !plan.cancelRemainder,
            offerGiveTokenId: plan.trace.offerGiveTokenId,
            offerWantTokenId: plan.trace.offerWantTokenId,
            offerGiveAmount: plan.trace.offerGiveAmount.toString(),
            offerQuantizedGive: plan.trace.offerQuantizedGive.toString(),
          });
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      containCurrentOfferPairFailure(bookKey, currentAccountId, offer.offerId, message);
      continue;
    }
  }

  if (pairSweepCount > 0) {
    orderbookSameLog.debug('pass.summary', { pairSweep: pairSweepCount });
  }
};
