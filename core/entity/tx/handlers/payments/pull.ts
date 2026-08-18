import {
  buildCrossJurisdictionCloseProof,
  getCrossJurisdictionCommittedProofRatio,
  hashCrossJurisdictionCloseBinary,
  isCrossJurisdictionRouteTransitionAllowed,
  isCrossJurisdictionTerminalStatus,
  transitionCrossJurisdictionRouteStatus,
  cloneCrossJurisdictionCloseProof,
} from '../../../../extensions/cross-j/index';
import { verifyHashLadderBinary } from '../../../../protocol/htlc/hash-ladder';
import { prepareEntityTxState } from '../../../state-clone';
import { addMessage } from '../../../frame-events';
import type { EntityInput, EntityState } from '../../../types';
import type { EntityRuntimeContext } from '../../../runtime-context';
import type { EntityTx } from '../../../../types/entity-tx';
import { findAccountKey, normalizeEntityRef } from '../../account-key';
import { getEntityCollectionValueForWrite } from '../../../state/persistent-collection-map';
import type { ApplyEntityTxOptions } from '../../apply';
import type { AccountTxTarget } from '../account';

type CrossPullCloseTx = Extract<EntityTx, { type: 'crossPullClose' }>;
type PullResult = { newState: EntityState; outputs: EntityInput[]; accountTxs: AccountTxTarget[] };

const now = (state: EntityState, env: EntityRuntimeContext): number => Number(state.timestamp || env.state.timestamp || 0);
const createResult = (state: EntityState, options?: ApplyEntityTxOptions): PullResult => ({
  newState: prepareEntityTxState(state, options?.mutableFrameState),
  outputs: [],
  accountTxs: [],
});
const fail = (result: PullResult, message: string): PullResult => {
  addMessage(result.newState, message);
  return result;
};
const requestFrame = (state: EntityState, outputs: EntityInput[]): void => {
  const signerId = state.config.validators[0];
  if (signerId) outputs.push({ entityId: state.entityId, signerId, entityTxs: [] });
};

const resolveCounterparty = (result: PullResult, counterpartyEntityId: string): string | null => {
  const accountId = findAccountKey(result.newState, counterpartyEntityId);
  if (!accountId) fail(result, `❌ Cross-j pull close failed: no account with ${counterpartyEntityId}`);
  return accountId;
};

const findCrossSourceRoute = (state: EntityState, pullId: string, counterpartyEntityId: string) =>
  [...(state.crossJurisdictionSwaps?.values?.() ?? [])].find(route =>
    route.sourcePull?.pullId === pullId &&
    normalizeEntityRef(route.source.counterpartyEntityId) === normalizeEntityRef(state.entityId) &&
    normalizeEntityRef(route.source.entityId) === normalizeEntityRef(counterpartyEntityId),
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
  route: NonNullable<ReturnType<typeof findCrossSourceRoute>> | NonNullable<ReturnType<typeof findCrossTargetHubRoute>>,
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

export const handleCrossPullCloseEntityTx = (env: EntityRuntimeContext, state: EntityState, tx: CrossPullCloseTx, options?: ApplyEntityTxOptions): PullResult => {
  const result = createResult(state, options);
  const { counterpartyEntityId, pullId, binary, proof, route: commandRoute } = tx.data;
  const accountId = resolveCounterparty(result, counterpartyEntityId);
  if (!accountId) return result;
  const sourceRoute = findCrossSourceRoute(result.newState, pullId, counterpartyEntityId);
  const targetRoute = findCrossTargetHubRoute(result.newState, pullId, counterpartyEntityId);
  const found = sourceRoute ?? targetRoute;
  if (!found) return fail(result, `❌ Cross-j pull close ${pullId.slice(0, 8)} blocked: route missing`);
  const leg = sourceRoute ? 'source' : 'target';
  if (isCrossJurisdictionTerminalStatus(found.status)) {
    return fail(result, `❌ Cross-j ${leg} pull close ${pullId.slice(0, 8)} blocked: route ${found.status}`);
  }
  if (leg === 'source' && found.status !== 'clearing' && found.status !== 'clear_requested') {
    return fail(result, `❌ Cross-j source pull close ${pullId.slice(0, 8)} blocked: route ${found.status}`);
  }
  const proofError = proofRouteError(found, proof, binary, leg, commandRoute);
  if (proofError) return fail(result, `❌ Cross-j ${leg} pull close ${pullId.slice(0, 8)} blocked: ${proofError}`);
  // Every gate runs before any mutation: a soft-fail return must not leak
  // route economics into the committed mirror while the Account tx was never
  // queued.
  if (leg === 'target' && !isCrossJurisdictionRouteTransitionAllowed(found.status, 'clearing')) {
    return fail(result, `❌ Cross-j target pull close ${pullId.slice(0, 8)} blocked: route ${found.status}->clearing`);
  }
  const routes = result.newState.crossJurisdictionSwaps;
  if (!routes) {
    throw new Error(`CROSS_J_PULL_CLOSE_COLLECTION_MISSING:${found.orderId}`);
  }
  const route = getEntityCollectionValueForWrite(routes, found.orderId);
  if (!route) {
    throw new Error(`CROSS_J_PULL_CLOSE_ROUTE_FORK_MISSING:${found.orderId}`);
  }
  route.sourceCloseProof = cloneCrossJurisdictionCloseProof(proof);
  if (leg === 'target') {
    route.cumulativeFillRatio = proof.fillRatio;
    route.claimedRatio = proof.fillRatio;
    route.filledSourceAmount = proof.cumulativeSourceAmount;
    route.filledTargetAmount = proof.cumulativeTargetAmount;
    route.sourceClaimed = proof.cumulativeSourceAmount;
    route.targetClaimed = proof.cumulativeTargetAmount;
    route.clearingPolicy = 'cancel_and_clear';
    route.pendingClearRequestedAt ||= now(result.newState, env);
    transitionCrossJurisdictionRouteStatus(route, 'clearing', result.newState.timestamp || env.state.timestamp);
  }
  routes.set(route.orderId, route);
  result.accountTxs.push({ accountId, tx: { type: 'cross_pull_close', data: { pullId, binary, proof } } });
  requestFrame(state, result.outputs);
  return result;
};
