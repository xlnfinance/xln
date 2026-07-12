import type { EntityReplica, Env } from '../types';

export const getEntityReplicaById = (env: Env, entityId: string): EntityReplica | null => {
  const target = String(entityId || '').trim().toLowerCase();
  if (!target || !env.eReplicas) return null;
  for (const [key, replica] of env.eReplicas.entries()) {
    if (typeof key === 'string' && key.toLowerCase().startsWith(`${target}:`)) return replica;
  }
  return null;
};
