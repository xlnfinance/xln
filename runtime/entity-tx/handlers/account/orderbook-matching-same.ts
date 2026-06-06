import type { EntityState } from '../../../types';
import {
  applyCommand,
  getBestAsk,
  getBestBid,
  getBookOrder,
  type BookState,
  type OrderbookExtState,
} from '../../../orderbook';
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
import { sortSwapOffersForOrderbook } from './orderbook-offers';
import {
  aggregateSameTradeFills,
  buildSameFillResolvePlan,
  createEmptyPairBook,
  deriveSameOrderbookMaterialization,
  evaluateSameOrderbookPriceBand,
  extractOfferIdForLog,
  parseNamespacedOrderId,
  rejectEventsForOrder,
  tradeEvents as collectTradeEvents,
} from './orderbook-matching-helpers';

const orderbookSameLog = createStructuredLogger('orderbook.same');

type RecordDebugProjectionReject = (accountId: string, offerId: string, reason: string) => true;
type RejectInvalidOffer = (accountId: string, offerId: string, reason: string) => void;
type ContainCurrentOfferPairFailure = (
  pairId: string,
  currentAccountId: string,
  currentOfferId: string,
  message: string,
) => void;
type SweepPairOutOfBandOffers = (
  pairId: string,
  pairPolicy: SwapPairPolicy,
  hasExplicitPairPolicy: boolean,
  currentBook: BookState,
) => BookState;
type AssertBookMatchesKnownAccountOffers = (pairId: string, book: BookState) => BookState;

export type SameOrderbookProcessInput = {
  hubState: EntityState;
  ext: OrderbookExtState;
  sameAccountSwapOffers: SameJurisdictionWorkingOrderbookOffer[];
  minTradeSize: bigint;
  swapTakerFeeBps: number;
  bookCache: Map<string, BookState>;
  bookUpdates: { pairId: string; book: BookState }[];
  mempoolOps: MempoolOp[];
  orderbookOfferMeta: Map<string, NormalizedOrderbookOffer>;
  sweptPairs: Set<string>;
  queuedSwapResolutions: Set<string>;
  debugRebuildProjectionOnly: boolean;
  recordDebugProjectionReject: RecordDebugProjectionReject;
  rejectInvalidOffer: RejectInvalidOffer;
  containCurrentOfferPairFailure: ContainCurrentOfferPairFailure;
  sweepPairOutOfBandOffers: SweepPairOutOfBandOffers;
  assertBookMatchesKnownAccountOffers: AssertBookMatchesKnownAccountOffers;
};

export const processSameAccountOrderbookOffers = (input: SameOrderbookProcessInput): void => {
  const {
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
  } = input;

  for (const offer of sortSwapOffersForOrderbook(sameAccountSwapOffers)) {
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
            ...(resolveComment ? { comment: resolveComment } : {}),
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
};
