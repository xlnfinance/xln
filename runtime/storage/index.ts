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
import type { CertifiedBoardPatriciaNode } from '../types/entity-board-registry';
import type { EntityState } from '../entity/types';
import type { RuntimeState, RoutedEntityInput, RuntimeInput, RuntimeHistoryRecord } from '../types';
import { cloneIsolatedRoutedEntityInputs } from '../runtime/input-clone';
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
} from './wal/snapshot';
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

export type StorageFrameSaveOptions = {
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
} & PerfDeps;

type StorageSnapshotLifecycleResult = {
  snapshotMs: number;
  snapshotDocs: number;
  snapshotBytes: number;
  prunedBytes: number;
  epochRotated: boolean;
  epochDbRotated: boolean;
  retainedHistoryBytes: number;
  latestSnapshotHeight: number;
};

/**
 * Snapshot publication is a second durability protocol after the frame WAL
 * commit. The new snapshot HEAD is published only after its body and manifest
 * are durable; pruning and epoch rotation happen strictly afterwards.
 */
const runStorageSnapshotLifecycle = async (
  options: StorageFrameSaveOptions,
  db: RuntimeDbLike,
  walDb: RuntimeDbLike,
  config: Required<StorageRuntimeConfig>,
  head: StorageHead,
  nextHead: StorageHead,
  snapshotDue: boolean,
  snapshotRequiredByBytes: boolean,
): Promise<StorageSnapshotLifecycleResult> => {
  let snapshotMs = 0;
  let snapshotDocs = 0;
  let snapshotBytes = 0;
  let prunedBytes = 0;
  const epochRotated = snapshotRequiredByBytes;
  let epochDbRotated = false;
  let retainedHistoryBytes = nextHead.retainedHistoryBytes;
  let latestSnapshotHeight = head.latestSnapshotHeight;

  if (snapshotDue || snapshotRequiredByBytes) {
    options.onPersistenceProgress?.('snapshot-start');
    const startedAt = options.getPerfMs();
    const snapshot = await createSnapshot(
      db,
      walDb,
      options.env.height,
      options.env.timestamp,
      options.onPersistenceBoundary,
    );
    snapshotDocs = snapshot.docCount;
    snapshotBytes = snapshot.bytes;
    retainedHistoryBytes += snapshotBytes;
    latestSnapshotHeight = options.env.height;
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
    snapshotMs = options.getPerfMs() - startedAt;
    options.onPersistenceProgress?.('snapshot-done');
  }

  if (snapshotDocs > 0) {
    const retainedSnapshots = await listSnapshotHeights(walDb);
    const oldestRetained = retainedSnapshots[0] ?? latestSnapshotHeight;
    prunedBytes += await pruneHistoryBeforeHeight(
      walDb,
      oldestRetained,
      options.onPersistenceBoundary,
    );
    prunedBytes += await pruneUnreachableCertifiedBoardHistoryNodes(
      options.env,
      walDb,
      db,
    );
    options.onPersistenceProgress?.('snapshot-board-gc-done');
    prunedBytes += await pruneUnreachableConsumptionHistoryNodes(
      options.env,
      walDb,
    );
    options.onPersistenceProgress?.('snapshot-consumption-gc-done');
    prunedBytes += await pruneUnreachableAccountJClaimHistoryNodes(
      options.env,
      walDb,
    );
    options.onPersistenceProgress?.('snapshot-account-j-gc-done');
  }

  retainedHistoryBytes = Math.max(0, retainedHistoryBytes - prunedBytes);
  if (snapshotDocs > 0 || prunedBytes > 0) {
    const latest = await readHead(walDb, config);
    const updatedHead = {
      ...latest,
      latestSnapshotHeight,
      retainedHistoryBytes,
    } satisfies StorageHead;
    const walUpdate = walDb.batch();
    walUpdate.put(KEY_HEAD, encodeBuffer(updatedHead));
    await writeBatch(walUpdate);
    await options.onPersistenceBoundary?.('after-snapshot-history-head');
    const stateUpdate = db.batch();
    stateUpdate.put(KEY_HEAD, encodeBuffer(updatedHead));
    await writeBatch(stateUpdate);
    await options.onPersistenceBoundary?.('after-snapshot-current-head');
  }

  if (epochRotated && snapshotDocs > 0 && options.rotateEpochDb) {
    const rotated = await options.rotateEpochDb(
      options.env,
      latestSnapshotHeight,
      options.env.timestamp,
    );
    epochDbRotated = rotated !== false;
    if (epochDbRotated) {
      const rotatedHead = {
        ...(await readHead(walDb, config)),
        epochReplayBytes: 0,
      } satisfies StorageHead;
      const batch = walDb.batch();
      batch.put(KEY_HEAD, encodeBuffer(rotatedHead));
      await writeBatch(batch, { sync: true });
      await options.onPersistenceBoundary?.('after-epoch-history-head-reset');
    }
    options.onPersistenceProgress?.('snapshot-epoch-rotation-done');
  }

  return {
    snapshotMs,
    snapshotDocs,
    snapshotBytes,
    prunedBytes,
    epochRotated,
    epochDbRotated,
    retainedHistoryBytes,
    latestSnapshotHeight,
  };
};

/**
 * Resolve databases and build the deterministic frame diff before any write.
 * Everything returned here is still pre-commit and may be discarded safely.
 */
const prepareStorageFrameSave = async (options: StorageFrameSaveOptions) => {
  const config = resolveStorageRuntimeConfig(options.env);
  if (!config.enabled || options.env.runtimeState?.persistencePaused) {
    return {
      skipped: {
        materialized: false,
        materializedOverlayRecords: 0,
        historyViewsMaterialized: true,
      } satisfies StorageFrameSaveResult,
    };
  }
  const openStartedAt = options.getPerfMs();
  if (!(await options.tryOpenDb(options.env))) {
    throw new Error('STORAGE_CURRENT_DB_UNAVAILABLE');
  }
  const db = options.getRuntimeDb(options.env);
  if (!(await options.tryOpenRuntimeWalDb(options.env))) {
    throw new Error('STORAGE_RUNTIME_WAL_UNAVAILABLE');
  }
  const walDb = options.getRuntimeWalDb(options.env);
  const recovered = await recoverStorageDbFromHistory({
    db,
    walDb,
    config,
    ...(options.onPersistenceProgress
      ? { onPersistenceProgress: options.onPersistenceProgress }
      : {}),
  });
  const state = options.env.runtimeState ?? {};
  if (recovered.entityHashDocs) {
    state.storageEntityHashDocs = recovered.entityHashDocs;
  }
  options.onPersistenceProgress?.('opened');
  const openMs = options.getPerfMs() - openStartedAt;
  const head = await readHead(walDb, config);
  const appliedRuntimeInput =
    options.currentFrameInput ?? { runtimeTxs: [], entityInputs: [] };
  const snapshotDue =
    options.env.height === 1 ||
    options.env.height % config.snapshotPeriodFrames === 0;
  const snapshotRequiredByBytes =
    head.epochReplayBytes + encodeBuffer(appliedRuntimeInput).byteLength >=
    config.epochMaxBytes;
  const shouldMaterialize =
    options.env.height === 1 ||
    options.env.height % config.materializePeriodFrames === 0 ||
    snapshotDue ||
    snapshotRequiredByBytes;

  const planningStartedAt = options.getPerfMs();
  const planningMarks: Record<string, number> = {};
  const checkpoint = (label: string): void => {
    planningMarks[label] = options.getPerfMs() - planningStartedAt;
  };
  const frameOverlayRecords = Array.isArray(state.currentStorageOverlayMarks)
    ? state.currentStorageOverlayMarks.map(record => ({ ...record }))
    : [];
  const overlayRecords = mergeOverlayRecordsIntoEnv(options.env, []);
  const frameTouched = storageRefsFromOverlay(frameOverlayRecords);
  checkpoint('overlay');
  const checkpointedLineagePlan = shouldMaterialize
    ? buildRuntimeCheckpointLineagePlan(options.env)
    : null;
  const lineagePlan =
    checkpointedLineagePlan ?? buildLiveReplicaMetaPlan(options.env);
  const replicaLookup =
    checkpointedLineagePlan?.lookup ?? buildLiveReplicaLookup(options.env);
  checkpoint('lineage');
  const planningMs = options.getPerfMs() - planningStartedAt;
  const planningStages = cumulativeMarksToDurations(planningMarks, planningMs);
  const diffStartedAt = options.getPerfMs();
  const framePuts = buildDocPuts(options.env, frameTouched, replicaLookup);
  const frameBookDels = buildBookDeletionsFromOverlay(frameOverlayRecords);
  const diff = buildDiffRecord(options.env.height, framePuts, frameBookDels);
  options.onPersistenceProgress?.('diff-built');

  return {
    config,
    state,
    db,
    walDb,
    head,
    appliedRuntimeInput,
    snapshotDue,
    snapshotRequiredByBytes,
    shouldMaterialize,
    openStartedAt,
    openMs,
    planningMs,
    planningStages,
    diffBuildMs: options.getPerfMs() - diffStartedAt,
    overlayRecords,
    frameTouched,
    checkpointedLineagePlan,
    lineagePlan,
    replicaLookup,
    diff,
  };
};

type PreparedStorageFrameSave = Exclude<
  Awaited<ReturnType<typeof prepareStorageFrameSave>>,
  { skipped: StorageFrameSaveResult }
>;

const resolveStorageAppendPosition = async (
  options: StorageFrameSaveOptions,
  walDb: RuntimeDbLike,
  head: StorageHead,
): Promise<
  | { staleWriterStopped: true }
  | { previousFrame: StorageFrameRecord | null; prevFrameHash: string }
> => {
  if (options.stopStaleWriterOnHeadAhead) {
    if (head.latestHeight > options.env.height) {
      return { staleWriterStopped: true };
    }
    if (head.latestHeight === options.env.height) {
      const persisted = await readStorageFrameRecord(
        walDb,
        options.env.height,
      );
      if (persisted) return { staleWriterStopped: true };
    }
  }
  if (head.latestHeight !== options.env.height - 1) {
    throw new Error(
      `STORAGE_APPEND_INVARIANT_FAILED: refusing to write frame ` +
      `${options.env.height} after persisted head ${head.latestHeight}`,
    );
  }
  const previous =
    head.latestHeight > 0
      ? await readStorageFrameRecord(walDb, head.latestHeight)
      : null;
  if (head.latestHeight > 0 && !previous) {
    throw new Error(`STORAGE_PREV_FRAME_MISSING: height=${head.latestHeight}`);
  }
  return {
    previousFrame: previous,
    prevFrameHash: previous
      ? previous.frameHash ?? computeStorageFrameHash(previous)
      : ZERO_FRAME_HASH,
  };
};

const collectPendingStorageNodes = (env: RuntimeState) => {
  const state = env.runtimeState ?? {};
  const boardNodes =
    state.pendingCertifiedBoardNodes instanceof Map
      ? state.pendingCertifiedBoardNodes
      : new Map<string, CertifiedBoardPatriciaNode>();
  const boardEntries: Array<{ key: Buffer; value: Buffer }> = [];
  let boardHistoryBytes = 0;
  for (const [hash, node] of boardNodes) {
    if (hashCertifiedBoardNode(node) !== hash) {
      throw new Error(`CERTIFIED_BOARD_NODE_CORRUPT:${hash}`);
    }
    const key = keyCertifiedBoardNode(hash);
    const value = encodeBuffer(node);
    boardEntries.push({ key, value });
    boardHistoryBytes += key.byteLength + value.byteLength;
  }

  const consumptionNodes = state.pendingConsumptionNodes ?? new Map();
  let consumptionHistoryBytes = 0;
  for (const [hash, node] of consumptionNodes) {
    if (hashConsumptionNode(node) !== hash) {
      throw new Error(`CONSUMPTION_NODE_CORRUPT:${hash}`);
    }
    consumptionHistoryBytes +=
      keyConsumptionNode(hash).byteLength + encodeBuffer(node).byteLength;
  }

  const accountJClaimNodes =
    state.pendingAccountJClaimNodes instanceof Map
      ? state.pendingAccountJClaimNodes
      : new Map<string, AccountJClaimNode>();
  let accountJClaimHistoryBytes = 0;
  for (const [hash, node] of accountJClaimNodes) {
    if (hashAccountJClaimNode(node) !== hash) {
      throw new Error(`ACCOUNT_J_CLAIM_NODE_CORRUPT:${hash}`);
    }
    accountJClaimHistoryBytes +=
      keyAccountJClaimNode(hash).byteLength + encodeBuffer(node).byteLength;
  }
  return {
    boardEntries,
    boardHistoryBytes,
    consumptionNodes,
    consumptionHistoryBytes,
    accountJClaimNodes,
    accountJClaimHistoryBytes,
  };
};

const logReplicaMetaDebug = (
  env: RuntimeState,
  checkpointed: boolean,
  commitment: ReturnType<typeof buildStorageLiveReplicaMetaCommitment>,
): void => {
  if (process.env['XLN_STORAGE_DEBUG_REPLICA_META'] !== '1') return;
  storageLog.info('replica_meta.debug', {
    height: env.height,
    digest: commitment.digest,
    checkpoint: checkpointed,
    consumptionNodes: getConsumptionNodeStore(env).size,
    consumptionRoots: [...env.eReplicas.values()].map(replica => ({
      entityId: replica.entityId,
      root: replica.state.consumptionAccumulator?.root ?? null,
      count: replica.state.consumptionAccumulator?.count?.toString() ?? null,
      mempool: replica.mempool.map(tx =>
        tx.type === 'consensusOutput'
          ? `consensusOutput:${tx.data.origin.sourceEntityId}:` +
            tx.data.origin.sequence.toString()
          : tx.type,
      ),
    })),
    heads: summarizeStorageReplicaMetaHeads(commitment.entries),
  });
};

const prepareStorageStateCommitments = async (
  options: StorageFrameSaveOptions,
  prepared: PreparedStorageFrameSave,
  previousFrame: StorageFrameRecord | null,
  checkpoint: (label: string) => void,
) => {
  const {
    db,
    walDb,
    state,
    config,
    shouldMaterialize,
    snapshotDue,
    snapshotRequiredByBytes,
    overlayRecords,
    checkpointedLineagePlan,
    lineagePlan,
    replicaLookup,
  } = prepared;
  const materializedTouched = shouldMaterialize
    ? storageRefsFromOverlay(overlayRecords)
    : null;
  const materializedPuts = materializedTouched
    ? buildDocPuts(options.env, materializedTouched, replicaLookup)
    : [];
  const materializedDels = shouldMaterialize
    ? buildBookDeletionsFromOverlay(overlayRecords)
    : [];
  const cachedEntityHashDocs =
    state.storageEntityHashDocs instanceof Map
      ? state.storageEntityHashDocs as Map<string, StorageEntityHashDoc>
      : undefined;
  const preparedHashes = shouldMaterialize
    ? await prepareStorageStateHashes({
        db,
        puts: materializedPuts,
        dels: materializedDels,
        ...(cachedEntityHashDocs
          ? { entityHashDocs: cachedEntityHashDocs }
          : {}),
      })
    : null;
  options.onPersistenceProgress?.('materialized-hashes-built');
  checkpoint('materializedHashes');

  const canonicalHashDue =
    config.canonicalHashPeriodFrames > 0 &&
    (options.env.height === 1 ||
      options.env.height % config.canonicalHashPeriodFrames === 0);
  const pendingNetworkOutputs =
    options.currentFrameOutputs ?? options.env.pendingNetworkOutputs ?? [];
  const runtimeMachineForPostState =
    buildReplayVerifiableRuntimeMachineSnapshot(options.env, {
      pendingNetworkOutputs,
      excludePersistedHistoryRecords: true,
    });
  const runtimeMachine = shouldMaterialize || canonicalHashDue
    ? buildDurableRuntimeMachineSnapshot(options.env, {
        pendingNetworkOutputs,
        excludePersistedHistoryRecords: true,
      })
    : undefined;
  checkpoint('runtimeMachine');
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
  checkpoint('canonicalHashes');

  const replicaMetaStateMode: StorageFrameRecord['replicaMetaStateMode'] =
    checkpointedLineagePlan
      ? snapshotDue || snapshotRequiredByBytes
        ? 'full'
        : 'shared-entity-state'
      : 'live-head';
  const replicaMetaCommitment = checkpointedLineagePlan
    ? buildStorageReplicaMetaCommitmentFromCheckpointPlan(
        options.env,
        lineagePlan,
        {
          omitIntermediateSingleSignerState:
            replicaMetaStateMode === 'shared-entity-state',
        },
      )
    : buildStorageLiveReplicaMetaCommitment(options.env);
  const replicaMetaEntries = checkpointedLineagePlan
    ? replicaMetaCommitment.entries
    : [];
  logReplicaMetaDebug(
    options.env,
    checkpointedLineagePlan !== null,
    replicaMetaCommitment,
  );
  const liveReplicaMetaKeys = checkpointedLineagePlan
    ? new Set(replicaMetaEntries.map(entry => entry.key.toString('hex')))
    : state.storageReplicaMetaKeys instanceof Set
      ? new Set(state.storageReplicaMetaKeys)
      : new Set<string>();
  checkpoint('replicaCommitment');
  const staleReplicaMetaKeys: Buffer[] = [];
  const cachedReplicaMetaKeys =
    state.storageReplicaMetaKeys instanceof Set
      ? state.storageReplicaMetaKeys
      : null;
  if (checkpointedLineagePlan && cachedReplicaMetaKeys) {
    for (const keyHex of cachedReplicaMetaKeys) {
      if (!liveReplicaMetaKeys.has(keyHex)) {
        staleReplicaMetaKeys.push(Buffer.from(keyHex, 'hex'));
      }
    }
  } else if (checkpointedLineagePlan) {
    for await (
      const key of iterateKeys(walDb, {
        prefix: keyLiveReplicaMetaPrefix(),
      })
    ) {
      if (!liveReplicaMetaKeys.has(key.toString('hex'))) {
        staleReplicaMetaKeys.push(Buffer.from(key));
      }
    }
  }
  checkpoint('replicaHistoryScan');
  options.onPersistenceProgress?.('replica-metadata-read');
  return {
    preparedHashes,
    runtimeMachineForPostState,
    runtimeMachine,
    runtimeStateHashes,
    replicaMetaStateMode,
    replicaMetaCommitment,
    replicaMetaEntries,
    liveReplicaMetaKeys,
    staleReplicaMetaKeys,
  };
};

type PreparedStorageCommitments = Awaited<
  ReturnType<typeof prepareStorageStateCommitments>
>;

const buildStorageFrameRecordPlan = (
  options: StorageFrameSaveOptions,
  prepared: PreparedStorageFrameSave,
  commitments: PreparedStorageCommitments,
  pendingNodes: ReturnType<typeof collectPendingStorageNodes>,
  prevFrameHash: string,
) => {
  const {
    head,
    diff,
    appliedRuntimeInput,
    shouldMaterialize,
    overlayRecords,
    frameTouched,
    checkpointedLineagePlan,
  } = prepared;
  const frameLogs = Array.isArray(options.env.frameLogs)
    ? options.env.frameLogs.map(entry => ({ ...entry }))
    : [];
  const touchedEntities = [...frameTouched.touchedEntities.values()].sort();
  const touchedAccounts = [...frameTouched.touchedAccounts.values()]
    .filter(
      (ref): ref is Extract<StorageDocRef, { family: 'account' }> =>
        ref.family === 'account',
    )
    .map(ref => ({
      entityId: ref.entityId,
      counterpartyId: ref.counterpartyId,
    }));
  const touchedBookEntities =
    [...frameTouched.touchedBookEntities.values()].sort();
  const durablePendingInput =
    buildDurableRuntimeMempool(options.env.runtimeMempool);
  const hasPendingInput =
    durablePendingInput.runtimeTxs.length > 0 ||
    durablePendingInput.entityInputs.length > 0 ||
    (durablePendingInput.jInputs?.length ?? 0) > 0 ||
    (durablePendingInput.reliableReceipts?.length ?? 0) > 0;
  const retryState = buildDurableOutputRetryState(
    options.env,
    options.currentFrameOutputs ?? [],
  );
  const frameBase: StorageFrameRecord = {
    height: options.env.height,
    timestamp: options.env.timestamp,
    prevFrameHash,
    replicaMetaDigest: commitments.replicaMetaCommitment.digest,
    replicaMetaCheckpoint: checkpointedLineagePlan !== null,
    replicaMetaStateMode: commitments.replicaMetaStateMode,
    postStateHash: computeStoragePostStateHash({
      height: options.env.height,
      timestamp: options.env.timestamp,
      replicaMetaDigest: commitments.replicaMetaCommitment.digest,
      runtimeMachine: commitments.runtimeMachineForPostState,
    }),
    stateHash: commitments.preparedHashes?.stateHash ?? '',
    hashMode: STORAGE_FRAME_FORMAT.hashMode,
    materializedState: shouldMaterialize,
    ...(commitments.preparedHashes
      ? { entityHashes: commitments.preparedHashes.entityHashes }
      : {}),
    ...(commitments.runtimeStateHashes
      ? {
          canonicalStateHash:
            commitments.runtimeStateHashes.canonicalStateHash,
          canonicalEntityHashes:
            commitments.runtimeStateHashes.canonicalEntityHashes,
          runtimeStateHash:
            commitments.runtimeStateHashes.canonicalStateHash,
        }
      : {}),
    runtimeInput: appliedRuntimeInput,
    historyRecords: (options.historyRecords ?? []).map(record =>
      structuredClone(record),
    ),
    activityLogs: frameLogs.map(log => structuredClone(log)),
    ...(hasPendingInput ? { pendingRuntimeInput: durablePendingInput } : {}),
    ...(commitments.runtimeMachine
      ? { runtimeMachine: commitments.runtimeMachine }
      : {}),
    ...(options.currentFrameOutputs?.length
      ? {
          runtimeOutputs: cloneIsolatedRoutedEntityInputs(
            options.currentFrameOutputs,
          ),
        }
      : {}),
    ...(retryState.length > 0 ? { runtimeOutputRetryState: retryState } : {}),
    ...(shouldMaterialize && overlayRecords.length > 0
      ? { overlayRecords: overlayRecords.map(record => ({ ...record })) }
      : {}),
    touchedEntities,
    touchedAccounts,
    touchedBookEntities,
  };
  const frameRecord = {
    ...frameBase,
    frameHash: computeStorageFrameHash(frameBase),
  } satisfies StorageFrameRecord;
  const frameKey = keyFrame(options.env.height);
  const diffKey = keyDiff(options.env.height);
  const frameBuffer = encodeBuffer(frameRecord);
  const diffBuffer = encodeBuffer(diff);
  const nodeBytes =
    pendingNodes.boardHistoryBytes +
    pendingNodes.consumptionHistoryBytes +
    pendingNodes.accountJClaimHistoryBytes;
  const frameBytes =
    frameKey.byteLength +
    frameBuffer.byteLength +
    diffKey.byteLength +
    diffBuffer.byteLength +
    nodeBytes;
  return {
    frameKey,
    diffKey,
    frameBuffer,
    diffBuffer,
    frameLogs,
    touchedEntities,
    touchedAccounts,
    touchedBookEntities,
    historyViewPuts: buildHistoryViewPuts({
      height: options.env.height,
      timestamp: options.env.timestamp,
      runtimeInput: appliedRuntimeInput,
      logs: frameLogs,
      touchedEntities,
      touchedAccounts,
      touchedBookEntities,
      historyRecords: options.historyRecords ?? [],
    }),
    highSignalEvents: frameLogs
      .map(entry => typeof entry?.message === 'string' ? entry.message : '')
      .filter(message => [
        'HtlcReceived',
        'HtlcFinalized',
        'HtlcFailed',
        'JEventReceived',
        'JBatchQueued',
      ].includes(message)),
    projectedReplayBytes: head.retainedHistoryBytes + frameBytes,
    projectedEpochReplayBytes: head.epochReplayBytes + frameBytes,
  };
};

type StorageFrameRecordPlan = ReturnType<typeof buildStorageFrameRecordPlan>;

const buildStorageCommitBatches = (
  options: StorageFrameSaveOptions,
  prepared: PreparedStorageFrameSave,
  commitments: PreparedStorageCommitments,
  pendingNodes: ReturnType<typeof collectPendingStorageNodes>,
  frame: StorageFrameRecordPlan,
) => {
  const walBatch = prepared.walDb.batch();
  if (
    commitments.staleReplicaMetaKeys.length > 0 &&
    typeof walBatch.del !== 'function'
  ) {
    throw new Error('STORAGE_HISTORY_REPLICA_META_DELETE_UNSUPPORTED');
  }
  for (const key of commitments.staleReplicaMetaKeys) walBatch.del!(key);
  for (const entry of pendingNodes.boardEntries) {
    walBatch.put(entry.key, entry.value);
  }
  for (const [hash, node] of pendingNodes.consumptionNodes) {
    walBatch.put(keyConsumptionNode(hash), encodeBuffer(node));
  }
  for (const [hash, node] of pendingNodes.accountJClaimNodes) {
    walBatch.put(keyAccountJClaimNode(hash), encodeBuffer(node));
  }
  walBatch.put(frame.frameKey, frame.frameBuffer);
  walBatch.put(frame.diffKey, frame.diffBuffer);
  for (const entry of commitments.replicaMetaEntries) {
    // Recovery metadata shares the authoritative batch with frame, diff, HEAD.
    walBatch.put(entry.key, entry.value);
  }

  const currentBatch = prepared.db.batch();
  for (const entry of pendingNodes.boardEntries) {
    currentBatch.put(entry.key, entry.value);
  }
  const safeConsumptionDeletes =
    getSafePendingConsumptionDeletes(options.env);
  const safeAccountJClaimDeletes =
    getSafePendingAccountJClaimDeletes(options.env);
  if (
    safeConsumptionDeletes.length > 0 &&
    typeof currentBatch.del !== 'function'
  ) {
    throw new Error('STORAGE_CURRENT_CONSUMPTION_DELETE_UNSUPPORTED');
  }
  if (
    safeAccountJClaimDeletes.length > 0 &&
    typeof currentBatch.del !== 'function'
  ) {
    throw new Error('STORAGE_CURRENT_ACCOUNT_J_CLAIM_DELETE_UNSUPPORTED');
  }
  for (const [hash, node] of pendingNodes.consumptionNodes) {
    currentBatch.put(keyConsumptionNode(hash), encodeBuffer(node));
  }
  for (const hash of safeConsumptionDeletes) {
    currentBatch.del!(keyConsumptionNode(hash));
  }
  for (const [hash, node] of pendingNodes.accountJClaimNodes) {
    currentBatch.put(keyAccountJClaimNode(hash), encodeBuffer(node));
  }
  for (const hash of safeAccountJClaimDeletes) {
    currentBatch.del!(keyAccountJClaimNode(hash));
  }
  const hashes = commitments.preparedHashes;
  if (hashes) {
    for (const key of hashes.docDels) currentBatch.del?.(key);
    for (const item of hashes.docPuts) currentBatch.put(item.key, item.value);
    for (const key of hashes.merkleDels) currentBatch.del?.(key);
    for (const item of hashes.merklePuts) {
      currentBatch.put(item.key, item.value);
    }
  }

  const nextHead: StorageHead = {
    schemaVersion: STORAGE_SCHEMA_VERSION,
    latestHeight: options.env.height,
    latestMaterializedHeight: prepared.shouldMaterialize
      ? options.env.height
      : Math.max(
          0,
          Math.floor(Number(prepared.head.latestMaterializedHeight ?? 0)),
        ),
    latestSnapshotHeight: prepared.head.latestSnapshotHeight,
    snapshotPeriodFrames: prepared.config.snapshotPeriodFrames,
    retainSnapshots: prepared.config.retainSnapshots,
    epochMaxBytes: prepared.config.epochMaxBytes,
    accountMerkleRadix: prepared.config.accountMerkleRadix,
    epochReplayBytes: frame.projectedEpochReplayBytes,
    retainedHistoryBytes: frame.projectedReplayBytes,
  };
  const encodedHead = encodeBuffer(nextHead);
  walBatch.put(KEY_HEAD, encodedHead);
  currentBatch.put(KEY_HEAD, encodedHead);
  options.onPersistenceProgress?.('history-view-plan-built');
  return {
    walBatch,
    currentBatch,
    nextHead,
    safeConsumptionDeletes,
    safeAccountJClaimDeletes,
  };
};

type StorageCommitBatches = ReturnType<typeof buildStorageCommitBatches>;

const commitStorageFrame = async (
  options: StorageFrameSaveOptions,
  prepared: PreparedStorageFrameSave,
  commitments: PreparedStorageCommitments,
  frame: StorageFrameRecordPlan,
  batches: StorageCommitBatches,
  writeStartedAt: number,
  prepareMarks: Record<string, number>,
) => {
  const prepareStartedAt = options.getPerfMs();
  const prepareMs = prepareStartedAt - writeStartedAt;
  const prepareStages = cumulativeMarksToDurations(prepareMarks, prepareMs);
  options.onPersistenceProgress?.('authoritative-write-start');
  // This synced WAL batch is the only frame commit point. Everything before it
  // is discardable planning; everything after it must recover forward.
  await writeBatch(batches.walBatch, { sync: true });
  const authoritativeWriteMs = options.getPerfMs() - prepareStartedAt;
  options.onPersistenceProgress?.('authoritative-write-done');
  await options.onPersistenceBoundary?.('after-authoritative-history-commit');

  let historyViewBytes = 0;
  let historyViewsMaterialized = frame.historyViewPuts.length === 0;
  let viewMaterializedThrough = 0;
  if (frame.historyViewPuts.length > 0) {
    if (!(await options.tryOpenHistoryViewDb(options.env))) {
      throw new Error(
        `HISTORY_VIEW_DB_OPEN_FAILED:height=${options.env.height}`,
      );
    }
    const snapshots = await listSnapshotHeights(prepared.walDb);
    const reconciled = await reconcileHistoryViews({
      viewDb: options.getHistoryViewDb(options.env),
      firstWalHeight: snapshots[0] ?? 1,
      latestWalHeight: options.env.height,
      readWalFrame: height =>
        readStorageFrameRecord(prepared.walDb, height),
      config: prepared.config,
    });
    historyViewBytes = reconciled.writtenBytes;
    viewMaterializedThrough =
      reconciled.materializedThroughRuntimeHeight;
    historyViewsMaterialized = true;
    await options.onPersistenceBoundary?.('after-history-view-commit');
  }

  const currentWriteStartedAt = options.getPerfMs();
  options.onPersistenceProgress?.('current-cache-write-start');
  await writeBatch(batches.currentBatch, { sync: false });
  const currentCacheWriteMs = options.getPerfMs() - currentWriteStartedAt;
  options.onPersistenceProgress?.('current-cache-write-done');
  await options.onPersistenceBoundary?.('after-current-cache-commit');
  if (prepared.checkpointedLineagePlan) {
    applyCertifiedEntityLineagePlan(
      options.env,
      prepared.checkpointedLineagePlan,
    );
  }
  const state = prepared.state;
  state.currentStorageOverlayMarks = [];
  state.pendingCertifiedBoardNodes = new Map();
  if (prepared.checkpointedLineagePlan) {
    state.storageReplicaMetaKeys = new Set(commitments.liveReplicaMetaKeys);
  }
  finalizePersistedConsumptionNodes(
    options.env,
    batches.safeConsumptionDeletes,
  );
  finalizePersistedAccountJClaimNodes(
    options.env,
    batches.safeAccountJClaimDeletes,
  );
  if (commitments.preparedHashes) {
    state.storageEntityHashDocs =
      commitments.preparedHashes.entityHashDocs;
  }

  let historyViewPrunedBytes = 0;
  let historyViewRetainedBytes = 0;
  let historyViewPrunedKeys = 0;
  let historyViewLatestPrunedHeight = 0;
  if (viewMaterializedThrough > 0) {
    const viewDb = options.getHistoryViewDb(options.env);
    const result = await pruneHistoryViewRetention({
      db: viewDb,
      height: options.env.height,
      head: await readHistoryViewHead(viewDb, prepared.config),
      config: prepared.config,
      ...(options.onPersistenceBoundary
        ? { onPersistenceBoundary: options.onPersistenceBoundary }
        : {}),
    });
    historyViewPrunedBytes = result.prunedBytes;
    historyViewRetainedBytes = result.retainedBytes;
    historyViewPrunedKeys = result.prunedKeys;
    historyViewLatestPrunedHeight = result.latestPrunedRuntimeHeight;
    historyViewsMaterialized = true;
  }
  const postCommitMs =
    options.getPerfMs() - currentWriteStartedAt - currentCacheWriteMs;
  return {
    prepareMs,
    prepareStages,
    authoritativeWriteMs,
    currentCacheWriteMs,
    postCommitMs,
    writeMs: options.getPerfMs() - writeStartedAt,
    historyViewBytes,
    historyViewsMaterialized,
    historyViewPrunedBytes,
    historyViewRetainedBytes,
    historyViewPrunedKeys,
    historyViewLatestPrunedHeight,
  };
};

type CommittedStorageFrame = Awaited<ReturnType<typeof commitStorageFrame>>;

const finishStorageFrameSave = (
  options: StorageFrameSaveOptions,
  prepared: PreparedStorageFrameSave,
  frame: StorageFrameRecordPlan,
  committed: CommittedStorageFrame,
  snapshot: StorageSnapshotLifecycleResult,
): StorageFrameSaveResult => {
  const persistencePerfMs: StoragePersistencePerf = {
    open: prepared.openMs,
    planning: prepared.planningMs,
    planningStages: prepared.planningStages,
    diff: prepared.diffBuildMs,
    prepare: committed.prepareMs,
    prepareStages: committed.prepareStages,
    authoritativeWrite: committed.authoritativeWriteMs,
    currentCacheWrite: committed.currentCacheWriteMs,
    postCommit: committed.postCommitMs,
    snapshot: snapshot.snapshotMs,
    total: options.getPerfMs() - prepared.openStartedAt,
  };
  const verbose =
    ['1', 'true'].includes(
      String(process.env['XLN_STORAGE_VERBOSE'] ?? '').toLowerCase(),
    ) && options.env.quietRuntimeLogs !== true;
  if (verbose) {
    storageLog.info('persist.frame', {
      runtimeId: String(options.env.runtimeId || '').slice(0, 12),
      frame: options.env.height,
      puts: prepared.diff.puts.length,
      dels: prepared.diff.dels.length,
      frameBytes: frame.frameBuffer.byteLength,
      diffBytes: frame.diffBuffer.byteLength,
      historyViewBytes: committed.historyViewBytes,
      historyViewRetainedBytes: committed.historyViewRetainedBytes,
      historyViewPrunedBytes: committed.historyViewPrunedBytes,
      historyViewPrunedKeys: committed.historyViewPrunedKeys,
      historyViewLatestPrunedHeight:
        committed.historyViewLatestPrunedHeight,
      snapshotBytes: snapshot.snapshotBytes,
      retainedHistoryBytes: snapshot.retainedHistoryBytes,
      entities: prepared.frameTouched.touchedEntities.size,
      accounts: prepared.frameTouched.touchedAccounts.size,
      books: prepared.frameTouched.touchedBookEntities.size,
      materialized: prepared.shouldMaterialize,
      overlayRecords: prepared.overlayRecords.length,
      highSignals: frame.highSignalEvents,
      snapDocs: snapshot.snapshotDocs,
      epochRotated: snapshot.epochRotated,
      epochDbRotated: snapshot.epochDbRotated,
      perfMs: {
        open: options.formatPerfMs(persistencePerfMs.open),
        planning: options.formatPerfMs(persistencePerfMs.planning),
        planningStages: Object.fromEntries(
          Object.entries(persistencePerfMs.planningStages).map(
            ([stage, duration]) => [
              stage,
              options.formatPerfMs(duration),
            ],
          ),
        ),
        diff: options.formatPerfMs(persistencePerfMs.diff),
        prepare: options.formatPerfMs(persistencePerfMs.prepare),
        prepareStages: Object.fromEntries(
          Object.entries(persistencePerfMs.prepareStages).map(
            ([stage, duration]) => [
              stage,
              options.formatPerfMs(duration),
            ],
          ),
        ),
        authoritativeWrite: options.formatPerfMs(
          persistencePerfMs.authoritativeWrite,
        ),
        currentCacheWrite: options.formatPerfMs(
          persistencePerfMs.currentCacheWrite,
        ),
        postCommit: options.formatPerfMs(persistencePerfMs.postCommit),
        write: options.formatPerfMs(committed.writeMs),
        snap: options.formatPerfMs(persistencePerfMs.snapshot),
        total: options.formatPerfMs(persistencePerfMs.total),
      },
    });
  }
  return {
    materialized: prepared.shouldMaterialize,
    materializedOverlayRecords: prepared.shouldMaterialize
      ? prepared.overlayRecords.length
      : 0,
    historyViewsMaterialized: committed.historyViewsMaterialized,
    latestSnapshotHeight: snapshot.latestSnapshotHeight,
    retainedHistoryBytes: snapshot.retainedHistoryBytes,
    snapshotCreated: snapshot.snapshotDocs > 0,
    snapshotBytes: snapshot.snapshotBytes,
    historyPrunedBytes: snapshot.prunedBytes,
    epochRotated: snapshot.epochRotated,
    epochDbRotated: snapshot.epochDbRotated,
    historyViewRetainedBytes: committed.historyViewRetainedBytes,
    historyViewPrunedBytes: committed.historyViewPrunedBytes,
    persistencePerfMs,
  };
};

export const saveRuntimeFrameToStorage = async (
  options: StorageFrameSaveOptions,
): Promise<StorageFrameSaveResult> => {
  const prepared = await prepareStorageFrameSave(options);
  if ('skipped' in prepared) return prepared.skipped;
  const {
    config,
    db,
    walDb,
    head,
    snapshotDue,
    snapshotRequiredByBytes,
  } = prepared;

  const writeStartedAt = options.getPerfMs();
  const prepareMarks: Record<string, number> = {};
  const checkpointPrepare = (label: string): void => {
    prepareMarks[label] = options.getPerfMs() - writeStartedAt;
  };
  const appendPosition = await resolveStorageAppendPosition(
    options,
    walDb,
    head,
  );
  if ('staleWriterStopped' in appendPosition) {
    return {
      materialized: false,
      materializedOverlayRecords: 0,
      historyViewsMaterialized: false,
      staleWriterStopped: true,
    };
  }
  const { previousFrame, prevFrameHash } = appendPosition;
  options.onPersistenceProgress?.('history-read');
  checkpointPrepare('historyRead');
  const pendingNodes = collectPendingStorageNodes(options.env);
  checkpointPrepare('pendingNodes');

  const commitments = await prepareStorageStateCommitments(
    options,
    prepared,
    previousFrame,
    checkpointPrepare,
  );
  const framePlan = buildStorageFrameRecordPlan(
    options,
    prepared,
    commitments,
    pendingNodes,
    prevFrameHash,
  );
  options.onPersistenceProgress?.('frame-encoded');
  checkpointPrepare('frameEncode');
  const batches = buildStorageCommitBatches(
    options,
    prepared,
    commitments,
    pendingNodes,
    framePlan,
  );
  checkpointPrepare('batchPlan');
  const committed = await commitStorageFrame(
    options,
    prepared,
    commitments,
    framePlan,
    batches,
    writeStartedAt,
    prepareMarks,
  );
  const snapshot = await runStorageSnapshotLifecycle(
    options,
    db,
    walDb,
    config,
    head,
    batches.nextHead,
    snapshotDue,
    snapshotRequiredByBytes,
  );
  return finishStorageFrameSave(
    options,
    prepared,
    framePlan,
    committed,
    snapshot,
  );
};
