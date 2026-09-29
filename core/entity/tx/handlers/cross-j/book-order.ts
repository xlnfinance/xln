import { haltRuntimeFailure } from "../../../../protocol/errors/failure-taxonomy";

import { normalizeEntityRef , findAccountKey } from '../../account-key';
import { getTokenInfo } from '../../../../account/utils';
import {
  deterministicEntityTimestamp,
  getTypedCrossJurisdictionBookAdmissionFailure,
} from '../../../../orderbook/cross-j/orderbook';
import {
  CROSS_J_MAX_FILL_RATIO,
  cloneCrossJurisdictionRoute,
  compareCrossJurisdictionRouteStatus,
  applyCrossJurisdictionFillProgress,
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
  markCrossJurisdictionBookAdmissionClosed,
  mergeCrossJurisdictionBookAdmission,
} from '../../../../extensions/cross-j/orderbook';
import type { CrossJurisdictionSwapRoute } from '../../../../types/cross-jurisdiction';
import type { EntityState } from '../../../types';
import type { EntityRuntimeContext } from '../../../runtime-context';
import type { EntityTx } from '../../../../types/entity-tx';
import type { RuntimeOverlayRecord } from '../../../../types/account';
import { getEntityCollectionValueForWrite, ensureEntityCollectionCandidate } from '../../../state/persistent-collection-map';
import { crossJurisdictionExecutableQtyLots } from '../../../../orderbook';
import {
  materializeCrossJurisdictionBookRemainder,
  removeCrossJurisdictionBookOrderByRouteId,
  resizeCrossJurisdictionBookOrderByRouteId,
} from '../../../../orderbook/cross-j';
import { prepareEntityTxState } from '../../../state-clone';
import { addMessage } from '../../../frame-events';
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
import type { CrossJurisdictionFillProgressData } from '../../../../extensions/cross-j/fill-notice';
import { applyCrossJurisdictionExecutionProgress } from '../../../../extensions/cross-j/fill-notice';

const stateForEntityTx = (entityState: EntityState, options?: ApplyEntityTxOptions): EntityState =>
  prepareEntityTxState(entityState, options?.mutableFrameState);

type CrossJurisdictionBookProgressData = CrossJurisdictionFillProgressData;

const isSameCommittedBookProgress = (
  route: ReturnType<typeof withCanonicalCrossJurisdictionRouteHash>,
  data: CrossJurisdictionBookProgressData,
): boolean => (
  Math.floor(Number(route.fillSeq ?? 0)) === Math.floor(Number(data.fillSeq)) &&
  getCrossJurisdictionCommittedProofRatio(route) === Math.floor(Number(data.cumulativeFillRatio)) &&
  (route.executionSourceAmount ?? 0n) === data.cumulativeExecutionSourceAmount &&
  (route.executionTargetAmount ?? 0n) === data.cumulativeExecutionTargetAmount
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

const applyNewBookProgress = (
  route: ReturnType<typeof withCanonicalCrossJurisdictionRouteHash>,
  data: CrossJurisdictionBookProgressData,
  now: number,
): ReturnType<typeof withCanonicalCrossJurisdictionRouteHash> => {
  const ratio = Math.floor(Number(data.cumulativeFillRatio));
  const next = applyCrossJurisdictionFillProgress(route, {
    fillSeq: data.fillSeq,
    cumulativeFillRatio: ratio,
    fillNumerator: BigInt(ratio),
    fillDenominator: BigInt(CROSS_J_MAX_FILL_RATIO),
  }, now, 'CROSS_J_BOOK_PROGRESS_INVALID');
  applyCrossJurisdictionExecutionProgress(next, data);
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
    const qtyLots = crossJurisdictionExecutableQtyLots(market.baseTokenId, market.quoteTokenId, market.baseAmount, market.quoteAmount, market.priceTicks);
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
  // The matcher already consumed a fully filled row; a terminal progress only
  // has to remove whatever remainder is still resting.
  removeCrossJurisdictionBookOrderByRouteId(
    state,
    route.source.entityId,
    route.orderId,
    storageChanges,
  );
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

  newState.crossJurisdictionSwaps = ensureEntityCollectionCandidate(
    newState.crossJurisdictionSwaps,
    cloneCrossJurisdictionRoute,
  );
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

/**
 * Book-owner projection of Hub-internal fill progress. Applied in the same
 * Entity frame that matched (or cancelled) the order; never an Account tx.
 */
export const applyCrossJurisdictionBookFillToState = (
  env: EntityRuntimeContext,
  newState: EntityState,
  sourceEntityId: string,
  data: CrossJurisdictionBookProgressData,
  storageChanges: RuntimeOverlayRecord[] = [],
): boolean => {
  const now = deterministicEntityTimestamp(newState, env);
  const admissionKey = crossJurisdictionBookAdmissionKeyFor(sourceEntityId, data.orderId);
  const admissions = newState.crossJurisdictionBookAdmissions;
  const admission = admissions
    ? getEntityCollectionValueForWrite(admissions, admissionKey)
    : undefined;
  if (!admission) {
    throw haltRuntimeFailure("CROSS_J_BOOK_PROGRESS_ADMISSION_MISSING", `CROSS_J_BOOK_PROGRESS_ADMISSION_MISSING: order=${data.orderId} source=${sourceEntityId}`);
  }
  // The book owner already closed this order (terminal fill or an earlier
  // cancel); a repeated cancel request has nothing left to decide.
  if (admission.status === 'closed' && data.cancelRemainder) return false;
  if (admission.status !== 'admitted' && admission.status !== 'resolving') {
    throw haltRuntimeFailure("CROSS_J_BOOK_PROGRESS_ADMISSION_NOT_ADMITTED", `CROSS_J_BOOK_PROGRESS_ADMISSION_NOT_ADMITTED: order=${data.orderId} status=${admission.status}`);
  }

  const route = withCanonicalCrossJurisdictionRouteHash(admission.route);
  const bookOwner = crossJurisdictionBookOwnerRef(route);
  if (bookOwner !== normalizeEntityRef(newState.entityId)) {
    throw haltRuntimeFailure("CROSS_J_BOOK_PROGRESS_WRONG_OWNER", `CROSS_J_BOOK_PROGRESS_WRONG_OWNER: order=${route.orderId} owner=${bookOwner} current=${newState.entityId}`);
  }
  if (isSameCommittedBookProgress(route, data)) {
    admission.updatedAt = now;
    if (data.cancelRemainder) {
      markCrossJurisdictionBookAdmissionClosed(newState, route.source.entityId, route.orderId, now, 'cancel_request');
      // A remote book owner keeps its informational mirror coherent.
      const mirrors = newState.crossJurisdictionSwaps;
      const mirror = mirrors?.get(route.orderId);
      if (
        mirrors && mirror &&
        normalizeEntityRef(route.source.counterpartyEntityId) !== normalizeEntityRef(newState.entityId) &&
        (mirror.status === 'resting' || mirror.status === 'partially_filled')
      ) {
        mirrors.set(route.orderId, {
          ...mirror,
          status: 'clear_requested',
          clearingPolicy: 'cancel_and_clear',
          updatedAt: now,
        });
      }
    }
    return false;
  }

  const currentSeq = Math.floor(Number(route.fillSeq ?? 0));
  if (Math.floor(Number(data.fillSeq)) <= currentSeq) {
    throw haltRuntimeFailure("CROSS_J_BOOK_PROGRESS_STALE", `CROSS_J_BOOK_PROGRESS_STALE: order=${route.orderId} seq=${data.fillSeq} current=${currentSeq}`);
  }

  const nextRoute = applyNewBookProgress(route, data, now);

  admission.route = nextRoute;
  admission.updatedAt = now;
  // The source Hub owns its route mirror and applies the same progress right
  // after this (locally or from the fill notice); only a remote book owner
  // keeps its mirror coherent here for salvage/UI.
  const mirrorRoute = newState.crossJurisdictionSwaps?.get(route.orderId);
  if (mirrorRoute && normalizeEntityRef(route.source.counterpartyEntityId) !== normalizeEntityRef(newState.entityId)) {
    newState.crossJurisdictionSwaps!.set(route.orderId, mergeCrossJurisdictionRoute(mirrorRoute, nextRoute));
  }

  updateBookOrderForProgress(newState, nextRoute, storageChanges);
  if (nextRoute.status !== 'partially_filled') {
    markCrossJurisdictionBookAdmissionClosed(
      newState,
      nextRoute.source.entityId,
      nextRoute.orderId,
      now,
      data.cancelRemainder ? 'cancel_request' : 'fill_closed',
    );
  }
  return true;
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

export const handleRemoveCrossJurisdictionBookOrderEntityTx = (
  env: EntityRuntimeContext,
  entityState: EntityState,
  entityTx: EntityTx & { type: 'removeCrossJurisdictionBookOrder' },
  options?: ApplyEntityTxOptions,
) => {
  const newState = stateForEntityTx(entityState, options);
  const now = deterministicEntityTimestamp(newState, env);
  // Same fences as Rust `apply_remove_book_order`: the removal must name this
  // book's admitted route.
  if (!entityTx.data.route) {
    throw haltRuntimeFailure("CROSS_J_BOOK_REMOVAL_ROUTE_MISSING", `CROSS_J_BOOK_REMOVAL_ROUTE_MISSING:${entityTx.data.orderId}`);
  }
  const route = withCanonicalCrossJurisdictionRouteHash(entityTx.data.route);
  if (
    route.orderId !== entityTx.data.orderId ||
    normalizeEntityRef(route.source.entityId) !== normalizeEntityRef(entityTx.data.sourceEntityId) ||
    crossJurisdictionBookOwnerRef(route) !== normalizeEntityRef(newState.entityId)
  ) {
    throw haltRuntimeFailure("CROSS_J_BOOK_REMOVAL_ROUTE_MISMATCH", `CROSS_J_BOOK_REMOVAL_ROUTE_MISMATCH:${entityTx.data.orderId}`);
  }
  const admission = newState.crossJurisdictionBookAdmissions?.get(
    crossJurisdictionBookAdmissionKeyFor(entityTx.data.sourceEntityId, entityTx.data.orderId),
  );
  if (admission && normalizeEntityRef(admission.routeHash || '') !== normalizeEntityRef(route.routeHash || '')) {
    throw haltRuntimeFailure("CROSS_J_CANCEL_ADMISSION_ROUTE_MISMATCH", `CROSS_J_CANCEL_ADMISSION_ROUTE_MISMATCH:${entityTx.data.orderId}`);
  }
  const removed = removeCrossJurisdictionBookOrderByRouteId(
    newState,
    entityTx.data.sourceEntityId,
    entityTx.data.orderId,
    options?.storageChanges ?? [],
  );
  // ACK with this book's own progress: the requester's copy may be stale.
  const ackRoute = newState.crossJurisdictionSwaps?.get(entityTx.data.orderId) ?? route;
  const outputs = entityTx.data.sourceAccountId
    ? [buildCrossJurisdictionBookRemovalAckOutput(
        newState,
        ackRoute,
        entityTx.data.sourceAccountId,
        now,
        entityTx.data.reason || 'cancel_request',
      )]
    : [];
  markCrossJurisdictionBookAdmissionClosed(
    newState,
    entityTx.data.sourceEntityId,
    entityTx.data.orderId,
    now,
    entityTx.data.reason || 'removeCrossJurisdictionBookOrder',
  );
  addMessage(
    newState,
    `🌉 Cross-j book remove ${entityTx.data.orderId}${entityTx.data.reason ? `: ${entityTx.data.reason}` : ''} ` +
      `${removed ? 'removed' : 'not-present'}`,
  );
  return { newState, outputs };
};
