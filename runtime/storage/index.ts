import { decodeValidatedBuffer, encodeBuffer, writeBatch } from './codec';
import {
  docValueKey,
  liveKeyForDoc,
  liveKeyForRef,
} from './doc-refs';
import {
  deleteKeyRange,
  iterateKeys,
  readRawOrNull,
} from './level';
import {
  buildFrameDbPuts,
  prepareFrameDbCommit,
  pruneFrameDbRetention,
  putFrameDbCommit,
} from './frame-db';
import {
  computeStorageFrameHash,
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
  buildCertifiedEntityLineagePlan,
  rebaseCertifiedEntityLineageAtRuntimeCheckpoint,
} from './entity-lineage';
import {
  listStorageSnapshotReplicaMetas,
  readStorageFrameRecord,
  readStorageHead,
} from './read';
import {
  DEFAULT_ACCOUNT_MERKLE_RADIX,
  DEFAULT_EPOCH_MAX_BYTES,
  DEFAULT_FRAME_DB_MAX_BYTES,
  DEFAULT_FRAME_DB_RETAIN_FRAMES,
  DEFAULT_MATERIALIZE_PERIOD_FRAMES,
  DEFAULT_RETAIN_SNAPSHOTS,
  DEFAULT_SNAPSHOT_PERIOD_FRAMES,
  KEY_HEAD,
  KEY_DIFF,
  KEY_LIVE_ACCOUNT,
  KEY_LIVE_BOOK,
  KEY_LIVE_ENTITY,
  KEY_LIVE_REPLICA_META,
  KEY_MERKLE_BRANCH,
  KEY_MERKLE_LEAF,
  KEY_MERKLE_ROOT,
  STORAGE_SCHEMA_VERSION,
  ZERO_FRAME_HASH,
  decodeEntityId,
  decodeHeight,
  keyDiff,
  keyFrame,
  keyLiveReplicaMetaPrefix,
  keyCertifiedBoardNode,
  keyCertifiedBoardNodePrefix,
  keyConsumptionNode,
  keyConsumptionNodePrefix,
  keyAccountJClaimNode,
  keyAccountJClaimNodePrefix,
  keySnapshotReplicaMetaPrefix,
} from './keys';
import { buildStorageReplicaMetaCommitment } from './replicas';
import { createStructuredLogger } from '../infra/logger';
import type {
  CertifiedBoardPatriciaNode,
  EntityState,
  Env,
  RoutedEntityInput,
  RuntimeInput,
  RuntimeFrameDbRecord,
} from '../types';
import {
  cloneIsolatedRoutedEntityInputs,
  cloneIsolatedRuntimeSnapshot,
} from '../protocol/runtime-input-clone';
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
import { buildDurableRuntimeMachineSnapshot } from '../wal/snapshot';
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
  RuntimeFrameDbLike,
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
export {
  buildAccountMerkleFromDocs,
  buildAccountMerkleFromState,
  hydrateAccountDocFromStorage,
  hydrateEntityStateFromStorage,
  projectAccountDoc,
  projectEntityCoreDoc,
} from './projections';
export {
  readFrameDbAccountFrames,
  readFrameDbRuntimeActivity,
} from './frame-db';
export {
  inspectStorage,
} from './inspect';
export {
  seedFreshStorageEpoch,
} from './lifecycle';
export {
  computeStorageFrameHash,
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

const parseStorageBoolean = (value: unknown, label: string): boolean => {
  if (typeof value === 'boolean') return value;
  const normalized = String(value ?? '').trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  throw new Error(`STORAGE_CONFIG_${label}_INVALID:${String(value)}`);
};

const positiveStorageInteger = (value: unknown, label: string): number => {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 1) {
    throw new Error(`STORAGE_CONFIG_${label}_INVALID:${String(value)}`);
  }
  return normalized;
};

const resolveCanonicalHashPeriodFrames = (env: Env): 0 | 1 => {
  const explicitPeriod =
    env.runtimeConfig?.storage?.canonicalHashPeriodFrames ??
    process.env['XLN_STORAGE_CANONICAL_HASH_PERIOD_FRAMES'];
  if (explicitPeriod !== undefined) {
    const normalized = Number(explicitPeriod);
    if (!Number.isSafeInteger(normalized) || normalized < 0) {
      throw new Error(`STORAGE_CONFIG_CANONICAL_HASH_PERIOD_FRAMES_INVALID:${String(explicitPeriod)}`);
    }
    return normalized > 0 ? 1 : 0;
  }
  const legacyOverride = process.env['XLN_STORAGE_VERIFY_CANONICAL'];
  if (legacyOverride !== undefined) {
    return parseStorageBoolean(legacyOverride, 'VERIFY_CANONICAL') ? 1 : 0;
  }
  // Mainnet default: every authoritative frame carries the independent
  // canonical replay oracle. Disabling it must be an explicit operator choice.
  return 1;
};

export const resolveStorageRuntimeConfig = (env: Env): Required<StorageRuntimeConfig> => {
  const raw = env.runtimeConfig?.storage;
  const radix = raw?.accountMerkleRadix ?? DEFAULT_ACCOUNT_MERKLE_RADIX;
  if (radix !== 16 && radix !== 256) {
    throw new Error(`STORAGE_CONFIG_ACCOUNT_MERKLE_RADIX_INVALID:${String(radix)}`);
  }
  return {
    enabled: raw?.enabled === undefined ? true : parseStorageBoolean(raw.enabled, 'ENABLED'),
    snapshotPeriodFrames: positiveStorageInteger(
      raw?.snapshotPeriodFrames ?? env.runtimeConfig?.snapshotIntervalFrames ?? DEFAULT_SNAPSHOT_PERIOD_FRAMES,
      'SNAPSHOT_PERIOD_FRAMES',
    ),
    retainSnapshots: positiveStorageInteger(raw?.retainSnapshots ?? DEFAULT_RETAIN_SNAPSHOTS, 'RETAIN_SNAPSHOTS'),
    epochMaxBytes: positiveStorageInteger(raw?.epochMaxBytes ?? DEFAULT_EPOCH_MAX_BYTES, 'EPOCH_MAX_BYTES'),
    frameDbMaxBytes: positiveStorageInteger(raw?.frameDbMaxBytes ?? DEFAULT_FRAME_DB_MAX_BYTES, 'FRAME_DB_MAX_BYTES'),
    frameDbRetainFrames: positiveStorageInteger(
      raw?.frameDbRetainFrames ?? DEFAULT_FRAME_DB_RETAIN_FRAMES,
      'FRAME_DB_RETAIN_FRAMES',
    ),
    materializePeriodFrames: positiveStorageInteger(
      raw?.materializePeriodFrames ?? DEFAULT_MATERIALIZE_PERIOD_FRAMES,
      'MATERIALIZE_PERIOD_FRAMES',
    ),
    canonicalHashPeriodFrames: resolveCanonicalHashPeriodFrames(env),
    accountMerkleRadix: radix,
  };
};

const defaultStorageHead = (config: Required<StorageRuntimeConfig>): StorageHead => ({
    schemaVersion: STORAGE_SCHEMA_VERSION,
    latestHeight: 0,
    latestMaterializedHeight: 0,
    latestSnapshotHeight: 0,
    snapshotPeriodFrames: config.snapshotPeriodFrames,
    retainSnapshots: config.retainSnapshots,
    epochMaxBytes: config.epochMaxBytes,
    accountMerkleRadix: config.accountMerkleRadix,
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
  puts,
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
  for (const doc of options.diff.puts) {
    batch.put(liveKeyForDoc(doc), preparedHashes.docValueBuffers.get(docValueKey(doc)) ?? encodeBuffer(doc.value));
  }
  for (const ref of options.diff.dels) {
    if (typeof batch.del === 'function') batch.del(liveKeyForRef(ref));
  }
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
  KEY_LIVE_BOOK,
  KEY_LIVE_REPLICA_META,
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
  left.retainedHistoryBytes === right.retainedHistoryBytes;

const synchronizeReplicaMeta = async (
  historyDb: RuntimeFrameDbLike,
  currentDb: RuntimeDbLike,
  batch: ReturnType<RuntimeDbLike['batch']>,
): Promise<boolean> => {
  if (typeof batch.del !== 'function') throw new Error('STORAGE_RECOVERY_DELETE_UNSUPPORTED');
  const authoritative = new Map<string, { key: Buffer; value: Buffer }>();
  for await (const key of iterateKeys(historyDb, { prefix: keyLiveReplicaMetaPrefix() })) {
    authoritative.set(key.toString('hex'), { key, value: await historyDb.get(key) });
  }
  let changed = false;
  for await (const key of iterateKeys(currentDb, { prefix: keyLiveReplicaMetaPrefix() })) {
    if (authoritative.has(key.toString('hex'))) continue;
    batch.del(key);
    changed = true;
  }
  for (const { key, value } of authoritative.values()) {
    const current = await readRawOrNull(currentDb, key);
    if (current?.equals(value)) continue;
    batch.put(key, value);
    changed = true;
  }
  return changed;
};

const synchronizeCertifiedBoardNodes = async (
  historyDb: RuntimeFrameDbLike,
  currentDb: RuntimeDbLike,
  batch: ReturnType<RuntimeDbLike['batch']>,
): Promise<boolean> => {
  let changed = false;
  for await (const key of iterateKeys(historyDb, { prefix: keyCertifiedBoardNodePrefix() })) {
    const authoritative = await historyDb.get(key);
    const current = await readRawOrNull(currentDb, key);
    if (current?.equals(authoritative)) continue;
    batch.put(key, authoritative);
    changed = true;
  }
  return changed;
};

const synchronizeConsumptionNodes = async (
  historyDb: RuntimeFrameDbLike,
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
  for await (const key of iterateKeys(historyDb, { prefix: keyConsumptionNodePrefix() })) {
    const hash = `0x${key.subarray(1).toString('hex')}`;
    const value = await historyDb.get(key);
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
  historyDb: RuntimeFrameDbLike,
  height: number,
  docs: readonly StorageDoc[],
): Promise<EntityState[]> => {
  const entityIds = Array.from(new Set(docs.map((doc) => doc.entityId))).sort();
  for await (const key of iterateKeys(historyDb, { prefix: keySnapshotReplicaMetaPrefix(height) })) {
    if (key.byteLength !== 73) throw new Error(`STORAGE_SNAPSHOT_REPLICA_META_KEY_LENGTH_INVALID:${key.byteLength}`);
    entityIds.push(decodeEntityId(key.subarray(9, 41)));
  }
  const states: EntityState[] = [];
  for (const entityId of [...new Set(entityIds)].sort()) {
    const metas = await listStorageSnapshotReplicaMetas(historyDb, height, entityId);
    for (const meta of metas) states.push(meta.state);
  }
  return states;
};

const certifiedBoardRoot = (
  state: { certifiedBoardState?: EntityState['certifiedBoardState'] },
): string | undefined =>
  state.certifiedBoardState?.boardRegistryRoot;

const collectCertifiedBoardHistoryRoots = async (
  env: Env,
  historyDb: RuntimeFrameDbLike,
): Promise<Set<string>> => {
  const roots = new Set<string>();
  const remember = (root: string | undefined): void => {
    if (root) roots.add(root);
  };
  for (const { state } of env.eReplicas.values()) remember(certifiedBoardRoot(state));
  for (const height of await listSnapshotHeights(historyDb)) {
    const docs = await readSnapshotDocs(historyDb, height);
    for (const doc of docs) if (doc.family === 'entity') remember(certifiedBoardRoot(doc.value));
    for (const state of await readSnapshotReplicaStates(historyDb, height, docs)) remember(certifiedBoardRoot(state));
  }
  for await (const key of iterateKeys(historyDb, { prefix: Buffer.from([KEY_DIFF]) })) {
    const diff = decodeValidatedBuffer(await historyDb.get(key), validateStorageDiffRecordValue);
    if (diff.height !== decodeHeight(key)) throw new Error('STORAGE_DIFF_KEY_HEIGHT_MISMATCH:scope=board-gc');
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
    const hash = `0x${key.subarray(1).toString('hex')}`;
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
  env: Env,
  historyDb: RuntimeFrameDbLike,
  currentDb: RuntimeDbLike,
): Promise<number> => {
  const stored = await readCertifiedBoardNodes(historyDb);
  const roots = await collectCertifiedBoardHistoryRoots(env, historyDb);
  const reachable = collectReachableCertifiedBoardNodes(stored.nodes, roots);
  const stale = [...stored.nodes.keys()].filter((hash) => !reachable.has(hash)).sort();
  await deleteCertifiedBoardNodes(historyDb, stale, 'STORAGE_HISTORY_CERTIFIED_BOARD_GC_UNSUPPORTED');
  await deleteCertifiedBoardNodes(currentDb, stale, 'STORAGE_CURRENT_CERTIFIED_BOARD_GC_UNSUPPORTED');
  const memoryStore = getCertifiedBoardNodeStore(env);
  for (const hash of stale) memoryStore.delete(hash);
  return stale.reduce((total, hash) => total + (stored.bytes.get(hash) ?? 0), 0);
};

const pruneUnreachableConsumptionHistoryNodes = async (
  env: Env,
  historyDb: RuntimeFrameDbLike,
): Promise<number> => {
  const byRoot = new Map<string, ConsumptionAccumulatorState>();
  const remember = (state: ConsumptionAccumulatorState | undefined): void => {
    if (state) byRoot.set(`${state.root}:${state.count.toString()}`, state);
  };
  for (const state of getLiveConsumptionAccumulatorStates(env)) remember(state);
  for (const height of await listSnapshotHeights(historyDb)) {
    const docs = await readSnapshotDocs(historyDb, height);
    for (const doc of docs) {
      if (doc.family === 'entity') remember(doc.value.consumptionAccumulator);
    }
    for (const state of await readSnapshotReplicaStates(historyDb, height, docs)) {
      remember(state.consumptionAccumulator);
    }
  }
  for await (const key of iterateKeys(historyDb, { prefix: Buffer.from([KEY_DIFF]) })) {
    const diff = decodeValidatedBuffer(await historyDb.get(key), validateStorageDiffRecordValue);
    if (diff.height !== decodeHeight(key)) throw new Error('STORAGE_DIFF_KEY_HEIGHT_MISMATCH:scope=consumption-gc');
    for (const doc of diff.puts) {
      if (doc.family === 'entity') remember(doc.value.consumptionAccumulator);
    }
  }

  const stored = new Map<string, ConsumptionNode>();
  const encodedBytes = new Map<string, number>();
  for await (const key of iterateKeys(historyDb, { prefix: keyConsumptionNodePrefix() })) {
    const hash = `0x${key.subarray(1).toString('hex')}`;
    const raw = await historyDb.get(key);
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
  const batch = historyDb.batch();
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
  historyDb: RuntimeFrameDbLike,
  currentDb: RuntimeDbLike,
  batch: ReturnType<RuntimeDbLike['batch']>,
): Promise<boolean> => {
  const states: AccountJClaimAccumulatorState[] = [];
  for await (const key of iterateKeys(currentDb, { prefix: Buffer.from([KEY_LIVE_ACCOUNT]) })) {
    const doc = decodeValidatedBuffer(await currentDb.get(key), validateStorageAccountDocValue);
    states.push(doc.leftPendingJClaims, doc.rightPendingJClaims);
  }
  const authoritative = new Map<string, AccountJClaimNode>();
  const values = new Map<string, Buffer>();
  for await (const key of iterateKeys(historyDb, { prefix: keyAccountJClaimNodePrefix() })) {
    const hash = `0x${key.subarray(1).toString('hex')}`;
    const value = await historyDb.get(key);
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
  env: Env,
  historyDb: RuntimeFrameDbLike,
): Promise<number> => {
  const states = new Map<string, AccountJClaimAccumulatorState>();
  const remember = (state: AccountJClaimAccumulatorState): void => {
    states.set(`${state.root}:${state.count.toString()}`, state);
  };
  for (const state of getLiveAccountJClaimAccumulatorStates(env)) remember(state);
  for (const height of await listSnapshotHeights(historyDb)) {
    const docs = await readSnapshotDocs(historyDb, height);
    for (const doc of docs) {
      if (doc.family !== 'account') continue;
      remember(doc.value.leftPendingJClaims);
      remember(doc.value.rightPendingJClaims);
    }
    for (const state of await readSnapshotReplicaStates(historyDb, height, docs)) {
      for (const account of state.accounts.values()) {
        remember(account.leftPendingJClaims);
        remember(account.rightPendingJClaims);
      }
    }
  }
  for await (const key of iterateKeys(historyDb, { prefix: Buffer.from([KEY_DIFF]) })) {
    const diff = decodeValidatedBuffer(await historyDb.get(key), validateStorageDiffRecordValue);
    if (diff.height !== decodeHeight(key)) throw new Error('STORAGE_DIFF_KEY_HEIGHT_MISMATCH:scope=account-j-gc');
    for (const doc of diff.puts) {
      if (doc.family !== 'account') continue;
      remember(doc.value.leftPendingJClaims);
      remember(doc.value.rightPendingJClaims);
    }
  }
  const stored = new Map<string, AccountJClaimNode>();
  const bytes = new Map<string, number>();
  for await (const key of iterateKeys(historyDb, { prefix: keyAccountJClaimNodePrefix() })) {
    const hash = `0x${key.subarray(1).toString('hex')}`;
    const raw = await historyDb.get(key);
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
  const batch = historyDb.batch();
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
  historyDb: RuntimeFrameDbLike;
  config: Required<StorageRuntimeConfig>;
  onPersistenceProgress?: StoragePersistenceProgressHook;
}): Promise<{ recovered: boolean; entityHashDocs?: Map<string, StorageEntityHashDoc> }> => {
  const historyHead = await readHead(options.historyDb, options.config);
  const rawCurrentHead = await readRawOrNull(options.db, KEY_HEAD);
  const currentHead = rawCurrentHead ? await readHead(options.db, options.config) : defaultStorageHead(options.config);
  const historyLatestHeight = Math.max(0, Math.floor(Number(historyHead.latestHeight ?? 0)));
  const currentLatestHeight = Math.max(0, Math.floor(Number(currentHead.latestHeight ?? 0)));
  const historyMaterializedHeight = materializedHeightOf(historyHead);
  const currentMaterializedHeight = materializedHeightOf(currentHead);
  const historySnapshotHeight = Math.max(0, Math.floor(Number(historyHead.latestSnapshotHeight ?? 0)));
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
      await verifyStorageSnapshotIntegrity(options.historyDb, historyHead);
      options.onPersistenceProgress?.('recovery-snapshot-verified');
    }
    await clearCurrentRecoveryState(options.db);
    options.onPersistenceProgress?.('recovery-current-cleared');
    replayFromHeight = 0;
    recovered = true;
    if (historySnapshotHeight > 0) {
      const snapshotDocs = await readSnapshotDocs(options.historyDb, historySnapshotHeight);
      entityHashDocs = await applyDiffToLiveDb({
        db: options.db,
        diff: { height: historySnapshotHeight, puts: snapshotDocs, dels: [] },
      });
      replayFromHeight = historySnapshotHeight;
      options.onPersistenceProgress?.('recovery-snapshot-applied');
    }
  }
  for (let height = replayFromHeight + 1; height <= historyMaterializedHeight; height += 1) {
    const rawDiff = await readRawOrNull(options.historyDb, keyDiff(height));
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
  const metaChanged = await synchronizeReplicaMeta(options.historyDb, options.db, batch);
  options.onPersistenceProgress?.('recovery-replica-metadata-synchronized');
  const headChanged = !rawCurrentHead || !storageHeadsEqual(historyHead, currentHead);
  // The normal append path writes both DBs and never scans the content-addressed
  // DAG. Only a lagging/current-cache recovery needs to copy immutable nodes.
  const boardNodesChanged = headChanged
    ? await synchronizeCertifiedBoardNodes(options.historyDb, options.db, batch)
    : false;
  options.onPersistenceProgress?.('recovery-board-nodes-synchronized');
  const consumptionNodesChanged = headChanged
    ? await synchronizeConsumptionNodes(options.historyDb, options.db, batch)
    : false;
  options.onPersistenceProgress?.('recovery-consumption-nodes-synchronized');
  const accountJClaimNodesChanged = headChanged
    ? await synchronizeAccountJClaimNodes(options.historyDb, options.db, batch)
    : false;
  options.onPersistenceProgress?.('recovery-account-j-nodes-synchronized');
  if (headChanged) batch.put(KEY_HEAD, encodeBuffer(historyHead));
  if (metaChanged || boardNodesChanged || consumptionNodesChanged || accountJClaimNodesChanged || headChanged) {
    await writeBatch(batch);
    options.onPersistenceProgress?.('recovery-current-write-done');
    recovered = true;
  }
  return { recovered, ...(entityHashDocs ? { entityHashDocs } : {}) };
};

export type StorageFrameSaveResult = {
  materialized: boolean;
  materializedOverlayRecords: number;
  frameDbCommitted: boolean;
  staleWriterStopped?: boolean;
  latestSnapshotHeight?: number;
  retainedHistoryBytes?: number;
  snapshotCreated?: boolean;
  snapshotBytes?: number;
  historyPrunedBytes?: number;
  epochRotated?: boolean;
  epochDbRotated?: boolean;
  frameDbRetainedBytes?: number;
  frameDbPrunedBytes?: number;
  persistencePerfMs?: StoragePersistencePerf;
};

export type StoragePersistencePerf = {
  open: number;
  diff: number;
  prepare: number;
  authoritativeWrite: number;
  currentCacheWrite: number;
  postCommit: number;
  snapshot: number;
  total: number;
};

export const saveRuntimeFrameToStorage = async (options: {
  env: Env;
  stateHash?: string;
  currentFrameInput?: RuntimeInput;
  currentFrameOutputs?: RoutedEntityInput[];
  currentFrameRuntimeMachineBeforeApply?: Record<string, unknown>;
  frameDbRecords?: RuntimeFrameDbRecord[];
  tryOpenDb: (env: Env) => Promise<boolean>;
  getRuntimeDb: (env: Env) => RuntimeDbLike;
  tryOpenFrameDb: (env: Env) => Promise<boolean>;
  getFrameDb: (env: Env) => RuntimeFrameDbLike;
  rotateEpochDb?: (env: Env, snapshotHeight: number, timestamp: number) => Promise<boolean | void>;
  stopStaleWriterOnHeadAhead?: boolean;
  onPersistenceBoundary?: StoragePersistenceBoundaryHook;
  onPersistenceProgress?: StoragePersistenceProgressHook;
} & PerfDeps): Promise<StorageFrameSaveResult> => {
  const config = resolveStorageRuntimeConfig(options.env);
  if (!config.enabled) return { materialized: false, materializedOverlayRecords: 0, frameDbCommitted: true };

  const state = options.env.runtimeState ?? {};
  if (state.persistencePaused) return { materialized: false, materializedOverlayRecords: 0, frameDbCommitted: true };

  const openStartedAt = options.getPerfMs();
  const opened = await options.tryOpenDb(options.env);
  if (!opened) return { materialized: false, materializedOverlayRecords: 0, frameDbCommitted: false };
  const db = options.getRuntimeDb(options.env);
  const historyOpened = await options.tryOpenFrameDb(options.env);
  if (!historyOpened) return { materialized: false, materializedOverlayRecords: 0, frameDbCommitted: false };
  const historyDb = options.getFrameDb(options.env);
  const recoveredStorage = await recoverStorageDbFromHistory({
    db,
    historyDb,
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

  const appliedRuntimeInput = options.currentFrameInput ?? { runtimeTxs: [], entityInputs: [] };
  const frameOverlayRecords = Array.isArray(state.currentStorageOverlayMarks)
    ? state.currentStorageOverlayMarks.map((record) => ({ ...record }))
    : [];
  const overlayRecords = mergeOverlayRecordsIntoEnv(options.env, []);
  const frameTouched = storageRefsFromOverlay(frameOverlayRecords);
  const lineagePlan = rebaseCertifiedEntityLineageAtRuntimeCheckpoint(
    options.env,
    buildCertifiedEntityLineagePlan(options.env),
  );
  const replicaLookup = lineagePlan.lookup;
  const diffBuildStartedAt = options.getPerfMs();
  const framePuts = buildDocPuts(options.env, frameTouched, replicaLookup);
  const frameBookDels = buildBookDeletionsFromOverlay(frameOverlayRecords);
  const diff = buildDiffRecord(options.env.height, framePuts, frameBookDels);
  options.onPersistenceProgress?.('diff-built');
  const diffBuildMs = options.getPerfMs() - diffBuildStartedAt;

  const writeStartedAt = options.getPerfMs();
  const head = await readHead(historyDb, config);
  if (options.stopStaleWriterOnHeadAhead) {
    if (head.latestHeight > options.env.height) {
      return {
        materialized: false,
        materializedOverlayRecords: 0,
        frameDbCommitted: false,
        staleWriterStopped: true,
      };
    }
    if (head.latestHeight === options.env.height) {
      const persistedFrame = await readStorageFrameRecord(historyDb, options.env.height);
      if (persistedFrame) {
        return {
          materialized: false,
          materializedOverlayRecords: 0,
          frameDbCommitted: false,
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
  const previousFrame = head.latestHeight > 0 ? await readStorageFrameRecord(historyDb, head.latestHeight) : null;
  if (head.latestHeight > 0 && !previousFrame) {
    throw new Error(`STORAGE_PREV_FRAME_MISSING: height=${head.latestHeight}`);
  }
  const prevFrameHash = previousFrame ? previousFrame.frameHash ?? computeStorageFrameHash(previousFrame) : ZERO_FRAME_HASH;
  options.onPersistenceProgress?.('history-read');
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
  const projectedHistoryBytesWithoutFrame =
    head.retainedHistoryBytes +
    diffKey.byteLength +
    diffBuffer.byteLength +
    pendingBoardHistoryBytes +
    pendingConsumptionHistoryBytes +
    pendingAccountJClaimHistoryBytes;
  // Frame 1 is the immutable recovery anchor for the first WAL suffix. Without
  // a published snapshot here, its validator-local Entity metadata exists only
  // at the live head and deterministic replay cannot start before the first
  // periodic checkpoint.
  const snapshotDue =
    options.env.height === 1 ||
    options.env.height % config.snapshotPeriodFrames === 0;
  const snapshotRequiredByBytes = projectedHistoryBytesWithoutFrame > config.epochMaxBytes;
  const shouldMaterialize =
    options.env.height === 1 ||
    options.env.height % config.materializePeriodFrames === 0 ||
    snapshotDue ||
    snapshotRequiredByBytes;

  const frameLogs = Array.isArray(options.env.frameLogs) ? options.env.frameLogs.map((entry) => ({ ...entry })) : [];
  const touchedEntities = Array.from(frameTouched.touchedEntities.values()).sort();
  const touchedAccounts = Array.from(frameTouched.touchedAccounts.values())
    .filter((ref): ref is Extract<StorageDocRef, { family: 'account' }> => ref.family === 'account')
    .map((ref) => ({ entityId: ref.entityId, counterpartyId: ref.counterpartyId }));
  const touchedBookEntities = Array.from(frameTouched.touchedBookEntities.values()).sort();

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
  const runtimeMachine = buildDurableRuntimeMachineSnapshot(options.env, {
    pendingNetworkOutputs: options.currentFrameOutputs ?? options.env.pendingNetworkOutputs ?? [],
  });
  const appliedInputHasWork =
    appliedRuntimeInput.runtimeTxs.length > 0 ||
    appliedRuntimeInput.entityInputs.length > 0 ||
    (appliedRuntimeInput.jInputs?.length ?? 0) > 0 ||
    (appliedRuntimeInput.reliableReceipts?.length ?? 0) > 0;
  const runtimeMachineBeforeApply = options.currentFrameRuntimeMachineBeforeApply ?? (
    appliedInputHasWork ? null : runtimeMachine
  );
  if (!runtimeMachineBeforeApply) {
    throw new Error(`STORAGE_PRE_APPLY_RUNTIME_MACHINE_REQUIRED:height=${options.env.height}`);
  }
  const canonicalHashEnabled = config.canonicalHashPeriodFrames > 0;
  const runtimeStateHashes = prepareStorageCanonicalStateHashes(
    options.env,
    [],
    previousFrame,
    replicaLookup,
    runtimeMachine,
  );
  options.onPersistenceProgress?.('canonical-hashes-built');
  const canonicalHashes = canonicalHashEnabled ? runtimeStateHashes : null;
  const replicaMetaCommitment = buildStorageReplicaMetaCommitment(options.env, lineagePlan);
  const replicaMetaEntries = replicaMetaCommitment.entries;
  const liveReplicaMetaKeys = new Set(replicaMetaEntries.map(entry => entry.key.toString('hex')));
  const staleHistoryReplicaMetaKeys: Buffer[] = [];
  for await (const key of iterateKeys(historyDb, { prefix: keyLiveReplicaMetaPrefix() })) {
    if (!liveReplicaMetaKeys.has(key.toString('hex'))) staleHistoryReplicaMetaKeys.push(Buffer.from(key));
  }
  const staleCurrentReplicaMetaKeys: Buffer[] = [];
  for await (const key of iterateKeys(db, { prefix: keyLiveReplicaMetaPrefix() })) {
    if (!liveReplicaMetaKeys.has(key.toString('hex'))) staleCurrentReplicaMetaKeys.push(Buffer.from(key));
  }
  options.onPersistenceProgress?.('replica-metadata-read');
  const frameRecordBase: StorageFrameRecord = {
    height: options.env.height,
    timestamp: options.env.timestamp,
    prevFrameHash,
    replicaMetaDigest: replicaMetaCommitment.digest,
    stateHash: preparedHashes?.stateHash ?? '',
    hashMode: 'storage-merkle-v1',
    materializedState: shouldMaterialize,
    entityHashes: preparedHashes?.entityHashes ?? previousFrame?.entityHashes ?? [],
    ...(canonicalHashes ? {
      canonicalStateHash: canonicalHashes.canonicalStateHash,
      canonicalEntityHashes: canonicalHashes.canonicalEntityHashes,
    } : {}),
    runtimeStateHash: runtimeStateHashes.canonicalStateHash,
    runtimeInput: appliedRuntimeInput,
    runtimeMachineBeforeApply: cloneIsolatedRuntimeSnapshot(runtimeMachineBeforeApply),
    runtimeMachine,
    ...(options.currentFrameOutputs && options.currentFrameOutputs.length > 0
      ? { runtimeOutputs: cloneIsolatedRoutedEntityInputs(options.currentFrameOutputs) }
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
  const frameDbPuts = buildFrameDbPuts({
    height: options.env.height,
    timestamp: options.env.timestamp,
    runtimeInput: appliedRuntimeInput,
    logs: frameLogs,
    touchedEntities,
    touchedAccounts,
    touchedBookEntities,
    frameDbRecords: options.frameDbRecords ?? [],
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
  const projectedReplayBytes =
    head.retainedHistoryBytes +
    frameKey.byteLength +
    frameBuffer.byteLength +
    diffKey.byteLength +
    diffBuffer.byteLength +
    pendingBoardHistoryBytes +
    pendingConsumptionHistoryBytes +
    pendingAccountJClaimHistoryBytes;
  let frameDbBytes = 0;
  let frameDbPrunedBytes = 0;
  let frameDbRetainedBytes = 0;
  let frameDbPrunedKeys = 0;
  let frameDbLatestPrunedHeight = 0;
  let frameDbCommitted = frameDbPuts.length === 0;
  let frameDbCommitPlan: Awaited<ReturnType<typeof prepareFrameDbCommit>> | null = null;
  const historyBatch = historyDb.batch();
  if (staleHistoryReplicaMetaKeys.length > 0 && typeof historyBatch.del !== 'function') {
    throw new Error('STORAGE_HISTORY_REPLICA_META_DELETE_UNSUPPORTED');
  }
  for (const key of staleHistoryReplicaMetaKeys) historyBatch.del!(key);
  for (const { key, value } of pendingBoardEntries) {
    // Root-bearing entity docs and all newly referenced nodes share both
    // atomic batches. History is authoritative; current is a rebuildable cache.
    historyBatch.put(key, value);
  }
  const safeConsumptionDeletes = getSafePendingConsumptionDeletes(options.env);
  const safeAccountJClaimDeletes = getSafePendingAccountJClaimDeletes(options.env);
  for (const [hash, node] of pendingConsumptionNodes) {
    if (hashConsumptionNode(node) !== hash) throw new Error(`CONSUMPTION_NODE_CORRUPT:${hash}`);
    historyBatch.put(keyConsumptionNode(hash), encodeBuffer(node));
  }
  for (const [hash, node] of pendingAccountJClaimNodes) {
    if (hashAccountJClaimNode(node) !== hash) throw new Error(`ACCOUNT_J_CLAIM_NODE_CORRUPT:${hash}`);
    historyBatch.put(keyAccountJClaimNode(hash), encodeBuffer(node));
  }
  historyBatch.put(frameKey, frameBuffer);
  historyBatch.put(diffKey, diffBuffer);
  if (frameDbPuts.length > 0) {
    frameDbCommitPlan = await prepareFrameDbCommit({
      db: historyDb,
      height: options.env.height,
      puts: frameDbPuts,
      config,
    });
    frameDbBytes = frameDbCommitPlan.writtenBytes;
    putFrameDbCommit(historyBatch, frameDbCommitPlan);
  }
  options.onPersistenceProgress?.('frame-db-plan-built');
  const batch = db.batch();
  if (staleCurrentReplicaMetaKeys.length > 0 && typeof batch.del !== 'function') {
    throw new Error('STORAGE_CURRENT_REPLICA_META_DELETE_UNSUPPORTED');
  }
  for (const key of staleCurrentReplicaMetaKeys) batch.del!(key);
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
    for (const doc of materializedPuts) {
      batch.put(liveKeyForDoc(doc), preparedHashes.docValueBuffers.get(docValueKey(doc)) ?? encodeBuffer(doc.value));
    }
    for (const ref of materializedDels) {
      if (typeof batch.del === 'function') batch.del(liveKeyForRef(ref));
    }
    for (const key of preparedHashes.merkleDels) {
      if (typeof batch.del === 'function') batch.del(key);
    }
    for (const item of preparedHashes.merklePuts) {
      batch.put(item.key, item.value);
    }
  }
  for (const entry of replicaMetaEntries) {
    // Replica metadata is authoritative recovery state. Keep it in the same
    // atomic history batch as frame+diff+head; the current DB is a rebuildable
    // materialized cache and may lag after a crash.
    historyBatch.put(entry.key, entry.value);
    batch.put(entry.key, entry.value);
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
    retainedHistoryBytes: projectedReplayBytes,
  };
  historyBatch.put(KEY_HEAD, encodeBuffer(nextHead));
  batch.put(KEY_HEAD, encodeBuffer(nextHead));
  const authoritativeWriteStartedAt = options.getPerfMs();
  const prepareMs = authoritativeWriteStartedAt - writeStartedAt;
  options.onPersistenceProgress?.('authoritative-write-start');
  await writeBatch(historyBatch, { sync: true });
  const authoritativeWriteMs = options.getPerfMs() - authoritativeWriteStartedAt;
  options.onPersistenceProgress?.('authoritative-write-done');
  await options.onPersistenceBoundary?.('after-authoritative-history-commit');
  if (frameDbCommitPlan) {
    frameDbCommitted = true;
  }
  const currentCacheWriteStartedAt = options.getPerfMs();
  options.onPersistenceProgress?.('current-cache-write-start');
  await writeBatch(batch, { sync: false });
  const currentCacheWriteMs = options.getPerfMs() - currentCacheWriteStartedAt;
  options.onPersistenceProgress?.('current-cache-write-done');
  await options.onPersistenceBoundary?.('after-current-cache-commit');
  applyCertifiedEntityLineagePlan(options.env, lineagePlan);
  if (state) {
    state.currentStorageOverlayMarks = [];
    state.pendingCertifiedBoardNodes = new Map();
    finalizePersistedConsumptionNodes(options.env, safeConsumptionDeletes);
    finalizePersistedAccountJClaimNodes(options.env, safeAccountJClaimDeletes);
  }
  if (preparedHashes) {
    state.storageEntityHashDocs = preparedHashes.entityHashDocs;
  }
  if (frameDbCommitPlan) {
    const frameDbResult = await pruneFrameDbRetention({
      db: historyDb,
      height: options.env.height,
      head: frameDbCommitPlan.nextHead,
      config,
      ...(options.onPersistenceBoundary
        ? { onPersistenceBoundary: options.onPersistenceBoundary }
        : {}),
    });
    frameDbPrunedBytes = frameDbResult.prunedBytes;
    frameDbRetainedBytes = frameDbResult.retainedBytes;
    frameDbPrunedKeys = frameDbResult.prunedKeys;
    frameDbLatestPrunedHeight = frameDbResult.latestPrunedRuntimeHeight;
    frameDbCommitted = true;
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
      historyDb,
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
      ...(await readHead(historyDb, config)),
      latestSnapshotHeight,
      retainedHistoryBytes,
    } satisfies StorageHead;
    await verifyStorageSnapshotIntegrity(historyDb, publishedHead);
    const publishBatch = historyDb.batch();
    publishBatch.put(KEY_HEAD, encodeBuffer(publishedHead));
    await writeBatch(publishBatch);
    await options.onPersistenceBoundary?.('after-snapshot-history-publish');

    prunedBytes += await maybeRotateSnapshots(
      historyDb,
      config.retainSnapshots,
      options.onPersistenceBoundary,
    );
    snapshotMs = options.getPerfMs() - snapshotStartedAt;
    options.onPersistenceProgress?.('snapshot-done');
  }

  if (snapDocs > 0) {
    if (latestSnapshotHeight > 0) {
      const retainedSnapshotHeights = await listSnapshotHeights(historyDb);
      const oldestRetainedSnapshotHeight = retainedSnapshotHeights[0] ?? latestSnapshotHeight;
      // Every retained snapshot advertises a usable historical base. Keep the
      // contiguous diff suffix after the oldest base; pruning through the newest
      // snapshot leaves older retained snapshots present but unreplayable.
      prunedBytes += await pruneHistoryBeforeHeight(
        historyDb,
        oldestRetainedSnapshotHeight,
        options.onPersistenceBoundary,
      );
    }
    prunedBytes += await pruneUnreachableCertifiedBoardHistoryNodes(options.env, historyDb, db);
    options.onPersistenceProgress?.('snapshot-board-gc-done');
    prunedBytes += await pruneUnreachableConsumptionHistoryNodes(options.env, historyDb);
    options.onPersistenceProgress?.('snapshot-consumption-gc-done');
    prunedBytes += await pruneUnreachableAccountJClaimHistoryNodes(options.env, historyDb);
    options.onPersistenceProgress?.('snapshot-account-j-gc-done');
  }

  retainedHistoryBytes = Math.max(0, retainedHistoryBytes - prunedBytes);

  if (snapDocs > 0 || prunedBytes > 0) {
    const latest = await readHead(historyDb, config);
    const historyUpdate = historyDb.batch();
    const stateUpdate = db.batch();
    const updatedHead = {
      ...latest,
      latestSnapshotHeight,
      retainedHistoryBytes,
    } satisfies StorageHead;
    historyUpdate.put(
      KEY_HEAD,
      encodeBuffer(updatedHead),
    );
    stateUpdate.put(KEY_HEAD, encodeBuffer(updatedHead));
    await writeBatch(historyUpdate);
    await options.onPersistenceBoundary?.('after-snapshot-history-head');
    await writeBatch(stateUpdate);
    await options.onPersistenceBoundary?.('after-snapshot-current-head');
  }

  if (epochRotated && snapDocs > 0 && options.rotateEpochDb) {
    const rotated = await options.rotateEpochDb(options.env, latestSnapshotHeight, options.env.timestamp);
    epochDbRotated = rotated !== false;
    options.onPersistenceProgress?.('snapshot-epoch-rotation-done');
  }

  const verboseStorageLogs =
    String(process.env['XLN_STORAGE_VERBOSE'] ?? '').toLowerCase() === '1' ||
    String(process.env['XLN_STORAGE_VERBOSE'] ?? '').toLowerCase() === 'true';
  const persistencePerfMs: StoragePersistencePerf = {
    open: openMs,
    diff: diffBuildMs,
    prepare: prepareMs,
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
      frameDbBytes,
      frameDbRetainedBytes,
      frameDbPrunedBytes,
      frameDbPrunedKeys,
      frameDbLatestPrunedHeight,
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
        diff: options.formatPerfMs(persistencePerfMs.diff),
        prepare: options.formatPerfMs(persistencePerfMs.prepare),
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
    frameDbCommitted,
    latestSnapshotHeight,
    retainedHistoryBytes,
    snapshotCreated: snapDocs > 0,
    snapshotBytes,
    historyPrunedBytes: prunedBytes,
    epochRotated,
    epochDbRotated,
    frameDbRetainedBytes,
    frameDbPrunedBytes,
    persistencePerfMs,
  };
};
