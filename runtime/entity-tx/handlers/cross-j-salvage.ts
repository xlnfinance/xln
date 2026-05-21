import {
  isCrossJurisdictionPullExpired,
  transitionCrossJurisdictionRouteStatus,
} from '../../cross-jurisdiction';
import { decodeHashLadderBinary } from '../../hashladder';
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

export const handleCrossJurisdictionSalvageEntityTx = (
  env: Env,
  entityState: EntityState,
  entityTx: CrossJurisdictionSalvageTx,
): CrossJurisdictionSalvageResult => {
  const { routeId, binary, fillRatio, sourceEntityId, sourceCounterpartyEntityId, observedAt } = entityTx.data;
  const newState = cloneEntityState(entityState);
  const outputs: EntityInput[] = [];
  if (!binary || binary === '0x' || fillRatio <= 0) {
    addMessage(newState, `🌉 Cross-j salvage ignored for ${routeId}: empty pull args`);
    return { newState, outputs };
  }
  try {
    const decoded = decodeHashLadderBinary(binary);
    if (decoded.fillRatio <= 0) {
      addMessage(newState, `🌉 Cross-j salvage ignored for ${routeId}: zero pull binary`);
      return { newState, outputs };
    }
  } catch (error) {
    addMessage(newState, `❌ Cross-j salvage ${routeId} invalid pull binary: ${error instanceof Error ? error.message : String(error)}`);
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
  outputs.push({
    entityId: newState.entityId,
    ...(firstValidator ? { signerId: firstValidator } : {}),
    entityTxs: [
      {
        type: 'resolvePull',
        data: {
          counterpartyEntityId: targetHubEntityId,
          pullId: route.targetPull.pullId,
          binary,
          description:
            `Cross-j salvage resolve ${routeId} fill=${fillRatio}/65535 ` +
            `source=${sourceEntityId.slice(-4)}:${sourceCounterpartyEntityId.slice(-4)}`,
        },
      },
      {
        type: 'disputeStart',
        data: {
          counterpartyEntityId: targetHubEntityId,
          description:
            `Cross-j salvage ${routeId} fill=${fillRatio}/65535 ` +
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
