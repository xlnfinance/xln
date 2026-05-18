import type { EntityInput, EntityState, EntityTx, Env } from '../types';

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
  const state = findLocalEntityState(env, entityId);
  const signerId = state?.config?.validators?.[0];
  return {
    entityId: state?.entityId || normalizeEntityRef(entityId),
    ...(signerId ? { signerId } : {}),
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
