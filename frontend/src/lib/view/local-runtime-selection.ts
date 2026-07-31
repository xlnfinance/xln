type LocalReplicaIdentity = {
  entityId?: string;
  signerId?: string;
};

type LocalSignerIdentity = {
  entityId?: string;
  address?: string;
};

const normalizeId = (value: unknown): string => String(value || '').trim().toLowerCase();

export const resolveActiveLocalReplica = <T extends LocalReplicaIdentity>(
  replicas: Map<string, T> | null | undefined,
  signer: LocalSignerIdentity | null | undefined,
): T | null => {
  const entityId = normalizeId(signer?.entityId);
  const signerId = normalizeId(signer?.address);
  if (!replicas || !entityId || !signerId) return null;

  for (const [key, replica] of replicas) {
    const [keyEntityId, keySignerId] = String(key).split(':');
    const replicaEntityId = normalizeId(replica.entityId || keyEntityId);
    const replicaSignerId = normalizeId(replica.signerId || keySignerId);
    if (replicaEntityId === entityId && replicaSignerId === signerId) return replica;
  }
  return null;
};
