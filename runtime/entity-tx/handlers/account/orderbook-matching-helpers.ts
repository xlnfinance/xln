import { LIMITS, SWAP as SWAP_CONSTANTS } from '../../../constants';
import {
  canonicalPair,
  createBook,
  deriveSide,
  getBookOrder,
  ORDERBOOK_PRICE_SCALE,
  SWAP_LOT_SCALE,
  type BookEvent,
  type BookState,
} from '../../../orderbook';
import {
  getSwapPairPolicyByBaseQuote,
  hasSwapPairPolicyByBaseQuote,
  type SwapPairPolicy,
} from '../../../account-utils';
import {
  buildSwapResolveDataFromOrderbookFill,
  calculateSwapTakerFeeAmount,
  isWorkingOrderbookOffer,
  MAX_SWAP_FILL_RATIO,
  type CrossJurisdictionWorkingOrderbookOffer,
  type ExactFillRatio,
  type NormalizedOrderbookOffer,
  type SameJurisdictionWorkingOrderbookOffer,
  type WorkingOrderbookOffer,
} from '../../../swap-execution';
import {
  buildCrossJurisdictionMarketOffer,
  type CrossMarketOffer,
} from '../../../cross-jurisdiction-orderbook';
import type { EntityState } from '../../../types';
import { normalizeSwapOfferForOrderbook, resolveStoredOfferEntityRefs } from './orderbook-offers';
import type { SwapResolveEnqueueData } from './orderbook-queue';

export type OrderbookProcessOptions = {
  debugRebuildProjectionOnly?: boolean;
};

type NamespacedOrderRef = {
  accountId: string;
  offerId: string;
};

type CanonicalRestingOffer = {
  giveTokenId: number;
  wantTokenId: number;
  giveAmount: bigint;
  wantAmount: bigint;
  quantizedGive: bigint;
  quantizedWant: bigint;
  priceTicks: bigint;
};

type SameTradeFillAggregate = {
  filledLots: number;
  originalLots: number;
  weightedCost: bigint;
};

type CrossTradeFillAggregate = {
  filledLots: number;
  weightedCost: bigint;
};

type RestingOrderTerms = {
  giveTokenId: number;
  wantTokenId: number;
};

type SameFillResolvePlan = {
  accountId: string;
  offerId: string;
  fillPct: string;
  cancelRemainder: boolean;
  offerSource: 'current-taker-offer' | 'committed-batch-state' | 'canonical-book-state';
  resolveEnqueueData: SwapResolveEnqueueData;
  trace: {
    executionBaseWei: bigint;
    executionQuoteWei: bigint;
    offerGiveTokenId: number;
    offerWantTokenId: number;
    offerGiveAmount: bigint;
    offerQuantizedGive: bigint;
    fillRatio: number;
    exactFillRatio: ExactFillRatio;
  };
};

export const MAX_ORDERBOOK_QTY_LOTS = 0xffffffffn;

type SameOrderbookMaterialization = {
  pairId: string;
  base: number;
  quote: number;
  side: 0 | 1;
  baseAmount: bigint;
  quoteAmount: bigint;
  priceTicks: bigint;
  qtyLots: bigint;
  makerId: string;
  namespacedOrderId: string;
  pairPolicy: SwapPairPolicy;
  hasExplicitPairPolicy: boolean;
  bucketWidthTicks: number;
};

type SameOrderbookMaterializationResult =
  | { kind: 'ok'; order: SameOrderbookMaterialization }
  | { kind: 'reject'; reason: string; message: string };

type SameOrderbookPriceBandDecision = {
  rejectReason?: string;
  rejectMessage?: string;
  warnMessage?: string;
};

export const splitWorkingOrderbookOffers = (
  offers: readonly WorkingOrderbookOffer[],
): {
  sameAccountSwapOffers: SameJurisdictionWorkingOrderbookOffer[];
  crossJurisdictionSwapOffers: CrossJurisdictionWorkingOrderbookOffer[];
} => {
  const sameAccountSwapOffers: SameJurisdictionWorkingOrderbookOffer[] = [];
  const crossJurisdictionSwapOffers: CrossJurisdictionWorkingOrderbookOffer[] = [];

  for (const offer of offers) {
    if (!isWorkingOrderbookOffer(offer)) {
      const rawOffer = offer as unknown as { offerId?: unknown };
      throw new Error(`ORDERBOOK_UNADMITTED_OFFER: offer=${String(rawOffer.offerId ?? '')}`);
    }
    if (offer.orderbookKind === 'same-jurisdiction') {
      sameAccountSwapOffers.push(offer);
      continue;
    }
    if (offer.orderbookKind === 'cross-jurisdiction') {
      crossJurisdictionSwapOffers.push(offer);
      continue;
    }
    const rawOffer = offer as unknown as { offerId?: unknown };
    throw new Error(`ORDERBOOK_UNADMITTED_OFFER: offer=${String(rawOffer.offerId ?? '')}`);
  }

  return { sameAccountSwapOffers, crossJurisdictionSwapOffers };
};

export const parseNamespacedOrderId = (namespacedOrderId: string, errorCode: string): NamespacedOrderRef => {
  const lastColon = namespacedOrderId.lastIndexOf(':');
  if (lastColon <= 0 || lastColon === namespacedOrderId.length - 1) {
    throw new Error(`${errorCode}: order=${namespacedOrderId}`);
  }
  return {
    accountId: namespacedOrderId.slice(0, lastColon),
    offerId: namespacedOrderId.slice(lastColon + 1),
  };
};

export const createEmptyPairBook = (bucketWidthTicks: number): BookState =>
  createBook({
    bucketWidthTicks: BigInt(Math.max(1, bucketWidthTicks)),
    maxOrders: LIMITS.MAX_ORDERBOOK_ORDERS_PER_PAIR,
    stpPolicy: 1,
  });

export const deriveSameOrderbookMaterialization = (
  offer: SameJurisdictionWorkingOrderbookOffer,
  minTradeSize: bigint,
): SameOrderbookMaterializationResult => {
  const { pairId, base, quote } = canonicalPair(offer.giveTokenId, offer.wantTokenId);
  const side = deriveSide(offer.giveTokenId, offer.wantTokenId);
  const isSellBase = offer.giveTokenId === base && offer.wantTokenId === quote;
  const isBuyBase = offer.giveTokenId === quote && offer.wantTokenId === base;
  const pairPolicy = getSwapPairPolicyByBaseQuote(base, quote);
  const hasExplicitPairPolicy = hasSwapPairPolicyByBaseQuote(base, quote);
  const bucketWidthTicks = Math.max(1, pairPolicy.bookBucketWidthTicks);

  if (!isSellBase && !isBuyBase) {
    return {
      kind: 'reject',
      reason: 'invalid-direction',
      message:
        `ORDERBOOK_REJECT: invalid token direction offer=${offer.offerId} give=${offer.giveTokenId} ` +
        `want=${offer.wantTokenId} base=${base} quote=${quote}`,
    };
  }

  const baseAmount = isSellBase ? offer.giveAmount : offer.wantAmount;
  const quoteAmount = isSellBase ? offer.wantAmount : offer.giveAmount;
  if (baseAmount <= 0n || quoteAmount <= 0n) {
    return {
      kind: 'reject',
      reason: 'zero-amount',
      message: `ORDERBOOK_REJECT: zero amount offer=${offer.offerId} base=${baseAmount} quote=${quoteAmount}`,
    };
  }

  if (minTradeSize > 0n && quoteAmount < minTradeSize) {
    return {
      kind: 'reject',
      reason: `below-minTradeSize:${quoteAmount.toString()}`,
      message:
        `ORDERBOOK_REJECT: below minTradeSize=${minTradeSize.toString()} ` +
        `quote=${quoteAmount.toString()} offer=${offer.offerId}`,
    };
  }

  if (baseAmount % SWAP_LOT_SCALE !== 0n) {
    return {
      kind: 'reject',
      reason: `lot-misaligned:${baseAmount.toString()}`,
      message: `ORDERBOOK_REJECT: base amount not aligned to lot scale offer=${offer.offerId} amount=${baseAmount}`,
    };
  }

  const priceTicks = offer.priceTicks;
  const qtyLots = baseAmount / SWAP_LOT_SCALE;
  if (qtyLots === 0n || qtyLots > MAX_ORDERBOOK_QTY_LOTS || priceTicks <= 0n) {
    return {
      kind: 'reject',
      reason: `invalid-order:${qtyLots.toString()}:${priceTicks.toString()}`,
      message: `ORDERBOOK_REJECT: invalid order offer=${offer.offerId} qty=${qtyLots} price=${priceTicks}`,
    };
  }

  return {
    kind: 'ok',
    order: {
      pairId,
      base,
      quote,
      side,
      baseAmount,
      quoteAmount,
      priceTicks,
      qtyLots,
      makerId: offer.makerIsLeft ? offer.fromEntity : offer.toEntity,
      namespacedOrderId: `${offer.accountId}:${offer.offerId}`,
      pairPolicy,
      hasExplicitPairPolicy,
      bucketWidthTicks,
    },
  };
};

export const evaluateSameOrderbookPriceBand = (input: {
  priceTicks: bigint;
  side: 0 | 1;
  bestBid: bigint | null;
  bestAsk: bigint | null;
  pairPolicy: SwapPairPolicy;
  hasExplicitPairPolicy: boolean;
}): SameOrderbookPriceBandDecision => {
  const rejectBps = SWAP_CONSTANTS.PRICE_REJECT_BPS;
  const warnBps = SWAP_CONSTANTS.PRICE_WARN_BPS;
  const bpsBase = SWAP_CONSTANTS.BPS_BASE;
  const { anchor, label } = resolvePairBandReference(
    input.pairPolicy,
    input.hasExplicitPairPolicy,
    input.bestBid,
    input.bestAsk,
  );

  if (anchor !== null) {
    const minAllowed = anchor - (anchor * BigInt(rejectBps)) / BigInt(bpsBase);
    const maxAllowed = anchor + (anchor * BigInt(rejectBps)) / BigInt(bpsBase);
    if (input.priceTicks < minAllowed || input.priceTicks > maxAllowed) {
      return {
        rejectReason: `outside-anchor-band:${input.priceTicks.toString()}`,
        rejectMessage:
          `ORDERBOOK_REJECT: price ${input.priceTicks.toString()} is outside +/-${rejectBps / 100}% band ` +
          `around ${label} ${anchor.toString()} (bestBid=${String(input.bestBid)} bestAsk=${String(input.bestAsk)})`,
      };
    }
  }

  if (input.side === 0 && input.bestAsk !== null) {
    const warnAbove = input.bestAsk + (input.bestAsk * BigInt(warnBps)) / BigInt(bpsBase);
    if (input.priceTicks > warnAbove) {
      return {
        warnMessage:
          `ORDERBOOK_WARN: BUY price ${input.priceTicks.toString()} is ${warnBps / 100}%+ ` +
          `above best ask ${input.bestAsk.toString()} - allowing match/rest`,
      };
    }
  }

  if (input.side === 1 && input.bestBid !== null) {
    const warnBelow = input.bestBid - (input.bestBid * BigInt(warnBps)) / BigInt(bpsBase);
    if (input.priceTicks < warnBelow) {
      return {
        warnMessage:
          `ORDERBOOK_WARN: SELL price ${input.priceTicks.toString()} is ${warnBps / 100}%+ ` +
          `below best bid ${input.bestBid.toString()} - allowing match/rest`,
      };
    }
  }

  return {};
};

export const buildCrossMarketOfferFromBookOrder = (
  state: Pick<EntityState, 'entityId' | 'accounts'>,
  namespacedOrderId: string,
): CrossMarketOffer | null => {
  const { accountId, offerId } = parseNamespacedOrderId(
    namespacedOrderId,
    'ORDERBOOK_CROSS_J_MALFORMED_BOOK_ORDER',
  );
  const account = state.accounts.get(accountId);
  const offer = account?.swapOffers?.get(offerId);
  if (!account || !offer?.crossJurisdiction) return null;
  const entityRefs = resolveStoredOfferEntityRefs(account, offer);
  return buildCrossJurisdictionMarketOffer(
    normalizeSwapOfferForOrderbook(
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
    ),
    state.entityId,
  );
};

const materializeCanonicalRestingOffer = (
  giveTokenId: number,
  wantTokenId: number,
  priceTicks: bigint,
  qtyLots: number,
): CanonicalRestingOffer => {
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

export const resolvePairBandReference = (
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

export const rejectEventsForOrder = (
  events: readonly BookEvent[],
  orderId: string,
): Extract<BookEvent, { type: 'REJECT' }>[] =>
  events.filter(
    (event): event is Extract<BookEvent, { type: 'REJECT' }> => event.type === 'REJECT' && event.orderId === orderId,
  );

export const tradeEvents = (events: readonly BookEvent[]): Extract<BookEvent, { type: 'TRADE' }>[] =>
  events.filter((event): event is Extract<BookEvent, { type: 'TRADE' }> => event.type === 'TRADE');

export const aggregateCrossTradeFills = (
  events: readonly Extract<BookEvent, { type: 'TRADE' }>[],
): Map<string, CrossTradeFillAggregate> => {
  const fillsPerOrder = new Map<string, CrossTradeFillAggregate>();
  for (const event of events) {
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
  return fillsPerOrder;
};

export const aggregateSameTradeFills = (
  events: readonly Extract<BookEvent, { type: 'TRADE' }>[],
): Map<string, SameTradeFillAggregate> => {
  const fillsPerOrder = new Map<string, SameTradeFillAggregate>();
  for (const event of events) {
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
  }
  return fillsPerOrder;
};

export const extractOfferIdForLog = (namespacedId: string): string => {
  const lastColon = namespacedId.lastIndexOf(':');
  return lastColon >= 0 ? namespacedId.slice(lastColon + 1) : namespacedId;
};

export const buildSameFillResolvePlan = (input: {
  accountId: string;
  offerId: string;
  namespacedOrderId: string;
  fill: SameTradeFillAggregate;
  currentNamespacedOrderId: string;
  currentOffer: NormalizedOrderbookOffer;
  batchOffer: RestingOrderTerms | null;
  accountOffer: RestingOrderTerms | null;
  book: BookState;
  bookKey: string;
  resolveComment?: string;
  takerFeeBps: number;
}): SameFillResolvePlan => {
  const { filledLots, originalLots, weightedCost } = input.fill;
  const filledBig = BigInt(filledLots);
  const isCurrentTakerOrder = input.namespacedOrderId === input.currentNamespacedOrderId;
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
  const restingPriceTicks = weightedCost / filledBig;
  if (!isCurrentTakerOrder && !input.batchOffer && !input.accountOffer) {
    throw new Error(
      `ORDERBOOK_FILL_SOURCE_MISSING: order=${input.namespacedOrderId} pair=${input.bookKey} ` +
        `account=${input.accountId} offer=${input.offerId}`,
    );
  }

  const offerForExecution = isCurrentTakerOrder
    ? {
        giveTokenId: input.currentOffer.giveTokenId,
        wantTokenId: input.currentOffer.wantTokenId,
        giveAmount: input.currentOffer.giveAmount,
        wantAmount: input.currentOffer.wantAmount,
        quantizedGive: input.currentOffer.giveAmount,
        quantizedWant: input.currentOffer.wantAmount,
        priceTicks: input.currentOffer.priceTicks,
      }
    : input.batchOffer
      ? materializeCanonicalRestingOffer(
          input.batchOffer.giveTokenId,
          input.batchOffer.wantTokenId,
          restingPriceTicks,
          originalLots,
        )
      : materializeCanonicalRestingOffer(
          input.accountOffer!.giveTokenId,
          input.accountOffer!.wantTokenId,
          restingPriceTicks,
          originalLots,
        );
  const orderStillInBook = getBookOrder(input.book, input.namespacedOrderId) !== null;
  const offerSource = isCurrentTakerOrder
    ? 'current-taker-offer'
    : input.batchOffer
      ? 'committed-batch-state'
      : 'canonical-book-state';
  const resolveData = buildSwapResolveDataFromOrderbookFill(
    offerForExecution,
    executionBaseWei,
    executionQuoteWei,
    !orderStillInBook,
  );

  const resolveEnqueueData: SwapResolveEnqueueData = {
    offerId: input.offerId,
    restingGiveTokenId: offerForExecution.giveTokenId,
    restingWantTokenId: offerForExecution.wantTokenId,
    ...resolveData,
    ...(offerForExecution.priceTicks !== undefined ? { restingPriceTicks: offerForExecution.priceTicks } : {}),
    restingGiveAmount: offerForExecution.giveAmount,
    restingWantAmount: offerForExecution.wantAmount,
    ...(offerForExecution.quantizedGive !== undefined ? { restingQuantizedGive: offerForExecution.quantizedGive } : {}),
    ...(offerForExecution.quantizedWant !== undefined ? { restingQuantizedWant: offerForExecution.quantizedWant } : {}),
    ...(isCurrentTakerOrder && input.resolveComment ? { comment: input.resolveComment } : {}),
  };
  if (isCurrentTakerOrder) {
    const takerFeeAmount = calculateSwapTakerFeeAmount(resolveData.executionWantAmount ?? 0n, input.takerFeeBps);
    if (takerFeeAmount > 0n) {
      resolveEnqueueData.feeTokenId = offerForExecution.wantTokenId;
      resolveEnqueueData.feeAmount = takerFeeAmount;
    }
  }

  return {
    accountId: input.accountId,
    offerId: input.offerId,
    fillPct: ((resolveData.fillRatio / MAX_SWAP_FILL_RATIO) * 100).toFixed(1),
    cancelRemainder: !orderStillInBook,
    offerSource,
    resolveEnqueueData,
    trace: {
      executionBaseWei,
      executionQuoteWei,
      offerGiveTokenId: offerForExecution.giveTokenId,
      offerWantTokenId: offerForExecution.wantTokenId,
      offerGiveAmount: offerForExecution.giveAmount,
      offerQuantizedGive: offerForExecution.quantizedGive ?? offerForExecution.giveAmount,
      fillRatio: resolveData.fillRatio,
      exactFillRatio: {
        numerator: resolveData.fillNumerator,
        denominator: resolveData.fillDenominator,
      },
    },
  };
};
