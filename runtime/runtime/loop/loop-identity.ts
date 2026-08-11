import { deriveSignerAddressSync, getSignerPrivateKeyIfAvailable } from '../../account/crypto.ts';
import { extractEntityId, extractSignerId } from '../../protocol/identity.ts';
import { createStructuredLogger } from '../../infra/logger.ts';
import { normalizeRuntimeId } from '../../network/p2p/runtime-id.ts';
import type { RuntimeReplica } from '../types.ts';

const identityLog = createStructuredLogger('runtime.identity');

export const getRuntimeEnv = (env?: RuntimeReplica | null): RuntimeReplica | null => {
  if (!env) {
    identityLog.warn('env.missing');
    return null;
  }
  return env;
};

export const deriveRuntimeId = (seed: string): string =>
  normalizeRuntimeId(deriveSignerAddressSync(seed, '1'));

export const getLocalSignerIdsForEntity = (env: RuntimeReplica, entityId: string): string[] => {
  const targetEntityId = String(entityId || '').toLowerCase();
  const signerIds = new Set<string>();
  for (const replicaKey of env.state.eReplicas.keys()) {
    const replicaEntityId = extractEntityId(replicaKey).toLowerCase();
    const signerId = extractSignerId(replicaKey);
    if (replicaEntityId !== targetEntityId || !signerId) continue;
    if (getSignerPrivateKeyIfAvailable(env, signerId) !== null) signerIds.add(signerId);
  }
  return [...signerIds];
};

export const getLocalEntitySignerKeys = (env: RuntimeReplica): Set<string> => {
  const keys = new Set<string>();
  for (const replicaKey of env.state.eReplicas.keys()) {
    const entityId = extractEntityId(replicaKey).toLowerCase();
    const signerId = extractSignerId(replicaKey).toLowerCase();
    if (entityId && signerId && getSignerPrivateKeyIfAvailable(env, signerId) !== null) {
      keys.add(`${entityId}\u0000${signerId}`);
    }
  }
  return keys;
};

export const hasLocalSignerForEntity = (env: RuntimeReplica, entityId: string): boolean =>
  getLocalSignerIdsForEntity(env, entityId).length > 0;

export const hasLocalSignerForEntitySigner = (
  env: RuntimeReplica,
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
  env: RuntimeReplica,
  entityId: string,
): string | null => {
  const signerIds = getLocalSignerIdsForEntity(env, entityId);
  return signerIds.length === 1 ? signerIds[0]! : null;
};
