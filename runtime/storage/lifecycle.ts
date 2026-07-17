import { decodeValidatedBuffer, encodeBuffer, writeBatch } from './codec';
import { copyKeyRange, deleteKeyRange, deleteKeys, iterateKeys, readValidatedOrNull } from './level';
import {
  KEY_DIFF,
  KEY_FRAME,
  KEY_HEAD,
  KEY_LIVE_ACCOUNT,
  KEY_LIVE_BOOK,
  KEY_LIVE_ENTITY,
  KEY_LIVE_REPLICA_META,
  KEY_MERKLE_BRANCH,
  KEY_MERKLE_LEAF,
  KEY_MERKLE_ROOT,
  KEY_CERTIFIED_BOARD_NODE,
  KEY_CONSUMPTION_NODE,
  KEY_ACCOUNT_J_CLAIM_NODE,
  KEY_SNAPSHOT_ACCOUNT,
  KEY_SNAPSHOT_BOOK,
  KEY_SNAPSHOT_ENTITY,
  KEY_SNAPSHOT_REPLICA_META,
  KEY_SNAPSHOT_MANIFEST,
  assertStorageSchemaVersion,
  decodeHeight,
  encodeHeight,
  decodeEntityId,
  keySnapshotAccountPrefix,
  keySnapshotBookPrefix,
  keySnapshotEntityPrefix,
  keySnapshotManifest,
  keySnapshotReplicaMetaPrefix,
  parseLiveBookKey,
  parseSnapshotManifestHeight,
} from './keys';
import type {
  RuntimeDbLike,
  StorageDoc,
  StorageEpochSeedStats,
  StorageHead,
  StoragePersistenceBoundaryHook,
  StorageSnapshotManifest,
} from './types';
import {
  assertStorageAccountDocBinding,
  assertStorageEntityDocBinding,
  validateStorageAccountDocValue,
  validateStorageBookDocValue,
  validateStorageEntityCoreDocValue,
  validateStorageHeadValue,
  validateStorageSnapshotManifestValue,
} from './authoritative-schema';

export const readSnapshotDocs = async (
  db: RuntimeDbLike,
  height: number,
): Promise<StorageDoc[]> => {
  const docs: StorageDoc[] = [];
  for await (const key of iterateKeys(db, { prefix: keySnapshotEntityPrefix(height) })) {
    const entityId = decodeEntityId(key.subarray(9, 41));
    docs.push({
      family: 'entity',
      entityId,
      value: assertStorageEntityDocBinding(
        decodeValidatedBuffer(await db.get(key), validateStorageEntityCoreDocValue),
        entityId,
        `snapshot:${height}`,
      ),
    });
  }
  for await (const key of iterateKeys(db, { prefix: keySnapshotAccountPrefix(height) })) {
    const entityId = decodeEntityId(key.subarray(9, 41));
    const counterpartyId = decodeEntityId(key.subarray(41, 73));
    docs.push({
      family: 'account',
      entityId,
      counterpartyId,
      value: assertStorageAccountDocBinding(
        decodeValidatedBuffer(await db.get(key), validateStorageAccountDocValue),
        entityId,
        counterpartyId,
        `snapshot:${height}`,
      ),
    });
  }
  for await (const key of iterateKeys(db, { prefix: keySnapshotBookPrefix(height) })) {
    const { entityId, pairId } = parseLiveBookKey(key, 9);
    docs.push({
      family: 'book',
      entityId,
      pairId,
      value: decodeValidatedBuffer(await db.get(key), validateStorageBookDocValue),
    });
  }
  return docs;
};

export const seedFreshStorageEpoch = async (options: {
  sourceDb: RuntimeDbLike;
  targetDb: RuntimeDbLike;
  snapshotHeight: number;
}): Promise<StorageEpochSeedStats> => {
  const head = await readValidatedOrNull(options.sourceDb, KEY_HEAD, validateStorageHeadValue);
  if (!head) return { liveBytes: 0, snapshotBytes: 0, frameBytes: 0, docCount: 0 };
  assertStorageSchemaVersion(head.schemaVersion, 'epoch-source-head');
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
    Buffer.from([KEY_LIVE_REPLICA_META]),
    Buffer.from([KEY_MERKLE_ROOT]),
    Buffer.from([KEY_MERKLE_BRANCH]),
    Buffer.from([KEY_MERKLE_LEAF]),
    Buffer.from([KEY_CERTIFIED_BOARD_NODE]),
    Buffer.from([KEY_CONSUMPTION_NODE]),
    Buffer.from([KEY_ACCOUNT_J_CLAIM_NODE]),
  ];
  let liveBytes = 0;
  let docCount = 0;

  for (const prefix of livePrefixes) {
    const copied = await copyKeyRange(options.sourceDb, options.targetDb, { prefix });
    liveBytes += copied.bytes;
    docCount += copied.count;
  }

  const batch = options.targetDb.batch();
  batch.put(
    KEY_HEAD,
    encodeBuffer({
      ...head,
      latestMaterializedHeight: options.snapshotHeight,
      latestSnapshotHeight: options.snapshotHeight,
      retainedHistoryBytes: 0,
    } satisfies StorageHead),
  );
  await writeBatch(batch);

  return { liveBytes, snapshotBytes: 0, frameBytes: 0, docCount };
};

export const listSnapshotHeights = async (db: RuntimeDbLike): Promise<number[]> => {
  const heights: number[] = [];
  for await (const key of iterateKeys(db, { prefix: Buffer.from([KEY_SNAPSHOT_MANIFEST]) })) {
    heights.push(parseSnapshotManifestHeight(key));
  }
  return heights.sort((left, right) => left - right);
};

const snapshotBodyFamilies = [
  { label: 'entity', prefix: KEY_SNAPSHOT_ENTITY, exactBytes: 41 },
  { label: 'account', prefix: KEY_SNAPSHOT_ACCOUNT, exactBytes: 73 },
  { label: 'replica-meta', prefix: KEY_SNAPSHOT_REPLICA_META, exactBytes: 73 },
] as const;

const readSnapshotBodyHeights = async (db: RuntimeDbLike): Promise<Set<number>> => {
  const heights = new Set<number>();
  for (const family of snapshotBodyFamilies) {
    for await (const key of iterateKeys(db, { prefix: Buffer.from([family.prefix]) })) {
      if (key.byteLength !== family.exactBytes) {
        throw new Error(`STORAGE_SNAPSHOT_BODY_KEY_INVALID: family=${family.label} bytes=${key.byteLength}`);
      }
      const height = decodeHeight(key);
      if (!Number.isSafeInteger(height) || height <= 0) {
        throw new Error(`STORAGE_SNAPSHOT_BODY_HEIGHT_INVALID: family=${family.label} height=${height}`);
      }
      heights.add(height);
    }
  }
  for await (const key of iterateKeys(db, { prefix: Buffer.from([KEY_SNAPSHOT_BOOK]) })) {
    const pairBytes = key.byteLength >= 43 ? key.readUInt16BE(41) : -1;
    if (pairBytes < 0 || key.byteLength !== 43 + pairBytes) {
      throw new Error(`STORAGE_SNAPSHOT_BODY_KEY_INVALID: family=book bytes=${key.byteLength}`);
    }
    const height = decodeHeight(key);
    if (!Number.isSafeInteger(height) || height <= 0) {
      throw new Error(`STORAGE_SNAPSHOT_BODY_HEIGHT_INVALID: family=book height=${height}`);
    }
    heights.add(height);
  }
  return heights;
};

const pruneUnpublishedSnapshots = async (
  db: RuntimeDbLike,
  onPersistenceBoundary?: StoragePersistenceBoundaryHook,
): Promise<number> => {
  const head = await readValidatedOrNull(db, KEY_HEAD, validateStorageHeadValue);
  if (!head) throw new Error('STORAGE_SNAPSHOT_CLEANUP_HEAD_MISSING');
  assertStorageSchemaVersion(head.schemaVersion, 'snapshot-cleanup-head');
  const latestHeight = Number(head.latestHeight);
  const publishedHeight = Number(head.latestSnapshotHeight);
  if (
    !Number.isSafeInteger(latestHeight) || latestHeight < 0 ||
    !Number.isSafeInteger(publishedHeight) || publishedHeight < 0
  ) {
    throw new Error(`STORAGE_SNAPSHOT_CLEANUP_HEAD_INVALID: latest=${latestHeight} snapshot=${publishedHeight}`);
  }
  if (publishedHeight > latestHeight) {
    throw new Error(`STORAGE_VERIFY_SNAPSHOT_AFTER_HEAD: snapshot=${publishedHeight} latest=${latestHeight}`);
  }

  const manifestHeights = await listSnapshotHeights(db);
  const manifestSet = new Set(manifestHeights);
  for (const height of manifestHeights) {
    if (height > latestHeight) {
      throw new Error(`STORAGE_SNAPSHOT_MANIFEST_AFTER_HEAD: snapshot=${height} latest=${latestHeight}`);
    }
    const manifest = await readValidatedOrNull(
      db,
      keySnapshotManifest(height),
      validateStorageSnapshotManifestValue,
    );
    if (!manifest || manifest.height !== height) {
      throw new Error(
        `STORAGE_VERIFY_SNAPSHOT_MANIFEST_HEIGHT_MISMATCH: key=${height} manifest=${String(manifest?.height)}`,
      );
    }
    if (!Number.isSafeInteger(manifest.docCount) || manifest.docCount < 0) {
      throw new Error(`STORAGE_SNAPSHOT_MANIFEST_DOC_COUNT_INVALID: height=${height} count=${manifest.docCount}`);
    }
  }
  if (publishedHeight > 0 && !manifestSet.has(publishedHeight)) {
    throw new Error(`STORAGE_VERIFY_SNAPSHOT_MANIFEST_MISSING: height=${publishedHeight}`);
  }

  const bodyHeights = await readSnapshotBodyHeights(db);
  for (const height of bodyHeights) {
    if (height > latestHeight) {
      throw new Error(`STORAGE_SNAPSHOT_BODY_AFTER_HEAD: snapshot=${height} latest=${latestHeight}`);
    }
  }
  const staleHeights = new Set(
    manifestHeights.filter((height) => height > publishedHeight),
  );
  for (const height of bodyHeights) {
    if (!manifestSet.has(height)) staleHeights.add(height);
  }
  staleHeights.delete(publishedHeight);

  let removedBytes = 0;
  for (const height of [...staleHeights].sort((left, right) => left - right)) {
    removedBytes += await pruneSnapshot(db, height, onPersistenceBoundary);
  }
  return removedBytes;
};

export const createSnapshot = async (
  sourceDb: RuntimeDbLike,
  targetDb: RuntimeDbLike,
  height: number,
  createdAt = 0,
  onPersistenceBoundary?: StoragePersistenceBoundaryHook,
): Promise<{ docCount: number; bytes: number }> => {
  await pruneUnpublishedSnapshots(targetDb, onPersistenceBoundary);
  const livePrefixes = [
    Buffer.from([KEY_LIVE_ENTITY]),
    Buffer.from([KEY_LIVE_ACCOUNT]),
    Buffer.from([KEY_LIVE_BOOK]),
    Buffer.from([KEY_LIVE_REPLICA_META]),
  ];

  let written = 0;
  let bytes = 0;
  for (const prefix of livePrefixes) {
    const copied = await copyKeyRange(sourceDb, targetDb, { prefix }, (key) => {
      if (key[0] === KEY_LIVE_ENTITY) {
        return Buffer.concat([Buffer.from([KEY_SNAPSHOT_ENTITY]), encodeHeight(height), key.subarray(1)]);
      }
      if (key[0] === KEY_LIVE_ACCOUNT) {
        return Buffer.concat([Buffer.from([KEY_SNAPSHOT_ACCOUNT]), encodeHeight(height), key.subarray(1)]);
      }
      if (key[0] === KEY_LIVE_BOOK) {
        return Buffer.concat([Buffer.from([KEY_SNAPSHOT_BOOK]), encodeHeight(height), key.subarray(1)]);
      }
      if (key[0] === KEY_LIVE_REPLICA_META) {
        return Buffer.concat([Buffer.from([KEY_SNAPSHOT_REPLICA_META]), encodeHeight(height), key.subarray(1)]);
      }
      return null;
    }, async () => onPersistenceBoundary?.('after-snapshot-chunk'));
    written += copied.count;
    bytes += copied.bytes;
  }
  const batch = targetDb.batch();
  const manifestKey = keySnapshotManifest(height);
  const manifestValue = encodeBuffer({ height, createdAt: Math.max(0, Math.floor(Number(createdAt || 0))), docCount: written } satisfies StorageSnapshotManifest);
  batch.put(manifestKey, manifestValue);
  await writeBatch(batch);
  await onPersistenceBoundary?.('after-snapshot-manifest');
  bytes += manifestKey.byteLength + manifestValue.byteLength;
  return { docCount: written, bytes };
};

const pruneSnapshot = async (
  db: RuntimeDbLike,
  height: number,
  onPersistenceBoundary?: StoragePersistenceBoundaryHook,
): Promise<number> => {
  const prefixes = [
    keySnapshotEntityPrefix(height),
    keySnapshotAccountPrefix(height),
    keySnapshotBookPrefix(height),
    keySnapshotReplicaMetaPrefix(height),
  ];
  let removedBytes = 0;
  // Delete the manifest first. If a crash happens mid-prune, leftover docs are
  // harmless orphans; the opposite order can leave a manifest pointing at
  // missing snapshot docs.
  const onPruneBatch = async (): Promise<void> => {
    await onPersistenceBoundary?.('after-snapshot-retention-prune');
  };
  removedBytes += await deleteKeys(db, [keySnapshotManifest(height)], onPruneBatch);
  for (const prefix of prefixes) {
    removedBytes += (await deleteKeyRange(db, { prefix }, () => true, onPruneBatch)).removedBytes;
  }
  return removedBytes;
};

export const maybeRotateSnapshots = async (
  db: RuntimeDbLike,
  retainSnapshots: number,
  onPersistenceBoundary?: StoragePersistenceBoundaryHook,
): Promise<number> => {
  const heights = await listSnapshotHeights(db);
  if (heights.length <= retainSnapshots) return 0;
  let removedBytes = 0;
  for (const height of heights.slice(0, Math.max(0, heights.length - retainSnapshots))) {
    removedBytes += await pruneSnapshot(db, height, onPersistenceBoundary);
  }
  return removedBytes;
};

export const pruneHistoryBeforeHeight = async (
  db: RuntimeDbLike,
  heightInclusive: number,
  onPersistenceBoundary?: StoragePersistenceBoundaryHook,
): Promise<number> => {
  const cutoff = Math.max(0, Math.floor(Number(heightInclusive)));
  if (cutoff <= 0) return 0;
  const retainedSnapshots = new Set(await listSnapshotHeights(db));
  const onPruneBatch = async (): Promise<void> => {
    await onPersistenceBoundary?.('after-replay-prune');
  };
  const frames = await deleteKeyRange(
    db,
    {
      gte: Buffer.from([KEY_FRAME]),
      lt: Buffer.concat([Buffer.from([KEY_FRAME]), encodeHeight(cutoff + 1)]),
    },
    key => !retainedSnapshots.has(decodeHeight(key)),
    onPruneBatch,
  );
  const diffs = await deleteKeyRange(
    db,
    {
      gte: Buffer.from([KEY_DIFF]),
      lt: Buffer.concat([Buffer.from([KEY_DIFF]), encodeHeight(cutoff + 1)]),
    },
    () => true,
    onPruneBatch,
  );
  return frames.removedBytes + diffs.removedBytes;
};
