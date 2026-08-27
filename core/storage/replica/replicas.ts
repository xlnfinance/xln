import type { EntityReplica, EntityState } from '../../entity/types';
import type { RuntimeReplica } from '../../runtime/types';
import { compareStableText } from '../../protocol/serialization';
import {
  buildCertifiedEntityHeadPlan,
  type CertifiedEntityHeadPlan,
} from './entity-head';
import { computeStorageReplicaMetaDigest } from './replica-meta-digest';
import { keyLiveReplicaMeta, normalizeEntityId } from '../keys';
import { encodeReplicaMeta } from '../read/projections';
import { decodeBuffer, encodeBuffer } from '../codec/codec';
import type { StorageReplicaLookup } from '../types';
import { computeIntegrityDigest } from '../../support/bytes/integrity-checksum';
import { computeCanonicalEntityConsensusStateHash } from '../../entity/consensus/state-root';

/**
 * A compact materialized Entity graph has one committed state per Entity.
 * Validator-local lag is replay state, so a checkpoint must wait until every
 * local replica names the same height/head/root; otherwise it would need to
 * duplicate an unbounded Account/Book graph in replica metadata.
 */
export const areStorageCheckpointReplicasConverged = (env: RuntimeReplica): boolean => {
  const endpoints = new Map<string, { state: EntityState; height: number; head: string; root?: string }>();
  for (const replica of env.state.eReplicas.values()) {
    const entityId = normalizeEntityId(replica.entityId || replica.state.entityId || '');
    if (!entityId) continue;
    const height = replica.state.height;
    const head = height === 0 ? 'genesis' : String(replica.state.prevFrameHash || '').toLowerCase();
    const existing = endpoints.get(entityId);
    if (!existing) {
      endpoints.set(entityId, { state: replica.state, height, head });
      continue;
    }
    if (existing.height !== height || existing.head !== head) return false;
    if (existing.state === replica.state) continue;
    existing.root ??= computeCanonicalEntityConsensusStateHash(existing.state);
    if (existing.root !== computeCanonicalEntityConsensusStateHash(replica.state)) return false;
  }
  return true;
};

/**
 * A materialized checkpoint becomes the new replay floor. Validator-private
 * proposals and candidates are deterministic overlays rebuilt from the WAL,
 * so cutting the WAL before they settle would discard their creating input.
 * Wait for an idle boundary instead of serializing an unbounded candidate.
 */
export const areStorageCheckpointReplicasQuiescent = (env: RuntimeReplica): boolean => {
  if (!areStorageCheckpointReplicasConverged(env)) return false;
  for (const replica of env.state.eReplicas.values()) {
    if (
      replica.mempool.length > 0
      || replica.proposal !== undefined
      || replica.lockedFrame !== undefined
      || replica.candidate !== undefined
    ) return false;
  }
  return true;
};

export const findReplicaForEntity = (
  env: RuntimeReplica,
  entityId: string,
  lookup?: StorageReplicaLookup,
): { replicaKey: string; replica: EntityReplica; state: EntityState } | null => {
  const normalized = normalizeEntityId(entityId);
  return (lookup ?? buildReplicaLookup(env)).get(normalized) ?? null;
};

export const buildReplicaLookup = (env: RuntimeReplica): StorageReplicaLookup => {
  return buildCertifiedEntityHeadPlan(env).lookup;
};

/**
 * Selects the live replica used to project dirty docs without re-validating
 * every certified head. The authoritative checkpoint path performs the
 * full validation; ordinary WAL frames bind only already-certified heads and
 * are replayed from that checkpoint after a crash.
 */
const buildLiveReplicaLookup = (env: RuntimeReplica): StorageReplicaLookup => {
  const lookup: StorageReplicaLookup = new Map();
  for (const [replicaKey, replica] of [...env.state.eReplicas.entries()].sort(([left], [right]) => (
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

export const buildLiveReplicaMetaPlan = (env: RuntimeReplica): CertifiedEntityHeadPlan => {
  const headByReplicaKey = new Map();
  for (const [replicaKey, replica] of env.state.eReplicas.entries()) {
    headByReplicaKey.set(String(replicaKey), replica.certifiedFrameHead);
  }
  return {
    lookup: buildLiveReplicaLookup(env),
    headByReplicaKey,
  };
};

export const buildStorageReplicaMetaCommitment = (
  env: RuntimeReplica,
  headPlan = buildCertifiedEntityHeadPlan(env),
): {
  entries: Array<{ key: Buffer; value: Buffer }>;
  digest: string;
} => buildStorageReplicaMetaCommitmentFromCheckpointPlan(env, headPlan);

/**
 * Build metadata from the exact full-head plan validated for this Runtime
 * height. The storage commit path serializes that immutable plan once for
 * lookup, commitment, and post-commit publication.
 */
export const buildStorageReplicaMetaCommitmentFromCheckpointPlan = (
  env: RuntimeReplica,
  checkpointPlan: CertifiedEntityHeadPlan,
): {
  entries: Array<{ key: Buffer; value: Buffer }>;
  digest: string;
} => {
  const entries: Array<{ key: Buffer; value: Buffer }> = [];
  for (const [replicaKey, replica] of env.state.eReplicas.entries()) {
    if (!replica?.state) continue;
    const entityId = normalizeEntityId(replica.entityId || replica.state.entityId || '');
    const signerId = normalizeEntityId(replica.signerId || '');
    if (!entityId || !signerId) {
      throw new Error(`STORAGE_REPLICA_SIGNER_MISSING:${entityId}`);
    }
    entries.push({
      key: keyLiveReplicaMeta(entityId, signerId),
      value: encodeReplicaMeta(replica, {
        certifiedFrameHead: checkpointPlan.headByReplicaKey.get(String(replicaKey)),
      }),
    });
  }
  return { entries, digest: computeStorageReplicaMetaDigest(entries) };
};

export const buildStorageLiveReplicaMetaCommitment = (env: RuntimeReplica): {
  entries: Array<{ key: Buffer; value: Buffer }>;
  digest: string;
} => {
  const entries: Array<{ key: Buffer; value: Buffer }> = [];
  for (const [replicaKey, replica] of env.state.eReplicas.entries()) {
    if (!replica?.state) continue;
    const entityId = normalizeEntityId(replica.entityId || replica.state.entityId || '');
    const signerId = normalizeEntityId(replica.signerId || '');
    if (!entityId || !signerId) throw new Error(`STORAGE_REPLICA_SIGNER_MISSING:${entityId}`);
    // EntityState cannot include its own certified frame because the frame
    // contains stateRoot. The parent Runtime replica-meta commitment therefore
    // binds the exact full head bytes. Checkpoints persist those bytes; ordinary
    // frames persist their digest so one mutated signature/manifest byte still
    // changes Runtime postStateHash without copying the full Entity graph.
    const head = replica.certifiedFrameHead;
    const certifiedFrameHeadDigest = head
      ? computeIntegrityDigest(encodeBuffer(head, { omitSymbolKeys: true }))
      : undefined;
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
        ...(certifiedFrameHeadDigest ? { certifiedFrameHeadDigest } : {}),
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

const requireDecodedRecord = (value: unknown, key: Buffer): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`STORAGE_REPLICA_META_RECORD_REQUIRED:key=0x${key.toString('hex')}`);
  }
  return value as Record<string, unknown>;
};

export const summarizeStorageReplicaMetaFields = (
  entries: readonly { key: Buffer; value: Buffer }[],
): Array<{ key: string; fields: Array<{ name: string; valueHash: string }> }> => entries.map(entry => {
  const value = requireDecodedRecord(decodeBuffer(entry.value), entry.key);
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
): Array<{ key: string; entityHead: unknown; certifiedFrameHeadDigest: unknown }> => entries.map(entry => {
  const value = requireDecodedRecord(decodeBuffer(entry.value), entry.key);
  return {
    key: entry.key.toString('hex'),
    entityHead: value['entityHead'],
    certifiedFrameHeadDigest: value['certifiedFrameHeadDigest'] ?? null,
  };
}).sort((left, right) => compareStableText(left.key, right.key));
