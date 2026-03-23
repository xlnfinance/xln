import { ethers } from 'ethers';

import { safeStringify } from '../serialization-utils';

const buildPersistedEnvHashInput = (snapshot: Record<string, unknown>): Record<string, unknown> => {
  const eReplicas = Array.isArray(snapshot.eReplicas)
    ? snapshot.eReplicas.map((entry) => {
        if (!Array.isArray(entry) || entry.length !== 2) return entry;
        const [replicaKey, rawReplica] = entry as [unknown, Record<string, unknown>];
        const replica = rawReplica ? { ...rawReplica } : rawReplica;
        if (replica && 'hankoWitness' in replica) {
          delete replica.hankoWitness;
        }
        const state =
          replica && typeof replica === 'object' && replica.state && typeof replica.state === 'object'
            ? { ...(replica.state as Record<string, unknown>) }
            : undefined;
        if (state && 'batchHistory' in state) {
          delete state.batchHistory;
        }
        return [
          replicaKey,
          state ? { ...replica, state } : replica,
        ];
      })
    : snapshot.eReplicas;
  return {
    eReplicas,
  };
};

const serializePersistedEnvHashInput = (snapshot: Record<string, unknown>): string =>
  safeStringify(buildPersistedEnvHashInput(snapshot));

export const computePersistedEnvStateHash = (snapshot: Record<string, unknown>): string => {
  return ethers.keccak256(ethers.toUtf8Bytes(serializePersistedEnvHashInput(snapshot)));
};
