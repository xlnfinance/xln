import type { EntityReplica, Env } from './types';

export function getReplicaByEntityId(env: Pick<Env, 'eReplicas'>, entityId: string): EntityReplica | undefined {
  const target = String(entityId).toLowerCase();
  for (const replica of env.eReplicas.values()) {
    if (String(replica.state.entityId).toLowerCase() === target) return replica;
  }
  return undefined;
}

export function getFirstSignerForEntity(env: Pick<Env, 'eReplicas'>, entityId: string): string | null {
  return getReplicaByEntityId(env, entityId)?.state.config.validators[0] ?? null;
}
