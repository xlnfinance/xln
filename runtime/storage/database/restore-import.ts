import { encodeBuffer, writeBatch } from '../codec/codec';
import { hashCertifiedBoardNode } from '../../jurisdiction/machine/board-registry';
import type { CertifiedBoardPatriciaNode } from '../../types/entity-board-registry';
import { hashConsumptionNode, type ConsumptionNode } from '../../entity/consumption/consumption-accumulator';
import {
  collectReachableAccountJClaimNodes,
  hashAccountJClaimNode,
  type AccountJClaimNode,
} from '../../account/j-claims/j-claim-accumulator';
import { docValueKey, liveKeyForDoc } from '../schema/doc-refs';
import {
  computeStorageFrameHash,
  computeStoragePostStateHash,
  computeRuntimePostStateComponentDigests,
  prepareStorageStateHashes,
} from '../hashes';
import { computeStorageReplicaMetaDigest } from '../replica/replica-meta-digest';
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
} from '../keys';
import { readStorageFrameRecord, readStorageHead } from '../read/read';
import { verifyStorageSnapshotIntegrity } from '../read/verify';
import { verifyStorageTailIntegrity } from '../read/verify';
import { projectReplayVerifiableRuntimePostStateView } from '../wal/snapshot';
import { prepareRuntimeMachineGraphRows } from '../wal/runtime-machine-graph';
import { buildHistoryViewPuts } from '../history/history-view';
import type {
  RuntimeDbLike,
  StorageDoc,
  StorageEntityHashDoc,
  StorageFrameEntityHash,
  RuntimeFrame,
  StorageHead,
  StoragePersistenceBoundaryHook,
  StorageSnapshotManifest,
} from '../types';

type ReplicaMetaEntry = { key: Buffer; value: Buffer };
type EncodedNode = { key: Buffer; value: Buffer };

type ExistingHistoryDecision =
  { kind: 'replace' } | { kind: 'idempotent'; head: StorageHead; frame: RuntimeFrame };

export type RestoredStorageBaseOptions = {
  currentDb: RuntimeDbLike;
  walDb: RuntimeDbLike;
  height: number;
  timestamp: number;
  docs: StorageDoc[];
  replicaMetas: ReplicaMetaEntry[];
  headConfig: Omit<
    StorageHead,
    'latestHeight' | 'latestMaterializedHeight' | 'latestSnapshotHeight' | 'epochReplayBytes' | 'retainedHistoryBytes'
  >;
  canonicalStateHash: string;
  canonicalEntityHashes: StorageFrameEntityHash[];
  runtimeMachine: Record<string, unknown>;
  certifiedBoardNodes: Array<{ hash: string; node: CertifiedBoardPatriciaNode }>;
  consumptionNodes: Array<{ hash: string; node: ConsumptionNode }>;
  accountJClaimNodes: Array<{ hash: string; node: AccountJClaimNode }>;
  onPersistenceBoundary?: StoragePersistenceBoundaryHook;
};

const snapshotKeyForDoc = (height: number, doc: StorageDoc): Buffer => {
  const prefix =
    doc.family === 'entity' ? KEY_SNAPSHOT_ENTITY : doc.family === 'account' ? KEY_SNAPSHOT_ACCOUNT : KEY_SNAPSHOT_BOOK;
  return Buffer.concat([Buffer.from([prefix]), encodeHeight(height), liveKeyForDoc(doc).subarray(1)]);
};

const encodedDocValue = (doc: StorageDoc, prepared: Awaited<ReturnType<typeof prepareStorageStateHashes>>): Buffer =>
  prepared.docValueBuffers.get(docValueKey(doc)) ?? encodeBuffer(doc.value);

const invalidateCurrentCache = async (
  db: RuntimeDbLike,
  onBoundary?: StoragePersistenceBoundaryHook,
): Promise<void> => {
  if (typeof db.keys !== 'function') throw new Error('RECOVERY_IMPORT_CURRENT_KEYS_UNSUPPORTED');
  const fence = db.batch();
  fence.del(KEY_HEAD);
  await writeBatch(fence);
  await onBoundary?.('after-restore-current-fence');
  await deleteKeyRange(
    db,
    {},
    () => true,
    async () => {
      await onBoundary?.('after-restore-current-clear-batch');
    },
  );
};

const queueCurrentBody = (
  batch: ReturnType<RuntimeDbLike['batch']>,
  docs: readonly StorageDoc[],
  prepared: Awaited<ReturnType<typeof prepareStorageStateHashes>>,
  certifiedBoardNodes: readonly { key: Buffer; value: Buffer }[],
  consumptionNodes: readonly { key: Buffer; value: Buffer }[],
  accountJClaimNodes: readonly { key: Buffer; value: Buffer }[],
): void => {
  void docs;
  for (const key of prepared.docDels) batch.del(key);
  for (const item of prepared.docPuts) batch.put(item.key, item.value);
  for (const item of prepared.merklePuts) batch.put(item.key, item.value);
  for (const item of certifiedBoardNodes) batch.put(item.key, item.value);
  for (const item of consumptionNodes) batch.put(item.key, item.value);
  for (const item of accountJClaimNodes) batch.put(item.key, item.value);
};

const buildSnapshotEntries = (
  height: number,
  docs: readonly StorageDoc[],
  prepared: Awaited<ReturnType<typeof prepareStorageStateHashes>>,
): Array<{ key: Buffer; value: Buffer }> =>
  docs.map(doc => ({
    key: snapshotKeyForDoc(height, doc),
    value: encodedDocValue(doc, prepared),
  }));

const buildSnapshotReplicaMetaEntries = (
  height: number,
  replicaMetas: readonly ReplicaMetaEntry[],
): ReplicaMetaEntry[] =>
  replicaMetas.map(({ key, value }) => {
    if (key.length !== 65 || key[0] !== keyLiveReplicaMetaPrefix()[0]) {
      throw new Error(`RECOVERY_IMPORT_REPLICA_META_KEY_INVALID:${key.toString('hex')}`);
    }
    return {
      key: Buffer.concat([Buffer.from([KEY_SNAPSHOT_REPLICA_META]), encodeHeight(height), key.subarray(1)]),
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

const readAuthoritativeReplicaMetas = async (db: RuntimeDbLike): Promise<ReplicaMetaEntry[]> => {
  const entries: ReplicaMetaEntry[] = [];
  for await (const key of iterateKeys(db, { prefix: keyLiveReplicaMetaPrefix() })) {
    entries.push({ key, value: await db.get(key) });
  }
  return entries;
};

const decideExistingHistory = async (options: RestoredStorageBaseOptions): Promise<ExistingHistoryDecision> => {
  const verified = await verifyStorageTailIntegrity(options.walDb);
  if (verified.latestHeight === 0) return { kind: 'replace' };
  const head = await readStorageHead(options.walDb);
  const frame = await readStorageFrameRecord(options.walDb, verified.latestHeight);
  if (!head || !frame) throw new Error('RECOVERY_IMPORT_EXISTING_HISTORY_INCOMPLETE');
  if (verified.latestHeight > options.height) {
    throw new Error(
      `RECOVERY_IMPORT_ROLLBACK_REJECTED:existing=${verified.latestHeight}:candidate=${options.height}:` +
        `existingHash=${frame.canonicalStateHash ?? 'missing'}:candidateHash=${options.canonicalStateHash}`,
    );
  }
  if (verified.latestHeight < options.height) {
    if (frame.timestamp > options.timestamp) {
      throw new Error(`RECOVERY_IMPORT_TIMESTAMP_ROLLBACK:existing=${frame.timestamp}:candidate=${options.timestamp}`);
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
  const existingMetaDigest = computeStorageReplicaMetaDigest(await readAuthoritativeReplicaMetas(options.walDb));
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
  db: RuntimeDbLike,
  entries: readonly { key: Buffer; value: Buffer }[],
): Promise<ReturnType<RuntimeDbLike['batch']>> => {
  if (typeof db.keys !== 'function') throw new Error('RECOVERY_IMPORT_HISTORY_KEYS_UNSUPPORTED');
  const batch = db.batch();
  for await (const key of iterateKeys(db, {})) batch.del(key);
  for (const item of entries) batch.put(item.key, item.value);
  return batch;
};

const prepareCertifiedNodes = (
  options: RestoredStorageBaseOptions,
): {
  certifiedBoardNodes: EncodedNode[];
  consumptionNodes: EncodedNode[];
  accountJClaimNodes: EncodedNode[];
} => {
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
  const accountJClaimStates = options.docs.flatMap(doc =>
    doc.family === 'account' ? [doc.value.state.leftPendingJClaims, doc.value.state.rightPendingJClaims] : [],
  );
  collectReachableAccountJClaimNodes(
    new Map(options.accountJClaimNodes.map(({ hash, node }) => [hash, node])),
    accountJClaimStates,
  );
  return { certifiedBoardNodes, consumptionNodes, accountJClaimNodes };
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
  const { certifiedBoardNodes, consumptionNodes, accountJClaimNodes } = prepareCertifiedNodes(options);
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
    runtimeComponentDigests: computeRuntimePostStateComponentDigests(
      projectReplayVerifiableRuntimePostStateView(options.runtimeMachine),
    ),
    runtimeOutputRefs: [],
  });

  const currentBody = options.currentDb.batch();
  queueCurrentBody(currentBody, options.docs, prepared, certifiedBoardNodes, consumptionNodes, accountJClaimNodes);
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
  const runtimeMachineGraph = prepareRuntimeMachineGraphRows(
    options.height,
    options.runtimeMachine,
  );
  if (!runtimeMachineGraph.root) {
    throw new Error('RECOVERY_IMPORT_RUNTIME_MACHINE_ROOT_MISSING');
  }
  const manifestEntry = {
    key: keySnapshotManifest(options.height),
    value: encodeBuffer({
      height: options.height,
      createdAt: options.timestamp,
      docCount: snapshotEntries.length + snapshotReplicaMetaEntries.length,
    } satisfies StorageSnapshotManifest),
  };
  const frameBase: RuntimeFrame = {
    height: options.height,
    timestamp: options.timestamp,
    prevFrameHash: ZERO_FRAME_HASH,
    replicaMetaDigest,
    replicaMetaCheckpoint: true,
    replicaMetaStateMode: 'shared-entity-state',
    postStateHash,
    stateHash: prepared.stateHash,
    hashMode: 'storage-merkle-v1',
    materializedState: true,
    entityHashes: prepared.entityHashes,
    canonicalStateHash: options.canonicalStateHash,
    canonicalEntityHashes: options.canonicalEntityHashes,
    runtimeStateHash: options.canonicalStateHash,
    runtimeMachineRoot: runtimeMachineGraph.root,
    runtimeInput: { runtimeTxs: [], entityInputs: [] },
    touchedEntities: Array.from(new Set(options.docs.map(doc => doc.entityId))).sort(),
    touchedAccounts: options.docs
      .filter((doc): doc is Extract<StorageDoc, { family: 'account' }> => doc.family === 'account')
      .map(doc => ({ entityId: doc.entityId, counterpartyId: doc.counterpartyId })),
    touchedBookEntities: Array.from(
      new Set(
        options.docs
          .filter((doc): doc is Extract<StorageDoc, { family: 'book' }> => doc.family === 'book')
          .map(doc => doc.entityId),
      ),
    ).sort(),
  };
  const frame: RuntimeFrame = { ...frameBase, frameHash: computeStorageFrameHash(frameBase) };
  const frameEntry = { key: keyFrame(options.height), value: encodeBuffer(frame) };
  const [activityEntry] = buildHistoryViewPuts({
    height: options.height,
    timestamp: options.timestamp,
    runtimeInput: frame.runtimeInput,
    logs: [],
    touchedEntities: frame.touchedEntities,
    touchedAccounts: frame.touchedAccounts,
    touchedBookEntities: frame.touchedBookEntities,
  });
  if (!activityEntry) throw new Error('RESTORE_RUNTIME_ACTIVITY_ENTRY_MISSING');
  const retainedHistoryBytes = entriesBytes([
    ...snapshotEntries,
    ...snapshotReplicaMetaEntries,
    manifestEntry,
    frameEntry,
    activityEntry,
    ...options.replicaMetas,
    ...certifiedBoardNodes,
    ...consumptionNodes,
    ...accountJClaimNodes,
    ...runtimeMachineGraph.rows,
  ]);
  const head: StorageHead = {
    ...options.headConfig,
    latestHeight: options.height,
    latestMaterializedHeight: options.height,
    latestSnapshotHeight: options.height,
    epochReplayBytes: 0,
    retainedHistoryBytes,
  };
  const walEntries = [
    ...snapshotEntries,
    ...snapshotReplicaMetaEntries,
    manifestEntry,
    frameEntry,
    activityEntry,
    ...options.replicaMetas,
    ...certifiedBoardNodes,
    ...consumptionNodes,
    ...accountJClaimNodes,
    ...runtimeMachineGraph.rows,
    { key: KEY_HEAD, value: encodeBuffer(head) },
  ];
  const walBatch = await queueHistoryReplacement(options.walDb, walEntries);
  // This swap establishes the authoritative restore point. Match the normal
  // Runtime WAL commit boundary explicitly; process exit after this await must
  // never acknowledge bytes that only reached an OS cache.
  await writeBatch(walBatch, { sync: true });
  await options.onPersistenceBoundary?.('after-restore-authoritative-swap');
  await verifyStorageSnapshotIntegrity(options.walDb, head);

  const currentHead = options.currentDb.batch();
  currentHead.put(KEY_HEAD, encodeBuffer(head));
  await writeBatch(currentHead);
  await options.onPersistenceBoundary?.('after-restore-current-head');
  return { entityHashDocs: prepared.entityHashDocs };
};
import { Buffer } from '../../infra/platform-crypto';
