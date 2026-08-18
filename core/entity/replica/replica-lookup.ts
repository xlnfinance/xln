import type { EntityReplica } from '../types';
import type { EntityRuntimeContext } from '../runtime-context';

export const getEntityReplicaById = (env: EntityRuntimeContext, entityId: string): EntityReplica | null => {
  const target = String(entityId || '').trim().toLowerCase();
  if (!target || !env.state.eReplicas) return null;
  for (const [key, replica] of env.state.eReplicas.entries()) {
    if (typeof key === 'string' && key.toLowerCase().startsWith(`${target}:`)) return replica;
  }
  return null;
};
