import type { EntityReplica, RuntimeState } from '../types';

export const getEntityReplicaById = (env: RuntimeState, entityId: string): EntityReplica | null => {
  const target = String(entityId || '').trim().toLowerCase();
  if (!target || !env.eReplicas) return null;
  for (const [key, replica] of env.eReplicas.entries()) {
    if (typeof key === 'string' && key.toLowerCase().startsWith(`${target}:`)) return replica;
  }
  return null;
};
