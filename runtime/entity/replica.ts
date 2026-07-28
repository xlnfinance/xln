import type { EntityReplica, RuntimeState } from '../types';

export function getReplicaByEntityId(env: Pick<RuntimeState, 'eReplicas'>, entityId: string): EntityReplica | undefined {
  const target = String(entityId).toLowerCase();
  for (const replica of env.eReplicas.values()) {
    if (String(replica.state.entityId).toLowerCase() === target) return replica;
  }
  return undefined;
}
