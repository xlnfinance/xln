import {
  CROSS_J_MAX_FILL_RATIO,
  cloneCrossJurisdictionRoute,
  compareCrossJurisdictionRouteStatus,
  deriveCanonicalCrossJurisdictionMarket,
  getCrossJurisdictionCommittedFillAmounts,
  isCrossJurisdictionPullExpired,
  isCrossJurisdictionRouteExpired,
  withCanonicalCrossJurisdictionRouteHash,
} from './index';
import {
  baseAmountFromLots,
  computePriceTicksForBaseQuote,
  quoteAmountFromWeightedLots,
} from '../../orderbook';
import {
  deriveExactSwapFillRatio,
  exactFillRatioToUint16,
  type NormalizedOrderbookOffer,
} from '../../orderbook/swap-execution';
import type {
  AccountTx,
  CrossJurisdictionBookAdmission,
  CrossJurisdictionSwapRoute,
  EntityState,
} from '../../types';

const mergeAdmissionRoute = (
  existing: CrossJurisdictionSwapRoute | undefined,
  next: CrossJurisdictionSwapRoute,
): CrossJurisdictionSwapRoute => {
  const canonicalNext = cloneCrossJurisdictionRoute(next);
  if (!existing) return canonicalNext;

  const canonicalExisting = cloneCrossJurisdictionRoute(existing);
  const merged: CrossJurisdictionSwapRoute = {
    ...canonicalExisting,
    ...canonicalNext,
  };
  if (compareCrossJurisdictionRouteStatus(canonicalExisting.status, canonicalNext.status) < 0) {
    merged.status = canonicalExisting.status;
  }
  if (canonicalExisting.sourcePull && !merged.sourcePull) merged.sourcePull = canonicalExisting.sourcePull;
  if (canonicalExisting.targetPull && !merged.targetPull) merged.targetPull = canonicalExisting.targetPull;
  if (canonicalExisting.routeHash && !merged.routeHash) merged.routeHash = canonicalExisting.routeHash;
  return merged;
};

const normalizeEntityRef = (value: string): string => String(value || '').toLowerCase();

export const crossJurisdictionBookAdmissionKeyFor = (sourceEntityId: string, orderId: string): string =>
  `${normalizeEntityRef(sourceEntityId)}:${String(orderId || '')}`;

export const crossJurisdictionBookAdmissionKey = (route: CrossJurisdictionSwapRoute): string =>
  crossJurisdictionBookAdmissionKeyFor(route.source.entityId, route.orderId);

export const crossJurisdictionBookOwnerRef = (route: CrossJurisdictionSwapRoute): string =>
  normalizeEntityRef(route.bookOwnerEntityId || route.source.counterpartyEntityId || route.hubEntityId || '');

export const mergeCrossJurisdictionBookAdmission = (
  currentEntityState: EntityState,
  route: CrossJurisdictionSwapRoute,
  now: number,
): CrossJurisdictionBookAdmission => {
  const canonicalRoute = withCanonicalCrossJurisdictionRouteHash(route);
  const key = crossJurisdictionBookAdmissionKey(canonicalRoute);
  currentEntityState.crossJurisdictionBookAdmissions ||= new Map();
  const existing = currentEntityState.crossJurisdictionBookAdmissions.get(key);
  const mergedRoute = mergeAdmissionRoute(existing?.route, canonicalRoute);
  const current: CrossJurisdictionBookAdmission = existing
    ? {
        ...existing,
        route: mergedRoute,
        updatedAt: now,
      }
    : {
        orderId: canonicalRoute.orderId,
        routeHash: canonicalRoute.routeHash || '',
        sourceEntityId: normalizeEntityRef(canonicalRoute.source.entityId),
        bookOwnerEntityId: crossJurisdictionBookOwnerRef(canonicalRoute),
        status: 'pending',
        route: mergedRoute,
        updatedAt: now,
      };
  currentEntityState.crossJurisdictionBookAdmissions.set(key, current);
  return current;
};

export const markCrossJurisdictionBookAdmissionResolving = (
  currentEntityState: EntityState,
  route: CrossJurisdictionSwapRoute,
  now: number,
): void => {
  const canonicalRoute = withCanonicalCrossJurisdictionRouteHash(route);
  const key = crossJurisdictionBookAdmissionKey(canonicalRoute);
  const admission = currentEntityState.crossJurisdictionBookAdmissions?.get(key);
  if (!admission || admission.status === 'closed') return;
  admission.status = 'resolving';
  admission.resolvingAt = now;
  delete admission.pendingFill;
  admission.updatedAt = now;
};

export const markCrossJurisdictionBookCancelPending = (
  currentEntityState: EntityState,
  route: CrossJurisdictionSwapRoute,
  sourceAccountId: string,
  now: number,
  reason = 'cancel_request',
): CrossJurisdictionBookAdmission => {
  const canonicalRoute = withCanonicalCrossJurisdictionRouteHash(route);
  const key = crossJurisdictionBookAdmissionKey(canonicalRoute);
  const admission = currentEntityState.crossJurisdictionBookAdmissions?.get(key);
  if (!admission) {
    throw new Error(
      `CROSS_J_CANCEL_ADMISSION_MISSING:order=${canonicalRoute.orderId}:source=${canonicalRoute.source.entityId}`,
    );
  }
  const canonicalRouteHash = canonicalRoute.routeHash;
  if (!canonicalRouteHash) {
    throw new Error(`CROSS_J_CANCEL_ROUTE_HASH_MISSING:order=${canonicalRoute.orderId}`);
  }
  if (normalizeEntityRef(admission.routeHash) !== normalizeEntityRef(canonicalRouteHash)) {
    throw new Error(
      `CROSS_J_CANCEL_ADMISSION_ROUTE_MISMATCH:order=${canonicalRoute.orderId}:` +
        `admission=${admission.routeHash}:route=${canonicalRoute.routeHash}`,
    );
  }
  const normalizedAccountId = normalizeEntityRef(sourceAccountId);
  if (!normalizedAccountId) {
    throw new Error(`CROSS_J_CANCEL_SOURCE_ACCOUNT_MISSING:order=${canonicalRoute.orderId}`);
  }
  if (
    admission.pendingCancel &&
    normalizeEntityRef(admission.pendingCancel.sourceAccountId) !== normalizedAccountId
  ) {
    throw new Error(
      `CROSS_J_CANCEL_SOURCE_ACCOUNT_MISMATCH:order=${canonicalRoute.orderId}:` +
        `pending=${admission.pendingCancel.sourceAccountId}:received=${sourceAccountId}`,
    );
  }
  admission.pendingCancel ??= {
    sourceAccountId,
    requestedAt: now,
    reason,
  };
  if (admission.status !== 'closed') {
    admission.status = 'resolving';
    admission.resolvingAt ??= now;
  }
  admission.updatedAt = now;
  return admission;
};

export const markCrossJurisdictionBookRemovalCommitted = (
  currentEntityState: EntityState,
  route: CrossJurisdictionSwapRoute,
  sourceAccountId: string,
  now: number,
  reason = 'cancel_request',
): CrossJurisdictionBookAdmission => {
  const admission = markCrossJurisdictionBookCancelPending(
    currentEntityState,
    route,
    sourceAccountId,
    now,
    reason,
  );
  admission.pendingCancel!.bookRemovalCommittedAt ??= now;
  admission.updatedAt = now;
  return admission;
};

export const markCrossJurisdictionBookAdmissionClosed = (
  currentEntityState: EntityState,
  sourceEntityId: string,
  orderId: string,
  now: number,
  reason: string,
): void => {
  const key = crossJurisdictionBookAdmissionKeyFor(sourceEntityId, orderId);
  const admission = currentEntityState.crossJurisdictionBookAdmissions?.get(key);
  if (!admission) return;
  admission.status = 'closed';
  admission.closedAt = now;
  admission.closeReason = reason;
  delete admission.pendingFill;
  delete admission.pendingCancel;
  admission.updatedAt = now;
};

export const getCrossJurisdictionBookAdmissionError = (
  currentEntityState: EntityState,
  route: CrossJurisdictionSwapRoute,
  now: number,
): string | null => {
  const canonicalRoute = withCanonicalCrossJurisdictionRouteHash(route);
  const currentOwner = normalizeEntityRef(currentEntityState.entityId);
  const bookOwner = crossJurisdictionBookOwnerRef(canonicalRoute);
  if (bookOwner !== currentOwner) {
    return `CROSS_J_ORDER_WRONG_BOOK_OWNER: order=${canonicalRoute.orderId} owner=${bookOwner} current=${currentOwner}`;
  }
  if (!canonicalRoute.sourcePull || !canonicalRoute.targetPull) {
    return `CROSS_J_ORDER_LOCK_REF_MISSING: order=${canonicalRoute.orderId}`;
  }
  if (isCrossJurisdictionRouteExpired(canonicalRoute, now)) {
    return `CROSS_J_ORDER_ROUTE_EXPIRED: order=${canonicalRoute.orderId}`;
  }
  if (isCrossJurisdictionPullExpired(canonicalRoute, 'source', now)) {
    return `CROSS_J_ORDER_LOCK_EXPIRED: order=${canonicalRoute.orderId} leg=source`;
  }
  if (isCrossJurisdictionPullExpired(canonicalRoute, 'target', now)) {
    return `CROSS_J_ORDER_LOCK_EXPIRED: order=${canonicalRoute.orderId} leg=target`;
  }

  const key = crossJurisdictionBookAdmissionKey(canonicalRoute);
  const admission = currentEntityState.crossJurisdictionBookAdmissions?.get(key);
  if (!admission) return `CROSS_J_BOOK_ADMISSION_PENDING: order=${canonicalRoute.orderId} leg=both`;
  if (admission.status === 'closed') {
    return `CROSS_J_BOOK_ADMISSION_CLOSED: order=${canonicalRoute.orderId} reason=${admission.closeReason || ''}`;
  }
  if (admission.status === 'resolving') {
    return `CROSS_J_BOOK_ADMISSION_RESOLVING: order=${canonicalRoute.orderId}`;
  }
  if (
    admission.orderId !== canonicalRoute.orderId ||
    admission.routeHash.toLowerCase() !== (canonicalRoute.routeHash || '').toLowerCase() ||
    normalizeEntityRef(admission.bookOwnerEntityId) !== bookOwner
  ) {
    return `CROSS_J_BOOK_ADMISSION_ROUTE_MISMATCH: order=${canonicalRoute.orderId}`;
  }

  return null;
};

export const isCrossJurisdictionBookAdmissionPending = (error: string | null): boolean =>
  Boolean(error && error.startsWith('CROSS_J_BOOK_ADMISSION_PENDING:'));

export const assertCrossJurisdictionOrderAdmissible = (
  currentEntityState: EntityState,
  route: CrossJurisdictionSwapRoute,
  now: number,
): void => {
  const error = getCrossJurisdictionBookAdmissionError(currentEntityState, route, now);
  if (error) throw new Error(error);
};

type CrossSwapFillAckTx = Extract<AccountTx, { type: 'cross_swap_fill_ack' }>;

export interface CrossJurisdictionFillInstruction {
  accountId: string;
  offerId: string;
  route: CrossJurisdictionSwapRoute;
  fillRatio: number;
  fillNumerator: bigint;
  fillDenominator: bigint;
  cancelRemainder: boolean;
  sourceAmount: bigint;
  targetAmount: bigint;
  executionSourceAmount: bigint;
  executionTargetAmount: bigint;
  priceImprovementMode: 'source_savings';
  priceImprovementAmount: bigint;
  priceImprovementTokenId: number | null;
  priceTicks: bigint;
  pairId: string;
  orderId: string;
}

export type CrossMarketOffer = {
  offer: NormalizedOrderbookOffer;
  route: CrossJurisdictionSwapRoute;
  pairId: string;
  side: 0 | 1;
  baseTokenId: number;
  quoteTokenId: number;
  baseAmount: bigint;
  quoteAmount: bigint;
  priceTicks: bigint;
  makerId: string;
};

/**
 * Cross-j has one price-improvement lane: unused source returns to the buyer.
 * Settlement therefore always uses the ask, independent of arrival order.
 * Generic maker-price settlement would pay an unsupported target-side bonus
 * whenever a bid rests first and would make the two bilateral legs diverge.
 */
export const resolveCrossJurisdictionExecutionPriceTicks = (
  first: CrossMarketOffer,
  second: CrossMarketOffer,
): bigint => {
  if (
    first.pairId !== second.pairId ||
    first.baseTokenId !== second.baseTokenId ||
    first.quoteTokenId !== second.quoteTokenId
  ) {
    throw new Error(`CROSS_J_TRADE_PAIR_MISMATCH:${first.pairId}:${second.pairId}`);
  }
  if (first.side === second.side) {
    throw new Error(`CROSS_J_TRADE_SIDE_MISMATCH:${first.side}:${second.side}`);
  }
  const sell = first.side === 1 ? first : second;
  const buy = first.side === 0 ? first : second;
  if (sell.priceTicks <= 0n || buy.priceTicks <= 0n || sell.priceTicks > buy.priceTicks) {
    throw new Error(
      `CROSS_J_TRADE_PRICE_NOT_CROSSED:ask=${sell.priceTicks.toString()}:bid=${buy.priceTicks.toString()}`,
    );
  }
  return sell.priceTicks;
};

export type CrossOrderbookFill = {
  filledLots: bigint;
  weightedCost: bigint;
};

const scaleByExactFillRatio = (total: bigint, numerator: bigint, denominator: bigint): bigint =>
  numerator >= denominator ? total : (total * numerator) / denominator;

export const getCrossJurisdictionRouteRemainingAmounts = (
  route: CrossJurisdictionSwapRoute,
): {
  sourceTotal: bigint;
  targetTotal: bigint;
  filledSourceAmount: bigint;
  filledTargetAmount: bigint;
  sourceRemaining: bigint;
  targetRemaining: bigint;
  fillRatio: number;
} => {
  const sourceTotal = BigInt(route.source.amount);
  const targetTotal = BigInt(route.target.amount);
  if (sourceTotal <= 0n || targetTotal <= 0n) {
    throw new Error(`CROSS_J_ROUTE_AMOUNT_INVALID: order=${route.orderId}`);
  }
  const { filledSourceAmount, filledTargetAmount, fillRatio } =
    getCrossJurisdictionCommittedFillAmounts(route);
  if (
    filledSourceAmount < 0n ||
    filledTargetAmount < 0n ||
    filledSourceAmount > sourceTotal ||
    filledTargetAmount > targetTotal
  ) {
    throw new Error(
      `CROSS_J_ROUTE_FILL_INVALID: order=${route.orderId} ` +
      `source=${filledSourceAmount.toString()}/${sourceTotal.toString()} ` +
      `target=${filledTargetAmount.toString()}/${targetTotal.toString()}`,
    );
  }
  return {
    sourceTotal,
    targetTotal,
    filledSourceAmount,
    filledTargetAmount,
    sourceRemaining: sourceTotal - filledSourceAmount,
    targetRemaining: targetTotal - filledTargetAmount,
    fillRatio,
  };
};

export const computeCrossJurisdictionPriceTicks = (
  side: 0 | 1,
  baseTokenId: number,
  quoteTokenId: number,
  baseAmount: bigint,
  quoteAmount: bigint,
): bigint => computePriceTicksForBaseQuote(
  side,
  baseTokenId,
  quoteTokenId,
  baseAmount,
  quoteAmount,
);

export const buildCrossJurisdictionMarketOffer = (
  offer: NormalizedOrderbookOffer,
  hubEntityId: string,
): CrossMarketOffer | null => {
  const route = offer.crossJurisdiction;
  if (!route) return null;
  const bookOwner = normalizeEntityRef(route.bookOwnerEntityId || route.source.counterpartyEntityId || route.hubEntityId);
  if (bookOwner && bookOwner !== normalizeEntityRef(hubEntityId)) return null;
  if (route.status !== 'resting' && route.status !== 'partially_filled') return null;
  const market = deriveCanonicalCrossJurisdictionMarket(route);
  if (!market.sourceKey || !market.targetKey || market.sourceKey === market.targetKey) return null;
  const side: 0 | 1 = market.sourceIsBase ? 1 : 0;
  const remaining = getCrossJurisdictionRouteRemainingAmounts(route);
  const baseTokenId = Number(market.sourceIsBase ? route.source.tokenId : route.target.tokenId);
  const quoteTokenId = Number(market.sourceIsBase ? route.target.tokenId : route.source.tokenId);
  const baseAmount = market.sourceIsBase ? remaining.sourceRemaining : remaining.targetRemaining;
  const quoteAmount = market.sourceIsBase ? remaining.targetRemaining : remaining.sourceRemaining;
  // Cross-j books are keyed by jurisdiction+token assets, not by token id alone.
  // Route amounts are the committed economic intent, so derive book price from
  // the committed route remainder instead of trusting the account offer view.
  const priceTicks = computeCrossJurisdictionPriceTicks(
    side,
    baseTokenId,
    quoteTokenId,
    baseAmount,
    quoteAmount,
  );
  if (baseAmount <= 0n || quoteAmount <= 0n || priceTicks <= 0n) return null;
  return {
    offer,
    route,
    pairId: market.venueId,
    side,
    baseTokenId,
    quoteTokenId,
    baseAmount,
    quoteAmount,
    priceTicks,
    makerId: offer.makerIsLeft ? offer.fromEntity : offer.toEntity,
  };
};

export const buildCrossJurisdictionFillAck = (
  accountId: string,
  offerId: string,
  namespacedOrderId: string,
  meta: CrossMarketOffer,
  fill: CrossOrderbookFill,
): { instruction: CrossJurisdictionFillInstruction; tx: CrossSwapFillAckTx } | null => {
  const filledLotsBig = BigInt(fill.filledLots);
  if (filledLotsBig <= 0n || fill.weightedCost <= 0n) return null;

  const executionBaseWei = baseAmountFromLots(meta.baseTokenId, filledLotsBig);
  const executionQuoteWei = quoteAmountFromWeightedLots(
    meta.baseTokenId,
    meta.quoteTokenId,
    fill.weightedCost,
  );
  const sourceAmount = meta.side === 1 ? executionBaseWei : executionQuoteWei;
  const targetAmount = meta.side === 1 ? executionQuoteWei : executionBaseWei;
  if (sourceAmount <= 0n || targetAmount <= 0n) return null;

  const {
    sourceTotal,
    targetTotal,
    filledSourceAmount: previousSourceClaimed,
    filledTargetAmount: previousTargetClaimed,
    fillRatio: previousCumulativeRatio,
  } = getCrossJurisdictionCommittedFillAmounts(meta.route);
  const priceImprovementMode = meta.route.priceImprovementMode ?? 'source_savings';
  // Hash-ledger ratio is the committed order-progress ratio. Price improvement
  // always follows target progress. A better book price spends less source;
  // cross-j never creates a second target-side payment lane.
  const exactFillRatio = deriveExactSwapFillRatio(
    targetTotal,
    previousTargetClaimed + targetAmount,
  );
  if (
    previousSourceClaimed + sourceAmount > sourceTotal ||
    previousTargetClaimed + targetAmount > targetTotal
  ) return null;
  const fillRatio = exactFillRatioToUint16(exactFillRatio);
  if (fillRatio <= previousCumulativeRatio) return null;

  // Keep settlement amounts exact. The uint16 ratio is only a coarse
  // hash-ladder/dispute projection; using it here creates dust-sized drift on
  // partial fills (for example exact 1/4 becomes 16384/65535).
  const exactCumulativeSource = scaleByExactFillRatio(
    sourceTotal,
    exactFillRatio.numerator,
    exactFillRatio.denominator,
  );
  const exactCumulativeTarget = scaleByExactFillRatio(
    targetTotal,
    exactFillRatio.numerator,
    exactFillRatio.denominator,
  );
  const settlementSourceAmount = exactCumulativeSource - previousSourceClaimed;
  const settlementTargetAmount = exactCumulativeTarget - previousTargetClaimed;
  if (settlementSourceAmount <= 0n || settlementTargetAmount <= 0n) return null;
  // The matcher owns one exact base/quote execution pair. The proportional
  // source claim may be larger only when this order receives price improvement;
  // the difference is returned during clear. It may never be smaller than the
  // shared execution amount, because that would make the paired ACKs diverge.
  if (settlementTargetAmount !== targetAmount || settlementSourceAmount < sourceAmount) return null;
  const sourceSavings = settlementSourceAmount - sourceAmount;
  const priceImprovementAmount = sourceSavings;
  const priceImprovementTokenId = priceImprovementAmount > 0n
    ? Number(meta.route.source.tokenId)
    : null;
  const executionSourceAmount = sourceAmount;
  const executionTargetAmount = targetAmount;
  const nextActualTargetAmount = previousTargetClaimed + executionTargetAmount;
  const terminalCancel =
    fillRatio >= CROSS_J_MAX_FILL_RATIO ||
    nextActualTargetAmount >= targetTotal;

  const instruction: CrossJurisdictionFillInstruction = {
    accountId,
    offerId,
    route: meta.route,
    fillRatio,
    fillNumerator: exactFillRatio.numerator,
    fillDenominator: exactFillRatio.denominator,
    cancelRemainder: terminalCancel,
    sourceAmount: settlementSourceAmount,
    targetAmount: settlementTargetAmount,
    executionSourceAmount,
    executionTargetAmount,
    priceImprovementMode,
    priceImprovementAmount,
    priceImprovementTokenId,
    priceTicks: meta.priceTicks,
    pairId: meta.pairId,
    orderId: namespacedOrderId,
  };
  const tx: CrossSwapFillAckTx = {
    type: 'cross_swap_fill_ack',
    data: {
      offerId,
      ...(meta.route.routeHash ? { routeHash: meta.route.routeHash } : {}),
      previousFillSeq: Math.max(0, Math.floor(Number(meta.route.fillSeq ?? 0) || 0)),
      fillSeq: Math.max(0, Math.floor(Number(meta.route.fillSeq ?? 0) || 0)) + 1,
      incrementalSourceAmount: settlementSourceAmount,
      incrementalTargetAmount: settlementTargetAmount,
      cumulativeSourceAmount: previousSourceClaimed + settlementSourceAmount,
      cumulativeTargetAmount: previousTargetClaimed + settlementTargetAmount,
      cumulativeFillRatio: fillRatio,
      fillNumerator: exactFillRatio.numerator,
      fillDenominator: exactFillRatio.denominator,
      ackKind: 'fill',
      executionSourceAmount,
      executionTargetAmount,
      priceImprovementMode,
      ...(priceImprovementAmount > 0n ? { priceImprovementAmount } : {}),
      ...(priceImprovementTokenId !== null ? { priceImprovementTokenId } : {}),
      cancelRemainder: terminalCancel,
      comment: `cross-j-hashledger-fill:${fillRatio}`,
      priceTicks: meta.priceTicks,
      pairId: meta.pairId,
    },
  };
  return { instruction, tx };
};

export const buildCrossJurisdictionCancelAck = (
  offerId: string,
  route: CrossJurisdictionSwapRoute,
): CrossSwapFillAckTx => {
  const {
    filledSourceAmount: cumulativeSourceAmount,
    filledTargetAmount: cumulativeTargetAmount,
    fillRatio: currentRatio,
  } = getCrossJurisdictionCommittedFillAmounts(route);
  return {
    type: 'cross_swap_fill_ack',
    data: {
      offerId,
      ...(route.routeHash ? { routeHash: route.routeHash } : {}),
      previousFillSeq: Math.max(0, Math.floor(Number(route.fillSeq ?? 0) || 0)),
      fillSeq: Math.max(0, Math.floor(Number(route.fillSeq ?? 0) || 0)),
      incrementalSourceAmount: 0n,
      incrementalTargetAmount: 0n,
      cumulativeSourceAmount,
      cumulativeTargetAmount,
      cumulativeFillRatio: currentRatio,
      ...(route.fillNumerator !== undefined ? { fillNumerator: route.fillNumerator } : {}),
      ...(route.fillDenominator !== undefined ? { fillDenominator: route.fillDenominator } : {}),
      ackKind: 'cancel',
      executionSourceAmount: 0n,
      executionTargetAmount: 0n,
      cancelRemainder: true,
      comment: 'cross-j-cancel-request',
      pairId: route.venueId || '',
    },
  };
};
