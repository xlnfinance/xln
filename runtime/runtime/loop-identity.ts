import { deriveSignerAddressSync, getSignerPrivateKeyIfAvailable } from '../account/crypto';
import { extractEntityId, extractSignerId } from '../protocol/identity';
import { createStructuredLogger } from '../infra/logger';
import { normalizeRuntimeId } from '../networking/runtime-id';
import type { RuntimeState } from './types';

const identityLog = createStructuredLogger('runtime.identity');

export const getRuntimeEnv = (env?: RuntimeState | null): RuntimeState | null => {
  if (!env) {
    identityLog.warn('env.missing');
    return null;
  }
  return env;
};

export const deriveRuntimeId = (seed: string): string =>
  normalizeRuntimeId(deriveSignerAddressSync(seed, '1'));

export const getLocalSignerIdsForEntity = (env: RuntimeState, entityId: string): string[] => {
  const targetEntityId = String(entityId || '').toLowerCase();
  const signerIds = new Set<string>();
  for (const replicaKey of env.eReplicas.keys()) {
    const replicaEntityId = extractEntityId(replicaKey).toLowerCase();
    const signerId = extractSignerId(replicaKey);
    if (replicaEntityId !== targetEntityId || !signerId) continue;
    if (getSignerPrivateKeyIfAvailable(env, signerId) !== null) signerIds.add(signerId);
  }
  return [...signerIds];
};

export const hasLocalSignerForEntity = (env: RuntimeState, entityId: string): boolean =>
  getLocalSignerIdsForEntity(env, entityId).length > 0;

export const hasLocalSignerForEntitySigner = (
  env: RuntimeState,
  entityId: string,
  signerId: string,
): boolean => {
  const targetSignerId = String(signerId || '').toLowerCase();
  return Boolean(
    targetSignerId &&
    getLocalSignerIdsForEntity(env, entityId).some(
      localSignerId => localSignerId.toLowerCase() === targetSignerId,
    ),
  );
};

export const resolveSoleLocalSignerForEntity = (
  env: RuntimeState,
  entityId: string,
): string | null => {
  const signerIds = getLocalSignerIdsForEntity(env, entityId);
  return signerIds.length === 1 ? signerIds[0]! : null;
};
