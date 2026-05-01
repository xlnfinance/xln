import { encodeBuffer, writeBatch } from './codec';
import { copyKeyRange, copyKeys, deleteKeyRange, deleteKeys, iterateKeys, readJsonOrNull, readRawOrNull } from './level';
import {
  EPOCH_SEED_FRAME_TAIL,
  KEY_DIFF,
  KEY_HEAD,
  KEY_LIVE_ACCOUNT,
  KEY_LIVE_BOOK,
  KEY_LIVE_DOC_HASH,
  KEY_LIVE_ENTITY,
  KEY_LIVE_ENTITY_HASH,
  KEY_LIVE_REPLICA_META,
  KEY_MERKLE_BRANCH,
  KEY_MERKLE_LEAF,
  KEY_MERKLE_ROOT,
  KEY_SNAPSHOT_ACCOUNT,
  KEY_SNAPSHOT_BOOK,
  KEY_SNAPSHOT_ENTITY,
  KEY_SNAPSHOT_MANIFEST,
  encodeHeight,
  keyFrame,
  keySnapshotAccountPrefix,
  keySnapshotBookPrefix,
  keySnapshotEntityPrefix,
  keySnapshotManifest,
  parseSnapshotManifestHeight,
} from './keys';
import type { RuntimeDbLike, StorageEpochSeedStats, StorageHead, StorageSnapshotManifest } from './types';

export const seedFreshStorageEpoch = async (options: {
  sourceDb: RuntimeDbLike;
  targetDb: RuntimeDbLike;
  snapshotHeight: number;
}): Promise<StorageEpochSeedStats> => {
  const head = await readJsonOrNull<StorageHead>(options.sourceDb, KEY_HEAD);
  if (!head) return { liveBytes: 0, snapshotBytes: 0, frameBytes: 0, docCount: 0 };
  const latestHeight = Math.max(0, Math.floor(Number(head.latestHeight ?? 0)));
  if (latestHeight > 0 && options.snapshotHeight !== latestHeight) {
    throw new Error(
      `STORAGE_EPOCH_SEED_REQUIRES_LATEST_SNAPSHOT: snapshot=${options.snapshotHeight} latest=${latestHeight}`,
    );
  }

  // Rotation is allowed only at a materialized head, so no overlay window crosses
  // the epoch boundary. The old epoch stays immutable for audit/history.
  const livePrefixes = [
    Buffer.from([KEY_LIVE_ENTITY]),
    Buffer.from([KEY_LIVE_ACCOUNT]),
    Buffer.from([KEY_LIVE_BOOK]),
    Buffer.from([KEY_LIVE_DOC_HASH]),
    Buffer.from([KEY_LIVE_ENTITY_HASH]),
    Buffer.from([KEY_LIVE_REPLICA_META]),
    Buffer.from([KEY_MERKLE_ROOT]),
    Buffer.from([KEY_MERKLE_BRANCH]),
    Buffer.from([KEY_MERKLE_LEAF]),
  ];
  const snapshotPrefixes = [
    keySnapshotManifest(options.snapshotHeight),
    keySnapshotEntityPrefix(options.snapshotHeight),
    keySnapshotAccountPrefix(options.snapshotHeight),
    keySnapshotBookPrefix(options.snapshotHeight),
  ];

  let liveBytes = 0;
  let snapshotBytes = 0;
  let frameBytes = 0;
  let docCount = 0;

  for (const prefix of livePrefixes) {
    const copied = await copyKeyRange(options.sourceDb, options.targetDb, { prefix });
    liveBytes += copied.bytes;
    docCount += copied.count;
  }

  const manifestRaw = await readRawOrNull(options.sourceDb, keySnapshotManifest(options.snapshotHeight));
  if (manifestRaw) {
    const batch = options.targetDb.batch();
    const manifestKey = keySnapshotManifest(options.snapshotHeight);
    batch.put(manifestKey, manifestRaw);
    await writeBatch(batch);
    snapshotBytes += manifestKey.byteLength + manifestRaw.byteLength;
    docCount += 1;
  }

  for (const prefix of snapshotPrefixes.slice(1)) {
    const copied = await copyKeyRange(options.sourceDb, options.targetDb, { prefix });
    snapshotBytes += copied.bytes;
    docCount += copied.count;
  }

  if (latestHeight > 0) {
    const firstTailHeight = Math.max(1, latestHeight - EPOCH_SEED_FRAME_TAIL + 1);
    const frameKeys: Buffer[] = [];
    for (let height = firstTailHeight; height <= latestHeight; height += 1) {
      frameKeys.push(keyFrame(height));
    }
    const copied = await copyKeys(options.sourceDb, options.targetDb, frameKeys);
    frameBytes += copied.bytes;
    docCount += copied.count;
  }

  const batch = options.targetDb.batch();
  batch.put(
    KEY_HEAD,
    encodeBuffer({
      ...head,
      latestMaterializedHeight: options.snapshotHeight,
      latestSnapshotHeight: options.snapshotHeight,
      retainedHistoryBytes: snapshotBytes + frameBytes,
    } satisfies StorageHead),
  );
  await writeBatch(batch);

  return { liveBytes, snapshotBytes, frameBytes, docCount };
};

export const listSnapshotHeights = async (db: RuntimeDbLike): Promise<number[]> => {
  const heights: number[] = [];
  for await (const key of iterateKeys(db, { prefix: Buffer.from([KEY_SNAPSHOT_MANIFEST]) })) {
    heights.push(parseSnapshotManifestHeight(key));
  }
  return heights.sort((left, right) => left - right);
};

export const createSnapshot = async (
  db: RuntimeDbLike,
  height: number,
  createdAt = 0,
): Promise<{ docCount: number; bytes: number }> => {
  const livePrefixes = [
    Buffer.from([KEY_LIVE_ENTITY]),
    Buffer.from([KEY_LIVE_ACCOUNT]),
    Buffer.from([KEY_LIVE_BOOK]),
  ];

  let written = 0;
  let bytes = 0;
  for (const prefix of livePrefixes) {
    const copied = await copyKeyRange(db, db, { prefix }, (key) => {
      if (key[0] === KEY_LIVE_ENTITY) {
        return Buffer.concat([Buffer.from([KEY_SNAPSHOT_ENTITY]), encodeHeight(height), key.subarray(1)]);
      }
      if (key[0] === KEY_LIVE_ACCOUNT) {
        return Buffer.concat([Buffer.from([KEY_SNAPSHOT_ACCOUNT]), encodeHeight(height), key.subarray(1)]);
      }
      if (key[0] === KEY_LIVE_BOOK) {
        return Buffer.concat([Buffer.from([KEY_SNAPSHOT_BOOK]), encodeHeight(height), key.subarray(1)]);
      }
      return null;
    });
    written += copied.count;
    bytes += copied.bytes;
  }
  const batch = db.batch();
  const manifestKey = keySnapshotManifest(height);
  const manifestValue = encodeBuffer({ height, createdAt: Math.max(0, Math.floor(Number(createdAt || 0))), docCount: written } satisfies StorageSnapshotManifest);
  batch.put(manifestKey, manifestValue);
  await writeBatch(batch);
  bytes += manifestKey.byteLength + manifestValue.byteLength;
  return { docCount: written, bytes };
};

const pruneSnapshot = async (db: RuntimeDbLike, height: number): Promise<number> => {
  const prefixes = [
    keySnapshotEntityPrefix(height),
    keySnapshotAccountPrefix(height),
    keySnapshotBookPrefix(height),
  ];
  let removedBytes = 0;
  // Delete the manifest first. If a crash happens mid-prune, leftover docs are
  // harmless orphans; the opposite order can leave a manifest pointing at
  // missing snapshot docs.
  removedBytes += await deleteKeys(db, [keySnapshotManifest(height)]);
  for (const prefix of prefixes) {
    removedBytes += (await deleteKeyRange(db, { prefix })).removedBytes;
  }
  return removedBytes;
};

export const maybeRotateSnapshots = async (db: RuntimeDbLike, retainSnapshots: number): Promise<number> => {
  const heights = await listSnapshotHeights(db);
  if (heights.length <= retainSnapshots) return 0;
  let removedBytes = 0;
  for (const height of heights.slice(0, Math.max(0, heights.length - retainSnapshots))) {
    removedBytes += await pruneSnapshot(db, height);
  }
  return removedBytes;
};

export const pruneHistoryBeforeHeight = async (db: RuntimeDbLike, heightInclusive: number): Promise<number> => {
  if (heightInclusive <= 0) return 0;
  // Keep frame journals available for receipts/audit even after a snapshot exists.
  // Only replay-specific layers can be dropped once the snapshot covers them.
  const lt = Buffer.concat([Buffer.from([KEY_DIFF]), encodeHeight(Math.max(0, Math.floor(heightInclusive)) + 1)]);
  return (await deleteKeyRange(db, { gte: Buffer.from([KEY_DIFF]), lt })).removedBytes;
};
