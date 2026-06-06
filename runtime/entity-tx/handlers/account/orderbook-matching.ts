import type { EntityState } from '../../../types';
import {
  applyCommand,
  deriveSide,
  getBookOrder,
  getBestAsk,
  getBestBid,
  refreshRestingOrder,
  SWAP_LOT_SCALE,
  type BookState,
  type OrderbookExtState,
} from '../../../orderbook';
import { SWAP as SWAP_CONSTANTS } from '../../../constants';
import { getSwapPairPolicyByBaseQuote, type SwapPairPolicy } from '../../../account-utils';
import { HEAVY_LOGS } from '../../../utils';
import { createStructuredLogger, shortId, shortOrder, shouldLogFullPayloads } from '../../../logger';
import {
  compareCanonicalText,
  type NormalizedOrderbookOffer,
  type WorkingOrderbookOffer,
  swapKey,
} from '../../../swap-execution';
import {
  buildCrossJurisdictionFillAck,
  markCrossJurisdictionBookAdmissionClosed,
  type CrossJurisdictionFillInstruction,
  type CrossMarketOffer,
} from '../../../cross-jurisdiction-orderbook';
import {
  findQueuedCrossSwapAckForEntityState,
  hasQueuedCrossSwapAckForEntityState,
  hasQueuedSwapResolveForEntityState,
  queueUniqueSwapResolveForEntityState,
  type MempoolOp,
} from './orderbook-queue';
import {
  normalizeSwapOfferForOrderbook,
  resolveStoredOfferEntityRefs,
  sortSwapOffersForOrderbook,
  type MatchResult,
} from './orderbook-offers';
import {
  aggregateCrossTradeFills,
  aggregateSameTradeFills,
  buildCrossMarketOfferForHub,
  buildCrossMarketOfferFromBookOrder,
  buildSameFillResolvePlan,
  createEmptyPairBook,
  deriveSameOrderbookMaterialization,
  evaluateSameOrderbookPriceBand,
  extractOfferIdForLog,
  parseNamespacedOrderId,
  rejectEventsForOrder,
  resolvePairBandReference,
  splitWorkingOrderbookOffers,
  tradeEvents as collectTradeEvents,
  type OrderbookProcessOptions,
} from './orderbook-matching-helpers';

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

  const crossLiveOfferMeta = new Map<string, CrossMarketOffer>();
  const assertedCrossJurisdictionPairs = new Set<string>();
  const crossAggregatedFills = new Map<string, { filledLots: number; weightedCost: bigint }>();

  const getCrossMarketOffer = (offer: NormalizedOrderbookOffer): CrossMarketOffer | null => {
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
    if (qtyLots > 0xffffffffn) {
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
      const cancelResult = applyCommand(book, {
        kind: 1,
        ownerId: meta.makerId,
        orderId: namespacedOrderId,
      });
      book = cancelResult.state;
    }

    bookCache.set(pairId, book);
    bookUpdates.push({ pairId, book });
  };

  const removeCrossBookOrderAfterFill = (pairId: string, namespacedOrderId: string, reason: string): void => {
    let book = bookCache.get(pairId) || ext.books.get(pairId);
    if (!book) return;
    const order = getBookOrder(book, namespacedOrderId);
    if (!order) return;
    const result = applyCommand(book, {
      kind: 1,
      ownerId: order.ownerId,
      orderId: namespacedOrderId,
    });
    book = result.state;
    bookCache.set(pairId, book);
    bookUpdates.push({ pairId, book });
    orderbookLog.debug('crossj.book.remove_resolving', {
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
        if (canonicalQtyLots > 0xffffffffn) {
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

  const processCrossJurisdictionOffers = (): void => {
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
      if (qtyLots > 0xffffffffn) {
        rejectInvalidCrossOffer(currentAccountId, rawOffer.offerId, `invalid-cross-qty:${qtyLots.toString()}`);
        continue;
      }

      crossLiveOfferMeta.set(currentNamespacedOrderId, marketOffer);
      if (hasQueuedSwapResolveForEntityState(hubState, queuedSwapResolutions, currentAccountId, rawOffer.offerId)) {
        continue;
      }
      // Cross-j routes carry delayed clearing state outside the plain book.
      // The book itself is loaded from the persisted snapshot and updated by
      // normal order commands, never rebuilt from an account scan in live mode.
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
        const refreshResult = applyCommand(book, {
          kind: 1,
          ownerId: marketOffer.makerId,
          orderId: currentNamespacedOrderId,
        });
        book = refreshResult.state;
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

  const processSameAccountOffers = (): void => {
    for (const rawOffer of sortSwapOffersForOrderbook(sameAccountSwapOffers)) {
      let offer = rawOffer;
      const currentAccountId = offer.accountId;
      if (hasQueuedSwapResolveForEntityState(hubState, queuedSwapResolutions, currentAccountId, offer.offerId)) {
        continue;
      }
      orderbookLog.debug('offer.process', { offer: shortOrder(offer.offerId), account: shortId(currentAccountId, 8) });

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

      // ext.books is the persisted hot book snapshot. Live mode must not rebuild
      // it by scanning accounts; mismatches are bugs that need a root-cause fix.
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
            `📊 ORDERBOOK-RESTING: already materialized offer=${offer.offerId} account=${currentAccountId.slice(-8)} ` +
              `price=${priceTicks.toString()} qty=${qtyLots.toString()}`,
          );
          bookCache.set(bookKey, book);
          continue;
        }
        console.warn(
          `⚠️ ORDERBOOK: cached order mismatch for live offer=${offer.offerId} account=${currentAccountId.slice(-8)} ` +
            `storedPrice=${existingOrder.priceTicks.toString()} canonicalPrice=${priceTicks.toString()} ` +
            `storedQty=${existingOrder.qtyLots.toString()} canonicalQty=${qtyLots.toString()}`,
        );
        throw new Error(`ORDERBOOK_CACHE_MISMATCH: pair=${bookKey} order=${currentNamespacedOrderId}`);
      }
      orderbookLog.debug('order.add', {
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
            `⚠️ ORDERBOOK FULL: pair=${bookKey} maxOrders=${book.params.maxOrders} offer=${offer.offerId} account=${currentAccountId.slice(-8)}`,
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
            orderbookLog.debug('resolve.queued_cancel_full_book', {
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
      // Keep the updated pair book hot for the rest of this matching pass.
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
            `⚠️ ORDERBOOK REJECT: offer=${offer.offerId} account=${currentAccountId.slice(-8)} side=${side} price=${priceTicks.toString()} qty=${qtyLots.toString()} bestBid=${String(bestBid)} bestAsk=${String(bestAsk)} reason=${rejectReasons || 'unknown'}`,
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
            orderbookLog.debug('resolve.queued_cancel_reject', {
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
          orderbookLog.debug('trade', {
            maker: shortOrder(extractOfferIdForLog(event.makerOrderId)),
            taker: shortOrder(extractOfferIdForLog(event.takerOrderId)),
            price: event.price.toString(),
            qty: event.qty,
          });
        }

        // Emit swap_resolve for each filled order
        for (const [namespacedOrderId, fill] of aggregateSameTradeFills(tradeEvents)) {
          const { accountId, offerId } = parseNamespacedOrderId(namespacedOrderId, 'ORDERBOOK_FILL_LOOKUP_FAILED');
          if (hasQueuedSwapResolveForEntityState(hubState, queuedSwapResolutions, accountId, offerId)) {
            continue;
          }

          if (HEAVY_LOGS) {
            orderbookLog.trace('lookup', {
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
          orderbookLog.debug('lookup.found', { account: shortId(accountId, 8), offer: shortOrder(offerId, 8) });

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
            orderbookLog.debug('resolve.queued', {
              offer: shortOrder(offerId, 8),
              fillPct: plan.fillPct,
              cancel: plan.cancelRemainder,
              source: plan.offerSource,
            });
          }
          if (shouldLogFullPayloads()) {
            orderbookLog.trace('resolve.payload', {
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

  processCrossJurisdictionOffers();
  processSameAccountOffers();

  if (pairSweepCount > 0) {
    orderbookLog.debug('pass.summary', { pairSweep: pairSweepCount });
  }

  return { mempoolOps, crossJurisdictionFills, bookUpdates, debugProjectionRejects };
}
