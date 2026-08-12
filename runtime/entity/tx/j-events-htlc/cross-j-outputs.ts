import type { CrossJurisdictionSwapRoute } from '../../../types/cross-jurisdiction';
import type { AccountTx } from '../../../types/account';
import type { EntityInput, EntityOutput, EntityState } from '../../types';
import type { EntityTx } from '../../../types/entity-tx';
import { deriveCanonicalCrossJurisdictionBookOwner } from '../../../extensions/cross-j/market';
import { buildCrossJurisdictionFillNoticeTx } from '../../../extensions/cross-j/fill-ack';

const normalizeEntityRef = (value: string): string => String(value || '').trim().toLowerCase();

export const crossJurisdictionRouteSignerHint = (
  route: CrossJurisdictionSwapRoute,
  entityId: string,
): string | null => {
  const target = normalizeEntityRef(entityId);
  if (!target) return null;
  const bookOwner = normalizeEntityRef(route.bookOwnerEntityId || deriveCanonicalCrossJurisdictionBookOwner(route));
  if (normalizeEntityRef(route.source.entityId) === target) return route.sourceSignerId || null;
  if (normalizeEntityRef(route.source.counterpartyEntityId) === target) return route.sourceHubSignerId || null;
  if (normalizeEntityRef(route.target.entityId) === target) return route.targetHubSignerId || null;
  if (normalizeEntityRef(route.target.counterpartyEntityId) === target) return route.targetSignerId || null;
  if (bookOwner === target || normalizeEntityRef(route.hubEntityId) === target) return route.bookHubSignerId || null;
  return null;
};

export const buildCrossJurisdictionEntityOutput = (
  entityId: string,
  signerId: string | null | undefined,
  entityTxs: EntityTx[],
): EntityInput => {
  const normalizedEntityId = normalizeEntityRef(entityId);
  const normalizedSignerId = normalizeEntityRef(signerId || '');
  if (!normalizedEntityId || !normalizedSignerId) {
    throw new Error(`CROSS_J_ENTITY_OUTPUT_ROUTE_MISSING:${normalizedEntityId || 'entity'}:${normalizedSignerId || 'signer'}`);
  }

  // Cross-J routes commit every destination signer before either Account leg
  // can settle. Entity consensus therefore emits only the exact certified
  // lane; consulting Runtime topology here would make pure replay depend on
  // validator-local replicas, gossip, or private keys.
  return {
    entityId: normalizedEntityId,
    signerId: normalizedSignerId,
    entityTxs,
    localRuntimeProtocol: 'cross-j',
  };
};

const buildCrossJurisdictionTargetFillNoticeOutput = (
  currentEntityState: EntityState,
  tx: Extract<AccountTx, { type: 'cross_swap_fill_ack' }>,
): EntityInput => {
  const route = currentEntityState.crossJurisdictionSwaps?.get(tx.data.offerId);
  if (!route) throw new Error(`CROSS_J_TARGET_PROGRESS_ROUTE_MISSING:${tx.data.offerId}`);
  const current = normalizeEntityRef(currentEntityState.entityId);
  const sourceHub = normalizeEntityRef(route.source.counterpartyEntityId);
  if (current !== sourceHub) {
    throw new Error(`CROSS_J_TARGET_PROGRESS_SOURCE_HUB_REQUIRED:${tx.data.offerId}:${current}:${sourceHub}`);
  }
  const targetHub = normalizeEntityRef(route.target.entityId);
  const targetSigner = normalizeEntityRef(route.targetHubSignerId || '');
  if (!targetHub || !targetSigner || targetHub === sourceHub) {
    throw new Error(`CROSS_J_TARGET_PROGRESS_ROUTE_INVALID:${tx.data.offerId}:${sourceHub}:${targetHub}`);
  }
  return buildCrossJurisdictionEntityOutput(
    targetHub,
    targetSigner,
    [buildCrossJurisdictionFillNoticeTx(tx, route.source.entityId)],
  );
};

export const appendCrossJurisdictionTargetProgressAfterAdmission = (
  currentEntityState: EntityState,
  tx: Extract<AccountTx, { type: 'cross_swap_fill_ack' }>,
  outputs: EntityOutput[],
): void => {
  outputs.push(buildCrossJurisdictionTargetFillNoticeOutput(currentEntityState, tx));
};

/** Generic certified E→E output. Cross-j sibling code must never call this. */
export const buildCertifiedEntityOutput = (
  entityId: string,
  signerId: string,
  entityTxs: EntityTx[],
): EntityInput => ({
  entityId: normalizeEntityRef(entityId),
  signerId: normalizeEntityRef(signerId),
  entityTxs,
});

export const pushCrossJurisdictionEntityOutput = (
  outputs: EntityInput[],
  entityId: string,
  entityTxs: EntityTx[],
  signerId: string | null | undefined,
): void => {
  outputs.push(buildCrossJurisdictionEntityOutput(entityId, signerId, entityTxs));
};
