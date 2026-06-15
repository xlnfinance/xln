import type { AccountTx, CrossJurisdictionSwapRoute, EntityInput, EntityState, EntityTx, Env } from '../../types';
import {
  cloneCrossJurisdictionRoute,
  CROSS_J_MAX_FILL_RATIO,
  applyCrossJurisdictionFillProgress,
  isCrossJurisdictionTerminalStatus,
  transitionCrossJurisdictionRouteStatus,
  withCrossJurisdictionClaimProgress,
} from '../../cross-jurisdiction';
import { deriveCanonicalCrossJurisdictionBookOwner } from '../../cross-jurisdiction-market';
import {
  buildCrossJurisdictionBookAdmissionReceipt,
  getCrossJurisdictionBookReceiptError,
  markCrossJurisdictionBookAdmissionClosed,
} from '../../cross-jurisdiction-orderbook';
import { decodeHashLadderBinary } from '../../hashladder';
import { createStructuredLogger, shortId, shortOrder } from '../../logger';
import { removeCrossJurisdictionBookOrder } from '../../orderbook/cross-j';
import { resolveEntityProposerId } from '../../state-helpers';
import {
  buildCrossJurisdictionEntityOutput,
  crossJurisdictionRouteSignerHint,
  findLocalEntityState,
} from '../cross-j-outputs';
import { applyCrossJurisdictionBookProgressToState } from './cross-j-book-order';

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
  }], crossJurisdictionRouteSignerHint(route, owner.ownerId)));
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
  env: Env,
  newState: EntityState,
  route: CrossJurisdictionSwapRoute,
  accountTx: Extract<AccountTx, { type: 'cross_swap_fill_ack' }>,
  outputs: EntityInput[],
): void => {
  const tx = buildCrossJurisdictionBookProgressTx(route, accountTx, 'fill_ack_committed');
  const owner = resolveLocalBookOwner(env, newState, route);
  if (owner.isCurrent) {
    // Source account consensus has committed the ACK in this same entity frame.
    // Apply the book-owner projection immediately; waiting for a self-output
    // would leave one matcher tick with updated account state and stale book qty.
    applyCrossJurisdictionBookProgressToState(env, newState, tx.data);
    return;
  }
  outputs.push(buildCrossJurisdictionEntityOutput(
    env,
    owner.ownerId,
    [tx],
    crossJurisdictionRouteSignerHint(route, owner.ownerId),
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
  if (leg === 'source' && (!binding.targetReceipt || binding.targetReceipt.leg !== 'target')) {
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
      const targetReceipt = accountTx.data.crossJurisdiction?.targetReceipt;
      if (!targetReceipt) {
        throw new Error(`CROSS_J_SOURCE_PULL_TARGET_RECEIPT_MISSING: route=${route.orderId}`);
      }
      const receiptError = getCrossJurisdictionBookReceiptError(route, targetReceipt);
      if (receiptError) {
        throw new Error(`CROSS_J_SOURCE_PULL_TARGET_RECEIPT_INVALID: route=${route.orderId} ${receiptError}`);
      }
      // This is the source-hub counterpart of book admission: the account frame
      // has now committed the source pull_lock whose binding already contains
      // the exact target receipt. From this point the source account can accept
      // a fill ACK, so the source entity route must become `resting` here.
      //
      // Do not let the fill-notice handler "repair" this from account offers.
      // That rehydration masks dropped committed followups and lets matcher
      // state run ahead of the source account consensus.
      admissionRoute.targetReceipt = targetReceipt;
      transitionCrossJurisdictionRouteStatus(admissionRoute, 'resting', committedAt);
      Object.assign(route, admissionRoute);
      newState.crossJurisdictionSwaps?.set(route.orderId, route);
    }
    const receipt = buildCrossJurisdictionBookAdmissionReceipt(
      admissionRoute,
      leg,
      accountTx,
      newState.entityId,
      counterpartyId,
      committedAt,
    );
    if (leg === 'target') {
      // Target-first escrow invariant: source funds are never locked from the
      // source account until the target account has committed this exact pull
      // receipt. The receipt is copied into the source commit and later into
      // the source pull binding, so raw account txs cannot pretend target-side
      // safety happened.
      admissionRoute.targetReceipt = receipt;
      transitionCrossJurisdictionRouteStatus(admissionRoute, 'target_locked', committedAt);
      Object.assign(route, admissionRoute);
      newState.crossJurisdictionSwaps?.set(route.orderId, route);
      outputs.push(buildCrossJurisdictionEntityOutput(env, route.source.entityId, [{
        type: 'commitCrossJurisdictionSwap',
        data: {
          route: admissionRoute,
          targetReceipt: receipt,
        },
      }], route.sourceSignerId));
    }

    const bookOwnerEntityId = routeBookOwnerEntityId(route);
    outputs.push(buildCrossJurisdictionEntityOutput(env, bookOwnerEntityId, [{
      type: 'admitCrossJurisdictionBookOrder',
      data: {
        route: admissionRoute,
        receipt,
        reason: `${leg}_pull_committed`,
      },
    }], crossJurisdictionRouteSignerHint(route, bookOwnerEntityId)));
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
      outputs.push(buildCrossJurisdictionEntityOutput(
        env,
        route.target.counterpartyEntityId,
        targetEntityTxs,
        route.targetSignerId,
      ));
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

const applyCrossPullCloseFollowup = (
  env: Env,
  newState: EntityState,
  counterpartyId: string,
  accountTx: Extract<AccountTx, { type: 'cross_pull_close' }>,
  outputs: EntityInput[],
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
      assertPullResolveAllowed(route, fillRatio, 'source');
      backfillCommittedFillFromResolvedPull(route, fillRatio, newState.timestamp);
      Object.assign(route, withCrossJurisdictionClaimProgress(route, fillRatio, newState.timestamp));
      route.sourceCloseProof = accountTx.data.proof;
      transitionCrossJurisdictionRouteStatus(route, 'source_claimed', newState.timestamp);

      const targetPull = route.targetPull;
      if (isSourceUserClose && targetPull) {
        outputs.push(buildCrossJurisdictionEntityOutput(
          env,
          route.target.counterpartyEntityId,
          [{
            type: 'crossPullClose',
            data: {
              counterpartyEntityId: route.target.entityId,
              pullId: targetPull.pullId,
              binary: accountTx.data.binary,
              proof: accountTx.data.proof,
              route: cloneCrossJurisdictionRoute(route),
              description: `Cross-j ${route.orderId} target close ${fillRatio}/65535`,
            },
          }],
          route.targetSignerId,
        ));
      }
      removeOrRouteCrossJurisdictionBookOrder(env, newState, route, outputs, 'source_claimed');
      crossJFollowupLog.debug('pull.close.relay_target', {
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
      route.sourceCloseProof = accountTx.data.proof;
      route.targetCloseProof = accountTx.data.proof;
      transitionCrossJurisdictionRouteStatus(route, 'settled', newState.timestamp);
      route.settledAt = newState.timestamp;
      removeOrRouteCrossJurisdictionBookOrder(env, newState, route, outputs, 'settled');
      crossJFollowupLog.debug('pull.close.settled', {
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
  if (!route) {
    // A committed account ACK is canonical money progress. If the entity route
    // mirror is gone, silently accepting the ACK leaves the shared book stale
    // and hides projection corruption. Never rehydrate or skip here.
    throw new Error(
      `CROSS_J_FILL_ACK_ROUTE_MISSING: entity=${shortId(newState.entityId)} ` +
      `offer=${shortOrder(accountTx.data.offerId, 12)} ratio=${ratio} cancel=${Boolean(accountTx.data.cancelRemainder)}`,
    );
  }

  const currentRatio = committedCrossJurisdictionRatio(route);
  const previousStatus = route.status;
  if (accountTx.data.cancelRemainder && ratio <= currentRatio) {
    transitionCrossJurisdictionRouteStatus(route, 'clear_requested', newState.timestamp);
    route.clearingPolicy = 'cancel_and_clear';
  } else {
    const nextRoute = applyCrossJurisdictionFillProgress(route, {
      fillSeq: accountTx.data.fillSeq,
      cumulativeFillRatio: ratio,
      // The account frame is the committed source of truth. Cross-j runtime
      // economics use exact ratios; the uint16 ratio exists for hash-ladder /
      // dispute projection only. Dropping these fields here reintroduces
      // 16384/65535 dust drift and bricks valid 1/4 fills post-commit.
      fillNumerator: accountTx.data.fillNumerator,
      fillDenominator: accountTx.data.fillDenominator,
      incrementalSourceAmount: accountTx.data.incrementalSourceAmount,
      incrementalTargetAmount: accountTx.data.incrementalTargetAmount,
      cumulativeSourceAmount: accountTx.data.cumulativeSourceAmount,
      cumulativeTargetAmount: accountTx.data.cumulativeTargetAmount,
    }, newState.timestamp, 'CROSS_J_COMMITTED_FILL_ACK_INVALID');
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
  crossJFollowupLog.debug('fill_ack.applied', {
    entity: shortId(newState.entityId),
    offer: shortOrder(accountTx.data.offerId, 12),
    previousStatus,
    status: route.status,
    ratio,
    fillSeq: route.fillSeq,
    cancel: accountTx.data.cancelRemainder,
  });

  if (
    normalizeEntityRef(newState.entityId) === normalizeEntityRef(route.source.counterpartyEntityId)
  ) {
    if (ratio >= CROSS_J_MAX_FILL_RATIO || accountTx.data.cancelRemainder) {
      removeOrRouteCrossJurisdictionBookOrder(env, newState, route, outputs, 'fill_ack_closed');
      outputs.push({
        entityId: newState.entityId,
        signerId: resolveEntityProposerId(env, newState.entityId, 'cross-j.clear-after-fill-ack'),
        entityTxs: [{
          type: 'requestCrossJurisdictionClear',
          data: {
            orderId: route.orderId,
            cancelRemainder: Boolean(accountTx.data.cancelRemainder),
          },
        }],
      });
    } else {
      applyOrRouteCrossJurisdictionBookProgress(env, newState, route, accountTx, outputs);
    }
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
  if (accountTx.type === 'cross_pull_close') {
    return applyCrossPullCloseFollowup(env, newState, counterpartyId, accountTx, outputs);
  }
  if (accountTx.type === 'cross_swap_fill_ack') {
    return applyFillAckFollowup(env, newState, accountTx, outputs);
  }
  return false;
}
