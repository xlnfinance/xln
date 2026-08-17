/**
 * Canonical Runtime WAL commitments over typed child roots and durable state.
 * Entity roots already commit Account and Book Patricia graphs, so this file
 * must never rebuild a second Merkle tree from storage documents.
 * Human-audit importance: 100/100 — these hashes identify crash replay state.
 */
import { computeIntegrityDigest } from '../infra/integrity-checksum';
import { compareStableText } from '../protocol/serialization';
import type { RuntimeReplica } from '../runtime/types';
import {
  computeCanonicalEntityHash,
  computeCanonicalRuntimeStateHash,
} from './canonical-hash';
import { encodeBinaryPayload } from './codec/binary-codec';
import { STORAGE_FRAME_FORMAT, normalizeEntityId } from './keys';
import { buildReplicaLookup } from './replica/replicas';
import type { RuntimeFrame, StorageFrameEntityHash } from './types';
import { buildStorageRuntimeMachineSnapshot } from './wal/snapshot';

const hashStable = (value: unknown): string =>
  computeIntegrityDigest(encodeBinaryPayload(value, 'msgpack'));

/** Bounded Entity roots plus durable Runtime state form the only checkpoint root. */
export const prepareStorageCanonicalStateHashes = (
  env: RuntimeReplica,
  touchedEntities: string[],
  previousFrame: RuntimeFrame | null,
  replicaLookup = buildReplicaLookup(env),
  runtimeMachine = buildStorageRuntimeMachineSnapshot(env),
): { canonicalStateHash: string; canonicalEntityHashes: StorageFrameEntityHash[] } => {
  void touchedEntities;
  void previousFrame;
  const canonicalEntityHashes = Array.from(
    replicaLookup.values(),
    ({ replica }) => computeCanonicalEntityHash(replica),
  ).sort((left, right) => compareStableText(left.entityId, right.entityId));
  return {
    canonicalEntityHashes,
    canonicalStateHash: computeCanonicalRuntimeStateHash(
      env.state.height,
      env.state.timestamp,
      canonicalEntityHashes,
      runtimeMachine,
    ),
  };
};

/** Hash the compact WAL frame; payload bodies remain content-addressed rows. */
export const computeStorageFrameHash = (record: RuntimeFrame): string => {
  const stableRecord = { ...record };
  delete stableRecord.frameHash;
  return hashStable({
    kind: STORAGE_FRAME_FORMAT.domain,
    ...stableRecord,
    canonicalEntityHashes: (stableRecord.canonicalEntityHashes ?? [])
      .map(entry => ({
        entityId: normalizeEntityId(entry.entityId),
        hash: entry.hash,
        cellCount: entry.cellCount,
      }))
      .sort((left, right) => compareStableText(left.entityId, right.entityId)),
  });
};

/** Per-frame replay oracle over dirty component hashes and immutable outputs. */
export const computeStoragePostStateHash = (input: {
  height: number;
  timestamp: number;
  replicaMetaDigest: string;
  runtimeComponentDigests: readonly Readonly<{ key: string; valueHash: string }>[];
  runtimeOutputRefs: readonly string[];
  runtimeOutputRetryState: ReadonlyArray<
    NonNullable<RuntimeFrame['runtimeOutputRetryState']>[number]
  >;
}): string => hashStable({
  kind: STORAGE_FRAME_FORMAT.postStateDomain,
  height: input.height,
  timestamp: input.timestamp,
  replicaMetaDigest: input.replicaMetaDigest,
  runtimeComponentDigests: input.runtimeComponentDigests,
  runtimeOutputRefs: input.runtimeOutputRefs,
  runtimeOutputRetryState: input.runtimeOutputRetryState ?? [],
});

/** One hash per Runtime component keeps the parent commitment O(dirty). */
export const computeRuntimePostStateComponentDigests = (
  view: Readonly<Record<string, unknown>>,
): ReadonlyArray<Readonly<{ key: string; valueHash: string }>> =>
  Object.keys(view)
    .sort(compareStableText)
    .map(key => ({ key, valueHash: hashStable(view[key]) }));
