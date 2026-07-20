import { computeCanonicalRuntimeStateHash } from './canonical-hash';
import {
  assertEntityHashesEqual,
  computeStorageFrameHash,
  computeStorageReplicaMetaDigest,
  computeStorageStateRoot,
  readAllEntityHashDocs,
  toFrameEntityHashes,
} from './hashes';
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
} from './keys';
import { countKeys, iterateKeys, readValidatedOrNull } from './level';
import { validateStorageSnapshotManifestValue } from './authoritative-schema';
import { readStorageFrameRecord, readStorageHead } from './read';
import type { RuntimeDbLike, StorageFrameRecord, StorageHead } from './types';

const countSnapshotDocs = async (db: RuntimeDbLike, height: number): Promise<number> => {
  const [entities, accounts, books, replicaMetas] = await Promise.all([
    countKeys(db, { prefix: keySnapshotEntityPrefix(height) }),
    countKeys(db, { prefix: keySnapshotAccountPrefix(height) }),
    countKeys(db, { prefix: keySnapshotBookPrefix(height) }),
    countKeys(db, { prefix: keySnapshotReplicaMetaPrefix(height) }),
  ]);
  return entities + accounts + books + replicaMetas;
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

  const actualDocCount = await countSnapshotDocs(db, snapshotHeight);
  const expectedDocCount = Math.max(0, Math.floor(Number(manifest.docCount ?? -1)));
  if (actualDocCount !== expectedDocCount) {
    throw new Error(
      `STORAGE_VERIFY_SNAPSHOT_DOC_COUNT_MISMATCH: height=${snapshotHeight} expected=${expectedDocCount} actual=${actualDocCount}`,
    );
  }

  const snapshotFrame = await readStorageFrameRecord(db, snapshotHeight);
  if (!snapshotFrame) throw new Error(`STORAGE_VERIFY_SNAPSHOT_FRAME_MISSING: height=${snapshotHeight}`);
  if (snapshotFrame.materializedState === false) {
    throw new Error(`STORAGE_VERIFY_SNAPSHOT_NOT_MATERIALIZED: height=${snapshotHeight}`);
  }
  const actualReplicaMetaDigest = await computeSnapshotReplicaMetaDigest(db, snapshotHeight);
  if (snapshotFrame.replicaMetaDigest !== actualReplicaMetaDigest) {
    throw new Error(
      `STORAGE_VERIFY_SNAPSHOT_REPLICA_META_DIGEST_MISMATCH:height=${snapshotHeight}:` +
        `expected=${snapshotFrame.replicaMetaDigest || 'missing'}:actual=${actualReplicaMetaDigest}`,
    );
  }
};

export const verifyStorageSnapshotIntegrity = async (
  db: RuntimeDbLike,
  head: StorageHead,
): Promise<void> => verifyStorageSnapshotAtHeight(db, head, head.latestSnapshotHeight);

export const verifyStorageTailIntegrity = async (
  db: RuntimeDbLike,
  options: { tailFrames?: number } = {},
): Promise<{ latestHeight: number; checkedFrames: number }> => {
  const head = await readStorageHead(db);
  if (!head || head.latestHeight <= 0) return { latestHeight: 0, checkedFrames: 0 };
  const latestHeight = Math.max(0, Math.floor(Number(head.latestHeight)));
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
  let latestRecord: StorageFrameRecord | null = null;
  for (let height = startHeight; height <= latestHeight; height += 1) {
    const record = await readStorageFrameRecord(db, height);
    if (!record) throw new Error(`STORAGE_VERIFY_FRAME_MISSING: height=${height}`);
    if (record.height !== height) throw new Error(`STORAGE_VERIFY_FRAME_HEIGHT_MISMATCH: key=${height} record=${record.height}`);
    const skipPrevHashCheck = anchoredAtSnapshot && height === startHeight && previousHash === null;
    if (!skipPrevHashCheck && record.prevFrameHash !== previousHash) {
      throw new Error(`STORAGE_VERIFY_FRAME_CHAIN_BROKEN: height=${height} expectedPrev=${previousHash} actualPrev=${record.prevFrameHash ?? 'none'}`);
    }
    if (record.materializedState !== false) {
      if (!Array.isArray(record.entityHashes)) {
        throw new Error(`STORAGE_VERIFY_ENTITY_HASHES_MISSING: height=${height}`);
      }
      const expectedStateHash = computeStorageStateRoot(record.entityHashes);
      if (record.stateHash !== expectedStateHash) {
        throw new Error(`STORAGE_VERIFY_STATE_HASH_MISMATCH: height=${height} expected=${expectedStateHash} actual=${record.stateHash}`);
      }
    }
    if (record.canonicalStateHash || Array.isArray(record.canonicalEntityHashes)) {
      if (!Array.isArray(record.canonicalEntityHashes) || !record.canonicalStateHash) {
        throw new Error(`STORAGE_VERIFY_CANONICAL_HASH_MISSING: height=${height}`);
      }
      const expectedCanonicalHash = computeCanonicalRuntimeStateHash(
        record.height,
        record.timestamp,
        record.canonicalEntityHashes,
        record.runtimeMachine,
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
    if (latestRecord.replicaMetaDigest !== actualReplicaMetaDigest) {
      throw new Error(
        `STORAGE_VERIFY_REPLICA_META_DIGEST_MISMATCH: height=${latestHeight} ` +
        `expected=${latestRecord.replicaMetaDigest || 'missing'} actual=${actualReplicaMetaDigest}`,
      );
    }
    const liveEntityHashes = await readAllEntityHashDocs(db);
    if (liveEntityHashes.size > 0) {
      const materializedRecord = await readStorageFrameRecord(
        db,
        Math.max(1, Math.floor(Number(head.latestMaterializedHeight))),
      );
      if (!materializedRecord?.entityHashes) {
        throw new Error(
          `STORAGE_VERIFY_MATERIALIZED_ENTITY_HASHES_MISSING:height=${head.latestMaterializedHeight}`,
        );
      }
      assertEntityHashesEqual(
        toFrameEntityHashes(liveEntityHashes.values()),
        materializedRecord.entityHashes,
        `materializedHeight=${head.latestMaterializedHeight}`,
      );
    }
  }
  return { latestHeight, checkedFrames };
};
