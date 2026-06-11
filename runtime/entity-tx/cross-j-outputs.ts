import type { EntityInput, EntityState, EntityTx, Env } from '../types';
import { resolveEntityProposerId } from '../state-helpers';

const normalizeEntityRef = (value: string): string => String(value || '').trim().toLowerCase();

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
): EntityInput => {
  const normalizedEntityId = normalizeEntityRef(entityId);
  const state = findLocalEntityState(env, normalizedEntityId);
  let signerId: string;
  try {
    signerId = resolveEntityProposerId(env, state?.entityId || normalizedEntityId, 'cross-j entity output');
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
  env: Env,
  outputs: EntityInput[],
  entityId: string,
  entityTxs: EntityTx[],
): void => {
  outputs.push(buildCrossJurisdictionEntityOutput(env, entityId, entityTxs));
};
