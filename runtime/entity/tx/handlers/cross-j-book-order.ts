import {
  cloneCrossJurisdictionRoute,
  compareCrossJurisdictionRouteStatus,
  applyCrossJurisdictionFillProgress,
  assertCrossJurisdictionPriceImprovementMode,
  getCrossJurisdictionCommittedProofRatio,
  isCrossJurisdictionTerminalStatus,
  transitionCrossJurisdictionRouteStatus,
  withCanonicalCrossJurisdictionRouteHash,
} from '../../../extensions/cross-j/index';
import {
  buildCrossJurisdictionMarketOffer,
  crossJurisdictionBookAdmissionKey,
  crossJurisdictionBookAdmissionKeyFor,
  crossJurisdictionBookOwnerRef,
  getCrossJurisdictionBookAdmissionError,
  getCrossJurisdictionRouteRemainingAmounts,
  isCrossJurisdictionBookAdmissionPending,
  buildCrossJurisdictionCancelAck,
  markCrossJurisdictionBookCancelPending,
  markCrossJurisdictionBookAdmissionClosed,
  markCrossJurisdictionBookRemovalCommitted,
  mergeCrossJurisdictionBookAdmission,
} from '../../../extensions/cross-j/orderbook';
import { resolveRuntimeSecurityIncident } from '../../../machine/security-incidents';
import type { CrossJurisdictionSwapRoute, EntityState, EntityTx, Env, RuntimeOverlayRecord } from '../../../types';
import { getSwapLotScale } from '../../../orderbook';
import {
  removeCrossJurisdictionBookOrderByRouteId,
  resizeCrossJurisdictionBookOrderByRouteId,
} from '../../../orderbook/cross-j';
import { cloneEntityState, addMessage } from '../../../state-helpers';
import { findAccountKey } from '../account-key';
import {
  mergeCrossJurisdictionRoute,
  validateCrossJurisdictionRouteTransition,
} from '../cross-jurisdiction-helpers';
import {
  normalizeSwapOfferForOrderbook,
  type SwapOfferEvent,
} from './account/orderbook-offers';
import type { ApplyEntityTxOptions } from '../apply';
import {
  buildCrossJurisdictionEntityOutput,
  crossJurisdictionRouteSignerHint,
} from '../cross-j-outputs';
import { hasQueuedCrossSwapAckForEntityState } from './account/orderbook-queue';

const deterministicEntityTimestamp = (state: EntityState, env: Env): number =>
  Number(state.timestamp || env.timestamp || 0);
const stateForEntityTx = (entityState: EntityState, options?: ApplyEntityTxOptions): EntityState =>
  options?.mutableFrameState ? entityState : cloneEntityState(entityState);

const normalizeEntityRef = (value: string): string => String(value || '').toLowerCase();
const crossBookQtyLots = (baseTokenId: number, baseAmount: bigint): bigint => {
  if (baseAmount <= 0n) return 0n;
  const lotScale = getSwapLotScale(baseTokenId);
  return (baseAmount + lotScale - 1n) / lotScale;
};

type CrossJurisdictionBookProgressTx = Extract<EntityTx, { type: 'applyCrossJurisdictionBookProgress' }>;

const isSameCommittedBookProgress = (
  route: ReturnType<typeof withCanonicalCrossJurisdictionRouteHash>,
  data: CrossJurisdictionBookProgressTx['data'],
): boolean => (
  Math.floor(Number(route.fillSeq ?? 0)) === Math.floor(Number(data.fillSeq)) &&
  getCrossJurisdictionCommittedProofRatio(route) === getCrossJurisdictionCommittedProofRatio({
    orderId: data.orderId,
    cumulativeFillRatio: data.cumulativeFillRatio,
    fillNumerator: data.fillNumerator,
    fillDenominator: data.fillDenominator,
  }) &&
  route.filledSourceAmount === data.cumulativeSourceAmount &&
  route.filledTargetAmount === data.cumulativeTargetAmount &&
  (route.fillNumerator ?? undefined) === (data.fillNumerator ?? undefined) &&
  (route.fillDenominator ?? undefined) === (data.fillDenominator ?? undefined)
);

const buildCommittedCrossJurisdictionOfferEvent = (
  state: EntityState,
  route: ReturnType<typeof withCanonicalCrossJurisdictionRouteHash>,
): SwapOfferEvent | null => {
  const accountId = findAccountKey(state, route.source.entityId);
  const account = accountId ? state.accounts.get(accountId) : undefined;
  const offer = account?.swapOffers?.get(route.orderId);
  const remaining = getCrossJurisdictionRouteRemainingAmounts(route);
  if (!accountId || !account || !offer?.crossJurisdiction) {
    // The canonical cross-j book owner may be the target-side hub. In that
    // case the source offer is committed on the sibling source hub, but this
    // book owner still has both committed pull receipts and can safely expose
    // the order to matching.
    return {
      offerId: route.orderId,
      accountId: normalizeEntityRef(route.source.entityId),
      makerIsLeft: true,
      fromEntity: normalizeEntityRef(route.source.entityId),
      toEntity: normalizeEntityRef(route.source.counterpartyEntityId),
      createdHeight: 0,
      giveTokenId: Number(route.source.tokenId),
      giveAmount: remaining.sourceRemaining,
      wantTokenId: Number(route.target.tokenId),
      wantAmount: remaining.targetRemaining,
      ...(route.priceTicks !== undefined ? { priceTicks: BigInt(route.priceTicks) } : {}),
      minFillRatio: 0,
      crossJurisdiction: cloneCrossJurisdictionRoute(route),
    };
  }
  return {
    offerId: route.orderId,
    accountId,
    makerIsLeft: offer.makerIsLeft,
    fromEntity: account.leftEntity,
    toEntity: account.rightEntity,
    createdHeight: offer.createdHeight,
    giveTokenId: offer.giveTokenId,
    giveAmount: remaining.sourceRemaining,
    wantTokenId: offer.wantTokenId,
    wantAmount: remaining.targetRemaining,
    ...(offer.priceTicks !== undefined ? { priceTicks: offer.priceTicks } : {}),
    ...(offer.timeInForce !== undefined ? { timeInForce: offer.timeInForce } : {}),
    minFillRatio: offer.minFillRatio,
    crossJurisdiction: cloneCrossJurisdictionRoute(route),
  };
};

export const handleAdmitCrossJurisdictionBookOrderEntityTx = (
  env: Env,
  entityState: EntityState,
  entityTx: EntityTx & { type: 'admitCrossJurisdictionBookOrder' },
  options?: ApplyEntityTxOptions,
) => {
  const newState = stateForEntityTx(entityState, options);
  const route = withCanonicalCrossJurisdictionRouteHash(entityTx.data.route);
  const now = deterministicEntityTimestamp(newState, env);
  const bookOwner = crossJurisdictionBookOwnerRef(route);
  if (bookOwner !== normalizeEntityRef(newState.entityId)) {
    throw new Error(`CROSS_J_BOOK_ADMIT_WRONG_OWNER: order=${route.orderId} owner=${bookOwner} current=${newState.entityId}`);
  }
  const admissionKey = crossJurisdictionBookAdmissionKey(route);
  const existingAdmission = newState.crossJurisdictionBookAdmissions?.get(admissionKey);
  if (existingAdmission?.status === 'closed' || existingAdmission?.status === 'resolving') {
    if ((existingAdmission.routeHash || '').toLowerCase() !== (route.routeHash || '').toLowerCase()) {
      throw new Error(`CROSS_J_BOOK_ADMIT_ROUTE_INVALID: order=${route.orderId} existing admission route hash mismatch`);
    }
    addMessage(newState, `🌉 Cross-j book admit ${route.orderId}: duplicate ${existingAdmission.status}`);
    return { newState, outputs: [], swapOffersCreated: [] };
  }

  newState.crossJurisdictionSwaps ||= new Map();
  const existing = newState.crossJurisdictionSwaps.get(route.orderId);
  if (!existing || !isCrossJurisdictionTerminalStatus(existing.status)) {
    const transitionError = validateCrossJurisdictionRouteTransition(existing, route);
    const existingRouteHash = existing?.routeHash?.toLowerCase();
    const routeHash = route.routeHash?.toLowerCase();
    const staleSameRoute =
      Boolean(existingRouteHash && routeHash) &&
      existingRouteHash === routeHash &&
      compareCrossJurisdictionRouteStatus(existing?.status, route.status) < 0;
    if (transitionError && !staleSameRoute) {
      throw new Error(`CROSS_J_BOOK_ADMIT_ROUTE_INVALID: order=${route.orderId} ${transitionError}`);
    }
    newState.crossJurisdictionSwaps.set(
      route.orderId,
      staleSameRoute && existing
        ? mergeCrossJurisdictionRoute(route, existing)
        : mergeCrossJurisdictionRoute(existing, route),
    );
  }

  const admission = mergeCrossJurisdictionBookAdmission(newState, route, now);

  const offerEvent = buildCommittedCrossJurisdictionOfferEvent(newState, admission.route);
  if (!offerEvent) {
    addMessage(newState, `🌉 Cross-j book admit ${route.orderId}: waiting source offer`);
    return { newState, outputs: [], swapOffersCreated: [] };
  }

  const admissionError = getCrossJurisdictionBookAdmissionError(
    newState,
    admission.route,
    now,
  );
  if (admissionError) {
    if (isCrossJurisdictionBookAdmissionPending(admissionError)) {
      addMessage(newState, `🌉 Cross-j book admit ${route.orderId}: pending ${admissionError}`);
      return { newState, outputs: [], swapOffersCreated: [] };
    }
    throw new Error(admissionError);
  }

  admission.status = 'admitted';
  admission.admittedAt ??= now;
  admission.updatedAt = now;
  addMessage(newState, `🌉 Cross-j book admit ${route.orderId}${entityTx.data.reason ? `: ${entityTx.data.reason}` : ''}`);
  return { newState, outputs: [], swapOffersCreated: [offerEvent] };
};

export const applyCrossJurisdictionBookProgressToState = (
  env: Env,
  newState: EntityState,
  data: CrossJurisdictionBookProgressTx['data'],
  storageChanges: RuntimeOverlayRecord[] = [],
): boolean => {
  assertCrossJurisdictionPriceImprovementMode(data.priceImprovementMode, data.orderId);
  const now = deterministicEntityTimestamp(newState, env);
  const admissionKey = crossJurisdictionBookAdmissionKeyFor(data.sourceEntityId, data.orderId);
  const admission = newState.crossJurisdictionBookAdmissions?.get(admissionKey);
  if (!admission) {
    throw new Error(`CROSS_J_BOOK_PROGRESS_ADMISSION_MISSING: order=${data.orderId} source=${data.sourceEntityId}`);
  }
  const cancelPending = admission.status === 'resolving' && Boolean(admission.pendingCancel);
  if (admission.status !== 'admitted' && !cancelPending) {
    throw new Error(`CROSS_J_BOOK_PROGRESS_ADMISSION_NOT_ADMITTED: order=${data.orderId} status=${admission.status}`);
  }

  const route = withCanonicalCrossJurisdictionRouteHash(admission.route);
  const bookOwner = crossJurisdictionBookOwnerRef(route);
  if (bookOwner !== normalizeEntityRef(newState.entityId)) {
    throw new Error(`CROSS_J_BOOK_PROGRESS_WRONG_OWNER: order=${route.orderId} owner=${bookOwner} current=${newState.entityId}`);
  }
  if (isSameCommittedBookProgress(route, data)) {
    if (admission.pendingFill?.ttlExpiredAt !== undefined) {
      resolveRuntimeSecurityIncident(env, {
        domain: 'cross-j',
        code: 'CROSS_J_BOOK_FILL_TTL_EXPIRED',
        source: 'local-consensus',
        severity: 'critical',
        summary: 'Book-owner fill is still waiting for its exact terminal sibling acknowledgement',
        entityId: newState.entityId,
        accountId: data.sourceEntityId,
        offerId: data.orderId,
        routeHash: route.routeHash || '',
      });
    }
    delete admission.pendingFill;
    admission.updatedAt = now;
    if (
      admission.pendingCancel &&
      normalizeEntityRef(newState.entityId) !== normalizeEntityRef(route.source.counterpartyEntityId)
    ) {
      markCrossJurisdictionBookAdmissionClosed(
        newState,
        route.source.entityId,
        route.orderId,
        now,
        admission.pendingCancel.reason || 'cancel_request_after_fill',
      );
    }
    return false;
  }

  const currentSeq = Math.floor(Number(route.fillSeq ?? 0));
  if (Math.floor(Number(data.fillSeq)) <= currentSeq) {
    throw new Error(`CROSS_J_BOOK_PROGRESS_STALE: order=${route.orderId} seq=${data.fillSeq} current=${currentSeq}`);
  }

  const nextRoute = applyCrossJurisdictionFillProgress(route, {
    fillSeq: data.fillSeq,
    cumulativeFillRatio: data.cumulativeFillRatio,
    fillNumerator: data.fillNumerator,
    fillDenominator: data.fillDenominator,
    incrementalSourceAmount: data.incrementalSourceAmount,
    incrementalTargetAmount: data.incrementalTargetAmount,
    cumulativeSourceAmount: data.cumulativeSourceAmount,
    cumulativeTargetAmount: data.cumulativeTargetAmount,
  }, now, 'CROSS_J_BOOK_PROGRESS_INVALID');
  if ((data.priceImprovementAmount ?? 0n) > 0n) {
    nextRoute.priceImprovementSourceAmount =
      (nextRoute.priceImprovementSourceAmount ?? 0n) + data.priceImprovementAmount!;
  }
  if (data.cancelRemainder) {
    transitionCrossJurisdictionRouteStatus(nextRoute, 'clear_requested', now);
    nextRoute.clearingPolicy = 'cancel_and_clear';
  }

  admission.route = nextRoute;
  if (admission.pendingFill?.ttlExpiredAt !== undefined) {
    resolveRuntimeSecurityIncident(env, {
      domain: 'cross-j',
      code: 'CROSS_J_BOOK_FILL_TTL_EXPIRED',
      source: 'local-consensus',
      severity: 'critical',
      summary: 'Book-owner fill is still waiting for its exact terminal sibling acknowledgement',
      entityId: newState.entityId,
      accountId: data.sourceEntityId,
      offerId: data.orderId,
      routeHash: route.routeHash || '',
    });
  }
  delete admission.pendingFill;
  admission.updatedAt = now;
  const mirrorRoute = newState.crossJurisdictionSwaps?.get(route.orderId);
  if (mirrorRoute) {
    // `crossJurisdictionSwaps` is a route mirror for local UI/salvage. The
    // account ACK remains canonical; this branch only keeps an existing mirror
    // coherent with the admitted book projection.
    newState.crossJurisdictionSwaps!.set(route.orderId, mergeCrossJurisdictionRoute(mirrorRoute, nextRoute));
  }

  if (admission.pendingCancel) {
    if (normalizeEntityRef(newState.entityId) !== normalizeEntityRef(nextRoute.source.counterpartyEntityId)) {
      markCrossJurisdictionBookAdmissionClosed(
        newState,
        nextRoute.source.entityId,
        nextRoute.orderId,
        now,
        admission.pendingCancel.reason || 'cancel_request_after_fill',
      );
    }
    return true;
  }

  if (nextRoute.status === 'partially_filled') {
    const offerEvent = buildCommittedCrossJurisdictionOfferEvent(newState, nextRoute);
    if (!offerEvent) throw new Error(`CROSS_J_BOOK_PROGRESS_OFFER_MISSING: order=${route.orderId}`);
    const marketOffer = buildCrossJurisdictionMarketOffer(
      normalizeSwapOfferForOrderbook(offerEvent, offerEvent.accountId || nextRoute.source.entityId),
      newState.entityId,
    );
    if (!marketOffer) throw new Error(`CROSS_J_BOOK_PROGRESS_MARKET_INVALID: order=${route.orderId}`);
    const qtyLots = crossBookQtyLots(marketOffer.baseTokenId, marketOffer.baseAmount);
    const resized = resizeCrossJurisdictionBookOrderByRouteId(
      newState,
      nextRoute.source.entityId,
      nextRoute.orderId,
      qtyLots,
      storageChanges,
    );
    if (!resized) {
      throw new Error(`CROSS_J_BOOK_PROGRESS_ORDER_MISSING: order=${route.orderId}`);
    }
    return true;
  }

  const removed = removeCrossJurisdictionBookOrderByRouteId(
    newState,
    nextRoute.source.entityId,
    nextRoute.orderId,
    storageChanges,
  );
  if (!removed && !isCrossJurisdictionTerminalStatus(nextRoute.status)) {
    throw new Error(`CROSS_J_BOOK_PROGRESS_ORDER_MISSING: order=${route.orderId}`);
  }
  return true;
};

export const handleApplyCrossJurisdictionBookProgressEntityTx = (
  env: Env,
  entityState: EntityState,
  entityTx: CrossJurisdictionBookProgressTx,
  options?: ApplyEntityTxOptions,
) => {
  const newState = stateForEntityTx(entityState, options);
  const changed = applyCrossJurisdictionBookProgressToState(
    env,
    newState,
    entityTx.data,
    options?.storageChanges,
  );
  if (changed) {
    addMessage(newState, `🌉 Cross-j book progress ${entityTx.data.orderId}${entityTx.data.reason ? `: ${entityTx.data.reason}` : ''}`);
  }
  return { newState, outputs: [] };
};

const buildCrossJurisdictionBookRemovalAckOutput = (
  env: Env,
  ownerState: EntityState,
  route: CrossJurisdictionSwapRoute,
  sourceAccountId: string,
  removedAt: number,
  reason: string,
) => {
  const sourceHubEntityId = normalizeEntityRef(route.source.counterpartyEntityId);
  if (!sourceHubEntityId || sourceHubEntityId === normalizeEntityRef(ownerState.entityId)) {
    throw new Error(`CROSS_J_BOOK_REMOVAL_ACK_TARGET_INVALID:order=${route.orderId}:target=${sourceHubEntityId}`);
  }
  const signerId = crossJurisdictionRouteSignerHint(route, sourceHubEntityId);
  if (!signerId) {
    throw new Error(
      `CROSS_J_BOOK_REMOVAL_ACK_SIGNER_MISSING:order=${route.orderId}:target=${sourceHubEntityId}`,
    );
  }
  return buildCrossJurisdictionEntityOutput(env, sourceHubEntityId, [{
    type: 'crossJurisdictionBookOrderRemoved',
    data: {
      orderId: route.orderId,
      sourceEntityId: route.source.entityId,
      sourceAccountId,
      route,
      removedAt,
      reason,
    },
  }], signerId);
};

export const handleCrossJurisdictionBookOrderRemovedEntityTx = (
  _env: Env,
  entityState: EntityState,
  entityTx: Extract<EntityTx, { type: 'crossJurisdictionBookOrderRemoved' }>,
  options?: ApplyEntityTxOptions,
) => {
  const newState = stateForEntityTx(entityState, options);
  const route = withCanonicalCrossJurisdictionRouteHash(entityTx.data.route);
  if (normalizeEntityRef(newState.entityId) !== normalizeEntityRef(route.source.counterpartyEntityId)) {
    throw new Error(
      `CROSS_J_BOOK_REMOVAL_ACK_SOURCE_HUB_REQUIRED:order=${route.orderId}:entity=${newState.entityId}`,
    );
  }
  const account = newState.accounts.get(entityTx.data.sourceAccountId);
  const offer = account?.swapOffers?.get(route.orderId);
  const currentRoute = newState.crossJurisdictionSwaps?.get(route.orderId);
  if (!account || !offer?.crossJurisdiction || !currentRoute) {
    throw new Error(
      `CROSS_J_BOOK_REMOVAL_ACK_SOURCE_STATE_MISSING:order=${route.orderId}:` +
        `account=${entityTx.data.sourceAccountId}`,
    );
  }
  markCrossJurisdictionBookRemovalCommitted(
    newState,
    route,
    entityTx.data.sourceAccountId,
    entityTx.data.removedAt,
    entityTx.data.reason || 'cancel_request',
  );
  const mempoolOps = hasQueuedCrossSwapAckForEntityState(
    newState,
    entityTx.data.sourceAccountId,
    route.orderId,
  ) ? [] : [{
    accountId: entityTx.data.sourceAccountId,
    tx: buildCrossJurisdictionCancelAck(route.orderId, currentRoute),
  }];
  addMessage(newState, `🌉 Cross-j book removal committed ${route.orderId}`);
  return { newState, outputs: [], mempoolOps };
};

export const handleRemoveCrossJurisdictionBookOrderEntityTx = (
  env: Env,
  entityState: EntityState,
  entityTx: EntityTx & { type: 'removeCrossJurisdictionBookOrder' },
  options?: ApplyEntityTxOptions,
) => {
  const newState = stateForEntityTx(entityState, options);
  const now = deterministicEntityTimestamp(newState, env);
  const route = entityTx.data.route
    ? withCanonicalCrossJurisdictionRouteHash(entityTx.data.route)
    : undefined;
  const pendingCancel = entityTx.data.sourceAccountId && route
    ? markCrossJurisdictionBookCancelPending(
        newState,
        route,
        entityTx.data.sourceAccountId,
        now,
        entityTx.data.reason || 'cancel_request',
      )
    : undefined;
  const removed = removeCrossJurisdictionBookOrderByRouteId(
    newState,
    entityTx.data.sourceEntityId,
    entityTx.data.orderId,
    options?.storageChanges ?? [],
  );
  const outputs = pendingCancel && route && entityTx.data.sourceAccountId
    ? [buildCrossJurisdictionBookRemovalAckOutput(
        env,
        newState,
        route,
        entityTx.data.sourceAccountId,
        now,
        entityTx.data.reason || 'cancel_request',
      )]
    : [];
  if (!pendingCancel?.pendingFill) {
    markCrossJurisdictionBookAdmissionClosed(
      newState,
      entityTx.data.sourceEntityId,
      entityTx.data.orderId,
      now,
      entityTx.data.reason || 'removeCrossJurisdictionBookOrder',
    );
  }
  addMessage(
    newState,
    `🌉 Cross-j book remove ${entityTx.data.orderId}${entityTx.data.reason ? `: ${entityTx.data.reason}` : ''} ` +
      `${removed ? 'removed' : 'not-present'}`,
  );
  return { newState, outputs };
};
