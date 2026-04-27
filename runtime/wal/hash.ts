import { ethers } from 'ethers';

import { safeStringify } from '../serialization-utils';

const sortPairs = <T>(pairs: Array<[string, T]>): Array<[string, T]> =>
  pairs.sort((left, right) => {
    if (left[0] < right[0]) return -1;
    if (left[0] > right[0]) return 1;
    return 0;
  });

const buildPersistedEnvHashInput = (snapshot: Record<string, unknown>): Record<string, unknown> => {
  const eReplicas = Array.isArray(snapshot['eReplicas'])
    ? sortPairs(snapshot['eReplicas'].map((entry) => {
        if (!Array.isArray(entry) || entry.length !== 2) return entry;
        const [, rawReplica] = entry as [unknown, Record<string, unknown>];
        const replica = rawReplica ? { ...rawReplica } : rawReplica;
        const state =
          replica && typeof replica === 'object' && replica['state'] && typeof replica['state'] === 'object'
            ? { ...(replica['state'] as Record<string, unknown>) }
            : undefined;
        if (state && 'batchHistory' in state) {
          delete state['batchHistory'];
        }
        const entityId =
          typeof state?.['entityId'] === 'string' && state['entityId'].length > 0
            ? state['entityId']
            : typeof replica?.['entityId'] === 'string' && replica['entityId'].length > 0
              ? replica['entityId']
              : null;
        return entityId ? [entityId, state ?? null] : entry;
      }).filter((entry): entry is [string, unknown] => Array.isArray(entry) && entry.length === 2 && typeof entry[0] === 'string'))
    : snapshot['eReplicas'];
  const jReplicas = Array.isArray(snapshot['jReplicas'])
    ? sortPairs(snapshot['jReplicas'].map((entry) => {
        if (!Array.isArray(entry) || entry.length !== 2) return entry;
        const [name, rawReplica] = entry as [unknown, Record<string, unknown>];
        if (typeof name !== 'string') return entry;
        const replica = rawReplica ? { ...rawReplica } : rawReplica;
        if (replica && typeof replica === 'object' && 'mempool' in replica) {
          delete replica['mempool'];
        }
        return [name, replica ?? null] as [string, unknown];
      }).filter((entry): entry is [string, unknown] => Array.isArray(entry) && entry.length === 2 && typeof entry[0] === 'string'))
    : snapshot['jReplicas'];
  return {
    height: snapshot['height'],
    timestamp: snapshot['timestamp'],
    ...(typeof snapshot['activeJurisdiction'] === 'string' && snapshot['activeJurisdiction'].length > 0
      ? { activeJurisdiction: snapshot['activeJurisdiction'] }
      : {}),
    eReplicas,
    jReplicas,
  };
};

const serializePersistedEnvHashInput = (snapshot: Record<string, unknown>): string =>
  safeStringify(buildPersistedEnvHashInput(snapshot));

export const computePersistedEnvStateHash = (snapshot: Record<string, unknown>): string => {
  const serialized = serializePersistedEnvHashInput(snapshot);
  return ethers.keccak256(ethers.toUtf8Bytes(serialized));
};
