/**
 * Storage composition root for authoritative WAL/history and disposable live views.
 * Key entrypoint: saveEnvToDB enforces durable history before cache publication.
 * Human-audit importance: 100/100 — this is the crash-consistency boundary.
 */
import { getPerfMs } from '../support/time';
import { auditEntityStateRootAtCheckpoint } from '../entity/consensus/state-root';
import { decodeValidatedBuffer, encodeBuffer, encodeBufferPrepared, writeBatch } from './codec/codec';
import { canonicalizeBinaryPayload } from '../protocol/serialization/binary-codec';
import {
  boundedStorageRowsBytes,
  prepareBoundedStorageValueRows,
  readBoundedEncodedValue,
} from './codec/bounded-value';
import {
  deleteKeyRange,
  iterateKeys,
  readRawOrNull,
} from './database/level';
import {
  buildCertifiedFramePuts,
  buildHistoryViewPuts,
  pruneHistoryViewRetention,
  readHistoryViewRuntimeActivity,
  readHistoryViewHead,
  reconcileHistoryViews,
} from './history/history-view';
import {
  computeStorageFrameHash,
  computeStoragePostStateHash,
  computeRuntimePostStateComponentDigests,
  prepareStorageCanonicalStateHashes,
} from './hashes';
import {
  createSnapshot,
  listSnapshotHeights,
  maybeRotateSnapshots,
  pruneHistoryBeforeHeight,
  readSnapshotDocs,
} from './database/lifecycle';
import {
  buildBookDeletionsFromOverlay,
  buildDocPuts,
  buildEntityStatePuts,
  mergeOverlayRecordsIntoEnv,
  storageRefsFromOverlay,
} from './schema/overlay-docs';
import { storageOverlayRecordKey } from '../protocol/state/overlay';
import {
  applyCertifiedEntityLineagePlan,
  buildRuntimeCheckpointLineagePlan,
} from './replica/entity-lineage';
import {
  readStorageFrameRecord,
  readStorageHead,
} from './read/read';
import {
  KEY_HEAD,
  HISTORY_VIEW_ACCOUNT_FRAME,
  HISTORY_VIEW_ENTITY_FRAME,
  KEY_LIVE_ACCOUNT,
  KEY_LIVE_ACCOUNT_BRANCH,
  KEY_LIVE_ACCOUNT_FIELD,
  KEY_LIVE_ACCOUNT_LEAF,
  KEY_LIVE_BOOK,
  KEY_LIVE_ENTITY,
  KEY_LIVE_ENTITY_BRANCH,
  KEY_LIVE_ENTITY_FIELD,
  KEY_LIVE_ENTITY_LEAF,
  KEY_CERTIFIED_BOARD_NODE,
  KEY_CONSUMPTION_NODE,
  KEY_ACCOUNT_J_CLAIM_NODE,
  KEY_LIVE_BOOK_BRANCH,
  KEY_LIVE_BOOK_LEAF,
  STORAGE_SCHEMA_VERSION,
  ZERO_FRAME_HASH,
  decodeTaggedStorageHash,
  keyFrame,
  keyLiveReplicaMetaPrefix,
  keyCertifiedBoardNode,
  keyCertifiedBoardNodePrefix,
  keyConsumptionNode,
  keyConsumptionNodePrefix,
  keyAccountJClaimNode,
  keyAccountJClaimNodePrefix,
  parseLiveAccountKey,
  parseHistoryViewAccountFrameKey,
  parseHistoryViewAccountSwapRecencyKey,
  parseHistoryViewEntityFrameKey,
  HISTORY_VIEW_ACCOUNT_SWAP_EVENT,
  HISTORY_VIEW_ACCOUNT_SWAP_RECENCY,
  decodeHeight,
  decodeEntityId,
} from './keys';
import { readAccountStorageLayout } from './schema/account-layout';
import { readEntityStorageLayout } from './schema/entity/layout';
import {
  areStorageCheckpointReplicasQuiescent,
  buildLiveReplicaMetaPlan,
  buildStorageLiveReplicaMetaCommitment,
  buildStorageReplicaMetaCommitmentFromCheckpointPlan,
  summarizeStorageReplicaMetaHeads,
} from './replica/replicas';
import { createStructuredLogger } from '../support/logger';
import { cumulativeMarksToDurations } from '../support/performance/profile';
import type { CertifiedBoardPatriciaNode } from '../types/entity-board-registry';
import type { FrameLogEntry } from '../types/logging';
import type { EntityState } from '../entity/types';
import type { RuntimeReplica, RoutedEntityInput, RuntimeInput, RuntimeHistoryRecord } from '../runtime/types';
import type { EntityContextPayloadHash, RuntimeOutputPayloadHash } from '../protocol/hashes';
import { readRuntimeFrameEvents } from '../runtime/observability/env-events';
import {
  collectReachableCertifiedBoardNodes,
  getCertifiedBoardNodeStore,
  hashCertifiedBoardNode,
} from '../jurisdiction/machine/board-registry';
import {
  hashConsumptionNode,
  type ConsumptionAccumulatorState,
  type ConsumptionNode,
} from '../entity/consumption/consumption-accumulator';
import {
  collectReachableConsumptionNodes,
  finalizePersistedConsumptionNodes,
  getConsumptionNodeStore,
  getLiveConsumptionAccumulatorStates,
  getSafePendingConsumptionDeletes,
} from '../entity/consumption/consumption-store';
import {
  collectReachableAccountJClaimNodes,
  hashAccountJClaimNode,
  type AccountJClaimAccumulatorState,
  type AccountJClaimNode,
} from '../account/j-claims/j-claim-accumulator';
import {
  finalizePersistedAccountJClaimNodes,
  getLiveAccountJClaimAccumulatorStates,
  getSafePendingAccountJClaimDeletes,
} from '../entity/account/account-j-claim-node-store';
import {
  buildDurableRuntimeMempool,
  buildStorageRuntimeMachineSnapshot,
  buildReplayVerifiableRuntimePostStateView,
} from './wal/snapshot';
import {
  verifyStorageSnapshotIntegrity,
  verifyStorageTailIntegrity,
} from './read/verify';
import { verifyLiveStorageIntegrity } from './read/integrity/live';
import {
  validateAccountJClaimNodeValue,
  validateCertifiedBoardNodeValue,
  validateConsumptionNodeValue,
  validateStorageAccountDocValue,
} from './schema/authoritative-schema';
import {
  validateStoredAccountFrameValue,
  validateStoredAccountSwapEventValue,
  validateStoredEntityFrameValue,
} from './history/history-view-schema';
import { encodeCanonicalConsensusValue } from '../protocol/serialization/canonical-consensus-value';
import { buffersEqual } from '../protocol/serialization';
import type {
  PerfDeps,
  HistoryViewPut,
  RuntimeDbLike,
  StorageDoc,
  StorageDocRef,
  RuntimeFrame,
  StorageHead,
  StoragePersistenceBoundaryHook,
  StoragePersistenceProgressHook,
  StorageRuntimeConfig,
} from './types';
import { resolveStorageRuntimeConfig } from './database/config';
import { prepareStorageBookGraphWrite } from './commit/book-graph';
import { prepareLiveStateGraph } from './commit/live-state-graph';
import {
  prepareRuntimeOutputPayloadRows,
} from './wal/outbox-payload';
import { prepareEntityContextPayloadRows } from './wal/entity-context-payload';
import { countOp, OP_COUNTERS_ENABLED } from '../support/performance/op-counters';
import { prepareRuntimeMachineGraphRows } from './wal/runtime-machine-graph';
export { resolveStorageRuntimeConfig } from './database/config';
export {
  readHistoryViewAccountFrames,
  readHistoryViewAccountSwapEvents,
  readHistoryViewAccountSwapRecency,
  readHistoryViewEntityFrames,
  readHistoryViewRuntimeActivity,
  readHistoryViewHead,
  reconcileHistoryViews,
} from './history/history-view';
export {
  inspectStorage,
} from './read/inspect';
export {
  seedFreshStorageEpoch,
} from './database/lifecycle';
export {
  computeStorageFrameHash,
  computeStoragePostStateHash,
} from './hashes';
export {
  verifyStorageSnapshotAtHeight,
} from './read/verify';
export {
  findStorageLatestSnapshotAtOrBelow,
  hydrateAccountJClaimRootNodesFromStorage,
  hydrateCertifiedBoardRootNodesFromStorage,
  hydrateConsumptionRootNodesFromStorage,
  listStorageSnapshotEntityIds,
  listStorageSnapshotHeights,
  listStorageSnapshotReplicaMetas,
  listStorageReplicaMetas,
  loadEntityStateFromStorage,
  loadEntityStatesAtHeightFromStorage,
  readStorageFrameRecord,
  readStorageFramePayloads,
  readStorageHead,
} from './read/read';
export {
  verifyStorageTailIntegrity,
} from './read/verify';
export {
  replaceRestoredStorageBase,
} from './database/restore-import';

export type {
  StorageEntityViewPage,
} from './read/read';

export type {
  RuntimeDbLike,
  RuntimeFramePayloads,
  StorageAccountDoc,
  RuntimeFrame,
  StorageHead,
  StoragePersistenceBoundary,
  StoragePersistenceProgressHook,
  StorageRuntimeConfig,
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

const materializedHeightOf = (head: StorageHead): number =>
  Math.max(0, Math.floor(Number(head.latestMaterializedHeight ?? head.latestSnapshotHeight ?? 0)));

const CURRENT_RECOVERY_PREFIXES = [
  KEY_LIVE_ENTITY,
  KEY_LIVE_ENTITY_FIELD,
  KEY_LIVE_ENTITY_BRANCH,
  KEY_LIVE_ENTITY_LEAF,
  KEY_LIVE_ACCOUNT,
  KEY_LIVE_ACCOUNT_BRANCH,
  KEY_LIVE_ACCOUNT_FIELD,
  KEY_LIVE_ACCOUNT_LEAF,
  KEY_LIVE_BOOK,
  KEY_CERTIFIED_BOARD_NODE,
  KEY_CONSUMPTION_NODE,
  KEY_ACCOUNT_J_CLAIM_NODE,
  KEY_LIVE_BOOK_BRANCH,
  KEY_LIVE_BOOK_LEAF,
] as const;

const clearCurrentRecoveryState = async (db: RuntimeDbLike): Promise<void> => {
  const fence = db.batch();
  fence.del(KEY_HEAD);
  await writeBatch(fence);
  for (const prefix of CURRENT_RECOVERY_PREFIXES) {
    await deleteKeyRange(db, { prefix: Buffer.from([prefix]) });
  }
};

const synchronizeLiveStateProjection = async (
  walDb: RuntimeDbLike,
  currentDb: RuntimeDbLike,
  batch: ReturnType<RuntimeDbLike['batch']>,
): Promise<boolean> => {
  let changed = false;
  for (const tag of [
    KEY_LIVE_ENTITY,
    KEY_LIVE_ENTITY_FIELD,
    KEY_LIVE_ENTITY_BRANCH,
    KEY_LIVE_ENTITY_LEAF,
    KEY_LIVE_ACCOUNT,
    KEY_LIVE_ACCOUNT_BRANCH,
    KEY_LIVE_ACCOUNT_FIELD,
    KEY_LIVE_ACCOUNT_LEAF,
    KEY_LIVE_BOOK,
    KEY_LIVE_BOOK_BRANCH,
    KEY_LIVE_BOOK_LEAF,
  ] as const) {
    const prefix = Buffer.from([tag]);
    const authoritativeKeys = new Set<string>();
    for await (const key of iterateKeys(walDb, { prefix })) {
      authoritativeKeys.add(key.toString('hex'));
      const authoritative = await walDb.get(key);
      if ((await readRawOrNull(currentDb, key))?.equals(authoritative)) continue;
      batch.put(key, authoritative);
      changed = true;
    }
    for await (const key of iterateKeys(currentDb, { prefix })) {
      if (authoritativeKeys.has(key.toString('hex'))) continue;
      batch.del(key);
      changed = true;
    }
  }
  return changed;
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
  batch?: ReturnType<RuntimeDbLike['batch']>,
): Promise<boolean> => {
  const authoritativeKeys = new Set<string>();
  let changed = false;
  for await (const key of iterateKeys(walDb, { prefix: keyCertifiedBoardNodePrefix() })) {
    authoritativeKeys.add(key.toString('hex'));
    const authoritative = await walDb.get(key);
    const hash = decodeTaggedStorageHash(
      key,
      KEY_CERTIFIED_BOARD_NODE,
      'STORAGE_CERTIFIED_BOARD_NODE_KEY_INVALID',
    );
    const node = decodeValidatedBuffer(authoritative, validateCertifiedBoardNodeValue);
    const actual = hashCertifiedBoardNode(node);
    if (actual !== hash) throw new Error(`CERTIFIED_BOARD_NODE_CORRUPT:${hash}:${actual}`);
    const current = await readRawOrNull(currentDb, key);
    if (current?.equals(authoritative)) continue;
    batch?.put(key, authoritative);
    changed = true;
  }
  for await (const key of iterateKeys(currentDb, { prefix: keyCertifiedBoardNodePrefix() })) {
    if (authoritativeKeys.has(key.toString('hex'))) continue;
    batch?.del(key);
    changed = true;
  }
  return changed;
};

const synchronizeConsumptionNodes = async (
  walDb: RuntimeDbLike,
  currentDb: RuntimeDbLike,
  batch?: ReturnType<RuntimeDbLike['batch']>,
  stateDb: RuntimeDbLike = currentDb,
): Promise<boolean> => {
  const states: ConsumptionAccumulatorState[] = [];
  for await (const key of iterateKeys(stateDb, { prefix: Buffer.from([KEY_LIVE_ENTITY]) })) {
    const entityId = decodeEntityId(key.subarray(1));
    const stored = await readEntityStorageLayout(stateDb, entityId, key);
    if (!stored) throw new Error(`STORAGE_ENTITY_GRAPH_MISSING:${entityId}`);
    const doc = stored.doc;
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
    batch?.put(key, value);
    changed = true;
  }
  for await (const key of iterateKeys(currentDb, { prefix: keyConsumptionNodePrefix() })) {
    if (reachableKeys.has(key.toString('hex'))) continue;
    batch?.del(key);
    changed = true;
  }
  return changed;
};

const certifiedBoardRoot = (
  state: { certifiedBoardState?: EntityState['certifiedBoardState'] },
): string | undefined =>
  state.certifiedBoardState?.boardRegistryRoot;

const collectCertifiedBoardHistoryRoots = async (
  env: RuntimeReplica,
  walDb: RuntimeDbLike,
): Promise<Set<string>> => {
  const roots = new Set<string>();
  const remember = (root: string | undefined): void => {
    if (root) roots.add(root);
  };
  for (const { state } of env.state.eReplicas.values()) remember(certifiedBoardRoot(state));
  for (const height of await listSnapshotHeights(walDb)) {
    const docs = await readSnapshotDocs(walDb, height);
    for (const doc of docs) if (doc.family === 'entity') remember(certifiedBoardRoot(doc.value));
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
): Promise<void> => {
  if (hashes.length === 0) return;
  const batch = db.batch();
  for (const hash of hashes) batch.del(keyCertifiedBoardNode(hash));
  await writeBatch(batch);
};

const pruneUnreachableCertifiedBoardHistoryNodes = async (
  env: RuntimeReplica,
  walDb: RuntimeDbLike,
  currentDb: RuntimeDbLike,
): Promise<number> => {
  const stored = await readCertifiedBoardNodes(walDb);
  const roots = await collectCertifiedBoardHistoryRoots(env, walDb);
  const reachable = collectReachableCertifiedBoardNodes(stored.nodes, roots);
  const stale = [...stored.nodes.keys()].filter((hash) => !reachable.has(hash)).sort();
  await deleteCertifiedBoardNodes(walDb, stale);
  await deleteCertifiedBoardNodes(currentDb, stale);
  const memoryStore = getCertifiedBoardNodeStore(env);
  for (const hash of stale) memoryStore.delete(hash);
  return stale.reduce((total, hash) => total + (stored.bytes.get(hash) ?? 0), 0);
};

const pruneUnreachableConsumptionHistoryNodes = async (
  env: RuntimeReplica,
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
  batch?: ReturnType<RuntimeDbLike['batch']>,
  stateDb: RuntimeDbLike = currentDb,
): Promise<boolean> => {
  const states: AccountJClaimAccumulatorState[] = [];
  for await (const key of iterateKeys(stateDb, { prefix: Buffer.from([KEY_LIVE_ACCOUNT]) })) {
    const parsed = parseLiveAccountKey(key);
    const stored = await readAccountStorageLayout(stateDb, parsed.entityId, parsed.counterpartyId, key);
    if (!stored) throw new Error(`STORAGE_LIVE_ACCOUNT_MISSING:${key.toString('hex')}`);
    const doc = validateStorageAccountDocValue(stored.doc);
    states.push(doc.state.leftPendingJClaims, doc.state.rightPendingJClaims);
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
    batch?.put(key, value);
    changed = true;
  }
  for await (const key of iterateKeys(currentDb, { prefix: keyAccountJClaimNodePrefix() })) {
    if (reachableKeys.has(key.toString('hex'))) continue;
    batch?.del(key);
    changed = true;
  }
  return changed;
};

const assertCurrentProjectionIntegrity = async (
  currentDb: RuntimeDbLike,
  walDb: RuntimeDbLike,
  walHead: StorageHead,
): Promise<void> => {
  await verifyLiveStorageIntegrity(currentDb);
  const materializedHeight = materializedHeightOf(walHead);
  if (materializedHeight > 0) {
    const frame = await readStorageFrameRecord(walDb, materializedHeight);
    if (!frame?.canonicalEntityHashes || !frame.canonicalStateHash) {
      throw new Error(
        `STORAGE_CURRENT_PROJECTION_CANONICAL_ROOTS_MISSING:height=${materializedHeight}`,
      );
    }
  }

  const boardChanged = await synchronizeCertifiedBoardNodes(walDb, currentDb);
  const consumptionChanged = await synchronizeConsumptionNodes(walDb, currentDb);
  const accountJClaimChanged = await synchronizeAccountJClaimNodes(walDb, currentDb);
  if (boardChanged || consumptionChanged || accountJClaimChanged) {
    throw new Error(
      `STORAGE_CURRENT_NODE_PROJECTION_MISMATCH:` +
        `board=${boardChanged}:consumption=${consumptionChanged}:accountJ=${accountJClaimChanged}`,
    );
  }
};

const pruneUnreachableAccountJClaimHistoryNodes = async (
  env: RuntimeReplica,
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
      remember(doc.value.state.leftPendingJClaims);
      remember(doc.value.state.rightPendingJClaims);
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
  let prunedBytes = 0;
  for (const hash of stale) {
    batch.del(keyAccountJClaimNode(hash));
    prunedBytes += bytes.get(hash) ?? 0;
  }
  await writeBatch(batch);
  return prunedBytes;
};

export type StorageRecoveryDiagnostics = {
  /**
   * `headChanged` selects the projection-rebuild path. It was designed for a
   * cold start, so a per-frame append must never reach it. Report the decision
   * and the cost of each rebuild step instead of inferring either from a
   * frame's total open time.
   */
  headsMatch: boolean;
  headChanged: boolean;
  verifiedCurrent: boolean;
  stages: Record<string, number>;
};

const EMPTY_STORAGE_RECOVERY: { recovered: boolean; diagnostics: StorageRecoveryDiagnostics } = {
  recovered: false,
  diagnostics: { headsMatch: true, headChanged: false, verifiedCurrent: false, stages: {} },
};

export const recoverStorageDbFromHistory = async (options: {
  db: RuntimeDbLike;
  walDb: RuntimeDbLike;
  config: Required<StorageRuntimeConfig>;
  onPersistenceProgress?: StoragePersistenceProgressHook;
  verifyCurrentProjection?: boolean;
}): Promise<{ recovered: boolean; diagnostics: StorageRecoveryDiagnostics }> => {
  const recoveryStages: Record<string, number> = {};
  let stageStartedAt = getPerfMs();
  const markRecoveryStage = (name: string): void => {
    const now = getPerfMs();
    recoveryStages[name] = (recoveryStages[name] ?? 0) + (now - stageStartedAt);
    stageStartedAt = now;
  };
  const diagnosticsOf = (
    headsMatch: boolean,
    headChanged: boolean,
    verifiedCurrent: boolean,
  ): StorageRecoveryDiagnostics => ({
    headsMatch,
    headChanged,
    verifiedCurrent,
    stages: recoveryStages,
  });
  const walHead = await readHead(options.walDb, options.config);
  const rawCurrentHead = await readRawOrNull(options.db, KEY_HEAD);
  const currentHead = rawCurrentHead ? await readHead(options.db, options.config) : defaultStorageHead(options.config);
  const historyLatestHeight = Math.max(0, Math.floor(Number(walHead.latestHeight ?? 0)));
  const currentLatestHeight = Math.max(0, Math.floor(Number(currentHead.latestHeight ?? 0)));
  const historyMaterializedHeight = materializedHeightOf(walHead);
  const currentMaterializedHeight = materializedHeightOf(currentHead);
  const historySnapshotHeight = Math.max(0, Math.floor(Number(walHead.latestSnapshotHeight ?? 0)));
  options.onPersistenceProgress?.('recovery-heads-read');
  markRecoveryStage('headsRead');

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
  if (historyLatestHeight === 0) {
    return { recovered: false, diagnostics: diagnosticsOf(false, false, false) };
  }

  const headsMatch = Boolean(rawCurrentHead) && storageHeadsEqual(walHead, currentHead);
  const shouldVerifyCurrent = headsMatch && options.verifyCurrentProjection !== false;
  let currentProjectionInvalid = false;
  if (shouldVerifyCurrent) {
    await verifyStorageTailIntegrity(options.walDb);
    try {
      await assertCurrentProjectionIntegrity(
        options.db,
        options.walDb,
        walHead,
      );
      options.onPersistenceProgress?.('recovery-current-verified');
    } catch (error) {
      currentProjectionInvalid = true;
      storageLog.info('current_projection.rebuilding_from_wal', {
        error: error instanceof Error ? error.message : String(error),
        height: currentMaterializedHeight,
      });
      options.onPersistenceProgress?.('recovery-current-invalid');
    }
    markRecoveryStage('verifyCurrent');
  }
  const resetFromHistory =
    !rawCurrentHead ||
    currentMaterializedHeight < historySnapshotHeight ||
    currentProjectionInvalid;
  let recovered = false;
  if (resetFromHistory) {
    if (historySnapshotHeight > 0) {
      await verifyStorageSnapshotIntegrity(options.walDb, walHead);
      options.onPersistenceProgress?.('recovery-snapshot-verified');
    }
    await clearCurrentRecoveryState(options.db);
    options.onPersistenceProgress?.('recovery-current-cleared');
    markRecoveryStage('resetFromHistory');
    recovered = true;
  }

  const batch = options.db.batch();
  const headChanged = !rawCurrentHead || !headsMatch || currentProjectionInvalid;
  const liveStateChanged = headChanged
    ? await synchronizeLiveStateProjection(options.walDb, options.db, batch)
    : false;
  options.onPersistenceProgress?.('recovery-live-state-synchronized');
  if (headChanged) markRecoveryStage('syncLiveState');
  // History commits before the rebuildable current projection cache.
  // The normal append path writes both DBs and never scans the content-addressed
  // DAG. Only a lagging/current-cache recovery needs to copy immutable nodes.
  const boardNodesChanged = headChanged
    ? await synchronizeCertifiedBoardNodes(options.walDb, options.db, batch)
    : false;
  options.onPersistenceProgress?.('recovery-board-nodes-synchronized');
  if (headChanged) markRecoveryStage('syncBoardNodes');
  const consumptionNodesChanged = headChanged
    ? await synchronizeConsumptionNodes(options.walDb, options.db, batch, options.walDb)
    : false;
  options.onPersistenceProgress?.('recovery-consumption-nodes-synchronized');
  if (headChanged) markRecoveryStage('syncConsumptionNodes');
  const accountJClaimNodesChanged = headChanged
    ? await synchronizeAccountJClaimNodes(options.walDb, options.db, batch, options.walDb)
    : false;
  options.onPersistenceProgress?.('recovery-account-j-nodes-synchronized');
  if (headChanged) markRecoveryStage('syncAccountJNodes');
  if (
    liveStateChanged ||
    boardNodesChanged ||
    consumptionNodesChanged ||
    accountJClaimNodesChanged
  ) {
    await writeBatch(batch);
    options.onPersistenceProgress?.('recovery-current-nodes-written');
    markRecoveryStage('writeRecoveredNodes');
    recovered = true;
  }
  if (headChanged) {
    // HEAD is the publication fence for the rebuilt cache and must be last.
    const headBatch = options.db.batch();
    headBatch.put(KEY_HEAD, encodeBuffer(walHead));
    await writeBatch(headBatch);
    options.onPersistenceProgress?.('recovery-current-head-published');
    markRecoveryStage('publishHead');
    recovered = true;
  }
  const reverified = shouldVerifyCurrent || resetFromHistory || headChanged;
  if (reverified) {
    await assertCurrentProjectionIntegrity(
      options.db,
      options.walDb,
      walHead,
    );
    options.onPersistenceProgress?.('recovery-current-reverified');
    markRecoveryStage('reverifyCurrent');
  }
  return {
    recovered,
    diagnostics: diagnosticsOf(headsMatch, headChanged, shouldVerifyCurrent || reverified),
  };
};

export type StorageFrameSaveResult = {
  materialized: boolean;
  materializedOverlayKeys: readonly string[];
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

type StoragePersistencePerf = {
  /**
   * Time owned by the Runtime storage wrapper rather than the canonical
   * LevelDB commit itself. Keeping this split explicit prevents a slow lock,
   * history projection, or post-commit cleanup from being blamed on LevelDB.
   */
  outerStages?: Record<string, number>;
  /**
   * Split of the `open` window: two cached db handles plus one recovery
   * decision. `openDecision.headChanged` selects the cold projection-rebuild
   * path, which must never be taken by a live append.
   */
  openStages?: Record<string, number>;
  openDecision?: {
    headsMatch: boolean;
    headChanged: boolean;
    verifiedCurrent: boolean;
    recovered: boolean;
  };
  outerTotal?: number;
  open: number;
  planning: number;
  planningStages: Record<string, number>;
  diff: number;
  prepare: number;
  prepareStages: Record<string, number>;
  authoritativeWrite: number;
  historyView: number;
  currentCacheWrite: number;
  postCommit: number;
  snapshot: number;
  total: number;
};

export type StorageFrameSaveOptions = {
  env: RuntimeReplica;
  stateHash?: string;
  currentFrameInput?: RuntimeInput;
  currentFrameOutputs?: RoutedEntityInput[];
  pendingRuntimeInput?: RuntimeInput;
  historyRecords?: RuntimeHistoryRecord[];
  entityContexts: Map<string, import('../types/entity/infra-context').EntityInfraContext>;
  /**
   * True only for the live Runtime commit that just applied these objects.
   * Recovery, tests, and any other writer keep the default full parse.
   */
  inProcessInfraValidated?: boolean;
  tryOpenDb: (env: RuntimeReplica) => Promise<boolean>;
  getRuntimeDb: (env: RuntimeReplica) => RuntimeDbLike;
  tryOpenRuntimeWalDb: (env: RuntimeReplica) => Promise<boolean>;
  getRuntimeWalDb: (env: RuntimeReplica) => RuntimeDbLike;
  tryOpenHistoryViewDb: (env: RuntimeReplica) => Promise<boolean>;
  getHistoryViewDb: (env: RuntimeReplica) => RuntimeDbLike;
  rotateEpochDb?: (env: RuntimeReplica, snapshotHeight: number, timestamp: number) => Promise<boolean | void>;
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
    await recoverStorageDbFromHistory({
      db,
      walDb,
      config,
      verifyCurrentProjection: true,
      ...(options.onPersistenceProgress
        ? { onPersistenceProgress: options.onPersistenceProgress }
        : {}),
    });
    const snapshot = await createSnapshot(
      db,
      walDb,
      options.env.state.height,
      options.env.state.timestamp,
      options.onPersistenceBoundary,
    );
    snapshotDocs = snapshot.docCount;
    snapshotBytes = snapshot.bytes;
    retainedHistoryBytes += snapshotBytes;
    latestSnapshotHeight = options.env.state.height;
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
    const firstWalHeight = (await listSnapshotHeights(walDb))[0] ?? latestSnapshotHeight;
    if (!(await options.tryOpenHistoryViewDb(options.env))) {
      throw new Error(`HISTORY_VIEW_DB_OPEN_FAILED:wal-floor=${firstWalHeight}`);
    }
    await pruneHistoryViewRetention({
      db: options.getHistoryViewDb(options.env),
      height: options.env.state.height,
      head: await readHistoryViewHead(options.getHistoryViewDb(options.env), config),
      config,
      firstWalHeight,
      ...(options.onPersistenceBoundary
        ? { onPersistenceBoundary: options.onPersistenceBoundary }
        : {}),
    });
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
      options.env.state.timestamp,
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
  if (!config.enabled || options.env.infrastructure?.persistencePaused) {
    return {
      skipped: {
        materialized: false,
        materializedOverlayKeys: [],
        historyViewsMaterialized: true,
      } satisfies StorageFrameSaveResult,
    };
  }
  const openStartedAt = options.getPerfMs();
  if (!(await options.tryOpenDb(options.env))) {
    throw new Error('STORAGE_CURRENT_DB_UNAVAILABLE');
  }
  const db = options.getRuntimeDb(options.env);
  const currentDbOpenedAt = options.getPerfMs();
  if (!(await options.tryOpenRuntimeWalDb(options.env))) {
    throw new Error('STORAGE_RUNTIME_WAL_UNAVAILABLE');
  }
  const walDb = options.getRuntimeWalDb(options.env);
  const walDbOpenedAt = options.getPerfMs();
  const state = options.env.infrastructure ??= {};
  /*
   * Reconciling `current` against the WAL answers one question: what did this
   * process inherit on disk? It is settled when the namespace opens. This
   * process then holds the writer lock and is the only author of both DBs, so
   * a committing frame re-reading three HEADs to re-derive an answer it just
   * wrote is pure per-frame tax. Any divergence after that point is a defect
   * in this process, and a silent re-sync would hide it rather than fix it.
   */
  const recovery = state.storageHistoryRecovered === true
    ? EMPTY_STORAGE_RECOVERY
    : await recoverStorageDbFromHistory({
      db,
      walDb,
      config,
      verifyCurrentProjection: state.storageCurrentProjectionVerified !== true,
      ...(options.onPersistenceProgress
        ? { onPersistenceProgress: options.onPersistenceProgress }
        : {}),
    });
  state.storageCurrentProjectionVerified = true;
  state.storageHistoryRecovered = true;
  options.onPersistenceProgress?.('opened');
  const openMs = options.getPerfMs() - openStartedAt;
  // The `open` window covers two cached db handles and one recovery decision.
  // Report that split so a rebuild taken on the append path is never read as
  // the cost of opening LevelDB.
  const openStages: Record<string, number> = {
    currentDb: currentDbOpenedAt - openStartedAt,
    walDb: walDbOpenedAt - currentDbOpenedAt,
    recovery: options.getPerfMs() - walDbOpenedAt,
    ...recovery.diagnostics.stages,
  };
  const openDecision = {
    headsMatch: recovery.diagnostics.headsMatch,
    headChanged: recovery.diagnostics.headChanged,
    verifiedCurrent: recovery.diagnostics.verifiedCurrent,
    recovered: recovery.recovered,
  };
  const head = await readHead(walDb, config);
  const appliedRuntimeInput =
    options.currentFrameInput ?? { runtimeTxs: [], entityInputs: [] };
  const canonicalAppliedRuntimeInput = canonicalizeBinaryPayload(
    appliedRuntimeInput,
    { omitSymbolKeys: true },
  ) as RuntimeInput;
  const finiteEpochByteBudget = config.epochMaxBytes !== Number.MAX_SAFE_INTEGER;
  const appliedRuntimeInputBytes = finiteEpochByteBudget
    ? encodeBufferPrepared(canonicalAppliedRuntimeInput, { omitSymbolKeys: true }).buffer.byteLength
    : 0;
  const snapshotRequested =
    options.env.state.height === 1 ||
    options.env.state.height - head.latestSnapshotHeight >= config.snapshotPeriodFrames;
  const snapshotRequiredByBytesRequested =
    finiteEpochByteBudget &&
    head.epochReplayBytes + appliedRuntimeInputBytes >= config.epochMaxBytes;
  const materializationRequested =
    options.env.state.height === 1 ||
    options.env.state.height - head.latestMaterializedHeight >= config.materializePeriodFrames ||
    snapshotRequested ||
    snapshotRequiredByBytesRequested;
  const checkpointEligible =
    !materializationRequested || areStorageCheckpointReplicasQuiescent(options.env);
  const snapshotDue = snapshotRequested && checkpointEligible;
  const snapshotRequiredByBytes = snapshotRequiredByBytesRequested && checkpointEligible;
  const shouldMaterialize = materializationRequested && checkpointEligible;

  const planningStartedAt = options.getPerfMs();
  const planningMarks: Record<string, number> = {};
  const checkpoint = (label: string): void => {
    planningMarks[label] = options.getPerfMs() - planningStartedAt;
  };
  const frameOverlayRecords = state.currentStorageOverlayMarks instanceof Map
    ? Array.from(state.currentStorageOverlayMarks.values(), record => ({ ...record }))
    : [];
  const overlayRecords = mergeOverlayRecordsIntoEnv(options.env, []);
  const frameTouched = storageRefsFromOverlay(frameOverlayRecords);
  checkpoint('overlay');
  const checkpointedLineagePlan = shouldMaterialize
    ? buildRuntimeCheckpointLineagePlan(options.env)
    : null;
  if (shouldMaterialize) {
    for (const replica of options.env.state.eReplicas.values()) {
      auditEntityStateRootAtCheckpoint(replica.state);
    }
  }
  const lineagePlan =
    checkpointedLineagePlan ?? buildLiveReplicaMetaPlan(options.env);
  // Both plans carry the sorted live-replica lookup; building it a second
  // time was one more O(replicas log replicas) pass per frame.
  const replicaLookup = lineagePlan.lookup;
  checkpoint('lineage');
  // Projected and canonicalized once: post-state view, machine snapshot and
  // the WAL frame all hash/encode this same durable pending mempool tree.
  const durablePendingInput = canonicalizeBinaryPayload(
    buildDurableRuntimeMempool(
      options.pendingRuntimeInput ?? options.env.runtimeMempool,
    ),
    { omitSymbolKeys: true },
  ) as RuntimeInput;
  const planningMs = options.getPerfMs() - planningStartedAt;
  const planningStages = cumulativeMarksToDurations(planningMarks, planningMs);
  if (OP_COUNTERS_ENABLED) {
    for (const [stage, ms] of Object.entries(planningStages)) countOp(`storage.planning.${stage}`, 0, Math.round(ms * 1_000));
  }
  return {
    config,
    state,
    db,
    walDb,
    head,
    appliedRuntimeInput: canonicalAppliedRuntimeInput,
    durablePendingInput,
    snapshotDue,
    snapshotRequiredByBytes,
    shouldMaterialize,
    openStartedAt,
    openMs,
    openStages,
    openDecision,
    planningMs,
    planningStages,
    overlayRecords,
    frameTouched,
    checkpointedLineagePlan,
    lineagePlan,
    replicaLookup,
  };
};

type PreparedStorageFrameSave = Exclude<
  Awaited<ReturnType<typeof prepareStorageFrameSave>>,
  { skipped: StorageFrameSaveResult }
>;

const FRAME_ENCODE_SUBSTAGE_PROFILE =
  typeof process !== 'undefined' && process.env?.['XLN_STORAGE_FRAME_ENCODE_PROFILE'] === '1';

// The previous frame record is read back only for its hash; the frame this
// process just wrote is that record. Multi-megabyte Hub frames cost ~27 ms
// per decode, so the last written (height, hash) per WAL db is remembered.
const lastWrittenFrameHash = new Map<RuntimeDbLike, { height: number; hash: string }>();

const resolveStorageAppendPosition = async (
  options: StorageFrameSaveOptions,
  walDb: RuntimeDbLike,
  head: StorageHead,
): Promise<
  | { staleWriterStopped: true }
  | { previousFrame: RuntimeFrame | null; prevFrameHash: string }
> => {
  if (options.stopStaleWriterOnHeadAhead) {
    if (head.latestHeight > options.env.state.height) {
      return { staleWriterStopped: true };
    }
    if (head.latestHeight === options.env.state.height) {
      const persisted = await readStorageFrameRecord(
        walDb,
        options.env.state.height,
      );
      if (persisted) return { staleWriterStopped: true };
    }
  }
  if (head.latestHeight !== options.env.state.height - 1) {
    throw new Error(
      `STORAGE_APPEND_INVARIANT_FAILED: refusing to write frame ` +
      `${options.env.state.height} after persisted head ${head.latestHeight}`,
    );
  }
  const remembered = lastWrittenFrameHash.get(walDb);
  if (remembered && remembered.height === head.latestHeight && head.latestHeight > 0) {
    return { previousFrame: null, prevFrameHash: remembered.hash };
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

const collectPendingStorageNodes = (env: RuntimeReplica) => {
  const state = env.infrastructure ?? {};
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
  env: RuntimeReplica,
  checkpointed: boolean,
  commitment: ReturnType<typeof buildStorageLiveReplicaMetaCommitment>,
): void => {
  if (process.env['XLN_STORAGE_DEBUG_REPLICA_META'] !== '1') return;
  storageLog.info('replica_meta.debug', {
    height: env.state.height,
    digest: commitment.digest,
    checkpoint: checkpointed,
    consumptionNodes: getConsumptionNodeStore(env).size,
    consumptionRoots: [...env.state.eReplicas.values()].map(replica => ({
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

const bookCacheKey = (entityId: string, pairId: string): string => `${entityId}\u0000${pairId}`;

const prepareBookGraphWrites = async (
  prepared: PreparedStorageFrameSave,
  putsToMaterialize: readonly StorageDoc[],
  delsToMaterialize: readonly StorageDocRef[],
): Promise<Readonly<{
  puts: readonly Readonly<{ key: Buffer; value: Buffer }>[];
  dels: readonly Buffer[];
  cachePuts: ReadonlyMap<string, import('../orderbook/core').BookState>;
  cacheDels: ReadonlySet<string>;
}>> => {
  const cache = prepared.state.storagePersistedBooks instanceof Map
    ? prepared.state.storagePersistedBooks as Map<string, import('../orderbook/core').BookState>
    : new Map<string, import('../orderbook/core').BookState>();
  const puts: Array<Readonly<{ key: Buffer; value: Buffer }>> = [];
  const dels: Buffer[] = [];
  const cachePuts = new Map<string, import('../orderbook/core').BookState>();
  const cacheDels = new Set<string>();
  const bookPuts = putsToMaterialize
    .filter((doc): doc is Extract<StorageDoc, { family: 'book' }> => doc.family === 'book')
    .sort((left, right) => `${left.entityId}\u0000${left.pairId}`.localeCompare(`${right.entityId}\u0000${right.pairId}`));
  for (const doc of bookPuts) {
    const key = bookCacheKey(doc.entityId, doc.pairId);
    const planned = await prepareStorageBookGraphWrite({
      db: prepared.db,
      entityId: doc.entityId,
      pairId: doc.pairId,
      next: doc.value,
      ...(cache.has(key) ? { previous: cache.get(key)! } : {}),
    });
    puts.push(...planned.puts);
    dels.push(...planned.dels);
    cachePuts.set(key, doc.value);
    cacheDels.delete(key);
  }
  for (const ref of delsToMaterialize.filter(
    (candidate): candidate is Extract<StorageDocRef, { family: 'book' }> => candidate.family === 'book',
  )) {
    const key = bookCacheKey(ref.entityId, ref.pairId);
    const planned = await prepareStorageBookGraphWrite({
      db: prepared.db,
      entityId: ref.entityId,
      pairId: ref.pairId,
      next: null,
      ...(cache.has(key) ? { previous: cache.get(key)! } : {}),
    });
    dels.push(...planned.dels);
    cachePuts.delete(key);
    cacheDels.add(key);
  }
  return { puts, dels, cachePuts, cacheDels };
};

const prepareStorageStateCommitments = async (
  options: StorageFrameSaveOptions,
  prepared: PreparedStorageFrameSave,
  previousFrame: RuntimeFrame | null,
  checkpoint: (label: string) => void,
) => {
  const {
    db,
    walDb,
    state,
    config,
    shouldMaterialize,
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
  const materializedEntityStates = materializedTouched
    ? buildEntityStatePuts(options.env, materializedTouched, replicaLookup)
    : [];
  const materializedDels = shouldMaterialize
    ? buildBookDeletionsFromOverlay(overlayRecords)
    : [];
  const liveStateGraph = shouldMaterialize
    ? await prepareLiveStateGraph({
        db,
        puts: materializedPuts,
        entityStates: materializedEntityStates,
        dels: materializedDels,
        ...(state.storagePersistedAccounts instanceof Map
          ? { previousAccounts: state.storagePersistedAccounts }
          : {}),
        ...(state.storagePersistedEntities instanceof Map
          ? { previousEntities: state.storagePersistedEntities }
          : {}),
      })
    : null;
  options.onPersistenceProgress?.('materialized-graph-built');
  checkpoint('materializedGraph');

  const bookGraphWrites = shouldMaterialize
    ? await prepareBookGraphWrites(prepared, materializedPuts, materializedDels)
    : {
        puts: [],
        dels: [],
        cachePuts: new Map(),
        cacheDels: new Set(),
      };
  checkpoint('bookGraph');

  const canonicalHashDue = shouldMaterialize || (
    config.canonicalHashPeriodFrames > 0 &&
    (options.env.state.height === 1 ||
      options.env.state.height % config.canonicalHashPeriodFrames === 0)
  );
  const runtimeComponentDigests = computeRuntimePostStateComponentDigests(
    buildReplayVerifiableRuntimePostStateView(options.env, {
      // Output bodies are immutable rows. Per-frame replay authority commits
      // their ordered refs below instead of serializing the same envelopes.
      pendingNetworkOutputs: [],
      durableRuntimeInput: prepared.durablePendingInput,
      excludePersistedHistoryRecords: true,
    }),
  );
  const runtimeMachine = shouldMaterialize || canonicalHashDue
    ? buildStorageRuntimeMachineSnapshot(options.env, {
        durableRuntimeInput: prepared.durablePendingInput,
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

  const replicaMetaStateMode: RuntimeFrame['replicaMetaStateMode'] =
    checkpointedLineagePlan
      ? 'shared-entity-state'
      : 'live-head';
  const replicaMetaCommitment = checkpointedLineagePlan
    ? buildStorageReplicaMetaCommitmentFromCheckpointPlan(
        options.env,
        lineagePlan,
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
    liveStateGraph,
    runtimeComponentDigests,
    runtimeMachine,
    runtimeStateHashes,
    replicaMetaStateMode,
    replicaMetaCommitment,
    replicaMetaEntries,
    liveReplicaMetaKeys,
    staleReplicaMetaKeys,
    bookGraphWrites,
  };
};

type PreparedStorageCommitments = Awaited<
  ReturnType<typeof prepareStorageStateCommitments>
>;

type StorageFrameTouchSummary = {
  frameLogs: FrameLogEntry[];
  touchedEntities: string[];
  touchedAccounts: Array<{ entityId: string; counterpartyId: string }>;
  touchedBookEntities: string[];
};

const summarizeStorageFrameTouches = (
  options: StorageFrameSaveOptions,
  prepared: PreparedStorageFrameSave,
): StorageFrameTouchSummary => ({
  frameLogs: readRuntimeFrameEvents(options.env),
  touchedEntities: [...prepared.frameTouched.touchedEntities.values()].sort(),
  touchedAccounts: [...prepared.frameTouched.touchedAccounts.values()]
    .filter(
      (ref): ref is Extract<StorageDocRef, { family: 'account' }> =>
        ref.family === 'account',
    )
    .map(ref => ({
      entityId: ref.entityId,
      counterpartyId: ref.counterpartyId,
    })),
  touchedBookEntities:
    [...prepared.frameTouched.touchedBookEntities.values()].sort(),
});

const buildStorageRuntimeFrame = (
  options: StorageFrameSaveOptions,
  prepared: PreparedStorageFrameSave,
  commitments: PreparedStorageCommitments,
  prevFrameHash: string,
  touches: StorageFrameTouchSummary,
  runtimeOutputRefs: readonly RuntimeOutputPayloadHash[],
  entityContextRefs: ReadonlyMap<string, EntityContextPayloadHash>,
  runtimeMachineRoot: import('./types').RuntimeMachineGraphRoot | undefined,
): RuntimeFrame => {
  const {
    appliedRuntimeInput,
    shouldMaterialize,
    checkpointedLineagePlan,
    durablePendingInput,
  } = prepared;
  const hasPendingInput =
    durablePendingInput.runtimeTxs.length > 0 ||
    durablePendingInput.entityInputs.length > 0 ||
    (durablePendingInput.jInputs?.length ?? 0) > 0;
  return {
    height: options.env.state.height,
    timestamp: options.env.state.timestamp,
    prevFrameHash,
    replicaMetaDigest: commitments.replicaMetaCommitment.digest,
    replicaMetaCheckpoint: checkpointedLineagePlan !== null,
    replicaMetaStateMode: commitments.replicaMetaStateMode,
    postStateHash: computeStoragePostStateHash({
      height: options.env.state.height,
      timestamp: options.env.state.timestamp,
      replicaMetaDigest: commitments.replicaMetaCommitment.digest,
      runtimeComponentDigests: commitments.runtimeComponentDigests,
      runtimeOutputRefs,
    }),
    materializedState: shouldMaterialize,
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
    ...(entityContextRefs.size > 0
      ? { entityContextRefs: new Map(entityContextRefs) }
      : {}),
    ...(hasPendingInput ? { pendingRuntimeInput: durablePendingInput } : {}),
    ...(runtimeMachineRoot
      ? { runtimeMachineRoot }
      : {}),
    ...(runtimeOutputRefs.length > 0
      ? { runtimeOutputRefs: [...runtimeOutputRefs] }
      : {}),
    touchedEntities: touches.touchedEntities,
    touchedAccounts: touches.touchedAccounts,
    touchedBookEntities: touches.touchedBookEntities,
  };
};

const WAL_SYNC_ENABLED = process.env['XLN_STORAGE_WAL_SYNC'] !== '0';

const buildStorageFrameRecordPlan = (
  options: StorageFrameSaveOptions,
  prepared: PreparedStorageFrameSave,
  commitments: PreparedStorageCommitments,
  pendingNodes: ReturnType<typeof collectPendingStorageNodes>,
  prevFrameHash: string,
  mark: (label: string) => void = () => {},
) => {
  const touches = summarizeStorageFrameTouches(options, prepared);
  mark('frameEncode.touches');
  const outputPayloads = prepareRuntimeOutputPayloadRows(
    options.currentFrameOutputs ?? [],
  );
  mark('frameEncode.outputPayloads');
  const entityContextPayloads = prepareEntityContextPayloadRows(
    options.entityContexts,
    options.inProcessInfraValidated === true,
  );
  mark('frameEncode.entityContexts');
  const runtimeMachineGraph = prepareRuntimeMachineGraphRows(
    options.env.state.height,
    commitments.runtimeMachine,
  );
  mark('frameEncode.machineGraph');
  // Canonicalized once: the frame hash and the stored record both encode
  // this multi-megabyte input log, and a canonical tree skips the walk.
  const frameBase = canonicalizeBinaryPayload(buildStorageRuntimeFrame(
    options,
    prepared,
    commitments,
    prevFrameHash,
    touches,
    outputPayloads.refs,
    entityContextPayloads.refs,
    runtimeMachineGraph.root,
  ), { omitSymbolKeys: true });
  mark('frameEncode.frameBase');
  const frameRecord = {
    ...frameBase,
    frameHash: computeStorageFrameHash(frameBase),
  } satisfies RuntimeFrame;
  mark('frameEncode.frameHash');
  const frameKey = keyFrame(options.env.state.height);
  const frameBuffer = encodeBuffer(frameRecord, { omitSymbolKeys: true });
  const frameRows = prepareBoundedStorageValueRows(frameKey, frameBuffer);
  mark('frameEncode.frameBuffer');
  const nodeBytes =
    pendingNodes.boardHistoryBytes +
    pendingNodes.consumptionHistoryBytes +
    pendingNodes.accountJClaimHistoryBytes;
  const authoritativeBaseBytes =
    boundedStorageRowsBytes(frameRows) +
    nodeBytes +
    outputPayloads.rows.reduce(
      (total, row) => total + row.key.byteLength + row.value.byteLength,
      0,
    ) +
    entityContextPayloads.rows.reduce(
      (total, row) => total + row.key.byteLength + row.value.byteLength,
      0,
    ) +
    runtimeMachineGraph.rows.reduce(
      (total, row) => total + row.key.byteLength + row.value.byteLength,
      0,
    );
  return {
    frameKey,
    frameHash: frameRecord.frameHash,
    frameBuffer,
    frameRows,
    outputPayloadRows: outputPayloads.rows,
    entityContextPayloadRows: entityContextPayloads.rows,
    runtimeMachineGraphRows: runtimeMachineGraph.rows,
    frameLogs: touches.frameLogs,
    touchedEntities: touches.touchedEntities,
    touchedAccounts: touches.touchedAccounts,
    touchedBookEntities: touches.touchedBookEntities,
    certifiedHistoryPuts: (() => {
      // Certified-frame history serves API pages (account frame / swap history);
      // it re-encodes every Entity and Account frame per Runtime frame. Load
      // runs switch it off with XLN_STORAGE_CERTIFIED_HISTORY=0.
      if (process.env['XLN_STORAGE_CERTIFIED_HISTORY'] === '0') return [];
      const puts = buildCertifiedFramePuts({
        height: options.env.state.height,
        timestamp: options.env.state.timestamp,
        historyRecords: options.historyRecords ?? [],
        // These records are outputs of the canonical Entity/Account transitions
        // applied above. Foreign and recovered bytes still pass the full schema
        // validators on every read and conflict comparison.
        validatedInProcess: true,
      });
      mark('frameEncode.certifiedPuts');
      return puts;
    })(),
    historyViewPuts: buildHistoryViewPuts({
      height: options.env.state.height,
      timestamp: options.env.state.timestamp,
      logs: touches.frameLogs,
      touchedEntities: touches.touchedEntities,
      touchedAccounts: touches.touchedAccounts,
      touchedBookEntities: touches.touchedBookEntities,
    }),
    highSignalEvents: touches.frameLogs
      .map(entry => typeof entry?.message === 'string' ? entry.message : '')
      .filter(message => [
        'HtlcReceived',
        'HtlcFinalized',
        'HtlcFailed',
        'JEventReceived',
        'JBatchQueued',
      ].includes(message)),
    authoritativeBaseBytes,
  };
};

type RuntimeFramePlan = ReturnType<typeof buildStorageFrameRecordPlan>;

const certifiedFrameValuesMatch = (
  key: Buffer,
  existing: Buffer,
  candidate: Buffer,
): boolean => {
  if (buffersEqual(existing, candidate)) return true;
  if (key[0] === HISTORY_VIEW_ACCOUNT_FRAME) {
    const { accountHeight } = parseHistoryViewAccountFrameKey(key);
    const left = decodeValidatedBuffer(existing, value =>
      validateStoredAccountFrameValue(value, accountHeight));
    const right = decodeValidatedBuffer(candidate, value =>
      validateStoredAccountFrameValue(value, accountHeight));
    return encodeCanonicalConsensusValue(left.frame) === encodeCanonicalConsensusValue(right.frame);
  }
  if (key[0] === HISTORY_VIEW_ENTITY_FRAME) {
    const { entityHeight } = parseHistoryViewEntityFrameKey(key);
    const left = decodeValidatedBuffer(existing, value =>
      validateStoredEntityFrameValue(value, entityHeight));
    const right = decodeValidatedBuffer(candidate, value =>
      validateStoredEntityFrameValue(value, entityHeight));
    // Validators of one Entity hold different, individually valid certificate
    // variants of the same committed frame, and they reach this key on
    // different Runtime frames. `recordEntityFrameHistory` already collapses
    // the variants it sees inside a single Runtime frame; across frames the
    // stored variant is simply the first durable one. The frame hash is the
    // identity of the immutable body, so a differing hash is a real fork and
    // still conflicts.
    return left.link.frame.hash === right.link.frame.hash;
  }
  if (key[0] === HISTORY_VIEW_ACCOUNT_SWAP_EVENT || key[0] === HISTORY_VIEW_ACCOUNT_SWAP_RECENCY) {
    const accountHeight = key[0] === HISTORY_VIEW_ACCOUNT_SWAP_RECENCY
      ? parseHistoryViewAccountSwapRecencyKey(key).accountHeight
      : decodeHeight(key, key.byteLength - 8);
    const left = decodeValidatedBuffer(existing, value =>
      validateStoredAccountSwapEventValue(value, accountHeight));
    const right = decodeValidatedBuffer(candidate, value =>
      validateStoredAccountSwapEventValue(value, accountHeight));
    return encodeCanonicalConsensusValue(left.tx) === encodeCanonicalConsensusValue(right.tx);
  }
  throw new Error(`STORAGE_CERTIFIED_FRAME_KEY_INVALID:${key.toString('hex')}`);
};

const prepareCertifiedHistoryPuts = async (
  walDb: RuntimeDbLike,
  planned: HistoryViewPut[],
): Promise<HistoryViewPut[]> => {
  const accepted: HistoryViewPut[] = [];
  const seen = new Map<string, Buffer>();
  // Existence probes are independent point reads; issue them together instead
  // of one awaited round trip per certified frame.
  const persisted = await Promise.all(planned.map(put => readBoundedEncodedValue(walDb, put.key)));
  for (const [index, put] of planned.entries()) {
    const keyHex = put.key.toString('hex');
    const existing = seen.get(keyHex) ?? persisted[index];
    if (existing) {
      if (!certifiedFrameValuesMatch(put.key, existing, put.value)) {
        throw new Error(`STORAGE_CERTIFIED_FRAME_CONFLICT:${keyHex}`);
      }
      continue;
    }
    seen.set(keyHex, put.value);
    accepted.push(put);
  }
  return accepted;
};

const buildStorageCommitBatches = (
  options: StorageFrameSaveOptions,
  prepared: PreparedStorageFrameSave,
  commitments: PreparedStorageCommitments,
  pendingNodes: ReturnType<typeof collectPendingStorageNodes>,
  frame: RuntimeFramePlan,
  certifiedHistoryPuts: HistoryViewPut[],
) => {
  const walBatch = prepared.walDb.batch();
  const certifiedHistoryRows = certifiedHistoryPuts.flatMap(put =>
    prepareBoundedStorageValueRows(put.key, put.value));
  const activityHistoryRows = frame.historyViewPuts.flatMap(put =>
    prepareBoundedStorageValueRows(put.key, put.value));
  for (const key of commitments.staleReplicaMetaKeys) walBatch.del(key);
  for (const entry of pendingNodes.boardEntries) {
    walBatch.put(entry.key, entry.value);
  }
  for (const [hash, node] of pendingNodes.consumptionNodes) {
    walBatch.put(keyConsumptionNode(hash), encodeBuffer(node));
  }
  for (const [hash, node] of pendingNodes.accountJClaimNodes) {
    walBatch.put(keyAccountJClaimNode(hash), encodeBuffer(node));
  }
  for (const row of frame.frameRows) walBatch.put(row.key, row.value);
  for (const row of frame.outputPayloadRows) {
    walBatch.put(row.key, row.value);
  }
  for (const row of frame.entityContextPayloadRows) {
    walBatch.put(row.key, row.value);
  }
  for (const row of frame.runtimeMachineGraphRows) {
    walBatch.put(row.key, row.value);
  }
  // The synced WAL DB also owns the latest materialized direct state graph.
  // Mirroring the exact graph mutations here prevents a crash between the
  // authoritative commit and the disposable current-cache write from losing
  // Patricia pages that cannot be reconstructed from header-only documents.
  if (prepared.shouldMaterialize) {
    const graph = commitments.liveStateGraph;
    if (!graph) throw new Error('STORAGE_MATERIALIZED_GRAPH_MISSING');
    for (const key of graph.dels) walBatch.del(key);
    for (const row of graph.puts) walBatch.put(row.key, row.value);
    for (const key of commitments.bookGraphWrites.dels) walBatch.del(key);
    for (const row of commitments.bookGraphWrites.puts) {
      walBatch.put(row.key, row.value);
    }
  }
  for (const row of certifiedHistoryRows) walBatch.put(row.key, row.value);
  for (const row of activityHistoryRows) walBatch.put(row.key, row.value);
  for (const entry of commitments.replicaMetaEntries) {
    // Recovery metadata shares the authoritative batch with frame and HEAD.
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
  for (const [hash, node] of pendingNodes.consumptionNodes) {
    currentBatch.put(keyConsumptionNode(hash), encodeBuffer(node));
  }
  for (const hash of safeConsumptionDeletes) {
    currentBatch.del(keyConsumptionNode(hash));
  }
  for (const [hash, node] of pendingNodes.accountJClaimNodes) {
    currentBatch.put(keyAccountJClaimNode(hash), encodeBuffer(node));
  }
  for (const hash of safeAccountJClaimDeletes) {
    currentBatch.del(keyAccountJClaimNode(hash));
  }
  const graph = commitments.liveStateGraph;
  if (graph) {
    for (const key of graph.dels) currentBatch.del(key);
    for (const item of graph.puts) {
      currentBatch.put(item.key, item.value);
    }
  }
  for (const key of commitments.bookGraphWrites.dels) currentBatch.del(key);
  for (const row of commitments.bookGraphWrites.puts) currentBatch.put(row.key, row.value);

  // Certified/activity rows are rebuildable indexes with their own retention
  // budget. Only the chained frame, immutable payloads and checkpoint graph
  // count toward the authoritative WAL epoch budget.
  const committedHistoryBytes = frame.authoritativeBaseBytes;
  const nextHead: StorageHead = {
    schemaVersion: STORAGE_SCHEMA_VERSION,
    latestHeight: options.env.state.height,
    latestMaterializedHeight: prepared.shouldMaterialize
      ? options.env.state.height
      : Math.max(
          0,
          Math.floor(Number(prepared.head.latestMaterializedHeight ?? 0)),
        ),
    latestSnapshotHeight: prepared.head.latestSnapshotHeight,
    snapshotPeriodFrames: prepared.config.snapshotPeriodFrames,
    retainSnapshots: prepared.config.retainSnapshots,
    epochMaxBytes: prepared.config.epochMaxBytes,
    accountMerkleRadix: prepared.config.accountMerkleRadix,
    epochReplayBytes: prepared.head.epochReplayBytes + committedHistoryBytes,
    retainedHistoryBytes: prepared.head.retainedHistoryBytes + committedHistoryBytes,
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
  frame: RuntimeFramePlan,
  batches: StorageCommitBatches,
  writeStartedAt: number,
  prepareMarks: Record<string, number>,
) => {
  const prepareStartedAt = options.getPerfMs();
  const prepareMs = prepareStartedAt - writeStartedAt;
  const prepareStages = cumulativeMarksToDurations(prepareMarks, prepareMs);
  if (OP_COUNTERS_ENABLED) {
    for (const [stage, ms] of Object.entries(prepareStages)) countOp(`storage.prepare.${stage}`, 0, Math.round(ms * 1_000));
  }
  options.onPersistenceProgress?.('authoritative-write-start');
  // This synced WAL batch is the only frame commit point. Everything before it
  // is discardable planning; everything after it must recover forward.
  // Load-test user Runtimes may trade durability for I/O (XLN_STORAGE_WAL_SYNC=0);
  // a Hub keeps the fsync.
  await writeBatch(batches.walBatch, { sync: WAL_SYNC_ENABLED });
  const authoritativeWriteMs = options.getPerfMs() - prepareStartedAt;
  options.onPersistenceProgress?.('authoritative-write-done');
  await options.onPersistenceBoundary?.('after-authoritative-history-commit');

  let historyViewBytes = 0;
  let historyViewsMaterialized = frame.historyViewPuts.length === 0;
  let viewMaterializedThrough = 0;
  // Only the WAL above is durability-critical. The history view and the
  // current-state cache are both rebuildable projections of it, so they are
  // written without fsync and concurrently with each other; the frame still
  // does not complete until both writes returned.
  const historyViewStartedAt = options.getPerfMs();
  const historyViewWrite = frame.historyViewPuts.length > 0
    ? (async () => {
        if (!(await options.tryOpenHistoryViewDb(options.env))) {
          throw new Error(
            `HISTORY_VIEW_DB_OPEN_FAILED:height=${options.env.state.height}`,
          );
        }
        return reconcileHistoryViews({
          viewDb: options.getHistoryViewDb(options.env),
          firstWalHeight: async () => (await listSnapshotHeights(prepared.walDb))[0] ?? 1,
          latestWalHeight: options.env.state.height,
          latestWalPuts: frame.historyViewPuts,
          readWalFrame: height =>
            readStorageFrameRecord(prepared.walDb, height),
          readWalActivity: height =>
            readHistoryViewRuntimeActivity(prepared.walDb, height),
          config: prepared.config,
        });
      })()
    : Promise.resolve(null);
  const currentWriteStartedAt = options.getPerfMs();
  options.onPersistenceProgress?.('current-cache-write-start');
  let currentCacheWriteMs = 0;
  const currentWrite = writeBatch(batches.currentBatch, { sync: false }).then(() => {
    currentCacheWriteMs = options.getPerfMs() - currentWriteStartedAt;
  });
  const [reconciled] = await Promise.all([historyViewWrite, currentWrite]);
  if (reconciled) {
    historyViewBytes = reconciled.writtenBytes;
    viewMaterializedThrough =
      reconciled.materializedThroughRuntimeHeight;
    historyViewsMaterialized = true;
    await options.onPersistenceBoundary?.('after-history-view-commit');
  }
  const historyViewMs = options.getPerfMs() - historyViewStartedAt;
  if (prepared.shouldMaterialize) {
    options.env.infrastructure ??= {};
    const bookCache = options.env.infrastructure.storagePersistedBooks instanceof Map
      ? options.env.infrastructure.storagePersistedBooks
      : new Map();
    for (const key of commitments.bookGraphWrites.cacheDels) bookCache.delete(key);
    for (const [key, book] of commitments.bookGraphWrites.cachePuts) bookCache.set(key, book);
    options.env.infrastructure.storagePersistedBooks = bookCache;
    const accountCache = options.env.infrastructure.storagePersistedAccounts instanceof Map
      ? options.env.infrastructure.storagePersistedAccounts
      : new Map();
    for (const key of commitments.liveStateGraph?.accountCacheDels ?? []) accountCache.delete(key);
    for (const [key, account] of commitments.liveStateGraph?.accountCachePuts ?? []) {
      accountCache.set(key, account);
    }
    options.env.infrastructure.storagePersistedAccounts = accountCache;
    const entityCache = options.env.infrastructure.storagePersistedEntities instanceof Map
      ? options.env.infrastructure.storagePersistedEntities
      : new Map();
    for (const key of commitments.liveStateGraph?.entityCacheDels ?? []) entityCache.delete(key);
    for (const [key, entity] of commitments.liveStateGraph?.entityCachePuts ?? []) {
      entityCache.set(key, entity);
    }
    options.env.infrastructure.storagePersistedEntities = entityCache;
  }
  options.onPersistenceProgress?.('current-cache-write-done');
  await options.onPersistenceBoundary?.('after-current-cache-commit');
  if (prepared.checkpointedLineagePlan) {
    applyCertifiedEntityLineagePlan(
      options.env,
      prepared.checkpointedLineagePlan,
    );
  }
  const state = prepared.state;
  state.currentStorageOverlayMarks = new Map();
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
  let historyViewPrunedBytes = 0;
  let historyViewRetainedBytes = 0;
  let historyViewPrunedKeys = 0;
  let historyViewLatestPrunedHeight = 0;
  if (viewMaterializedThrough > 0) {
    const viewDb = options.getHistoryViewDb(options.env);
    const result = await pruneHistoryViewRetention({
      db: viewDb,
      height: options.env.state.height,
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
    historyViewMs,
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
  frame: RuntimeFramePlan,
  committed: CommittedStorageFrame,
  snapshot: StorageSnapshotLifecycleResult,
): StorageFrameSaveResult => {
  const persistencePerfMs: StoragePersistencePerf = {
    open: prepared.openMs,
    openStages: prepared.openStages,
    openDecision: prepared.openDecision,
    planning: prepared.planningMs,
    planningStages: prepared.planningStages,
    diff: 0,
    prepare: committed.prepareMs,
    prepareStages: committed.prepareStages,
    authoritativeWrite: committed.authoritativeWriteMs,
    historyView: committed.historyViewMs,
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
      frame: options.env.state.height,
      puts: prepared.overlayRecords.length,
      dels: prepared.overlayRecords.filter(
        record => record.family === 'book' && record.deleted === true,
      ).length,
      frameBytes: frame.frameBuffer.byteLength,
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
    materializedOverlayKeys: prepared.shouldMaterialize
      ? prepared.overlayRecords.map(storageOverlayRecordKey)
      : [],
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
      materializedOverlayKeys: [],
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
    // Sub-stage marks split `frameEncode`; keep the default stage shape stable.
    FRAME_ENCODE_SUBSTAGE_PROFILE ? checkpointPrepare : undefined,
  );
  options.onPersistenceProgress?.('frame-encoded');
  checkpointPrepare('frameEncode');
  const certifiedHistoryPuts = await prepareCertifiedHistoryPuts(
    walDb,
    framePlan.certifiedHistoryPuts,
  );
  checkpointPrepare('certifiedHistory');
  const batches = buildStorageCommitBatches(
    options,
    prepared,
    commitments,
    pendingNodes,
    framePlan,
    certifiedHistoryPuts,
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
  lastWrittenFrameHash.set(walDb, { height: options.env.state.height, hash: framePlan.frameHash });
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
import { Buffer } from '../support/platform-crypto';
