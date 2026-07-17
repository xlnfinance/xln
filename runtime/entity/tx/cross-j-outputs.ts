import type { CrossJurisdictionSwapRoute, EntityInput, EntityState, EntityTx, Env } from '../../types';
import { resolveEntityProposerId } from '../../state-helpers';
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

export const findLocalEntityState = (env: Env, entityId: string): EntityState | null => {
  const target = normalizeEntityRef(entityId);
  for (const replica of env.eReplicas?.values?.() || []) {
    const state = replica?.state;
    if (state && normalizeEntityRef(state.entityId) === target) return state;
  }
  return null;
};

export const buildCrossJurisdictionEntityOutput = (
  env: Env,
  entityId: string,
  entityTxs: EntityTx[],
  signerIdHint?: string | null,
): EntityInput => {
  const normalizedEntityId = normalizeEntityRef(entityId);
  const hintedSignerId = normalizeEntityRef(String(signerIdHint || ''));
  if (hintedSignerId) {
    // Route signers are committed before consensus. Never consult local
    // topology when a committed route already identifies the recipient lane.
    return { entityId: normalizedEntityId, signerId: hintedSignerId, entityTxs };
  }
  const state = findLocalEntityState(env, normalizedEntityId);
  let signerId: string;
  try {
    signerId = hintedSignerId || resolveEntityProposerId(env, state?.entityId || normalizedEntityId, 'cross-j entity output');
  } catch (error) {
    throw new Error(
      `CROSS_J_ENTITY_OUTPUT_SIGNER_MISSING: entity=${normalizedEntityId} ` +
      `reason=${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return {
    entityId: state?.entityId || normalizedEntityId,
    signerId,
    entityTxs,
  };
};

export const pushCrossJurisdictionEntityOutput = (
  _env: Env,
  outputs: EntityInput[],
  entityId: string,
  entityTxs: EntityTx[],
  signerIdHint?: string | null,
): void => {
  const normalizedEntityId = normalizeEntityRef(entityId);
  const normalizedSignerId = normalizeEntityRef(String(signerIdHint || ''));
  if (!normalizedEntityId || !normalizedSignerId) {
    throw new Error(`CROSS_J_ENTITY_OUTPUT_SIGNER_MISSING: entity=${normalizedEntityId || 'missing'}`);
  }
  outputs.push({ entityId: normalizedEntityId, signerId: normalizedSignerId, entityTxs });
};
