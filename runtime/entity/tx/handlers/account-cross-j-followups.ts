import type {
  AccountTx,
  CrossJurisdictionSwapRoute,
  EntityCandidateEffect,
  EntityInput,
  EntityState,
  EntityTx,
  RuntimeState,
  RuntimeOverlayRecord,
} from '../../../types';
import {
  buildCrossJurisdictionCloseProof,
  cloneCrossJurisdictionRoute,
  CROSS_J_MAX_FILL_RATIO,
  applyCrossJurisdictionFillProgress,
  assertCrossJurisdictionPriceImprovementMode,
  getCrossJurisdictionCommittedProofRatio,
  getCrossJurisdictionCommittedFillAmounts,
  hashCrossJurisdictionCloseBinary,
  isCrossJurisdictionTerminalStatus,
  transitionCrossJurisdictionRouteStatus,
  withCrossJurisdictionCloseProofProgress,
  withCrossJurisdictionClaimProgress,
} from '../../../extensions/cross-j/index';
import { deriveCanonicalCrossJurisdictionBookOwner } from '../../../extensions/cross-j/market';
import {
  crossJurisdictionBookAdmissionKeyFor,
  markCrossJurisdictionBookAdmissionClosed,
} from '../../../extensions/cross-j/orderbook';
import { decodeHashLadderBinary } from '../../../protocol/htlc/hash-ladder';
import { createStructuredLogger, shortId, shortOrder } from '../../../infra/logger';
import { removeCrossJurisdictionBookOrder } from '../../../orderbook/cross-j';
import { addMessage } from '../../frame-events';
import {
  buildCrossJurisdictionEntityOutput,
  crossJurisdictionRouteSignerHint,
} from '../cross-j-outputs';
import { applyCrossJurisdictionBookProgressToState } from './cross-j-book-order';
import { handleAdmitCrossJurisdictionBookOrderEntityTx } from './cross-j-book-order';
import type { SwapOfferEvent } from './account';

const crossJFollowupLog = createStructuredLogger('crossj.followup');

const normalizeEntityRef = (value: string): string => String(value || '').toLowerCase();

const committedCrossJurisdictionRatio = (route: CrossJurisdictionSwapRoute): number =>
  getCrossJurisdictionCommittedProofRatio(route);

const assertSettledPullReplay = (
  route: CrossJurisdictionSwapRoute,
  fillRatio: number,
  binary: string,
  suppliedProof?: Extract<AccountTx, { type: 'cross_pull_close' }>['data']['proof'],
): boolean => {
  if (route.status !== 'settled') return false;
  const proof = route.sourceCloseProof;
  const committed = getCrossJurisdictionCommittedFillAmounts(route);
  const binaryHash = hashCrossJurisdictionCloseBinary(binary);
  if (
    !proof ||
    fillRatio !== committed.fillRatio ||
    proof.fillRatio !== committed.fillRatio ||
    normalizeEntityRef(proof.binaryHash) !== normalizeEntityRef(binaryHash) ||
    proof.cumulativeSourceAmount !== committed.filledSourceAmount ||
    proof.cumulativeTargetAmount !== committed.filledTargetAmount
  ) {
    throw new Error(`CROSS_J_SETTLED_PULL_REPLAY_MISMATCH: route=${route.orderId} ratio=${fillRatio}`);
  }
  if (
    suppliedProof &&
    (
      suppliedProof.orderId !== proof.orderId ||
      normalizeEntityRef(suppliedProof.routeHash) !== normalizeEntityRef(proof.routeHash) ||
      suppliedProof.fillRatio !== proof.fillRatio ||
      suppliedProof.cumulativeSourceAmount !== proof.cumulativeSourceAmount ||
      suppliedProof.cumulativeTargetAmount !== proof.cumulativeTargetAmount ||
      normalizeEntityRef(suppliedProof.binaryHash) !== normalizeEntityRef(proof.binaryHash)
    )
  ) {
    throw new Error(`CROSS_J_SETTLED_PULL_PROOF_REPLAY_MISMATCH: route=${route.orderId}`);
  }
  return true;
};

const assertPullResolveAllowed = (
  route: CrossJurisdictionSwapRoute,
  fillRatio: number,
  leg: 'source' | 'target_user' | 'target_hub',
): void => {
  if (fillRatio <= 0) return;
  if (isCrossJurisdictionTerminalStatus(route.status)) {
    throw new Error(`CROSS_J_PULL_RESOLVE_STATE_INVALID: route=${route.orderId} status=${route.status}`);
  }
  if (leg === 'source' && route.status !== 'clearing' && route.status !== 'clear_requested') {
    throw new Error(`CROSS_J_PULL_RESOLVE_STATE_INVALID: route=${route.orderId} leg=source status=${route.status}`);
  }
  if (leg === 'target_user' && route.status !== 'clearing' && route.status !== 'source_claimed') {
    throw new Error(`CROSS_J_PULL_RESOLVE_STATE_INVALID: route=${route.orderId} leg=target status=${route.status}`);
  }
  if (
    leg === 'target_hub' &&
    route.status !== 'resting' &&
    route.status !== 'partially_filled' &&
    route.status !== 'clear_requested' &&
    route.status !== 'clearing' &&
    route.status !== 'source_claimed'
  ) {
    throw new Error(`CROSS_J_PULL_RESOLVE_STATE_INVALID: route=${route.orderId} leg=target_hub status=${route.status}`);
  }
  const committedRatio = committedCrossJurisdictionRatio(route);
  if (committedRatio > 0 && fillRatio > committedRatio) {
    throw new Error(
      `CROSS_J_PULL_RESOLVE_OVER_COMMITTED: route=${route.orderId} ` +
      `ratio=${fillRatio} committed=${committedRatio}`,
    );
  }
};

const backfillCommittedFillFromResolvedPull = (
  route: CrossJurisdictionSwapRoute,
  fillRatio: number,
  updatedAt: number,
): void => {
  if (committedCrossJurisdictionRatio(route) > 0) return;
  // Network delivery may commit the bilateral pull_resolve before the route's
  // cross_swap_fill_ack mirror reaches this runtime. The pull_resolve is itself
  // a committed account frame carrying a valid hash-ladder reveal, so we can
  // backfill the committed fill fields while preserving the current lifecycle
  // status chosen by the route FSM.
  const { status: _status, ...fillFields } = applyCrossJurisdictionFillProgress(
    route,
    { cumulativeFillRatio: fillRatio },
    updatedAt,
    'CROSS_J_PULL_RESOLVE_NO_COMMITTED_FILL',
  );
  Object.assign(route, fillFields);
};

const settleTargetLegAndNotifySourceSibling = (
  env: RuntimeState,
  newState: EntityState,
  route: CrossJurisdictionSwapRoute,
  fillRatio: number,
  binary: string,
  closeProof: ReturnType<typeof buildCrossJurisdictionCloseProof> | undefined,
  outputs: EntityInput[],
  currentEntityId: string,
): void => {
  const targetUserId = normalizeEntityRef(route.target.counterpartyEntityId);
  const targetHubId = normalizeEntityRef(route.target.entityId);
  const sourceSiblingId = currentEntityId === targetUserId
    ? route.source.entityId
    : currentEntityId === targetHubId
      ? route.source.counterpartyEntityId
      : null;
  if (!sourceSiblingId) {
    throw new Error(`CROSS_J_TARGET_SETTLE_PARTICIPANT_INVALID: route=${route.orderId} entity=${newState.entityId}`);
  }
  if (!route.routeHash) {
    throw new Error(`CROSS_J_TARGET_SETTLE_ROUTE_HASH_MISSING: route=${route.orderId}`);
  }

  const committed = getCrossJurisdictionCommittedFillAmounts(route);
  if (committed.fillRatio !== fillRatio) {
    throw new Error(
      `CROSS_J_TARGET_SETTLE_RATIO_MISMATCH: route=${route.orderId} ` +
        `resolved=${fillRatio} committed=${committed.fillRatio}`,
    );
  }
  const proof = closeProof ?? buildCrossJurisdictionCloseProof(route, binary);
  outputs.push(buildCrossJurisdictionEntityOutput(
    env,
    sourceSiblingId,
    [{
      type: 'crossJurisdictionSettled',
      data: {
        orderId: route.orderId,
        routeHash: route.routeHash,
        binary,
        proof,
      },
    }],
    requireRouteSignerHint(route, sourceSiblingId),
  ));
  crossJFollowupLog.debug('pull.target_settled.notify_source', {
    route: shortOrder(route.orderId, 12),
    source: shortId(sourceSiblingId),
    ratio: fillRatio,
  });
};

const transitionTargetLegSettled = (
  route: CrossJurisdictionSwapRoute,
  updatedAt: number,
): void => {
  if (
    route.status !== 'clearing' &&
    route.status !== 'source_claimed' &&
    route.status !== 'target_claimed'
  ) {
    // The Hub-authored atomic Account close is the authoritative transition.
    // Either bilateral participant may still have a resting route projection
    // when that same frame commits, so materialize clearing before settlement.
    transitionCrossJurisdictionRouteStatus(route, 'clearing', updatedAt);
  }
  transitionCrossJurisdictionRouteStatus(route, 'settled', updatedAt);
  route.settledAt = updatedAt;
};

const routeBookOwnerEntityId = (route: CrossJurisdictionSwapRoute): string =>
  normalizeEntityRef(route.bookOwnerEntityId || deriveCanonicalCrossJurisdictionBookOwner(route));

const resolveLocalBookOwner = (
  newState: EntityState,
  route: CrossJurisdictionSwapRoute,
): { ownerId: string; isCurrent: boolean } => {
  const ownerId = routeBookOwnerEntityId(route);
  const currentId = normalizeEntityRef(newState.entityId);
  if (!ownerId || ownerId === currentId) {
    return { ownerId: newState.entityId, isCurrent: true };
  }
  return { ownerId, isCurrent: false };
};

const requireRouteSignerHint = (
  route: CrossJurisdictionSwapRoute,
  entityId: string,
): string => {
  const signerId = crossJurisdictionRouteSignerHint(route, entityId);
  if (!signerId) throw new Error(`CROSS_J_ROUTE_SIGNER_MISSING:${route.orderId}:${entityId}`);
  return signerId;
};

const removeOrRouteCrossJurisdictionBookOrder = (
  env: RuntimeState,
  newState: EntityState,
  route: CrossJurisdictionSwapRoute,
  outputs: EntityInput[],
  reason: string,
  storageChanges: RuntimeOverlayRecord[],
): void => {
  const owner = resolveLocalBookOwner(newState, route);
  if (owner.isCurrent) {
    removeCrossJurisdictionBookOrder(newState, route, storageChanges);
    markCrossJurisdictionBookAdmissionClosed(
      newState,
      route.source.entityId,
      route.orderId,
      Number(newState.timestamp || env.timestamp || 0),
      reason,
    );
    return;
  }

  outputs.push(buildCrossJurisdictionEntityOutput(env, owner.ownerId, [{
      type: 'removeCrossJurisdictionBookOrder',
      data: {
        orderId: route.orderId,
        sourceEntityId: route.source.entityId,
        route,
        reason,
      },
  }], requireRouteSignerHint(route, owner.ownerId)));
};

const requireCrossFillAckNumber = (
  accountTx: Extract<AccountTx, { type: 'cross_swap_fill_ack' }>,
  field: 'fillSeq' | 'cumulativeFillRatio',
): number => {
  const value = accountTx.data[field];
  if (!Number.isFinite(Number(value))) {
    throw new Error(`CROSS_J_FILL_ACK_FIELD_MISSING: offer=${accountTx.data.offerId} field=${field}`);
  }
  return Math.floor(Number(value));
};

const requireCrossFillAckBigInt = (
  accountTx: Extract<AccountTx, { type: 'cross_swap_fill_ack' }>,
  field:
    | 'incrementalSourceAmount'
    | 'incrementalTargetAmount'
    | 'cumulativeSourceAmount'
    | 'cumulativeTargetAmount',
): bigint => {
  const value = accountTx.data[field];
  if (value === undefined) {
    throw new Error(`CROSS_J_FILL_ACK_FIELD_MISSING: offer=${accountTx.data.offerId} field=${field}`);
  }
  return BigInt(value);
};

const buildCrossJurisdictionBookProgressTx = (
  route: CrossJurisdictionSwapRoute,
  accountTx: Extract<AccountTx, { type: 'cross_swap_fill_ack' }>,
  reason: string,
): Extract<EntityTx, { type: 'applyCrossJurisdictionBookProgress' }> => ({
  type: 'applyCrossJurisdictionBookProgress',
  data: {
    orderId: route.orderId,
    sourceEntityId: route.source.entityId,
    fillSeq: requireCrossFillAckNumber(accountTx, 'fillSeq'),
    incrementalSourceAmount: requireCrossFillAckBigInt(accountTx, 'incrementalSourceAmount'),
    incrementalTargetAmount: requireCrossFillAckBigInt(accountTx, 'incrementalTargetAmount'),
    cumulativeSourceAmount: requireCrossFillAckBigInt(accountTx, 'cumulativeSourceAmount'),
    cumulativeTargetAmount: requireCrossFillAckBigInt(accountTx, 'cumulativeTargetAmount'),
    cumulativeFillRatio: requireCrossFillAckNumber(accountTx, 'cumulativeFillRatio'),
    ...(accountTx.data.fillNumerator !== undefined ? { fillNumerator: accountTx.data.fillNumerator } : {}),
    ...(accountTx.data.fillDenominator !== undefined ? { fillDenominator: accountTx.data.fillDenominator } : {}),
    ...(accountTx.data.priceImprovementMode ? { priceImprovementMode: accountTx.data.priceImprovementMode } : {}),
    ...(accountTx.data.priceImprovementAmount !== undefined ? { priceImprovementAmount: accountTx.data.priceImprovementAmount } : {}),
    ...(accountTx.data.priceImprovementTokenId !== undefined ? { priceImprovementTokenId: accountTx.data.priceImprovementTokenId } : {}),
    ...(accountTx.data.cancelRemainder !== undefined ? { cancelRemainder: accountTx.data.cancelRemainder } : {}),
    reason,
  },
});

const applyOrRouteCrossJurisdictionBookProgress = (
  env: RuntimeState,
  newState: EntityState,
  route: CrossJurisdictionSwapRoute,
  accountTx: Extract<AccountTx, { type: 'cross_swap_fill_ack' }>,
  outputs: EntityInput[],
  storageChanges: RuntimeOverlayRecord[],
  candidateEffects: EntityCandidateEffect[],
): void => {
  const tx = buildCrossJurisdictionBookProgressTx(route, accountTx, 'fill_ack_committed');
  const owner = resolveLocalBookOwner(newState, route);
  if (owner.isCurrent) {
    // Source account consensus has committed the ACK in this same entity frame.
    // Apply the book-owner projection immediately; waiting for a self-output
    // would leave one matcher tick with updated account state and stale book qty.
    applyCrossJurisdictionBookProgressToState(
      env,
      newState,
      tx.data,
      storageChanges,
      candidateEffects,
    );
    return;
  }
  outputs.push(buildCrossJurisdictionEntityOutput(
    env,
    owner.ownerId,
    [tx],
    requireRouteSignerHint(route, owner.ownerId),
  ));
};

const committedPullMatchesRoute = (
  accountTx: Extract<AccountTx, { type: 'pull_lock' }>,
  route: CrossJurisdictionSwapRoute,
  leg: 'source' | 'target',
): boolean => {
  const pull = leg === 'source' ? route.sourcePull : route.targetPull;
  if (!pull) return false;
  const binding = accountTx.data.crossJurisdiction;
  if (
    !binding ||
    binding.leg !== leg ||
    binding.orderId !== route.orderId ||
    (binding.routeHash || '').toLowerCase() !== (route.routeHash || '').toLowerCase()
  ) {
    return false;
  }
  return (
    accountTx.data.pullId === pull.pullId &&
    accountTx.data.tokenId === pull.tokenId &&
    accountTx.data.amount === pull.signedAmount &&
    (accountTx.data.fullHash || '').toLowerCase() === pull.fullHash.toLowerCase() &&
    (accountTx.data.partialRoot || '').toLowerCase() === pull.partialRoot.toLowerCase() &&
    accountTx.data.revealedUntilTimestamp === pull.revealedUntilTimestamp
  );
};

const getCommittedPullRole = (
  route: CrossJurisdictionSwapRoute,
  currentEntityId: string,
  counterpartyEntityId: string,
  pullId: string,
): Readonly<{ leg: 'source' | 'target'; sourceHubCommitted: boolean }> | null => {
  const sourceHubId = normalizeEntityRef(route.source.counterpartyEntityId);
  const sourceUserId = normalizeEntityRef(route.source.entityId);
  const targetHubId = normalizeEntityRef(route.target.entityId);
  const targetUserId = normalizeEntityRef(route.target.counterpartyEntityId);
  const sourcePull = route.sourcePull?.pullId === pullId;
  const targetPull = route.targetPull?.pullId === pullId;
  const sourceHubCommitted =
    sourcePull && currentEntityId === sourceHubId && counterpartyEntityId === sourceUserId;
  if (sourceHubCommitted) return { leg: 'source', sourceHubCommitted: true };
  if (sourcePull && currentEntityId === sourceUserId && counterpartyEntityId === sourceHubId) {
    return { leg: 'source', sourceHubCommitted: false };
  }
  if (targetPull && currentEntityId === targetHubId && counterpartyEntityId === targetUserId) {
    return { leg: 'target', sourceHubCommitted: false };
  }
  if (targetPull && currentEntityId === targetUserId && counterpartyEntityId === targetHubId) {
    return { leg: 'target', sourceHubCommitted: false };
  }
  return null;
};

const admitCommittedSourcePullToBook = (
  env: RuntimeState,
  state: EntityState,
  route: CrossJurisdictionSwapRoute,
  outputs: EntityInput[],
  swapOffersCreated: SwapOfferEvent[],
  storageChanges: RuntimeOverlayRecord[],
): void => {
  addMessage(state, `🌉 Cross-j swap ${route.orderId} committed by both Account legs`);
  const ownerId = routeBookOwnerEntityId(route);
  const admissionTx: Extract<EntityTx, { type: 'admitCrossJurisdictionBookOrder' }> = {
    type: 'admitCrossJurisdictionBookOrder',
    data: {
      route: cloneCrossJurisdictionRoute(route),
      reason: 'atomic_account_pair_committed',
    },
  };
  if (ownerId === normalizeEntityRef(state.entityId)) {
    const local = handleAdmitCrossJurisdictionBookOrderEntityTx(
      env,
      state,
      admissionTx,
      { mutableFrameState: true, storageChanges },
    );
    swapOffersCreated.push(...local.swapOffersCreated);
    return;
  }
  outputs.push(buildCrossJurisdictionEntityOutput(
    env,
    ownerId,
    [admissionTx],
    requireRouteSignerHint(route, ownerId),
  ));
};

const queueBookAdmissionOnCommittedPull = (
  env: RuntimeState,
  newState: EntityState,
  counterpartyId: string,
  accountTx: Extract<AccountTx, { type: 'pull_lock' }>,
  outputs: EntityInput[],
  committedAt: number,
  swapOffersCreated: SwapOfferEvent[],
  storageChanges: RuntimeOverlayRecord[],
): boolean => {
  const carriedRoute = accountTx.data.crossJurisdictionRoute;
  if (accountTx.data.crossJurisdiction && !carriedRoute) {
    throw new Error(`CROSS_J_COMMITTED_PULL_ROUTE_MISSING:${accountTx.data.pullId}`);
  }
  if (carriedRoute) {
    const route = cloneCrossJurisdictionRoute(carriedRoute);
    newState.crossJurisdictionSwaps ||= new Map();
    const existing = newState.crossJurisdictionSwaps.get(route.orderId);
    if (existing?.routeHash && route.routeHash && existing.routeHash.toLowerCase() !== route.routeHash.toLowerCase()) {
      throw new Error(`CROSS_J_COMMITTED_PULL_ROUTE_CONFLICT:${route.orderId}`);
    }
    newState.crossJurisdictionSwaps.set(route.orderId, { ...existing, ...route });
  }
  const currentEntityId = normalizeEntityRef(newState.entityId);
  const counterpartyEntityId = normalizeEntityRef(counterpartyId);
  let handled = false;

  for (const route of newState.crossJurisdictionSwaps?.values?.() ?? []) {
    const role = getCommittedPullRole(
      route,
      currentEntityId,
      counterpartyEntityId,
      accountTx.data.pullId,
    );
    if (!role) continue;
    if (!committedPullMatchesRoute(accountTx, route, role.leg)) {
      throw new Error(`CROSS_J_COMMITTED_PULL_ROUTE_MISMATCH: route=${route.orderId} leg=${role.leg} pull=${accountTx.data.pullId}`);
    }
    const admissionRoute = cloneCrossJurisdictionRoute(route);
    transitionCrossJurisdictionRouteStatus(
      admissionRoute,
      'resting',
      committedAt,
    );
    Object.assign(route, admissionRoute);
    newState.crossJurisdictionSwaps?.set(route.orderId, route);

    // Opening is admitted only from the source Hub's committed Account frame.
    // That frame can reach this point only after Runtime preflight accepted the
    // exact source+target proposal pair at the User Runtime and the exact two
    // resulting ACKs at the Hub Runtime. Re-encoding that fact as a receipt is
    // redundant and was the source of the old extra protocol round trip.
    if (!role.sourceHubCommitted) {
      handled = true;
      continue;
    }
    admitCommittedSourcePullToBook(
      env,
      newState,
      admissionRoute,
      outputs,
      swapOffersCreated,
      storageChanges,
    );
    handled = true;
  }

  return handled;
};

const applySourcePullResolve = (
  env: RuntimeState,
  state: EntityState,
  route: CrossJurisdictionSwapRoute,
  accountTx: Extract<AccountTx, { type: 'pull_resolve' }>,
  fillRatio: number,
  currentEntityId: string,
  counterpartyEntityId: string,
  outputs: EntityInput[],
  storageChanges: RuntimeOverlayRecord[],
): boolean => {
  const sourceUserId = normalizeEntityRef(route.source.entityId);
  const sourceHubId = normalizeEntityRef(route.source.counterpartyEntityId);
  const isHub =
    route.sourcePull?.pullId === accountTx.data.pullId &&
    route.targetPull?.pullId !== undefined &&
    currentEntityId === sourceHubId &&
    counterpartyEntityId === sourceUserId;
  const isUser =
    route.sourcePull?.pullId === accountTx.data.pullId &&
    currentEntityId === sourceUserId &&
    counterpartyEntityId === sourceHubId;
  if (!isHub && !isUser) return false;
  if (assertSettledPullReplay(route, fillRatio, accountTx.data.binary)) {
    if (isHub) {
      removeOrRouteCrossJurisdictionBookOrder(env, state, route, outputs, 'settled', storageChanges);
    }
    return true;
  }
  assertPullResolveAllowed(route, fillRatio, 'source');
  backfillCommittedFillFromResolvedPull(route, fillRatio, state.timestamp);
  Object.assign(route, withCrossJurisdictionClaimProgress(route, fillRatio, state.timestamp));
  route.sourceCloseProof = buildCrossJurisdictionCloseProof(route, accountTx.data.binary);
  transitionCrossJurisdictionRouteStatus(route, 'source_claimed', state.timestamp);
  // Both participants project the Account frame, but only the Hub owns the
  // sibling book and may emit its removal.
  if (isHub) {
    removeOrRouteCrossJurisdictionBookOrder(env, state, route, outputs, 'source_claimed', storageChanges);
  }
  return true;
};

const applyTargetPullResolve = (
  env: RuntimeState,
  state: EntityState,
  route: CrossJurisdictionSwapRoute,
  accountTx: Extract<AccountTx, { type: 'pull_resolve' }>,
  fillRatio: number,
  currentEntityId: string,
  counterpartyEntityId: string,
  outputs: EntityInput[],
): boolean => {
  const targetHubId = normalizeEntityRef(route.target.entityId);
  const targetUserId = normalizeEntityRef(route.target.counterpartyEntityId);
  const isUser =
    route.targetPull?.pullId === accountTx.data.pullId &&
    currentEntityId === targetUserId &&
    counterpartyEntityId === targetHubId;
  const isHub =
    route.targetPull?.pullId === accountTx.data.pullId &&
    currentEntityId === targetHubId &&
    counterpartyEntityId === targetUserId;
  if (!isUser && !isHub) return false;
  if (assertSettledPullReplay(route, fillRatio, accountTx.data.binary)) return true;
  assertPullResolveAllowed(route, fillRatio, isHub ? 'target_hub' : 'target_user');
  backfillCommittedFillFromResolvedPull(route, fillRatio, state.timestamp);
  Object.assign(route, withCrossJurisdictionClaimProgress(route, fillRatio, state.timestamp));
  transitionTargetLegSettled(route, state.timestamp);
  settleTargetLegAndNotifySourceSibling(
    env,
    state,
    route,
    fillRatio,
    accountTx.data.binary,
    undefined,
    outputs,
    currentEntityId,
  );
  crossJFollowupLog.debug('pull.resolve.settled', {
    route: shortOrder(route.orderId, 12),
    ratio: fillRatio,
  });
  return true;
};

const applyPullResolveFollowup = (
  env: RuntimeState,
  newState: EntityState,
  counterpartyId: string,
  accountTx: Extract<AccountTx, { type: 'pull_resolve' }>,
  outputs: EntityInput[],
  storageChanges: RuntimeOverlayRecord[],
): boolean => {
  if (!newState.crossJurisdictionSwaps?.size) return true;
  let fillRatio = 0;
  try {
    fillRatio = decodeHashLadderBinary(accountTx.data.binary).fillRatio;
  } catch (error) {
    // Account consensus should never commit an invalid pull_resolve binary. If it
    // happens here, treating it as ratio=0 would silently skip a money-moving
    // cross-j claim followup and leave source/target legs inconsistent.
    throw new Error(
      `CROSS_J_PULL_RESOLVE_BINARY_INVALID: pull=${accountTx.data.pullId} ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (fillRatio <= 0) return true;

  const currentEntityId = normalizeEntityRef(newState.entityId);
  const counterpartyEntityId = normalizeEntityRef(counterpartyId);

  for (const route of newState.crossJurisdictionSwaps.values()) {
    if (applySourcePullResolve(
      env,
      newState,
      route,
      accountTx,
      fillRatio,
      currentEntityId,
      counterpartyEntityId,
      outputs,
      storageChanges,
    )) continue;
    applyTargetPullResolve(
      env,
      newState,
      route,
      accountTx,
      fillRatio,
      currentEntityId,
      counterpartyEntityId,
      outputs,
    );
  }
  return true;
};

const applyCrossPullCloseFollowup = (
  env: RuntimeState,
  newState: EntityState,
  counterpartyId: string,
  accountTx: Extract<AccountTx, { type: 'cross_pull_close' }>,
  outputs: EntityInput[],
  storageChanges: RuntimeOverlayRecord[],
): boolean => {
  if (!newState.crossJurisdictionSwaps?.size) return true;
  const fillRatio = Math.max(0, Math.min(CROSS_J_MAX_FILL_RATIO, Math.floor(Number(accountTx.data.proof.fillRatio) || 0)));
  const decoded = decodeHashLadderBinary(accountTx.data.binary);
  if (decoded.fillRatio !== fillRatio) {
    throw new Error(
      `CROSS_J_CLOSE_BINARY_RATIO_MISMATCH: pull=${accountTx.data.pullId} binary=${decoded.fillRatio} proof=${fillRatio}`,
    );
  }
  const currentEntityId = normalizeEntityRef(newState.entityId);
  const counterpartyEntityId = normalizeEntityRef(counterpartyId);

  for (const route of newState.crossJurisdictionSwaps.values()) {
    const sourceUserId = normalizeEntityRef(route.source.entityId);
    const sourceHubId = normalizeEntityRef(route.source.counterpartyEntityId);
    const targetHubId = normalizeEntityRef(route.target.entityId);
    const targetUserId = normalizeEntityRef(route.target.counterpartyEntityId);
    const isSourceHubClose =
      route.sourcePull?.pullId === accountTx.data.pullId &&
      route.targetPull?.pullId !== undefined &&
      currentEntityId === sourceHubId &&
      counterpartyEntityId === sourceUserId;
    const isSourceUserClose =
      route.sourcePull?.pullId === accountTx.data.pullId &&
      currentEntityId === sourceUserId &&
      counterpartyEntityId === sourceHubId;

    if (isSourceHubClose || isSourceUserClose) {
      if (assertSettledPullReplay(route, fillRatio, accountTx.data.binary, accountTx.data.proof)) {
        if (isSourceHubClose) {
          removeOrRouteCrossJurisdictionBookOrder(
            env,
            newState,
            route,
            outputs,
            'settled',
            storageChanges,
          );
        }
        continue;
      }
      assertPullResolveAllowed(route, fillRatio, 'source');
      Object.assign(
        route,
        withCrossJurisdictionCloseProofProgress(route, accountTx.data.proof, newState.timestamp),
      );
      route.sourceCloseProof = accountTx.data.proof;
      route.targetCloseProof = accountTx.data.proof;
      transitionTargetLegSettled(route, newState.timestamp);

      if (isSourceHubClose) {
        removeOrRouteCrossJurisdictionBookOrder(env, newState, route, outputs, 'settled', storageChanges);
      }
      crossJFollowupLog.debug('pull.close.source_committed', {
        route: shortOrder(route.orderId, 12),
        ratio: fillRatio,
      });
      continue;
    }

    const isTargetUserClose =
      route.targetPull?.pullId === accountTx.data.pullId &&
      currentEntityId === targetUserId &&
      counterpartyEntityId === targetHubId;
    const isTargetHubClose =
      route.targetPull?.pullId === accountTx.data.pullId &&
      currentEntityId === targetHubId &&
      counterpartyEntityId === targetUserId;
    if (isTargetUserClose || isTargetHubClose) {
      if (assertSettledPullReplay(route, fillRatio, accountTx.data.binary, accountTx.data.proof)) continue;
      // Account consensus already proved that the target Hub authored this
      // cross_pull_close. currentEntityId only identifies which side is
      // projecting the committed bilateral frame; it never changes authorship.
      assertPullResolveAllowed(route, fillRatio, 'target_hub');
      Object.assign(
        route,
        withCrossJurisdictionCloseProofProgress(route, accountTx.data.proof, newState.timestamp),
      );
      route.sourceCloseProof = accountTx.data.proof;
      route.targetCloseProof = accountTx.data.proof;
      transitionTargetLegSettled(route, newState.timestamp);
      crossJFollowupLog.debug('pull.close.settled', {
        route: shortOrder(route.orderId, 12),
        ratio: fillRatio,
      });
    }
  }
  return true;
};

const applyCommittedFillAckProgress = (
  state: EntityState,
  route: CrossJurisdictionSwapRoute,
  accountTx: Extract<AccountTx, { type: 'cross_swap_fill_ack' }>,
  ratio: number,
): void => {
  const currentRatio = committedCrossJurisdictionRatio(route);
  if (accountTx.data.cancelRemainder && ratio <= currentRatio) {
    transitionCrossJurisdictionRouteStatus(route, 'clear_requested', state.timestamp);
    route.clearingPolicy = 'cancel_and_clear';
    return;
  }
  const nextRoute = applyCrossJurisdictionFillProgress(route, {
    fillSeq: accountTx.data.fillSeq,
    cumulativeFillRatio: ratio,
    // Account consensus commits exact rational economics. The uint16 ratio is
    // only the hash-ladder/dispute projection and must never replace them.
    fillNumerator: accountTx.data.fillNumerator,
    fillDenominator: accountTx.data.fillDenominator,
    incrementalSourceAmount: accountTx.data.incrementalSourceAmount,
    incrementalTargetAmount: accountTx.data.incrementalTargetAmount,
    cumulativeSourceAmount: accountTx.data.cumulativeSourceAmount,
    cumulativeTargetAmount: accountTx.data.cumulativeTargetAmount,
  }, state.timestamp, 'CROSS_J_COMMITTED_FILL_ACK_INVALID');
  transitionCrossJurisdictionRouteStatus(route, nextRoute.status, state.timestamp);
  Object.assign(route, nextRoute);
  if ((accountTx.data.priceImprovementAmount ?? 0n) > 0n) {
    route.priceImprovementSourceAmount =
      (route.priceImprovementSourceAmount ?? 0n) + accountTx.data.priceImprovementAmount!;
  }
  if (accountTx.data.cancelRemainder) {
    transitionCrossJurisdictionRouteStatus(route, 'clear_requested', state.timestamp);
    route.clearingPolicy = 'cancel_and_clear';
  }
};

const closeOrProgressCrossJurisdictionBook = (
  env: RuntimeState,
  state: EntityState,
  route: CrossJurisdictionSwapRoute,
  accountTx: Extract<AccountTx, { type: 'cross_swap_fill_ack' }>,
  ratio: number,
  outputs: EntityInput[],
  storageChanges: RuntimeOverlayRecord[],
  candidateEffects: EntityCandidateEffect[],
): void => {
  if (normalizeEntityRef(state.entityId) !== normalizeEntityRef(route.source.counterpartyEntityId)) {
    return;
  }
  if (ratio < CROSS_J_MAX_FILL_RATIO && !accountTx.data.cancelRemainder) {
    applyOrRouteCrossJurisdictionBookProgress(
      env,
      state,
      route,
      accountTx,
      outputs,
      storageChanges,
      candidateEffects,
    );
    return;
  }
  const admission = state.crossJurisdictionBookAdmissions?.get(
    crossJurisdictionBookAdmissionKeyFor(route.source.entityId, route.orderId),
  );
  const removalAlreadyCommitted = Boolean(
    accountTx.data.cancelRemainder && admission?.pendingCancel?.bookRemovalCommittedAt,
  );
  if (removalAlreadyCommitted) {
    markCrossJurisdictionBookAdmissionClosed(
      state,
      route.source.entityId,
      route.orderId,
      Number(state.timestamp || env.timestamp || 0),
      'cancel_ack_committed',
    );
  } else {
    removeOrRouteCrossJurisdictionBookOrder(env, state, route, outputs, 'fill_ack_closed', storageChanges);
  }
  const signerId = String(state.config.validators[0] || '').trim().toLowerCase();
  if (!signerId) throw new Error(`CROSS_J_SELF_SIGNER_MISSING:${route.orderId}:${state.entityId}`);
  outputs.push({
    entityId: state.entityId,
    signerId,
    entityTxs: [{
      type: 'requestCrossJurisdictionClear',
      data: {
        orderId: route.orderId,
        cancelRemainder: Boolean(accountTx.data.cancelRemainder),
      },
    }],
  });
};

const applyFillAckFollowup = (
  env: RuntimeState,
  newState: EntityState,
  accountTx: Extract<AccountTx, { type: 'cross_swap_fill_ack' }>,
  outputs: EntityInput[],
  storageChanges: RuntimeOverlayRecord[],
  candidateEffects: EntityCandidateEffect[],
): boolean => {
  assertCrossJurisdictionPriceImprovementMode(
    accountTx.data.priceImprovementMode,
    accountTx.data.offerId,
  );
  const ratio = getCrossJurisdictionCommittedProofRatio({
    orderId: accountTx.data.offerId,
    cumulativeFillRatio: accountTx.data.cumulativeFillRatio,
    fillNumerator: accountTx.data.fillNumerator,
    fillDenominator: accountTx.data.fillDenominator,
  });
  const route = newState.crossJurisdictionSwaps?.get(accountTx.data.offerId);
  if (!route) {
    // A committed account ACK is canonical money progress. If the entity route
    // mirror is gone, silently accepting the ACK leaves the shared book stale
    // and hides projection corruption. Never rehydrate or skip here.
    throw new Error(
      `CROSS_J_FILL_ACK_ROUTE_MISSING: entity=${shortId(newState.entityId)} ` +
      `offer=${shortOrder(accountTx.data.offerId, 12)} ratio=${ratio} cancel=${Boolean(accountTx.data.cancelRemainder)}`,
    );
  }

  const previousStatus = route.status;
  applyCommittedFillAckProgress(newState, route, accountTx, ratio);
  route.updatedAt = newState.timestamp;
  crossJFollowupLog.debug('fill_ack.applied', {
    entity: shortId(newState.entityId),
    offer: shortOrder(accountTx.data.offerId, 12),
    previousStatus,
    status: route.status,
    ratio,
    fillSeq: route.fillSeq,
    cancel: accountTx.data.cancelRemainder,
  });

  closeOrProgressCrossJurisdictionBook(
    env,
    newState,
    route,
    accountTx,
    ratio,
    outputs,
    storageChanges,
    candidateEffects,
  );
  return true;
};

export function applyCommittedCrossJurisdictionAccountTxFollowup(
  env: RuntimeState,
  newState: EntityState,
  counterpartyId: string,
  accountTx: AccountTx,
  outputs: EntityInput[],
  committedAt: number,
  swapOffersCreated: SwapOfferEvent[],
  storageChanges: RuntimeOverlayRecord[],
  candidateEffects: EntityCandidateEffect[],
): boolean {
  if (accountTx.type === 'pull_lock') {
    return queueBookAdmissionOnCommittedPull(
      env,
      newState,
      counterpartyId,
      accountTx,
      outputs,
      committedAt,
      swapOffersCreated,
      storageChanges,
    );
  }
  if (accountTx.type === 'pull_resolve') {
    return applyPullResolveFollowup(env, newState, counterpartyId, accountTx, outputs, storageChanges);
  }
  if (accountTx.type === 'cross_pull_close') {
    return applyCrossPullCloseFollowup(env, newState, counterpartyId, accountTx, outputs, storageChanges);
  }
  if (accountTx.type === 'cross_swap_fill_ack') {
    return applyFillAckFollowup(
      env,
      newState,
      accountTx,
      outputs,
      storageChanges,
      candidateEffects,
    );
  }
  return false;
}
