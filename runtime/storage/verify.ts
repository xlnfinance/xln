import { computeCanonicalRuntimeStateHash } from './canonical-hash';
import {
  assertEntityHashesEqual,
  computeStorageFrameHash,
  computeStorageStateRoot,
  readAllEntityHashDocs,
  toFrameEntityHashes,
} from './hashes';
import {
  KEY_HEAD,
  STORAGE_VERIFY_TAIL_FRAMES,
  ZERO_FRAME_HASH,
  keySnapshotAccountPrefix,
  keySnapshotBookPrefix,
  keySnapshotEntityPrefix,
  keySnapshotManifest,
} from './keys';
import { countKeys, readJsonOrNull } from './level';
import { readStorageFrameRecord } from './read';
import type { RuntimeDbLike, StorageFrameRecord, StorageHead, StorageSnapshotManifest } from './types';

const countSnapshotDocs = async (db: RuntimeDbLike, height: number): Promise<number> => {
  const [entities, accounts, books] = await Promise.all([
    countKeys(db, { prefix: keySnapshotEntityPrefix(height) }),
    countKeys(db, { prefix: keySnapshotAccountPrefix(height) }),
    countKeys(db, { prefix: keySnapshotBookPrefix(height) }),
  ]);
  return entities + accounts + books;
};

export const verifyStorageSnapshotIntegrity = async (
  db: RuntimeDbLike,
  head: StorageHead,
): Promise<void> => {
  const latestHeight = Math.max(0, Math.floor(Number(head.latestHeight ?? 0)));
  const snapshotHeight = Math.max(0, Math.floor(Number(head.latestSnapshotHeight ?? 0)));
  if (snapshotHeight <= 0) return;
  if (snapshotHeight > latestHeight) {
    throw new Error(`STORAGE_VERIFY_SNAPSHOT_AFTER_HEAD: snapshot=${snapshotHeight} latest=${latestHeight}`);
  }

  const manifest = await readJsonOrNull<StorageSnapshotManifest>(db, keySnapshotManifest(snapshotHeight));
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
};

export const verifyStorageTailIntegrity = async (
  db: RuntimeDbLike,
  options: { tailFrames?: number } = {},
): Promise<{ latestHeight: number; checkedFrames: number }> => {
  const head = await readJsonOrNull<StorageHead>(db, KEY_HEAD);
  if (!head || head.latestHeight <= 0) return { latestHeight: 0, checkedFrames: 0 };
  const latestHeight = Math.max(0, Math.floor(Number(head.latestHeight)));
  await verifyStorageSnapshotIntegrity(db, head);
  const tailFrames = Math.max(1, Math.floor(Number(options.tailFrames ?? STORAGE_VERIFY_TAIL_FRAMES)));
  const startHeight = Math.max(1, latestHeight - tailFrames + 1);
  let previousHash = ZERO_FRAME_HASH;
  if (startHeight > 1) {
    const previous = await readStorageFrameRecord(db, startHeight - 1);
    if (!previous) throw new Error(`STORAGE_VERIFY_PREV_FRAME_MISSING: height=${startHeight - 1}`);
    previousHash = previous.frameHash ?? computeStorageFrameHash(previous);
  }

  let checkedFrames = 0;
  let latestRecord: StorageFrameRecord | null = null;
  for (let height = startHeight; height <= latestHeight; height += 1) {
    const record = await readStorageFrameRecord(db, height);
    if (!record) throw new Error(`STORAGE_VERIFY_FRAME_MISSING: height=${height}`);
    if (record.height !== height) throw new Error(`STORAGE_VERIFY_FRAME_HEIGHT_MISMATCH: key=${height} record=${record.height}`);
    if (record.prevFrameHash !== previousHash) {
      throw new Error(`STORAGE_VERIFY_FRAME_CHAIN_BROKEN: height=${height} expectedPrev=${previousHash} actualPrev=${record.prevFrameHash ?? 'none'}`);
    }
    if (!Array.isArray(record.entityHashes)) {
      throw new Error(`STORAGE_VERIFY_ENTITY_HASHES_MISSING: height=${height}`);
    }
    if (record.materializedState !== false) {
      const expectedStateHash = computeStorageStateRoot(record.entityHashes);
      if (record.stateHash !== expectedStateHash) {
        throw new Error(`STORAGE_VERIFY_STATE_HASH_MISMATCH: height=${height} expected=${expectedStateHash} actual=${record.stateHash}`);
      }
      if (record.canonicalStateHash || Array.isArray(record.canonicalEntityHashes)) {
        if (!Array.isArray(record.canonicalEntityHashes) || !record.canonicalStateHash) {
          throw new Error(`STORAGE_VERIFY_CANONICAL_HASH_MISSING: height=${height}`);
        }
        const expectedCanonicalHash = computeCanonicalRuntimeStateHash(record.height, record.timestamp, record.canonicalEntityHashes);
        if (record.canonicalStateHash !== expectedCanonicalHash) {
          throw new Error(`STORAGE_VERIFY_CANONICAL_HASH_MISMATCH: height=${height} expected=${expectedCanonicalHash} actual=${record.canonicalStateHash}`);
        }
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
    const liveEntityHashes = await readAllEntityHashDocs(db);
    if (liveEntityHashes.size > 0) {
      assertEntityHashesEqual(
        toFrameEntityHashes(liveEntityHashes.values()),
        latestRecord.entityHashes,
        `latestHeight=${latestHeight}`,
      );
    }
  }
  return { latestHeight, checkedFrames };
};
