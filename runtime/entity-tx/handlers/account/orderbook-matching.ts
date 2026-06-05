import type { EntityState } from '../../../types';
import {
  applyCommand,
  createBook,
  canonicalPair,
  deriveSide,
  getBookOrder,
  getBestAsk,
  getBestBid,
  refreshRestingOrder,
  ORDERBOOK_PRICE_SCALE,
  SWAP_LOT_SCALE,
  type BookState,
  type OrderbookExtState,
} from '../../../orderbook';
import { LIMITS, SWAP as SWAP_CONSTANTS } from '../../../constants';
import { getSwapPairPolicyByBaseQuote, hasSwapPairPolicyByBaseQuote, type SwapPairPolicy } from '../../../account-utils';
import { HEAVY_LOGS } from '../../../utils';
import { createStructuredLogger, shortId, shortOrder, shouldLogFullPayloads } from '../../../logger';
import {
  buildSwapResolveDataFromOrderbookFill,
  calculateSwapTakerFeeAmount,
  compareCanonicalText,
  MAX_SWAP_FILL_RATIO,
  type AdmittedOrderbookOffer,
  type NormalizedOrderbookOffer,
  swapKey,
} from '../../../swap-execution';
import {
  buildCrossJurisdictionFillAck,
  buildCrossJurisdictionMarketOffer,
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
  type SwapResolveEnqueueData,
} from './orderbook-queue';
import {
  normalizeSwapOfferForOrderbook,
  resolveStoredOfferEntityRefs,
  sortSwapOffersForOrderbook,
  type MatchResult,
} from './orderbook-offers';

const orderbookLog = createStructuredLogger('orderbook');

type OrderbookProcessOptions = {
  debugRebuildProjectionOnly?: boolean;
};


/**
 * Process swap offers through hub's orderbook (PURE - returns events, no mutations)
 * Called at entity level after aggregating all swap events
 */
export function processOrderbookSwaps(
  hubState: EntityState,
  swapOffers: AdmittedOrderbookOffer[],
  options: OrderbookProcessOptions = {},
): MatchResult {
  const mempoolOps: MempoolOp[] = [];
  const crossJurisdictionFills: CrossJurisdictionFillInstruction[] = [];
  const bookUpdates: { pairId: string; book: BookState }[] = [];
  const debugProjectionRejects: Array<{ offerId: string; accountId: string; reason: string }> = [];
  const ext = hubState.orderbookExt as OrderbookExtState | undefined;
  if (!ext) return { mempoolOps, crossJurisdictionFills, bookUpdates, debugProjectionRejects };
  const debugRebuildProjectionOnly = options.debugRebuildProjectionOnly === true;
  const sameAccountSwapOffers = swapOffers.filter((offer) => !offer.crossJurisdiction);
  const crossJurisdictionSwapOffers = swapOffers.filter((offer) => !!offer.crossJurisdiction);
  const minTradeSize = ext.hubProfile?.minTradeSize ?? 0n;
  const swapTakerFeeBpsRaw = hubState.hubRebalanceConfig?.swapTakerFeeBps;
  const swapTakerFeeBps = Number.isFinite(Number(swapTakerFeeBpsRaw))
    ? Math.max(0, Math.min(10_000, Math.floor(Number(swapTakerFeeBpsRaw))))
    : 0;
  const debugProjectionRejectKeys = new Set<string>();
  const recordDebugProjectionReject = (accountId: string, offerId: string, reason: string): true => {
    if (!debugRebuildProjectionOnly) {
      throw new Error(
        `ORDERBOOK_LIVE_PROJECTION_REJECT: account=${accountId} offer=${offerId} reason=${reason}`,
      );
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
    orderbookLog.warn('crossj.offer_skipped', { offer: shortOrder(offerId, 8), account: shortId(accountId, 8), reason });
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

  const parseNamespacedOrderId = (
    namespacedOrderId: string,
    errorCode: string,
  ): { accountId: string; offerId: string } => {
    const lastColon = namespacedOrderId.lastIndexOf(':');
    if (lastColon <= 0 || lastColon === namespacedOrderId.length - 1) {
      throw new Error(`${errorCode}: order=${namespacedOrderId}`);
    }
    return {
      accountId: namespacedOrderId.slice(0, lastColon),
      offerId: namespacedOrderId.slice(lastColon + 1),
    };
  };

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
    const cancelled = result.events.some((event) => event.type === 'CANCELED' && event.orderId === order.orderId);
    if (!cancelled) {
      throw new Error(
        `ORDERBOOK_CANCEL_NONWORKING_FAILED: pair=${pairId} order=${order.orderId} reason=${reason}`,
      );
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

  const materializeCanonicalRestingOffer = (
    giveTokenId: number,
    wantTokenId: number,
    priceTicks: bigint,
    qtyLots: number,
  ): {
    giveTokenId: number;
    wantTokenId: number;
    giveAmount: bigint;
    wantAmount: bigint;
    quantizedGive: bigint;
    quantizedWant: bigint;
    priceTicks: bigint;
  } => {
    const baseAmount = BigInt(qtyLots) * SWAP_LOT_SCALE;
    const side = deriveSide(giveTokenId, wantTokenId);
    const quoteAmount = (baseAmount * priceTicks) / ORDERBOOK_PRICE_SCALE;
    if (side === 1) {
      return {
        giveTokenId,
        wantTokenId,
        giveAmount: baseAmount,
        wantAmount: quoteAmount,
        quantizedGive: baseAmount,
        quantizedWant: quoteAmount,
        priceTicks,
      };
    }
    return {
      giveTokenId,
      wantTokenId,
      giveAmount: quoteAmount,
      wantAmount: baseAmount,
      quantizedGive: quoteAmount,
      quantizedWant: baseAmount,
      priceTicks,
    };
  };

  const buildLiveOfferMeta = (
    namespacedOrderId: string,
  ): NormalizedOrderbookOffer | null => {
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

  const synthesizeOfferFromMissingBookLookup = (
    takerSide: 0 | 1,
    baseTokenId: number,
    quoteTokenId: number,
    originalLots: number,
    filledLots: number,
    weightedCost: bigint,
  ): {
    giveTokenId: number;
    wantTokenId: number;
    giveAmount: bigint;
    wantAmount: bigint;
    quantizedGive: bigint;
    quantizedWant: bigint;
    priceTicks: bigint;
  } => {
    const originalLotsBig = BigInt(Math.max(0, originalLots));
    const filledLotsBig = BigInt(Math.max(0, filledLots));
    if (originalLotsBig <= 0n || filledLotsBig <= 0n) {
      throw new Error(`ORDERBOOK_FILL_LOOKUP_FAILED: invalid lots original=${originalLots} filled=${filledLots}`);
    }

    if (weightedCost <= 0n || weightedCost % filledLotsBig !== 0n) {
      throw new Error(
        `ORDERBOOK_FILL_LOOKUP_FAILED: non-integral maker price weightedCost=${weightedCost.toString()} filledLots=${filledLotsBig.toString()}`,
      );
    }

    const makerSide = takerSide === 0 ? 1 : 0;
    const priceTicks = weightedCost / filledLotsBig;
    const canonicalOffer = materializeCanonicalRestingOffer(
      makerSide === 1 ? baseTokenId : quoteTokenId,
      makerSide === 1 ? quoteTokenId : baseTokenId,
      priceTicks,
      Number(originalLotsBig),
    );
    if (canonicalOffer.giveAmount <= 0n || canonicalOffer.wantAmount <= 0n) {
      throw new Error(
        `ORDERBOOK_FILL_LOOKUP_FAILED: synthesized maker offer is zero give=${canonicalOffer.giveAmount.toString()} want=${canonicalOffer.wantAmount.toString()}`,
      );
    }
    return canonicalOffer;
  };

  const resolvePairBandReference = (
    pairPolicy: SwapPairPolicy,
    hasExplicitPairPolicy: boolean,
    bestBid: bigint | null,
    bestAsk: bigint | null,
  ): { anchor: bigint | null; label: string } => {
    if (bestBid !== null && bestAsk !== null) {
      return { anchor: (bestBid + bestAsk) / 2n, label: 'midpoint' };
    }
    if (bestBid !== null) return { anchor: bestBid, label: 'bestBid' };
    if (bestAsk !== null) return { anchor: bestAsk, label: 'bestAsk' };
    if (!hasExplicitPairPolicy) return { anchor: null, label: 'unanchored' };
    return { anchor: pairPolicy.mmMidPriceTicks, label: 'policyMid' };
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

  const createEmptyPairBook = (
    bucketWidthTicks: number,
  ): BookState => createBook({
    bucketWidthTicks: BigInt(Math.max(1, bucketWidthTicks)),
    maxOrders: LIMITS.MAX_ORDERBOOK_ORDERS_PER_PAIR,
    stpPolicy: 1,
  });

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
    const { anchor: bandAnchor, label: bandLabel } = resolvePairBandReference(pairPolicy, hasExplicitPairPolicy, bestBid, bestAsk);
    if (bandAnchor === null) return currentBook;

    const minAllowed = bandAnchor - ((bandAnchor * BigInt(REJECT_BPS)) / BigInt(BPS_BASE));
    const maxAllowed = bandAnchor + ((bandAnchor * BigInt(REJECT_BPS)) / BigInt(BPS_BASE));
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
          recordDebugProjectionReject(liveOffer.accountId, liveOffer.offerId, `outside-anchor-band:${order.priceTicks.toString()}`);
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
      const metaBaseAmount = metaSide === 1
        ? (meta.quantizedGive ?? meta.giveAmount)
        : meta.wantAmount;
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

  const buildCrossMarketOffer = (offer: NormalizedOrderbookOffer): CrossMarketOffer | null => {
    return buildCrossJurisdictionMarketOffer(offer, hubState.entityId);
  };

  const buildCrossMarketOfferFromBookOrder = (namespacedOrderId: string): CrossMarketOffer | null => {
    const lastColon = namespacedOrderId.lastIndexOf(':');
    if (lastColon === -1) return null;
    const accountId = namespacedOrderId.slice(0, lastColon);
    const offerId = namespacedOrderId.slice(lastColon + 1);
    const account = hubState.accounts.get(accountId);
    const offer = account?.swapOffers?.get(offerId);
    if (!account || !offer?.crossJurisdiction) return null;
    const entityRefs = resolveStoredOfferEntityRefs(account, offer);
    return buildCrossMarketOffer(normalizeSwapOfferForOrderbook(
      {
        offerId,
        makerIsLeft: offer.makerIsLeft,
        fromEntity: entityRefs.fromEntity,
        toEntity: entityRefs.toEntity,
        createdHeight: offer.createdHeight,
        giveTokenId: offer.giveTokenId,
        giveAmount: offer.giveAmount,
        wantTokenId: offer.wantTokenId,
        wantAmount: offer.wantAmount,
        priceTicks: offer.priceTicks,
        timeInForce: offer.timeInForce,
        minFillRatio: offer.minFillRatio,
        crossJurisdiction: offer.crossJurisdiction,
      },
      accountId,
    ));
  };

  const crossLiveOfferMeta = new Map<string, CrossMarketOffer>();
  const crossPendingAckInputs = new Map<
    string,
    NonNullable<NormalizedOrderbookOffer['pendingCrossSwapAck']>
  >();
  for (const rawOffer of crossJurisdictionSwapOffers) {
    if (!rawOffer.pendingCrossSwapAck) continue;
    crossPendingAckInputs.set(swapKey(rawOffer.accountId, rawOffer.offerId), rawOffer.pendingCrossSwapAck);
  }
  const assertedCrossJurisdictionPairs = new Set<string>();
  const crossAggregatedFills = new Map<string, { filledLots: number; weightedCost: bigint }>();

  const refreshExistingCrossBookOrder = (
    pairId: string,
    namespacedOrderId: string,
    meta: CrossMarketOffer,
  ): void => {
    let book = bookCache.get(pairId) || ext.books.get(pairId);
    if (!book || !getBookOrder(book, namespacedOrderId)) return;

    const qtyLots = meta.baseAmount / SWAP_LOT_SCALE;
    if (qtyLots > 0xFFFFFFFFn) {
      throw new Error(`ORDERBOOK_CROSS_J_REFRESH_QTY_INVALID: pair=${pairId} order=${namespacedOrderId} qty=${qtyLots.toString()}`);
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

  const assertCrossBookMatchesKnownRoutes = (pairId: string, book: BookState): BookState => {
    if (assertedCrossJurisdictionPairs.has(pairId)) return book;
    assertedCrossJurisdictionPairs.add(pairId);
    let currentBook = book;

    for (const order of [...book.orders.values()]) {
      const orderId = order.orderId;
      const { accountId, offerId } = parseNamespacedOrderId(orderId, 'ORDERBOOK_CROSS_J_MALFORMED_BOOK_ORDER');
      const queuedPendingAck = findQueuedCrossSwapAckForEntityState(hubState, accountId, offerId);
      const pendingAck = crossPendingAckInputs.get(orderId) ?? queuedPendingAck?.data ?? null;
      const meta = crossLiveOfferMeta.get(orderId) ?? buildCrossMarketOfferFromBookOrder(orderId);
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
        currentBook = cancelNonWorkingBookOrder(pairId, currentBook, order, 'pending-cross-ack');
        continue;
      }
      if (
        meta.pairId !== pairId ||
        order.priceTicks !== meta.priceTicks ||
        order.ownerId !== meta.makerId ||
        BigInt(order.qtyLots) !== canonicalQtyLots
      ) {
        throw new Error(
          `ORDERBOOK_CROSS_J_CACHE_MISMATCH: pair=${pairId} order=${orderId} ` +
          `storedPrice=${order.priceTicks.toString()} canonicalPrice=${meta.priceTicks.toString()}`,
        );
      }
    }
    return currentBook;
  };

  const processCrossJurisdictionOffers = (): void => {
    for (const rawOffer of crossJurisdictionSwapOffers) {
      const marketOffer = buildCrossMarketOffer(rawOffer);
      if (!marketOffer) continue;
      crossLiveOfferMeta.set(swapKey(rawOffer.accountId, rawOffer.offerId), marketOffer);
    }

    for (const rawOffer of sortSwapOffersForOrderbook(crossJurisdictionSwapOffers)) {
      if (crossPendingAckInputs.has(swapKey(rawOffer.accountId, rawOffer.offerId))) continue;
      const marketOffer = buildCrossMarketOffer(rawOffer);
      if (!marketOffer) continue;
      refreshExistingCrossBookOrder(
        marketOffer.pairId,
        swapKey(rawOffer.accountId, rawOffer.offerId),
        marketOffer,
      );
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
      if (crossPendingAckInputs.has(currentNamespacedOrderId)) continue;
      const marketOffer = buildCrossMarketOffer(rawOffer);
      if (!marketOffer) {
        rejectInvalidCrossOffer(currentAccountId, rawOffer.offerId, 'invalid-cross-j-route');
        continue;
      }
      const qtyLots = marketOffer.baseAmount / SWAP_LOT_SCALE;
      if (qtyLots <= 0n) {
        rejectInvalidCrossOffer(currentAccountId, rawOffer.offerId, `cross-dust-remainder:${marketOffer.baseAmount.toString()}`);
        continue;
      }
      if (qtyLots > 0xFFFFFFFFn) {
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
        book = createEmptyPairBook(getSwapPairPolicyByBaseQuote(rawOffer.giveTokenId, rawOffer.wantTokenId).bookBucketWidthTicks);
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
        rejectInvalidCrossOffer(currentAccountId, rawOffer.offerId, `cross-pair-error:${error instanceof Error ? error.message : String(error)}`);
        continue;
      }

      book = result.state;
      bookCache.set(marketOffer.pairId, book);
      bookUpdates.push({ pairId: marketOffer.pairId, book });

      const rejectEvents = result.events.filter(
        (event): event is Extract<typeof result.events[number], { type: 'REJECT' }> =>
          event.type === 'REJECT' && event.orderId === currentNamespacedOrderId,
      );
      const tradeEvents = result.events.filter(
        (event): event is Extract<typeof result.events[number], { type: 'TRADE' }> => event.type === 'TRADE',
      );
      if (rejectEvents.length > 0 && tradeEvents.length === 0) {
        rejectInvalidCrossOffer(currentAccountId, rawOffer.offerId, `cross-post-only-reject:${rejectEvents.map(event => event.reason).join(',')}`);
        continue;
      }
      if (debugRebuildProjectionOnly) {
        if (tradeEvents.length > 0) {
          recordDebugProjectionReject(currentAccountId, rawOffer.offerId, `debug-rebuild-cross-trade:${tradeEvents.length}`);
        }
        continue;
      }

      const fillsPerOrder = new Map<string, { filledLots: number; weightedCost: bigint }>();
      for (const event of tradeEvents) {
        const tradeCost = event.price * BigInt(event.qty);
        for (const orderId of [event.makerOrderId, event.takerOrderId]) {
          const entry = fillsPerOrder.get(orderId);
          if (entry) {
            entry.filledLots += event.qty;
            entry.weightedCost += tradeCost;
          } else {
            fillsPerOrder.set(orderId, { filledLots: event.qty, weightedCost: tradeCost });
          }
        }
      }

      for (const [namespacedOrderId, fill] of fillsPerOrder) {
        const meta = crossLiveOfferMeta.get(namespacedOrderId) ?? buildCrossMarketOfferFromBookOrder(namespacedOrderId);
        if (!meta) {
          throw new Error(`ORDERBOOK_CROSS_J_FILL_META_MISSING: order=${namespacedOrderId}`);
        }
        const lastColon = namespacedOrderId.lastIndexOf(':');
        if (lastColon === -1) continue;
        const accountId = namespacedOrderId.slice(0, lastColon);
        const offerId = namespacedOrderId.slice(lastColon + 1);
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
      const meta = crossLiveOfferMeta.get(namespacedOrderId) ?? buildCrossMarketOfferFromBookOrder(namespacedOrderId);
      if (!meta) {
        throw new Error(`ORDERBOOK_CROSS_J_FILL_META_MISSING: order=${namespacedOrderId}`);
      }
      const lastColon = namespacedOrderId.lastIndexOf(':');
      if (lastColon === -1) continue;
      const accountId = namespacedOrderId.slice(0, lastColon);
      const offerId = namespacedOrderId.slice(lastColon + 1);
      if (hasQueuedCrossSwapAckForEntityState(hubState, accountId, offerId)) continue;
      const ack = buildCrossJurisdictionFillAck(accountId, offerId, namespacedOrderId, meta, fill);
      if (!ack) continue;
      crossJurisdictionFills.push(ack.instruction);
      mempoolOps.push({ accountId, tx: ack.tx });
    }
  };

  processCrossJurisdictionOffers();

  for (const rawOffer of sortSwapOffersForOrderbook(sameAccountSwapOffers)) {
    let offer = rawOffer;
    const currentAccountId = offer.accountId;
    if (hasQueuedSwapResolveForEntityState(hubState, queuedSwapResolutions, currentAccountId, offer.offerId)) {
      continue;
    }
    orderbookLog.debug('offer.process', { offer: shortOrder(offer.offerId), account: shortId(currentAccountId, 8) });

    const { pairId, base, quote } = canonicalPair(offer.giveTokenId, offer.wantTokenId);
    const bookKey = pairId;

    const side = deriveSide(offer.giveTokenId, offer.wantTokenId);
    // SWAP_LOT_SCALE = 10^12: Orderbook works in lots for uint32 efficiency.
    // For 18-decimal tokens: 1 lot = 0.000001 tokens.
    // This is acceptable: sub-$0.001 orders at typical ETH prices are uneconomical anyway
    const MAX_LOTS = 0xFFFFFFFFn;

    let priceTicks: bigint;
    let qtyLots: bigint;

    const isSellBase = offer.giveTokenId === base && offer.wantTokenId === quote;
    const isBuyBase = offer.giveTokenId === quote && offer.wantTokenId === base;
    const pairPolicy = getSwapPairPolicyByBaseQuote(base, quote);
    const hasExplicitPairPolicy = hasSwapPairPolicyByBaseQuote(base, quote);
    const bucketWidthTicks = Math.max(1, pairPolicy.bookBucketWidthTicks);
    if (!isSellBase && !isBuyBase) {
      console.warn(
        `⚠️ ORDERBOOK: Invalid token direction for offer=${offer.offerId} give=${offer.giveTokenId} want=${offer.wantTokenId} base=${base} quote=${quote}`,
      );
      rejectInvalidOffer(currentAccountId, offer.offerId, 'invalid-direction');
      continue;
    }

    const baseAmount = isSellBase ? offer.giveAmount : offer.wantAmount;
    const quoteAmount = isSellBase ? offer.wantAmount : offer.giveAmount;
    if (baseAmount <= 0n || quoteAmount <= 0n) {
      console.warn(`⚠️ ORDERBOOK: Zero amount in offer=${offer.offerId}, base=${baseAmount}, quote=${quoteAmount}`);
      rejectInvalidOffer(currentAccountId, offer.offerId, 'zero-amount');
      continue;
    }
    if (minTradeSize > 0n && quoteAmount < minTradeSize) {
      console.warn(
        `⚠️ ORDERBOOK: Offer below minTradeSize=${minTradeSize.toString()} quote=${quoteAmount.toString()} offer=${offer.offerId}` +
        (debugRebuildProjectionOnly ? '; rejected from debug projection rebuild' : '; cancelling remainder'),
      );
      if (debugRebuildProjectionOnly) {
        recordDebugProjectionReject(currentAccountId, offer.offerId, `below-minTradeSize:${quoteAmount.toString()}`);
        continue;
      }
      queueUniqueSwapResolveForEntityState(mempoolOps, hubState, queuedSwapResolutions, currentAccountId, {
        offerId: offer.offerId,
        fillRatio: 0,
        cancelRemainder: true,
      });
      continue;
    }
    if (baseAmount % SWAP_LOT_SCALE !== 0n) {
      console.warn(
        `⚠️ ORDERBOOK: base amount not aligned to SWAP_LOT_SCALE — skipping offer=${offer.offerId}, amount=${baseAmount}`,
      );
      rejectInvalidOffer(currentAccountId, offer.offerId, `lot-misaligned:${baseAmount.toString()}`);
      continue;
    }

    priceTicks = offer.priceTicks;

    qtyLots = baseAmount / SWAP_LOT_SCALE;

    if (qtyLots === 0n || qtyLots > MAX_LOTS || priceTicks <= 0n) {
      console.warn(`⚠️ ORDERBOOK: Invalid order — skipping offer=${offer.offerId}, qty=${qtyLots}, price=${priceTicks}`);
      rejectInvalidOffer(currentAccountId, offer.offerId, `invalid-order:${qtyLots.toString()}:${priceTicks.toString()}`);
      continue;
    }

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
    const REJECT_BPS = SWAP_CONSTANTS.PRICE_REJECT_BPS;
    const WARN_BPS = SWAP_CONSTANTS.PRICE_WARN_BPS;
    const BPS_BASE = SWAP_CONSTANTS.BPS_BASE;
    const { anchor: marketAnchor, label: marketAnchorLabel } = resolvePairBandReference(pairPolicy, hasExplicitPairPolicy, bestBid, bestAsk);
    if (marketAnchor !== null) {
      const minAllowed = marketAnchor - ((marketAnchor * BigInt(REJECT_BPS)) / BigInt(BPS_BASE));
      const maxAllowed = marketAnchor + ((marketAnchor * BigInt(REJECT_BPS)) / BigInt(BPS_BASE));
      if (priceTicks < minAllowed || priceTicks > maxAllowed) {
        console.warn(
          `⚠️ ORDERBOOK: price ${priceTicks.toString()} is outside ±${REJECT_BPS / 100}% band ` +
          `around ${marketAnchorLabel} ${marketAnchor.toString()} (bestBid=${String(bestBid)} bestAsk=${String(bestAsk)}) ` +
          `— auto-canceling offer=${offer.offerId}`,
        );
        if (debugRebuildProjectionOnly) {
          recordDebugProjectionReject(currentAccountId, offer.offerId, `outside-anchor-band:${priceTicks.toString()}`);
          continue;
        }
        queueUniqueSwapResolveForEntityState(mempoolOps, hubState, queuedSwapResolutions, currentAccountId, {
          offerId: offer.offerId,
          fillRatio: 0,
          cancelRemainder: true,
        });
        continue;
      }
    }
    if (side === 0 && bestAsk !== null) {
      const warnAbove = bestAsk + ((bestAsk * BigInt(WARN_BPS)) / BigInt(BPS_BASE));
      if (priceTicks > warnAbove) {
        console.warn(
          `⚠️ ORDERBOOK: BUY price ${priceTicks.toString()} is ${WARN_BPS / 100}%+ above best ask ${bestAsk.toString()} — allowing match/rest`,
        );
      }
    }
    if (side === 1 && bestBid !== null) {
      const warnBelow = bestBid - ((bestBid * BigInt(WARN_BPS)) / BigInt(BPS_BASE));
      if (priceTicks < warnBelow) {
        console.warn(
          `⚠️ ORDERBOOK: SELL price ${priceTicks.toString()} is ${WARN_BPS / 100}%+ below best bid ${bestBid.toString()} — allowing match/rest`,
        );
      }
    }

    const makerId = offer.makerIsLeft ? offer.fromEntity : offer.toEntity;
    const currentNamespacedOrderId = `${currentAccountId}:${offer.offerId}`;
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
          `📊 ORDERBOOK-SKIP: already materialized offer=${offer.offerId} account=${currentAccountId.slice(-8)} ` +
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
        if (queueUniqueSwapResolveForEntityState(mempoolOps, hubState, queuedSwapResolutions, currentAccountId, {
          offerId: offer.offerId,
          fillRatio: 0,
          cancelRemainder: true,
        })) {
          orderbookLog.debug('resolve.queued_cancel_full_book', { offer: shortOrder(offer.offerId, 8), account: shortId(currentAccountId, 8) });
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
      const rejectEvents = result.events.filter(
        (event): event is Extract<typeof result.events[number], { type: 'REJECT' }> =>
          event.type === 'REJECT' && event.orderId === currentNamespacedOrderId,
      );
      const tradeEvents = result.events.filter(
        (event): event is Extract<typeof result.events[number], { type: 'TRADE' }> => event.type === 'TRADE',
      );
      const stpRejectEvent = rejectEvents.find((event) => event.reason === 'STP cancel taker');
      const resolveComment = stpRejectEvent
        ? `STP:${String(stpRejectEvent.blockingOrderId || '')}`
        : undefined;
      const offerRejectedWithoutFill = rejectEvents.length > 0 && tradeEvents.length === 0;
      if (offerRejectedWithoutFill) {
        const rejectReasons = rejectEvents.map((event) => event.reason).filter(Boolean).join(', ');
        console.warn(
          `⚠️ ORDERBOOK REJECT: offer=${offer.offerId} account=${currentAccountId.slice(-8)} side=${side} price=${priceTicks.toString()} qty=${qtyLots.toString()} bestBid=${String(bestBid)} bestAsk=${String(bestAsk)} reason=${rejectReasons || 'unknown'}`,
        );
        if (debugRebuildProjectionOnly) {
          recordDebugProjectionReject(currentAccountId, offer.offerId, `post-only-reject:${rejectReasons || 'unknown'}`);
          continue;
        }
        if (queueUniqueSwapResolveForEntityState(mempoolOps, hubState, queuedSwapResolutions, currentAccountId, {
          offerId: offer.offerId,
          fillRatio: 0,
          cancelRemainder: true,
          ...(resolveComment ? { comment: resolveComment } : {}),
        })) {
          orderbookLog.debug('resolve.queued_cancel_reject', { offer: shortOrder(offer.offerId, 8), account: shortId(currentAccountId, 8) });
        }
        continue;
      }

      if (debugRebuildProjectionOnly) {
        continue;
      }

      // Process trade events
      const fillsPerOrder = new Map<string, {
        filledLots: number;
        originalLots: number;
        weightedCost: bigint;
      }>();

      for (const event of tradeEvents) {
        const extractOfferId = (namespacedId: string) => {
          const lastColon = namespacedId.lastIndexOf(':');
          return lastColon >= 0 ? namespacedId.slice(lastColon + 1) : namespacedId;
        };
        const tradeCost = event.price * BigInt(event.qty);

        const makerEntry = fillsPerOrder.get(event.makerOrderId);
        if (!makerEntry) {
          fillsPerOrder.set(event.makerOrderId, {
            filledLots: event.qty,
            originalLots: event.makerQtyBefore,
            weightedCost: tradeCost,
          });
        } else {
          makerEntry.filledLots += event.qty;
          makerEntry.weightedCost += tradeCost;
        }

        const takerEntry = fillsPerOrder.get(event.takerOrderId);
        if (!takerEntry) {
          fillsPerOrder.set(event.takerOrderId, {
            filledLots: event.qty,
            originalLots: event.takerQtyTotal,
            weightedCost: tradeCost,
          });
        } else {
          takerEntry.filledLots += event.qty;
          takerEntry.weightedCost += tradeCost;
        }

        orderbookLog.debug('trade', {
          maker: shortOrder(extractOfferId(event.makerOrderId)),
          taker: shortOrder(extractOfferId(event.takerOrderId)),
          price: event.price.toString(),
          qty: event.qty,
        });
      }

      // Emit swap_resolve for each filled order
      for (const [namespacedOrderId, { filledLots, originalLots, weightedCost }] of fillsPerOrder) {
      // Parse namespacedOrderId format: "counterpartyId:offerId"
      // counterpartyId is the Map key used to store the account
      const lastColon = namespacedOrderId.lastIndexOf(':');
      if (lastColon === -1) {
        throw new Error(`ORDERBOOK_FILL_LOOKUP_FAILED: malformed namespacedOrderId=${namespacedOrderId}`);
      }
      const offerId = namespacedOrderId.slice(lastColon + 1);
      const accountId = namespacedOrderId.slice(0, lastColon);
      if (hasQueuedSwapResolveForEntityState(hubState, queuedSwapResolutions, accountId, offerId)) {
        continue;
      }

      // Verify account exists in hub's state
      if (HEAVY_LOGS) {
        orderbookLog.trace('lookup', {
          account: shortId(accountId, 8),
          known: Array.from(hubState.accounts.keys()).map((id) => shortId(id, 8)),
          found: hubState.accounts.has(accountId),
        });
      }
      if (!hubState.accounts.has(accountId)) {
        throw new Error(
          `ORDERBOOK_ACCOUNT_LOOKUP_FAILED: offer=${offerId} accountId=${accountId} ` +
          `known=[${Array.from(hubState.accounts.keys()).join(',')}]`,
        );
      }
      orderbookLog.debug('lookup.found', { account: shortId(accountId, 8), offer: shortOrder(offerId, 8) });

      const filledBig = BigInt(filledLots);
      const isCurrentTakerOrder = namespacedOrderId === currentNamespacedOrderId;
      if (filledBig <= 0n || weightedCost <= 0n) {
        throw new Error(
          `ORDERBOOK_FILL_LOOKUP_FAILED: invalid fill aggregate weightedCost=${weightedCost.toString()} filledLots=${filledBig.toString()}`,
        );
      }
      if (!isCurrentTakerOrder && weightedCost % filledBig !== 0n) {
        throw new Error(
          `ORDERBOOK_FILL_LOOKUP_FAILED: non-integral resting price weightedCost=${weightedCost.toString()} filledLots=${filledBig.toString()}`,
        );
      }
      const executionBaseWei = filledBig * SWAP_LOT_SCALE;
      const executionQuoteWei = (weightedCost * SWAP_LOT_SCALE) / ORDERBOOK_PRICE_SCALE;

      const account = hubState.accounts.get(accountId);
      const swapOffer = account?.swapOffers?.get(offerId);
      const restingPriceTicks = weightedCost / filledBig;
      const offerForExecution = isCurrentTakerOrder
        ? {
            giveTokenId: offer.giveTokenId,
            wantTokenId: offer.wantTokenId,
            giveAmount: offer.giveAmount,
            wantAmount: offer.wantAmount,
            quantizedGive: offer.giveAmount,
            quantizedWant: offer.wantAmount,
            priceTicks: offer.priceTicks,
          }
        : swapOffer
          ? materializeCanonicalRestingOffer(
              swapOffer.giveTokenId,
              swapOffer.wantTokenId,
              restingPriceTicks,
              originalLots,
            )
          : synthesizeOfferFromMissingBookLookup(side, base, quote, originalLots, filledLots, weightedCost);
      const orderStillInBook = getBookOrder(book, namespacedOrderId) !== null;
      const offerSource = isCurrentTakerOrder
        ? 'current-taker-offer'
        : swapOffer
          ? 'canonical-book-state'
          : 'synthesized-from-book-fill';
      const resolveData = buildSwapResolveDataFromOrderbookFill(
        offerForExecution,
        executionBaseWei,
        executionQuoteWei,
        !orderStillInBook,
      );

      const resolveEnqueueData: SwapResolveEnqueueData = {
        offerId,
        restingGiveTokenId: offerForExecution.giveTokenId,
        restingWantTokenId: offerForExecution.wantTokenId,
        ...resolveData,
        ...(offerForExecution.priceTicks !== undefined ? { restingPriceTicks: offerForExecution.priceTicks } : {}),
        restingGiveAmount: offerForExecution.giveAmount,
        restingWantAmount: offerForExecution.wantAmount,
        ...(offerForExecution.quantizedGive !== undefined ? { restingQuantizedGive: offerForExecution.quantizedGive } : {}),
        ...(offerForExecution.quantizedWant !== undefined ? { restingQuantizedWant: offerForExecution.quantizedWant } : {}),
        ...(isCurrentTakerOrder && resolveComment ? { comment: resolveComment } : {}),
      };
      if (isCurrentTakerOrder) {
        const takerFeeAmount = calculateSwapTakerFeeAmount(resolveData.executionWantAmount ?? 0n, swapTakerFeeBps);
        if (takerFeeAmount > 0n) {
          resolveEnqueueData.feeTokenId = offerForExecution.wantTokenId;
          resolveEnqueueData.feeAmount = takerFeeAmount;
        }
      }
      if (queueUniqueSwapResolveForEntityState(mempoolOps, hubState, queuedSwapResolutions, accountId, resolveEnqueueData)) {
        orderbookLog.debug('resolve.queued', {
          offer: shortOrder(offerId, 8),
          fillPct: (resolveData.fillRatio / MAX_SWAP_FILL_RATIO * 100).toFixed(1),
          cancel: !orderStillInBook,
          source: offerSource,
        });
      }
      if (shouldLogFullPayloads()) {
        orderbookLog.trace('resolve.payload', {
          accountId,
          offerId,
          namespacedOrderId,
          offerSource,
          side,
          baseTokenId: base,
          quoteTokenId: quote,
          originalLots,
          filledLots,
          weightedCost: weightedCost.toString(),
          executionBaseWei: executionBaseWei.toString(),
          executionQuoteWei: executionQuoteWei.toString(),
          orderStillInBook,
          offerGiveTokenId: offerForExecution.giveTokenId,
          offerWantTokenId: offerForExecution.wantTokenId,
          offerGiveAmount: offerForExecution.giveAmount.toString(),
          offerQuantizedGive: (offerForExecution.quantizedGive ?? offerForExecution.giveAmount).toString(),
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
    orderbookLog.debug('pass.summary', { pairSweep: pairSweepCount });
  }

  return { mempoolOps, crossJurisdictionFills, bookUpdates, debugProjectionRejects };
}
