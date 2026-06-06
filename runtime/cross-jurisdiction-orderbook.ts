import {
  CROSS_J_MAX_FILL_RATIO,
  cloneCrossJurisdictionRoute,
  compareCrossJurisdictionRouteStatus,
  deriveCanonicalCrossJurisdictionMarket,
  isCrossJurisdictionPullExpired,
  isCrossJurisdictionRouteExpired,
  withCanonicalCrossJurisdictionRouteHash,
} from './cross-jurisdiction';
import { ORDERBOOK_PRICE_SCALE, SWAP_LOT_SCALE } from './orderbook';
import {
  deriveExactSwapFillRatio,
  exactFillRatioToUint16,
  type NormalizedOrderbookOffer,
} from './swap-execution';
import type {
  AccountTx,
  CrossJurisdictionBookAdmission,
  CrossJurisdictionBookAdmissionReceipt,
  CrossJurisdictionBookLeg,
  CrossJurisdictionPullLeg,
  CrossJurisdictionSwapRoute,
  EntityState,
} from './types';

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

const routeLegRefs = (
  route: CrossJurisdictionSwapRoute,
  leg: CrossJurisdictionBookLeg,
): { hubEntityId: string; counterpartyEntityId: string; pull: CrossJurisdictionPullLeg | undefined } => (
  leg === 'source'
    ? {
        hubEntityId: route.source.counterpartyEntityId,
        counterpartyEntityId: route.source.entityId,
        pull: route.sourcePull,
      }
    : {
        hubEntityId: route.target.entityId,
        counterpartyEntityId: route.target.counterpartyEntityId,
        pull: route.targetPull,
      }
);

const receiptAdmissionError = (
  routeOrderId: string,
  routeHash: string,
  legName: CrossJurisdictionBookLeg,
  receipt: CrossJurisdictionBookAdmissionReceipt | undefined,
  expected: CrossJurisdictionPullLeg,
  expectedHubEntityId: string,
  expectedCounterpartyEntityId: string,
): string | null => {
  if (!receipt) {
    return `CROSS_J_BOOK_ADMISSION_PENDING: order=${routeOrderId} leg=${legName} pull=${expected.pullId}`;
  }
  if (
    receipt.leg !== legName ||
    receipt.orderId !== routeOrderId ||
    receipt.routeHash.toLowerCase() !== routeHash.toLowerCase() ||
    normalizeEntityRef(receipt.hubEntityId) !== normalizeEntityRef(expectedHubEntityId) ||
    normalizeEntityRef(receipt.counterpartyEntityId) !== normalizeEntityRef(expectedCounterpartyEntityId) ||
    receipt.pullId !== expected.pullId ||
    receipt.tokenId !== expected.tokenId ||
    receipt.signedAmount !== expected.signedAmount ||
    (receipt.fullHash || '').toLowerCase() !== expected.fullHash.toLowerCase() ||
    (receipt.partialRoot || '').toLowerCase() !== expected.partialRoot.toLowerCase() ||
    receipt.revealedUntilTimestamp !== expected.revealedUntilTimestamp
  ) {
    return `CROSS_J_BOOK_ADMISSION_RECEIPT_MISMATCH: order=${routeOrderId} leg=${legName} pull=${expected.pullId}`;
  }
  return null;
};

export const getCrossJurisdictionBookReceiptError = (
  route: CrossJurisdictionSwapRoute,
  receipt: CrossJurisdictionBookAdmissionReceipt,
): string | null => {
  const canonicalRoute = withCanonicalCrossJurisdictionRouteHash(route);
  const { hubEntityId, counterpartyEntityId, pull } = routeLegRefs(canonicalRoute, receipt.leg);
  if (!pull) {
    return `CROSS_J_BOOK_RECEIPT_PULL_REF_MISSING: order=${canonicalRoute.orderId} leg=${receipt.leg}`;
  }
  return receiptAdmissionError(
    canonicalRoute.orderId,
    canonicalRoute.routeHash || '',
    receipt.leg,
    receipt,
    pull,
    hubEntityId,
    counterpartyEntityId,
  );
};

export const crossJurisdictionBookOwnerRef = (route: CrossJurisdictionSwapRoute): string =>
  normalizeEntityRef(route.bookOwnerEntityId || route.source.counterpartyEntityId || route.hubEntityId || '');

export const buildCrossJurisdictionBookAdmissionReceipt = (
  route: CrossJurisdictionSwapRoute,
  leg: CrossJurisdictionBookLeg,
  accountTx: Extract<AccountTx, { type: 'pull_lock' }>,
  hubEntityId: string,
  counterpartyEntityId: string,
  committedAt: number,
): CrossJurisdictionBookAdmissionReceipt => {
  const canonicalRoute = withCanonicalCrossJurisdictionRouteHash(route);
  const { hubEntityId: expectedHubEntityId, counterpartyEntityId: expectedCounterpartyEntityId, pull } =
    routeLegRefs(canonicalRoute, leg);
  if (!pull) {
    throw new Error(`CROSS_J_BOOK_RECEIPT_PULL_REF_MISSING: order=${canonicalRoute.orderId} leg=${leg}`);
  }
  const receipt: CrossJurisdictionBookAdmissionReceipt = {
    leg,
    orderId: canonicalRoute.orderId,
    routeHash: canonicalRoute.routeHash || '',
    hubEntityId: normalizeEntityRef(hubEntityId),
    counterpartyEntityId: normalizeEntityRef(counterpartyEntityId),
    pullId: String(accountTx.data.pullId || ''),
    tokenId: Number(accountTx.data.tokenId),
    signedAmount: BigInt(accountTx.data.amount),
    revealedUntilTimestamp: Number(accountTx.data.revealedUntilTimestamp),
    fullHash: String(accountTx.data.fullHash || ''),
    partialRoot: String(accountTx.data.partialRoot || ''),
    committedAt: Number(committedAt || 0),
  };
  const error = receiptAdmissionError(
    canonicalRoute.orderId,
    canonicalRoute.routeHash || '',
    leg,
    receipt,
    pull,
    expectedHubEntityId,
    expectedCounterpartyEntityId,
  );
  if (error) throw new Error(error);
  return receipt;
};

export const mergeCrossJurisdictionBookAdmission = (
  currentEntityState: EntityState,
  route: CrossJurisdictionSwapRoute,
  now: number,
  receipt?: CrossJurisdictionBookAdmissionReceipt,
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
  if (receipt) {
    if (receipt.leg === 'source') current.sourceReceipt = receipt;
    if (receipt.leg === 'target') current.targetReceipt = receipt;
  }
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
  admission.updatedAt = now;
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

  const sourceRefs = routeLegRefs(canonicalRoute, 'source');
  const targetRefs = routeLegRefs(canonicalRoute, 'target');
  return (
    receiptAdmissionError(
      canonicalRoute.orderId,
      canonicalRoute.routeHash || '',
      'source',
      admission.sourceReceipt,
      canonicalRoute.sourcePull,
      sourceRefs.hubEntityId,
      sourceRefs.counterpartyEntityId,
    ) ??
    receiptAdmissionError(
      canonicalRoute.orderId,
      canonicalRoute.routeHash || '',
      'target',
      admission.targetReceipt,
      canonicalRoute.targetPull,
      targetRefs.hubEntityId,
      targetRefs.counterpartyEntityId,
    )
  );
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
  priceImprovementMode: 'source_savings' | 'target_bonus' | 'none';
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
  baseAmount: bigint;
  quoteAmount: bigint;
  priceTicks: bigint;
  makerId: string;
};

export type CrossOrderbookFill = {
  filledLots: number;
  weightedCost: bigint;
};

const clampCrossJurisdictionFillRatio = (value: unknown): number =>
  Math.max(0, Math.min(CROSS_J_MAX_FILL_RATIO, Math.floor(Number(value) || 0)));

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
  const fillRatio = Math.max(
    clampCrossJurisdictionFillRatio(route.cumulativeFillRatio),
    clampCrossJurisdictionFillRatio(route.claimedRatio),
  );
  const filledSourceAmount =
    route.filledSourceAmount ??
    route.sourceClaimed ??
    ((sourceTotal * BigInt(fillRatio)) / BigInt(CROSS_J_MAX_FILL_RATIO));
  const filledTargetAmount =
    route.filledTargetAmount ??
    route.targetClaimed ??
    ((targetTotal * BigInt(fillRatio)) / BigInt(CROSS_J_MAX_FILL_RATIO));
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
  baseAmount: bigint,
  quoteAmount: bigint,
): bigint => {
  if (baseAmount <= 0n || quoteAmount <= 0n) return 0n;
  const scaledQuote = quoteAmount * ORDERBOOK_PRICE_SCALE;
  const remainder = scaledQuote % baseAmount;
  let priceTicks = scaledQuote / baseAmount;
  if (side === 1 && remainder > 0n) priceTicks += 1n;
  return priceTicks > 0n ? priceTicks : 0n;
};

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
  const baseAmount = market.sourceIsBase ? remaining.sourceRemaining : remaining.targetRemaining;
  const quoteAmount = market.sourceIsBase ? remaining.targetRemaining : remaining.sourceRemaining;
  // Cross-j books are keyed by jurisdiction+token assets, not by token id alone.
  // Route amounts are the committed economic intent, so derive book price from
  // the committed route remainder instead of trusting the account offer view.
  const priceTicks = computeCrossJurisdictionPriceTicks(side, baseAmount, quoteAmount);
  if (baseAmount <= 0n || quoteAmount <= 0n || priceTicks <= 0n) return null;
  return {
    offer,
    route,
    pairId: market.venueId,
    side,
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

  const executionBaseWei = filledLotsBig * SWAP_LOT_SCALE;
  const executionQuoteWei = (fill.weightedCost * SWAP_LOT_SCALE) / ORDERBOOK_PRICE_SCALE;
  const sourceAmount = meta.side === 1 ? executionBaseWei : executionQuoteWei;
  const targetAmount = meta.side === 1 ? executionQuoteWei : executionBaseWei;
  if (sourceAmount <= 0n || targetAmount <= 0n) return null;

  const previousRatio = Math.max(0, Math.min(
    CROSS_J_MAX_FILL_RATIO,
    Math.floor(Number(meta.route.claimedRatio ?? 0) || 0),
  ));
  const previousCumulativeRatio = Math.max(
    previousRatio,
    Math.max(0, Math.min(CROSS_J_MAX_FILL_RATIO, Math.floor(Number(meta.route.cumulativeFillRatio ?? 0) || 0))),
  );
  const sourceTotal = BigInt(meta.route.source.amount);
  const targetTotal = BigInt(meta.route.target.amount);
  const previousSourceClaimed =
    meta.route.filledSourceAmount ??
    meta.route.sourceClaimed ??
    ((sourceTotal * BigInt(previousCumulativeRatio)) / BigInt(CROSS_J_MAX_FILL_RATIO));
  const desiredSourceClaimed = previousSourceClaimed + sourceAmount;
  const cappedSourceClaimed = desiredSourceClaimed >= sourceTotal ? sourceTotal : desiredSourceClaimed;
  const exactFillRatio = deriveExactSwapFillRatio(sourceTotal, cappedSourceClaimed);
  const fillRatio = exactFillRatioToUint16(exactFillRatio);
  if (fillRatio <= previousCumulativeRatio) return null;

  const settlementSourceAmount =
    (sourceTotal * BigInt(fillRatio)) / BigInt(CROSS_J_MAX_FILL_RATIO) - previousSourceClaimed;
  const previousTargetClaimed =
    meta.route.filledTargetAmount ??
    meta.route.targetClaimed ??
    ((targetTotal * BigInt(previousCumulativeRatio)) / BigInt(CROSS_J_MAX_FILL_RATIO));
  const settlementTargetAmount =
    (targetTotal * BigInt(fillRatio)) / BigInt(CROSS_J_MAX_FILL_RATIO) - previousTargetClaimed;
  if (settlementSourceAmount <= 0n || settlementTargetAmount <= 0n) return null;
  const priceImprovementMode = meta.route.priceImprovementMode ?? 'source_savings';
  const sourceSavings = settlementSourceAmount > sourceAmount ? settlementSourceAmount - sourceAmount : 0n;
  const targetBonus = targetAmount > settlementTargetAmount ? targetAmount - settlementTargetAmount : 0n;
  const priceImprovementAmount = priceImprovementMode === 'source_savings'
    ? sourceSavings
    : priceImprovementMode === 'target_bonus'
      ? targetBonus
      : 0n;
  const priceImprovementTokenId = priceImprovementAmount > 0n
    ? priceImprovementMode === 'source_savings'
      ? Number(meta.route.source.tokenId)
      : Number(meta.route.target.tokenId)
    : null;
  const executionSourceAmount = priceImprovementMode === 'source_savings' && sourceSavings > 0n
    ? settlementSourceAmount - sourceSavings
    : settlementSourceAmount;
  const executionTargetAmount = priceImprovementMode === 'target_bonus' && targetBonus > 0n
    ? settlementTargetAmount + targetBonus
    : settlementTargetAmount;

  const instruction: CrossJurisdictionFillInstruction = {
    accountId,
    offerId,
    route: meta.route,
    fillRatio,
    fillNumerator: exactFillRatio.numerator,
    fillDenominator: exactFillRatio.denominator,
    cancelRemainder: fillRatio >= CROSS_J_MAX_FILL_RATIO,
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
      fillSeq: Math.max(0, Math.floor(Number(meta.route.fillSeq ?? 0) || 0)) + 1,
      incrementalSourceAmount: settlementSourceAmount,
      incrementalTargetAmount: settlementTargetAmount,
      cumulativeSourceAmount: previousSourceClaimed + settlementSourceAmount,
      cumulativeTargetAmount: previousTargetClaimed + settlementTargetAmount,
      cumulativeFillRatio: fillRatio,
      fillNumerator: exactFillRatio.numerator,
      fillDenominator: exactFillRatio.denominator,
      executionSourceAmount,
      executionTargetAmount,
      priceImprovementMode,
      ...(priceImprovementAmount > 0n ? { priceImprovementAmount } : {}),
      ...(priceImprovementTokenId !== null ? { priceImprovementTokenId } : {}),
      cancelRemainder: fillRatio >= CROSS_J_MAX_FILL_RATIO,
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
  const currentRatio = Math.max(
    0,
    Math.min(CROSS_J_MAX_FILL_RATIO, Math.floor(Number(route.cumulativeFillRatio ?? route.claimedRatio ?? 0) || 0)),
  );
  const sourceTotal = BigInt(route.source.amount);
  const targetTotal = BigInt(route.target.amount);
  const cumulativeSourceAmount =
    route.filledSourceAmount ??
    route.sourceClaimed ??
    ((sourceTotal * BigInt(currentRatio)) / BigInt(CROSS_J_MAX_FILL_RATIO));
  const cumulativeTargetAmount =
    route.filledTargetAmount ??
    route.targetClaimed ??
    ((targetTotal * BigInt(currentRatio)) / BigInt(CROSS_J_MAX_FILL_RATIO));
  return {
    type: 'cross_swap_fill_ack',
    data: {
      offerId,
      fillSeq: Math.max(0, Math.floor(Number(route.fillSeq ?? 0) || 0)),
      incrementalSourceAmount: 0n,
      incrementalTargetAmount: 0n,
      cumulativeSourceAmount,
      cumulativeTargetAmount,
      cumulativeFillRatio: currentRatio,
      executionSourceAmount: 0n,
      executionTargetAmount: 0n,
      cancelRemainder: true,
      comment: 'cross-j-cancel-request',
      pairId: route.venueId || '',
    },
  };
};
