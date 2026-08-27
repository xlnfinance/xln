/**
 * Durable StorageReplicaMeta is not a live EntityReplica. Transient consensus
 * overlays stay in RAM; a storage decoder that required them would either
 * reject every current row or become a compatibility reader for retired bodies.
 */
import {
  FinancialDataCorruptionError,
  validateObject,
  validateString,
} from '../../protocol/boundary/validation-primitives';
import { assertEntityReplicaCoordination } from '../../entity/replica/replica-validation';
import type { StorageReplicaMeta } from '../types';

const STORAGE_REPLICA_META_KEYS = new Set<string>([
  'entityId',
  'signerId',
  'isProposer',
  'htlcNotes',
  'position',
  'certifiedFrameHead',
  'hankoWitness',
  'leaderVotes',
  'pendingLeaderCertificate',
  'lastConsensusProgressAt',
  'jHistory',
  'jPrefixRound',
  'jSubmitState',
  'entityProviderActionSubmitState',
]);

export const validateStorageReplicaMeta = (
  value: unknown,
  context: string,
): StorageReplicaMeta => {
  const replica = validateObject(value, context);
  if (Object.hasOwn(replica, 'entityEncPrivKey')) {
    throw new FinancialDataCorruptionError(
      `${context}.entityEncPrivKey must not be persisted`,
    );
  }
  const unexpected = Object.keys(replica).filter(field => !STORAGE_REPLICA_META_KEYS.has(field));
  if (unexpected.length > 0) {
    throw new FinancialDataCorruptionError(
      `${context} contains unexpected fields: ${unexpected.sort().join(',')}`,
    );
  }
  validateString(replica['entityId'], `${context}.entityId`);
  assertEntityReplicaCoordination(replica, context);
  return replica as StorageReplicaMeta;
};
