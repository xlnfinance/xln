import {
  buildCrossJurisdictionCloseProof,
  getCrossJurisdictionCommittedProofRatio,
  hashCrossJurisdictionCloseBinary,
  isCrossJurisdictionRouteTransitionAllowed,
  isCrossJurisdictionTerminalStatus,
  transitionCrossJurisdictionRouteStatus,
} from '../../../extensions/cross-j/index';
import { verifyHashLadderBinary } from '../../../protocol/htlc/hash-ladder';
import { addMessage, cloneEntityState } from '../../../state-helpers';
import type { EntityInput, EntityState, EntityTx, Env } from '../../../types';
import { formatEntityId } from '../../../utils';
import { findAccountKey, normalizeEntityRef } from '../account-key';
import { findCrossJurisdictionPullRoute, isCrossJurisdictionPullCancelWithinClear } from '../cross-jurisdiction-helpers';
import type { ApplyEntityTxOptions } from '../apply';
import type { MempoolOp } from './account';

type PullLockTx = Extract<EntityTx, { type: 'pullLock' }>;
type ResolvePullTx = Extract<EntityTx, { type: 'resolvePull' }>;
type CrossPullCloseTx = Extract<EntityTx, { type: 'crossPullClose' }>;
type CancelPullTx = Extract<EntityTx, { type: 'cancelPull' | 'pullCancelExpired' }>;
type PullResult = { newState: EntityState; outputs: EntityInput[]; mempoolOps: MempoolOp[] };

const now = (state: EntityState, env: Env): number => Number(state.timestamp || env.timestamp || 0);
const createResult = (state: EntityState, options?: ApplyEntityTxOptions): PullResult => ({
  newState: options?.mutableFrameState ? state : cloneEntityState(state),
  outputs: [],
  mempoolOps: [],
});
const fail = (result: PullResult, message: string): PullResult => {
  addMessage(result.newState, message);
  return result;
};
const requestFrame = (state: EntityState, outputs: EntityInput[]): void => {
  const signerId = state.config.validators[0];
  if (signerId) outputs.push({ entityId: state.entityId, signerId, entityTxs: [] });
};

const resolveCounterparty = (result: PullResult, counterpartyEntityId: string, action: 'lock' | 'resolve' | 'cancel'): string | null => {
  const accountId = findAccountKey(result.newState, counterpartyEntityId);
  if (!accountId) fail(result, `❌ Pull ${action} failed: no account with ${formatEntityId(counterpartyEntityId)}`);
  return accountId;
};

export const handlePullLockEntityTx = (_env: Env, state: EntityState, tx: PullLockTx, options?: ApplyEntityTxOptions): PullResult => {
  const result = createResult(state, options);
  const {
    counterpartyEntityId,
    pullId,
    tokenId,
    amount,
    revealedUntilTimestamp,
    fullHash,
    partialRoot,
    crossJurisdiction,
    crossJurisdictionRoute,
  } = tx.data;
  const accountId = resolveCounterparty(result, counterpartyEntityId, 'lock');
  if (!accountId) return result;
  result.mempoolOps.push({
    accountId,
    tx: {
      type: 'pull_lock',
      data: {
        pullId,
        tokenId: Number(tokenId),
        amount: BigInt(amount),
        revealedUntilTimestamp: Number(revealedUntilTimestamp),
        fullHash,
        partialRoot,
        ...(crossJurisdiction ? { crossJurisdiction } : {}),
        ...(crossJurisdictionRoute ? { crossJurisdictionRoute } : {}),
      },
    },
  });
  // Cross-j sibling delivery is already being applied inside a committed
  // Entity frame. Its Account mempool op is proposed before that same frame
  // completes, so a self-wake would create a redundant Runtime input. Ordinary
  // user pull commands retain the historical wake until their wider flow is
  // reviewed independently.
  if (!crossJurisdiction) requestFrame(state, result.outputs);
  return result;
};

const findCrossSourceRoute = (state: EntityState, pullId: string, counterpartyEntityId: string) =>
  [...(state.crossJurisdictionSwaps?.values?.() ?? [])].find(route =>
    route.sourcePull?.pullId === pullId &&
    normalizeEntityRef(route.source.counterpartyEntityId) === normalizeEntityRef(state.entityId) &&
    normalizeEntityRef(route.source.entityId) === normalizeEntityRef(counterpartyEntityId),
  );

const findCrossTargetRoute = (state: EntityState, pullId: string, counterpartyEntityId: string) =>
  [...(state.crossJurisdictionSwaps?.values?.() ?? [])].find(route =>
    route.targetPull?.pullId === pullId &&
    normalizeEntityRef(route.target.counterpartyEntityId) === normalizeEntityRef(state.entityId) &&
    normalizeEntityRef(route.target.entityId) === normalizeEntityRef(counterpartyEntityId),
  );

const findCrossTargetHubRoute = (state: EntityState, pullId: string, counterpartyEntityId: string) =>
  [...(state.crossJurisdictionSwaps?.values?.() ?? [])].find(route =>
    route.targetPull?.pullId === pullId &&
    normalizeEntityRef(route.target.entityId) === normalizeEntityRef(state.entityId) &&
    normalizeEntityRef(route.target.counterpartyEntityId) === normalizeEntityRef(counterpartyEntityId),
  );

const closeProofsMatch = (
  left: CrossPullCloseTx['data']['proof'] | undefined,
  right: CrossPullCloseTx['data']['proof'] | undefined,
): boolean => {
  if (!left || !right) return false;
  return left.orderId === right.orderId &&
    (left.routeHash || '').toLowerCase() === (right.routeHash || '').toLowerCase() &&
    left.sourcePullId === right.sourcePullId &&
    left.targetPullId === right.targetPullId &&
    left.fillRatio === right.fillRatio &&
    left.cumulativeSourceAmount === right.cumulativeSourceAmount &&
    left.cumulativeTargetAmount === right.cumulativeTargetAmount &&
    (left.binaryHash || '').toLowerCase() === (right.binaryHash || '').toLowerCase() &&
    left.closeMode === right.closeMode;
};

const proofRouteError = (
  route: NonNullable<ReturnType<typeof findCrossSourceRoute>> | NonNullable<ReturnType<typeof findCrossTargetRoute>>,
  proof: CrossPullCloseTx['data']['proof'],
  binary: string,
  leg: 'source' | 'target',
  commandRoute?: CrossPullCloseTx['data']['route'],
): string | null => {
  const routeHash = String(route.routeHash || '').toLowerCase();
  if (!routeHash) return 'route hash missing';
  if ((proof.routeHash || '').toLowerCase() !== routeHash) return `route hash ${proof.routeHash} != ${routeHash}`;
  if (commandRoute) {
    if (commandRoute.orderId !== proof.orderId) return `command route order ${commandRoute.orderId} != ${proof.orderId}`;
    if ((commandRoute.routeHash || '').toLowerCase() !== (proof.routeHash || '').toLowerCase()) {
      return `command route hash ${commandRoute.routeHash} != ${proof.routeHash}`;
    }
    if (commandRoute.sourcePull?.pullId !== proof.sourcePullId) {
      return `command source pull ${commandRoute.sourcePull?.pullId} != ${proof.sourcePullId}`;
    }
    if (commandRoute.targetPull?.pullId !== proof.targetPullId) {
      return `command target pull ${commandRoute.targetPull?.pullId} != ${proof.targetPullId}`;
    }
  }
  if (proof.orderId !== route.orderId) return `order ${proof.orderId} != ${route.orderId}`;
  if (!route.sourcePull || !route.targetPull) return 'pull commitments missing';
  if (proof.sourcePullId !== route.sourcePull.pullId) return `source pull ${proof.sourcePullId} != ${route.sourcePull.pullId}`;
  if (proof.targetPullId !== route.targetPull.pullId) return `target pull ${proof.targetPullId} != ${route.targetPull.pullId}`;
  const expectedPullId = leg === 'source' ? route.sourcePull.pullId : route.targetPull.pullId;
  if ((leg === 'source' ? proof.sourcePullId : proof.targetPullId) !== expectedPullId) return `${leg} pull mismatch`;
  if ((proof.binaryHash || '').toLowerCase() !== hashCrossJurisdictionCloseBinary(binary).toLowerCase()) {
    return 'binary hash mismatch';
  }
  const commitment = leg === 'source' ? route.sourcePull : route.targetPull;
  const decoded = verifyHashLadderBinary({ fullHash: commitment.fullHash, partialRoot: commitment.partialRoot }, binary);
  if (decoded.fillRatio !== proof.fillRatio) return `binary ratio ${decoded.fillRatio} != proof ${proof.fillRatio}`;
  if (leg === 'target') {
    const sourceProof = route.sourceCloseProof ?? commandRoute?.sourceCloseProof;
    if (!sourceProof) return 'source close proof missing';
    if (!closeProofsMatch(sourceProof, proof)) return 'source close proof mismatch';
  }
  const routeRatio = getCrossJurisdictionCommittedProofRatio(route);
  if (leg === 'source' || routeRatio > 0) {
    const expectedProof = buildCrossJurisdictionCloseProof(route, binary);
    if (proof.fillRatio !== expectedProof.fillRatio) return `ratio ${proof.fillRatio} != ${expectedProof.fillRatio}`;
    if (proof.cumulativeSourceAmount !== expectedProof.cumulativeSourceAmount) {
      return `source amount ${proof.cumulativeSourceAmount} != ${expectedProof.cumulativeSourceAmount}`;
    }
    if (proof.cumulativeTargetAmount !== expectedProof.cumulativeTargetAmount) {
      return `target amount ${proof.cumulativeTargetAmount} != ${expectedProof.cumulativeTargetAmount}`;
    }
    if (proof.closeMode !== expectedProof.closeMode) return `mode ${proof.closeMode} != ${expectedProof.closeMode}`;
  }
  return null;
};

export const handleResolvePullEntityTx = (_env: Env, state: EntityState, tx: ResolvePullTx, options?: ApplyEntityTxOptions): PullResult => {
  const result = createResult(state, options);
  const { counterpartyEntityId, pullId, binary } = tx.data;
  const accountId = resolveCounterparty(result, counterpartyEntityId, 'resolve');
  if (!accountId) return result;
  const sourceRoute = findCrossSourceRoute(result.newState, pullId, counterpartyEntityId);
  if (sourceRoute && sourceRoute.status !== 'clearing') {
    return fail(result, `❌ Cross-j source pull ${pullId.slice(0, 8)} resolve blocked: use requestCrossJurisdictionClear`);
  }
  const targetRoute = findCrossTargetRoute(result.newState, pullId, counterpartyEntityId);
  if (targetRoute) {
    return fail(
      result,
      `❌ Cross-j target pull ${pullId.slice(0, 8)} resolve blocked: only the Hub atomic close cohort may settle it`,
    );
  }
  result.mempoolOps.push({
    accountId,
    tx: { type: 'pull_resolve', data: { pullId, binary } },
  });
  requestFrame(state, result.outputs);
  return result;
};

export const handleCrossPullCloseEntityTx = (env: Env, state: EntityState, tx: CrossPullCloseTx, options?: ApplyEntityTxOptions): PullResult => {
  const result = createResult(state, options);
  const { counterpartyEntityId, pullId, binary, proof, route: commandRoute } = tx.data;
  const accountId = resolveCounterparty(result, counterpartyEntityId, 'resolve');
  if (!accountId) return result;
  const sourceRoute = findCrossSourceRoute(result.newState, pullId, counterpartyEntityId);
  const targetRoute = findCrossTargetHubRoute(result.newState, pullId, counterpartyEntityId);
  const route = sourceRoute ?? targetRoute;
  if (!route) return fail(result, `❌ Cross-j pull close ${pullId.slice(0, 8)} blocked: route missing`);
  const leg = sourceRoute ? 'source' : 'target';
  if (isCrossJurisdictionTerminalStatus(route.status)) {
    return fail(result, `❌ Cross-j ${leg} pull close ${pullId.slice(0, 8)} blocked: route ${route.status}`);
  }
  if (leg === 'source' && route.status !== 'clearing' && route.status !== 'clear_requested') {
    return fail(result, `❌ Cross-j source pull close ${pullId.slice(0, 8)} blocked: route ${route.status}`);
  }
  const proofError = proofRouteError(route, proof, binary, leg, commandRoute);
  if (proofError) return fail(result, `❌ Cross-j ${leg} pull close ${pullId.slice(0, 8)} blocked: ${proofError}`);
  route.sourceCloseProof = proof;
  if (leg === 'target') {
    route.cumulativeFillRatio = proof.fillRatio;
    route.claimedRatio = proof.fillRatio;
    route.filledSourceAmount = proof.cumulativeSourceAmount;
    route.filledTargetAmount = proof.cumulativeTargetAmount;
    route.sourceClaimed = proof.cumulativeSourceAmount;
    route.targetClaimed = proof.cumulativeTargetAmount;
    route.clearingPolicy = 'cancel_and_clear';
    route.pendingClearRequestedAt ||= now(result.newState, env);
    if (!isCrossJurisdictionRouteTransitionAllowed(route.status, 'clearing')) {
      return fail(result, `❌ Cross-j target pull close ${pullId.slice(0, 8)} blocked: route ${route.status}->clearing`);
    }
    transitionCrossJurisdictionRouteStatus(route, 'clearing', result.newState.timestamp || env.timestamp);
  }
  result.newState.crossJurisdictionSwaps?.set(route.orderId, route);
  result.mempoolOps.push({ accountId, tx: { type: 'cross_pull_close', data: { pullId, binary, proof } } });
  requestFrame(state, result.outputs);
  return result;
};

export const handleCancelPullEntityTx = (_env: Env, state: EntityState, tx: CancelPullTx, options?: ApplyEntityTxOptions): PullResult => {
  const result = createResult(state, options);
  const { counterpartyEntityId, pullId } = tx.data;
  const accountId = resolveCounterparty(result, counterpartyEntityId, 'cancel');
  if (!accountId) return result;
  const crossPullRoute = findCrossJurisdictionPullRoute(result.newState, pullId);
  if (
    crossPullRoute &&
    !isCrossJurisdictionTerminalStatus(crossPullRoute.route.status) &&
    !isCrossJurisdictionPullCancelWithinClear(crossPullRoute.route)
  ) {
    return fail(
      result,
      `❌ Cross-j ${crossPullRoute.leg} pull ${pullId.slice(0, 8)} cancel blocked: route ${crossPullRoute.route.orderId} must clear through requestCrossJurisdictionClear`,
    );
  }
  result.mempoolOps.push({
    accountId,
    tx: { type: 'pull_cancel', data: { pullId, reason: tx.type === 'pullCancelExpired' ? 'expired' : 'beneficiary_release' } },
  });
  requestFrame(state, result.outputs);
  addMessage(result.newState, `🪝 Pull cancel queued: ${pullId.slice(0, 8)}`);
  return result;
};
