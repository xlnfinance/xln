import { computeCanonicalRuntimeStateHash } from '../canonical-hash';
import { computeStorageFrameHash } from '../hashes';
import { computeStorageReplicaMetaDigest } from '../replica/replica-meta-digest';
import { readSnapshotDocs } from '../database/lifecycle';
import { verifyLiveStorageIntegrity } from './integrity/live';
import {
  KEY_LIVE_REPLICA_META,
  STORAGE_VERIFY_TAIL_FRAMES,
  ZERO_FRAME_HASH,
  keySnapshotAccountPrefix,
  keySnapshotBookPrefix,
  keySnapshotEntityPrefix,
  keySnapshotManifest,
  keySnapshotReplicaMetaPrefix,
  keyLiveReplicaMetaPrefix,
} from '../keys';
import { countKeys, iterateKeys, readValidatedOrNull } from '../database/level';
import { validateStorageSnapshotManifestValue } from '../schema/authoritative-schema';
import { inspectSnapshotGraphRows } from './integrity/snapshot-graph';
import {
  readStorageFramePayloads,
  readStorageFrameRecord,
  readStorageHead,
} from './read';
import type { RuntimeDbLike, RuntimeFrame, StorageHead } from '../types';

const countSnapshotDocs = async (
  db: RuntimeDbLike,
  frame: RuntimeFrame,
): Promise<number> => {
  const height = frame.height;
  const [entities, accounts, books, graphRows, replicaMetas] = await Promise.all([
    countKeys(db, { prefix: keySnapshotEntityPrefix(height) }),
    countKeys(db, { prefix: keySnapshotAccountPrefix(height) }),
    countKeys(db, { prefix: keySnapshotBookPrefix(height) }),
    inspectSnapshotGraphRows(db, height, frame.runtimeMachineRoot),
    countKeys(db, { prefix: keySnapshotReplicaMetaPrefix(height) }),
  ]);
  return entities + accounts + books + graphRows + replicaMetas;
};

const computeSnapshotReplicaMetaDigest = async (
  db: RuntimeDbLike,
  height: number,
): Promise<string> => {
  const entries: Array<{ key: Buffer; value: Buffer }> = [];
  for await (const snapshotKey of iterateKeys(db, { prefix: keySnapshotReplicaMetaPrefix(height) })) {
    if (snapshotKey.length !== 73) {
      throw new Error(
        `STORAGE_VERIFY_SNAPSHOT_REPLICA_META_KEY_INVALID:height=${height}:key=${snapshotKey.toString('hex')}`,
      );
    }
    entries.push({
      key: Buffer.concat([Buffer.from([KEY_LIVE_REPLICA_META]), snapshotKey.subarray(9)]),
      value: await db.get(snapshotKey),
    });
  }
  return computeStorageReplicaMetaDigest(entries);
};

export const verifyStorageSnapshotAtHeight = async (
  db: RuntimeDbLike,
  head: StorageHead,
  snapshotHeightValue: number,
): Promise<void> => {
  const latestHeight = Math.max(0, Math.floor(Number(head.latestHeight ?? 0)));
  const publishedSnapshotHeight = Math.max(0, Math.floor(Number(head.latestSnapshotHeight ?? 0)));
  const snapshotHeight = Math.max(0, Math.floor(Number(snapshotHeightValue ?? 0)));
  if (snapshotHeight <= 0) return;
  if (snapshotHeight > publishedSnapshotHeight) {
    throw new Error(
      `STORAGE_VERIFY_SNAPSHOT_UNPUBLISHED: snapshot=${snapshotHeight} published=${publishedSnapshotHeight}`,
    );
  }
  if (snapshotHeight > latestHeight) {
    throw new Error(`STORAGE_VERIFY_SNAPSHOT_AFTER_HEAD: snapshot=${snapshotHeight} latest=${latestHeight}`);
  }

  const manifest = await readValidatedOrNull(
    db,
    keySnapshotManifest(snapshotHeight),
    validateStorageSnapshotManifestValue,
  );
  if (!manifest) throw new Error(`STORAGE_VERIFY_SNAPSHOT_MANIFEST_MISSING: height=${snapshotHeight}`);
  if (Math.floor(Number(manifest.height ?? 0)) !== snapshotHeight) {
    throw new Error(`STORAGE_VERIFY_SNAPSHOT_MANIFEST_HEIGHT_MISMATCH: key=${snapshotHeight} manifest=${manifest.height}`);
  }

  const snapshotFrame = await readStorageFrameRecord(db, snapshotHeight);
  if (!snapshotFrame) throw new Error(`STORAGE_VERIFY_SNAPSHOT_FRAME_MISSING: height=${snapshotHeight}`);
  if (snapshotFrame.materializedState === false) {
    throw new Error(`STORAGE_VERIFY_SNAPSHOT_NOT_MATERIALIZED: height=${snapshotHeight}`);
  }
  if (!snapshotFrame.runtimeMachineRoot) {
    throw new Error(`STORAGE_VERIFY_SNAPSHOT_RUNTIME_MACHINE_ROOT_MISSING:height=${snapshotHeight}`);
  }
  const actualDocCount = await countSnapshotDocs(db, snapshotFrame);
  const expectedDocCount = Math.max(0, Math.floor(Number(manifest.docCount ?? -1)));
  if (actualDocCount !== expectedDocCount) {
    throw new Error(
      `STORAGE_VERIFY_SNAPSHOT_DOC_COUNT_MISMATCH: height=${snapshotHeight} expected=${expectedDocCount} actual=${actualDocCount}`,
    );
  }
  // This hydrates and verifies every declared Account/Book Patricia root.
  // The replay loader then compares the reconstructed Entity roots with the
  // frame's canonical roots; no parallel document-Merkle is consulted.
  await readSnapshotDocs(db, snapshotHeight);
  if (!snapshotFrame.canonicalStateHash || !snapshotFrame.canonicalEntityHashes) {
    throw new Error(`STORAGE_VERIFY_SNAPSHOT_CANONICAL_ROOTS_MISSING:height=${snapshotHeight}`);
  }
  // Output/Entity-context rows and the height-scoped Runtime-machine graph are
  // immutable snapshot payloads. The machine root was verified above.
  await readStorageFramePayloads(db, snapshotFrame, { includeRuntimeMachine: true });
  const snapshotStateHash = computeCanonicalRuntimeStateHash(
    snapshotFrame.height,
    snapshotFrame.timestamp,
    snapshotFrame.canonicalEntityHashes,
  );
  if (snapshotFrame.canonicalStateHash !== snapshotStateHash) {
    throw new Error(
      `STORAGE_VERIFY_SNAPSHOT_CANONICAL_HASH_MISMATCH:height=${snapshotHeight}:` +
        `expected=${snapshotFrame.canonicalStateHash}:actual=${snapshotStateHash}`,
    );
  }
  const actualReplicaMetaDigest = await computeSnapshotReplicaMetaDigest(db, snapshotHeight);
  if (snapshotFrame.replicaMetaDigest !== actualReplicaMetaDigest) {
    throw new Error(
      `STORAGE_VERIFY_SNAPSHOT_REPLICA_META_DIGEST_MISMATCH:height=${snapshotHeight}:` +
        `expected=${snapshotFrame.replicaMetaDigest || 'missing'}:actual=${actualReplicaMetaDigest}`,
    );
  }
};

const verifyCurrentMaterializedMachine = async (
  db: RuntimeDbLike,
  head: StorageHead,
): Promise<void> => {
  const height = Math.max(0, Math.floor(Number(head.latestMaterializedHeight ?? 0)));
  if (height <= 0) return;
  if (height > head.latestHeight) {
    throw new Error(`STORAGE_VERIFY_MATERIALIZED_AFTER_HEAD: materialized=${height} latest=${head.latestHeight}`);
  }
  const frame = await readStorageFrameRecord(db, height);
  if (!frame) throw new Error(`STORAGE_VERIFY_MATERIALIZED_FRAME_MISSING: height=${height}`);
  if (frame.materializedState !== true || !frame.runtimeMachineRoot) {
    throw new Error(`STORAGE_VERIFY_MATERIALIZED_MACHINE_MISSING: height=${height}`);
  }
  await readStorageFramePayloads(db, frame, { includeRuntimeMachine: true });
};

export const verifyStorageSnapshotIntegrity = async (
  db: RuntimeDbLike,
  head: StorageHead,
): Promise<void> => {
  // Published snapshots retain the exact Runtime/Entity/Account checkpoint;
  // the current materialized graph remains a separately verified live copy.
  await verifyStorageSnapshotAtHeight(db, head, head.latestSnapshotHeight);
  await verifyCurrentMaterializedMachine(db, head);
};

export const verifyStorageTailIntegrity = async (
  db: RuntimeDbLike,
  options: { tailFrames?: number } = {},
): Promise<{ latestHeight: number; checkedFrames: number }> => {
  const head = await readStorageHead(db);
  if (!head || head.latestHeight <= 0) return { latestHeight: 0, checkedFrames: 0 };
  const latestHeight = Math.max(0, Math.floor(Number(head.latestHeight)));
  await verifyLiveStorageIntegrity(db);
  await verifyStorageSnapshotIntegrity(db, head);
  const tailFrames = Math.max(1, Math.floor(Number(options.tailFrames ?? STORAGE_VERIFY_TAIL_FRAMES)));
  const snapshotHeight = Math.max(0, Math.floor(Number(head.latestSnapshotHeight ?? 0)));
  let startHeight = Math.max(1, latestHeight - tailFrames + 1);
  let anchoredAtSnapshot = false;
  const firstCandidate = await readStorageFrameRecord(db, startHeight);
  if (!firstCandidate && snapshotHeight > startHeight) {
    startHeight = snapshotHeight;
    anchoredAtSnapshot = true;
  }

  let previousHash: string | null = ZERO_FRAME_HASH;
  if (startHeight > 1) {
    const previous = await readStorageFrameRecord(db, startHeight - 1);
    if (!previous) {
      if (snapshotHeight === startHeight) {
        anchoredAtSnapshot = true;
        previousHash = null;
      } else {
        throw new Error(`STORAGE_VERIFY_PREV_FRAME_MISSING: height=${startHeight - 1}`);
      }
    } else {
      previousHash = previous.frameHash ?? computeStorageFrameHash(previous);
    }
  }

  let checkedFrames = 0;
  let latestRecord: RuntimeFrame | null = null;
  for (let height = startHeight; height <= latestHeight; height += 1) {
    const record = await readStorageFrameRecord(db, height);
    if (!record) throw new Error(`STORAGE_VERIFY_FRAME_MISSING: height=${height}`);
    if (record.height !== height) throw new Error(`STORAGE_VERIFY_FRAME_HEIGHT_MISMATCH: key=${height} record=${record.height}`);
    const skipPrevHashCheck = anchoredAtSnapshot && height === startHeight && previousHash === null;
    if (!skipPrevHashCheck && record.prevFrameHash !== previousHash) {
      throw new Error(`STORAGE_VERIFY_FRAME_CHAIN_BROKEN: height=${height} expectedPrev=${previousHash} actualPrev=${record.prevFrameHash ?? 'none'}`);
    }
    if (record.canonicalStateHash || Array.isArray(record.canonicalEntityHashes)) {
      if (!Array.isArray(record.canonicalEntityHashes) || !record.canonicalStateHash) {
        throw new Error(`STORAGE_VERIFY_CANONICAL_HASH_MISSING: height=${height}`);
      }
      await readStorageFramePayloads(db, record, { includeRuntimeMachine: false });
      const expectedCanonicalHash = computeCanonicalRuntimeStateHash(
        record.height,
        record.timestamp,
        record.canonicalEntityHashes,
      );
      if (record.canonicalStateHash !== expectedCanonicalHash) {
        throw new Error(`STORAGE_VERIFY_CANONICAL_HASH_MISMATCH: height=${height} expected=${expectedCanonicalHash} actual=${record.canonicalStateHash}`);
      }
    }
    const actualFrameHash = computeStorageFrameHash(record);
    if (record.frameHash !== actualFrameHash) {
      throw new Error(`STORAGE_VERIFY_FRAME_HASH_MISMATCH: height=${height} expected=${actualFrameHash} actual=${record.frameHash ?? 'none'}`);
    }
    previousHash = actualFrameHash;
    latestRecord = record;
    checkedFrames += 1;
  }

  if (latestRecord) {
    const replicaMetas: Array<{ key: Buffer; value: Buffer }> = [];
    for await (const key of iterateKeys(db, { prefix: keyLiveReplicaMetaPrefix() })) {
      replicaMetas.push({ key, value: await db.get(key) });
    }
    const actualReplicaMetaDigest = computeStorageReplicaMetaDigest(replicaMetas);
    const replicaCheckpointHeight = Math.max(1, Math.floor(Number(head.latestMaterializedHeight)));
    const replicaCheckpointRecord = await readStorageFrameRecord(db, replicaCheckpointHeight);
    if (replicaCheckpointRecord?.materializedState !== true) {
      throw new Error(`STORAGE_VERIFY_REPLICA_META_CHECKPOINT_MISSING:height=${replicaCheckpointHeight}`);
    }
    if (replicaCheckpointRecord.replicaMetaDigest !== actualReplicaMetaDigest) {
      throw new Error(
        `STORAGE_VERIFY_REPLICA_META_DIGEST_MISMATCH: height=${replicaCheckpointHeight} ` +
        `expected=${replicaCheckpointRecord.replicaMetaDigest || 'missing'} actual=${actualReplicaMetaDigest}`,
      );
    }
  }
  return { latestHeight, checkedFrames };
};
import { Buffer } from '../../support/platform-crypto';
