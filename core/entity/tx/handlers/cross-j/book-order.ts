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
import type { EntityInput, EntityState } from '../../../types';
import type { EntityRuntimeContext } from '../../../runtime-context';
import type { EntityTx } from '../../../../types/entity-tx';
import type { RuntimeOverlayRecord } from '../../../../types/account';
import { getEntityCollectionValueForWrite, ensureEntityCollectionCandidate } from '../../../state/persistent-collection-map';
import { crossJurisdictionBookQtyLots } from '../../../../orderbook';
import {
  materializeCrossJurisdictionBookRemainder,
  removeCrossJurisdictionBookOrderByRouteId,
  resizeCrossJurisdictionBookOrderByRouteId,
} from '../../../../orderbook/cross-j';
import { prepareEntityTxState } from '../../../state-clone';
import { addMessage } from '../../../frame-events';
import { getEntityAccountForWrite } from '../../../state/persistent-account-map';
import { applyEntityAccountEnvelopeUpdate } from '../../../account-envelope-update';
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
import type { CrossJurisdictionFillProgressData } from '../../../../extensions/cross-j/fill-notice';

const stateForEntityTx = (entityState: EntityState, options?: ApplyEntityTxOptions): EntityState =>
  prepareEntityTxState(entityState, options?.mutableFrameState);

type CrossJurisdictionBookProgressData = CrossJurisdictionFillProgressData;

const isSameCommittedBookProgress = (
  route: ReturnType<typeof withCanonicalCrossJurisdictionRouteHash>,
  data: CrossJurisdictionBookProgressData,
): boolean => (
  Math.floor(Number(route.fillSeq ?? 0)) === Math.floor(Number(data.fillSeq)) &&
  getCrossJurisdictionCommittedProofRatio(route) === Math.floor(Number(data.cumulativeFillRatio))
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
  if (!currentRoute) {
    throw haltRuntimeFailure("CROSS_J_BOOK_REMOVAL_ACK_SOURCE_STATE_MISSING", `CROSS_J_BOOK_REMOVAL_ACK_SOURCE_STATE_MISSING:order=${route.orderId}:` +
        `account=${entityTx.data.sourceAccountId}`);
  }
  if (normalizeEntityRef(currentRoute.routeHash || '') !== normalizeEntityRef(route.routeHash || '')) {
    throw haltRuntimeFailure("CROSS_J_BOOK_REMOVAL_ACK_ROUTE_HASH_MISMATCH", `CROSS_J_BOOK_REMOVAL_ACK_ROUTE_HASH_MISMATCH:order=${route.orderId}`);
  }
  // An exact ACK may arrive after the atomic close/finality retired the source
  // offer. The terminal route is the durable proof that no removal remains to
  // confirm; re-emitting clear would resurrect work. A different route hash is
  // rejected above so an adversary cannot hide a conflicting ACK behind this
  // idempotent fence.
  if (isCrossJurisdictionTerminalStatus(currentRoute.status)) {
    return { newState, outputs: [], accountTxs: [] };
  }
  if (!visible || !offer?.crossJurisdiction) {
    throw haltRuntimeFailure("CROSS_J_BOOK_REMOVAL_ACK_SOURCE_STATE_MISSING", `CROSS_J_BOOK_REMOVAL_ACK_SOURCE_STATE_MISSING:order=${route.orderId}:` +
        `account=${entityTx.data.sourceAccountId}`);
  }
  markCrossJurisdictionBookAdmissionClosed(
    newState,
    route.source.entityId,
    route.orderId,
    entityTx.data.removedAt,
    entityTx.data.reason || 'cancel_request',
  );
  const pendingDisputeRemovals = visible.disputePrepare?.pendingOrderbookRemovalIds;
  if ((visible.status ?? 'active') === 'dispute_preparing' && pendingDisputeRemovals?.includes(route.orderId)) {
    const account = getEntityAccountForWrite(newState.accounts, entityTx.data.sourceAccountId);
    if (!account?.disputePrepare) throw new Error(`CROSS_J_BOOK_REMOVAL_WRITE_ACCOUNT_MISSING:${entityTx.data.sourceAccountId}`);
    applyEntityAccountEnvelopeUpdate(env, entityTx.data.sourceAccountId, account, {
      type: 'confirmDisputeBookRemoval',
      orderId: route.orderId,
    });
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
  // The remote book owner removed the row; the source Hub now clears the pull
  // pair at the committed progress (pure cancel or partial reveal).
  const signerId = String(newState.config.validators[0] || '').trim().toLowerCase();
  if (!signerId) throw haltRuntimeFailure("CROSS_J_SELF_SIGNER_MISSING", `CROSS_J_SELF_SIGNER_MISSING:${route.orderId}:${newState.entityId}`);
  addMessage(newState, `🌉 Cross-j book removal committed ${route.orderId}`);
  const clearOutputs: EntityInput[] = [{
    entityId: newState.entityId,
    signerId,
    entityTxs: [{
      type: 'requestCrossJurisdictionClear',
      data: { orderId: route.orderId, cancelRemainder: true },
    }],
  }];
  return { newState, outputs: clearOutputs, accountTxs: [] };
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
  const removed = removeCrossJurisdictionBookOrderByRouteId(
    newState,
    entityTx.data.sourceEntityId,
    entityTx.data.orderId,
    options?.storageChanges ?? [],
  );
  const outputs = route && entityTx.data.sourceAccountId
    ? [buildCrossJurisdictionBookRemovalAckOutput(
        newState,
        route,
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
