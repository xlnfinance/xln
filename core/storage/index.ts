/**
 * Storage composition root for the bounded authoritative WAL and disposable live views.
 * Key entrypoint: saveEnvToDB commits the Runtime WAL before cache publication.
 * Human-audit importance: 100/100 — this is the crash-consistency boundary.
 */
import { getPerfMs } from '../support/time';
import { auditEntityStateRootAtCheckpoint } from '../entity/consensus/state-root';
import { decodeValidatedBuffer, encodeBuffer, encodeBufferAsIs, encodeBufferPrepared, writeBatch } from './codec/codec';
import { canonicalizeBinaryPayload } from '../protocol/serialization/binary-codec';
import {
  boundedStorageRowsBytes,
  prepareBoundedStorageValueRows,
} from './codec/bounded-value';
import {
  deleteKeyRange,
  iterateKeys,
  readRawOrNull,
} from './database/level';
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
  pruneWalBeforeHeight,
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
  applyCertifiedEntityHeadPlan,
  buildRuntimeCheckpointHeadPlan,
} from './replica/entity-head';
import {
  readStorageFrameRecord,
  readStorageHead,
} from './read/read';
import {
  KEY_HEAD,
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
  KEY_ACCOUNT_J_CLAIM_NODE,
  KEY_LIVE_BOOK_BRANCH,
  KEY_LIVE_BOOK_LEAF,
  STORAGE_SCHEMA_VERSION,
  ZERO_FRAME_HASH,
  keyFrame,
  keyLiveReplicaMetaPrefix,
  keyCertifiedBoardNodePrefix,
  keyAccountJClaimNodePrefix,
} from './keys';
import {
  areStorageCheckpointReplicasQuiescent,
  buildLiveReplicaMetaPlan,
  buildStorageLiveReplicaMetaCommitment,
  buildStorageReplicaMetaCommitmentFromCheckpointPlan,
  summarizeStorageReplicaMetaHeads,
} from './replica/replicas';
import { createStructuredLogger } from '../support/logger';
import { cumulativeMarksToDurations } from '../support/performance/profile';
import type { FrameLogEntry } from '../types/logging';
import type { RuntimeReplica, RoutedEntityInput, RuntimeInput } from '../runtime/types';
import type { EntityContextPayloadHash } from '../protocol/hashes';
import { readRuntimeFrameEvents } from '../runtime/observability/env-events';
import { getCertifiedBoardNodeStore, hashCertifiedBoardNode } from '../jurisdiction/machine/board-registry';
import {
  hashAccountJClaimNode,
} from '../account/j-claims/j-claim-accumulator';
import {
  finalizePersistedAccountJClaimNodes,
  getAccountJClaimNodeStore,
  getSafePendingAccountJClaimDeletes,
} from '../entity/account/account-j-claim-node-store';
import {
  buildStorageRuntimeMachineSnapshot,
  buildReplayVerifiableRuntimePostStateView,
} from './wal/snapshot';
import {
  verifyStorageSnapshotIntegrity,
  verifyStorageTailIntegrity,
} from './read/verify';
import { verifyLiveStorageIntegrity } from './read/integrity/live';
import {
  validatePersistedAccountJClaimPathNode,
  validatePersistedCertifiedBoardPathNode,
} from './schema/authoritative-schema';
import type {
  PerfDeps,
  RuntimeDbLike,
  StorageDoc,
  StorageDocRef,
  RuntimeFrame,
  StorageRscoreCheckpointRef,
  StorageHead,
  StoragePersistenceBoundaryHook,
  StoragePersistenceProgressHook,
  StorageRuntimeConfig,
  StorageReplicaLookup,
} from './types';
import { resolveStorageRuntimeConfig } from './database/config';
import { prepareStorageBookGraphWrite } from './commit/book-graph';
import { prepareLiveStateGraph } from './commit/live-state-graph';
import {
  prepareRscoreCheckpointStorage,
  type PreparedRscoreCheckpointStorage,
  type RscoreCheckpointStorageInput,
} from './schema/rscore/checkpoint';
import {
  prepareRuntimeOutputRows,
  type RuntimeOutputCommitment,
} from './wal/outbox-payload';
import { prepareEntityContextPayloadRows } from './wal/entity-context-payload';
import { countOp, OP_COUNTERS_ENABLED } from '../support/performance/op-counters';
import { prepareRuntimeMachineGraphWrite } from './wal/runtime-machine-graph';
import {
  preparePathKeyedAuxiliaryRows,
  type AuxiliaryTreeOwner,
} from './schema/nodes/path-keyed-auxiliary-nodes';
import type { RscoreExactCheckpoint } from '../rscore/checkpoint/checkpoint-wire';
import { appendRuntimeActivityViewFrame } from './history/runtime-activity-view';
export { resolveStorageRuntimeConfig } from './database/config';
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
    retainedWalBytes: 0,
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
  left.retainedWalBytes === right.retainedWalBytes;

type AuxiliaryPathFamily = Readonly<{
  prefix: Buffer;
  validate: (value: unknown) => Readonly<{ hash: string; node: unknown }>;
  hashNode: (node: never) => string;
  code: string;
}>;

const AUXILIARY_PATH_FAMILIES: readonly AuxiliaryPathFamily[] = [
  {
    prefix: keyCertifiedBoardNodePrefix(),
    validate: validatePersistedCertifiedBoardPathNode,
    hashNode: hashCertifiedBoardNode as (node: never) => string,
    code: 'CERTIFIED_BOARD_PATH_NODE',
  },
  {
    prefix: keyAccountJClaimNodePrefix(),
    validate: validatePersistedAccountJClaimPathNode,
    hashNode: hashAccountJClaimNode as (node: never) => string,
    code: 'ACCOUNT_J_CLAIM_PATH_NODE',
  },
] as const;

const validateAuxiliaryPathValue = (
  value: Buffer,
  family: AuxiliaryPathFamily,
): void => {
  const decoded = decodeValidatedBuffer(value, family.validate);
  const actual = family.hashNode(decoded.node as never);
  if (actual !== decoded.hash) {
    throw new Error(`${family.code}_CORRUPT:${decoded.hash}:${actual}`);
  }
};

const synchronizeAuxiliaryPathFamily = async (
  walDb: RuntimeDbLike,
  currentDb: RuntimeDbLike,
  family: AuxiliaryPathFamily,
  batch?: ReturnType<RuntimeDbLike['batch']>,
): Promise<boolean> => {
  const authoritativeKeys = new Set<string>();
  let changed = false;
  for await (const key of iterateKeys(walDb, { prefix: family.prefix })) {
    const authoritative = await walDb.get(key);
    validateAuxiliaryPathValue(authoritative, family);
    authoritativeKeys.add(key.toString('hex'));
    if ((await readRawOrNull(currentDb, key))?.equals(authoritative)) continue;
    batch?.put(key, authoritative);
    changed = true;
  }
  for await (const key of iterateKeys(currentDb, { prefix: family.prefix })) {
    if (authoritativeKeys.has(key.toString('hex'))) continue;
    batch?.del(key);
    changed = true;
  }
  return changed;
};

const synchronizeCertifiedBoardNodes = (
  walDb: RuntimeDbLike,
  currentDb: RuntimeDbLike,
  batch?: ReturnType<RuntimeDbLike['batch']>,
): Promise<boolean> => synchronizeAuxiliaryPathFamily(
  walDb,
  currentDb,
  AUXILIARY_PATH_FAMILIES[0]!,
  batch,
);

const synchronizeAccountJClaimNodes = (
  walDb: RuntimeDbLike,
  currentDb: RuntimeDbLike,
  batch?: ReturnType<RuntimeDbLike['batch']>,
  _stateDb: RuntimeDbLike = currentDb,
): Promise<boolean> => synchronizeAuxiliaryPathFamily(
  walDb,
  currentDb,
  AUXILIARY_PATH_FAMILIES[1]!,
  batch,
);

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
  const accountJClaimChanged = await synchronizeAccountJClaimNodes(walDb, currentDb);
  if (boardChanged || accountJClaimChanged) {
    throw new Error(
      `STORAGE_CURRENT_NODE_PROJECTION_MISMATCH:` +
        `board=${boardChanged}:accountJ=${accountJClaimChanged}`,
    );
  }
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

export const recoverStorageDbFromWal = async (options: {
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
  const walLatestHeight = Math.max(0, Math.floor(Number(walHead.latestHeight ?? 0)));
  const currentLatestHeight = Math.max(0, Math.floor(Number(currentHead.latestHeight ?? 0)));
  const walMaterializedHeight = materializedHeightOf(walHead);
  const currentMaterializedHeight = materializedHeightOf(currentHead);
  const walSnapshotHeight = Math.max(0, Math.floor(Number(walHead.latestSnapshotHeight ?? 0)));
  options.onPersistenceProgress?.('recovery-heads-read');
  markRecoveryStage('headsRead');

  if (
    currentLatestHeight > walLatestHeight ||
    currentMaterializedHeight > walMaterializedHeight ||
    currentHead.latestSnapshotHeight > walSnapshotHeight
  ) {
    throw new Error(
      `STORAGE_CURRENT_AHEAD_OF_WAL: ` +
        `current=${currentLatestHeight}/${currentMaterializedHeight}/${currentHead.latestSnapshotHeight} ` +
        `wal=${walLatestHeight}/${walMaterializedHeight}/${walSnapshotHeight}`,
    );
  }
  if (walLatestHeight === 0) {
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
  const resetFromWal =
    !rawCurrentHead ||
    currentMaterializedHeight < walSnapshotHeight ||
    currentProjectionInvalid;
  let recovered = false;
  if (resetFromWal) {
    if (walSnapshotHeight > 0) {
      await verifyStorageSnapshotIntegrity(options.walDb, walHead);
      options.onPersistenceProgress?.('recovery-snapshot-verified');
    }
    await clearCurrentRecoveryState(options.db);
    options.onPersistenceProgress?.('recovery-current-cleared');
    markRecoveryStage('resetFromWal');
    recovered = true;
  }

  const batch = options.db.batch();
  const headChanged = !rawCurrentHead || !headsMatch || currentProjectionInvalid;
  const liveStateChanged = headChanged
    ? await synchronizeLiveStateProjection(options.walDb, options.db, batch)
    : false;
  options.onPersistenceProgress?.('recovery-live-state-synchronized');
  if (headChanged) markRecoveryStage('syncLiveState');
  // The Runtime WAL commits before the rebuildable current projection cache. The
  // normal append path writes both DBs; only lagging-cache recovery scans and
  // reconciles the live owner/path rows.
  const boardNodesChanged = headChanged
    ? await synchronizeCertifiedBoardNodes(options.walDb, options.db, batch)
    : false;
  options.onPersistenceProgress?.('recovery-board-nodes-synchronized');
  if (headChanged) markRecoveryStage('syncBoardNodes');
  const accountJClaimNodesChanged = headChanged
    ? await synchronizeAccountJClaimNodes(options.walDb, options.db, batch, options.walDb)
    : false;
  options.onPersistenceProgress?.('recovery-account-j-nodes-synchronized');
  if (headChanged) markRecoveryStage('syncAccountJNodes');
  if (
    liveStateChanged ||
    boardNodesChanged ||
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
  const reverified = shouldVerifyCurrent || resetFromWal || headChanged;
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
  staleWriterStopped?: boolean;
  latestSnapshotHeight?: number;
  retainedWalBytes?: number;
  snapshotCreated?: boolean;
  snapshotBytes?: number;
  walPrunedBytes?: number;
  epochRotated?: boolean;
  epochDbRotated?: boolean;
  persistencePerfMs?: StoragePersistencePerf;
};

type StoragePersistencePerf = {
  /**
   * Time owned by the Runtime storage wrapper rather than the canonical
   * LevelDB commit itself. Keeping this split explicit prevents a slow lock,
   * projection, or post-commit cleanup from being blamed on LevelDB.
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
  rotateEpochDb?: (env: RuntimeReplica, snapshotHeight: number, timestamp: number) => Promise<boolean | void>;
  stopStaleWriterOnHeadAhead?: boolean;
  onPersistenceBoundary?: StoragePersistenceBoundaryHook;
  onPersistenceProgress?: StoragePersistenceProgressHook;
  accountAuthority?: Readonly<{
    /** Selects checkpoint rows already piggybacked by the final Account outbound. */
    prepareCheckpoint: () => Promise<readonly RscoreCheckpointStorageInput[]>;
    /** Proves the planned physical projection is accepted by exact Rust restore. */
    validateCheckpointMaterialization: (
      checkpoints: readonly RscoreExactCheckpoint[],
    ) => Promise<void>;
    /** Runs immediately after the sole authoritative WAL fsync. */
    afterWalCommit: (materialized: boolean) => Promise<void>;
  }>;
  /**
   * Internal crash-proof seam. Captures the exact frame identity before the
   * authoritative write starts, so an apply-then-reject result can be proven
   * against bytes read back from the WAL before Rust is completed.
   */
  onAuthoritativeFramePrepared?: (
    identity: StorageAuthoritativeFrameIdentity,
  ) => void;
} & PerfDeps;

export type StorageAuthoritativeFrameIdentity = Readonly<{
  frameHash: string;
  postStateHash: string;
  runtimeInput: RuntimeInput;
  materialized: boolean;
  accountAuthorityCheckpoints: readonly StorageRscoreCheckpointRef[];
}>;

type StorageSnapshotLifecycleResult = {
  snapshotMs: number;
  snapshotDocs: number;
  snapshotBytes: number;
  prunedBytes: number;
  epochRotated: boolean;
  epochDbRotated: boolean;
  retainedWalBytes: number;
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
  let retainedWalBytes = nextHead.retainedWalBytes;
  let latestSnapshotHeight = head.latestSnapshotHeight;

  if (snapshotDue || snapshotRequiredByBytes) {
    options.onPersistenceProgress?.('snapshot-start');
    const startedAt = options.getPerfMs();
    await recoverStorageDbFromWal({
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
    retainedWalBytes += snapshotBytes;
    latestSnapshotHeight = options.env.state.height;
    const publishedHead = {
      ...(await readHead(walDb, config)),
      latestSnapshotHeight,
      retainedWalBytes,
    } satisfies StorageHead;
    await verifyStorageSnapshotIntegrity(walDb, publishedHead);
    const publishBatch = walDb.batch();
    publishBatch.put(KEY_HEAD, encodeBuffer(publishedHead));
    await writeBatch(publishBatch);
    await options.onPersistenceBoundary?.('after-snapshot-wal-publish');
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
    prunedBytes += await pruneWalBeforeHeight(
      walDb,
      oldestRetained,
      options.onPersistenceBoundary,
    );
  }

  retainedWalBytes = Math.max(0, retainedWalBytes - prunedBytes);
  if (snapshotDocs > 0 || prunedBytes > 0) {
    const latest = await readHead(walDb, config);
    const updatedHead = {
      ...latest,
      latestSnapshotHeight,
      retainedWalBytes,
    } satisfies StorageHead;
    const walUpdate = walDb.batch();
    walUpdate.put(KEY_HEAD, encodeBuffer(updatedHead));
    await writeBatch(walUpdate);
    await options.onPersistenceBoundary?.('after-snapshot-wal-head');
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
      await options.onPersistenceBoundary?.('after-epoch-wal-head-reset');
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
    retainedWalBytes,
    latestSnapshotHeight,
  };
};

const buildStorageCheckpointRequest = (
  height: number,
  head: StorageHead,
  config: Required<StorageRuntimeConfig>,
  appliedRuntimeInput: RuntimeInput,
) => {
  const checkpointBarrierRequested = appliedRuntimeInput.runtimeTxs.some(
    tx => tx.type === 'checkpointBarrier',
  );
  const finiteEpochByteBudget = config.epochMaxBytes !== Number.MAX_SAFE_INTEGER;
  const appliedRuntimeInputBytes = finiteEpochByteBudget
    ? encodeBufferPrepared(appliedRuntimeInput, { omitSymbolKeys: true }).buffer.byteLength
    : 0;
  const snapshotRequested =
    height === 1 || height - head.latestSnapshotHeight >= config.snapshotPeriodFrames;
  const snapshotRequiredByBytesRequested =
    finiteEpochByteBudget &&
    head.epochReplayBytes + appliedRuntimeInputBytes >= config.epochMaxBytes;
  return {
    snapshotRequested,
    snapshotRequiredByBytesRequested,
    materializationRequested:
      checkpointBarrierRequested ||
      height === 1 ||
      height - head.latestMaterializedHeight >= config.materializePeriodFrames ||
      snapshotRequested ||
      snapshotRequiredByBytesRequested,
  };
};

/**
 * Resolve databases and build the deterministic frame diff before any write.
 * Everything returned here is still pre-commit and may be discarded safely.
 */
const prepareStorageFrameSave = async (options: StorageFrameSaveOptions) => {
  const config = resolveStorageRuntimeConfig(options.env);
  if (!config.enabled || options.env.infrastructure?.persistencePaused) {
    if (options.accountAuthority) {
      throw new AccountAuthorityPreWalError(
        !config.enabled ? 'STORAGE_DISABLED' : 'PERSISTENCE_PAUSED',
      );
    }
    return {
      skipped: {
        materialized: false,
        materializedOverlayKeys: [],
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
  const recovery = state.storageWalRecovered === true
    ? EMPTY_STORAGE_RECOVERY
    : await recoverStorageDbFromWal({
      db,
      walDb,
      config,
      verifyCurrentProjection: state.storageCurrentProjectionVerified !== true,
      ...(options.onPersistenceProgress
        ? { onPersistenceProgress: options.onPersistenceProgress }
        : {}),
    });
  state.storageCurrentProjectionVerified = true;
  state.storageWalRecovered = true;
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
  const checkpointRequest = buildStorageCheckpointRequest(
    options.env.state.height,
    head,
    config,
    canonicalAppliedRuntimeInput,
  );
  const checkpointEligible =
    !checkpointRequest.materializationRequested ||
    areStorageCheckpointReplicasQuiescent(options.env);
  const snapshotDue = checkpointRequest.snapshotRequested && checkpointEligible;
  const snapshotRequiredByBytes =
    checkpointRequest.snapshotRequiredByBytesRequested && checkpointEligible;
  const shouldMaterialize = checkpointRequest.materializationRequested && checkpointEligible;

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
    ? buildRuntimeCheckpointHeadPlan(options.env)
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
  const planningMs = options.getPerfMs() - planningStartedAt;
  const planningStages = countStorageStages('planning', planningMarks, planningMs);
  return {
    config,
    state,
    db,
    walDb,
    head,
    appliedRuntimeInput: canonicalAppliedRuntimeInput,
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

const collectAuxiliaryTreeOwners = (replicas: StorageReplicaLookup): AuxiliaryTreeOwner[] =>
  [...replicas.entries()].map(([entityId, { state }]) => ({
      entityId,
      ...(state.certifiedBoardState?.boardRegistryRoot
        ? { certifiedBoardRoot: state.certifiedBoardState.boardRegistryRoot }
        : {}),
      accounts: [...state.accounts]
        .map(([counterpartyId, account]) => ({
          counterpartyId: counterpartyId.toLowerCase(),
          leftPendingJClaims: account.state.leftPendingJClaims,
          rightPendingJClaims: account.state.rightPendingJClaims,
        }))
        .sort((left, right) => left.counterpartyId.localeCompare(right.counterpartyId)),
    }));

const preparePathKeyedAuxiliaryPlan = async (
  env: RuntimeReplica,
  walDb: RuntimeDbLike,
  shouldMaterialize: boolean,
  replicas: StorageReplicaLookup,
) => {
  // Path-keyed auxiliary trees are part of the materialized Entity/Account
  // graph. Advancing or garbage-collecting them on an ordinary WAL frame
  // would leave the durable checkpoint root pointing at deleted path nodes.
  if (!shouldMaterialize) {
    return {
      puts: [] as ReadonlyArray<Readonly<{ key: Buffer; value: Buffer }>>,
      dels: [] as readonly Buffer[],
      safeAccountJClaimDeletes: [] as readonly string[],
    };
  }
  const safeAccountJClaimDeletes = getSafePendingAccountJClaimDeletes(env);
  const projected = preparePathKeyedAuxiliaryRows({
    owners: collectAuxiliaryTreeOwners(replicas),
    certifiedBoardStore: getCertifiedBoardNodeStore(env),
    accountJClaimStore: getAccountJClaimNodeStore(env),
  });
  const puts = [
    ...projected.certifiedBoardNodes,
    ...projected.accountJClaimNodes,
  ];
  const desired = new Set(puts.map(row => row.key.toString('hex')));
  const dels: Buffer[] = [];
  for (const family of AUXILIARY_PATH_FAMILIES) {
    for await (const key of iterateKeys(walDb, { prefix: family.prefix })) {
      if (!desired.has(key.toString('hex'))) dels.push(key);
    }
  }
  return { puts, dels, safeAccountJClaimDeletes };
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
    mempools: [...env.state.eReplicas.values()].map(replica => ({
      entityId: replica.entityId,
      txTypes: replica.mempool.map(tx => tx.type),
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
    buildReplayVerifiableRuntimePostStateView(options.env),
  );
  const runtimeMachine = shouldMaterialize
    ? buildStorageRuntimeMachineSnapshot(options.env)
    : undefined;
  const runtimeMachineGraph = runtimeMachine
    ? await prepareRuntimeMachineGraphWrite(walDb, runtimeMachine)
    : null;
  checkpoint('runtimeMachine');
  const canonicalStateHashes = canonicalHashDue
    ? prepareStorageCanonicalStateHashes(
        options.env,
        [],
        previousFrame,
        replicaLookup,
      )
    : null;
  options.onPersistenceProgress?.('canonical-hashes-built');
  checkpoint('canonicalHashes');

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
  checkpoint('replicaMetaScan');
  options.onPersistenceProgress?.('replica-metadata-read');
  return {
    liveStateGraph,
    runtimeComponentDigests,
    runtimeMachineGraph,
    canonicalStateHashes,
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
  runtimeOutputs: RuntimeOutputCommitment,
  entityContextRefs: ReadonlyMap<string, EntityContextPayloadHash>,
  runtimeMachineRoot: import('./types').RuntimeMachineGraphRoot | undefined,
  accountAuthorityCheckpoints: PreparedRscoreCheckpointStorage['refs'],
): RuntimeFrame => {
  const { appliedRuntimeInput, shouldMaterialize } = prepared;
  return {
    height: options.env.state.height,
    timestamp: options.env.state.timestamp,
    prevFrameHash,
    replicaMetaDigest: commitments.replicaMetaCommitment.digest,
    postStateHash: computeStoragePostStateHash({
      height: options.env.state.height,
      timestamp: options.env.state.timestamp,
      replicaMetaDigest: commitments.replicaMetaCommitment.digest,
      runtimeComponentDigests: commitments.runtimeComponentDigests,
      runtimeOutputCount: runtimeOutputs.count,
      runtimeOutputsDigest: runtimeOutputs.digest,
    }),
    materializedState: shouldMaterialize,
    ...(commitments.canonicalStateHashes
      ? {
          canonicalStateHash:
            commitments.canonicalStateHashes.canonicalStateHash,
          canonicalEntityHashes:
            commitments.canonicalStateHashes.canonicalEntityHashes,
        }
      : {}),
    runtimeInput: appliedRuntimeInput,
    ...(entityContextRefs.size > 0
      ? { entityContextRefs: new Map(entityContextRefs) }
      : {}),
    ...(runtimeMachineRoot
      ? { runtimeMachineRoot }
      : {}),
    ...(accountAuthorityCheckpoints.length > 0
      ? { accountAuthorityCheckpoints: [...accountAuthorityCheckpoints] }
      : {}),
    runtimeOutputCount: runtimeOutputs.count,
    runtimeOutputsDigest: runtimeOutputs.digest,
    touchedEntities: touches.touchedEntities,
    touchedAccounts: touches.touchedAccounts,
    touchedBookEntities: touches.touchedBookEntities,
  };
};

const WAL_SYNC_ENABLED = process.env['XLN_STORAGE_WAL_SYNC'] !== '0';

/** WAL is durable but the Rust authority did not acknowledge the same wave. */
export class AccountAuthorityWalCommitError extends Error {
  constructor(cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`RSCORE_AUTHORITY_AFTER_WAL_FAILED:${detail}`, { cause });
    this.name = 'AccountAuthorityWalCommitError';
  }
}

/** The Rust candidate is proven abortable because no WAL write was attempted. */
export class AccountAuthorityPreWalError extends Error {
  constructor(reason: string, cause?: unknown) {
    super(`RSCORE_AUTHORITY_PRE_WAL:${reason}`, { cause });
    this.name = 'AccountAuthorityPreWalError';
  }
}

/** Stage durations become op-counters so a load run can split save time. */
const countStorageStages = (
  family: 'planning' | 'prepare',
  marks: Record<string, number>,
  totalMs: number,
): Record<string, number> => {
  const stages = cumulativeMarksToDurations(marks, totalMs);
  if (OP_COUNTERS_ENABLED) {
    for (const [stage, ms] of Object.entries(stages)) countOp(`storage.${family}.${stage}`, 0, Math.round(ms * 1_000));
  }
  return stages;
};

const buildStorageFrameRecordPlan = (
  options: StorageFrameSaveOptions,
  prepared: PreparedStorageFrameSave,
  commitments: PreparedStorageCommitments,
  prevFrameHash: string,
  accountAuthorityCheckpoint: PreparedRscoreCheckpointStorage,
  mark: (label: string) => void = () => {},
) => {
  const touches = summarizeStorageFrameTouches(options, prepared);
  mark('frameEncode.touches');
  const outputPayloads = prepareRuntimeOutputRows(
    options.env.state.height,
    options.currentFrameOutputs ?? [],
  );
  mark('frameEncode.outputPayloads');
  const entityContextPayloads = prepareEntityContextPayloadRows(
    options.env.state.height,
    options.entityContexts,
    options.inProcessInfraValidated === true,
  );
  mark('frameEncode.entityContexts');
  const runtimeMachineGraph = commitments.runtimeMachineGraph;
  mark('frameEncode.machineGraph');
  // Canonicalized once: the frame hash and the stored record both encode
  // this multi-megabyte input log, and a canonical tree skips the walk.
  const frameBase = canonicalizeBinaryPayload(buildStorageRuntimeFrame(
    options,
    prepared,
    commitments,
    prevFrameHash,
    touches,
    outputPayloads.commitment,
    entityContextPayloads.refs,
    runtimeMachineGraph?.root,
    accountAuthorityCheckpoint.refs,
  ), { omitSymbolKeys: true });
  mark('frameEncode.frameBase');
  const frameRecord = {
    ...frameBase,
    frameHash: computeStorageFrameHash(frameBase),
  } satisfies RuntimeFrame;
  mark('frameEncode.frameHash');
  const frameKey = keyFrame(options.env.state.height);
  // frameBase is already a canonical (marked) tree; the row is decoded back
  // into a record and its hash is computed above, never over these bytes.
  const frameBuffer = encodeBufferAsIs(frameRecord);
  const frameRows = prepareBoundedStorageValueRows(frameKey, frameBuffer);
  mark('frameEncode.frameBuffer');
  const authoritativeBaseBytes =
    boundedStorageRowsBytes(frameRows) +
    outputPayloads.rows.reduce(
      (total, row) => total + row.key.byteLength + row.value.byteLength,
      0,
    ) +
    entityContextPayloads.rows.reduce(
      (total, row) => total + row.key.byteLength + row.value.byteLength,
      0,
    ) +
    (runtimeMachineGraph?.rows ?? []).reduce(
      (total, row) => total + row.key.byteLength + row.value.byteLength,
      0,
    ) +
    (runtimeMachineGraph?.dels ?? []).reduce((total, key) => total + key.byteLength, 0) +
    accountAuthorityCheckpoint.puts.reduce(
      (total, row) => total + row.key.byteLength + row.value.byteLength,
      0,
    ) +
    accountAuthorityCheckpoint.dels.reduce((total, key) => total + key.byteLength, 0);
  return {
    record: frameRecord,
    frameKey,
    frameHash: frameRecord.frameHash,
    authoritativeIdentity: {
      frameHash: frameRecord.frameHash,
      postStateHash: frameRecord.postStateHash,
      runtimeInput: frameRecord.runtimeInput,
      materialized: frameRecord.materializedState,
      accountAuthorityCheckpoints: (frameRecord.accountAuthorityCheckpoints ?? [])
        .map(checkpoint => ({ ...checkpoint })),
    } satisfies StorageAuthoritativeFrameIdentity,
    frameBuffer,
    frameRows,
    outputPayloadRows: outputPayloads.rows,
    entityContextPayloadRows: entityContextPayloads.rows,
    runtimeMachineGraphRows: runtimeMachineGraph?.rows ?? [],
    runtimeMachineGraphDels: runtimeMachineGraph?.dels ?? [],
    frameLogs: touches.frameLogs,
    touchedEntities: touches.touchedEntities,
    touchedAccounts: touches.touchedAccounts,
    touchedBookEntities: touches.touchedBookEntities,
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

const buildStorageCommitBatches = (
  options: StorageFrameSaveOptions,
  prepared: PreparedStorageFrameSave,
  commitments: PreparedStorageCommitments,
  pendingNodes: Awaited<ReturnType<typeof preparePathKeyedAuxiliaryPlan>>,
  frame: RuntimeFramePlan,
  accountAuthorityCheckpoint: PreparedRscoreCheckpointStorage,
) => {
  const walBatch = prepared.walDb.batch();
  for (const key of commitments.staleReplicaMetaKeys) walBatch.del(key);
  for (const key of pendingNodes.dels) walBatch.del(key);
  for (const entry of pendingNodes.puts) walBatch.put(entry.key, entry.value);
  for (const row of frame.frameRows) walBatch.put(row.key, row.value);
  for (const row of frame.outputPayloadRows) {
    walBatch.put(row.key, row.value);
  }
  for (const row of frame.entityContextPayloadRows) {
    walBatch.put(row.key, row.value);
  }
  for (const key of frame.runtimeMachineGraphDels) {
    walBatch.del(key);
  }
  for (const row of frame.runtimeMachineGraphRows) {
    walBatch.put(row.key, row.value);
  }
  for (const key of accountAuthorityCheckpoint.dels) walBatch.del(key);
  for (const row of accountAuthorityCheckpoint.puts) walBatch.put(row.key, row.value);
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
  for (const entry of commitments.replicaMetaEntries) {
    // Recovery metadata shares the authoritative batch with frame and HEAD.
    walBatch.put(entry.key, entry.value);
  }

  const currentBatch = prepared.db.batch();
  for (const key of pendingNodes.dels) currentBatch.del(key);
  for (const entry of pendingNodes.puts) currentBatch.put(entry.key, entry.value);
  const graph = commitments.liveStateGraph;
  if (graph) {
    for (const key of graph.dels) currentBatch.del(key);
    for (const item of graph.puts) {
      currentBatch.put(item.key, item.value);
    }
  }
  for (const key of commitments.bookGraphWrites.dels) currentBatch.del(key);
  for (const row of commitments.bookGraphWrites.puts) currentBatch.put(row.key, row.value);

  const committedFrameBytes = frame.authoritativeBaseBytes;
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
    epochReplayBytes: prepared.head.epochReplayBytes + committedFrameBytes,
    retainedWalBytes: prepared.head.retainedWalBytes + committedFrameBytes,
  };
  const encodedHead = encodeBuffer(nextHead);
  walBatch.put(KEY_HEAD, encodedHead);
  currentBatch.put(KEY_HEAD, encodedHead);
  options.onPersistenceProgress?.('commit-plan-built');
  return {
    walBatch,
    currentBatch,
    nextHead,
    safeAccountJClaimDeletes: pendingNodes.safeAccountJClaimDeletes,
  };
};

type StorageCommitBatches = ReturnType<typeof buildStorageCommitBatches>;

const scheduleDisposableActivityView = (
  options: StorageFrameSaveOptions,
  frame: RuntimeFramePlan,
): void => {
  const events = structuredClone(frame.frameLogs);
  void appendRuntimeActivityViewFrame(options.env, frame.record, events).then(outcome => {
    if (outcome === 'gap') throw new Error(`RUNTIME_ACTIVITY_VIEW_GAP:height=${frame.record.height}`);
    const failure = options.env.infrastructure?.runtimeActivityViewFailure;
    if (failure && failure.height <= frame.record.height) {
      delete options.env.infrastructure?.runtimeActivityViewFailure;
    }
  }).catch(error => {
    const message = error instanceof Error ? error.message : String(error);
    options.env.infrastructure ??= {};
    const failure = options.env.infrastructure.runtimeActivityViewFailure;
    if (!failure || failure.height <= frame.record.height) {
      options.env.infrastructure.runtimeActivityViewFailure = {
        height: frame.record.height,
        message,
      };
    }
    storageLog.warn('activity_view.write_failed', {
      height: frame.record.height,
      error: message,
    });
  });
};

// Load-test user Runtimes may trade durability for I/O (XLN_STORAGE_WAL_SYNC=0);
// a Hub keeps the fsync.
const writeAuthoritativeWalBatch = (batches: StorageCommitBatches): Promise<void> =>
  writeBatch(batches.walBatch, { sync: WAL_SYNC_ENABLED });

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
  const prepareStages = countStorageStages('prepare', prepareMarks, prepareMs);
  options.onPersistenceProgress?.('authoritative-write-start');
  // This synced WAL batch is the only frame commit point. Everything before it
  // is discardable planning; everything after it must recover forward.
  await writeAuthoritativeWalBatch(batches);
  const authoritativeWriteMs = options.getPerfMs() - prepareStartedAt;
  options.onPersistenceProgress?.('authoritative-write-done');
  try {
    await options.accountAuthority?.afterWalCommit(prepared.shouldMaterialize);
  } catch (error) {
    throw new AccountAuthorityWalCommitError(error);
  }
  options.onPersistenceProgress?.('account-authority-committed');
  await options.onPersistenceBoundary?.('after-authoritative-commit');
  scheduleDisposableActivityView(options, frame);

  const currentWriteStartedAt = options.getPerfMs();
  options.onPersistenceProgress?.('current-cache-write-start');
  let currentCacheWriteMs = 0;
  await writeBatch(batches.currentBatch, { sync: false }).then(() => {
    currentCacheWriteMs = options.getPerfMs() - currentWriteStartedAt;
  });
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
    applyCertifiedEntityHeadPlan(
      options.env,
      prepared.checkpointedLineagePlan,
    );
  }
  const state = prepared.state;
  state.currentStorageOverlayMarks = new Map();
  if (prepared.shouldMaterialize) {
    state.pendingCertifiedBoardNodes = new Map();
    finalizePersistedAccountJClaimNodes(
      options.env,
      batches.safeAccountJClaimDeletes,
    );
  }
  if (prepared.checkpointedLineagePlan) {
    state.storageReplicaMetaKeys = new Set(commitments.liveReplicaMetaKeys);
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
  if (prepared.shouldMaterialize) {
    options.env.persistenceLastMaterializedHeight = options.env.state.height;
  }
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
      snapshotBytes: snapshot.snapshotBytes,
      retainedWalBytes: snapshot.retainedWalBytes,
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
    latestSnapshotHeight: snapshot.latestSnapshotHeight,
    retainedWalBytes: snapshot.retainedWalBytes,
    snapshotCreated: snapshot.snapshotDocs > 0,
    snapshotBytes: snapshot.snapshotBytes,
    walPrunedBytes: snapshot.prunedBytes,
    epochRotated: snapshot.epochRotated,
    epochDbRotated: snapshot.epochDbRotated,
    persistencePerfMs,
  };
};

export const saveRuntimeFrameToStorage = async (
  options: StorageFrameSaveOptions,
): Promise<StorageFrameSaveResult> => {
  if (options.accountAuthority && !WAL_SYNC_ENABLED) {
    throw new AccountAuthorityPreWalError('SYNC_WAL_REQUIRED');
  }
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
      staleWriterStopped: true,
    };
  }
  const { previousFrame, prevFrameHash } = appendPosition;
  options.onPersistenceProgress?.('wal-head-read');
  checkpointPrepare('walHeadRead');
  const pendingNodes = await preparePathKeyedAuxiliaryPlan(
    options.env,
    walDb,
    prepared.shouldMaterialize,
    prepared.replicaLookup,
  );
  checkpointPrepare('pendingNodes');

  const authorityCheckpointInputs = options.accountAuthority && prepared.shouldMaterialize
    ? await options.accountAuthority.prepareCheckpoint()
    : [];
  const accountAuthorityCheckpoint = await prepareRscoreCheckpointStorage(
    walDb,
    authorityCheckpointInputs,
  );
  if (options.accountAuthority && accountAuthorityCheckpoint.refs.length > 0) {
    try {
      await options.accountAuthority.validateCheckpointMaterialization(
        accountAuthorityCheckpoint.exactCheckpoints,
      );
    } catch (error) {
      throw new AccountAuthorityPreWalError(
        'CHECKPOINT_MATERIALIZATION_INVALID',
        error,
      );
    }
  }
  options.onPersistenceProgress?.('account-authority-checkpoint-built');
  checkpointPrepare('accountAuthorityCheckpoint');

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
    prevFrameHash,
    accountAuthorityCheckpoint,
    // Sub-stage marks split `frameEncode`; keep the default stage shape stable.
    FRAME_ENCODE_SUBSTAGE_PROFILE ? checkpointPrepare : undefined,
  );
  options.onAuthoritativeFramePrepared?.(framePlan.authoritativeIdentity);
  options.onPersistenceProgress?.('frame-encoded');
  checkpointPrepare('frameEncode');
  const batches = buildStorageCommitBatches(
    options,
    prepared,
    commitments,
    pendingNodes,
    framePlan,
    accountAuthorityCheckpoint,
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
