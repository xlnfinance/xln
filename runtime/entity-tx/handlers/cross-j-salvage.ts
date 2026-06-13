import { ethers } from 'ethers';
import {
  isCrossJurisdictionPullExpired,
  isCrossJurisdictionRouteTransitionAllowed,
  transitionCrossJurisdictionRouteStatus,
} from '../../cross-jurisdiction';
import { verifyHashLadderBinary } from '../../hashladder';
import { cloneEntityState, addMessage } from '../../state-helpers';
import type { EntityInput, EntityState, EntityTx, Env } from '../../types';
import { normalizeEntityRef } from '../account-key';

type CrossJurisdictionSalvageTx = Extract<EntityTx, { type: 'crossJurisdictionSalvage' }>;

type CrossJurisdictionSalvageResult = {
  newState: EntityState;
  outputs: EntityInput[];
};

const deterministicEntityTimestamp = (state: EntityState, env: Env): number =>
  Number(state.timestamp || env.timestamp || 0);

const buildCrossJurisdictionStarterPullArguments = (binary: string): string => {
  const abiCoder = ethers.AbiCoder.defaultAbiCoder();
  const args = abiCoder.encode(
    ['tuple(uint16[] fillRatios, bytes32[] secrets, bytes[] pulls)'],
    [{ fillRatios: [], secrets: [], pulls: [binary] }],
  );
  return abiCoder.encode(['bytes[]'], [[args]]);
};

export const handleCrossJurisdictionSalvageEntityTx = (
  env: Env,
  entityState: EntityState,
  entityTx: CrossJurisdictionSalvageTx,
): CrossJurisdictionSalvageResult => {
  const { routeId, binary, fillRatio, sourceEntityId, sourceCounterpartyEntityId, observedAt } = entityTx.data;
  const newState = cloneEntityState(entityState);
  const outputs: EntityInput[] = [];
  const claimedFillRatio = Math.floor(Number(fillRatio) || 0);
  if (!binary || binary === '0x' || claimedFillRatio <= 0) {
    addMessage(newState, `🌉 Cross-j salvage ignored for ${routeId}: empty pull args`);
    return { newState, outputs };
  }

  const route = newState.crossJurisdictionSwaps?.get(routeId);
  if (!route) {
    addMessage(newState, `❌ Cross-j salvage ${routeId} missing local route`);
    return { newState, outputs };
  }
  if (!route.targetPull) {
    addMessage(newState, `❌ Cross-j salvage ${routeId} missing target pull commitment`);
    return { newState, outputs };
  }
  let verifiedFillRatio = 0;
  try {
    verifiedFillRatio = verifyHashLadderBinary({
      fullHash: route.targetPull.fullHash,
      partialRoot: route.targetPull.partialRoot,
    }, binary).fillRatio;
  } catch (error) {
    addMessage(newState, `❌ Cross-j salvage ${routeId} invalid pull binary: ${error instanceof Error ? error.message : String(error)}`);
    return { newState, outputs };
  }
  if (verifiedFillRatio <= 0) {
    addMessage(newState, `🌉 Cross-j salvage ignored for ${routeId}: zero pull binary`);
    return { newState, outputs };
  }
  if (verifiedFillRatio !== claimedFillRatio) {
    addMessage(newState, `❌ Cross-j salvage ${routeId} fill mismatch: claimed ${claimedFillRatio}, verified ${verifiedFillRatio}`);
    return { newState, outputs };
  }
  const committedRatio = Math.max(
    Math.floor(Number(route.cumulativeFillRatio ?? 0) || 0),
    Math.floor(Number(route.claimedRatio ?? 0) || 0),
  );
  if (committedRatio > 0 && verifiedFillRatio > committedRatio) {
    addMessage(newState, `❌ Cross-j salvage ${routeId} exceeds committed fill: ${verifiedFillRatio}/${committedRatio}`);
    return { newState, outputs };
  }
  if (!isCrossJurisdictionRouteTransitionAllowed(route.status, 'clearing')) {
    addMessage(newState, `❌ Cross-j salvage ${routeId} blocked: route ${route.status}->clearing`);
    return { newState, outputs };
  }
  if (isCrossJurisdictionPullExpired(route, 'target', deterministicEntityTimestamp(newState, env))) {
    addMessage(newState, `❌ Cross-j salvage ${routeId} target pull expired`);
    return { newState, outputs };
  }

  const targetUserEntityId = normalizeEntityRef(route.target.counterpartyEntityId);
  const targetHubEntityId = normalizeEntityRef(route.target.entityId);
  if (normalizeEntityRef(newState.entityId) !== targetUserEntityId) {
    addMessage(newState, `❌ Cross-j salvage ${routeId} routed to wrong sibling entity`);
    return { newState, outputs };
  }
  if (!newState.accounts.has(targetHubEntityId)) {
    addMessage(newState, `❌ Cross-j salvage ${routeId} blocked: no target account with ${targetHubEntityId.slice(-4)}`);
    return { newState, outputs };
  }

  const requestedAt = deterministicEntityTimestamp(newState, env);
  transitionCrossJurisdictionRouteStatus(route, 'clearing', requestedAt);
  route.pendingClearRequestedAt = requestedAt;
  newState.crossJurisdictionSwaps ||= new Map();
  newState.crossJurisdictionSwaps.set(route.orderId, route);

  const firstValidator = entityState.config.validators[0];
  if (!firstValidator) {
    throw new Error(`CROSS_J_SALVAGE_SIGNER_MISSING: entity=${newState.entityId} route=${routeId}`);
  }
  outputs.push({
    entityId: newState.entityId,
    signerId: firstValidator,
    entityTxs: [
      {
        type: 'resolvePull',
        data: {
          counterpartyEntityId: targetHubEntityId,
          pullId: route.targetPull.pullId,
          binary,
          description:
            `Cross-j salvage resolve ${routeId} fill=${verifiedFillRatio}/65535 ` +
            `source=${sourceEntityId.slice(-4)}:${sourceCounterpartyEntityId.slice(-4)}`,
        },
      },
      {
        type: 'disputeStart',
        data: {
          counterpartyEntityId: targetHubEntityId,
          starterInitialArguments: buildCrossJurisdictionStarterPullArguments(binary),
          description:
            `Cross-j salvage ${routeId} fill=${verifiedFillRatio}/65535 ` +
            `source=${sourceEntityId.slice(-4)}:${sourceCounterpartyEntityId.slice(-4)}` +
            (observedAt ? ` observed=${observedAt}` : ''),
        },
      },
      { type: 'j_broadcast', data: {} },
    ],
  });
  addMessage(newState, `🌉 Cross-j salvage queued for ${routeId}: target dispute vs ${targetHubEntityId.slice(-4)}`);
  return { newState, outputs };
};
