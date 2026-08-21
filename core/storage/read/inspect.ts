import type { RuntimeReplica } from '../../runtime/types';
import {
  KEY_DIFF,
  KEY_FRAME,
  KEY_LIVE_ACCOUNT,
  KEY_LIVE_ACCOUNT_BRANCH,
  KEY_LIVE_ACCOUNT_FIELD,
  KEY_LIVE_ACCOUNT_LEAF,
  KEY_LIVE_BOOK,
  KEY_LIVE_BOOK_BRANCH,
  KEY_LIVE_BOOK_LEAF,
  KEY_LIVE_ENTITY,
  KEY_LIVE_ENTITY_BRANCH,
  KEY_LIVE_ENTITY_FIELD,
  KEY_LIVE_ENTITY_LEAF,
  KEY_LIVE_REPLICA_META,
  KEY_CERTIFIED_BOARD_NODE,
  KEY_CONSUMPTION_NODE,
  KEY_ACCOUNT_J_CLAIM_NODE,
  KEY_SNAPSHOT_ACCOUNT,
  KEY_SNAPSHOT_BOOK,
  KEY_SNAPSHOT_ENTITY,
  KEY_SNAPSHOT_MANIFEST,
  KEY_SNAPSHOT_REPLICA_META,
} from '../keys';
import { measurePrefixBytes } from '../database/level';
import { listSnapshotHeights } from '../database/lifecycle';
import { readStorageHead } from './read';
import type { RuntimeDbLike, StorageDebugStats } from '../types';
import { requireStorageDbOpen } from '../commit/availability';

export const inspectStorage = async (options: {
  env: RuntimeReplica;
  tryOpenDb: (env: RuntimeReplica) => Promise<boolean>;
  getRuntimeDb: (env: RuntimeReplica) => RuntimeDbLike;
}): Promise<StorageDebugStats | null> => {
  await requireStorageDbOpen(
    () => options.tryOpenDb(options.env),
    'storage-inspection',
  );
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
    liveEntityFieldStats,
    liveAccountStats,
    liveAccountFieldStats,
    liveBookStats,
    liveReplicaMetaStats,
    accountGraphBranchStats,
    accountGraphLeafStats,
    bookGraphBranchStats,
    bookGraphLeafStats,
    entityGraphBranchStats,
    entityGraphLeafStats,
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
    measurePrefixBytes(db, Buffer.from([KEY_LIVE_ENTITY_FIELD])),
    measurePrefixBytes(db, Buffer.from([KEY_LIVE_ACCOUNT])),
    measurePrefixBytes(db, Buffer.from([KEY_LIVE_ACCOUNT_FIELD])),
    measurePrefixBytes(db, Buffer.from([KEY_LIVE_BOOK])),
    measurePrefixBytes(db, Buffer.from([KEY_LIVE_REPLICA_META])),
    measurePrefixBytes(db, Buffer.from([KEY_LIVE_ACCOUNT_BRANCH])),
    measurePrefixBytes(db, Buffer.from([KEY_LIVE_ACCOUNT_LEAF])),
    measurePrefixBytes(db, Buffer.from([KEY_LIVE_BOOK_BRANCH])),
    measurePrefixBytes(db, Buffer.from([KEY_LIVE_BOOK_LEAF])),
    measurePrefixBytes(db, Buffer.from([KEY_LIVE_ENTITY_BRANCH])),
    measurePrefixBytes(db, Buffer.from([KEY_LIVE_ENTITY_LEAF])),
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
    liveEntityFieldStats.bytes +
    liveAccountStats.bytes +
    liveAccountFieldStats.bytes +
    liveBookStats.bytes +
    liveReplicaMetaStats.bytes +
    accountGraphBranchStats.bytes +
    accountGraphLeafStats.bytes +
    bookGraphBranchStats.bytes +
    bookGraphLeafStats.bytes +
    entityGraphBranchStats.bytes +
    entityGraphLeafStats.bytes +
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
    liveEntityFieldCount: liveEntityFieldStats.count,
    liveEntityFieldBytes: liveEntityFieldStats.bytes,
    liveAccountCount: liveAccountStats.count,
    liveAccountFieldCount: liveAccountFieldStats.count,
    liveAccountFieldBytes: liveAccountFieldStats.bytes,
    liveBookCount: liveBookStats.count,
    accountGraphBranchCount: accountGraphBranchStats.count,
    accountGraphLeafCount: accountGraphLeafStats.count,
    bookGraphBranchCount: bookGraphBranchStats.count,
    bookGraphLeafCount: bookGraphLeafStats.count,
    entityGraphBranchCount: entityGraphBranchStats.count,
    entityGraphLeafCount: entityGraphLeafStats.count,
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
import { Buffer } from '../../support/platform-crypto';
