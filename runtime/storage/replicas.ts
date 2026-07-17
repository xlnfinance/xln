import type { EntityReplica, EntityState, Env } from '../types';
import { encodeBuffer } from './codec';
import {
  buildCertifiedEntityLineagePlan,
  rebaseCertifiedEntityLineageAtRuntimeCheckpoint,
} from './entity-lineage';
import { computeStorageReplicaMetaDigest } from './hashes';
import { keyLiveReplicaMeta, normalizeEntityId } from './keys';
import { projectReplicaMeta } from './projections';
import type { StorageReplicaLookup } from './types';

export const findReplicaForEntity = (
  env: Env,
  entityId: string,
  lookup?: StorageReplicaLookup,
): { replicaKey: string; replica: EntityReplica; state: EntityState } | null => {
  const normalized = normalizeEntityId(entityId);
  return (lookup ?? buildReplicaLookup(env)).get(normalized) ?? null;
};

export const buildReplicaLookup = (env: Env): StorageReplicaLookup => {
  return buildCertifiedEntityLineagePlan(env).lookup;
};

export const buildStorageReplicaMetaCommitment = (
  env: Env,
  lineagePlan = buildCertifiedEntityLineagePlan(env),
): {
  entries: Array<{ key: Buffer; value: Buffer }>;
  digest: string;
} => {
  const checkpointPlan = rebaseCertifiedEntityLineageAtRuntimeCheckpoint(env, lineagePlan);
  const entries: Array<{ key: Buffer; value: Buffer }> = [];
  for (const [replicaKey, replica] of env.eReplicas.entries()) {
    if (!replica?.state) continue;
    const entityId = normalizeEntityId(replica.entityId || replica.state.entityId || '');
    const signerId = normalizeEntityId(replica.signerId || '');
    if (!entityId || !signerId) {
      throw new Error(`STORAGE_REPLICA_SIGNER_MISSING:${entityId}`);
    }
    entries.push({
      key: keyLiveReplicaMeta(entityId, signerId),
      value: encodeBuffer(projectReplicaMeta(replica, {
        certifiedFrameLineage: checkpointPlan.lineageByReplicaKey.get(String(replicaKey)),
        certifiedFrameAnchor: checkpointPlan.anchorByReplicaKey.get(String(replicaKey)),
      })),
    });
  }
  return { entries, digest: computeStorageReplicaMetaDigest(entries) };
};
