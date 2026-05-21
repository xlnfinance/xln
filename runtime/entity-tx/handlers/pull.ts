import { isCrossJurisdictionRouteTransitionAllowed, isCrossJurisdictionTerminalStatus } from '../../cross-jurisdiction';
import { verifyHashLadderBinary } from '../../hashladder';
import { addMessage, cloneEntityState } from '../../state-helpers';
import type { EntityInput, EntityState, EntityTx, Env } from '../../types';
import { formatEntityId } from '../../utils';
import { findAccountKey, normalizeEntityRef } from '../account-key';
import { findCrossJurisdictionPullRoute, hasCommittedCrossJurisdictionFill, isCrossJurisdictionPullCancelWithinClear } from '../cross-jurisdiction-helpers';
import type { MempoolOp } from './account';

type PullLockTx = Extract<EntityTx, { type: 'pullLock' }>;
type ResolvePullTx = Extract<EntityTx, { type: 'resolvePull' }>;
type CancelPullTx = Extract<EntityTx, { type: 'cancelPull' | 'pullCancelExpired' }>;
type PullResult = { newState: EntityState; outputs: EntityInput[]; mempoolOps: MempoolOp[] };

const now = (state: EntityState, env: Env): number => Number(state.timestamp || env.timestamp || 0);
const createResult = (state: EntityState): PullResult => ({ newState: cloneEntityState(state), outputs: [], mempoolOps: [] });
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

export const handlePullLockEntityTx = (_env: Env, state: EntityState, tx: PullLockTx): PullResult => {
  const result = createResult(state);
  const { counterpartyEntityId, pullId, tokenId, amount, revealedUntilTimestamp, fullHash, partialRoot } = tx.data;
  const accountId = resolveCounterparty(result, counterpartyEntityId, 'lock');
  if (!accountId) return result;
  result.mempoolOps.push({
    accountId,
    tx: {
      type: 'pull_lock',
      data: { pullId, tokenId: Number(tokenId), amount: BigInt(amount), revealedUntilTimestamp: Number(revealedUntilTimestamp), fullHash, partialRoot },
    },
  });
  requestFrame(state, result.outputs);
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

const validateCrossTargetResolve = (result: PullResult, env: Env, pullId: string, counterpartyEntityId: string, binary: string): PullResult | null => {
  const route = findCrossTargetRoute(result.newState, pullId, counterpartyEntityId);
  if (!route) return null;
  const shortPull = pullId.slice(0, 8);
  if (isCrossJurisdictionTerminalStatus(route.status)) {
    return fail(result, `❌ Cross-j target pull ${shortPull} resolve blocked: route ${route.status}`);
  }
  if (!route.targetPull) return fail(result, `❌ Cross-j target pull ${shortPull} resolve blocked: missing commitment`);

  let decodedRatio = 0;
  try {
    decodedRatio = verifyHashLadderBinary({ fullHash: route.targetPull.fullHash, partialRoot: route.targetPull.partialRoot }, binary).fillRatio;
  } catch (error) {
    return fail(result, `❌ Cross-j target pull ${shortPull} resolve blocked: ${error instanceof Error ? error.message : String(error)}`);
  }
  const committedRatio = Math.max(Math.floor(Number(route.cumulativeFillRatio ?? 0) || 0), Math.floor(Number(route.claimedRatio ?? 0) || 0));
  if (decodedRatio <= 0) return fail(result, `❌ Cross-j target pull ${shortPull} resolve blocked: empty reveal`);
  if (committedRatio > 0 && decodedRatio > committedRatio) {
    return fail(result, `❌ Cross-j target pull ${shortPull} resolve blocked: ratio ${decodedRatio}/65535 exceeds committed ${committedRatio}/65535`);
  }
  if (!isCrossJurisdictionRouteTransitionAllowed(route.status, 'clearing')) {
    return fail(result, `❌ Cross-j target pull ${shortPull} resolve blocked: route ${route.status}->clearing`);
  }
  route.status = 'clearing';
  route.pendingClearRequestedAt ||= now(result.newState, env);
  route.updatedAt = result.newState.timestamp || env.timestamp;
  result.newState.crossJurisdictionSwaps?.set(route.orderId, route);
  return null;
};

export const handleResolvePullEntityTx = (env: Env, state: EntityState, tx: ResolvePullTx): PullResult => {
  const result = createResult(state);
  const { counterpartyEntityId, pullId, binary } = tx.data;
  const accountId = resolveCounterparty(result, counterpartyEntityId, 'resolve');
  if (!accountId) return result;
  const sourceRoute = findCrossSourceRoute(result.newState, pullId, counterpartyEntityId);
  if (sourceRoute && sourceRoute.status !== 'clearing') {
    return fail(result, `❌ Cross-j source pull ${pullId.slice(0, 8)} resolve blocked: use requestCrossJurisdictionClear`);
  }
  const blocked = validateCrossTargetResolve(result, env, pullId, counterpartyEntityId, binary);
  if (blocked) return blocked;
  result.mempoolOps.push({ accountId, tx: { type: 'pull_resolve', data: { pullId, binary } } });
  requestFrame(state, result.outputs);
  return result;
};

export const handleCancelPullEntityTx = (_env: Env, state: EntityState, tx: CancelPullTx): PullResult => {
  const result = createResult(state);
  const { counterpartyEntityId, pullId } = tx.data;
  const accountId = resolveCounterparty(result, counterpartyEntityId, 'cancel');
  if (!accountId) return result;
  const crossPullRoute = findCrossJurisdictionPullRoute(result.newState, pullId);
  if (crossPullRoute && hasCommittedCrossJurisdictionFill(crossPullRoute.route) && !isCrossJurisdictionPullCancelWithinClear(crossPullRoute.route)) {
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
