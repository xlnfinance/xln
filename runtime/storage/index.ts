import type { BookState } from '../orderbook';
import { decodeBuffer, encodeBuffer, writeBatch } from './codec';
import {
  docRefKey,
  docValueKey,
  liveKeyForDoc,
  liveKeyForRef,
} from './doc-refs';
import {
  listKeys,
  measurePrefixBytes,
  readJsonOrNull,
} from './level';
import { buildFrameDbPuts, writeFrameDbPutsWithRetention } from './frame-db';
import {
  assertEntityHashesEqual,
  computeStorageFrameHash,
  computeStorageStateRoot,
  prepareStorageCanonicalStateHashes,
  prepareStorageStateHashes,
  readAllEntityHashDocs,
  toFrameEntityHashes,
} from './hashes';
import {
  createSnapshot,
  listSnapshotHeights,
  maybeRotateSnapshots,
  pruneHistoryBeforeHeight,
} from './lifecycle';
import {
  hydrateEntityStateFromStorage,
  projectReplicaMeta,
} from './projections';
import {
  buildBookDeletionsFromOverlay,
  buildDocPuts,
  mergeOverlayRecordsIntoEnv,
  storageRefsFromOverlay,
} from './overlay-docs';
import { buildReplicaLookup } from './replicas';
import {
  DEFAULT_ACCOUNT_MERKLE_RADIX,
  DEFAULT_EPOCH_MAX_BYTES,
  DEFAULT_FRAME_DB_MAX_BYTES,
  DEFAULT_FRAME_DB_RETAIN_FRAMES,
  DEFAULT_MATERIALIZE_PERIOD_FRAMES,
  DEFAULT_RETAIN_SNAPSHOTS,
  DEFAULT_SNAPSHOT_PERIOD_FRAMES,
  KEY_DIFF,
  KEY_FRAME,
  KEY_HEAD,
  KEY_LIVE_ACCOUNT,
  KEY_LIVE_BOOK,
  KEY_LIVE_ENTITY,
  KEY_LIVE_REPLICA_META,
  KEY_SNAPSHOT_ACCOUNT,
  KEY_SNAPSHOT_BOOK,
  KEY_SNAPSHOT_ENTITY,
  KEY_SNAPSHOT_MANIFEST,
  STORAGE_SCHEMA_VERSION,
  STORAGE_VERIFY_TAIL_FRAMES,
  ZERO_FRAME_HASH,
  decodeEntityId,
  keyDiff,
  keyFrame,
  keyLiveAccountPrefix,
  keyLiveBookPrefix,
  keyLiveEntity,
  keyLiveReplicaMeta,
  keySnapshotAccountPrefix,
  keySnapshotBookPrefix,
  keySnapshotEntity,
  keySnapshotEntityPrefix,
  normalizeEntityId,
  parseLiveAccountKey,
  parseLiveBookKey,
} from './keys';
import { computeCanonicalRuntimeStateHash } from './canonical-hash';
import type { EntityInput, EntityState, Env, RuntimeInput, RuntimeFrameDbRecord } from '../types';
import type {
  PerfDeps,
  RuntimeDbLike,
  RuntimeFrameDbLike,
  StorageAccountDoc,
  StorageDebugStats,
  StorageDiffRecord,
  StorageDoc,
  StorageDocRef,
  StorageEntityCoreDoc,
  StorageEntityHashDoc,
  StorageFrameRecord,
  StorageHead,
  StorageReplicaMeta,
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
  seedFreshStorageEpoch,
} from './lifecycle';
export {
  computeStorageDebugStateHashFromEnv,
  computeStorageFrameHash,
  computeStorageStateRoot,
} from './hashes';
export {
  readStorageOverlayRecordsFromDiffs,
} from './overlay-docs';

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
  StorageHashCell,
  StorageHead,
  StorageReplicaMeta,
  StorageRuntimeConfig,
  StorageSnapshotManifest,
} from './types';

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
  accountMerkleRadix: env.runtimeConfig?.storage?.accountMerkleRadix === 256 ? 256 : DEFAULT_ACCOUNT_MERKLE_RADIX,
});

const readHead = async (db: RuntimeDbLike, config: Required<StorageRuntimeConfig>): Promise<StorageHead> => {
  const head = await readJsonOrNull<StorageHead>(db, KEY_HEAD);
  if (head) {
    return {
      ...head,
      latestMaterializedHeight: Math.max(
        0,
        Math.floor(Number(head.latestMaterializedHeight ?? head.latestSnapshotHeight ?? head.latestHeight ?? 0)),
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

export type StorageFrameSaveResult = {
  materialized: boolean;
  materializedOverlayRecords: number;
};

export const saveRuntimeFrameToStorage = async (options: {
  env: Env;
  stateHash?: string;
  currentFrameInput?: RuntimeInput;
  currentFrameOutputs?: EntityInput[];
  frameDbRecords?: RuntimeFrameDbRecord[];
  tryOpenDb: (env: Env) => Promise<boolean>;
  getRuntimeDb: (env: Env) => RuntimeDbLike;
  tryOpenFrameDb: (env: Env) => Promise<boolean>;
  getFrameDb: (env: Env) => RuntimeFrameDbLike;
  rotateEpochDb?: (env: Env, snapshotHeight: number) => Promise<void>;
} & PerfDeps): Promise<StorageFrameSaveResult> => {
  const config = runtimeConfigFromEnv(options.env);
  if (!config.enabled) return { materialized: false, materializedOverlayRecords: 0 };

  const state = options.env.runtimeState ?? {};
  if (state.persistencePaused) return { materialized: false, materializedOverlayRecords: 0 };

  const openStartedAt = options.getPerfMs();
  const opened = await options.tryOpenDb(options.env);
  if (!opened) return { materialized: false, materializedOverlayRecords: 0 };
  const db = options.getRuntimeDb(options.env);
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
  const head = await readHead(db, config);
  if (head.latestHeight !== options.env.height - 1) {
    throw new Error(
      `STORAGE_APPEND_INVARIANT_FAILED: refusing to write frame ${options.env.height} after persisted head ${head.latestHeight}`,
    );
  }
  const previousFrame = head.latestHeight > 0 ? await readStorageFrameRecord(db, head.latestHeight) : null;
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
  const materializedEntities = materializedTouched
    ? Array.from(materializedTouched.touchedEntities.values()).sort()
    : [];
  const canonicalHashes = shouldMaterialize
    ? prepareStorageCanonicalStateHashes(options.env, materializedEntities, previousFrame, replicaLookup)
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
    frameOutputs: (options.currentFrameOutputs ?? []).map((output) => ({ ...output })),
    ...(shouldMaterialize && overlayRecords.length > 0
      ? { overlayRecords: overlayRecords.map((record) => ({ ...record })) }
      : {}),
    // Logs/history are indexed in the frame DB. Keep the runtime state journal
    // focused on replay inputs/outputs and state hashes.
    logs: [],
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
  const projectedHistoryBytes =
    head.retainedHistoryBytes +
    frameKey.byteLength +
    frameBuffer.byteLength +
    diffKey.byteLength +
    diffBuffer.byteLength;
  let frameDbBytes = 0;
  let frameDbPrunedBytes = 0;
  let frameDbRetainedBytes = 0;
  let frameDbPrunedKeys = 0;
  let frameDbLatestPrunedHeight = 0;
  const batch = db.batch();
  batch.put(frameKey, frameBuffer);
  batch.put(diffKey, diffBuffer);
  if (preparedHashes) {
    for (const doc of materializedPuts) {
      batch.put(liveKeyForDoc(doc), preparedHashes.docValueBuffers.get(docValueKey(doc)) ?? encodeBuffer(doc.value));
    }
    for (const ref of materializedDels) {
      if (typeof batch.del === 'function') batch.del(liveKeyForRef(ref));
    }
    for (const item of preparedHashes.docHashPuts) {
      batch.put(item.key, item.value);
    }
    for (const key of preparedHashes.docHashDels) {
      if (typeof batch.del === 'function') batch.del(key);
    }
    for (const item of preparedHashes.entityHashPuts) {
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
    retainedHistoryBytes: projectedHistoryBytes,
  };
  batch.put(KEY_HEAD, encodeBuffer(nextHead));
  await writeBatch(batch);
  if (state) {
    state.currentStorageOverlayMarks = [];
  }
  if (preparedHashes) {
    state.storageEntityHashDocs = preparedHashes.entityHashDocs;
  }
  if (frameDbPuts.length > 0) {
    try {
      const frameDbReady = await options.tryOpenFrameDb(options.env);
      if (!frameDbReady) throw new Error('RUNTIME_FRAME_DB_UNAVAILABLE');
      const frameDb = options.getFrameDb(options.env);
      const frameDbResult = await writeFrameDbPutsWithRetention({
        db: frameDb,
        height: options.env.height,
        puts: frameDbPuts,
        config,
      });
      frameDbBytes = frameDbResult.writtenBytes;
      frameDbPrunedBytes = frameDbResult.prunedBytes;
      frameDbRetainedBytes = frameDbResult.retainedBytes;
      frameDbPrunedKeys = frameDbResult.prunedKeys;
      frameDbLatestPrunedHeight = frameDbResult.latestPrunedRuntimeHeight;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[PERSIST] frame DB secondary-index write failed after main commit: ${message}`);
    }
  }
  const writeMs = options.getPerfMs() - writeStartedAt;

  let snapshotMs = 0;
  let snapDocs = 0;
  let snapshotBytes = 0;
  let prunedBytes = 0;
  let epochRotated = false;
  let epochDbRotated = false;
  let retainedHistoryBytes = nextHead.retainedHistoryBytes;
  let latestSnapshotHeight = head.latestSnapshotHeight;

  if (snapshotDue || snapshotRequiredByBytes) {
    const snapshotStartedAt = options.getPerfMs();
    const snapshotResult = await createSnapshot(db, options.env.height);
    snapDocs = snapshotResult.docCount;
    snapshotBytes = snapshotResult.bytes;
    retainedHistoryBytes += snapshotBytes;
    latestSnapshotHeight = options.env.height;
    prunedBytes += await maybeRotateSnapshots(db, config.retainSnapshots);
    snapshotMs = options.getPerfMs() - snapshotStartedAt;
    if (snapshotRequiredByBytes && !snapshotDue) {
      epochRotated = true;
    }
  }

  if (snapDocs > 0) {
    const retainedSnapshotHeights = await listSnapshotHeights(db);
    const oldestRetainedSnapshotHeight = retainedSnapshotHeights[0] ?? 0;
    if (oldestRetainedSnapshotHeight > 0) {
      prunedBytes += await pruneHistoryBeforeHeight(db, oldestRetainedSnapshotHeight);
    }
  }

  retainedHistoryBytes = Math.max(0, retainedHistoryBytes - prunedBytes);

  if (snapDocs > 0 || prunedBytes > 0) {
    const latest = await readHead(db, config);
    const update = db.batch();
    update.put(
      KEY_HEAD,
      encodeBuffer({
        ...latest,
        latestSnapshotHeight,
        retainedHistoryBytes,
      }),
    );
    await writeBatch(update);
  }

  if (snapDocs > 0 && retainedHistoryBytes > config.epochMaxBytes && options.rotateEpochDb) {
    await options.rotateEpochDb(options.env, latestSnapshotHeight);
    epochDbRotated = true;
  }

  const verboseStorageLogs =
    String(process.env['XLN_STORAGE_VERBOSE'] ?? process.env['RUNTIME_VERBOSE_LOGS'] ?? '').toLowerCase() === '1' ||
    String(process.env['XLN_STORAGE_VERBOSE'] ?? process.env['RUNTIME_VERBOSE_LOGS'] ?? '').toLowerCase() === 'true';
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
  };
};

export const readStorageHead = async (
  db: RuntimeDbLike,
): Promise<StorageHead | null> => readJsonOrNull<StorageHead>(db, KEY_HEAD);

export const readStorageFrameRecord = async (
  db: RuntimeDbLike,
  height: number,
): Promise<StorageFrameRecord | null> => {
  const targetHeight = Number.isFinite(height) ? Math.max(1, Math.floor(height)) : 0;
  if (targetHeight <= 0) return null;
  return readJsonOrNull<StorageFrameRecord>(db, keyFrame(targetHeight));
};

export const readStorageReplicaMeta = async (
  db: RuntimeDbLike,
  entityId: string,
): Promise<StorageReplicaMeta | null> => readJsonOrNull<StorageReplicaMeta>(db, keyLiveReplicaMeta(entityId));

export const verifyStorageTailIntegrity = async (
  db: RuntimeDbLike,
  options: { tailFrames?: number } = {},
): Promise<{ latestHeight: number; checkedFrames: number }> => {
  const head = await readJsonOrNull<StorageHead>(db, KEY_HEAD);
  if (!head || head.latestHeight <= 0) return { latestHeight: 0, checkedFrames: 0 };
  const latestHeight = Math.max(0, Math.floor(Number(head.latestHeight)));
  const tailFrames = Math.max(1, Math.floor(Number(options.tailFrames ?? STORAGE_VERIFY_TAIL_FRAMES)));
  const startHeight = Math.max(1, latestHeight - tailFrames + 1);
  let previousHash = ZERO_FRAME_HASH;
  if (startHeight > 1) {
    const previous = await readStorageFrameRecord(db, startHeight - 1);
    if (!previous) throw new Error(`STORAGE_VERIFY_PREV_FRAME_MISSING: height=${startHeight - 1}`);
    previousHash = previous.frameHash ?? computeStorageFrameHash(previous);
  }

  let checkedFrames = 0;
  let latestRecord: StorageFrameRecord | null = null;
  for (let height = startHeight; height <= latestHeight; height += 1) {
    const record = await readStorageFrameRecord(db, height);
    if (!record) throw new Error(`STORAGE_VERIFY_FRAME_MISSING: height=${height}`);
    if (record.height !== height) throw new Error(`STORAGE_VERIFY_FRAME_HEIGHT_MISMATCH: key=${height} record=${record.height}`);
    if (record.prevFrameHash !== previousHash) {
      throw new Error(`STORAGE_VERIFY_FRAME_CHAIN_BROKEN: height=${height} expectedPrev=${previousHash} actualPrev=${record.prevFrameHash ?? 'none'}`);
    }
    if (!Array.isArray(record.entityHashes)) {
      throw new Error(`STORAGE_VERIFY_ENTITY_HASHES_MISSING: height=${height}`);
    }
    if (record.materializedState !== false) {
      const expectedStateHash = computeStorageStateRoot(record.entityHashes);
      if (record.stateHash !== expectedStateHash) {
        throw new Error(`STORAGE_VERIFY_STATE_HASH_MISMATCH: height=${height} expected=${expectedStateHash} actual=${record.stateHash}`);
      }
      if (record.canonicalStateHash || Array.isArray(record.canonicalEntityHashes)) {
        if (!Array.isArray(record.canonicalEntityHashes) || !record.canonicalStateHash) {
          throw new Error(`STORAGE_VERIFY_CANONICAL_HASH_MISSING: height=${height}`);
        }
        const expectedCanonicalHash = computeCanonicalRuntimeStateHash(record.height, record.timestamp, record.canonicalEntityHashes);
        if (record.canonicalStateHash !== expectedCanonicalHash) {
          throw new Error(`STORAGE_VERIFY_CANONICAL_HASH_MISMATCH: height=${height} expected=${expectedCanonicalHash} actual=${record.canonicalStateHash}`);
        }
      }
    }
    const actualFrameHash = computeStorageFrameHash(record);
    if (record.frameHash !== actualFrameHash) {
      throw new Error(`STORAGE_VERIFY_FRAME_HASH_MISMATCH: height=${height} expected=${actualFrameHash} actual=${record.frameHash ?? 'none'}`);
    }
    previousHash = actualFrameHash;
    latestRecord = record;
    checkedFrames += 1;
  }

  if (latestRecord) {
    assertEntityHashesEqual(
      toFrameEntityHashes((await readAllEntityHashDocs(db)).values()),
      latestRecord.entityHashes,
      `latestHeight=${latestHeight}`,
    );
  }
  return { latestHeight, checkedFrames };
};

export const listStorageSnapshotHeights = async (db: RuntimeDbLike): Promise<number[]> => {
  return listSnapshotHeights(db);
};

export const findStorageLatestSnapshotAtOrBelow = async (
  db: RuntimeDbLike,
  height: number,
): Promise<number> => {
  return findLatestSnapshotAtOrBelow(db, height);
};

export const listStorageLiveEntityIds = async (db: RuntimeDbLike): Promise<string[]> => {
  const keys = await listKeys(db, Buffer.from([KEY_LIVE_ENTITY]));
  return keys.map((key) => decodeEntityId(key.subarray(1, 33)));
};

export const listStorageSnapshotEntityIds = async (
  db: RuntimeDbLike,
  height: number,
): Promise<string[]> => {
  const targetHeight = Number.isFinite(height) ? Math.max(1, Math.floor(height)) : 0;
  if (targetHeight <= 0) return [];
  const keys = await listKeys(db, keySnapshotEntityPrefix(targetHeight));
  return keys.map((key) => decodeEntityId(key.subarray(9, 41)));
};

const applyDocs = (
  target: Map<string, StorageDoc>,
  puts: StorageDoc[],
  dels: StorageDocRef[],
  entityId?: string,
): void => {
  const filterEntity = entityId ? normalizeEntityId(entityId) : null;
  for (const ref of dels) {
    if (filterEntity) {
      if (normalizeEntityId(ref.entityId) !== filterEntity) continue;
    }
    target.delete(docRefKey(ref));
  }
  for (const doc of puts) {
    if (filterEntity && normalizeEntityId(doc.entityId) !== filterEntity) continue;
    target.set(docValueKey(doc), doc);
  }
};

const loadSnapshotDocsForEntity = async (db: RuntimeDbLike, snapshotHeight: number, entityId: string): Promise<Map<string, StorageDoc>> => {
  const docs = new Map<string, StorageDoc>();

  const entityBuffer = await readJsonOrNull<StorageEntityCoreDoc>(db, keySnapshotEntity(snapshotHeight, entityId));
  if (entityBuffer) {
    docs.set(`e:${normalizeEntityId(entityId)}`, { family: 'entity', entityId: normalizeEntityId(entityId), value: entityBuffer });
  }

  const accountKeys = await listKeys(db, keySnapshotAccountPrefix(snapshotHeight, entityId));
  for (const key of accountKeys) {
    const entity = decodeEntityId(key.subarray(9, 41));
    const counterparty = decodeEntityId(key.subarray(41, 73));
    const value = decodeBuffer<StorageAccountDoc>(await db.get(key));
    docs.set(`a:${normalizeEntityId(entity)}:${normalizeEntityId(counterparty)}`, {
      family: 'account',
      entityId: normalizeEntityId(entity),
      counterpartyId: normalizeEntityId(counterparty),
      value,
    });
  }

  const bookKeys = await listKeys(db, keySnapshotBookPrefix(snapshotHeight, entityId));
  for (const key of bookKeys) {
    const parsed = parseLiveBookKey(key, 9);
    const value = decodeBuffer<BookState>(await db.get(key));
    docs.set(`b:${normalizeEntityId(parsed.entityId)}:${parsed.pairId}`, {
      family: 'book',
      entityId: normalizeEntityId(parsed.entityId),
      pairId: parsed.pairId,
      value,
    });
  }

  return docs;
};

const findLatestSnapshotAtOrBelow = async (db: RuntimeDbLike, height: number): Promise<number> => {
  const heights = await listSnapshotHeights(db);
  let best = 0;
  for (const value of heights) {
    if (value <= height && value > best) best = value;
  }
  return best;
};

export const loadEntityStateFromStorage = async (options: {
  env: Env;
  tryOpenDb: (env: Env) => Promise<boolean>;
  getRuntimeDb: (env: Env) => RuntimeDbLike;
  entityId: string;
  height?: number;
}): Promise<EntityState | null> => {
  const opened = await options.tryOpenDb(options.env);
  if (!opened) return null;
  const db = options.getRuntimeDb(options.env);
  const head = await readJsonOrNull<StorageHead>(db, KEY_HEAD);
  if (!head) return null;
  const targetHeight = Math.min(options.height ?? head.latestHeight, head.latestHeight);
  const entityId = normalizeEntityId(options.entityId);
  const latestMaterializedHeight = Math.max(
    0,
    Math.floor(Number(head.latestMaterializedHeight ?? head.latestSnapshotHeight ?? head.latestHeight ?? 0)),
  );

  if (targetHeight === latestMaterializedHeight) {
    const entityCore = await readJsonOrNull<StorageEntityCoreDoc>(db, keyLiveEntity(entityId));
    if (!entityCore) return null;
    const accounts = new Map<string, StorageAccountDoc>();
    for (const key of await listKeys(db, keyLiveAccountPrefix(entityId))) {
      const parsed = parseLiveAccountKey(key);
      const doc = decodeBuffer<StorageAccountDoc>(await db.get(key));
      accounts.set(parsed.counterpartyId, doc);
    }
    const books = new Map<string, BookState>();
    for (const key of await listKeys(db, keyLiveBookPrefix(entityId))) {
      const parsed = parseLiveBookKey(key);
      books.set(parsed.pairId, decodeBuffer<BookState>(await db.get(key)));
    }
    return hydrateEntityStateFromStorage({ core: entityCore, accounts, books });
  }

  const baseSnapshotHeight = await findLatestSnapshotAtOrBelow(db, targetHeight);
  const docs = baseSnapshotHeight > 0
    ? await loadSnapshotDocsForEntity(db, baseSnapshotHeight, entityId)
    : new Map<string, StorageDoc>();

  let cursor = baseSnapshotHeight + 1;
  while (cursor <= targetHeight) {
    const diff = await readJsonOrNull<StorageDiffRecord>(db, keyDiff(cursor));
    if (diff) {
      applyDocs(docs, diff.puts, diff.dels, entityId);
    }
    cursor += 1;
  }

  const core = docs.get(`e:${entityId}`) as Extract<StorageDoc, { family: 'entity' }> | undefined;
  if (!core) return null;
  const accounts = new Map<string, StorageAccountDoc>();
  const books = new Map<string, BookState>();
  for (const doc of docs.values()) {
    if (doc.family === 'account' && normalizeEntityId(doc.entityId) === entityId) {
      accounts.set(doc.counterpartyId, doc.value);
    } else if (doc.family === 'book' && normalizeEntityId(doc.entityId) === entityId) {
      books.set(doc.pairId, doc.value);
    }
  }

  return hydrateEntityStateFromStorage({ core: core.value, accounts, books });
};

export const inspectStorage = async (options: {
  env: Env;
  tryOpenDb: (env: Env) => Promise<boolean>;
  getRuntimeDb: (env: Env) => RuntimeDbLike;
}): Promise<StorageDebugStats | null> => {
  const opened = await options.tryOpenDb(options.env);
  if (!opened) return null;
  const db = options.getRuntimeDb(options.env);
  const [
    head,
    frameStats,
    diffStats,
    snapshotManifestStats,
    snapshotEntityStats,
    snapshotAccountStats,
    snapshotBookStats,
    snapshotHeights,
    liveEntityStats,
    liveAccountStats,
    liveBookStats,
    liveReplicaMetaStats,
  ] = await Promise.all([
    readJsonOrNull<StorageHead>(db, KEY_HEAD),
    measurePrefixBytes(db, Buffer.from([KEY_FRAME])),
    measurePrefixBytes(db, Buffer.from([KEY_DIFF])),
    measurePrefixBytes(db, Buffer.from([KEY_SNAPSHOT_MANIFEST])),
    measurePrefixBytes(db, Buffer.from([KEY_SNAPSHOT_ENTITY])),
    measurePrefixBytes(db, Buffer.from([KEY_SNAPSHOT_ACCOUNT])),
    measurePrefixBytes(db, Buffer.from([KEY_SNAPSHOT_BOOK])),
    listSnapshotHeights(db),
    measurePrefixBytes(db, Buffer.from([KEY_LIVE_ENTITY])),
    measurePrefixBytes(db, Buffer.from([KEY_LIVE_ACCOUNT])),
    measurePrefixBytes(db, Buffer.from([KEY_LIVE_BOOK])),
    measurePrefixBytes(db, Buffer.from([KEY_LIVE_REPLICA_META])),
  ]);

  const snapshotBytes =
    snapshotManifestStats.bytes +
    snapshotEntityStats.bytes +
    snapshotAccountStats.bytes +
    snapshotBookStats.bytes;
  const liveBytes = liveEntityStats.bytes + liveAccountStats.bytes + liveBookStats.bytes + liveReplicaMetaStats.bytes;
  const historyBytes = frameStats.bytes + diffStats.bytes + snapshotBytes;
  const totalBytes = historyBytes + liveBytes;

  return {
    head,
    frameCount: frameStats.count,
    diffCount: diffStats.count,
    snapshotHeights,
    liveEntityCount: liveEntityStats.count,
    liveAccountCount: liveAccountStats.count,
    liveBookCount: liveBookStats.count,
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
    ),
  };
};
