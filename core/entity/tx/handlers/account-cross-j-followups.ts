import { haltRuntimeFailure } from "../../../protocol/errors/failure-taxonomy";

import { normalizeEntityRef } from '../account-key';
import type { AccountTx, RuntimeOverlayRecord } from '../../../types/account';
import type { CrossJurisdictionSwapRoute } from '../../../types/cross-jurisdiction';
import type { EntityInput, EntityOutput, EntityState } from '../../types';
import type { EntityRuntimeContext } from '../../runtime-context';
import type { EntityTx } from '../../../types/entity-tx';
import {
  cloneCrossJurisdictionRoute,
  CROSS_J_MAX_FILL_RATIO,
  applyCrossJurisdictionFillProgress,
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
  buildCrossJurisdictionFillProgressData,
  type CrossJurisdictionFillProgressData,
} from '../../../extensions/cross-j/fill-notice';
import {
  markCrossJurisdictionBookAdmissionClosed,
  type CrossJurisdictionFillInstruction,
} from '../../../extensions/cross-j/orderbook';
import { decodeHashLadderBinary } from '../../../protocol/htlc/hash-ladder';
import { createStructuredLogger, shortId, shortOrder } from '../../../support/logger';
import { removeCrossJurisdictionBookOrder } from '../../../orderbook/cross-j';
import { addMessage } from '../../frame-events';
import { getEntityCollectionValueForWrite, ensureEntityCollectionCandidate } from '../../state/persistent-collection-map';
import { cancelHook, scheduleHook } from '../../scheduler';
import {
  buildCrossJurisdictionEntityOutput,
  buildCrossJurisdictionFillNoticeOutput,
  crossJurisdictionRouteSignerHint,
} from '../j-events-htlc/cross-j-outputs';
import {
  applyCrossJurisdictionBookFillToState,
  handleAdmitCrossJurisdictionBookOrderEntityTx,
} from './cross-j/book-order';
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
    throw haltRuntimeFailure("CROSS_J_TERMINAL_PULL_REPLAY_MISMATCH", `CROSS_J_TERMINAL_PULL_REPLAY_MISMATCH: route=${route.orderId} ratio=${fillRatio}`);
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
    throw haltRuntimeFailure("CROSS_J_TERMINAL_PULL_PROOF_REPLAY_MISMATCH", `CROSS_J_TERMINAL_PULL_PROOF_REPLAY_MISMATCH: route=${route.orderId}`);
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
    throw haltRuntimeFailure("CROSS_J_PULL_CLOSE_STATE_INVALID", `CROSS_J_PULL_CLOSE_STATE_INVALID: route=${route.orderId} status=${route.status}`);
  }
  if (leg === 'source' && route.status !== 'clearing' && route.status !== 'clear_requested') {
    throw haltRuntimeFailure("CROSS_J_PULL_CLOSE_STATE_INVALID", `CROSS_J_PULL_CLOSE_STATE_INVALID: route=${route.orderId} leg=source status=${route.status}`);
  }
  if (
    leg === 'target' &&
    route.status !== 'resting' &&
    route.status !== 'partially_filled' &&
    route.status !== 'clear_requested' &&
    route.status !== 'clearing'
  ) {
    throw haltRuntimeFailure("CROSS_J_PULL_CLOSE_STATE_INVALID", `CROSS_J_PULL_CLOSE_STATE_INVALID: route=${route.orderId} leg=target status=${route.status}`);
  }
  // CANON (owner, 2026-08-07): Hub-internal fill progress never gates a close.
  // The Account layer already verified the ladder reveal against partialRoot
  // at exactly this ratio, and the hub's real fill legally runs AHEAD of the
  // last progress this mirror saw, so a close above the mirrored ratio is
  // normal. Only a rollback BELOW mirrored fill is invalid: progress is
  // monotonic, and un-matching what the Hub already recorded would be the hub
  // rewriting history, not lagging delivery.
  const committedRatio = committedCrossJurisdictionRatio(route);
  if (fillRatio < committedRatio) {
    throw haltRuntimeFailure("CROSS_J_PULL_CLOSE_ROLLBACK", `CROSS_J_PULL_CLOSE_ROLLBACK: route=${route.orderId} ` +
      `ratio=${fillRatio} informed=${committedRatio}`);
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
  if (!signerId) throw haltRuntimeFailure("CROSS_J_ROUTE_SIGNER_MISSING", `CROSS_J_ROUTE_SIGNER_MISSING:${route.orderId}:${entityId}`);
  return signerId;
};

const removeOrRouteCrossJurisdictionBookOrder = (
  env: EntityRuntimeContext,
  newState: EntityState,
  route: CrossJurisdictionSwapRoute,
  outputs: EntityOutput[],
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
  if (!state.crontabState) throw haltRuntimeFailure("CROSS_J_EXPIRY_CRONTAB_MISSING", `CROSS_J_EXPIRY_CRONTAB_MISSING:${route.orderId}`);
  const expiresAt = Math.floor(Number(route.expiresAt || 0));
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= state.timestamp) {
    throw haltRuntimeFailure("CROSS_J_EXPIRY_INVALID", `CROSS_J_EXPIRY_INVALID:${route.orderId}:${String(route.expiresAt)}`);
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
    throw haltRuntimeFailure("CROSS_J_COMMITTED_PULL_ROUTE_MISSING", `CROSS_J_COMMITTED_PULL_ROUTE_MISSING:${accountTx.data.pullId}`);
  }
  if (carriedRoute) {
    const route = cloneCrossJurisdictionRoute(carriedRoute);
    newState.crossJurisdictionSwaps = ensureEntityCollectionCandidate(
      newState.crossJurisdictionSwaps,
      cloneCrossJurisdictionRoute,
    );
    const existing = newState.crossJurisdictionSwaps.get(route.orderId);
    if (existing?.routeHash && route.routeHash && existing.routeHash.toLowerCase() !== route.routeHash.toLowerCase()) {
      throw haltRuntimeFailure("CROSS_J_COMMITTED_PULL_ROUTE_CONFLICT", `CROSS_J_COMMITTED_PULL_ROUTE_CONFLICT:${route.orderId}`);
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
      throw haltRuntimeFailure("CROSS_J_COMMITTED_PULL_ROUTE_MISMATCH", `CROSS_J_COMMITTED_PULL_ROUTE_MISMATCH: route=${route.orderId} leg=${role.leg} pull=${accountTx.data.pullId}`);
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
        throw haltRuntimeFailure("CROSS_J_COMMITTED_PULL_AUTH_MISSING", `CROSS_J_COMMITTED_PULL_AUTH_MISSING:${route.orderId}:${currentEntityId}`);
      }
      // This mutates only the staged Entity candidate. Runtime publishes both
      // user sibling candidates together, so neither one-shot authorization is
      // consumed unless both Account frames have committed successfully.
      newState.crossJurisdictionAuthorizations!.delete(route.orderId);
    }
    const writable = claimWritableCrossJRoute(newState, route.orderId);
    const admissionRoute = cloneCrossJurisdictionRoute(writable);
    transitionCrossJurisdictionRouteStatus(
      admissionRoute,
      'resting',
      committedAt,
    );
    Object.assign(writable, admissionRoute);
    newState.crossJurisdictionSwaps?.set(writable.orderId, writable);

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
    throw haltRuntimeFailure("CROSS_J_CLOSE_PROOF_RATIO_INVALID", `CROSS_J_CLOSE_PROOF_RATIO_INVALID:${fillRatio}`);
  }
  return fillRatio;
};

const claimWritableCrossJRoute = (
  state: EntityState,
  orderId: string,
): CrossJurisdictionSwapRoute => {
  const routes = state.crossJurisdictionSwaps;
  const route = routes
    ? getEntityCollectionValueForWrite(routes, orderId)
    : undefined;
  if (!route) {
    throw haltRuntimeFailure(
      'CROSS_J_PULL_CLOSE_ROUTE_FORK_MISSING',
      `CROSS_J_PULL_CLOSE_ROUTE_FORK_MISSING:${orderId}`,
    );
  }
  return route;
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
    throw haltRuntimeFailure("CROSS_J_CLOSE_BINARY_RATIO_MISMATCH", `CROSS_J_CLOSE_BINARY_RATIO_MISMATCH: pull=${accountTx.data.pullId} binary=${decoded.fillRatio} proof=${fillRatio}`);
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
      const writable = claimWritableCrossJRoute(newState, route.orderId);
      Object.assign(
        writable,
        withCrossJurisdictionCloseProofProgress(writable, accountTx.data.proof, newState.timestamp),
      );
      writable.sourceCloseProof = cloneCrossJurisdictionCloseProof(accountTx.data.proof);
      writable.targetCloseProof = cloneCrossJurisdictionCloseProof(accountTx.data.proof);
      const terminal = transitionTargetLegTerminal(writable, newState.timestamp, fillRatio);
      if (newState.crontabState) cancelHook(newState.crontabState, `cross-j-expiry:${writable.orderId}`);

      if (isSourceHubClose) {
        removeOrRouteCrossJurisdictionBookOrder(env, newState, writable, outputs, terminal, storageChanges);
      }
      crossJFollowupLog.debug('pull.close.source_hub_committed', {
        route: shortOrder(writable.orderId, 12),
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
      const writable = claimWritableCrossJRoute(newState, route.orderId);
      Object.assign(
        writable,
        withCrossJurisdictionCloseProofProgress(writable, accountTx.data.proof, newState.timestamp),
      );
      writable.sourceCloseProof = cloneCrossJurisdictionCloseProof(accountTx.data.proof);
      writable.targetCloseProof = cloneCrossJurisdictionCloseProof(accountTx.data.proof);
      transitionTargetLegTerminal(writable, newState.timestamp, fillRatio);
      if (newState.crontabState) cancelHook(newState.crontabState, `cross-j-expiry:${writable.orderId}`);
      crossJFollowupLog.debug('pull.close.settled', {
        route: shortOrder(writable.orderId, 12),
        ratio: fillRatio,
      });
    }
  }
  return true;
};

const applyCommittedFillProgress = (
  state: EntityState,
  route: CrossJurisdictionSwapRoute,
  fill: CrossJurisdictionFillProgressData,
  ratio: number,
): void => {
  const currentRatio = committedCrossJurisdictionRatio(route);
  if (fill.cancelRemainder && ratio <= currentRatio) {
    transitionCrossJurisdictionRouteStatus(route, 'clear_requested', state.timestamp);
    route.clearingPolicy = 'cancel_and_clear';
    return;
  }
  const nextRoute = applyCrossJurisdictionFillProgress(route, {
    fillSeq: fill.fillSeq,
    cumulativeFillRatio: ratio,
    fillNumerator: BigInt(ratio),
    fillDenominator: BigInt(CROSS_J_MAX_FILL_RATIO),
  }, state.timestamp, 'CROSS_J_FILL_PROGRESS_INVALID');
  transitionCrossJurisdictionRouteStatus(route, nextRoute.status, state.timestamp);
  Object.assign(route, nextRoute);
  if (isCrossJurisdictionFillTerminal(route, { nextRatio: ratio, cancelRemainder: fill.cancelRemainder })) {
    transitionCrossJurisdictionRouteStatus(route, 'clear_requested', state.timestamp);
    route.clearingPolicy = fill.cancelRemainder || ratio < CROSS_J_MAX_FILL_RATIO
      ? 'cancel_and_clear'
      : 'full_fill';
  }
};

const requestClearFromSourceHub = (
  state: EntityState,
  route: CrossJurisdictionSwapRoute,
  cancelRemainder: boolean,
  outputs: EntityOutput[],
): void => {
  const signerId = String(state.config.validators[0] || '').trim().toLowerCase();
  if (!signerId) throw haltRuntimeFailure("CROSS_J_SELF_SIGNER_MISSING", `CROSS_J_SELF_SIGNER_MISSING:${route.orderId}:${state.entityId}`);
  outputs.push({
    entityId: state.entityId,
    signerId,
    entityTxs: [{
      type: 'requestCrossJurisdictionClear',
      data: {
        orderId: route.orderId,
        cancelRemainder,
      },
    }],
  });
};

/**
 * Source-Hub view of Hub-internal fill progress. The route mirror is what the
 * proposer reveals against; a terminal fill (or cancel) requests the clear.
 * Returns false for an exact duplicate (durable sibling delivery may retry).
 */
export const applySourceHubCrossJurisdictionFillProgress = (
  env: EntityRuntimeContext,
  newState: EntityState,
  fill: CrossJurisdictionFillProgressData,
  outputs: EntityOutput[],
  storageChanges: RuntimeOverlayRecord[],
): boolean => {
  const routes = newState.crossJurisdictionSwaps;
  const route = routes
    ? getEntityCollectionValueForWrite(routes, fill.orderId)
    : undefined;
  if (!route) {
    throw haltRuntimeFailure("CROSS_J_FILL_ROUTE_MISSING", `CROSS_J_FILL_ROUTE_MISSING: entity=${shortId(newState.entityId)} ` +
      `offer=${shortOrder(fill.orderId, 12)} ratio=${fill.cumulativeFillRatio} cancel=${Boolean(fill.cancelRemainder)}`);
  }
  if (normalizeEntityRef(newState.entityId) !== normalizeEntityRef(route.source.counterpartyEntityId)) {
    throw haltRuntimeFailure("CROSS_J_FILL_SOURCE_HUB_REQUIRED", `CROSS_J_FILL_SOURCE_HUB_REQUIRED: order=${fill.orderId} entity=${newState.entityId}`);
  }
  if (
    fill.routeHash &&
    route.routeHash &&
    fill.routeHash.toLowerCase() !== route.routeHash.toLowerCase()
  ) {
    throw haltRuntimeFailure("CROSS_J_FILL_ROUTE_HASH_MISMATCH", `CROSS_J_FILL_ROUTE_HASH_MISMATCH: order=${fill.orderId} got=${fill.routeHash} expected=${route.routeHash}`);
  }
  if (isCrossJurisdictionTerminalStatus(route.status)) return false;
  // Once the clear is requested the ladder reveal is the only remaining
  // authority: a late fill must never re-open or raise the ratio.
  if (route.status === 'clear_requested' || route.status === 'clearing') return false;
  const ratio = Math.max(0, Math.min(CROSS_J_MAX_FILL_RATIO, Math.floor(Number(fill.cumulativeFillRatio) || 0)));
  const currentSeq = Math.max(0, Math.floor(Number(route.fillSeq ?? 0) || 0));
  const incomingSeq = Math.floor(Number(fill.fillSeq));
  const isCancel = Boolean(fill.cancelRemainder) && incomingSeq === currentSeq;
  if (!isCancel && incomingSeq === currentSeq && ratio !== committedCrossJurisdictionRatio(route)) {
    throw haltRuntimeFailure("CROSS_J_FILL_NOTICE_STALE_CONFLICT", `CROSS_J_FILL_NOTICE_STALE_CONFLICT: order=${fill.orderId} seq=${incomingSeq} ratio=${ratio}`);
  }
  if (!isCancel && incomingSeq <= currentSeq) return false;

  const previousStatus = route.status;
  applyCommittedFillProgress(newState, route, fill, ratio);
  route.updatedAt = newState.timestamp;
  crossJFollowupLog.debug('fill.applied', {
    entity: shortId(newState.entityId),
    offer: shortOrder(fill.orderId, 12),
    previousStatus,
    status: route.status,
    ratio,
    fillSeq: route.fillSeq,
    cancel: fill.cancelRemainder,
  });

  if (!isCrossJurisdictionFillTerminal(route, { nextRatio: ratio, cancelRemainder: fill.cancelRemainder })) return true;
  // The book owner already removed its row for a terminal progress; only a
  // local book still needs the removal and the admission close here.
  if (resolveLocalBookOwner(newState, route).isCurrent) {
    removeOrRouteCrossJurisdictionBookOrder(env, newState, route, outputs, 'fill_closed', storageChanges);
  }
  requestClearFromSourceHub(newState, route, Boolean(fill.cancelRemainder), outputs);
  return true;
};

/**
 * Book-owner entry point for a matched or cancelled cross-j order. Applies the
 * progress to the admitted route and book row, then hands the same progress
 * to the source Hub: locally when it is this Entity, otherwise as a durable
 * sibling output. Nothing here touches an Account frame.
 */
export const applyCrossJurisdictionOrderbookFill = (
  env: EntityRuntimeContext,
  newState: EntityState,
  instruction: CrossJurisdictionFillInstruction,
  outputs: EntityOutput[],
  storageChanges: RuntimeOverlayRecord[],
): void => {
  const data = buildCrossJurisdictionFillProgressData(instruction);
  applyCrossJurisdictionBookFillToState(env, newState, instruction.accountId, data, storageChanges);
  const sourceHub = normalizeEntityRef(instruction.route.source.counterpartyEntityId);
  if (sourceHub === normalizeEntityRef(newState.entityId)) {
    applySourceHubCrossJurisdictionFillProgress(env, newState, data, outputs, storageChanges);
    return;
  }
  outputs.push(buildCrossJurisdictionFillNoticeOutput(instruction));
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
  return false;
}
