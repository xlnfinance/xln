import {
  cloneCrossJurisdictionRoute,
  compareCrossJurisdictionRouteStatus,
  applyCrossJurisdictionFillProgress,
  isCrossJurisdictionTerminalStatus,
  transitionCrossJurisdictionRouteStatus,
  withCanonicalCrossJurisdictionRouteHash,
} from '../../cross-jurisdiction';
import {
  buildCrossJurisdictionMarketOffer,
  crossJurisdictionBookAdmissionKey,
  crossJurisdictionBookAdmissionKeyFor,
  crossJurisdictionBookOwnerRef,
  getCrossJurisdictionBookAdmissionError,
  getCrossJurisdictionBookReceiptError,
  getCrossJurisdictionRouteRemainingAmounts,
  isCrossJurisdictionBookAdmissionPending,
  markCrossJurisdictionBookAdmissionClosed,
  mergeCrossJurisdictionBookAdmission,
} from '../../cross-jurisdiction-orderbook';
import type { EntityState, EntityTx, Env } from '../../types';
import { SWAP_LOT_SCALE } from '../../orderbook';
import {
  removeCrossJurisdictionBookOrderByRouteId,
  resizeCrossJurisdictionBookOrderByRouteId,
} from '../../orderbook/cross-j';
import { cloneEntityState, addMessage } from '../../state-helpers';
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

const deterministicEntityTimestamp = (state: EntityState, env: Env): number =>
  Number(state.timestamp || env.timestamp || 0);
const stateForEntityTx = (entityState: EntityState, options?: ApplyEntityTxOptions): EntityState =>
  options?.mutableFrameState ? entityState : cloneEntityState(entityState);

const normalizeEntityRef = (value: string): string => String(value || '').toLowerCase();
const crossBookQtyLots = (baseAmount: bigint): bigint =>
  baseAmount <= 0n ? 0n : (baseAmount + SWAP_LOT_SCALE - 1n) / SWAP_LOT_SCALE;

type CrossJurisdictionBookProgressTx = Extract<EntityTx, { type: 'applyCrossJurisdictionBookProgress' }>;

const isSameCommittedBookProgress = (
  route: ReturnType<typeof withCanonicalCrossJurisdictionRouteHash>,
  data: CrossJurisdictionBookProgressTx['data'],
): boolean => (
  Math.floor(Number(route.fillSeq ?? 0)) === Math.floor(Number(data.fillSeq)) &&
  Math.floor(Number(route.cumulativeFillRatio ?? 0)) === Math.floor(Number(data.cumulativeFillRatio)) &&
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
  if (!entityTx.data.receipt) {
    throw new Error(`CROSS_J_BOOK_ADMIT_RECEIPT_MISSING: order=${route.orderId}`);
  }
  const receiptError = getCrossJurisdictionBookReceiptError(route, entityTx.data.receipt);
  if (receiptError) throw new Error(receiptError);

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

  const admission = mergeCrossJurisdictionBookAdmission(newState, route, now, entityTx.data.receipt);

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
): boolean => {
  const now = deterministicEntityTimestamp(newState, env);
  const admissionKey = crossJurisdictionBookAdmissionKeyFor(data.sourceEntityId, data.orderId);
  const admission = newState.crossJurisdictionBookAdmissions?.get(admissionKey);
  if (!admission) {
    throw new Error(`CROSS_J_BOOK_PROGRESS_ADMISSION_MISSING: order=${data.orderId} source=${data.sourceEntityId}`);
  }
  if (admission.status !== 'admitted') {
    throw new Error(`CROSS_J_BOOK_PROGRESS_ADMISSION_NOT_ADMITTED: order=${data.orderId} status=${admission.status}`);
  }

  const route = withCanonicalCrossJurisdictionRouteHash(admission.route);
  const bookOwner = crossJurisdictionBookOwnerRef(route);
  if (bookOwner !== normalizeEntityRef(newState.entityId)) {
    throw new Error(`CROSS_J_BOOK_PROGRESS_WRONG_OWNER: order=${route.orderId} owner=${bookOwner} current=${newState.entityId}`);
  }
  if (isSameCommittedBookProgress(route, data)) {
    delete admission.pendingFill;
    admission.updatedAt = now;
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
    if (data.priceImprovementMode === 'source_savings') {
      nextRoute.priceImprovementSourceAmount =
        (nextRoute.priceImprovementSourceAmount ?? 0n) + data.priceImprovementAmount!;
    } else if (data.priceImprovementMode === 'target_bonus') {
      nextRoute.priceImprovementTargetAmount =
        (nextRoute.priceImprovementTargetAmount ?? 0n) + data.priceImprovementAmount!;
    }
  }
  if (data.cancelRemainder) {
    transitionCrossJurisdictionRouteStatus(nextRoute, 'clear_requested', now);
    nextRoute.clearingPolicy = 'cancel_and_clear';
  }

  admission.route = nextRoute;
  delete admission.pendingFill;
  admission.updatedAt = now;
  const mirrorRoute = newState.crossJurisdictionSwaps?.get(route.orderId);
  if (mirrorRoute) {
    // `crossJurisdictionSwaps` is a route mirror for local UI/salvage. The
    // account ACK remains canonical; this branch only keeps an existing mirror
    // coherent with the admitted book projection.
    newState.crossJurisdictionSwaps!.set(route.orderId, mergeCrossJurisdictionRoute(mirrorRoute, nextRoute));
  }

  if (nextRoute.status === 'partially_filled') {
    const offerEvent = buildCommittedCrossJurisdictionOfferEvent(newState, nextRoute);
    if (!offerEvent) throw new Error(`CROSS_J_BOOK_PROGRESS_OFFER_MISSING: order=${route.orderId}`);
    const marketOffer = buildCrossJurisdictionMarketOffer(
      normalizeSwapOfferForOrderbook(offerEvent, offerEvent.accountId || nextRoute.source.entityId),
      newState.entityId,
    );
    if (!marketOffer) throw new Error(`CROSS_J_BOOK_PROGRESS_MARKET_INVALID: order=${route.orderId}`);
    const qtyLots = crossBookQtyLots(marketOffer.baseAmount);
    const resized = resizeCrossJurisdictionBookOrderByRouteId(
      env,
      newState,
      nextRoute.source.entityId,
      nextRoute.orderId,
      qtyLots,
    );
    if (!resized) {
      throw new Error(`CROSS_J_BOOK_PROGRESS_ORDER_MISSING: order=${route.orderId}`);
    }
    return true;
  }

  const removed = removeCrossJurisdictionBookOrderByRouteId(env, newState, nextRoute.source.entityId, nextRoute.orderId);
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
  const changed = applyCrossJurisdictionBookProgressToState(env, newState, entityTx.data);
  if (changed) {
    addMessage(newState, `🌉 Cross-j book progress ${entityTx.data.orderId}${entityTx.data.reason ? `: ${entityTx.data.reason}` : ''}`);
  }
  return { newState, outputs: [] };
};

export const handleRemoveCrossJurisdictionBookOrderEntityTx = (
  env: Env,
  entityState: EntityState,
  entityTx: EntityTx & { type: 'removeCrossJurisdictionBookOrder' },
  options?: ApplyEntityTxOptions,
) => {
  const newState = stateForEntityTx(entityState, options);
  const now = deterministicEntityTimestamp(newState, env);
  const removed = removeCrossJurisdictionBookOrderByRouteId(
    env,
    newState,
    entityTx.data.sourceEntityId,
    entityTx.data.orderId,
  );
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
  return { newState, outputs: [] };
};
