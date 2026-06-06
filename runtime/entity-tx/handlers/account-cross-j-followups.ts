import type { AccountTx, CrossJurisdictionSwapRoute, EntityInput, EntityState, EntityTx, Env } from '../../types';
import {
  cloneCrossJurisdictionRoute,
  CROSS_J_MAX_FILL_RATIO,
  isCrossJurisdictionTerminalStatus,
  transitionCrossJurisdictionRouteStatus,
  validateCrossJurisdictionFillProgress,
  withCrossJurisdictionClaimProgress,
  withCrossJurisdictionFillProgress,
} from '../../cross-jurisdiction';
import { deriveCanonicalCrossJurisdictionBookOwner } from '../../cross-jurisdiction-market';
import {
  buildCrossJurisdictionBookAdmissionReceipt,
  markCrossJurisdictionBookAdmissionClosed,
} from '../../cross-jurisdiction-orderbook';
import { decodeHashLadderBinary } from '../../hashladder';
import { createStructuredLogger, shortId, shortOrder } from '../../logger';
import { removeCrossJurisdictionBookOrder } from '../../orderbook/cross-j';
import { buildCrossJurisdictionEntityOutput, findLocalEntityState } from '../cross-j-outputs';

const crossJFollowupLog = createStructuredLogger('crossj.followup');

const normalizeEntityRef = (value: string): string => String(value || '').toLowerCase();

const clampFillRatio = (value: unknown): number =>
  Math.max(0, Math.min(CROSS_J_MAX_FILL_RATIO, Math.floor(Number(value) || 0)));

const committedCrossJurisdictionRatio = (route: CrossJurisdictionSwapRoute): number =>
  Math.max(clampFillRatio(route.cumulativeFillRatio), clampFillRatio(route.claimedRatio));

const assertPullResolveAllowed = (
  route: CrossJurisdictionSwapRoute,
  fillRatio: number,
  leg: 'source' | 'target',
): void => {
  if (fillRatio <= 0) return;
  if (isCrossJurisdictionTerminalStatus(route.status)) {
    throw new Error(`CROSS_J_PULL_RESOLVE_STATE_INVALID: route=${route.orderId} status=${route.status}`);
  }
  if (leg === 'source' && route.status !== 'clearing' && route.status !== 'clear_requested') {
    throw new Error(`CROSS_J_PULL_RESOLVE_STATE_INVALID: route=${route.orderId} leg=source status=${route.status}`);
  }
  if (leg === 'target' && route.status !== 'clearing' && route.status !== 'source_claimed') {
    throw new Error(`CROSS_J_PULL_RESOLVE_STATE_INVALID: route=${route.orderId} leg=target status=${route.status}`);
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
  const validatedFill = validateCrossJurisdictionFillProgress(route, {
    cumulativeFillRatio: fillRatio,
  });
  if (!validatedFill.ok) {
    throw new Error(`CROSS_J_PULL_RESOLVE_NO_COMMITTED_FILL: route=${route.orderId} ${validatedFill.error}`);
  }

  // Network delivery may commit the bilateral pull_resolve before the route's
  // cross_swap_fill_ack mirror reaches this runtime. The pull_resolve is itself
  // a committed account frame carrying a valid hash-ladder reveal, so we can
  // backfill the committed fill fields while preserving the current lifecycle
  // status chosen by the route FSM.
  const { status: _status, ...fillFields } = withCrossJurisdictionFillProgress(route, validatedFill.value, updatedAt);
  Object.assign(route, fillFields);
};

const routeBookOwnerEntityId = (route: CrossJurisdictionSwapRoute): string =>
  normalizeEntityRef(route.bookOwnerEntityId || deriveCanonicalCrossJurisdictionBookOwner(route));

const resolveLocalBookOwner = (
  env: Env,
  newState: EntityState,
  route: CrossJurisdictionSwapRoute,
): { ownerId: string; ownerState: EntityState | null; signerId: string | null; isCurrent: boolean } => {
  const ownerId = routeBookOwnerEntityId(route);
  const currentId = normalizeEntityRef(newState.entityId);
  if (!ownerId || ownerId === currentId) {
    return {
      ownerId: newState.entityId,
      ownerState: newState,
      signerId: newState.config?.validators?.[0] || null,
      isCurrent: true,
    };
  }
  const ownerState = findLocalEntityState(env, ownerId);
  const signerId = ownerState?.config?.validators?.[0];
  return { ownerId: ownerState?.entityId || ownerId, ownerState, signerId: signerId || null, isCurrent: false };
};

const removeOrRouteCrossJurisdictionBookOrder = (
  env: Env,
  newState: EntityState,
  route: CrossJurisdictionSwapRoute,
  outputs: EntityInput[],
  reason: string,
): void => {
  const owner = resolveLocalBookOwner(env, newState, route);
  if (owner.isCurrent) {
    removeCrossJurisdictionBookOrder(env, newState, route);
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
  }]));
};

const committedPullMatchesRoute = (
  accountTx: Extract<AccountTx, { type: 'pull_lock' }>,
  route: CrossJurisdictionSwapRoute,
  leg: 'source' | 'target',
): boolean => {
  const pull = leg === 'source' ? route.sourcePull : route.targetPull;
  if (!pull) return false;
  return (
    accountTx.data.pullId === pull.pullId &&
    accountTx.data.tokenId === pull.tokenId &&
    accountTx.data.amount === pull.signedAmount &&
    (accountTx.data.fullHash || '').toLowerCase() === pull.fullHash.toLowerCase() &&
    (accountTx.data.partialRoot || '').toLowerCase() === pull.partialRoot.toLowerCase() &&
    accountTx.data.revealedUntilTimestamp === pull.revealedUntilTimestamp
  );
};

const queueBookAdmissionOnCommittedPull = (
  env: Env,
  newState: EntityState,
  counterpartyId: string,
  accountTx: Extract<AccountTx, { type: 'pull_lock' }>,
  outputs: EntityInput[],
): boolean => {
  const currentEntityId = normalizeEntityRef(newState.entityId);
  const counterpartyEntityId = normalizeEntityRef(counterpartyId);
  let handled = false;

  for (const route of newState.crossJurisdictionSwaps?.values?.() ?? []) {
    const sourceHubId = normalizeEntityRef(route.source.counterpartyEntityId);
    const sourceUserId = normalizeEntityRef(route.source.entityId);
    const targetHubId = normalizeEntityRef(route.target.entityId);
    const targetUserId = normalizeEntityRef(route.target.counterpartyEntityId);
    const sourceHubCommitted =
      route.sourcePull?.pullId === accountTx.data.pullId &&
      currentEntityId === sourceHubId &&
      counterpartyEntityId === sourceUserId;
    const targetHubCommitted =
      route.targetPull?.pullId === accountTx.data.pullId &&
      currentEntityId === targetHubId &&
      counterpartyEntityId === targetUserId;
    if (!sourceHubCommitted && !targetHubCommitted) continue;

    const leg = sourceHubCommitted ? 'source' : 'target';
    if (!committedPullMatchesRoute(accountTx, route, leg)) {
      throw new Error(`CROSS_J_COMMITTED_PULL_ROUTE_MISMATCH: route=${route.orderId} leg=${leg} pull=${accountTx.data.pullId}`);
    }
    const committedAt = Number(newState.timestamp || env.timestamp || 0);
    const admissionRoute = cloneCrossJurisdictionRoute(route);
    if (leg === 'source') {
      admissionRoute.status = 'resting';
      admissionRoute.updatedAt = committedAt;
    }
    const receipt = buildCrossJurisdictionBookAdmissionReceipt(
      admissionRoute,
      leg,
      accountTx,
      newState.entityId,
      counterpartyId,
      committedAt,
    );

    outputs.push(buildCrossJurisdictionEntityOutput(env, routeBookOwnerEntityId(route), [{
      type: 'admitCrossJurisdictionBookOrder',
      data: {
        route: admissionRoute,
        receipt,
        reason: `${leg}_pull_committed`,
      },
    }]));
    handled = true;
  }

  return handled;
};

const applyPullResolveFollowup = (
  env: Env,
  newState: EntityState,
  counterpartyId: string,
  accountTx: Extract<AccountTx, { type: 'pull_resolve' }>,
  outputs: EntityInput[],
): boolean => {
  let fillRatio = 0;
  try {
    fillRatio = decodeHashLadderBinary(accountTx.data.binary).fillRatio;
  } catch {
    fillRatio = 0;
  }
  if (fillRatio <= 0 || !newState.crossJurisdictionSwaps?.size) return true;

  const currentEntityId = normalizeEntityRef(newState.entityId);
  const counterpartyEntityId = normalizeEntityRef(counterpartyId);

  for (const route of newState.crossJurisdictionSwaps.values()) {
    const sourceUserId = normalizeEntityRef(route.source.entityId);
    const sourceHubId = normalizeEntityRef(route.source.counterpartyEntityId);
    const targetHubId = normalizeEntityRef(route.target.entityId);
    const targetUserId = normalizeEntityRef(route.target.counterpartyEntityId);
    const isSourceHubResolve =
      route.sourcePull?.pullId === accountTx.data.pullId &&
      route.targetPull?.pullId !== undefined &&
      currentEntityId === sourceHubId &&
      counterpartyEntityId === sourceUserId;
    const isSourceUserResolve =
      route.sourcePull?.pullId === accountTx.data.pullId &&
      currentEntityId === sourceUserId &&
      counterpartyEntityId === sourceHubId;

    if (isSourceHubResolve || isSourceUserResolve) {
      assertPullResolveAllowed(route, fillRatio, 'source');
      backfillCommittedFillFromResolvedPull(route, fillRatio, newState.timestamp);
      Object.assign(route, withCrossJurisdictionClaimProgress(route, fillRatio, newState.timestamp));
      transitionCrossJurisdictionRouteStatus(route, 'source_claimed', newState.timestamp);

      // The same account frame commits on both source participants. Only the hub
      // side is allowed to relay the binary to the target leg; the user side
      // still has to mirror the route lifecycle for local UI/storage convergence.
      if (isSourceUserResolve) {
        continue;
      }

      const targetPull = route.targetPull;
      if (!targetPull) continue;
      const targetEntityTxs: EntityTx[] = [{
        type: 'resolvePull',
        data: {
          counterpartyEntityId: route.target.entityId,
          pullId: targetPull.pullId,
          binary: accountTx.data.binary,
          description: `Cross-j ${route.orderId} target pull ${fillRatio}/65535`,
        },
      }];
      if (
        fillRatio >= CROSS_J_MAX_FILL_RATIO ||
        route.clearingPolicy === 'cancel_and_clear' ||
        route.clearingPolicy === 'full_fill'
      ) {
        targetEntityTxs.push({
          type: 'cancelPull',
          data: {
            counterpartyEntityId: route.target.entityId,
            pullId: targetPull.pullId,
            description: `Cross-j ${route.orderId} release target remainder`,
          },
        });
      }
      outputs.push(buildCrossJurisdictionEntityOutput(env, route.target.counterpartyEntityId, targetEntityTxs));
      removeOrRouteCrossJurisdictionBookOrder(env, newState, route, outputs, 'source_claimed');
      crossJFollowupLog.debug('pull.resolve.relay_target', {
        route: shortOrder(route.orderId, 12),
        target: shortId(route.target.counterpartyEntityId),
        ratio: fillRatio,
      });
      continue;
    }

    if (
      route.targetPull?.pullId === accountTx.data.pullId &&
      currentEntityId === targetUserId &&
      counterpartyEntityId === targetHubId
    ) {
      assertPullResolveAllowed(route, fillRatio, 'target');
      backfillCommittedFillFromResolvedPull(route, fillRatio, newState.timestamp);
      Object.assign(route, withCrossJurisdictionClaimProgress(route, fillRatio, newState.timestamp));
      transitionCrossJurisdictionRouteStatus(route, 'settled', newState.timestamp);
      route.settledAt = newState.timestamp;
      removeOrRouteCrossJurisdictionBookOrder(env, newState, route, outputs, 'settled');
      crossJFollowupLog.debug('pull.resolve.settled', {
        route: shortOrder(route.orderId, 12),
        ratio: fillRatio,
      });
    }
  }
  return true;
};

const applyFillAckFollowup = (
  env: Env,
  newState: EntityState,
  accountTx: Extract<AccountTx, { type: 'cross_swap_fill_ack' }>,
  outputs: EntityInput[],
): boolean => {
  const ratio = clampFillRatio(accountTx.data.cumulativeFillRatio);
  const route = newState.crossJurisdictionSwaps?.get(accountTx.data.offerId);
  if (!route) return true;

  const currentRatio = committedCrossJurisdictionRatio(route);
  if (accountTx.data.cancelRemainder && ratio <= currentRatio) {
    transitionCrossJurisdictionRouteStatus(route, 'clear_requested', newState.timestamp);
    route.clearingPolicy = 'cancel_and_clear';
  } else {
    const validatedFill = validateCrossJurisdictionFillProgress(route, {
      fillSeq: accountTx.data.fillSeq,
      cumulativeFillRatio: ratio,
      incrementalSourceAmount: accountTx.data.incrementalSourceAmount,
      incrementalTargetAmount: accountTx.data.incrementalTargetAmount,
      cumulativeSourceAmount: accountTx.data.cumulativeSourceAmount,
      cumulativeTargetAmount: accountTx.data.cumulativeTargetAmount,
    });
    if (!validatedFill.ok) {
      throw new Error(`CROSS_J_COMMITTED_FILL_ACK_INVALID: ${validatedFill.error}`);
    }
    const nextRoute = withCrossJurisdictionFillProgress(route, validatedFill.value, newState.timestamp);
    transitionCrossJurisdictionRouteStatus(route, nextRoute.status, newState.timestamp);
    Object.assign(route, nextRoute);
    if ((accountTx.data.priceImprovementAmount ?? 0n) > 0n) {
      if (accountTx.data.priceImprovementMode === 'source_savings') {
        route.priceImprovementSourceAmount =
          (route.priceImprovementSourceAmount ?? 0n) + accountTx.data.priceImprovementAmount!;
      } else if (accountTx.data.priceImprovementMode === 'target_bonus') {
        route.priceImprovementTargetAmount =
          (route.priceImprovementTargetAmount ?? 0n) + accountTx.data.priceImprovementAmount!;
      }
    }
    if (accountTx.data.cancelRemainder) {
      transitionCrossJurisdictionRouteStatus(route, 'clear_requested', newState.timestamp);
      route.clearingPolicy = 'cancel_and_clear';
    }
  }
  route.updatedAt = newState.timestamp;

  if (
    (ratio >= CROSS_J_MAX_FILL_RATIO || accountTx.data.cancelRemainder) &&
    normalizeEntityRef(newState.entityId) === normalizeEntityRef(route.source.counterpartyEntityId)
  ) {
    removeOrRouteCrossJurisdictionBookOrder(env, newState, route, outputs, 'fill_ack_closed');
    outputs.push({
      entityId: newState.entityId,
      entityTxs: [{
        type: 'requestCrossJurisdictionClear',
        data: {
          orderId: route.orderId,
          cancelRemainder: Boolean(accountTx.data.cancelRemainder),
        },
      }],
    });
  }
  return true;
};

export function applyCommittedCrossJurisdictionAccountTxFollowup(
  env: Env,
  newState: EntityState,
  counterpartyId: string,
  accountTx: AccountTx,
  outputs: EntityInput[],
): boolean {
  if (accountTx.type === 'pull_lock') {
    return queueBookAdmissionOnCommittedPull(env, newState, counterpartyId, accountTx, outputs);
  }
  if (accountTx.type === 'pull_resolve') {
    return applyPullResolveFollowup(env, newState, counterpartyId, accountTx, outputs);
  }
  if (accountTx.type === 'cross_swap_fill_ack') {
    return applyFillAckFollowup(env, newState, accountTx, outputs);
  }
  return false;
}
