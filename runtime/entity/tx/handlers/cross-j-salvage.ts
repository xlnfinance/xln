import {
  getCrossJurisdictionCommittedProofRatio,
  isCrossJurisdictionPullExpired,
  isCrossJurisdictionRouteTransitionAllowed,
  transitionCrossJurisdictionRouteStatus,
} from '../../../extensions/cross-j/index';
import { verifyHashLadderBinary } from '../../../protocol/htlc/hash-ladder';
import { prepareEntityTxState } from '../../state-clone';
import { addMessage } from '../../frame-events';
import type { CrossJurisdictionSwapRoute } from '../../../types/cross-jurisdiction';
import type { AccountReplica, RuntimeOverlayRecord } from '../../../types/account';
import type { EntityInput, EntityState } from '../../types';
import type { EntityRuntimeContext } from '../../runtime-context';
import type { EntityTx } from '../../../types/entity-tx';
import { normalizeEntityRef } from '../account-key';
import { buildCrossJurisdictionEntityOutput } from '../cross-j-outputs';
import { freezeAccountForDispute } from '../../../account/consensus/dispute-policy';
import {
  draftPreparedDisputeStartIfReady,
  handlePrepareDispute,
} from './dispute';

type CrossJurisdictionSalvageTx = Extract<EntityTx, { type: 'crossJurisdictionSalvage' }>;

type CrossJurisdictionSalvageResult = {
  newState: EntityState;
  outputs: EntityInput[];
};

const deterministicEntityTimestamp = (state: EntityState, env: EntityRuntimeContext): number =>
  Number(state.timestamp || env.state.timestamp || 0);

const rejectSourceSalvageMirror = (
  state: EntityState,
  tx: CrossJurisdictionSalvageTx,
  reason: string,
): void => {
  if (normalizeEntityRef(state.entityId) === normalizeEntityRef(tx.data.sourceEntityId)) {
    throw new Error(`CROSS_J_SALVAGE_SOURCE_MIRROR_REJECTED:${tx.data.routeId}:${reason}`);
  }
};

const verifySalvageFillRatio = (
  state: EntityState,
  route: CrossJurisdictionSwapRoute,
  routeId: string,
  binary: string,
  claimedFillRatio: number,
): number | null => {
  if (binary === '0x') {
    if (claimedFillRatio === 0) return 0;
    addMessage(state, `❌ Cross-j salvage ${routeId} empty-result ratio mismatch`);
    return null;
  }
  let verifiedFillRatio: number;
  try {
    verifiedFillRatio = verifyHashLadderBinary({
      fullHash: route.targetPull!.fullHash,
      partialRoot: route.targetPull!.partialRoot,
    }, binary).fillRatio;
  } catch (error) {
    addMessage(state, `❌ Cross-j salvage ${routeId} invalid pull binary: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
  if (verifiedFillRatio <= 0) {
    addMessage(state, `🌉 Cross-j salvage ignored for ${routeId}: zero pull binary`);
    return null;
  }
  if (verifiedFillRatio !== claimedFillRatio) {
    addMessage(state, `❌ Cross-j salvage ${routeId} fill mismatch: claimed ${claimedFillRatio}, verified ${verifiedFillRatio}`);
    return null;
  }
  const committedRatio = getCrossJurisdictionCommittedProofRatio(route);
  if (committedRatio > 0 && verifiedFillRatio > committedRatio) {
    addMessage(state, `❌ Cross-j salvage ${routeId} exceeds committed fill: ${verifiedFillRatio}/${committedRatio}`);
    return null;
  }
  return verifiedFillRatio;
};

const resolveSalvageAccount = (
  state: EntityState,
  route: CrossJurisdictionSwapRoute,
  routeId: string,
): { accountEntityId: string; role: 'target' | 'source' } | null => {
  const sourceUserEntityId = normalizeEntityRef(route.source.entityId);
  const sourceHubEntityId = normalizeEntityRef(route.source.counterpartyEntityId);
  const targetUserEntityId = normalizeEntityRef(route.target.counterpartyEntityId);
  const targetHubEntityId = normalizeEntityRef(route.target.entityId);
  const currentEntityId = normalizeEntityRef(state.entityId);
  const role = currentEntityId === targetUserEntityId
    ? 'target'
    : currentEntityId === sourceUserEntityId
      ? 'source'
      : null;
  if (!role) {
    addMessage(state, `❌ Cross-j salvage ${routeId} routed to wrong sibling entity`);
    return null;
  }
  const accountEntityId = role === 'target' ? targetHubEntityId : sourceHubEntityId;
  if (!state.accounts.has(accountEntityId)) {
    throw new Error(`CROSS_J_SALVAGE_${role.toUpperCase()}_ACCOUNT_MISSING:${routeId}:${accountEntityId}`);
  }
  return { accountEntityId, role };
};

const recordDisputeRecoveryResult = (
  account: AccountReplica,
  localEntityId: string,
  route: CrossJurisdictionSwapRoute,
  binary: string,
): 'preparing' | 'active' | 'none' => {
  const preparing = account.disputePrepare?.crossJurisdictionRecovery;
  const active = account.activeDispute;
  if (!preparing && !active) return 'none';
  if (preparing && active) throw new Error('CROSS_J_SALVAGE_RECOVERY_PHASE_CONFLICT');
  if (active) {
    const localIsLeft = account.state.leftEntity === localEntityId;
    if (localIsLeft === active.startedByLeft) {
      throw new Error(`CROSS_J_SALVAGE_STARTER_EVIDENCE_LATE:${route.orderId}`);
    }
  }
  const recovery = preparing ?? active?.crossJurisdictionRecovery;
  if (!recovery) throw new Error(`CROSS_J_SALVAGE_RECOVERY_MISSING:${route.orderId}`);
  const pullId = route.targetPull!.pullId;
  if (!recovery.requiredPullIds.includes(pullId)) {
    throw new Error(`CROSS_J_SALVAGE_DISPUTE_PULL_UNBOUND:${route.orderId}:${pullId}`);
  }
  const normalized = binary.toLowerCase();
  const previous = recovery.resultsByPullId[pullId];
  if (previous !== undefined) {
    if (previous.toLowerCase() === normalized) return preparing ? 'preparing' : 'active';
    throw new Error(`CROSS_J_SALVAGE_DISPUTE_PULL_CONFLICT:${pullId}`);
  }
  recovery.resultsByPullId = { ...recovery.resultsByPullId, [pullId]: normalized };
  return preparing ? 'preparing' : 'active';
};

const recoveryIsComplete = (account: AccountReplica): boolean => {
  const recovery = account.disputePrepare?.crossJurisdictionRecovery;
  return Boolean(recovery && recovery.requiredPullIds.every(
    (pullId) => Object.hasOwn(recovery.resultsByPullId, pullId),
  ));
};

const recoveryHasClaim = (account: AccountReplica): boolean => {
  const recovery = account.disputePrepare?.crossJurisdictionRecovery;
  return Boolean(recovery?.requiredPullIds.some(
    (pullId) => recovery.resultsByPullId[pullId] !== '0x',
  ));
};

const applyTargetSalvageResult = async (
  env: EntityRuntimeContext,
  state: EntityState,
  tx: CrossJurisdictionSalvageTx,
  route: CrossJurisdictionSwapRoute,
  accountEntityId: string,
  outputs: EntityInput[],
  storageChanges: RuntimeOverlayRecord[],
): Promise<CrossJurisdictionSalvageResult> => {
  // The source mirror is Runtime-private and is drained before any outbox is
  // published. A missing sibling therefore aborts this entire Runtime input
  // before WAL; target evidence can never commit alone.
  outputs.push(buildCrossJurisdictionEntityOutput(
    route.source.entityId,
    route.sourceSignerId,
    [tx],
  ));

  const account = state.accounts.get(accountEntityId)!;
  const phase = recordDisputeRecoveryResult(account, state.entityId, route, tx.data.binary);
  if (phase === 'active') {
    addMessage(state, `🌉 Cross-j source-final result recorded for active target dispute ${route.orderId}`);
    return { newState: state, outputs };
  }
  if (phase === 'none') {
    if (tx.data.binary === '0x') return { newState: state, outputs };
    const prepared = await handlePrepareDispute(
      state,
      {
        type: 'prepareDispute',
        data: {
          counterpartyEntityId: accountEntityId,
          description: `Cross-j source-final recovery ${route.orderId}`,
          crossJurisdictionRouteId: route.orderId,
        },
      },
      env,
      storageChanges,
      true,
      { [route.targetPull!.pullId]: tx.data.binary },
    );
    return { newState: prepared.newState, outputs: [...outputs, ...prepared.outputs] };
  }
  if (!recoveryIsComplete(account)) return { newState: state, outputs };
  if (!recoveryHasClaim(account)) {
    account.status = 'active';
    delete account.disputePrepare;
    freezeAccountForDispute(account, false);
    addMessage(state, '🌉 Cross-j source finality required no target dispute');
    return { newState: state, outputs };
  }
  const drafted = await draftPreparedDisputeStartIfReady(
    state,
    accountEntityId,
    env,
    storageChanges,
    true,
  );
  return { newState: drafted.newState, outputs: [...outputs, ...drafted.outputs] };
};

export const handleCrossJurisdictionSalvageEntityTx = async (
  env: EntityRuntimeContext,
  entityState: EntityState,
  entityTx: CrossJurisdictionSalvageTx,
  storageChanges: RuntimeOverlayRecord[] = [],
  mutableFrameState = false,
): Promise<CrossJurisdictionSalvageResult> => {
  const { routeId, binary, fillRatio } = entityTx.data;
  const newState = prepareEntityTxState(entityState, mutableFrameState);
  const outputs: EntityInput[] = [];
  const claimedFillRatio = Math.floor(Number(fillRatio) || 0);
  if (!binary || claimedFillRatio < 0) {
    rejectSourceSalvageMirror(newState, entityTx, 'INVALID_RESULT');
    addMessage(newState, `🌉 Cross-j salvage ignored for ${routeId}: invalid result`);
    return { newState, outputs };
  }

  const route = newState.crossJurisdictionSwaps?.get(routeId);
  if (!route) {
    throw new Error(`CROSS_J_SALVAGE_ROUTE_MISSING:${routeId}:${newState.entityId}`);
  }
  if (!route.targetPull) {
    throw new Error(`CROSS_J_SALVAGE_TARGET_PULL_MISSING:${routeId}:${newState.entityId}`);
  }
  const verifiedFillRatio = verifySalvageFillRatio(
    newState,
    route,
    routeId,
    binary,
    claimedFillRatio,
  );
  if (verifiedFillRatio === null) {
    rejectSourceSalvageMirror(newState, entityTx, 'EVIDENCE_MISMATCH');
    return { newState, outputs };
  }
  const preserveSourceClaim = route.status === 'source_claimed';
  if (
    verifiedFillRatio > 0 &&
    !preserveSourceClaim &&
    !isCrossJurisdictionRouteTransitionAllowed(route.status, 'clearing')
  ) {
    rejectSourceSalvageMirror(newState, entityTx, `STATUS_${route.status}`);
    addMessage(newState, `❌ Cross-j salvage ${routeId} blocked: route ${route.status}->clearing`);
    return { newState, outputs };
  }
  if (
    verifiedFillRatio > 0 &&
    isCrossJurisdictionPullExpired(route, 'target', deterministicEntityTimestamp(newState, env))
  ) {
    rejectSourceSalvageMirror(newState, entityTx, 'TARGET_PULL_EXPIRED');
    addMessage(newState, `❌ Cross-j salvage ${routeId} target pull expired`);
    return { newState, outputs };
  }

  const resolved = resolveSalvageAccount(newState, route, routeId);
  if (!resolved) {
    rejectSourceSalvageMirror(newState, entityTx, 'ROLE_OR_ACCOUNT_MISMATCH');
    return { newState, outputs };
  }
  const { accountEntityId, role } = resolved;

  const requestedAt = deterministicEntityTimestamp(newState, env);
  if (verifiedFillRatio > 0) {
    if (!preserveSourceClaim) transitionCrossJurisdictionRouteStatus(route, 'clearing', requestedAt);
    route.pendingClearRequestedAt = requestedAt;
    newState.crossJurisdictionSwaps ||= new Map();
    newState.crossJurisdictionSwaps.set(route.orderId, route);
  }

  if (role === 'source') {
    addMessage(newState, `🌉 Cross-j source-final result mirrored for ${routeId}`);
    return { newState, outputs };
  }
  return applyTargetSalvageResult(
    env,
    newState,
    entityTx,
    route,
    accountEntityId,
    outputs,
    storageChanges,
  );
};
