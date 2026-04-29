import type { Env } from '../types';
import {
  KEY_DIFF,
  KEY_FRAME,
  KEY_HEAD,
  KEY_LIVE_ACCOUNT,
  KEY_LIVE_BOOK,
  KEY_LIVE_ENTITY,
  KEY_LIVE_REPLICA_META,
  KEY_SNAPSHOT_ACCOUNT,
  KEY_SNAPSHOT_BOOK,
  KEY_SNAPSHOT_ENTITY,
  KEY_SNAPSHOT_MANIFEST,
} from './keys';
import { measurePrefixBytes, readJsonOrNull } from './level';
import { listSnapshotHeights } from './lifecycle';
import type { RuntimeDbLike, StorageDebugStats, StorageHead } from './types';

export const inspectStorage = async (options: {
  env: Env;
  tryOpenDb: (env: Env) => Promise<boolean>;
  getRuntimeDb: (env: Env) => RuntimeDbLike;
}): Promise<StorageDebugStats | null> => {
  const opened = await options.tryOpenDb(options.env);
  if (!opened) return null;
  const db = options.getRuntimeDb(options.env);
  const [
    head,
    frameStats,
    diffStats,
    snapshotManifestStats,
    snapshotEntityStats,
    snapshotAccountStats,
    snapshotBookStats,
    snapshotHeights,
    liveEntityStats,
    liveAccountStats,
    liveBookStats,
    liveReplicaMetaStats,
  ] = await Promise.all([
    readJsonOrNull<StorageHead>(db, KEY_HEAD),
    measurePrefixBytes(db, Buffer.from([KEY_FRAME])),
    measurePrefixBytes(db, Buffer.from([KEY_DIFF])),
    measurePrefixBytes(db, Buffer.from([KEY_SNAPSHOT_MANIFEST])),
    measurePrefixBytes(db, Buffer.from([KEY_SNAPSHOT_ENTITY])),
    measurePrefixBytes(db, Buffer.from([KEY_SNAPSHOT_ACCOUNT])),
    measurePrefixBytes(db, Buffer.from([KEY_SNAPSHOT_BOOK])),
    listSnapshotHeights(db),
    measurePrefixBytes(db, Buffer.from([KEY_LIVE_ENTITY])),
    measurePrefixBytes(db, Buffer.from([KEY_LIVE_ACCOUNT])),
    measurePrefixBytes(db, Buffer.from([KEY_LIVE_BOOK])),
    measurePrefixBytes(db, Buffer.from([KEY_LIVE_REPLICA_META])),
  ]);

  const snapshotBytes =
    snapshotManifestStats.bytes +
    snapshotEntityStats.bytes +
    snapshotAccountStats.bytes +
    snapshotBookStats.bytes;
  const liveBytes = liveEntityStats.bytes + liveAccountStats.bytes + liveBookStats.bytes + liveReplicaMetaStats.bytes;
  const historyBytes = frameStats.bytes + diffStats.bytes + snapshotBytes;
  const totalBytes = historyBytes + liveBytes;

  return {
    head,
    frameCount: frameStats.count,
    diffCount: diffStats.count,
    snapshotHeights,
    liveEntityCount: liveEntityStats.count,
    liveAccountCount: liveAccountStats.count,
    liveBookCount: liveBookStats.count,
    frameBytes: frameStats.bytes,
    diffBytes: diffStats.bytes,
    snapshotBytes,
    liveBytes,
    historyBytes,
    totalBytes,
    maxFrameBytes: frameStats.maxValueBytes,
    maxDiffBytes: diffStats.maxValueBytes,
    maxSnapshotBytes: Math.max(
      snapshotManifestStats.maxValueBytes,
      snapshotAccountStats.maxValueBytes,
      snapshotBookStats.maxValueBytes,
    ),
  };
};
