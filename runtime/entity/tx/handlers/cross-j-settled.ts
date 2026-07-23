import {
  CROSS_J_MAX_FILL_RATIO,
  getCrossJurisdictionCommittedFillAmounts,
  hashCrossJurisdictionCloseBinary,
  transitionCrossJurisdictionRouteStatus,
} from '../../../extensions/cross-j/index';
import { decodeHashLadderBinary } from '../../../protocol/htlc/hash-ladder';
import { addMessage, cloneEntityState } from '../../../state-helpers';
import type { EntityInput, EntityState, EntityTx } from '../../../types';

type CrossJurisdictionSettledTx = Extract<EntityTx, { type: 'crossJurisdictionSettled' }>;

const normalizeEntityRef = (value: string): string => String(value || '').trim().toLowerCase();

export const handleCrossJurisdictionSettledEntityTx = (
  entityState: EntityState,
  entityTx: CrossJurisdictionSettledTx,
): { newState: EntityState; outputs: EntityInput[] } => {
  const newState = cloneEntityState(entityState);
  const route = newState.crossJurisdictionSwaps?.get(entityTx.data.orderId);
  if (!route) {
    throw new Error(`CROSS_J_SETTLED_ROUTE_MISSING: order=${entityTx.data.orderId}`);
  }

  const currentEntityId = normalizeEntityRef(newState.entityId);
  const sourceUserId = normalizeEntityRef(route.source.entityId);
  const sourceHubId = normalizeEntityRef(route.source.counterpartyEntityId);
  if (currentEntityId !== sourceUserId && currentEntityId !== sourceHubId) {
    throw new Error(
      `CROSS_J_SETTLED_SOURCE_SIBLING_REQUIRED: order=${route.orderId} entity=${newState.entityId}`,
    );
  }
  if (!route.routeHash || normalizeEntityRef(entityTx.data.routeHash) !== normalizeEntityRef(route.routeHash)) {
    throw new Error(
      `CROSS_J_SETTLED_ROUTE_HASH_MISMATCH: order=${route.orderId} ` +
        `got=${entityTx.data.routeHash || 'missing'} expected=${route.routeHash || 'missing'}`,
    );
  }

  if (
    route.status !== 'clearing' &&
    route.status !== 'source_claimed' &&
    route.status !== 'settled'
  ) {
    throw new Error(`CROSS_J_SETTLED_STATUS_INVALID: order=${route.orderId} status=${route.status}`);
  }

  const suppliedProof = entityTx.data.proof;
  const decodedRatio = decodeHashLadderBinary(entityTx.data.binary).fillRatio;
  const binaryHash = hashCrossJurisdictionCloseBinary(entityTx.data.binary);
  if (
    suppliedProof.orderId !== route.orderId ||
    normalizeEntityRef(suppliedProof.routeHash) !== normalizeEntityRef(route.routeHash) ||
    suppliedProof.sourcePullId !== route.sourcePull?.pullId ||
    suppliedProof.targetPullId !== route.targetPull?.pullId ||
    normalizeEntityRef(suppliedProof.binaryHash) !== normalizeEntityRef(binaryHash)
  ) {
    throw new Error(
      `CROSS_J_SETTLED_SOURCE_PROOF_MISMATCH: order=${route.orderId} ` +
        `proofHash=${suppliedProof.binaryHash} binaryHash=${binaryHash}`,
    );
  }
  const committed = getCrossJurisdictionCommittedFillAmounts(route);
  if (
    decodedRatio !== committed.fillRatio ||
    suppliedProof.fillRatio !== committed.fillRatio ||
    suppliedProof.cumulativeSourceAmount !== committed.filledSourceAmount ||
    suppliedProof.cumulativeTargetAmount !== committed.filledTargetAmount
  ) {
    throw new Error(
      `CROSS_J_SETTLED_COMMITMENT_MISMATCH: order=${route.orderId} ` +
        `ratio=${decodedRatio}/${suppliedProof.fillRatio}/${committed.fillRatio} ` +
        `source=${suppliedProof.cumulativeSourceAmount}/${committed.filledSourceAmount} ` +
        `target=${suppliedProof.cumulativeTargetAmount}/${committed.filledTargetAmount}`,
    );
  }
  if (committed.fillRatio <= 0 || committed.fillRatio > CROSS_J_MAX_FILL_RATIO) {
    throw new Error(`CROSS_J_SETTLED_RATIO_INVALID: order=${route.orderId} ratio=${committed.fillRatio}`);
  }
  if (route.status === 'settled') {
    addMessage(newState, `🌉 Cross-j ${route.orderId} terminal update already applied`);
    return { newState, outputs: [] };
  }

  route.sourceCloseProof = suppliedProof;
  transitionCrossJurisdictionRouteStatus(route, 'settled', newState.timestamp);
  route.settledAt = newState.timestamp;
  addMessage(newState, `🌉 Cross-j ${route.orderId} settled on both legs`);
  return { newState, outputs: [] };
};
