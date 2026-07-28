import { decodeValidatedBuffer, encodeBuffer, writeBatch } from './codec';
import {
  deleteKeyRange,
  iterateKeys,
  readRawOrNull,
} from './level';
import {
  buildHistoryViewPuts,
  pruneHistoryViewRetention,
  readHistoryViewHead,
  reconcileHistoryViews,
} from './history-view';
import {
  canonicalizeStorageDoc,
  computeStorageFrameHash,
  computeStoragePostStateHash,
  prepareStorageCanonicalStateHashes,
  prepareStorageStateHashes,
} from './hashes';
import {
  createSnapshot,
  listSnapshotHeights,
  maybeRotateSnapshots,
  pruneHistoryBeforeHeight,
  readSnapshotDocs,
} from './lifecycle';
import {
  buildBookDeletionsFromOverlay,
  buildDocPuts,
  mergeOverlayRecordsIntoEnv,
  storageRefsFromOverlay,
} from './overlay-docs';
import {
  applyCertifiedEntityLineagePlan,
  buildRuntimeCheckpointLineagePlan,
} from './entity-lineage';
import {
  listStorageSnapshotReplicaMetas,
  readStorageFrameRecord,
  readStorageHead,
} from './read';
import {
  KEY_HEAD,
  KEY_DIFF,
  KEY_LIVE_ACCOUNT,
  KEY_LIVE_ACCOUNT_FIELD,
  KEY_LIVE_BOOK,
  KEY_LIVE_ENTITY,
  KEY_MERKLE_BRANCH,
  KEY_MERKLE_LEAF,
  KEY_MERKLE_ROOT,
  KEY_CERTIFIED_BOARD_NODE,
  KEY_CONSUMPTION_NODE,
  KEY_ACCOUNT_J_CLAIM_NODE,
  STORAGE_FRAME_FORMAT,
  STORAGE_SCHEMA_VERSION,
  ZERO_FRAME_HASH,
  decodeEntityId,
  decodeTaggedStorageHash,
  decodeTaggedStorageHeight,
  keyDiff,
  keyFrame,
  keyLiveReplicaMetaPrefix,
  keyCertifiedBoardNode,
  keyCertifiedBoardNodePrefix,
  keyConsumptionNode,
  keyConsumptionNodePrefix,
  keyAccountJClaimNode,
  keyAccountJClaimNodePrefix,
  parseLiveAccountKey,
  keySnapshotReplicaMetaPrefix,
} from './keys';
import { readAccountStorageLayout } from './account-layout';
import {
  buildLiveReplicaLookup,
  buildLiveReplicaMetaPlan,
  buildStorageLiveReplicaMetaCommitment,
  buildStorageReplicaMetaCommitmentFromCheckpointPlan,
  summarizeStorageReplicaMetaHeads,
} from './replicas';
import { createStructuredLogger } from '../infra/logger';
import { cumulativeMarksToDurations } from '../infra/perf-profile';
import type {
  CertifiedBoardPatriciaNode,
  EntityState,
  RuntimeState,
  RoutedEntityInput,
  RuntimeInput,
  RuntimeHistoryRecord,
} from '../types';
import { cloneIsolatedRoutedEntityInputs } from '../protocol/runtime-input-clone';
import {
  collectReachableCertifiedBoardNodes,
  getCertifiedBoardNodeStore,
  hashCertifiedBoardNode,
} from '../jurisdiction/board-registry';
import {
  hashConsumptionNode,
  type ConsumptionAccumulatorState,
  type ConsumptionNode,
} from '../entity/consumption-accumulator';
import {
  collectReachableConsumptionNodes,
  finalizePersistedConsumptionNodes,
  getConsumptionNodeStore,
  getLiveConsumptionAccumulatorStates,
  getSafePendingConsumptionDeletes,
} from '../entity/consumption-store';
import {
  collectReachableAccountJClaimNodes,
  hashAccountJClaimNode,
  type AccountJClaimAccumulatorState,
  type AccountJClaimNode,
} from '../account/j-claim-accumulator';
import {
  finalizePersistedAccountJClaimNodes,
  getLiveAccountJClaimAccumulatorStates,
  getSafePendingAccountJClaimDeletes,
} from '../account/j-claim-store';
import {
  buildDurableRuntimeMempool,
  buildDurableRuntimeMachineSnapshot,
  buildReplayVerifiableRuntimeMachineSnapshot,
} from '../wal/snapshot';
import { buildDurableOutputRetryState } from '../runtime/durable-output-retry';
import { verifyStorageSnapshotIntegrity } from './verify';
import {
  validateAccountJClaimNodeValue,
  validateCertifiedBoardNodeValue,
  validateConsumptionNodeValue,
  validateStorageAccountDocValue,
  validateStorageDiffRecordValue,
  validateStorageEntityCoreDocValue,
} from './authoritative-schema';
import type {
  PerfDeps,
  RuntimeDbLike,
  StorageDiffRecord,
  StorageDoc,
  StorageDocRef,
  StorageEntityHashDoc,
  StorageFrameRecord,
  StorageHead,
  StoragePersistenceBoundaryHook,
  StoragePersistenceProgressHook,
  StorageRuntimeConfig,
} from './types';
import { resolveStorageRuntimeConfig } from './config';
export { resolveStorageRuntimeConfig } from './config';
export {
  buildAccountMerkleFromDocs,
  buildAccountMerkleFromState,
  hydrateAccountDocFromStorage,
  hydrateEntityStateFromStorage,
  projectAccountDoc,
  projectEntityCoreDoc,
} from './projections';
export {
  readHistoryViewAccountFrames,
  readHistoryViewEntityFrames,
  readHistoryViewRuntimeActivity,
  readHistoryViewHead,
  reconcileHistoryViews,
} from './history-view';
export {
  inspectStorage,
} from './inspect';
export {
  seedFreshStorageEpoch,
} from './lifecycle';
export {
  computeStorageFrameHash,
  computeStoragePostStateHash,
  computeStorageStateRoot,
} from './hashes';
export {
  readStorageOverlayRecordsFromDiffs,
} from './overlay-docs';
export {
  verifyStorageSnapshotAtHeight,
} from './verify';
export {
  findStorageLatestSnapshotAtOrBelow,
  hydrateAccountJClaimRootNodesFromStorage,
  hydrateCertifiedBoardRootNodesFromStorage,
  hydrateConsumptionRootNodesFromStorage,
  listStorageLiveEntityIds,
  listStorageSnapshotEntityIds,
  listStorageSnapshotHeights,
  listStorageSnapshotReplicaMetas,
  listStorageReplicaMetas,
  loadEntityAccountDocFromStorage,
  loadEntityStateFromStorage,
  loadEntityStatesAtHeightFromStorage,
  loadEntityViewPageFromStorage,
  readStorageFrameRecord,
  readStorageHead,
  readStorageReplicaMeta,
} from './read';
export {
  verifyStorageTailIntegrity,
} from './verify';
export {
  replaceRestoredStorageBase,
  type RestoredStorageBaseOptions,
} from './restore-import';

export type {
  StorageAccountDocPage,
  StorageBookDocPage,
  StorageEntityViewPage,
} from './read';

export type {
  RuntimeDbLike,
  StorageAccountDoc,
  StorageDebugStats,
  StorageDiffRecord,
  StorageDoc,
  StorageDocRef,
  StorageEntityCoreDoc,
  StorageEntityHashDoc,
  StorageEpochSeedStats,
  StorageFrameEntityHash,
  StorageFrameRecord,
  StorageHead,
  StoragePersistenceBoundary,
  StoragePersistenceBoundaryHook,
  StoragePersistenceProgressHook,
  StorageReplicaMeta,
  StorageRuntimeConfig,
  StorageSnapshotManifest,
} from './types';

const storageLog = createStructuredLogger('runtime.storage');

const defaultStorageHead = (config: Required<StorageRuntimeConfig>): StorageHead => ({
    schemaVersion: STORAGE_SCHEMA_VERSION,
    latestHeight: 0,
    latestMaterializedHeight: 0,
    latestSnapshotHeight: 0,
    snapshotPeriodFrames: config.snapshotPeriodFrames,
    retainSnapshots: config.retainSnapshots,
    epochMaxBytes: config.epochMaxBytes,
    accountMerkleRadix: config.accountMerkleRadix,
    epochReplayBytes: 0,
    retainedHistoryBytes: 0,
  });

const readHead = async (db: RuntimeDbLike, config: Required<StorageRuntimeConfig>): Promise<StorageHead> => {
  const head = await readStorageHead(db);
  if (head) {
    return {
      ...head,
      latestMaterializedHeight: Math.max(
        0,
        Math.floor(Number(head.latestMaterializedHeight ?? head.latestSnapshotHeight ?? 0)),
      ),
    };
  }
  return defaultStorageHead(config);
};

const buildDiffRecord = (height: number, puts: StorageDoc[], dels: StorageDocRef[]): StorageDiffRecord => ({
  height,
  puts: puts.map(canonicalizeStorageDoc),
  dels,
});

const materializedHeightOf = (head: StorageHead): number =>
  Math.max(0, Math.floor(Number(head.latestMaterializedHeight ?? head.latestSnapshotHeight ?? 0)));

const applyDiffToLiveDb = async (options: {
  db: RuntimeDbLike;
  diff: StorageDiffRecord;
  entityHashDocs?: Map<string, StorageEntityHashDoc>;
}): Promise<Map<string, StorageEntityHashDoc>> => {
  const preparedHashes = await prepareStorageStateHashes({
    db: options.db,
    puts: options.diff.puts,
    dels: options.diff.dels,
    ...(options.entityHashDocs ? { entityHashDocs: options.entityHashDocs } : {}),
  });
  const batch = options.db.batch();
  for (const key of preparedHashes.docDels) {
    if (typeof batch.del === 'function') batch.del(key);
  }
  for (const item of preparedHashes.docPuts) batch.put(item.key, item.value);
  for (const key of preparedHashes.merkleDels) {
    if (typeof batch.del === 'function') batch.del(key);
  }
  for (const item of preparedHashes.merklePuts) {
    batch.put(item.key, item.value);
  }
  await writeBatch(batch);
  return preparedHashes.entityHashDocs;
};

const CURRENT_RECOVERY_PREFIXES = [
  KEY_LIVE_ENTITY,
  KEY_LIVE_ACCOUNT,
  KEY_LIVE_ACCOUNT_FIELD,
  KEY_LIVE_BOOK,
  KEY_MERKLE_ROOT,
  KEY_MERKLE_BRANCH,
  KEY_MERKLE_LEAF,
] as const;

const clearCurrentRecoveryState = async (db: RuntimeDbLike): Promise<void> => {
  const fence = db.batch();
  if (typeof fence.del !== 'function') throw new Error('STORAGE_RECOVERY_DELETE_UNSUPPORTED');
  fence.del(KEY_HEAD);
  await writeBatch(fence);
  for (const prefix of CURRENT_RECOVERY_PREFIXES) {
    await deleteKeyRange(db, { prefix: Buffer.from([prefix]) });
  }
};

const storageHeadsEqual = (left: StorageHead, right: StorageHead): boolean =>
  left.schemaVersion === right.schemaVersion &&
  left.latestHeight === right.latestHeight &&
  materializedHeightOf(left) === materializedHeightOf(right) &&
  left.latestSnapshotHeight === right.latestSnapshotHeight &&
  left.snapshotPeriodFrames === right.snapshotPeriodFrames &&
  left.retainSnapshots === right.retainSnapshots &&
  left.epochMaxBytes === right.epochMaxBytes &&
  left.accountMerkleRadix === right.accountMerkleRadix &&
  left.epochReplayBytes === right.epochReplayBytes &&
  left.retainedHistoryBytes === right.retainedHistoryBytes;

const synchronizeCertifiedBoardNodes = async (
  walDb: RuntimeDbLike,
  currentDb: RuntimeDbLike,
  batch: ReturnType<RuntimeDbLike['batch']>,
): Promise<boolean> => {
  let changed = false;
  for await (const key of iterateKeys(walDb, { prefix: keyCertifiedBoardNodePrefix() })) {
    const authoritative = await walDb.get(key);
    const current = await readRawOrNull(currentDb, key);
    if (current?.equals(authoritative)) continue;
    batch.put(key, authoritative);
    changed = true;
  }
  return changed;
};

const synchronizeConsumptionNodes = async (
  walDb: RuntimeDbLike,
  currentDb: RuntimeDbLike,
  batch: ReturnType<RuntimeDbLike['batch']>,
): Promise<boolean> => {
  const states: ConsumptionAccumulatorState[] = [];
  for await (const key of iterateKeys(currentDb, { prefix: Buffer.from([KEY_LIVE_ENTITY]) })) {
    const doc = decodeValidatedBuffer(await currentDb.get(key), validateStorageEntityCoreDocValue);
    if (doc.consumptionAccumulator) states.push(doc.consumptionAccumulator);
  }
  const authoritative = new Map<string, ConsumptionNode>();
  const authoritativeValues = new Map<string, Buffer>();
  for await (const key of iterateKeys(walDb, { prefix: keyConsumptionNodePrefix() })) {
    const hash = decodeTaggedStorageHash(key, KEY_CONSUMPTION_NODE, 'STORAGE_CONSUMPTION_NODE_KEY_INVALID');
    const value = await walDb.get(key);
    const node = decodeValidatedBuffer(value, validateConsumptionNodeValue);
    const actual = hashConsumptionNode(node);
    if (actual !== hash) throw new Error(`CONSUMPTION_NODE_CORRUPT:${hash}:${actual}`);
    authoritative.set(hash, node);
    authoritativeValues.set(hash, value);
  }
  const reachable = collectReachableConsumptionNodes(authoritative, states);
  const reachableKeys = new Set<string>();
  let changed = false;
  for (const hash of reachable.keys()) {
    const key = keyConsumptionNode(hash);
    reachableKeys.add(key.toString('hex'));
    const value = authoritativeValues.get(hash);
    if (!value) throw new Error(`CONSUMPTION_NODE_MISSING:${hash}`);
    const current = await readRawOrNull(currentDb, key);
    if (current?.equals(value)) continue;
    batch.put(key, value);
    changed = true;
  }
  for await (const key of iterateKeys(currentDb, { prefix: keyConsumptionNodePrefix() })) {
    if (reachableKeys.has(key.toString('hex'))) continue;
    if (typeof batch.del !== 'function') throw new Error('STORAGE_RECOVERY_CONSUMPTION_DELETE_UNSUPPORTED');
    batch.del(key);
    changed = true;
  }
  return changed;
};

const readSnapshotReplicaStates = async (
  walDb: RuntimeDbLike,
  height: number,
  docs: readonly StorageDoc[],
): Promise<EntityState[]> => {
  const entityIds = Array.from(new Set(docs.map((doc) => doc.entityId))).sort();
  for await (const key of iterateKeys(walDb, { prefix: keySnapshotReplicaMetaPrefix(height) })) {
    if (key.byteLength !== 73) throw new Error(`STORAGE_SNAPSHOT_REPLICA_META_KEY_LENGTH_INVALID:${key.byteLength}`);
    entityIds.push(decodeEntityId(key.subarray(9, 41)));
  }
  const states: EntityState[] = [];
  for (const entityId of [...new Set(entityIds)].sort()) {
    const metas = await listStorageSnapshotReplicaMetas(walDb, height, entityId);
    for (const meta of metas) {
      if (!meta.state) throw new Error(`STORAGE_SNAPSHOT_REPLICA_STATE_MISSING:${height}:${entityId}`);
      states.push(meta.state);
    }
  }
  return states;
};

const certifiedBoardRoot = (
  state: { certifiedBoardState?: EntityState['certifiedBoardState'] },
): string | undefined =>
  state.certifiedBoardState?.boardRegistryRoot;

const collectCertifiedBoardHistoryRoots = async (
  env: RuntimeState,
  walDb: RuntimeDbLike,
): Promise<Set<string>> => {
  const roots = new Set<string>();
  const remember = (root: string | undefined): void => {
    if (root) roots.add(root);
  };
  for (const { state } of env.eReplicas.values()) remember(certifiedBoardRoot(state));
  for (const height of await listSnapshotHeights(walDb)) {
    const docs = await readSnapshotDocs(walDb, height);
    for (const doc of docs) if (doc.family === 'entity') remember(certifiedBoardRoot(doc.value));
    for (const state of await readSnapshotReplicaStates(walDb, height, docs)) remember(certifiedBoardRoot(state));
  }
  for await (const key of iterateKeys(walDb, { prefix: Buffer.from([KEY_DIFF]) })) {
    const diff = decodeValidatedBuffer(await walDb.get(key), validateStorageDiffRecordValue);
    if (diff.height !== decodeTaggedStorageHeight(key, KEY_DIFF, 'STORAGE_DIFF_KEY_INVALID')) {
      throw new Error('STORAGE_DIFF_KEY_HEIGHT_MISMATCH:scope=board-gc');
    }
    for (const doc of diff.puts) if (doc.family === 'entity') remember(certifiedBoardRoot(doc.value));
  }
  return roots;
};

const readCertifiedBoardNodes = async (
  db: RuntimeDbLike,
): Promise<{ nodes: Map<string, CertifiedBoardPatriciaNode>; bytes: Map<string, number> }> => {
  const nodes = new Map<string, CertifiedBoardPatriciaNode>();
  const bytes = new Map<string, number>();
  for await (const key of iterateKeys(db, { prefix: keyCertifiedBoardNodePrefix() })) {
    const hash = decodeTaggedStorageHash(key, KEY_CERTIFIED_BOARD_NODE, 'STORAGE_CERTIFIED_BOARD_NODE_KEY_INVALID');
    const raw = await db.get(key);
    const node = decodeValidatedBuffer(raw, validateCertifiedBoardNodeValue);
    const actual = hashCertifiedBoardNode(node);
    if (actual !== hash) throw new Error(`CERTIFIED_BOARD_NODE_CORRUPT:${hash}:${actual}`);
    nodes.set(hash, node);
    bytes.set(hash, key.byteLength + raw.byteLength);
  }
  return { nodes, bytes };
};

const deleteCertifiedBoardNodes = async (
  db: RuntimeDbLike,
  hashes: readonly string[],
  unsupportedCode: string,
): Promise<void> => {
  if (hashes.length === 0) return;
  const batch = db.batch();
  if (typeof batch.del !== 'function') throw new Error(unsupportedCode);
  for (const hash of hashes) batch.del(keyCertifiedBoardNode(hash));
  await writeBatch(batch);
};

const pruneUnreachableCertifiedBoardHistoryNodes = async (
  env: RuntimeState,
  walDb: RuntimeDbLike,
  currentDb: RuntimeDbLike,
): Promise<number> => {
  const stored = await readCertifiedBoardNodes(walDb);
  const roots = await collectCertifiedBoardHistoryRoots(env, walDb);
  const reachable = collectReachableCertifiedBoardNodes(stored.nodes, roots);
  const stale = [...stored.nodes.keys()].filter((hash) => !reachable.has(hash)).sort();
  await deleteCertifiedBoardNodes(walDb, stale, 'STORAGE_HISTORY_CERTIFIED_BOARD_GC_UNSUPPORTED');
  await deleteCertifiedBoardNodes(currentDb, stale, 'STORAGE_CURRENT_CERTIFIED_BOARD_GC_UNSUPPORTED');
  const memoryStore = getCertifiedBoardNodeStore(env);
  for (const hash of stale) memoryStore.delete(hash);
  return stale.reduce((total, hash) => total + (stored.bytes.get(hash) ?? 0), 0);
};

const pruneUnreachableConsumptionHistoryNodes = async (
  env: RuntimeState,
  walDb: RuntimeDbLike,
): Promise<number> => {
  const byRoot = new Map<string, ConsumptionAccumulatorState>();
  const remember = (state: ConsumptionAccumulatorState | undefined): void => {
    if (state) byRoot.set(`${state.root}:${state.count.toString()}`, state);
  };
  for (const state of getLiveConsumptionAccumulatorStates(env)) remember(state);
  for (const height of await listSnapshotHeights(walDb)) {
    const docs = await readSnapshotDocs(walDb, height);
    for (const doc of docs) {
      if (doc.family === 'entity') remember(doc.value.consumptionAccumulator);
    }
    for (const state of await readSnapshotReplicaStates(walDb, height, docs)) {
      remember(state.consumptionAccumulator);
    }
  }
  for await (const key of iterateKeys(walDb, { prefix: Buffer.from([KEY_DIFF]) })) {
    const diff = decodeValidatedBuffer(await walDb.get(key), validateStorageDiffRecordValue);
    if (diff.height !== decodeTaggedStorageHeight(key, KEY_DIFF, 'STORAGE_DIFF_KEY_INVALID')) {
      throw new Error('STORAGE_DIFF_KEY_HEIGHT_MISMATCH:scope=consumption-gc');
    }
    for (const doc of diff.puts) {
      if (doc.family === 'entity') remember(doc.value.consumptionAccumulator);
    }
  }

  const stored = new Map<string, ConsumptionNode>();
  const encodedBytes = new Map<string, number>();
  for await (const key of iterateKeys(walDb, { prefix: keyConsumptionNodePrefix() })) {
    const hash = decodeTaggedStorageHash(key, KEY_CONSUMPTION_NODE, 'STORAGE_CONSUMPTION_NODE_KEY_INVALID');
    const raw = await walDb.get(key);
    const node = decodeValidatedBuffer(raw, validateConsumptionNodeValue);
    const actual = hashConsumptionNode(node);
    if (actual !== hash) throw new Error(`CONSUMPTION_NODE_CORRUPT:${hash}:${actual}`);
    stored.set(hash, node);
    encodedBytes.set(hash, key.byteLength + raw.byteLength);
  }
  if (stored.size === 0) return 0;
  const reachable = collectReachableConsumptionNodes(stored, Array.from(byRoot.values()));
  const stale = Array.from(stored.keys()).filter((hash) => !reachable.has(hash)).sort();
  if (stale.length === 0) return 0;
  const batch = walDb.batch();
  if (typeof batch.del !== 'function') throw new Error('STORAGE_HISTORY_CONSUMPTION_GC_UNSUPPORTED');
  let prunedBytes = 0;
  for (const hash of stale) {
    batch.del(keyConsumptionNode(hash));
    prunedBytes += encodedBytes.get(hash) ?? 0;
  }
  await writeBatch(batch);
  return prunedBytes;
};

const synchronizeAccountJClaimNodes = async (
  walDb: RuntimeDbLike,
  currentDb: RuntimeDbLike,
  batch: ReturnType<RuntimeDbLike['batch']>,
): Promise<boolean> => {
  const states: AccountJClaimAccumulatorState[] = [];
  for await (const key of iterateKeys(currentDb, { prefix: Buffer.from([KEY_LIVE_ACCOUNT]) })) {
    const parsed = parseLiveAccountKey(key);
    const stored = await readAccountStorageLayout(currentDb, parsed.entityId, parsed.counterpartyId, key);
    if (!stored) throw new Error(`STORAGE_LIVE_ACCOUNT_MISSING:${key.toString('hex')}`);
    const doc = validateStorageAccountDocValue(stored.doc);
    states.push(doc.leftPendingJClaims, doc.rightPendingJClaims);
  }
  const authoritative = new Map<string, AccountJClaimNode>();
  const values = new Map<string, Buffer>();
  for await (const key of iterateKeys(walDb, { prefix: keyAccountJClaimNodePrefix() })) {
    const hash = decodeTaggedStorageHash(key, KEY_ACCOUNT_J_CLAIM_NODE, 'STORAGE_ACCOUNT_J_CLAIM_NODE_KEY_INVALID');
    const value = await walDb.get(key);
    const node = decodeValidatedBuffer(value, validateAccountJClaimNodeValue);
    const actual = hashAccountJClaimNode(node);
    if (actual !== hash) throw new Error(`ACCOUNT_J_CLAIM_NODE_CORRUPT:${hash}:${actual}`);
    authoritative.set(hash, node);
    values.set(hash, value);
  }
  const reachable = collectReachableAccountJClaimNodes(authoritative, states);
  const reachableKeys = new Set<string>();
  let changed = false;
  for (const hash of reachable.keys()) {
    const key = keyAccountJClaimNode(hash);
    reachableKeys.add(key.toString('hex'));
    const value = values.get(hash);
    if (!value) throw new Error(`ACCOUNT_J_CLAIM_NODE_MISSING:${hash}`);
    if ((await readRawOrNull(currentDb, key))?.equals(value)) continue;
    batch.put(key, value);
    changed = true;
  }
  for await (const key of iterateKeys(currentDb, { prefix: keyAccountJClaimNodePrefix() })) {
    if (reachableKeys.has(key.toString('hex'))) continue;
    if (typeof batch.del !== 'function') throw new Error('STORAGE_RECOVERY_ACCOUNT_J_CLAIM_DELETE_UNSUPPORTED');
    batch.del(key);
    changed = true;
  }
  return changed;
};

const pruneUnreachableAccountJClaimHistoryNodes = async (
  env: RuntimeState,
  walDb: RuntimeDbLike,
): Promise<number> => {
  const states = new Map<string, AccountJClaimAccumulatorState>();
  const remember = (state: AccountJClaimAccumulatorState): void => {
    states.set(`${state.root}:${state.count.toString()}`, state);
  };
  for (const state of getLiveAccountJClaimAccumulatorStates(env)) remember(state);
  for (const height of await listSnapshotHeights(walDb)) {
    const docs = await readSnapshotDocs(walDb, height);
    for (const doc of docs) {
      if (doc.family !== 'account') continue;
      remember(doc.value.leftPendingJClaims);
      remember(doc.value.rightPendingJClaims);
    }
    for (const state of await readSnapshotReplicaStates(walDb, height, docs)) {
      for (const account of state.accounts.values()) {
        remember(account.leftPendingJClaims);
        remember(account.rightPendingJClaims);
      }
    }
  }
  for await (const key of iterateKeys(walDb, { prefix: Buffer.from([KEY_DIFF]) })) {
    const diff = decodeValidatedBuffer(await walDb.get(key), validateStorageDiffRecordValue);
    if (diff.height !== decodeTaggedStorageHeight(key, KEY_DIFF, 'STORAGE_DIFF_KEY_INVALID')) {
      throw new Error('STORAGE_DIFF_KEY_HEIGHT_MISMATCH:scope=account-j-gc');
    }
    for (const doc of diff.puts) {
      if (doc.family !== 'account') continue;
      remember(doc.value.leftPendingJClaims);
      remember(doc.value.rightPendingJClaims);
    }
  }
  const stored = new Map<string, AccountJClaimNode>();
  const bytes = new Map<string, number>();
  for await (const key of iterateKeys(walDb, { prefix: keyAccountJClaimNodePrefix() })) {
    const hash = decodeTaggedStorageHash(key, KEY_ACCOUNT_J_CLAIM_NODE, 'STORAGE_ACCOUNT_J_CLAIM_NODE_KEY_INVALID');
    const raw = await walDb.get(key);
    const node = decodeValidatedBuffer(raw, validateAccountJClaimNodeValue);
    const actual = hashAccountJClaimNode(node);
    if (actual !== hash) throw new Error(`ACCOUNT_J_CLAIM_NODE_CORRUPT:${hash}:${actual}`);
    stored.set(hash, node);
    bytes.set(hash, key.byteLength + raw.byteLength);
  }
  if (stored.size === 0) return 0;
  const reachable = collectReachableAccountJClaimNodes(stored, [...states.values()]);
  const stale = [...stored.keys()].filter((hash) => !reachable.has(hash)).sort();
  if (stale.length === 0) return 0;
  const batch = walDb.batch();
  if (typeof batch.del !== 'function') throw new Error('STORAGE_HISTORY_ACCOUNT_J_CLAIM_GC_UNSUPPORTED');
  let prunedBytes = 0;
  for (const hash of stale) {
    batch.del(keyAccountJClaimNode(hash));
    prunedBytes += bytes.get(hash) ?? 0;
  }
  await writeBatch(batch);
  return prunedBytes;
};

export const recoverStorageDbFromHistory = async (options: {
  db: RuntimeDbLike;
  walDb: RuntimeDbLike;
  config: Required<StorageRuntimeConfig>;
  onPersistenceProgress?: StoragePersistenceProgressHook;
}): Promise<{ recovered: boolean; entityHashDocs?: Map<string, StorageEntityHashDoc> }> => {
  const walHead = await readHead(options.walDb, options.config);
  const rawCurrentHead = await readRawOrNull(options.db, KEY_HEAD);
  const currentHead = rawCurrentHead ? await readHead(options.db, options.config) : defaultStorageHead(options.config);
  const historyLatestHeight = Math.max(0, Math.floor(Number(walHead.latestHeight ?? 0)));
  const currentLatestHeight = Math.max(0, Math.floor(Number(currentHead.latestHeight ?? 0)));
  const historyMaterializedHeight = materializedHeightOf(walHead);
  const currentMaterializedHeight = materializedHeightOf(currentHead);
  const historySnapshotHeight = Math.max(0, Math.floor(Number(walHead.latestSnapshotHeight ?? 0)));
  options.onPersistenceProgress?.('recovery-heads-read');

  if (
    currentLatestHeight > historyLatestHeight ||
    currentMaterializedHeight > historyMaterializedHeight ||
    currentHead.latestSnapshotHeight > historySnapshotHeight
  ) {
    throw new Error(
      `STORAGE_CURRENT_AHEAD_OF_HISTORY: ` +
        `current=${currentLatestHeight}/${currentMaterializedHeight}/${currentHead.latestSnapshotHeight} ` +
        `history=${historyLatestHeight}/${historyMaterializedHeight}/${historySnapshotHeight}`,
    );
  }
  if (historyLatestHeight === 0) return { recovered: false };

  let entityHashDocs: Map<string, StorageEntityHashDoc> | undefined;
  const resetFromHistory = !rawCurrentHead || currentMaterializedHeight < historySnapshotHeight;
  let replayFromHeight = currentMaterializedHeight;
  let recovered = false;
  if (resetFromHistory) {
    // Validate the authoritative base before clearing the rebuildable cache.
    // This path is cold (fresh/current-lagging restore), so the full integrity
    // scan does not add per-frame cost to the normal append path.
    if (historySnapshotHeight > 0) {
      await verifyStorageSnapshotIntegrity(options.walDb, walHead);
      options.onPersistenceProgress?.('recovery-snapshot-verified');
    }
    await clearCurrentRecoveryState(options.db);
    options.onPersistenceProgress?.('recovery-current-cleared');
    replayFromHeight = 0;
    recovered = true;
    if (historySnapshotHeight > 0) {
      const snapshotDocs = await readSnapshotDocs(options.walDb, historySnapshotHeight);
      entityHashDocs = await applyDiffToLiveDb({
        db: options.db,
        diff: { height: historySnapshotHeight, puts: snapshotDocs, dels: [] },
      });
      replayFromHeight = historySnapshotHeight;
      options.onPersistenceProgress?.('recovery-snapshot-applied');
    }
  }
  for (let height = replayFromHeight + 1; height <= historyMaterializedHeight; height += 1) {
    const rawDiff = await readRawOrNull(options.walDb, keyDiff(height));
    const diff = rawDiff ? decodeValidatedBuffer(rawDiff, validateStorageDiffRecordValue) : null;
    if (!diff) throw new Error(`STORAGE_RECOVERY_DIFF_MISSING: height=${height}`);
    if (diff.height !== height) {
      throw new Error(`STORAGE_DIFF_KEY_HEIGHT_MISMATCH:key=${height}:value=${diff.height}:scope=recovery`);
    }
    entityHashDocs = await applyDiffToLiveDb({
      db: options.db,
      diff,
      ...(entityHashDocs ? { entityHashDocs } : {}),
    });
    options.onPersistenceProgress?.(`recovery-diff-applied:${height}`);
    recovered = true;
  }

  const batch = options.db.batch();
  const headChanged = !rawCurrentHead || !storageHeadsEqual(walHead, currentHead);
  // History commits before the rebuildable current projection cache.
  // The normal append path writes both DBs and never scans the content-addressed
  // DAG. Only a lagging/current-cache recovery needs to copy immutable nodes.
  const boardNodesChanged = headChanged
    ? await synchronizeCertifiedBoardNodes(options.walDb, options.db, batch)
    : false;
  options.onPersistenceProgress?.('recovery-board-nodes-synchronized');
  const consumptionNodesChanged = headChanged
    ? await synchronizeConsumptionNodes(options.walDb, options.db, batch)
    : false;
  options.onPersistenceProgress?.('recovery-consumption-nodes-synchronized');
  const accountJClaimNodesChanged = headChanged
    ? await synchronizeAccountJClaimNodes(options.walDb, options.db, batch)
    : false;
  options.onPersistenceProgress?.('recovery-account-j-nodes-synchronized');
  if (headChanged) batch.put(KEY_HEAD, encodeBuffer(walHead));
  if (boardNodesChanged || consumptionNodesChanged || accountJClaimNodesChanged || headChanged) {
    await writeBatch(batch);
    options.onPersistenceProgress?.('recovery-current-write-done');
    recovered = true;
  }
  return { recovered, ...(entityHashDocs ? { entityHashDocs } : {}) };
};

export type StorageFrameSaveResult = {
  materialized: boolean;
  materializedOverlayRecords: number;
  historyViewsMaterialized: boolean;
  staleWriterStopped?: boolean;
  latestSnapshotHeight?: number;
  retainedHistoryBytes?: number;
  snapshotCreated?: boolean;
  snapshotBytes?: number;
  historyPrunedBytes?: number;
  epochRotated?: boolean;
  epochDbRotated?: boolean;
  historyViewRetainedBytes?: number;
  historyViewPrunedBytes?: number;
  persistencePerfMs?: StoragePersistencePerf;
};

export type StoragePersistencePerf = {
  open: number;
  planning: number;
  planningStages: Record<string, number>;
  diff: number;
  prepare: number;
  prepareStages: Record<string, number>;
  authoritativeWrite: number;
  currentCacheWrite: number;
  postCommit: number;
  snapshot: number;
  total: number;
};

export const saveRuntimeFrameToStorage = async (options: {
  env: RuntimeState;
  stateHash?: string;
  currentFrameInput?: RuntimeInput;
  currentFrameOutputs?: RoutedEntityInput[];
  historyRecords?: RuntimeHistoryRecord[];
  tryOpenDb: (env: RuntimeState) => Promise<boolean>;
  getRuntimeDb: (env: RuntimeState) => RuntimeDbLike;
  tryOpenRuntimeWalDb: (env: RuntimeState) => Promise<boolean>;
  getRuntimeWalDb: (env: RuntimeState) => RuntimeDbLike;
  tryOpenHistoryViewDb: (env: RuntimeState) => Promise<boolean>;
  getHistoryViewDb: (env: RuntimeState) => RuntimeDbLike;
  rotateEpochDb?: (env: RuntimeState, snapshotHeight: number, timestamp: number) => Promise<boolean | void>;
  stopStaleWriterOnHeadAhead?: boolean;
  onPersistenceBoundary?: StoragePersistenceBoundaryHook;
  onPersistenceProgress?: StoragePersistenceProgressHook;
} & PerfDeps): Promise<StorageFrameSaveResult> => {
  const config = resolveStorageRuntimeConfig(options.env);
  if (!config.enabled) return { materialized: false, materializedOverlayRecords: 0, historyViewsMaterialized: true };

  const state = options.env.runtimeState ?? {};
  if (state.persistencePaused) return { materialized: false, materializedOverlayRecords: 0, historyViewsMaterialized: true };

  const openStartedAt = options.getPerfMs();
  const opened = await options.tryOpenDb(options.env);
  if (!opened) return { materialized: false, materializedOverlayRecords: 0, historyViewsMaterialized: false };
  const db = options.getRuntimeDb(options.env);
  const walOpened = await options.tryOpenRuntimeWalDb(options.env);
  if (!walOpened) return { materialized: false, materializedOverlayRecords: 0, historyViewsMaterialized: false };
  const walDb = options.getRuntimeWalDb(options.env);
  const recoveredStorage = await recoverStorageDbFromHistory({
    db,
    walDb,
    config,
    ...(options.onPersistenceProgress
      ? { onPersistenceProgress: options.onPersistenceProgress }
      : {}),
  });
  if (recoveredStorage.entityHashDocs) {
    state.storageEntityHashDocs = recoveredStorage.entityHashDocs;
  }
  options.onPersistenceProgress?.('opened');
  const openMs = options.getPerfMs() - openStartedAt;
  const head = await readHead(walDb, config);
  const appliedRuntimeInput = options.currentFrameInput ?? { runtimeTxs: [], entityInputs: [] };
  const snapshotDue =
    options.env.height === 1 ||
    options.env.height % config.snapshotPeriodFrames === 0;
  // Byte pressure may move the next checkpoint forward. Checking the retained
  // prefix before appending permits at most one WAL frame of overshoot while
  // keeping ordinary frames free of full-state projection work.
  const snapshotRequiredByBytes =
    head.epochReplayBytes + encodeBuffer(appliedRuntimeInput).byteLength >= config.epochMaxBytes;
  const shouldMaterialize =
    options.env.height === 1 ||
    options.env.height % config.materializePeriodFrames === 0 ||
    snapshotDue ||
    snapshotRequiredByBytes;

  const planningStartedAt = options.getPerfMs();
  const planningMarks: Record<string, number> = {};
  const checkpointPlanning = (label: string): void => {
    planningMarks[label] = options.getPerfMs() - planningStartedAt;
  };
  const frameOverlayRecords = Array.isArray(state.currentStorageOverlayMarks)
    ? state.currentStorageOverlayMarks.map((record) => ({ ...record }))
    : [];
  const overlayRecords = mergeOverlayRecordsIntoEnv(options.env, []);
  const frameTouched = storageRefsFromOverlay(frameOverlayRecords);
  checkpointPlanning('overlay');
  const checkpointedLineagePlan = shouldMaterialize
    ? buildRuntimeCheckpointLineagePlan(options.env)
    : null;
  const lineagePlan = checkpointedLineagePlan ?? buildLiveReplicaMetaPlan(options.env);
  const replicaLookup = checkpointedLineagePlan?.lookup ?? buildLiveReplicaLookup(options.env);
  checkpointPlanning('lineage');
  const planningMs = options.getPerfMs() - planningStartedAt;
  const planningStages = cumulativeMarksToDurations(planningMarks, planningMs);
  const diffBuildStartedAt = options.getPerfMs();
  const framePuts = buildDocPuts(options.env, frameTouched, replicaLookup);
  const frameBookDels = buildBookDeletionsFromOverlay(frameOverlayRecords);
  const diff = buildDiffRecord(options.env.height, framePuts, frameBookDels);
  options.onPersistenceProgress?.('diff-built');
  const diffBuildMs = options.getPerfMs() - diffBuildStartedAt;

  const writeStartedAt = options.getPerfMs();
  const prepareMarks: Record<string, number> = {};
  const checkpointPrepare = (label: string): void => {
    prepareMarks[label] = options.getPerfMs() - writeStartedAt;
  };
  if (options.stopStaleWriterOnHeadAhead) {
    if (head.latestHeight > options.env.height) {
      return {
        materialized: false,
        materializedOverlayRecords: 0,
        historyViewsMaterialized: false,
        staleWriterStopped: true,
      };
    }
    if (head.latestHeight === options.env.height) {
      const persistedFrame = await readStorageFrameRecord(walDb, options.env.height);
      if (persistedFrame) {
        return {
          materialized: false,
          materializedOverlayRecords: 0,
          historyViewsMaterialized: false,
          staleWriterStopped: true,
        };
      }
    }
  }
  if (head.latestHeight !== options.env.height - 1) {
    throw new Error(
      `STORAGE_APPEND_INVARIANT_FAILED: refusing to write frame ${options.env.height} after persisted head ${head.latestHeight}`,
    );
  }
  const previousFrame = head.latestHeight > 0 ? await readStorageFrameRecord(walDb, head.latestHeight) : null;
  if (head.latestHeight > 0 && !previousFrame) {
    throw new Error(`STORAGE_PREV_FRAME_MISSING: height=${head.latestHeight}`);
  }
  const prevFrameHash = previousFrame ? previousFrame.frameHash ?? computeStorageFrameHash(previousFrame) : ZERO_FRAME_HASH;
  options.onPersistenceProgress?.('history-read');
  checkpointPrepare('historyRead');
  const frameKey = keyFrame(options.env.height);
  const diffKey = keyDiff(options.env.height);
  const diffBuffer = encodeBuffer(diff);
  const pendingBoardNodes = state.pendingCertifiedBoardNodes instanceof Map
    ? state.pendingCertifiedBoardNodes
    : new Map<string, CertifiedBoardPatriciaNode>();
  const pendingBoardEntries: Array<{ key: Buffer; value: Buffer }> = [];
  let pendingBoardHistoryBytes = 0;
  for (const [hash, node] of pendingBoardNodes) {
    if (hashCertifiedBoardNode(node) !== hash) throw new Error(`CERTIFIED_BOARD_NODE_CORRUPT:${hash}`);
    const key = keyCertifiedBoardNode(hash);
    const value = encodeBuffer(node);
    pendingBoardEntries.push({ key, value });
    pendingBoardHistoryBytes += key.byteLength + value.byteLength;
  }
  const pendingConsumptionNodes = state.pendingConsumptionNodes ?? new Map();
  let pendingConsumptionHistoryBytes = 0;
  for (const [hash, node] of pendingConsumptionNodes) {
    if (hashConsumptionNode(node) !== hash) throw new Error(`CONSUMPTION_NODE_CORRUPT:${hash}`);
    pendingConsumptionHistoryBytes += keyConsumptionNode(hash).byteLength + encodeBuffer(node).byteLength;
  }
  const pendingAccountJClaimNodes = state.pendingAccountJClaimNodes instanceof Map
    ? state.pendingAccountJClaimNodes
    : new Map<string, AccountJClaimNode>();
  let pendingAccountJClaimHistoryBytes = 0;
  for (const [hash, node] of pendingAccountJClaimNodes) {
    if (hashAccountJClaimNode(node) !== hash) throw new Error(`ACCOUNT_J_CLAIM_NODE_CORRUPT:${hash}`);
    pendingAccountJClaimHistoryBytes += keyAccountJClaimNode(hash).byteLength + encodeBuffer(node).byteLength;
  }
  const frameLogs = Array.isArray(options.env.frameLogs) ? options.env.frameLogs.map((entry) => ({ ...entry })) : [];
  const touchedEntities = Array.from(frameTouched.touchedEntities.values()).sort();
  const touchedAccounts = Array.from(frameTouched.touchedAccounts.values())
    .filter((ref): ref is Extract<StorageDocRef, { family: 'account' }> => ref.family === 'account')
    .map((ref) => ({ entityId: ref.entityId, counterpartyId: ref.counterpartyId }));
  const touchedBookEntities = Array.from(frameTouched.touchedBookEntities.values()).sort();
  checkpointPrepare('pendingNodes');

  const materializedTouched = shouldMaterialize
    ? storageRefsFromOverlay(overlayRecords)
    : null;
  const materializedPuts = materializedTouched
    ? buildDocPuts(options.env, materializedTouched, replicaLookup)
    : [];
  const materializedDels = shouldMaterialize
    ? buildBookDeletionsFromOverlay(overlayRecords)
    : [];
  const cachedEntityHashDocs = state.storageEntityHashDocs instanceof Map
    ? state.storageEntityHashDocs as Map<string, StorageEntityHashDoc>
    : undefined;
  const preparedHashes = shouldMaterialize
    ? await prepareStorageStateHashes({
        db,
        puts: materializedPuts,
        dels: materializedDels,
        ...(cachedEntityHashDocs ? { entityHashDocs: cachedEntityHashDocs } : {}),
      })
    : null;
  options.onPersistenceProgress?.('materialized-hashes-built');
  checkpointPrepare('materializedHashes');
  const canonicalHashDue = config.canonicalHashPeriodFrames > 0 && (
    options.env.height === 1 ||
    options.env.height % config.canonicalHashPeriodFrames === 0
  );
  const runtimeMachineForPostState = buildReplayVerifiableRuntimeMachineSnapshot(options.env, {
    pendingNetworkOutputs: options.currentFrameOutputs ?? options.env.pendingNetworkOutputs ?? [],
    excludePersistedHistoryRecords: true,
  });
  const runtimeMachine = shouldMaterialize || canonicalHashDue
    ? buildDurableRuntimeMachineSnapshot(options.env, {
        pendingNetworkOutputs: options.currentFrameOutputs ?? options.env.pendingNetworkOutputs ?? [],
        excludePersistedHistoryRecords: true,
      })
    : undefined;
  checkpointPrepare('runtimeMachine');
  const runtimeStateHashes = canonicalHashDue
    ? prepareStorageCanonicalStateHashes(
        options.env,
        [],
        previousFrame,
        replicaLookup,
        runtimeMachine!,
      )
    : null;
  options.onPersistenceProgress?.('canonical-hashes-built');
  checkpointPrepare('canonicalHashes');
  const replicaMetaStateMode: StorageFrameRecord['replicaMetaStateMode'] = checkpointedLineagePlan
    ? snapshotDue || snapshotRequiredByBytes
      ? 'full'
      : 'shared-entity-state'
    : 'live-head';
  const replicaMetaCommitment = checkpointedLineagePlan
    ? buildStorageReplicaMetaCommitmentFromCheckpointPlan(options.env, lineagePlan, {
        omitIntermediateSingleSignerState: replicaMetaStateMode === 'shared-entity-state',
      })
    : buildStorageLiveReplicaMetaCommitment(options.env);
  // Full replica metadata is a checkpoint body. Ordinary WAL frames commit a
  // compact replay checksum but write only their Runtime input/state-machine
  // fence; replay deterministically regenerates the intermediate metadata.
  const replicaMetaEntries = checkpointedLineagePlan ? replicaMetaCommitment.entries : [];
  if (process.env['XLN_STORAGE_DEBUG_REPLICA_META'] === '1') {
    storageLog.info('replica_meta.debug', {
      height: options.env.height,
      digest: replicaMetaCommitment.digest,
      checkpoint: checkpointedLineagePlan !== null,
      consumptionNodes: getConsumptionNodeStore(options.env).size,
      consumptionRoots: [...options.env.eReplicas.values()].map(replica => ({
        entityId: replica.entityId,
        root: replica.state.consumptionAccumulator?.root ?? null,
        count: replica.state.consumptionAccumulator?.count?.toString() ?? null,
        mempool: replica.mempool.map(tx => tx.type === 'consensusOutput'
          ? `consensusOutput:${tx.data.origin.sourceEntityId}:${tx.data.origin.sequence.toString()}`
          : tx.type),
      })),
      heads: summarizeStorageReplicaMetaHeads(replicaMetaCommitment.entries),
    });
  }
  const liveReplicaMetaKeys = checkpointedLineagePlan
    ? new Set(replicaMetaEntries.map(entry => entry.key.toString('hex')))
    : state.storageReplicaMetaKeys instanceof Set
      ? new Set(state.storageReplicaMetaKeys)
      : new Set<string>();
  checkpointPrepare('replicaCommitment');
  const staleHistoryReplicaMetaKeys: Buffer[] = [];
  const cachedReplicaMetaKeys = state.storageReplicaMetaKeys instanceof Set
    ? state.storageReplicaMetaKeys
    : null;
  if (!checkpointedLineagePlan) {
    // Intermediate frames never rewrite/delete the checkpoint metadata.
  } else if (cachedReplicaMetaKeys) {
    for (const keyHex of cachedReplicaMetaKeys) {
      if (!liveReplicaMetaKeys.has(keyHex)) staleHistoryReplicaMetaKeys.push(Buffer.from(keyHex, 'hex'));
    }
  } else {
    // A process restart pays one authoritative scan. Subsequent appends use
    // the writer-local key set published only after both DB batches commit.
    for await (const key of iterateKeys(walDb, { prefix: keyLiveReplicaMetaPrefix() })) {
      if (!liveReplicaMetaKeys.has(key.toString('hex'))) staleHistoryReplicaMetaKeys.push(Buffer.from(key));
    }
  }
  checkpointPrepare('replicaHistoryScan');
  options.onPersistenceProgress?.('replica-metadata-read');
  const runtimeOutputRetryState = buildDurableOutputRetryState(
    options.env,
    options.currentFrameOutputs ?? [],
  );
  const durablePendingRuntimeInput = buildDurableRuntimeMempool(options.env.runtimeMempool);
  const hasDurablePendingRuntimeInput =
    durablePendingRuntimeInput.runtimeTxs.length > 0 ||
    durablePendingRuntimeInput.entityInputs.length > 0 ||
    (durablePendingRuntimeInput.jInputs?.length ?? 0) > 0 ||
    (durablePendingRuntimeInput.reliableReceipts?.length ?? 0) > 0;
  const frameRecordBase: StorageFrameRecord = {
    height: options.env.height,
    timestamp: options.env.timestamp,
    prevFrameHash,
    replicaMetaDigest: replicaMetaCommitment.digest,
    replicaMetaCheckpoint: checkpointedLineagePlan !== null,
    replicaMetaStateMode,
    postStateHash: computeStoragePostStateHash({
      height: options.env.height,
      timestamp: options.env.timestamp,
      replicaMetaDigest: replicaMetaCommitment.digest,
      runtimeMachine: runtimeMachineForPostState,
    }),
    stateHash: preparedHashes?.stateHash ?? '',
    hashMode: STORAGE_FRAME_FORMAT.hashMode,
    materializedState: shouldMaterialize,
    ...(preparedHashes ? { entityHashes: preparedHashes.entityHashes } : {}),
    ...(runtimeStateHashes ? {
      canonicalStateHash: runtimeStateHashes.canonicalStateHash,
      canonicalEntityHashes: runtimeStateHashes.canonicalEntityHashes,
      runtimeStateHash: runtimeStateHashes.canonicalStateHash,
    } : {}),
    runtimeInput: appliedRuntimeInput,
    historyRecords: (options.historyRecords ?? []).map(record => structuredClone(record)),
    activityLogs: frameLogs.map(log => structuredClone(log)),
    ...(hasDurablePendingRuntimeInput
      ? { pendingRuntimeInput: durablePendingRuntimeInput }
      : {}),
    ...(runtimeMachine ? { runtimeMachine } : {}),
    ...(options.currentFrameOutputs && options.currentFrameOutputs.length > 0
      ? { runtimeOutputs: cloneIsolatedRoutedEntityInputs(options.currentFrameOutputs) }
      : {}),
    ...(runtimeOutputRetryState.length > 0
      ? { runtimeOutputRetryState }
      : {}),
    ...(shouldMaterialize && overlayRecords.length > 0
      ? { overlayRecords: overlayRecords.map((record) => ({ ...record })) }
      : {}),
    touchedEntities,
    touchedAccounts,
    touchedBookEntities,
  };
  const frameRecord: StorageFrameRecord = {
    ...frameRecordBase,
    frameHash: computeStorageFrameHash(frameRecordBase),
  };
  const historyViewPuts = buildHistoryViewPuts({
    height: options.env.height,
    timestamp: options.env.timestamp,
    runtimeInput: appliedRuntimeInput,
    logs: frameLogs,
    touchedEntities,
    touchedAccounts,
    touchedBookEntities,
    historyRecords: options.historyRecords ?? [],
  });
  const highSignalEvents = frameLogs
    .map((entry) => (typeof entry?.message === 'string' ? entry.message : ''))
    .filter((message) =>
      message === 'HtlcReceived' ||
      message === 'HtlcFinalized' ||
      message === 'HtlcFailed' ||
      message === 'JEventReceived' ||
      message === 'JBatchQueued',
    );

  const frameBuffer = encodeBuffer(frameRecord);
  options.onPersistenceProgress?.('frame-encoded');
  checkpointPrepare('frameEncode');
  const projectedReplayBytes =
    head.retainedHistoryBytes +
    frameKey.byteLength +
    frameBuffer.byteLength +
    diffKey.byteLength +
    diffBuffer.byteLength +
    pendingBoardHistoryBytes +
    pendingConsumptionHistoryBytes +
    pendingAccountJClaimHistoryBytes;
  const projectedEpochReplayBytes =
    head.epochReplayBytes +
    frameKey.byteLength +
    frameBuffer.byteLength +
    diffKey.byteLength +
    diffBuffer.byteLength +
    pendingBoardHistoryBytes +
    pendingConsumptionHistoryBytes +
    pendingAccountJClaimHistoryBytes;
  let historyViewBytes = 0;
  let historyViewPrunedBytes = 0;
  let historyViewRetainedBytes = 0;
  let historyViewPrunedKeys = 0;
  let historyViewLatestPrunedHeight = 0;
  let historyViewsMaterialized = historyViewPuts.length === 0;
  let viewMaterializedThrough = 0;
  const walBatch = walDb.batch();
  if (staleHistoryReplicaMetaKeys.length > 0 && typeof walBatch.del !== 'function') {
    throw new Error('STORAGE_HISTORY_REPLICA_META_DELETE_UNSUPPORTED');
  }
  for (const key of staleHistoryReplicaMetaKeys) walBatch.del!(key);
  for (const { key, value } of pendingBoardEntries) {
    // Root-bearing entity docs and all newly referenced nodes share both
    // atomic batches. History is authoritative; current is a rebuildable cache.
    walBatch.put(key, value);
  }
  const safeConsumptionDeletes = getSafePendingConsumptionDeletes(options.env);
  const safeAccountJClaimDeletes = getSafePendingAccountJClaimDeletes(options.env);
  for (const [hash, node] of pendingConsumptionNodes) {
    if (hashConsumptionNode(node) !== hash) throw new Error(`CONSUMPTION_NODE_CORRUPT:${hash}`);
    walBatch.put(keyConsumptionNode(hash), encodeBuffer(node));
  }
  for (const [hash, node] of pendingAccountJClaimNodes) {
    if (hashAccountJClaimNode(node) !== hash) throw new Error(`ACCOUNT_J_CLAIM_NODE_CORRUPT:${hash}`);
    walBatch.put(keyAccountJClaimNode(hash), encodeBuffer(node));
  }
  walBatch.put(frameKey, frameBuffer);
  walBatch.put(diffKey, diffBuffer);
  options.onPersistenceProgress?.('history-view-plan-built');
  const batch = db.batch();
  for (const { key, value } of pendingBoardEntries) {
    batch.put(key, value);
  }
  if (safeConsumptionDeletes.length > 0 && typeof batch.del !== 'function') {
    throw new Error('STORAGE_CURRENT_CONSUMPTION_DELETE_UNSUPPORTED');
  }
  if (safeAccountJClaimDeletes.length > 0 && typeof batch.del !== 'function') {
    throw new Error('STORAGE_CURRENT_ACCOUNT_J_CLAIM_DELETE_UNSUPPORTED');
  }
  for (const [hash, node] of pendingConsumptionNodes) {
    batch.put(keyConsumptionNode(hash), encodeBuffer(node));
  }
  for (const hash of safeConsumptionDeletes) batch.del!(keyConsumptionNode(hash));
  for (const [hash, node] of pendingAccountJClaimNodes) {
    batch.put(keyAccountJClaimNode(hash), encodeBuffer(node));
  }
  for (const hash of safeAccountJClaimDeletes) batch.del!(keyAccountJClaimNode(hash));
  if (preparedHashes) {
    for (const key of preparedHashes.docDels) {
      if (typeof batch.del === 'function') batch.del(key);
    }
    for (const item of preparedHashes.docPuts) batch.put(item.key, item.value);
    for (const key of preparedHashes.merkleDels) {
      if (typeof batch.del === 'function') batch.del(key);
    }
    for (const item of preparedHashes.merklePuts) {
      batch.put(item.key, item.value);
    }
  }
  for (const entry of replicaMetaEntries) {
    // Replica metadata is authoritative recovery state. Keep one copy in the
    // same atomic history batch as frame, diff, and HEAD.
    walBatch.put(entry.key, entry.value);
  }

  const nextHead: StorageHead = {
    schemaVersion: STORAGE_SCHEMA_VERSION,
    latestHeight: options.env.height,
    latestMaterializedHeight: shouldMaterialize
      ? options.env.height
      : Math.max(0, Math.floor(Number(head.latestMaterializedHeight ?? 0))),
    latestSnapshotHeight: head.latestSnapshotHeight,
    snapshotPeriodFrames: config.snapshotPeriodFrames,
    retainSnapshots: config.retainSnapshots,
    epochMaxBytes: config.epochMaxBytes,
    accountMerkleRadix: config.accountMerkleRadix,
    epochReplayBytes: projectedEpochReplayBytes,
    retainedHistoryBytes: projectedReplayBytes,
  };
  walBatch.put(KEY_HEAD, encodeBuffer(nextHead));
  batch.put(KEY_HEAD, encodeBuffer(nextHead));
  checkpointPrepare('batchPlan');
  const authoritativeWriteStartedAt = options.getPerfMs();
  const prepareMs = authoritativeWriteStartedAt - writeStartedAt;
  const prepareStages = cumulativeMarksToDurations(prepareMarks, prepareMs);
  options.onPersistenceProgress?.('authoritative-write-start');
  await writeBatch(walBatch, { sync: true });
  const authoritativeWriteMs = options.getPerfMs() - authoritativeWriteStartedAt;
  options.onPersistenceProgress?.('authoritative-write-done');
  await options.onPersistenceBoundary?.('after-authoritative-history-commit');
  if (historyViewPuts.length > 0) {
    if (!(await options.tryOpenHistoryViewDb(options.env))) {
      throw new Error(`HISTORY_VIEW_DB_OPEN_FAILED:height=${options.env.height}`);
    }
    const viewDb = options.getHistoryViewDb(options.env);
    const retainedSnapshotHeights = await listSnapshotHeights(walDb);
    const reconciled = await reconcileHistoryViews({
      viewDb,
      firstWalHeight: retainedSnapshotHeights[0] ?? 1,
      latestWalHeight: options.env.height,
      readWalFrame: height => readStorageFrameRecord(walDb, height),
      config,
    });
    historyViewBytes = reconciled.writtenBytes;
    viewMaterializedThrough = reconciled.materializedThroughRuntimeHeight;
    historyViewsMaterialized = true;
    await options.onPersistenceBoundary?.('after-history-view-commit');
  }
  const currentCacheWriteStartedAt = options.getPerfMs();
  options.onPersistenceProgress?.('current-cache-write-start');
  await writeBatch(batch, { sync: false });
  const currentCacheWriteMs = options.getPerfMs() - currentCacheWriteStartedAt;
  options.onPersistenceProgress?.('current-cache-write-done');
  await options.onPersistenceBoundary?.('after-current-cache-commit');
  if (checkpointedLineagePlan) applyCertifiedEntityLineagePlan(options.env, checkpointedLineagePlan);
  if (state) {
    state.currentStorageOverlayMarks = [];
    state.pendingCertifiedBoardNodes = new Map();
    if (checkpointedLineagePlan) state.storageReplicaMetaKeys = new Set(liveReplicaMetaKeys);
    finalizePersistedConsumptionNodes(options.env, safeConsumptionDeletes);
    finalizePersistedAccountJClaimNodes(options.env, safeAccountJClaimDeletes);
  }
  if (preparedHashes) {
    state.storageEntityHashDocs = preparedHashes.entityHashDocs;
  }
  if (viewMaterializedThrough > 0) {
    const historyViewResult = await pruneHistoryViewRetention({
      db: options.getHistoryViewDb(options.env),
      height: options.env.height,
      head: await readHistoryViewHead(options.getHistoryViewDb(options.env), config),
      config,
      ...(options.onPersistenceBoundary
        ? { onPersistenceBoundary: options.onPersistenceBoundary }
        : {}),
    });
    historyViewPrunedBytes = historyViewResult.prunedBytes;
    historyViewRetainedBytes = historyViewResult.retainedBytes;
    historyViewPrunedKeys = historyViewResult.prunedKeys;
    historyViewLatestPrunedHeight = historyViewResult.latestPrunedRuntimeHeight;
    historyViewsMaterialized = true;
  }
  const postCommitMs = options.getPerfMs() - currentCacheWriteStartedAt - currentCacheWriteMs;
  const writeMs = options.getPerfMs() - writeStartedAt;

  let snapshotMs = 0;
  let snapDocs = 0;
  let snapshotBytes = 0;
  let prunedBytes = 0;
  const epochRotated = snapshotRequiredByBytes;
  let epochDbRotated = false;
  let retainedHistoryBytes = nextHead.retainedHistoryBytes;
  let latestSnapshotHeight = head.latestSnapshotHeight;

  if (snapshotDue || snapshotRequiredByBytes) {
    options.onPersistenceProgress?.('snapshot-start');
    const snapshotStartedAt = options.getPerfMs();
    const snapshotResult = await createSnapshot(
      db,
      walDb,
      options.env.height,
      options.env.timestamp,
      options.onPersistenceBoundary,
    );
    snapDocs = snapshotResult.docCount;
    snapshotBytes = snapshotResult.bytes;
    retainedHistoryBytes += snapshotBytes;
    latestSnapshotHeight = options.env.height;

    // The history head is the recovery fence. Publish it only after every
    // snapshot body and the manifest are durable, and before deleting any
    // older recovery base. A killed process therefore sees either the old
    // snapshot plus replay diffs, or the complete new snapshot, never a head
    // whose base was already pruned.
    const publishedHead = {
      ...(await readHead(walDb, config)),
      latestSnapshotHeight,
      retainedHistoryBytes,
    } satisfies StorageHead;
    await verifyStorageSnapshotIntegrity(walDb, publishedHead);
    const publishBatch = walDb.batch();
    publishBatch.put(KEY_HEAD, encodeBuffer(publishedHead));
    await writeBatch(publishBatch);
    await options.onPersistenceBoundary?.('after-snapshot-history-publish');

    prunedBytes += await maybeRotateSnapshots(
      walDb,
      config.retainSnapshots,
      options.onPersistenceBoundary,
    );
    snapshotMs = options.getPerfMs() - snapshotStartedAt;
    options.onPersistenceProgress?.('snapshot-done');
  }

  if (snapDocs > 0) {
    if (latestSnapshotHeight > 0) {
      const retainedSnapshotHeights = await listSnapshotHeights(walDb);
      const oldestRetainedSnapshotHeight = retainedSnapshotHeights[0] ?? latestSnapshotHeight;
      // Every retained snapshot advertises a usable historical base. Keep the
      // contiguous diff suffix after the oldest base; pruning through the newest
      // snapshot leaves older retained snapshots present but unreplayable.
      prunedBytes += await pruneHistoryBeforeHeight(
        walDb,
        oldestRetainedSnapshotHeight,
        options.onPersistenceBoundary,
      );
    }
    prunedBytes += await pruneUnreachableCertifiedBoardHistoryNodes(options.env, walDb, db);
    options.onPersistenceProgress?.('snapshot-board-gc-done');
    prunedBytes += await pruneUnreachableConsumptionHistoryNodes(options.env, walDb);
    options.onPersistenceProgress?.('snapshot-consumption-gc-done');
    prunedBytes += await pruneUnreachableAccountJClaimHistoryNodes(options.env, walDb);
    options.onPersistenceProgress?.('snapshot-account-j-gc-done');
  }

  retainedHistoryBytes = Math.max(0, retainedHistoryBytes - prunedBytes);

  if (snapDocs > 0 || prunedBytes > 0) {
    const latest = await readHead(walDb, config);
    const walUpdate = walDb.batch();
    const stateUpdate = db.batch();
    const updatedHead = {
      ...latest,
      latestSnapshotHeight,
      retainedHistoryBytes,
    } satisfies StorageHead;
    walUpdate.put(
      KEY_HEAD,
      encodeBuffer(updatedHead),
    );
    stateUpdate.put(KEY_HEAD, encodeBuffer(updatedHead));
    await writeBatch(walUpdate);
    await options.onPersistenceBoundary?.('after-snapshot-history-head');
    await writeBatch(stateUpdate);
    await options.onPersistenceBoundary?.('after-snapshot-current-head');
  }

  if (epochRotated && snapDocs > 0 && options.rotateEpochDb) {
    const rotated = await options.rotateEpochDb(options.env, latestSnapshotHeight, options.env.timestamp);
    epochDbRotated = rotated !== false;
    if (epochDbRotated) {
      const rotatedHistoryHead = {
        ...(await readHead(walDb, config)),
        epochReplayBytes: 0,
      } satisfies StorageHead;
      const resetEpochBatch = walDb.batch();
      resetEpochBatch.put(KEY_HEAD, encodeBuffer(rotatedHistoryHead));
      await writeBatch(resetEpochBatch, { sync: true });
      await options.onPersistenceBoundary?.('after-epoch-history-head-reset');
    }
    options.onPersistenceProgress?.('snapshot-epoch-rotation-done');
  }

  const verboseStorageLogs =
    String(process.env['XLN_STORAGE_VERBOSE'] ?? '').toLowerCase() === '1' ||
    String(process.env['XLN_STORAGE_VERBOSE'] ?? '').toLowerCase() === 'true';
  const persistencePerfMs: StoragePersistencePerf = {
    open: openMs,
    planning: planningMs,
    planningStages,
    diff: diffBuildMs,
    prepare: prepareMs,
    prepareStages,
    authoritativeWrite: authoritativeWriteMs,
    currentCacheWrite: currentCacheWriteMs,
    postCommit: postCommitMs,
    snapshot: snapshotMs,
    total: options.getPerfMs() - openStartedAt,
  };
  if (verboseStorageLogs && options.env.quietRuntimeLogs !== true) {
    storageLog.info('persist.frame', {
      runtimeId: String(options.env.runtimeId || '').slice(0, 12),
      frame: options.env.height,
      puts: diff.puts.length,
      dels: diff.dels.length,
      frameBytes: frameBuffer.byteLength,
      diffBytes: diffBuffer.byteLength,
      historyViewBytes,
      historyViewRetainedBytes,
      historyViewPrunedBytes,
      historyViewPrunedKeys,
      historyViewLatestPrunedHeight,
      snapshotBytes,
      retainedHistoryBytes,
      entities: frameTouched.touchedEntities.size,
      accounts: frameTouched.touchedAccounts.size,
      books: frameTouched.touchedBookEntities.size,
      materialized: shouldMaterialize,
      overlayRecords: overlayRecords.length,
      highSignals: highSignalEvents,
      snapDocs,
      epochRotated,
      epochDbRotated,
      perfMs: {
        open: options.formatPerfMs(persistencePerfMs.open),
        planning: options.formatPerfMs(persistencePerfMs.planning),
        planningStages: Object.fromEntries(
          Object.entries(persistencePerfMs.planningStages)
            .map(([stage, durationMs]) => [stage, options.formatPerfMs(durationMs)]),
        ),
        diff: options.formatPerfMs(persistencePerfMs.diff),
        prepare: options.formatPerfMs(persistencePerfMs.prepare),
        prepareStages: Object.fromEntries(
          Object.entries(persistencePerfMs.prepareStages)
            .map(([stage, durationMs]) => [stage, options.formatPerfMs(durationMs)]),
        ),
        authoritativeWrite: options.formatPerfMs(persistencePerfMs.authoritativeWrite),
        currentCacheWrite: options.formatPerfMs(persistencePerfMs.currentCacheWrite),
        postCommit: options.formatPerfMs(persistencePerfMs.postCommit),
        write: options.formatPerfMs(writeMs),
        snap: options.formatPerfMs(persistencePerfMs.snapshot),
        total: options.formatPerfMs(persistencePerfMs.total),
      },
    });
  }
  return {
    materialized: shouldMaterialize,
    materializedOverlayRecords: shouldMaterialize ? overlayRecords.length : 0,
    historyViewsMaterialized,
    latestSnapshotHeight,
    retainedHistoryBytes,
    snapshotCreated: snapDocs > 0,
    snapshotBytes,
    historyPrunedBytes: prunedBytes,
    epochRotated,
    epochDbRotated,
    historyViewRetainedBytes,
    historyViewPrunedBytes,
    persistencePerfMs,
  };
};
