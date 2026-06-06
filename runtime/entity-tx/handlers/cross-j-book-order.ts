import {
  cloneCrossJurisdictionRoute,
  compareCrossJurisdictionRouteStatus,
  isCrossJurisdictionTerminalStatus,
  withCanonicalCrossJurisdictionRouteHash,
} from '../../cross-jurisdiction';
import {
  crossJurisdictionBookAdmissionKey,
  crossJurisdictionBookOwnerRef,
  getCrossJurisdictionBookAdmissionError,
  getCrossJurisdictionBookReceiptError,
  getCrossJurisdictionRouteRemainingAmounts,
  isCrossJurisdictionBookAdmissionPending,
  markCrossJurisdictionBookAdmissionClosed,
  mergeCrossJurisdictionBookAdmission,
} from '../../cross-jurisdiction-orderbook';
import type { EntityState, EntityTx, Env } from '../../types';
import { removeCrossJurisdictionBookOrderByRouteId } from '../../orderbook/cross-j';
import { cloneEntityState, addMessage } from '../../state-helpers';
import { findAccountKey } from '../account-key';
import {
  mergeCrossJurisdictionRoute,
  validateCrossJurisdictionRouteTransition,
} from '../cross-jurisdiction-helpers';
import type { SwapOfferEvent } from './account/orderbook-offers';

const deterministicEntityTimestamp = (state: EntityState, env: Env): number =>
  Number(state.timestamp || env.timestamp || 0);

const normalizeEntityRef = (value: string): string => String(value || '').toLowerCase();

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
) => {
  const newState = cloneEntityState(entityState);
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

export const handleRemoveCrossJurisdictionBookOrderEntityTx = (
  env: Env,
  entityState: EntityState,
  entityTx: EntityTx & { type: 'removeCrossJurisdictionBookOrder' },
) => {
  const newState = cloneEntityState(entityState);
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
