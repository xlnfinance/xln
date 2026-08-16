import { haltRuntimeFailure } from "../../../../protocol/errors/failure-taxonomy";

import { normalizeEntityRef } from '../../account-key';
import { getTokenInfo } from '../../../../account/utils';
import {
  deterministicEntityTimestamp,
  getTypedCrossJurisdictionBookAdmissionFailure,
} from '../../../../orderbook/cross-j/orderbook';
import {
  cloneCrossJurisdictionRoute,
  compareCrossJurisdictionRouteStatus,
  applyCrossJurisdictionFillProgress,
  assertCrossJurisdictionPriceImprovementMode,
  getCrossJurisdictionCommittedProofRatio,
  isCrossJurisdictionTerminalStatus,
  transitionCrossJurisdictionRouteStatus,
  withCanonicalCrossJurisdictionRouteHash,
} from '../../../../extensions/cross-j/index';
import {
  buildCrossJurisdictionMarketOffer,
  crossJurisdictionBookAdmissionKey,
  crossJurisdictionBookAdmissionKeyFor,
  crossJurisdictionBookOwnerRef,
  getCrossJurisdictionRouteRemainingAmounts,
  markCrossJurisdictionBookCancelPending,
  markCrossJurisdictionBookAdmissionClosed,
  markCrossJurisdictionBookRemovalCommitted,
  mergeCrossJurisdictionBookAdmission,
} from '../../../../extensions/cross-j/orderbook';
import type { CrossJurisdictionSwapRoute } from '../../../../types/cross-jurisdiction';
import type { EntityCandidateEffect, EntityState } from '../../../types';
import type { EntityRuntimeContext } from '../../../runtime-context';
import type { EntityTx } from '../../../../types/entity-tx';
import type { RuntimeOverlayRecord } from '../../../../types/account';
import { getEntityCollectionValueForWrite } from '../../../state/persistent-collection-map';
import { crossJurisdictionBookQtyLots } from '../../../../orderbook';
import {
  materializeCrossJurisdictionBookRemainder,
  removeCrossJurisdictionBookOrderByRouteId,
  resizeCrossJurisdictionBookOrderByRouteId,
} from '../../../../orderbook/cross-j';
import { prepareEntityTxState } from '../../../state-clone';
import { addMessage } from '../../../frame-events';
import { getEntityAccountForWrite } from '../../../state/persistent-account-map';
import { findAccountKey } from '../../account-key';
import {
  mergeCrossJurisdictionRoute,
  validateCrossJurisdictionRouteTransition,
} from '../../j-events-htlc/cross-jurisdiction-helpers';
import type { SwapOfferEvent } from '../account/orderbook/offers';
import { normalizeSwapOfferForOrderbook } from '../../../../orderbook/swap-execution';
import type { ApplyEntityTxOptions } from '../../apply';
import {
  buildCrossJurisdictionEntityOutput,
  crossJurisdictionRouteSignerHint,
} from '../../j-events-htlc/cross-j-outputs';
import { draftPreparedDisputeStartIfReady } from '../dispute';

const stateForEntityTx = (entityState: EntityState, options?: ApplyEntityTxOptions): EntityState =>
  prepareEntityTxState(entityState, options?.mutableFrameState);

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
  const offer = account?.state.swapOffers?.get(route.orderId);
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
      giveTokenDecimals: getTokenInfo(Number(route.source.tokenId)).decimals,
      giveAmount: remaining.sourceRemaining,
      wantTokenId: Number(route.target.tokenId),
      wantTokenDecimals: getTokenInfo(Number(route.target.tokenId)).decimals,
      wantAmount: remaining.targetRemaining,
      maxFee: 0n,
      minNetReceive: remaining.targetRemaining,
      ...(route.priceTicks !== undefined ? { priceTicks: BigInt(route.priceTicks) } : {}),
      crossJurisdiction: cloneCrossJurisdictionRoute(route),
    };
  }
  return {
    offerId: route.orderId,
    accountId,
    makerIsLeft: offer.makerIsLeft,
    fromEntity: account.state.leftEntity,
    toEntity: account.state.rightEntity,
    createdHeight: offer.createdHeight,
    giveTokenId: offer.giveTokenId,
    giveTokenDecimals: offer.giveTokenDecimals,
    giveAmount: remaining.sourceRemaining,
    wantTokenId: offer.wantTokenId,
    wantTokenDecimals: offer.wantTokenDecimals,
    wantAmount: remaining.targetRemaining,
    maxFee: 0n,
    minNetReceive: remaining.targetRemaining,
    priceTicks: offer.priceTicks,
    ...(offer.timeInForce !== undefined ? { timeInForce: offer.timeInForce } : {}),
    crossJurisdiction: cloneCrossJurisdictionRoute(route),
  };
};

type CrossJBookAdmission =
  NonNullable<EntityState['crossJurisdictionBookAdmissions']> extends Map<string, infer Admission>
    ? Admission
    : never;

const resolveExpiredBookFillIncident = (
  candidateEffects: EntityCandidateEffect[] | undefined,
  state: EntityState,
  admission: CrossJBookAdmission,
  data: CrossJurisdictionBookProgressTx['data'],
  routeHash: string,
): void => {
  if (admission.pendingFill?.ttlExpiredAt === undefined) return;
  if (!candidateEffects) {
    throw haltRuntimeFailure("CROSS_J_BOOK_FILL_RESOLVE_EFFECT_COLLECTOR_REQUIRED", 'CROSS_J_BOOK_FILL_RESOLVE_EFFECT_COLLECTOR_REQUIRED');
  }
  candidateEffects.push({
    kind: 'securityIncidentResolve',
    identity: {
      domain: 'cross-j',
      code: 'CROSS_J_BOOK_FILL_TTL_EXPIRED',
      source: 'local-consensus',
      severity: 'critical',
      summary: 'Book-owner fill is still waiting for its exact terminal sibling acknowledgement',
      entityId: state.entityId,
      accountId: data.sourceEntityId,
      offerId: data.orderId,
      routeHash,
    },
  });
};

const applyNewBookProgress = (
  route: ReturnType<typeof withCanonicalCrossJurisdictionRouteHash>,
  data: CrossJurisdictionBookProgressTx['data'],
  now: number,
): ReturnType<typeof withCanonicalCrossJurisdictionRouteHash> => {
  const next = applyCrossJurisdictionFillProgress(route, {
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
    next.priceImprovementSourceAmount =
      (next.priceImprovementSourceAmount ?? 0n) + data.priceImprovementAmount!;
  }
  if (data.cancelRemainder) {
    transitionCrossJurisdictionRouteStatus(next, 'clear_requested', now);
    next.clearingPolicy = 'cancel_and_clear';
  }
  return next;
};

const updateBookOrderForProgress = (
  state: EntityState,
  route: ReturnType<typeof withCanonicalCrossJurisdictionRouteHash>,
  storageChanges: RuntimeOverlayRecord[],
): void => {
  if (route.status === 'partially_filled') {
    const offer = buildCommittedCrossJurisdictionOfferEvent(state, route);
    if (!offer) throw haltRuntimeFailure("CROSS_J_BOOK_PROGRESS_OFFER_MISSING", `CROSS_J_BOOK_PROGRESS_OFFER_MISSING: order=${route.orderId}`);
    const market = buildCrossJurisdictionMarketOffer(
      normalizeSwapOfferForOrderbook(offer, offer.accountId || route.source.entityId),
      state.entityId,
    );
    if (!market) throw haltRuntimeFailure("CROSS_J_BOOK_PROGRESS_MARKET_INVALID", `CROSS_J_BOOK_PROGRESS_MARKET_INVALID: order=${route.orderId}`);
    const qtyLots = crossJurisdictionBookQtyLots(market.baseTokenId, market.baseAmount);
    if (resizeCrossJurisdictionBookOrderByRouteId(
      state,
      route.source.entityId,
      route.orderId,
      qtyLots,
      storageChanges,
    )) return;
    const materialized = materializeCrossJurisdictionBookRemainder(state, {
      pairId: market.pairId,
      sourceEntityId: route.source.entityId,
      orderId: route.orderId,
      ownerId: market.makerId,
      side: market.side,
      priceTicks: market.priceTicks,
      qtyLots,
    }, storageChanges);
    if (!materialized) throw haltRuntimeFailure("CROSS_J_BOOK_PROGRESS_ORDER_MISSING", `CROSS_J_BOOK_PROGRESS_ORDER_MISSING: order=${route.orderId}`);
    return;
  }
  const removed = removeCrossJurisdictionBookOrderByRouteId(
    state,
    route.source.entityId,
    route.orderId,
    storageChanges,
  );
  if (!removed && !isCrossJurisdictionTerminalStatus(route.status)) {
    throw haltRuntimeFailure("CROSS_J_BOOK_PROGRESS_ORDER_MISSING", `CROSS_J_BOOK_PROGRESS_ORDER_MISSING: order=${route.orderId}`);
  }
};

export const handleAdmitCrossJurisdictionBookOrderEntityTx = (
  env: EntityRuntimeContext,
  entityState: EntityState,
  entityTx: EntityTx & { type: 'admitCrossJurisdictionBookOrder' },
  options?: ApplyEntityTxOptions,
) => {
  const newState = stateForEntityTx(entityState, options);
  const route = withCanonicalCrossJurisdictionRouteHash(entityTx.data.route);
  const now = deterministicEntityTimestamp(newState, env);
  const bookOwner = crossJurisdictionBookOwnerRef(route);
  if (bookOwner !== normalizeEntityRef(newState.entityId)) {
    throw haltRuntimeFailure("CROSS_J_BOOK_ADMIT_WRONG_OWNER", `CROSS_J_BOOK_ADMIT_WRONG_OWNER: order=${route.orderId} owner=${bookOwner} current=${newState.entityId}`);
  }
  const admissionKey = crossJurisdictionBookAdmissionKey(route);
  const existingAdmission = newState.crossJurisdictionBookAdmissions?.get(admissionKey);
  if (existingAdmission?.status === 'closed' || existingAdmission?.status === 'resolving') {
    if ((existingAdmission.routeHash || '').toLowerCase() !== (route.routeHash || '').toLowerCase()) {
      throw haltRuntimeFailure("CROSS_J_BOOK_ADMIT_ROUTE_INVALID", `CROSS_J_BOOK_ADMIT_ROUTE_INVALID: order=${route.orderId} existing admission route hash mismatch`);
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
      throw haltRuntimeFailure("CROSS_J_BOOK_ADMIT_ROUTE_INVALID", `CROSS_J_BOOK_ADMIT_ROUTE_INVALID: order=${route.orderId} ${transitionError}`);
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

  const admissionFailure = getTypedCrossJurisdictionBookAdmissionFailure(
    newState,
    admission.route,
    now,
  );
  if (admissionFailure) {
    if (admissionFailure.kind === 'pending') {
      addMessage(newState, `🌉 Cross-j book admit ${route.orderId}: pending ${admissionFailure.message}`);
      return { newState, outputs: [], swapOffersCreated: [] };
    }
    if (admissionFailure.kind === 'risk_reject') {
      // Oversize or unpriced orders are normal Hub admission rejections, not
      // corrupt consensus inputs. Persist the exact reason and leave the
      // bilateral route available for its explicit manual cancellation path.
      markCrossJurisdictionBookAdmissionClosed(
        newState,
        admission.route.source.entityId,
        admission.route.orderId,
        now,
        admissionFailure.message,
      );
      addMessage(newState, `🌉 Cross-j book reject ${route.orderId}: ${admissionFailure.message}`);
      return { newState, outputs: [], swapOffersCreated: [] };
    }
    throw new Error(admissionFailure.message);
  }

  admission.status = 'admitted';
  admission.admittedAt ??= now;
  admission.updatedAt = now;
  addMessage(newState, `🌉 Cross-j book admit ${route.orderId}${entityTx.data.reason ? `: ${entityTx.data.reason}` : ''}`);
  return { newState, outputs: [], swapOffersCreated: [offerEvent] };
};

export const applyCrossJurisdictionBookProgressToState = (
  env: EntityRuntimeContext,
  newState: EntityState,
  data: CrossJurisdictionBookProgressTx['data'],
  storageChanges: RuntimeOverlayRecord[] = [],
  candidateEffects?: EntityCandidateEffect[],
): boolean => {
  assertCrossJurisdictionPriceImprovementMode(data.priceImprovementMode, data.orderId);
  const now = deterministicEntityTimestamp(newState, env);
  const admissionKey = crossJurisdictionBookAdmissionKeyFor(data.sourceEntityId, data.orderId);
  const admissions = newState.crossJurisdictionBookAdmissions;
  const admission = admissions
    ? getEntityCollectionValueForWrite(admissions, admissionKey)
    : undefined;
  if (!admission) {
    throw haltRuntimeFailure("CROSS_J_BOOK_PROGRESS_ADMISSION_MISSING", `CROSS_J_BOOK_PROGRESS_ADMISSION_MISSING: order=${data.orderId} source=${data.sourceEntityId}`);
  }
  const cancelPending = admission.status === 'resolving' && Boolean(admission.pendingCancel);
  if (admission.status !== 'admitted' && !cancelPending) {
    throw haltRuntimeFailure("CROSS_J_BOOK_PROGRESS_ADMISSION_NOT_ADMITTED", `CROSS_J_BOOK_PROGRESS_ADMISSION_NOT_ADMITTED: order=${data.orderId} status=${admission.status}`);
  }

  const route = withCanonicalCrossJurisdictionRouteHash(admission.route);
  const bookOwner = crossJurisdictionBookOwnerRef(route);
  if (bookOwner !== normalizeEntityRef(newState.entityId)) {
    throw haltRuntimeFailure("CROSS_J_BOOK_PROGRESS_WRONG_OWNER", `CROSS_J_BOOK_PROGRESS_WRONG_OWNER: order=${route.orderId} owner=${bookOwner} current=${newState.entityId}`);
  }
  if (isSameCommittedBookProgress(route, data)) {
    resolveExpiredBookFillIncident(candidateEffects, newState, admission, data, route.routeHash || '');
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
    throw haltRuntimeFailure("CROSS_J_BOOK_PROGRESS_STALE", `CROSS_J_BOOK_PROGRESS_STALE: order=${route.orderId} seq=${data.fillSeq} current=${currentSeq}`);
  }

  const nextRoute = applyNewBookProgress(route, data, now);

  admission.route = nextRoute;
  resolveExpiredBookFillIncident(candidateEffects, newState, admission, data, route.routeHash || '');
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

  updateBookOrderForProgress(newState, nextRoute, storageChanges);
  return true;
};

export const handleApplyCrossJurisdictionBookProgressEntityTx = (
  env: EntityRuntimeContext,
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
    options?.candidateEffects,
  );
  if (changed) {
    addMessage(newState, `🌉 Cross-j book progress ${entityTx.data.orderId}${entityTx.data.reason ? `: ${entityTx.data.reason}` : ''}`);
  }
  return { newState, outputs: [] };
};

const buildCrossJurisdictionBookRemovalAckOutput = (
  ownerState: EntityState,
  route: CrossJurisdictionSwapRoute,
  sourceAccountId: string,
  removedAt: number,
  reason: string,
) => {
  const sourceHubEntityId = normalizeEntityRef(route.source.counterpartyEntityId);
  if (!sourceHubEntityId || sourceHubEntityId === normalizeEntityRef(ownerState.entityId)) {
    throw haltRuntimeFailure("CROSS_J_BOOK_REMOVAL_ACK_TARGET_INVALID", `CROSS_J_BOOK_REMOVAL_ACK_TARGET_INVALID:order=${route.orderId}:target=${sourceHubEntityId}`);
  }
  const signerId = crossJurisdictionRouteSignerHint(route, sourceHubEntityId);
  if (!signerId) {
    throw haltRuntimeFailure("CROSS_J_BOOK_REMOVAL_ACK_SIGNER_MISSING", `CROSS_J_BOOK_REMOVAL_ACK_SIGNER_MISSING:order=${route.orderId}:target=${sourceHubEntityId}`);
  }
  return buildCrossJurisdictionEntityOutput(sourceHubEntityId, signerId, [{
    type: 'crossJurisdictionBookOrderRemoved',
    data: {
      orderId: route.orderId,
      sourceEntityId: route.source.entityId,
      sourceAccountId,
      route,
      removedAt,
      reason,
    },
  }]);
};

export const handleCrossJurisdictionBookOrderRemovedEntityTx = async (
  env: EntityRuntimeContext,
  entityState: EntityState,
  entityTx: Extract<EntityTx, { type: 'crossJurisdictionBookOrderRemoved' }>,
  options?: ApplyEntityTxOptions,
) => {
  const newState = stateForEntityTx(entityState, options);
  const route = withCanonicalCrossJurisdictionRouteHash(entityTx.data.route);
  if (normalizeEntityRef(newState.entityId) !== normalizeEntityRef(route.source.counterpartyEntityId)) {
    throw haltRuntimeFailure("CROSS_J_BOOK_REMOVAL_ACK_SOURCE_HUB_REQUIRED", `CROSS_J_BOOK_REMOVAL_ACK_SOURCE_HUB_REQUIRED:order=${route.orderId}:entity=${newState.entityId}`);
  }
  const visible = newState.accounts.get(entityTx.data.sourceAccountId);
  const offer = visible?.state.swapOffers?.get(route.orderId);
  const currentRoute = newState.crossJurisdictionSwaps?.get(route.orderId);
  if (!visible || !offer?.crossJurisdiction || !currentRoute) {
    throw haltRuntimeFailure("CROSS_J_BOOK_REMOVAL_ACK_SOURCE_STATE_MISSING", `CROSS_J_BOOK_REMOVAL_ACK_SOURCE_STATE_MISSING:order=${route.orderId}:` +
        `account=${entityTx.data.sourceAccountId}`);
  }
  markCrossJurisdictionBookRemovalCommitted(
    newState,
    route,
    entityTx.data.sourceAccountId,
    entityTx.data.removedAt,
    entityTx.data.reason || 'cancel_request',
  );
  const pendingDisputeRemovals = visible.disputePrepare?.pendingOrderbookRemovalIds;
  if ((visible.status ?? 'active') === 'dispute_preparing' && pendingDisputeRemovals?.includes(route.orderId)) {
    const account = getEntityAccountForWrite(newState.accounts, entityTx.data.sourceAccountId);
    if (!account?.disputePrepare) throw new Error(`CROSS_J_BOOK_REMOVAL_WRITE_ACCOUNT_MISSING:${entityTx.data.sourceAccountId}`);
    account.disputePrepare!.pendingOrderbookRemovalIds = pendingDisputeRemovals.filter(
      (orderId) => orderId !== route.orderId,
    );
    if (account.disputePrepare!.pendingOrderbookRemovalIds.length === 0) {
      delete account.disputePrepare!.pendingOrderbookRemovalIds;
    }
    addMessage(newState, `🌉 Cross-j dispute book removal confirmed ${route.orderId}`);
    const drafted = await draftPreparedDisputeStartIfReady(
      newState,
      entityTx.data.sourceAccountId,
      env,
      options?.storageChanges,
      true,
    );
    return { newState: drafted.newState, outputs: drafted.outputs, accountTxs: [] };
  }
  addMessage(newState, `🌉 Cross-j book removal committed ${route.orderId}`);
  return { newState, outputs: [], accountTxs: [] };
};

export const handleRemoveCrossJurisdictionBookOrderEntityTx = (
  env: EntityRuntimeContext,
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
