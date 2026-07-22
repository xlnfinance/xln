import type { EntityReplica, EntityState, Env } from '../types';
import { compareStableText } from '../protocol/serialization';
import {
  buildCertifiedEntityLineagePlan,
  rebaseCertifiedEntityLineageAtRuntimeCheckpoint,
  type CertifiedEntityLineagePlan,
} from './entity-lineage';
import { computeStorageReplicaMetaDigest } from './hashes';
import { keyLiveReplicaMeta, normalizeEntityId } from './keys';
import { encodeReplicaMeta } from './projections';
import { decodeBuffer, encodeBuffer } from './codec';
import type { StorageReplicaLookup } from './types';
import { computeIntegrityDigest } from '../infra/integrity-checksum';

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

/**
 * Selects the live replica used to project dirty docs without re-validating
 * every certified lineage. The authoritative checkpoint path performs the
 * full validation; ordinary WAL frames bind only already-certified heads and
 * are replayed from that checkpoint after a crash.
 */
export const buildLiveReplicaLookup = (env: Env): StorageReplicaLookup => {
  const lookup: StorageReplicaLookup = new Map();
  for (const [replicaKey, replica] of [...env.eReplicas.entries()].sort(([left], [right]) => (
    compareStableText(String(left).toLowerCase(), String(right).toLowerCase())
  ))) {
    if (!replica?.state) continue;
    const entityId = normalizeEntityId(replica.entityId || replica.state.entityId || '');
    if (!entityId) continue;
    const current = lookup.get(entityId);
    if (!current || replica.state.height > current.state.height) {
      lookup.set(entityId, { replicaKey: String(replicaKey), replica, state: replica.state });
    }
  }
  return lookup;
};

export const buildLiveReplicaMetaPlan = (env: Env): CertifiedEntityLineagePlan => {
  const lineageByReplicaKey = new Map();
  const anchorByReplicaKey = new Map();
  for (const [replicaKey, replica] of env.eReplicas.entries()) {
    if (replica.certifiedFrameLineage) {
      lineageByReplicaKey.set(String(replicaKey), replica.certifiedFrameLineage);
    }
    if (replica.certifiedFrameAnchor) {
      anchorByReplicaKey.set(String(replicaKey), replica.certifiedFrameAnchor);
    }
  }
  return {
    lookup: buildLiveReplicaLookup(env),
    lineageByReplicaKey,
    anchorByReplicaKey,
  };
};

export const buildStorageReplicaMetaCommitment = (
  env: Env,
  lineagePlan = buildCertifiedEntityLineagePlan(env),
): {
  entries: Array<{ key: Buffer; value: Buffer }>;
  digest: string;
} => buildStorageReplicaMetaCommitmentFromCheckpointPlan(
  env,
  rebaseCertifiedEntityLineageAtRuntimeCheckpoint(env, lineagePlan),
);

/**
 * Build metadata from a lineage plan already rebased for this exact Runtime
 * height. The storage commit path validates and rebases once, then reuses the
 * same immutable plan for lookup, metadata, and post-commit publication.
 */
export const buildStorageReplicaMetaCommitmentFromCheckpointPlan = (
  env: Env,
  checkpointPlan: ReturnType<typeof rebaseCertifiedEntityLineageAtRuntimeCheckpoint>,
  options: { omitIntermediateSingleSignerState?: boolean } = {},
): {
  entries: Array<{ key: Buffer; value: Buffer }>;
  digest: string;
} => {
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
      value: encodeReplicaMeta(replica, {
        certifiedFrameLineage: checkpointPlan.lineageByReplicaKey.get(String(replicaKey)),
        certifiedFrameAnchor: checkpointPlan.anchorByReplicaKey.get(String(replicaKey)),
        ...(options.omitIntermediateSingleSignerState === true && replica.state.config.validators.length === 1
          ? { omitState: true }
          : {}),
      }),
    });
  }
  return { entries, digest: computeStorageReplicaMetaDigest(entries) };
};

export const buildStorageLiveReplicaMetaCommitment = (env: Env): {
  entries: Array<{ key: Buffer; value: Buffer }>;
  digest: string;
} => {
  const entries: Array<{ key: Buffer; value: Buffer }> = [];
  for (const [replicaKey, replica] of env.eReplicas.entries()) {
    if (!replica?.state) continue;
    const entityId = normalizeEntityId(replica.entityId || replica.state.entityId || '');
    const signerId = normalizeEntityId(replica.signerId || '');
    if (!entityId || !signerId) throw new Error(`STORAGE_REPLICA_SIGNER_MISSING:${entityId}`);
    const latestLineage = replica.certifiedFrameLineage?.at(-1);
    entries.push({
      key: keyLiveReplicaMeta(entityId, signerId),
      value: encodeBuffer({
        replicaKey: String(replicaKey).toLowerCase(),
        entityId,
        signerId,
        isProposer: replica.isProposer,
        entityHead: {
          entityId: normalizeEntityId(replica.state.entityId),
          height: replica.state.height,
          timestamp: replica.state.timestamp,
          frameHash: replica.state.prevFrameHash ?? '',
        },
        mempool: replica.mempool,
        ...(replica.proposal ? { proposal: replica.proposal } : {}),
        ...(replica.lockedFrame ? { lockedFrame: replica.lockedFrame } : {}),
        ...(replica.validatorExecution ? { validatorExecution: replica.validatorExecution } : {}),
        ...(latestLineage ? { latestLineage } : {}),
        ...(replica.certifiedFrameAnchor ? { certifiedFrameAnchor: replica.certifiedFrameAnchor } : {}),
        ...(replica.leaderVotes ? { leaderVotes: replica.leaderVotes } : {}),
        ...(replica.pendingLeaderCertificate
          ? { pendingLeaderCertificate: replica.pendingLeaderCertificate }
          : {}),
        ...(replica.jPrefixRound ? { jPrefixRound: replica.jPrefixRound } : {}),
        ...(replica.jSubmitState ? { jSubmitState: replica.jSubmitState } : {}),
        ...(replica.entityProviderActionSubmitState
          ? { entityProviderActionSubmitState: replica.entityProviderActionSubmitState }
          : {}),
      }, { omitSymbolKeys: true }),
    });
  }
  return { entries, digest: computeStorageReplicaMetaDigest(entries) };
};

export const summarizeStorageReplicaMetaEntries = (
  entries: readonly { key: Buffer; value: Buffer }[],
): Array<{ key: string; valueHash: string }> => entries.map(entry => ({
  key: entry.key.toString('hex'),
  valueHash: computeIntegrityDigest(entry.value),
})).sort((left, right) => compareStableText(left.key, right.key));

export const inspectStorageReplicaMetaEntries = (
  entries: readonly { key: Buffer; value: Buffer }[],
): Array<{ key: string; value: unknown }> => entries.map(entry => ({
  key: entry.key.toString('hex'),
  value: decodeBuffer(entry.value),
})).sort((left, right) => compareStableText(left.key, right.key));

export const summarizeStorageReplicaMetaFields = (
  entries: readonly { key: Buffer; value: Buffer }[],
): Array<{ key: string; fields: Array<{ name: string; valueHash: string }> }> => entries.map(entry => {
  const value = decodeBuffer<Record<string, unknown>>(entry.value);
  return {
    key: entry.key.toString('hex'),
    fields: Object.keys(value).sort(compareStableText).map(name => ({
      name,
      valueHash: computeIntegrityDigest(encodeBuffer(value[name])),
    })),
  };
}).sort((left, right) => compareStableText(left.key, right.key));

export const summarizeStorageReplicaMetaHeads = (
  entries: readonly { key: Buffer; value: Buffer }[],
): Array<{ key: string; entityHead: unknown; latestLineageHead: unknown }> => entries.map(entry => {
  const value = decodeBuffer<Record<string, unknown>>(entry.value);
  const latestLineage = value['latestLineage'] as {
    frame?: {
      height?: unknown;
      hash?: unknown;
      stateRoot?: unknown;
      accountRoots?: unknown;
      parentFrameHash?: unknown;
      authorityRoot?: unknown;
      jPrefixCertificate?: unknown;
      txs?: Array<{ type?: unknown }>;
    };
  } | undefined;
  return {
    key: entry.key.toString('hex'),
    entityHead: value['entityHead'],
    latestLineageHead: latestLineage?.frame
      ? {
          height: latestLineage.frame.height,
          hash: latestLineage.frame.hash,
          stateRoot: latestLineage.frame.stateRoot,
          accountRootsHash: computeIntegrityDigest(encodeBuffer(latestLineage.frame.accountRoots ?? null)),
          parentFrameHash: latestLineage.frame.parentFrameHash,
          authorityRoot: latestLineage.frame.authorityRoot,
          jPrefixHash: computeIntegrityDigest(encodeBuffer(latestLineage.frame.jPrefixCertificate ?? null)),
          txTypes: latestLineage.frame.txs?.map(tx => tx.type) ?? [],
          txsHash: computeIntegrityDigest(encodeBuffer(latestLineage.frame.txs ?? [])),
        }
      : null,
  };
}).sort((left, right) => compareStableText(left.key, right.key));
