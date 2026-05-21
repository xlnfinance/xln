import { encodeBuffer, writeBatch } from './codec';
import {
  docValueKey,
  liveKeyForDoc,
  liveKeyForRef,
} from './doc-refs';
import {
  readJsonOrNull,
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
} from './lifecycle';
import {
  projectReplicaMeta,
} from './projections';
import {
  buildBookDeletionsFromOverlay,
  buildDocPuts,
  mergeOverlayRecordsIntoEnv,
  storageRefsFromOverlay,
} from './overlay-docs';
import { buildReplicaLookup } from './replicas';
import { readStorageFrameRecord } from './read';
import {
  DEFAULT_ACCOUNT_MERKLE_RADIX,
  DEFAULT_EPOCH_MAX_BYTES,
  DEFAULT_FRAME_DB_MAX_BYTES,
  DEFAULT_FRAME_DB_RETAIN_FRAMES,
  DEFAULT_MATERIALIZE_PERIOD_FRAMES,
  DEFAULT_RETAIN_SNAPSHOTS,
  DEFAULT_SNAPSHOT_PERIOD_FRAMES,
  KEY_HEAD,
  STORAGE_SCHEMA_VERSION,
  ZERO_FRAME_HASH,
  keyDiff,
  keyFrame,
  keyLiveReplicaMeta,
  normalizeEntityId,
} from './keys';
import type { Env, RuntimeInput, RuntimeFrameDbRecord } from '../types';
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
  StorageRuntimeConfig,
} from './types';
export {
  buildAccountMerkleFromDocs,
  buildAccountMerkleFromState,
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
  findStorageLatestSnapshotAtOrBelow,
  listStorageLiveEntityIds,
  listStorageSnapshotEntityIds,
  listStorageSnapshotHeights,
  loadEntityAccountDocFromStorage,
  loadEntityStateFromStorage,
  loadEntityViewPageFromStorage,
  readStorageFrameRecord,
  readStorageHead,
  readStorageReplicaMeta,
} from './read';
export {
  verifyStorageTailIntegrity,
} from './verify';

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
  StorageReplicaMeta,
  StorageRuntimeConfig,
  StorageSnapshotManifest,
} from './types';

const isProductionStorageRuntime = (): boolean =>
  String(process.env['NODE_ENV'] ?? '').trim().toLowerCase() === 'production';

const resolveCanonicalHashPeriodFrames = (env: Env): 0 | 1 => {
  const raw =
    env.runtimeConfig?.storage?.canonicalHashPeriodFrames ??
    process.env['XLN_STORAGE_CANONICAL_HASH_PERIOD_FRAMES'] ??
    1;
  const enabled = Number(raw) > 0;
  if (!enabled && isProductionStorageRuntime()) {
    throw new Error('STORAGE_CANONICAL_HASH_REQUIRED_IN_PRODUCTION');
  }
  return enabled ? 1 : 0;
};

const runtimeConfigFromEnv = (env: Env): Required<StorageRuntimeConfig> => ({
  enabled: env.runtimeConfig?.storage?.enabled ?? true,
  snapshotPeriodFrames: Math.max(
    1,
    Number(
      env.runtimeConfig?.storage?.snapshotPeriodFrames ??
        env.runtimeConfig?.snapshotIntervalFrames ??
        DEFAULT_SNAPSHOT_PERIOD_FRAMES,
    ),
  ),
  retainSnapshots: Math.max(
    1,
    Number(env.runtimeConfig?.storage?.retainSnapshots ?? DEFAULT_RETAIN_SNAPSHOTS),
  ),
  epochMaxBytes: Math.max(
    1,
    Number(env.runtimeConfig?.storage?.epochMaxBytes ?? DEFAULT_EPOCH_MAX_BYTES),
  ),
  frameDbMaxBytes: Math.max(
    1,
    Number(env.runtimeConfig?.storage?.frameDbMaxBytes ?? DEFAULT_FRAME_DB_MAX_BYTES),
  ),
  frameDbRetainFrames: Math.max(
    1,
    Number(env.runtimeConfig?.storage?.frameDbRetainFrames ?? DEFAULT_FRAME_DB_RETAIN_FRAMES),
  ),
  materializePeriodFrames: Math.max(
    1,
    Number(env.runtimeConfig?.storage?.materializePeriodFrames ?? DEFAULT_MATERIALIZE_PERIOD_FRAMES),
  ),
  canonicalHashPeriodFrames: resolveCanonicalHashPeriodFrames(env),
  accountMerkleRadix: env.runtimeConfig?.storage?.accountMerkleRadix === 256 ? 256 : DEFAULT_ACCOUNT_MERKLE_RADIX,
});

const readHead = async (db: RuntimeDbLike, config: Required<StorageRuntimeConfig>): Promise<StorageHead> => {
  const head = await readJsonOrNull<StorageHead>(db, KEY_HEAD);
  if (head) {
    return {
      ...head,
      latestMaterializedHeight: Math.max(
        0,
        Math.floor(Number(head.latestMaterializedHeight ?? head.latestSnapshotHeight ?? 0)),
      ),
    };
  }
  return {
    schemaVersion: STORAGE_SCHEMA_VERSION,
    latestHeight: 0,
    latestMaterializedHeight: 0,
    latestSnapshotHeight: 0,
    snapshotPeriodFrames: config.snapshotPeriodFrames,
    retainSnapshots: config.retainSnapshots,
    epochMaxBytes: config.epochMaxBytes,
    accountMerkleRadix: config.accountMerkleRadix,
    retainedHistoryBytes: 0,
  };
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

export const recoverStorageDbFromHistory = async (options: {
  db: RuntimeDbLike;
  historyDb: RuntimeFrameDbLike;
  config: Required<StorageRuntimeConfig>;
}): Promise<{ recovered: boolean; entityHashDocs?: Map<string, StorageEntityHashDoc> }> => {
  const historyHead = await readHead(options.historyDb, options.config);
  const currentHead = await readHead(options.db, options.config);
  const historyLatestHeight = Math.max(0, Math.floor(Number(historyHead.latestHeight ?? 0)));
  const currentLatestHeight = Math.max(0, Math.floor(Number(currentHead.latestHeight ?? 0)));
  const historyMaterializedHeight = materializedHeightOf(historyHead);
  const currentMaterializedHeight = materializedHeightOf(currentHead);

  if (currentLatestHeight > historyLatestHeight || currentMaterializedHeight > historyMaterializedHeight) {
    throw new Error(
      `STORAGE_CURRENT_AHEAD_OF_HISTORY: current=${currentLatestHeight}/${currentMaterializedHeight} ` +
        `history=${historyLatestHeight}/${historyMaterializedHeight}`,
    );
  }
  if (historyLatestHeight === currentLatestHeight && historyMaterializedHeight === currentMaterializedHeight) {
    return { recovered: false };
  }

  let entityHashDocs: Map<string, StorageEntityHashDoc> | undefined;
  for (let height = currentMaterializedHeight + 1; height <= historyMaterializedHeight; height += 1) {
    const diff = await readJsonOrNull<StorageDiffRecord>(options.historyDb, keyDiff(height));
    if (!diff) throw new Error(`STORAGE_RECOVERY_DIFF_MISSING: height=${height}`);
    entityHashDocs = await applyDiffToLiveDb({
      db: options.db,
      diff,
      ...(entityHashDocs ? { entityHashDocs } : {}),
    });
  }

  const batch = options.db.batch();
  batch.put(KEY_HEAD, encodeBuffer(historyHead));
  await writeBatch(batch);
  return { recovered: true, ...(entityHashDocs ? { entityHashDocs } : {}) };
};

export type StorageFrameSaveResult = {
  materialized: boolean;
  materializedOverlayRecords: number;
  frameDbCommitted: boolean;
  latestSnapshotHeight?: number;
  retainedHistoryBytes?: number;
  snapshotCreated?: boolean;
  snapshotBytes?: number;
  historyPrunedBytes?: number;
  epochRotated?: boolean;
  epochDbRotated?: boolean;
  frameDbRetainedBytes?: number;
  frameDbPrunedBytes?: number;
};

export const saveRuntimeFrameToStorage = async (options: {
  env: Env;
  stateHash?: string;
  currentFrameInput?: RuntimeInput;
  frameDbRecords?: RuntimeFrameDbRecord[];
  tryOpenDb: (env: Env) => Promise<boolean>;
  getRuntimeDb: (env: Env) => RuntimeDbLike;
  tryOpenFrameDb: (env: Env) => Promise<boolean>;
  getFrameDb: (env: Env) => RuntimeFrameDbLike;
  rotateEpochDb?: (env: Env, snapshotHeight: number, timestamp: number) => Promise<boolean | void>;
} & PerfDeps): Promise<StorageFrameSaveResult> => {
  const config = runtimeConfigFromEnv(options.env);
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
  const recoveredStorage = await recoverStorageDbFromHistory({ db, historyDb, config });
  if (recoveredStorage.entityHashDocs) {
    state.storageEntityHashDocs = recoveredStorage.entityHashDocs;
  }
  const openMs = options.getPerfMs() - openStartedAt;

  const appliedRuntimeInput = options.currentFrameInput ?? { runtimeTxs: [], entityInputs: [] };
  const frameOverlayRecords = Array.isArray(state.currentStorageOverlayMarks)
    ? state.currentStorageOverlayMarks.map((record) => ({ ...record }))
    : [];
  const overlayRecords = mergeOverlayRecordsIntoEnv(options.env, []);
  const frameTouched = storageRefsFromOverlay(frameOverlayRecords);
  const replicaLookup = buildReplicaLookup(options.env);
  const diffBuildStartedAt = options.getPerfMs();
  const framePuts = buildDocPuts(options.env, frameTouched, replicaLookup);
  const frameBookDels = buildBookDeletionsFromOverlay(frameOverlayRecords);
  const diff = buildDiffRecord(options.env.height, framePuts, frameBookDels);
  const diffBuildMs = options.getPerfMs() - diffBuildStartedAt;

  const writeStartedAt = options.getPerfMs();
  const head = await readHead(historyDb, config);
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
  const frameKey = keyFrame(options.env.height);
  const diffKey = keyDiff(options.env.height);
  const diffBuffer = encodeBuffer(diff);
  const projectedHistoryBytesWithoutFrame =
    head.retainedHistoryBytes +
    diffKey.byteLength +
    diffBuffer.byteLength;
  const snapshotDue = options.env.height % config.snapshotPeriodFrames === 0;
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
  const canonicalHashEnabled = config.canonicalHashPeriodFrames > 0;
  const canonicalHashes = canonicalHashEnabled
    ? prepareStorageCanonicalStateHashes(options.env, [], previousFrame, replicaLookup)
    : null;
  const frameRecordBase: StorageFrameRecord = {
    height: options.env.height,
    timestamp: options.env.timestamp,
    prevFrameHash,
    stateHash: preparedHashes?.stateHash ?? '',
    hashMode: 'storage-merkle-v1',
    materializedState: shouldMaterialize,
    entityHashes: preparedHashes?.entityHashes ?? previousFrame?.entityHashes ?? [],
    ...(canonicalHashes ? {
      canonicalStateHash: canonicalHashes.canonicalStateHash,
      canonicalEntityHashes: canonicalHashes.canonicalEntityHashes,
    } : {}),
    runtimeInput: appliedRuntimeInput,
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
  const projectedReplayBytes =
    head.retainedHistoryBytes +
    diffKey.byteLength +
    diffBuffer.byteLength;
  let frameDbBytes = 0;
  let frameDbPrunedBytes = 0;
  let frameDbRetainedBytes = 0;
  let frameDbPrunedKeys = 0;
  let frameDbLatestPrunedHeight = 0;
  let frameDbCommitted = frameDbPuts.length === 0;
  let frameDbCommitPlan: Awaited<ReturnType<typeof prepareFrameDbCommit>> | null = null;
  const historyBatch = historyDb.batch();
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
  const batch = db.batch();
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
  for (const replica of options.env.eReplicas.values()) {
    if (!replica?.state) continue;
    const entityId = normalizeEntityId(replica.entityId || replica.state.entityId || '');
    if (!entityId) continue;
    batch.put(keyLiveReplicaMeta(entityId), encodeBuffer(projectReplicaMeta(replica)));
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
  await writeBatch(historyBatch);
  if (frameDbCommitPlan) {
    frameDbCommitted = true;
  }
  await writeBatch(batch);
  if (state) {
    state.currentStorageOverlayMarks = [];
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
    });
    frameDbPrunedBytes = frameDbResult.prunedBytes;
    frameDbRetainedBytes = frameDbResult.retainedBytes;
    frameDbPrunedKeys = frameDbResult.prunedKeys;
    frameDbLatestPrunedHeight = frameDbResult.latestPrunedRuntimeHeight;
    frameDbCommitted = true;
  }
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
    const snapshotStartedAt = options.getPerfMs();
    const snapshotResult = await createSnapshot(db, historyDb, options.env.height, options.env.timestamp);
    snapDocs = snapshotResult.docCount;
    snapshotBytes = snapshotResult.bytes;
    retainedHistoryBytes += snapshotBytes;
    latestSnapshotHeight = options.env.height;
    prunedBytes += await maybeRotateSnapshots(historyDb, config.retainSnapshots);
    snapshotMs = options.getPerfMs() - snapshotStartedAt;
  }

  if (snapDocs > 0) {
    const retainedSnapshotHeights = await listSnapshotHeights(historyDb);
    const oldestRetainedSnapshotHeight = retainedSnapshotHeights[0] ?? 0;
    if (oldestRetainedSnapshotHeight > 0) {
      prunedBytes += await pruneHistoryBeforeHeight(historyDb, oldestRetainedSnapshotHeight);
    }
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
    await writeBatch(stateUpdate);
  }

  if (epochRotated && snapDocs > 0 && options.rotateEpochDb) {
    const rotated = await options.rotateEpochDb(options.env, latestSnapshotHeight, options.env.timestamp);
    epochDbRotated = rotated !== false;
  }

  const verboseStorageLogs =
    String(process.env['XLN_STORAGE_VERBOSE'] ?? '').toLowerCase() === '1' ||
    String(process.env['XLN_STORAGE_VERBOSE'] ?? '').toLowerCase() === 'true';
  if (verboseStorageLogs && options.env.quietRuntimeLogs !== true) {
    console.log(
      `[PERSIST] runtime=${String(options.env.runtimeId || '').slice(0, 12)} frame=${options.env.height} puts=${diff.puts.length} dels=${diff.dels.length} ` +
        `frameBytes=${frameBuffer.byteLength} diffBytes=${diffBuffer.byteLength} ` +
        `frameDbBytes=${frameDbBytes} frameDbRetained=${frameDbRetainedBytes} frameDbPruned=${frameDbPrunedBytes}/${frameDbPrunedKeys}@${frameDbLatestPrunedHeight} ` +
        `snapshotBytes=${snapshotBytes} historyBytes=${retainedHistoryBytes} ` +
        `entities=${frameTouched.touchedEntities.size} accounts=${frameTouched.touchedAccounts.size} books=${frameTouched.touchedBookEntities.size} materialized=${shouldMaterialize ? 1 : 0} overlay=${overlayRecords.length} ` +
        `highSignals=${highSignalEvents.join(',') || 'none'} ` +
        `snapDocs=${snapDocs} epoch=${epochRotated ? 1 : 0} epochDb=${epochDbRotated ? 1 : 0} ` +
        `ms(open=${options.formatPerfMs(openMs)},diff=${options.formatPerfMs(diffBuildMs)},write=${options.formatPerfMs(writeMs)},snap=${options.formatPerfMs(snapshotMs)})`,
    );
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
  };
};
