import type { RuntimeReplica } from '../../runtime/types';
import {
  KEY_FRAME,
  KEY_BOUNDED_VALUE_CHUNK,
  KEY_RUNTIME_OUTPUT_PAYLOAD,
  KEY_ENTITY_CONTEXT_PAYLOAD,
  KEY_RUNTIME_MACHINE_BRANCH,
  KEY_RUNTIME_MACHINE_LEAF,
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
  KEY_SNAPSHOT_GRAPH,
  HISTORY_VIEW_ACCOUNT_FRAME,
  HISTORY_VIEW_RUNTIME_ACTIVITY,
  HISTORY_VIEW_ENTITY_FRAME,
  HISTORY_VIEW_ACCOUNT_SWAP_EVENT,
  HISTORY_VIEW_ACCOUNT_SWAP_RECENCY,
  parseBoundedValueChunkKey,
} from '../keys';
import { iterateKeys, measurePrefixBytes } from '../database/level';
import { listSnapshotHeights } from '../database/lifecycle';
import { readStorageHead } from './read';
import type { RuntimeDbLike, StorageDebugStats } from '../types';
import { requireStorageDbOpen } from '../commit/availability';

const isRebuildableHistoryOwner = (ownerKey: Buffer): boolean => {
  const tag = ownerKey[0];
  return tag !== undefined && tag >= HISTORY_VIEW_ACCOUNT_FRAME && tag <= HISTORY_VIEW_ACCOUNT_SWAP_RECENCY;
};

const measureBoundedValueChunks = async (db: RuntimeDbLike) => {
  const total = { count: 0, bytes: 0, maxValueBytes: 0 };
  const authoritative = { count: 0, bytes: 0, maxValueBytes: 0 };
  const rebuildable = { count: 0, bytes: 0, maxValueBytes: 0 };
  for await (const key of iterateKeys(db, { prefix: Buffer.from([KEY_BOUNDED_VALUE_CHUNK]) })) {
    const value = await db.get(key);
    const bucket = isRebuildableHistoryOwner(parseBoundedValueChunkKey(key).ownerKey)
      ? rebuildable
      : authoritative;
    for (const stats of [total, bucket]) {
      stats.count += 1;
      stats.bytes += key.byteLength + value.byteLength;
      stats.maxValueBytes = Math.max(stats.maxValueBytes, value.byteLength);
    }
  }
  return { total, authoritative, rebuildable } as const;
};

const maxNamespaceValueBytes = (
  ...stats: ReadonlyArray<Readonly<{ maxValueBytes: number }>>
): number => Math.max(0, ...stats.map(value => value.maxValueBytes));

const measureStorageNamespaces = (db: RuntimeDbLike) => Promise.all([
  measurePrefixBytes(db, Buffer.from([KEY_FRAME])),
  measureBoundedValueChunks(db),
  measurePrefixBytes(db, Buffer.from([HISTORY_VIEW_ACCOUNT_FRAME])),
  measurePrefixBytes(db, Buffer.from([HISTORY_VIEW_RUNTIME_ACTIVITY])),
  measurePrefixBytes(db, Buffer.from([HISTORY_VIEW_ENTITY_FRAME])),
  measurePrefixBytes(db, Buffer.from([HISTORY_VIEW_ACCOUNT_SWAP_EVENT])),
  measurePrefixBytes(db, Buffer.from([HISTORY_VIEW_ACCOUNT_SWAP_RECENCY])),
  measurePrefixBytes(db, Buffer.from([KEY_RUNTIME_OUTPUT_PAYLOAD])),
  measurePrefixBytes(db, Buffer.from([KEY_ENTITY_CONTEXT_PAYLOAD])),
  measurePrefixBytes(db, Buffer.from([KEY_RUNTIME_MACHINE_BRANCH])),
  measurePrefixBytes(db, Buffer.from([KEY_RUNTIME_MACHINE_LEAF])),
  measurePrefixBytes(db, Buffer.from([KEY_SNAPSHOT_MANIFEST])),
  measurePrefixBytes(db, Buffer.from([KEY_SNAPSHOT_ENTITY])),
  measurePrefixBytes(db, Buffer.from([KEY_SNAPSHOT_ACCOUNT])),
  measurePrefixBytes(db, Buffer.from([KEY_SNAPSHOT_BOOK])),
  measurePrefixBytes(db, Buffer.from([KEY_SNAPSHOT_REPLICA_META])),
  measurePrefixBytes(db, Buffer.from([KEY_SNAPSHOT_GRAPH])),
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
] as const);

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
    boundedValueChunks,
    accountFrameHistoryStats,
    runtimeActivityHistoryStats,
    entityFrameHistoryStats,
    accountSwapEventHistoryStats,
    accountSwapRecencyHistoryStats,
    runtimeOutputPayloadStats,
    entityContextPayloadStats,
    runtimeMachineBranchStats,
    runtimeMachineLeafStats,
    snapshotManifestStats,
    snapshotEntityStats,
    snapshotAccountStats,
    snapshotBookStats,
    snapshotReplicaMetaStats,
    snapshotGraphStats,
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
  ] = await measureStorageNamespaces(db);

  const snapshotBytes =
    snapshotManifestStats.bytes +
    snapshotEntityStats.bytes +
    snapshotAccountStats.bytes +
    snapshotBookStats.bytes +
    snapshotReplicaMetaStats.bytes +
    snapshotGraphStats.bytes;
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
    entityGraphLeafStats.bytes;
  const immutableBytes =
    runtimeOutputPayloadStats.bytes +
    entityContextPayloadStats.bytes +
    runtimeMachineBranchStats.bytes +
    runtimeMachineLeafStats.bytes +
    certifiedBoardNodeStats.bytes +
    consumptionNodeStats.bytes +
    accountJClaimNodeStats.bytes;
  const historyViewBytes =
    accountFrameHistoryStats.bytes +
    runtimeActivityHistoryStats.bytes +
    entityFrameHistoryStats.bytes +
    accountSwapEventHistoryStats.bytes +
    accountSwapRecencyHistoryStats.bytes +
    boundedValueChunks.rebuildable.bytes;
  const historyBytes =
    frameStats.bytes + boundedValueChunks.authoritative.bytes + snapshotBytes + immutableBytes;
  const totalBytes = historyBytes + historyViewBytes + liveBytes;

  return {
    head,
    frameCount: frameStats.count,
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
    boundedValueCount: boundedValueChunks.total.count,
    boundedValueBytes: boundedValueChunks.total.bytes,
    historyViewBytes,
    snapshotBytes,
    liveBytes,
    historyBytes,
    totalBytes,
    maxFrameBytes: frameStats.maxValueBytes,
    maxPhysicalValueBytes: maxNamespaceValueBytes(
      frameStats, boundedValueChunks.total, accountFrameHistoryStats,
      runtimeActivityHistoryStats, entityFrameHistoryStats, accountSwapEventHistoryStats,
      accountSwapRecencyHistoryStats, snapshotManifestStats, snapshotEntityStats,
      snapshotAccountStats, snapshotBookStats, snapshotReplicaMetaStats, snapshotGraphStats,
      liveEntityStats, liveEntityFieldStats, liveAccountStats, liveAccountFieldStats,
      liveBookStats, liveReplicaMetaStats, accountGraphBranchStats, accountGraphLeafStats,
      bookGraphBranchStats, bookGraphLeafStats, entityGraphBranchStats, entityGraphLeafStats,
      runtimeOutputPayloadStats, entityContextPayloadStats, runtimeMachineBranchStats,
      runtimeMachineLeafStats, certifiedBoardNodeStats, consumptionNodeStats, accountJClaimNodeStats,
    ),
    maxSnapshotBytes: Math.max(
      snapshotManifestStats.maxValueBytes,
      snapshotEntityStats.maxValueBytes,
      snapshotAccountStats.maxValueBytes,
      snapshotBookStats.maxValueBytes,
      snapshotReplicaMetaStats.maxValueBytes,
      snapshotGraphStats.maxValueBytes,
    ),
  };
};
import { Buffer } from '../../support/platform-crypto';
