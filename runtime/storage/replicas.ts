import type { EntityReplica, EntityState, Env } from '../types';
import { normalizeEntityId } from './keys';
import type { StorageReplicaLookup } from './types';

export const findReplicaForEntity = (
  env: Env,
  entityId: string,
  lookup?: StorageReplicaLookup,
): { replicaKey: string; replica: EntityReplica; state: EntityState } | null => {
  const normalized = normalizeEntityId(entityId);
  if (lookup) return lookup.get(normalized) ?? null;
  for (const [replicaKey, replica] of env.eReplicas.entries()) {
    const candidate = String(replica?.entityId || String(replicaKey).split(':')[0] || '').toLowerCase();
    if (candidate === normalized) return { replicaKey: String(replicaKey), replica, state: replica.state };
  }
  return null;
};

export const buildReplicaLookup = (env: Env): StorageReplicaLookup => {
  const lookup: StorageReplicaLookup = new Map();
  for (const [replicaKey, replica] of env.eReplicas.entries()) {
    if (!replica?.state) continue;
    const entityId = normalizeEntityId(replica.entityId || replica.state.entityId || String(replicaKey).split(':')[0] || '');
    if (!entityId) continue;
    lookup.set(entityId, { replicaKey: String(replicaKey), replica, state: replica.state });
  }
  return lookup;
};
