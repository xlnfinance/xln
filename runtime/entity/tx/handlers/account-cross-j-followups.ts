import { normalizeEntityRef } from '../account-key';
import type { AccountTx, RuntimeOverlayRecord } from '../../../types/account';
import type { CrossJurisdictionSwapRoute } from '../../../types/cross-jurisdiction';
import type { EntityCandidateEffect, EntityInput, EntityState } from '../../types';
import type { EntityRuntimeContext } from '../../runtime-context';
import type { EntityTx } from '../../../types/entity-tx';
import {
  cloneCrossJurisdictionRoute,
  CROSS_J_MAX_FILL_RATIO,
  applyCrossJurisdictionFillProgress,
  assertCrossJurisdictionPriceImprovementMode,
  getCrossJurisdictionCommittedProofRatio,
  getCrossJurisdictionCommittedFillAmounts,
  hashCrossJurisdictionCloseBinary,
  isCrossJurisdictionFillTerminal,
  isCrossJurisdictionRouteExpired,
  isCrossJurisdictionTerminalStatus,
  transitionCrossJurisdictionRouteStatus,
  withCrossJurisdictionCloseProofProgress,
  cloneCrossJurisdictionCloseProof,
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
import { cancelHook, scheduleHook } from '../../scheduler';
import {
  buildCrossJurisdictionEntityOutput,
  crossJurisdictionRouteSignerHint,
} from '../cross-j-outputs';
import { applyCrossJurisdictionBookProgressToState } from './cross-j-book-order';
import { handleAdmitCrossJurisdictionBookOrderEntityTx } from './cross-j-book-order';
import type { SwapOfferEvent } from './account';

const crossJFollowupLog = createStructuredLogger('crossj.followup');


const committedCrossJurisdictionRatio = (route: CrossJurisdictionSwapRoute): number =>
  getCrossJurisdictionCommittedProofRatio(route);

const assertTerminalPullReplay = (
  route: CrossJurisdictionSwapRoute,
  fillRatio: number,
  binary: string,
  suppliedProof?: Extract<AccountTx, { type: 'cross_pull_close' }>['data']['proof'],
): boolean => {
  if (!isCrossJurisdictionTerminalStatus(route.status)) return false;
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
    throw new Error(`CROSS_J_TERMINAL_PULL_REPLAY_MISMATCH: route=${route.orderId} ratio=${fillRatio}`);
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
    throw new Error(`CROSS_J_TERMINAL_PULL_PROOF_REPLAY_MISMATCH: route=${route.orderId}`);
  }
  return true;
};

const assertCrossPullCloseAllowed = (
  route: CrossJurisdictionSwapRoute,
  fillRatio: number,
  leg: 'source' | 'target',
): void => {
  if (fillRatio <= 0) return;
  if (isCrossJurisdictionTerminalStatus(route.status)) {
    throw new Error(`CROSS_J_PULL_CLOSE_STATE_INVALID: route=${route.orderId} status=${route.status}`);
  }
  if (leg === 'source' && route.status !== 'clearing' && route.status !== 'clear_requested') {
    throw new Error(`CROSS_J_PULL_CLOSE_STATE_INVALID: route=${route.orderId} leg=source status=${route.status}`);
  }
  if (
    leg === 'target' &&
    route.status !== 'resting' &&
    route.status !== 'partially_filled' &&
    route.status !== 'clear_requested' &&
    route.status !== 'clearing'
  ) {
    throw new Error(`CROSS_J_PULL_CLOSE_STATE_INVALID: route=${route.orderId} leg=target status=${route.status}`);
  }
  // CANON (owner, 2026-08-07): informational fill progress never gates a
  // close. The Account layer already verified the ladder reveal against
  // partialRoot at exactly this ratio, and the hub's real fill legally runs
  // AHEAD of its last "matched X%" message, so a close above the informed
  // ratio is normal. Only a rollback BELOW informed fill is invalid: informed
  // progress is monotonic, and un-matching what both sides were told would be
  // the hub rewriting history, not lagging delivery.
  const committedRatio = committedCrossJurisdictionRatio(route);
  if (fillRatio < committedRatio) {
    throw new Error(
      `CROSS_J_PULL_CLOSE_ROLLBACK: route=${route.orderId} ` +
      `ratio=${fillRatio} informed=${committedRatio}`,
    );
  }
};

export const transitionTargetLegTerminal = (
  route: CrossJurisdictionSwapRoute,
  updatedAt: number,
  fillRatio: number,
): 'settled' | 'cancelled' | 'expired' => {
  if (route.status !== 'clearing') {
    // The Hub-authored atomic Account close is the authoritative transition.
    // Either bilateral participant may still have a resting route projection
    // when that same frame commits, so materialize clearing before settlement.
    transitionCrossJurisdictionRouteStatus(route, 'clearing', updatedAt);
  }
  const terminal = fillRatio > 0
    ? 'settled'
    : isCrossJurisdictionRouteExpired(route, updatedAt)
      ? 'expired'
      : 'cancelled';
  transitionCrossJurisdictionRouteStatus(route, terminal, updatedAt);
  if (terminal === 'settled') route.settledAt = updatedAt;
  return terminal;
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
  env: EntityRuntimeContext,
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
      Number(newState.timestamp || env.state.timestamp || 0),
      reason,
    );
    return;
  }

  outputs.push(buildCrossJurisdictionEntityOutput(owner.ownerId, requireRouteSignerHint(route, owner.ownerId), [{
      type: 'removeCrossJurisdictionBookOrder',
      data: {
        orderId: route.orderId,
        sourceEntityId: route.source.entityId,
        route,
        reason,
      },
  }]));
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
    fillNumerator: accountTx.data.fillNumerator,
    fillDenominator: accountTx.data.fillDenominator,
    ...(accountTx.data.priceImprovementMode ? { priceImprovementMode: accountTx.data.priceImprovementMode } : {}),
    ...(accountTx.data.priceImprovementAmount !== undefined ? { priceImprovementAmount: accountTx.data.priceImprovementAmount } : {}),
    ...(accountTx.data.priceImprovementTokenId !== undefined ? { priceImprovementTokenId: accountTx.data.priceImprovementTokenId } : {}),
    ...(accountTx.data.cancelRemainder !== undefined ? { cancelRemainder: accountTx.data.cancelRemainder } : {}),
    reason,
  },
});

const applyOrRouteCrossJurisdictionBookProgress = (
  env: EntityRuntimeContext,
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
    owner.ownerId,
    requireRouteSignerHint(route, owner.ownerId),
    [tx],
  ));
};

const committedPullMatchesRoute = (
  accountTx: Extract<AccountTx, { type: 'cross_pull_lock' }>,
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
    (accountTx.data.partialRoot || '').toLowerCase() === pull.partialRoot.toLowerCase()
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
  env: EntityRuntimeContext,
  state: EntityState,
  route: CrossJurisdictionSwapRoute,
  outputs: EntityInput[],
  swapOffersCreated: SwapOfferEvent[],
  storageChanges: RuntimeOverlayRecord[],
): void => {
  addMessage(state, `🌉 Cross-j swap ${route.orderId} committed by both Account legs`);
  if (!state.crontabState) throw new Error(`CROSS_J_EXPIRY_CRONTAB_MISSING:${route.orderId}`);
  const expiresAt = Math.floor(Number(route.expiresAt || 0));
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= state.timestamp) {
    throw new Error(`CROSS_J_EXPIRY_INVALID:${route.orderId}:${String(route.expiresAt)}`);
  }
  scheduleHook(state.crontabState, {
    id: `cross-j-expiry:${route.orderId}`,
    type: 'cross_j_orderbook_sweep',
    triggerAt: expiresAt,
    data: { reason: `cross-j-expiry:${route.orderId}` },
  });
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
    ownerId,
    requireRouteSignerHint(route, ownerId),
    [admissionTx],
  ));
};

const queueBookAdmissionOnCommittedPull = (
  env: EntityRuntimeContext,
  newState: EntityState,
  counterpartyId: string,
  accountTx: Extract<AccountTx, { type: 'cross_pull_lock' }>,
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
    const userLeg =
      currentEntityId === normalizeEntityRef(route.source.entityId) ||
      currentEntityId === normalizeEntityRef(route.target.counterpartyEntityId);
    if (userLeg) {
      const authorization = newState.crossJurisdictionAuthorizations?.get(route.orderId);
      if (
        !authorization ||
        normalizeEntityRef(authorization.routeHash || '') !== normalizeEntityRef(route.routeHash || '')
      ) {
        throw new Error(`CROSS_J_COMMITTED_PULL_AUTH_MISSING:${route.orderId}:${currentEntityId}`);
      }
      // This mutates only the staged Entity candidate. Runtime publishes both
      // user sibling candidates together, so neither one-shot authorization is
      // consumed unless both Account frames have committed successfully.
      newState.crossJurisdictionAuthorizations!.delete(route.orderId);
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
    // That frame can reach this point only after Runtime atomic admission accepted the
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

const requireCrossPullCloseFillRatio = (fillRatio: number): number => {
  if (!Number.isSafeInteger(fillRatio) || fillRatio < 0 || fillRatio > CROSS_J_MAX_FILL_RATIO) {
    throw new Error(`CROSS_J_CLOSE_PROOF_RATIO_INVALID:${fillRatio}`);
  }
  return fillRatio;
};

const applyCrossPullCloseFollowup = (
  env: EntityRuntimeContext,
  newState: EntityState,
  counterpartyId: string,
  accountTx: Extract<AccountTx, { type: 'cross_pull_close' }>,
  outputs: EntityInput[],
  storageChanges: RuntimeOverlayRecord[],
): boolean => {
  if (!newState.crossJurisdictionSwaps?.size) return true;
  const fillRatio = requireCrossPullCloseFillRatio(accountTx.data.proof.fillRatio);
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
      if (assertTerminalPullReplay(route, fillRatio, accountTx.data.binary, accountTx.data.proof)) {
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
      assertCrossPullCloseAllowed(route, fillRatio, 'source');
      Object.assign(
        route,
        withCrossJurisdictionCloseProofProgress(route, accountTx.data.proof, newState.timestamp),
      );
      route.sourceCloseProof = cloneCrossJurisdictionCloseProof(accountTx.data.proof);
      route.targetCloseProof = cloneCrossJurisdictionCloseProof(accountTx.data.proof);
      const terminal = transitionTargetLegTerminal(route, newState.timestamp, fillRatio);
      if (newState.crontabState) cancelHook(newState.crontabState, `cross-j-expiry:${route.orderId}`);

      if (isSourceHubClose) {
        removeOrRouteCrossJurisdictionBookOrder(env, newState, route, outputs, terminal, storageChanges);
      }
      crossJFollowupLog.debug('pull.close.source_hub_committed', {
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
      if (assertTerminalPullReplay(route, fillRatio, accountTx.data.binary, accountTx.data.proof)) continue;
      // Account consensus already proved that the target Hub authored this
      // cross_pull_close. currentEntityId only identifies which side is
      // projecting the committed bilateral frame; it never changes authorship.
      assertCrossPullCloseAllowed(route, fillRatio, 'target');
      Object.assign(
        route,
        withCrossJurisdictionCloseProofProgress(route, accountTx.data.proof, newState.timestamp),
      );
      route.sourceCloseProof = cloneCrossJurisdictionCloseProof(accountTx.data.proof);
      route.targetCloseProof = cloneCrossJurisdictionCloseProof(accountTx.data.proof);
      transitionTargetLegTerminal(route, newState.timestamp, fillRatio);
      if (newState.crontabState) cancelHook(newState.crontabState, `cross-j-expiry:${route.orderId}`);
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
  // Mirror the Account transition: a terminal fill - including a sub-lot dust
  // remainder the taker did not explicitly cancel - requests the clear.
  const { terminal, dustClose } = isCrossJurisdictionFillTerminal(route, {
    nextRatio: ratio,
    cumulativeSourceAmount: accountTx.data.cumulativeSourceAmount,
    cumulativeTargetAmount: accountTx.data.cumulativeTargetAmount,
    ...(accountTx.data.cancelRemainder !== undefined
      ? { cancelRemainder: accountTx.data.cancelRemainder }
      : {}),
  });
  if (terminal) {
    transitionCrossJurisdictionRouteStatus(route, 'clear_requested', state.timestamp);
    route.clearingPolicy =
      accountTx.data.cancelRemainder || dustClose || ratio < CROSS_J_MAX_FILL_RATIO
        ? 'cancel_and_clear'
        : 'full_fill';
  }
};

const closeOrProgressCrossJurisdictionBook = (
  env: EntityRuntimeContext,
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
  // The Account transition closes the offer on a sub-lot remainder too, so this
  // must use the same terminal predicate. Deriving terminality from the tx
  // flags alone leaves the source offer deleted with its pulls bound until
  // expiry, because the clear is never requested.
  const { terminal } = isCrossJurisdictionFillTerminal(route, {
    nextRatio: ratio,
    cumulativeSourceAmount: accountTx.data.cumulativeSourceAmount,
    cumulativeTargetAmount: accountTx.data.cumulativeTargetAmount,
    ...(accountTx.data.cancelRemainder !== undefined
      ? { cancelRemainder: accountTx.data.cancelRemainder }
      : {}),
  });
  if (!terminal) {
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
      Number(state.timestamp || env.state.timestamp || 0),
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
  env: EntityRuntimeContext,
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

const applyTargetProgressFollowup = (
  newState: EntityState,
  counterpartyId: string,
  accountTx: Extract<AccountTx, { type: 'cross_pull_progress' }>,
): boolean => {
  const fillAck: Extract<AccountTx, { type: 'cross_swap_fill_ack' }> = {
    type: 'cross_swap_fill_ack',
    data: accountTx.data.fill,
  };
  const route = newState.crossJurisdictionSwaps?.get(fillAck.data.offerId);
  if (!route) {
    throw new Error(`CROSS_J_TARGET_PROGRESS_ROUTE_MISSING:${fillAck.data.offerId}`);
  }
  const role = getCommittedPullRole(
    route,
    normalizeEntityRef(newState.entityId),
    normalizeEntityRef(counterpartyId),
    accountTx.data.pullId,
  );
  if (role?.leg !== 'target') {
    throw new Error(`CROSS_J_TARGET_PROGRESS_ACCOUNT_MISMATCH:${fillAck.data.offerId}:${accountTx.data.pullId}`);
  }
  const ratio = getCrossJurisdictionCommittedProofRatio({
    orderId: fillAck.data.offerId,
    cumulativeFillRatio: fillAck.data.cumulativeFillRatio,
    fillNumerator: fillAck.data.fillNumerator,
    fillDenominator: fillAck.data.fillDenominator,
  });
  applyCommittedFillAckProgress(newState, route, fillAck, ratio);
  route.updatedAt = newState.timestamp;
  return true;
};

export function applyCommittedCrossJurisdictionAccountTxFollowup(
  env: EntityRuntimeContext,
  newState: EntityState,
  counterpartyId: string,
  accountTx: AccountTx,
  outputs: EntityInput[],
  committedAt: number,
  swapOffersCreated: SwapOfferEvent[],
  storageChanges: RuntimeOverlayRecord[],
  candidateEffects: EntityCandidateEffect[],
): boolean {
  if (accountTx.type === 'cross_pull_lock') {
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
  if (accountTx.type === 'cross_pull_close') {
    return applyCrossPullCloseFollowup(env, newState, counterpartyId, accountTx, outputs, storageChanges);
  }
  if (accountTx.type === 'cross_pull_progress') {
    return applyTargetProgressFollowup(newState, counterpartyId, accountTx);
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
