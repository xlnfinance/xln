import type { CrossJurisdictionSwapRoute } from '../../types/cross-jurisdiction';
import type { EntityInput } from '../types';
import type { EntityTx } from '../../types/entity-tx';
import { deriveCanonicalCrossJurisdictionBookOwner } from '../../extensions/cross-j/market';

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
