import { encodeBuffer, writeBatch } from './codec';
import { hashCertifiedBoardNode } from '../jurisdiction/board-registry';
import type { CertifiedBoardPatriciaNode } from '../types/entity-board-registry';
import { hashConsumptionNode, type ConsumptionNode } from '../entity/consumption-accumulator';
import {
  collectReachableAccountJClaimNodes,
  hashAccountJClaimNode,
  type AccountJClaimNode,
} from '../account/j-claim-accumulator';
import { docValueKey, liveKeyForDoc } from './doc-refs';
import {
  computeStorageFrameHash,
  computeStoragePostStateHash,
  computeStorageReplicaMetaDigest,
  prepareStorageStateHashes,
} from './hashes';
import { deleteKeyRange, iterateKeys } from './level';
import {
  KEY_HEAD,
  KEY_SNAPSHOT_ACCOUNT,
  KEY_SNAPSHOT_BOOK,
  KEY_SNAPSHOT_ENTITY,
  KEY_SNAPSHOT_REPLICA_META,
  ZERO_FRAME_HASH,
  encodeHeight,
  keyFrame,
  keyLiveReplicaMetaPrefix,
  keyCertifiedBoardNode,
  keyConsumptionNode,
  keyAccountJClaimNode,
  keySnapshotManifest,
} from './keys';
import { readStorageFrameRecord, readStorageHead } from './read';
import { verifyStorageSnapshotIntegrity } from './verify';
import { verifyStorageTailIntegrity } from './verify';
import { projectReplayVerifiableRuntimeMachine } from '../wal/snapshot';
import type {
  RuntimeDbLike,
  RuntimeFrameDbLike,
  StorageDoc,
  StorageEntityHashDoc,
  StorageFrameEntityHash,
  StorageFrameRecord,
  StorageHead,
  StoragePersistenceBoundaryHook,
  StorageSnapshotManifest,
} from './types';

type ReplicaMetaEntry = { key: Buffer; value: Buffer };

type ExistingHistoryDecision =
  | { kind: 'replace' }
  | { kind: 'idempotent'; head: StorageHead; frame: StorageFrameRecord };

export type RestoredStorageBaseOptions = {
  currentDb: RuntimeDbLike;
  historyDb: RuntimeFrameDbLike;
  height: number;
  timestamp: number;
  docs: StorageDoc[];
  replicaMetas: ReplicaMetaEntry[];
  headConfig: Omit<StorageHead, 'latestHeight' | 'latestMaterializedHeight' | 'latestSnapshotHeight' | 'retainedHistoryBytes'>;
  canonicalStateHash: string;
  canonicalEntityHashes: StorageFrameEntityHash[];
  runtimeMachine: Record<string, unknown>;
  certifiedBoardNodes: Array<{ hash: string; node: CertifiedBoardPatriciaNode }>;
  consumptionNodes: Array<{ hash: string; node: ConsumptionNode }>;
  accountJClaimNodes: Array<{ hash: string; node: AccountJClaimNode }>;
  onPersistenceBoundary?: StoragePersistenceBoundaryHook;
};

const requireAtomicDelete = (batch: ReturnType<RuntimeDbLike['batch']>, label: string): void => {
  if (typeof batch.del !== 'function') throw new Error(`${label}_DELETE_UNSUPPORTED`);
};

const snapshotKeyForDoc = (height: number, doc: StorageDoc): Buffer => {
  const prefix = doc.family === 'entity'
    ? KEY_SNAPSHOT_ENTITY
    : doc.family === 'account'
      ? KEY_SNAPSHOT_ACCOUNT
      : KEY_SNAPSHOT_BOOK;
  return Buffer.concat([Buffer.from([prefix]), encodeHeight(height), liveKeyForDoc(doc).subarray(1)]);
};

const encodedDocValue = (
  doc: StorageDoc,
  prepared: Awaited<ReturnType<typeof prepareStorageStateHashes>>,
): Buffer => prepared.docValueBuffers.get(docValueKey(doc)) ?? encodeBuffer(doc.value);

const invalidateCurrentCache = async (
  db: RuntimeDbLike,
  onBoundary?: StoragePersistenceBoundaryHook,
): Promise<void> => {
  if (typeof db.keys !== 'function') throw new Error('RECOVERY_IMPORT_CURRENT_KEYS_UNSUPPORTED');
  const fence = db.batch();
  requireAtomicDelete(fence, 'RECOVERY_IMPORT_CURRENT_FENCE');
  fence.del!(KEY_HEAD);
  await writeBatch(fence);
  await onBoundary?.('after-restore-current-fence');
  await deleteKeyRange(db, {}, () => true, async () => {
    await onBoundary?.('after-restore-current-clear-chunk');
  });
};

const queueCurrentBody = (
  batch: ReturnType<RuntimeDbLike['batch']>,
  docs: readonly StorageDoc[],
  prepared: Awaited<ReturnType<typeof prepareStorageStateHashes>>,
  certifiedBoardNodes: readonly { key: Buffer; value: Buffer }[],
  consumptionNodes: readonly { key: Buffer; value: Buffer }[],
  accountJClaimNodes: readonly { key: Buffer; value: Buffer }[],
): void => {
  for (const doc of docs) batch.put(liveKeyForDoc(doc), encodedDocValue(doc, prepared));
  for (const item of prepared.merklePuts) batch.put(item.key, item.value);
  for (const item of certifiedBoardNodes) batch.put(item.key, item.value);
  for (const item of consumptionNodes) batch.put(item.key, item.value);
  for (const item of accountJClaimNodes) batch.put(item.key, item.value);
};

const buildSnapshotEntries = (
  height: number,
  docs: readonly StorageDoc[],
  prepared: Awaited<ReturnType<typeof prepareStorageStateHashes>>,
): Array<{ key: Buffer; value: Buffer }> => docs.map((doc) => ({
  key: snapshotKeyForDoc(height, doc),
  value: encodedDocValue(doc, prepared),
}));

const buildSnapshotReplicaMetaEntries = (
  height: number,
  replicaMetas: readonly ReplicaMetaEntry[],
): ReplicaMetaEntry[] => replicaMetas.map(({ key, value }) => {
  if (key.length !== 65 || key[0] !== keyLiveReplicaMetaPrefix()[0]) {
    throw new Error(`RECOVERY_IMPORT_REPLICA_META_KEY_INVALID:${key.toString('hex')}`);
  }
  return {
    key: Buffer.concat([
      Buffer.from([KEY_SNAPSHOT_REPLICA_META]),
      encodeHeight(height),
      key.subarray(1),
    ]),
    value,
  };
});

const entriesBytes = (entries: readonly { key: Buffer; value: Buffer }[]): number =>
  entries.reduce((total, item) => total + item.key.byteLength + item.value.byteLength, 0);

const assertUniqueReplicaMetas = (entries: readonly ReplicaMetaEntry[]): void => {
  const keys = new Set<string>();
  for (const entry of entries) {
    const key = entry.key.toString('hex');
    if (keys.has(key)) throw new Error(`RECOVERY_IMPORT_REPLICA_META_DUPLICATE:${key}`);
    keys.add(key);
  }
};

const readAuthoritativeReplicaMetas = async (db: RuntimeFrameDbLike): Promise<ReplicaMetaEntry[]> => {
  const entries: ReplicaMetaEntry[] = [];
  for await (const key of iterateKeys(db, { prefix: keyLiveReplicaMetaPrefix() })) {
    entries.push({ key, value: await db.get(key) });
  }
  return entries;
};

const decideExistingHistory = async (
  options: RestoredStorageBaseOptions,
): Promise<ExistingHistoryDecision> => {
  const verified = await verifyStorageTailIntegrity(options.historyDb);
  if (verified.latestHeight === 0) return { kind: 'replace' };
  const head = await readStorageHead(options.historyDb);
  const frame = await readStorageFrameRecord(options.historyDb, verified.latestHeight);
  if (!head || !frame) throw new Error('RECOVERY_IMPORT_EXISTING_HISTORY_INCOMPLETE');
  if (verified.latestHeight > options.height) {
    throw new Error(
      `RECOVERY_IMPORT_ROLLBACK_REJECTED:existing=${verified.latestHeight}:candidate=${options.height}:` +
      `existingHash=${frame.canonicalStateHash ?? 'missing'}:candidateHash=${options.canonicalStateHash}`,
    );
  }
  if (verified.latestHeight < options.height) {
    if (frame.timestamp > options.timestamp) {
      throw new Error(
        `RECOVERY_IMPORT_TIMESTAMP_ROLLBACK:existing=${frame.timestamp}:candidate=${options.timestamp}`,
      );
    }
    return { kind: 'replace' };
  }
  if (!frame.canonicalStateHash) throw new Error('RECOVERY_IMPORT_EXISTING_CANONICAL_HASH_MISSING');
  if (frame.canonicalStateHash !== options.canonicalStateHash) {
    throw new Error(
      `RECOVERY_IMPORT_SAME_HEIGHT_CONFLICT:height=${options.height}:` +
      `existingHash=${frame.canonicalStateHash}:candidateHash=${options.canonicalStateHash}`,
    );
  }
  const existingMetaDigest = computeStorageReplicaMetaDigest(await readAuthoritativeReplicaMetas(options.historyDb));
  const candidateMetaDigest = computeStorageReplicaMetaDigest(options.replicaMetas);
  if (existingMetaDigest !== candidateMetaDigest) {
    throw new Error(
      `RECOVERY_IMPORT_SAME_HEIGHT_META_CONFLICT:height=${options.height}:` +
      `existingMeta=${existingMetaDigest}:candidateMeta=${candidateMetaDigest}`,
    );
  }
  return { kind: 'idempotent', head, frame };
};

const queueHistoryReplacement = async (
  db: RuntimeFrameDbLike,
  entries: readonly { key: Buffer; value: Buffer }[],
): Promise<ReturnType<RuntimeFrameDbLike['batch']>> => {
  if (typeof db.keys !== 'function') throw new Error('RECOVERY_IMPORT_HISTORY_KEYS_UNSUPPORTED');
  const batch = db.batch();
  requireAtomicDelete(batch, 'RECOVERY_IMPORT_HISTORY');
  for await (const key of iterateKeys(db, {})) batch.del!(key);
  for (const item of entries) batch.put(item.key, item.value);
  return batch;
};

/**
 * Publish a restored checkpoint without an empty-history window. The current
 * database is only a cache: its head is removed first, so every crash before
 * the authoritative atomic history batch rebuilds from the old history. After
 * that batch, every crash rebuilds from the complete new snapshot.
 */
export const replaceRestoredStorageBase = async (
  options: RestoredStorageBaseOptions,
): Promise<{ entityHashDocs: Map<string, StorageEntityHashDoc> }> => {
  assertUniqueReplicaMetas(options.replicaMetas);
  const certifiedBoardNodes = options.certifiedBoardNodes.map(({ hash, node }) => {
    const actualHash = hashCertifiedBoardNode(node);
    if (actualHash !== hash) throw new Error(`CERTIFIED_BOARD_NODE_CORRUPT:${hash}:${actualHash}`);
    return { key: keyCertifiedBoardNode(hash), value: encodeBuffer(node) };
  });
  const consumptionNodes = options.consumptionNodes.map(({ hash, node }) => {
    const actualHash = hashConsumptionNode(node);
    if (actualHash !== hash) throw new Error(`CONSUMPTION_NODE_CORRUPT:${hash}:${actualHash}`);
    return { key: keyConsumptionNode(hash), value: encodeBuffer(node) };
  });
  const accountJClaimNodes = options.accountJClaimNodes.map(({ hash, node }) => {
    const actualHash = hashAccountJClaimNode(node);
    if (actualHash !== hash) throw new Error(`ACCOUNT_J_CLAIM_NODE_CORRUPT:${hash}:${actualHash}`);
    return { key: keyAccountJClaimNode(hash), value: encodeBuffer(node) };
  });
  const accountJClaimStates = options.docs.flatMap((doc) => doc.family === 'account'
    ? [doc.value.leftPendingJClaims, doc.value.rightPendingJClaims]
    : []);
  collectReachableAccountJClaimNodes(
    new Map(options.accountJClaimNodes.map(({ hash, node }) => [hash, node])),
    accountJClaimStates,
  );
  const existing = await decideExistingHistory(options);
  await invalidateCurrentCache(options.currentDb, options.onPersistenceBoundary);
  const prepared = await prepareStorageStateHashes({
    db: options.currentDb,
    puts: options.docs,
    dels: [],
  });
  const replicaMetaDigest = computeStorageReplicaMetaDigest(options.replicaMetas);
  const postStateHash = computeStoragePostStateHash({
    height: options.height,
    timestamp: options.timestamp,
    replicaMetaDigest,
    runtimeMachine: projectReplayVerifiableRuntimeMachine(options.runtimeMachine),
  });

  const currentBody = options.currentDb.batch();
  queueCurrentBody(
    currentBody,
    options.docs,
    prepared,
    certifiedBoardNodes,
    consumptionNodes,
    accountJClaimNodes,
  );
  await writeBatch(currentBody);
  await options.onPersistenceBoundary?.('after-restore-current-body');

  if (existing.kind === 'idempotent') {
    if (prepared.stateHash !== existing.frame.stateHash) {
      throw new Error(
        `RECOVERY_IMPORT_SAME_HEIGHT_STORAGE_HASH_CONFLICT:height=${options.height}:` +
        `existingHash=${existing.frame.stateHash}:candidateHash=${prepared.stateHash}`,
      );
    }
    if (postStateHash !== existing.frame.postStateHash) {
      throw new Error(
        `RECOVERY_IMPORT_SAME_HEIGHT_POST_STATE_HASH_CONFLICT:height=${options.height}:` +
        `existingHash=${existing.frame.postStateHash}:candidateHash=${postStateHash}`,
      );
    }
    const currentHead = options.currentDb.batch();
    currentHead.put(KEY_HEAD, encodeBuffer(existing.head));
    await writeBatch(currentHead);
    await options.onPersistenceBoundary?.('after-restore-current-head');
    return { entityHashDocs: prepared.entityHashDocs };
  }

  const snapshotEntries = buildSnapshotEntries(options.height, options.docs, prepared);
  const snapshotReplicaMetaEntries = buildSnapshotReplicaMetaEntries(options.height, options.replicaMetas);
  const manifestEntry = {
    key: keySnapshotManifest(options.height),
    value: encodeBuffer({
      height: options.height,
      createdAt: options.timestamp,
      docCount: snapshotEntries.length + snapshotReplicaMetaEntries.length,
    } satisfies StorageSnapshotManifest),
  };
  const frameBase: StorageFrameRecord = {
    height: options.height,
    timestamp: options.timestamp,
    prevFrameHash: ZERO_FRAME_HASH,
    replicaMetaDigest,
    replicaMetaCheckpoint: true,
    replicaMetaStateMode: 'full',
    postStateHash,
    stateHash: prepared.stateHash,
    hashMode: 'storage-merkle-v1',
    materializedState: true,
    entityHashes: prepared.entityHashes,
    canonicalStateHash: options.canonicalStateHash,
    canonicalEntityHashes: options.canonicalEntityHashes,
    runtimeStateHash: options.canonicalStateHash,
    runtimeMachine: options.runtimeMachine,
    runtimeInput: { runtimeTxs: [], entityInputs: [] },
    touchedEntities: Array.from(new Set(options.docs.map((doc) => doc.entityId))).sort(),
    touchedAccounts: options.docs
      .filter((doc): doc is Extract<StorageDoc, { family: 'account' }> => doc.family === 'account')
      .map((doc) => ({ entityId: doc.entityId, counterpartyId: doc.counterpartyId })),
    touchedBookEntities: Array.from(new Set(options.docs
      .filter((doc): doc is Extract<StorageDoc, { family: 'book' }> => doc.family === 'book')
      .map((doc) => doc.entityId))).sort(),
  };
  const frame: StorageFrameRecord = { ...frameBase, frameHash: computeStorageFrameHash(frameBase) };
  const frameEntry = { key: keyFrame(options.height), value: encodeBuffer(frame) };
  const retainedHistoryBytes = entriesBytes([
    ...snapshotEntries,
    ...snapshotReplicaMetaEntries,
    manifestEntry,
    frameEntry,
    ...options.replicaMetas,
    ...certifiedBoardNodes,
    ...consumptionNodes,
    ...accountJClaimNodes,
  ]);
  const head: StorageHead = {
    ...options.headConfig,
    latestHeight: options.height,
    latestMaterializedHeight: options.height,
    latestSnapshotHeight: options.height,
    retainedHistoryBytes,
  };
  const historyEntries = [
    ...snapshotEntries,
    ...snapshotReplicaMetaEntries,
    manifestEntry,
    frameEntry,
    ...options.replicaMetas,
    ...certifiedBoardNodes,
    ...consumptionNodes,
    ...accountJClaimNodes,
    { key: KEY_HEAD, value: encodeBuffer(head) },
  ];
  const historyBatch = await queueHistoryReplacement(options.historyDb, historyEntries);
  await writeBatch(historyBatch);
  await options.onPersistenceBoundary?.('after-restore-authoritative-swap');
  await verifyStorageSnapshotIntegrity(options.historyDb, head);

  const currentHead = options.currentDb.batch();
  currentHead.put(KEY_HEAD, encodeBuffer(head));
  await writeBatch(currentHead);
  await options.onPersistenceBoundary?.('after-restore-current-head');
  return { entityHashDocs: prepared.entityHashDocs };
};
