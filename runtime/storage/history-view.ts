import type { EntityTx } from '../types/entity-tx';
import type { FrameLogEntry } from '../types/logging';
import type { JInput } from '../jurisdiction/input';
import type { RuntimeHistoryRecord, RuntimeInput } from '../runtime/types';
import { cloneIsolatedEntityTxs } from '../entity/input-clone';
import { decodeValidatedBuffer, encodeBuffer, writeBatch } from './codec';
import { deleteKeyRange, iterateKeys, readRawOrNull } from './level';
import {
  HISTORY_VIEW_ACCOUNT_FRAME_BY_RUNTIME,
  HISTORY_VIEW_ENTITY_FRAME_BY_RUNTIME,
  HISTORY_VIEW_RUNTIME_ACTIVITY,
  KEY_HISTORY_VIEW_HEAD,
  STORAGE_SCHEMA_VERSION,
  encodeHeight,
  keyHistoryViewAccountFrame,
  keyHistoryViewAccountFrameByRuntime,
  keyHistoryViewAccountFrameByRuntimePrefix,
  keyHistoryViewAccountFramePrefix,
  keyHistoryViewEntityFrame,
  keyHistoryViewEntityFrameByRuntime,
  keyHistoryViewEntityFrameByRuntimePrefix,
  keyHistoryViewEntityFramePrefix,
  keyHistoryViewRuntimeActivity,
  normalizeEntityId,
  parseHistoryViewAccountFrameKey,
  parseHistoryViewEntityFrameKey,
} from './keys';
import {
  validateHistoryViewHeadValue,
  validateStoredAccountFrameValue,
  validateStoredEntityFrameValue,
  validateStoredRuntimeActivityValue,
} from './history-view-schema';
import type {
  HistoryViewPut,
  RuntimeDbLike,
  StorageHistoryViewHead,
  StoragePersistenceBoundaryHook,
  StorageRuntimeConfig,
  StorageFrameRecord,
} from './types';

type RuntimeHistoryViewBatch = ReturnType<RuntimeDbLike['batch']>;

export type StoredAccountFrameRecord = Extract<RuntimeHistoryRecord, { kind: 'accountFrame' }> & {
  runtimeHeight: number;
  timestamp: number;
};

export type StoredAccountFrameValue = {
  source: Extract<RuntimeHistoryRecord, { kind: 'accountFrame' }>['source'];
  frame: Extract<RuntimeHistoryRecord, { kind: 'accountFrame' }>['frame'];
  runtimeHeight: number;
  timestamp: number;
};

export type StoredEntityFrameRecord = Extract<RuntimeHistoryRecord, { kind: 'entityFrame' }> & {
  runtimeHeight: number;
  timestamp: number;
};

export type StoredEntityFrameValue = {
  link: Extract<RuntimeHistoryRecord, { kind: 'entityFrame' }>['link'];
  runtimeHeight: number;
  timestamp: number;
};

export type StoredRuntimeActivityValue = {
  timestamp: number;
  runtimeInput: {
    entityInputs: Array<{ entityId: string; entityTxs?: EntityTx[] }>;
    jInputs?: JInput[];
  };
  logs: FrameLogEntry[];
  touchedEntities: string[];
  touchedAccounts: Array<{ entityId: string; counterpartyId: string }>;
  touchedBookEntities: string[];
};

export type ReadHistoryViewAccountFramesOptions = {
  limit?: number;
  maxAccountHeight?: number;
  maxRuntimeHeight?: number;
};

export type StoredRuntimeActivityRecord = StoredRuntimeActivityValue & {
  kind: 'runtimeActivity';
  height: number;
};

export const buildHistoryViewPuts = (options: {
  height: number;
  timestamp: number;
  runtimeInput: RuntimeInput;
  logs: FrameLogEntry[];
  touchedEntities: string[];
  touchedAccounts: Array<{ entityId: string; counterpartyId: string }>;
  touchedBookEntities: string[];
  historyRecords?: RuntimeHistoryRecord[];
}): HistoryViewPut[] => {
  const puts: HistoryViewPut[] = [];
  const runtimeInput: StoredRuntimeActivityValue['runtimeInput'] = {
    entityInputs: options.runtimeInput.entityInputs.map((input) => ({
      entityId: input.entityId,
      ...(input.entityTxs ? { entityTxs: cloneIsolatedEntityTxs(input.entityTxs) } : {}),
    })),
    ...(options.runtimeInput.jInputs
      ? { jInputs: options.runtimeInput.jInputs.map(input => structuredClone(input)) }
      : {}),
  };
  const runtimeActivity: StoredRuntimeActivityValue = {
    timestamp: options.timestamp,
    runtimeInput,
    logs: options.logs,
    touchedEntities: options.touchedEntities,
    touchedAccounts: options.touchedAccounts,
    touchedBookEntities: options.touchedBookEntities,
  };
  validateStoredRuntimeActivityValue(runtimeActivity, options.height);
  puts.push({ key: keyHistoryViewRuntimeActivity(options.height), value: encodeBuffer(runtimeActivity) });

  for (const record of options.historyRecords ?? []) {
    if (record.kind === 'entityFrame') {
      const entityId = normalizeEntityId(record.entityId);
      const entityHeight = record.entityHeight;
      if (!entityId) throw new Error('HISTORY_VIEW_ENTITY_FRAME_ENTITY_ID_INVALID');
      if (!Number.isSafeInteger(entityHeight) || entityHeight <= 0) {
        throw new Error(`HISTORY_VIEW_ENTITY_FRAME_HEIGHT_INVALID:${String(entityHeight)}`);
      }
      const recordHeight = record.runtimeHeight ?? options.height;
      const recordTimestamp = record.timestamp ?? options.timestamp;
      const stored: StoredEntityFrameValue = {
        link: structuredClone(record.link),
        runtimeHeight: recordHeight,
        timestamp: recordTimestamp,
      };
      validateStoredEntityFrameValue(stored, entityHeight);
      puts.push({ key: keyHistoryViewEntityFrame(entityId, entityHeight), value: encodeBuffer(stored) });
      puts.push({
        key: keyHistoryViewEntityFrameByRuntime(recordHeight, entityId, entityHeight),
        value: Buffer.alloc(0),
      });
      continue;
    }
    const entityId = normalizeEntityId(record.entityId);
    const counterpartyId = normalizeEntityId(record.counterpartyId);
    const accountHeight = record.accountHeight;
    if (!entityId || !counterpartyId) throw new Error('HISTORY_VIEW_ACCOUNT_FRAME_ENTITY_ID_INVALID');
    if (!Number.isSafeInteger(accountHeight) || accountHeight <= 0) {
      throw new Error(`HISTORY_VIEW_ACCOUNT_FRAME_HEIGHT_INVALID:${String(accountHeight)}`);
    }
    const recordHeight = record.runtimeHeight ?? options.height;
    const recordTimestamp = record.timestamp ?? options.timestamp;
    const stored: StoredAccountFrameValue = {
      source: record.source,
      frame: structuredClone(record.frame),
      runtimeHeight: recordHeight,
      timestamp: recordTimestamp,
    };
    validateStoredAccountFrameValue(stored, accountHeight);
    puts.push({
      key: keyHistoryViewAccountFrame(entityId, counterpartyId, Math.floor(accountHeight)),
      value: encodeBuffer(stored),
    });
    puts.push({
      key: keyHistoryViewAccountFrameByRuntime(recordHeight, entityId, counterpartyId, Math.floor(accountHeight)),
      value: Buffer.alloc(0),
    });
  }

  return puts;
};

export const readHistoryViewHead = async (
  db: RuntimeDbLike,
  config: Required<StorageRuntimeConfig>,
): Promise<StorageHistoryViewHead> => {
  const raw = await readRawOrNull(db, KEY_HISTORY_VIEW_HEAD);
  const decoded = raw ? decodeValidatedBuffer(raw, validateHistoryViewHeadValue) : null;
  return {
    schemaVersion: STORAGE_SCHEMA_VERSION,
    latestHeight: decoded?.latestHeight ?? 0,
    latestPrunedRuntimeHeight: decoded?.latestPrunedRuntimeHeight ?? 0,
    retainedBytes: decoded?.retainedBytes ?? 0,
    maxBytes: config.historyViewMaxBytes,
    retainFrames: config.historyViewRetainFrames,
  };
};

const writeHistoryViewHead = async (
  db: RuntimeDbLike,
  head: StorageHistoryViewHead,
  onPersistenceBoundary?: StoragePersistenceBoundaryHook,
): Promise<void> => {
  const batch = db.batch();
  batch.put(KEY_HISTORY_VIEW_HEAD, encodeBuffer(head));
  await writeBatch(batch);
  await onPersistenceBoundary?.('after-history-view-prune');
};

export type HistoryViewCommitPlan = {
  puts: HistoryViewPut[];
  writtenBytes: number;
  nextHead: StorageHistoryViewHead;
};

export const prepareHistoryViewCommit = async (options: {
  db: RuntimeDbLike;
  height: number;
  puts: HistoryViewPut[];
  config: Required<StorageRuntimeConfig>;
}): Promise<HistoryViewCommitPlan> => {
  const height = Math.max(1, Math.floor(Number(options.height)));
  const head = await readHistoryViewHead(options.db, options.config);
  const writtenBytes = options.puts.reduce((sum, item) => sum + item.key.byteLength + item.value.byteLength, 0);
  const appendBytes = head.latestHeight >= height ? 0 : writtenBytes;
  const nextHead: StorageHistoryViewHead = {
    schemaVersion: STORAGE_SCHEMA_VERSION,
    latestHeight: Math.max(head.latestHeight, height),
    latestPrunedRuntimeHeight: head.latestPrunedRuntimeHeight,
    retainedBytes: head.retainedBytes + appendBytes,
    maxBytes: options.config.historyViewMaxBytes,
    retainFrames: options.config.historyViewRetainFrames,
  };

  return {
    puts: options.puts,
    writtenBytes,
    nextHead,
  };
};

export const putHistoryViewCommit = (batch: RuntimeHistoryViewBatch, plan: HistoryViewCommitPlan): void => {
  for (const item of plan.puts) batch.put(item.key, item.value);
  batch.put(KEY_HISTORY_VIEW_HEAD, encodeBuffer(plan.nextHead));
};

export const reconcileHistoryViews = async (options: {
  viewDb: RuntimeDbLike;
  firstWalHeight: number;
  latestWalHeight: number;
  readWalFrame: (height: number) => Promise<StorageFrameRecord | null>;
  config: Required<StorageRuntimeConfig>;
}): Promise<{ materializedThroughRuntimeHeight: number; writtenBytes: number }> => {
  const firstWalHeight = Math.max(1, Math.floor(Number(options.firstWalHeight)));
  const latestWalHeight = Math.max(0, Math.floor(Number(options.latestWalHeight)));
  let head = await readHistoryViewHead(options.viewDb, options.config);
  if (latestWalHeight > 0 && firstWalHeight > latestWalHeight) {
    throw new Error(
      `HISTORY_VIEW_WAL_RANGE_INVALID:first=${firstWalHeight}:latest=${latestWalHeight}`,
    );
  }
  if (head.latestHeight > latestWalHeight) {
    throw new Error(
      `HISTORY_VIEW_AHEAD_OF_WAL:view=${head.latestHeight}:wal=${latestWalHeight}`,
    );
  }
  if (head.latestHeight + 1 < firstWalHeight) {
    // A checkpoint import or WAL compaction may intentionally replace the
    // replay prefix with one complete snapshot frame. The view is rebuildable,
    // so advance its cursor to the explicit WAL floor and mark the unavailable
    // prefix as pruned. Never skip a hole at or after this floor: those frames
    // are part of the authoritative retained suffix and must fail loudly.
    head = {
      ...head,
      latestHeight: firstWalHeight - 1,
      latestPrunedRuntimeHeight: Math.max(
        head.latestPrunedRuntimeHeight,
        firstWalHeight - 1,
      ),
    };
    const floorBatch = options.viewDb.batch();
    floorBatch.put(KEY_HISTORY_VIEW_HEAD, encodeBuffer(head));
    await writeBatch(floorBatch, { sync: true });
  }
  let writtenBytes = 0;
  for (let height = head.latestHeight + 1; height <= latestWalHeight; height += 1) {
    const frame = await options.readWalFrame(height);
    if (!frame) throw new Error(`HISTORY_VIEW_WAL_FRAME_MISSING:height=${height}`);
    const puts = buildHistoryViewPuts({
      height: frame.height,
      timestamp: frame.timestamp,
      runtimeInput: frame.runtimeInput,
      logs: frame.activityLogs,
      touchedEntities: frame.touchedEntities,
      touchedAccounts: frame.touchedAccounts,
      touchedBookEntities: frame.touchedBookEntities,
      historyRecords: frame.historyRecords,
    });
    const plan = await prepareHistoryViewCommit({
      db: options.viewDb,
      height,
      puts,
      config: options.config,
    });
    const batch = options.viewDb.batch();
    putHistoryViewCommit(batch, plan);
    await writeBatch(batch, { sync: true });
    writtenBytes += plan.writtenBytes;
  }
  return {
    materializedThroughRuntimeHeight: latestWalHeight,
    writtenBytes,
  };
};

const pruneHistoryViewBeforeRuntimeHeight = async (
  db: RuntimeDbLike,
  heightInclusive: number,
  onPersistenceBoundary?: StoragePersistenceBoundaryHook,
): Promise<{ removedBytes: number; removedKeys: number }> => {
  const cutoff = Math.max(0, Math.floor(Number(heightInclusive)));
  if (cutoff <= 0) return { removedBytes: 0, removedKeys: 0 };

  let removedBytes = 0;
  let removedKeys = 0;
  const onPruneBatch = async (): Promise<void> => {
    await onPersistenceBoundary?.('after-history-view-prune');
  };
  const runtimeActivityPruned = await deleteKeyRange(
    db,
    {
      gte: Buffer.from([HISTORY_VIEW_RUNTIME_ACTIVITY]),
      lt: Buffer.concat([Buffer.from([HISTORY_VIEW_RUNTIME_ACTIVITY]), encodeHeight(cutoff + 1)]),
    },
    () => true,
    onPruneBatch,
  );
  removedBytes += runtimeActivityPruned.removedBytes;
  removedKeys += runtimeActivityPruned.removedKeys;

  // Runtime retention owns only Runtime activity and its reverse indexes.
  // Certified Entity/Account frame bodies are independent replica histories:
  // deleting them because the hosting Runtime compacted would couple child
  // recovery to an unrelated parent epoch. Their eventual pruning requires a
  // replica checkpoint and an explicit local archival policy.
  const accountRuntimeIndexesPruned = await deleteKeyRange(
    db,
    {
    gte: keyHistoryViewAccountFrameByRuntimePrefix(),
    lt: Buffer.concat([Buffer.from([HISTORY_VIEW_ACCOUNT_FRAME_BY_RUNTIME]), encodeHeight(cutoff + 1)]),
    },
    () => true,
    onPruneBatch,
  );
  removedBytes += accountRuntimeIndexesPruned.removedBytes;
  removedKeys += accountRuntimeIndexesPruned.removedKeys;

  const entityRuntimeIndexesPruned = await deleteKeyRange(
    db,
    {
      gte: keyHistoryViewEntityFrameByRuntimePrefix(),
      lt: Buffer.concat([Buffer.from([HISTORY_VIEW_ENTITY_FRAME_BY_RUNTIME]), encodeHeight(cutoff + 1)]),
    },
    () => true,
    onPruneBatch,
  );
  removedBytes += entityRuntimeIndexesPruned.removedBytes;
  removedKeys += entityRuntimeIndexesPruned.removedKeys;

  return { removedBytes, removedKeys };
};

export const pruneHistoryViewRetention = async (options: {
  db: RuntimeDbLike;
  height: number;
  head: StorageHistoryViewHead;
  config: Required<StorageRuntimeConfig>;
  onPersistenceBoundary?: StoragePersistenceBoundaryHook;
}): Promise<{
  prunedBytes: number;
  retainedBytes: number;
  prunedKeys: number;
  latestPrunedRuntimeHeight: number;
}> => {
  const height = Math.max(1, Math.floor(Number(options.height)));
  const nextHead = options.head;
  if (nextHead.retainedBytes <= options.config.historyViewMaxBytes || height <= options.config.historyViewRetainFrames) {
    return {
      prunedBytes: 0,
      retainedBytes: nextHead.retainedBytes,
      prunedKeys: 0,
      latestPrunedRuntimeHeight: nextHead.latestPrunedRuntimeHeight,
    };
  }

  const cutoff = height - options.config.historyViewRetainFrames;
  const pruned = await pruneHistoryViewBeforeRuntimeHeight(
    options.db,
    cutoff,
    options.onPersistenceBoundary,
  );
  const finalHead: StorageHistoryViewHead = {
    ...nextHead,
    latestPrunedRuntimeHeight: Math.max(nextHead.latestPrunedRuntimeHeight, cutoff),
    retainedBytes: Math.max(0, nextHead.retainedBytes - pruned.removedBytes),
  };
  await writeHistoryViewHead(options.db, finalHead, options.onPersistenceBoundary);
  return {
    prunedBytes: pruned.removedBytes,
    retainedBytes: finalHead.retainedBytes,
    prunedKeys: pruned.removedKeys,
    latestPrunedRuntimeHeight: finalHead.latestPrunedRuntimeHeight,
  };
};

export const readHistoryViewRuntimeActivity = async (
  db: RuntimeDbLike,
  height: number,
): Promise<StoredRuntimeActivityRecord | null> => {
  const targetHeight = Number.isFinite(height) ? Math.max(1, Math.floor(height)) : 0;
  if (targetHeight <= 0) return null;
  const raw = await readRawOrNull(db, keyHistoryViewRuntimeActivity(targetHeight));
  if (!raw) return null;
  const value = decodeValidatedBuffer(raw, decoded =>
    validateStoredRuntimeActivityValue(decoded, targetHeight));
  return {
    kind: 'runtimeActivity',
    height: targetHeight,
    timestamp: value.timestamp,
    runtimeInput: {
      entityInputs: value.runtimeInput.entityInputs.map(input => ({
        entityId: input.entityId,
        ...(input.entityTxs ? { entityTxs: cloneIsolatedEntityTxs(input.entityTxs) } : {}),
      })),
      ...(value.runtimeInput.jInputs
        ? { jInputs: value.runtimeInput.jInputs.map(input => structuredClone(input)) }
        : {}),
    },
    logs: value.logs,
    touchedEntities: value.touchedEntities,
    touchedAccounts: value.touchedAccounts,
    touchedBookEntities: value.touchedBookEntities,
  };
};

export const readHistoryViewAccountFrames = async (
  db: RuntimeDbLike,
  entityId: string,
  counterpartyId: string,
  options: ReadHistoryViewAccountFramesOptions = {},
): Promise<StoredAccountFrameRecord[]> => {
  const limit = options.limit ?? Number.POSITIVE_INFINITY;
  if (limit !== Number.POSITIVE_INFINITY && (!Number.isSafeInteger(limit) || limit <= 0)) {
    throw new Error(`HISTORY_VIEW_ACCOUNT_FRAME_LIMIT_INVALID:${String(limit)}`);
  }
  const maxAccountHeight = options.maxAccountHeight ?? Number.MAX_SAFE_INTEGER;
  const maxRuntimeHeight = options.maxRuntimeHeight ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(maxAccountHeight) || maxAccountHeight < 0) {
    throw new Error(`HISTORY_VIEW_ACCOUNT_FRAME_MAX_ACCOUNT_HEIGHT_INVALID:${String(maxAccountHeight)}`);
  }
  if (!Number.isSafeInteger(maxRuntimeHeight) || maxRuntimeHeight < 0) {
    throw new Error(`HISTORY_VIEW_ACCOUNT_FRAME_MAX_RUNTIME_HEIGHT_INVALID:${String(maxRuntimeHeight)}`);
  }
  if (maxAccountHeight === 0 || maxRuntimeHeight === 0) return [];

  const prefix = keyHistoryViewAccountFramePrefix(entityId, counterpartyId);
  const range = maxAccountHeight < Number.MAX_SAFE_INTEGER
    ? { gte: prefix, lt: keyHistoryViewAccountFrame(entityId, counterpartyId, maxAccountHeight + 1), reverse: true }
    : { prefix, reverse: true };
  const records: StoredAccountFrameRecord[] = [];
  for await (const key of iterateKeys(db, range)) {
    const parsed = parseHistoryViewAccountFrameKey(key);
    const accountHeight = parsed.accountHeight;
    if (accountHeight > maxAccountHeight) continue;
    const record = decodeValidatedBuffer(await db.get(key), decoded =>
      validateStoredAccountFrameValue(decoded, accountHeight));
    if (record.runtimeHeight > maxRuntimeHeight) continue;
    const frameHeight = record.frame.height;
    if (frameHeight !== accountHeight) {
      throw new Error(`HISTORY_VIEW_ACCOUNT_FRAME_HEIGHT_MISMATCH: key=${accountHeight} frame=${frameHeight}`);
    }
    records.push({
      kind: 'accountFrame',
      entityId: normalizeEntityId(parsed.entityId),
      counterpartyId: normalizeEntityId(parsed.counterpartyId),
      accountHeight,
      source: record.source,
      frame: record.frame,
      runtimeHeight: record.runtimeHeight,
      timestamp: record.timestamp,
    });
    if (records.length >= limit) break;
  }
  return records.sort((left, right) => left.accountHeight - right.accountHeight);
};

export const readHistoryViewEntityFrames = async (
  db: RuntimeDbLike,
  entityId: string,
  options: { limit?: number; maxEntityHeight?: number; maxRuntimeHeight?: number } = {},
): Promise<StoredEntityFrameRecord[]> => {
  const limit = options.limit ?? Number.POSITIVE_INFINITY;
  if (limit !== Number.POSITIVE_INFINITY && (!Number.isSafeInteger(limit) || limit <= 0)) {
    throw new Error(`HISTORY_VIEW_ENTITY_FRAME_LIMIT_INVALID:${String(limit)}`);
  }
  const maxEntityHeight = options.maxEntityHeight ?? Number.MAX_SAFE_INTEGER;
  const maxRuntimeHeight = options.maxRuntimeHeight ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(maxEntityHeight) || maxEntityHeight < 0) {
    throw new Error(`HISTORY_VIEW_ENTITY_FRAME_MAX_ENTITY_HEIGHT_INVALID:${String(maxEntityHeight)}`);
  }
  if (!Number.isSafeInteger(maxRuntimeHeight) || maxRuntimeHeight < 0) {
    throw new Error(`HISTORY_VIEW_ENTITY_FRAME_MAX_RUNTIME_HEIGHT_INVALID:${String(maxRuntimeHeight)}`);
  }
  if (maxEntityHeight === 0 || maxRuntimeHeight === 0) return [];
  const prefix = keyHistoryViewEntityFramePrefix(entityId);
  const range = maxEntityHeight < Number.MAX_SAFE_INTEGER
    ? { gte: prefix, lt: keyHistoryViewEntityFrame(entityId, maxEntityHeight + 1), reverse: true }
    : { prefix, reverse: true };
  const records: StoredEntityFrameRecord[] = [];
  for await (const key of iterateKeys(db, range)) {
    const parsed = parseHistoryViewEntityFrameKey(key);
    if (normalizeEntityId(parsed.entityId) !== normalizeEntityId(entityId)) {
      throw new Error(`HISTORY_VIEW_ENTITY_FRAME_KEY_BINDING_MISMATCH:${parsed.entityId}:${entityId}`);
    }
    const entityHeight = parsed.entityHeight;
    if (entityHeight > maxEntityHeight) continue;
    const value = decodeValidatedBuffer(await db.get(key), decoded =>
      validateStoredEntityFrameValue(decoded, entityHeight));
    if (value.runtimeHeight > maxRuntimeHeight) continue;
    records.push({
      kind: 'entityFrame',
      entityId: normalizeEntityId(entityId),
      entityHeight,
      link: structuredClone(value.link),
      runtimeHeight: value.runtimeHeight,
      timestamp: value.timestamp,
    });
    if (records.length >= limit) break;
  }
  return records.sort((left, right) => left.entityHeight - right.entityHeight);
};
