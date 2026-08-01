import { ethers } from 'ethers';
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
import type { EntityInput, EntityState } from '../../types';
import type { EntityRuntimeContext } from '../../runtime-context';
import type { EntityTx } from '../../../types/entity-tx';
import { normalizeEntityRef } from '../account-key';
import { buildCrossJurisdictionEntityOutput } from '../cross-j-outputs';

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

const buildCrossJurisdictionStarterPullArguments = (binary: string): string => {
  const abiCoder = ethers.AbiCoder.defaultAbiCoder();
  const args = abiCoder.encode(
    ['tuple(uint16[] fillRatios, bytes32[] secrets, bytes[] pulls)'],
    [{ fillRatios: [], secrets: [], pulls: [binary] }],
  );
  return abiCoder.encode(['bytes[]'], [[args]]);
};

const verifySalvageFillRatio = (
  state: EntityState,
  route: CrossJurisdictionSwapRoute,
  routeId: string,
  binary: string,
  claimedFillRatio: number,
): number | null => {
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

export const handleCrossJurisdictionSalvageEntityTx = (
  env: EntityRuntimeContext,
  entityState: EntityState,
  entityTx: CrossJurisdictionSalvageTx,
  mutableFrameState = false,
): CrossJurisdictionSalvageResult => {
  const { routeId, binary, fillRatio } = entityTx.data;
  const newState = prepareEntityTxState(entityState, mutableFrameState);
  const outputs: EntityInput[] = [];
  const claimedFillRatio = Math.floor(Number(fillRatio) || 0);
  if (!binary || binary === '0x' || claimedFillRatio <= 0) {
    rejectSourceSalvageMirror(newState, entityTx, 'EMPTY_PULL');
    addMessage(newState, `🌉 Cross-j salvage ignored for ${routeId}: empty pull args`);
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
  if (!preserveSourceClaim && !isCrossJurisdictionRouteTransitionAllowed(route.status, 'clearing')) {
    rejectSourceSalvageMirror(newState, entityTx, `STATUS_${route.status}`);
    addMessage(newState, `❌ Cross-j salvage ${routeId} blocked: route ${route.status}->clearing`);
    return { newState, outputs };
  }
  if (isCrossJurisdictionPullExpired(route, 'target', deterministicEntityTimestamp(newState, env))) {
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
  if (!preserveSourceClaim) transitionCrossJurisdictionRouteStatus(route, 'clearing', requestedAt);
  route.pendingClearRequestedAt = requestedAt;
  newState.crossJurisdictionSwaps ||= new Map();
  newState.crossJurisdictionSwaps.set(route.orderId, route);

  if (role === 'source') {
    addMessage(newState, `🌉 Cross-j salvage mirror committed for ${routeId}`);
    return { newState, outputs };
  }

  // The mirror is Runtime-private and is drained before `entityOutbox` is
  // published. If the source sibling cannot commit the same transition, the
  // whole Runtime input aborts before WAL and the self prepare output below
  // never escapes. Do not move prepareDispute ahead of this mirror.
  outputs.push(buildCrossJurisdictionEntityOutput(
    route.source.entityId,
    route.sourceSignerId,
    [entityTx],
  ));

  const firstValidator = entityState.config.validators[0];
  if (!firstValidator) {
    throw new Error(`CROSS_J_SALVAGE_SIGNER_MISSING: entity=${newState.entityId} route=${routeId}`);
  }
  outputs.push({
    entityId: newState.entityId,
    signerId: firstValidator,
    entityTxs: [{
      type: 'prepareDispute',
      data: {
        counterpartyEntityId: accountEntityId,
        description: `Cross-j salvage prepare ${routeId} fill=${verifiedFillRatio}`,
        crossJurisdictionRouteId: routeId,
        starterInitialArguments: buildCrossJurisdictionStarterPullArguments(binary),
      },
    }],
  });
  addMessage(newState, `🌉 Cross-j salvage queued for ${routeId}: target dispute vs ${accountEntityId.slice(-4)}`);
  return { newState, outputs };
};
