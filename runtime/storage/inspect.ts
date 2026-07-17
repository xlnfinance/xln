import type { Env } from '../types';
import {
  KEY_DIFF,
  KEY_FRAME,
  KEY_LIVE_ACCOUNT,
  KEY_LIVE_BOOK,
  KEY_LIVE_ENTITY,
  KEY_LIVE_REPLICA_META,
  KEY_CERTIFIED_BOARD_NODE,
  KEY_CONSUMPTION_NODE,
  KEY_ACCOUNT_J_CLAIM_NODE,
  KEY_MERKLE_BRANCH,
  KEY_MERKLE_LEAF,
  KEY_MERKLE_ROOT,
  KEY_SNAPSHOT_ACCOUNT,
  KEY_SNAPSHOT_BOOK,
  KEY_SNAPSHOT_ENTITY,
  KEY_SNAPSHOT_MANIFEST,
  KEY_SNAPSHOT_REPLICA_META,
} from './keys';
import { measurePrefixBytes } from './level';
import { listSnapshotHeights } from './lifecycle';
import { readStorageHead } from './read';
import type { RuntimeDbLike, StorageDebugStats } from './types';

export const inspectStorage = async (options: {
  env: Env;
  tryOpenDb: (env: Env) => Promise<boolean>;
  getRuntimeDb: (env: Env) => RuntimeDbLike;
}): Promise<StorageDebugStats | null> => {
  const opened = await options.tryOpenDb(options.env);
  if (!opened) return null;
  const db = options.getRuntimeDb(options.env);
  // Reject incompatible durable bytes before scanning any storage namespace.
  const head = await readStorageHead(db);
  const [
    frameStats,
    diffStats,
    snapshotManifestStats,
    snapshotEntityStats,
    snapshotAccountStats,
    snapshotBookStats,
    snapshotReplicaMetaStats,
    snapshotHeights,
    liveEntityStats,
    liveAccountStats,
    liveBookStats,
    liveReplicaMetaStats,
    merkleRootStats,
    merkleBranchStats,
    merkleLeafStats,
    certifiedBoardNodeStats,
    consumptionNodeStats,
    accountJClaimNodeStats,
  ] = await Promise.all([
    measurePrefixBytes(db, Buffer.from([KEY_FRAME])),
    measurePrefixBytes(db, Buffer.from([KEY_DIFF])),
    measurePrefixBytes(db, Buffer.from([KEY_SNAPSHOT_MANIFEST])),
    measurePrefixBytes(db, Buffer.from([KEY_SNAPSHOT_ENTITY])),
    measurePrefixBytes(db, Buffer.from([KEY_SNAPSHOT_ACCOUNT])),
    measurePrefixBytes(db, Buffer.from([KEY_SNAPSHOT_BOOK])),
    measurePrefixBytes(db, Buffer.from([KEY_SNAPSHOT_REPLICA_META])),
    listSnapshotHeights(db),
    measurePrefixBytes(db, Buffer.from([KEY_LIVE_ENTITY])),
    measurePrefixBytes(db, Buffer.from([KEY_LIVE_ACCOUNT])),
    measurePrefixBytes(db, Buffer.from([KEY_LIVE_BOOK])),
    measurePrefixBytes(db, Buffer.from([KEY_LIVE_REPLICA_META])),
    measurePrefixBytes(db, Buffer.from([KEY_MERKLE_ROOT])),
    measurePrefixBytes(db, Buffer.from([KEY_MERKLE_BRANCH])),
    measurePrefixBytes(db, Buffer.from([KEY_MERKLE_LEAF])),
    measurePrefixBytes(db, Buffer.from([KEY_CERTIFIED_BOARD_NODE])),
    measurePrefixBytes(db, Buffer.from([KEY_CONSUMPTION_NODE])),
    measurePrefixBytes(db, Buffer.from([KEY_ACCOUNT_J_CLAIM_NODE])),
  ]);

  const snapshotBytes =
    snapshotManifestStats.bytes +
    snapshotEntityStats.bytes +
    snapshotAccountStats.bytes +
    snapshotBookStats.bytes +
    snapshotReplicaMetaStats.bytes;
  const liveBytes =
    liveEntityStats.bytes +
    liveAccountStats.bytes +
    liveBookStats.bytes +
    liveReplicaMetaStats.bytes +
    merkleRootStats.bytes +
    merkleBranchStats.bytes +
    merkleLeafStats.bytes +
    certifiedBoardNodeStats.bytes +
    consumptionNodeStats.bytes +
    accountJClaimNodeStats.bytes;
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
    merkleRootCount: merkleRootStats.count,
    merkleBranchCount: merkleBranchStats.count,
    merkleLeafCount: merkleLeafStats.count,
    certifiedBoardNodeCount: certifiedBoardNodeStats.count,
    consumptionNodeCount: consumptionNodeStats.count,
    accountJClaimNodeCount: accountJClaimNodeStats.count,
    certifiedBoardNodeBytes: certifiedBoardNodeStats.bytes,
    consumptionNodeBytes: consumptionNodeStats.bytes,
    accountJClaimNodeBytes: accountJClaimNodeStats.bytes,
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
      snapshotEntityStats.maxValueBytes,
      snapshotAccountStats.maxValueBytes,
      snapshotBookStats.maxValueBytes,
      snapshotReplicaMetaStats.maxValueBytes,
    ),
  };
};
