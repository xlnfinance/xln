import type { EntityTx, FrameLogEntry, JInput, RuntimeFrameDbRecord, RuntimeInput } from '../types';
import { cloneIsolatedEntityTxs } from '../protocol/runtime-input-clone';
import { decodeValidatedBuffer, encodeBuffer, writeBatch } from './codec';
import { deleteKeyRange, deleteKeys, iterateKeys, readRawOrNull } from './level';
import {
  FRAME_DB_ACCOUNT_FRAME_BY_RUNTIME,
  FRAME_DB_ENTITY_FRAME_BY_RUNTIME,
  FRAME_DB_RUNTIME_ACTIVITY,
  KEY_FRAME_DB_HEAD,
  STORAGE_SCHEMA_VERSION,
  encodeHeight,
  keyFrameDbAccountFrame,
  keyFrameDbAccountFrameByRuntime,
  keyFrameDbAccountFrameByRuntimePrefix,
  keyFrameDbAccountFramePrefix,
  keyFrameDbEntityFrame,
  keyFrameDbEntityFrameByRuntime,
  keyFrameDbEntityFrameByRuntimePrefix,
  keyFrameDbEntityFramePrefix,
  keyFrameDbRuntimeActivity,
  normalizeEntityId,
  parseFrameDbAccountFrameKey,
  parseFrameDbAccountFrameRuntimeIndexKey,
  parseFrameDbEntityFrameRuntimeIndexKey,
} from './keys';
import {
  validateFrameDbHeadValue,
  validateStoredAccountFrameValue,
  validateStoredEntityFrameValue,
  validateStoredRuntimeActivityValue,
} from './frame-db-schema';
import type {
  FrameDbPut,
  RuntimeFrameDbLike,
  StorageFrameDbHead,
  StoragePersistenceBoundaryHook,
  StorageRuntimeConfig,
} from './types';

type RuntimeFrameDbBatch = ReturnType<RuntimeFrameDbLike['batch']>;

export type StoredAccountFrameRecord = Extract<RuntimeFrameDbRecord, { kind: 'accountFrame' }> & {
  runtimeHeight: number;
  timestamp: number;
};

export type StoredAccountFrameValue = {
  source: Extract<RuntimeFrameDbRecord, { kind: 'accountFrame' }>['source'];
  frame: Extract<RuntimeFrameDbRecord, { kind: 'accountFrame' }>['frame'];
  runtimeHeight: number;
  timestamp: number;
};

export type StoredEntityFrameRecord = Extract<RuntimeFrameDbRecord, { kind: 'entityFrame' }> & {
  runtimeHeight: number;
  timestamp: number;
};

export type StoredEntityFrameValue = {
  link: Extract<RuntimeFrameDbRecord, { kind: 'entityFrame' }>['link'];
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

export type ReadFrameDbAccountFramesOptions = {
  limit?: number;
  maxAccountHeight?: number;
  maxRuntimeHeight?: number;
};

export type StoredRuntimeActivityRecord = StoredRuntimeActivityValue & {
  kind: 'runtimeActivity';
  height: number;
};

export const buildFrameDbPuts = (options: {
  height: number;
  timestamp: number;
  runtimeInput: RuntimeInput;
  logs: FrameLogEntry[];
  touchedEntities: string[];
  touchedAccounts: Array<{ entityId: string; counterpartyId: string }>;
  touchedBookEntities: string[];
  frameDbRecords?: RuntimeFrameDbRecord[];
}): FrameDbPut[] => {
  const puts: FrameDbPut[] = [];
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
  puts.push({ key: keyFrameDbRuntimeActivity(options.height), value: encodeBuffer(runtimeActivity) });

  for (const record of options.frameDbRecords ?? []) {
    if (record.kind === 'entityFrame') {
      const entityId = normalizeEntityId(record.entityId);
      const entityHeight = record.entityHeight;
      if (!entityId) throw new Error('FRAME_DB_ENTITY_FRAME_ENTITY_ID_INVALID');
      if (!Number.isSafeInteger(entityHeight) || entityHeight <= 0) {
        throw new Error(`FRAME_DB_ENTITY_FRAME_HEIGHT_INVALID:${String(entityHeight)}`);
      }
      const recordHeight = record.runtimeHeight ?? options.height;
      const recordTimestamp = record.timestamp ?? options.timestamp;
      const stored: StoredEntityFrameValue = {
        link: structuredClone(record.link),
        runtimeHeight: recordHeight,
        timestamp: recordTimestamp,
      };
      validateStoredEntityFrameValue(stored, entityHeight);
      puts.push({ key: keyFrameDbEntityFrame(entityId, entityHeight), value: encodeBuffer(stored) });
      puts.push({
        key: keyFrameDbEntityFrameByRuntime(recordHeight, entityId, entityHeight),
        value: Buffer.alloc(0),
      });
      continue;
    }
    const entityId = normalizeEntityId(record.entityId);
    const counterpartyId = normalizeEntityId(record.counterpartyId);
    const accountHeight = record.accountHeight;
    if (!entityId || !counterpartyId) throw new Error('FRAME_DB_ACCOUNT_FRAME_ENTITY_ID_INVALID');
    if (!Number.isSafeInteger(accountHeight) || accountHeight <= 0) {
      throw new Error(`FRAME_DB_ACCOUNT_FRAME_HEIGHT_INVALID:${String(accountHeight)}`);
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
      key: keyFrameDbAccountFrame(entityId, counterpartyId, Math.floor(accountHeight)),
      value: encodeBuffer(stored),
    });
    puts.push({
      key: keyFrameDbAccountFrameByRuntime(recordHeight, entityId, counterpartyId, Math.floor(accountHeight)),
      value: Buffer.alloc(0),
    });
  }

  return puts;
};

export const readFrameDbHead = async (
  db: RuntimeFrameDbLike,
  config: Required<StorageRuntimeConfig>,
): Promise<StorageFrameDbHead> => {
  const raw = await readRawOrNull(db, KEY_FRAME_DB_HEAD);
  const decoded = raw ? decodeValidatedBuffer(raw, validateFrameDbHeadValue) : null;
  return {
    schemaVersion: STORAGE_SCHEMA_VERSION,
    latestHeight: decoded?.latestHeight ?? 0,
    latestPrunedRuntimeHeight: decoded?.latestPrunedRuntimeHeight ?? 0,
    retainedBytes: decoded?.retainedBytes ?? 0,
    maxBytes: config.frameDbMaxBytes,
    retainFrames: config.frameDbRetainFrames,
  };
};

const writeFrameDbHead = async (
  db: RuntimeFrameDbLike,
  head: StorageFrameDbHead,
  onPersistenceBoundary?: StoragePersistenceBoundaryHook,
): Promise<void> => {
  const batch = db.batch();
  batch.put(KEY_FRAME_DB_HEAD, encodeBuffer(head));
  await writeBatch(batch);
  await onPersistenceBoundary?.('after-frame-db-prune');
};

export type FrameDbCommitPlan = {
  puts: FrameDbPut[];
  writtenBytes: number;
  nextHead: StorageFrameDbHead;
};

export const prepareFrameDbCommit = async (options: {
  db: RuntimeFrameDbLike;
  height: number;
  puts: FrameDbPut[];
  config: Required<StorageRuntimeConfig>;
}): Promise<FrameDbCommitPlan> => {
  const height = Math.max(1, Math.floor(Number(options.height)));
  const head = await readFrameDbHead(options.db, options.config);
  const writtenBytes = options.puts.reduce((sum, item) => sum + item.key.byteLength + item.value.byteLength, 0);
  const appendBytes = head.latestHeight >= height ? 0 : writtenBytes;
  const nextHead: StorageFrameDbHead = {
    schemaVersion: STORAGE_SCHEMA_VERSION,
    latestHeight: Math.max(head.latestHeight, height),
    latestPrunedRuntimeHeight: head.latestPrunedRuntimeHeight,
    retainedBytes: head.retainedBytes + appendBytes,
    maxBytes: options.config.frameDbMaxBytes,
    retainFrames: options.config.frameDbRetainFrames,
  };

  return {
    puts: options.puts,
    writtenBytes,
    nextHead,
  };
};

export const putFrameDbCommit = (batch: RuntimeFrameDbBatch, plan: FrameDbCommitPlan): void => {
  for (const item of plan.puts) batch.put(item.key, item.value);
  batch.put(KEY_FRAME_DB_HEAD, encodeBuffer(plan.nextHead));
};

const pruneFrameDbBeforeRuntimeHeight = async (
  db: RuntimeFrameDbLike,
  heightInclusive: number,
  onPersistenceBoundary?: StoragePersistenceBoundaryHook,
): Promise<{ removedBytes: number; removedKeys: number }> => {
  const cutoff = Math.max(0, Math.floor(Number(heightInclusive)));
  if (cutoff <= 0) return { removedBytes: 0, removedKeys: 0 };

  let removedBytes = 0;
  let removedKeys = 0;
  const onPruneBatch = async (): Promise<void> => {
    await onPersistenceBoundary?.('after-frame-db-prune');
  };
  const runtimeActivityPruned = await deleteKeyRange(
    db,
    {
      gte: Buffer.from([FRAME_DB_RUNTIME_ACTIVITY]),
      lt: Buffer.concat([Buffer.from([FRAME_DB_RUNTIME_ACTIVITY]), encodeHeight(cutoff + 1)]),
    },
    () => true,
    onPruneBatch,
  );
  removedBytes += runtimeActivityPruned.removedBytes;
  removedKeys += runtimeActivityPruned.removedKeys;

  const accountFrameKeysByHex = new Map<string, Buffer>();
  for await (const key of iterateKeys(db, {
    gte: keyFrameDbAccountFrameByRuntimePrefix(),
    lt: Buffer.concat([Buffer.from([FRAME_DB_ACCOUNT_FRAME_BY_RUNTIME]), encodeHeight(cutoff + 1)]),
  })) {
    accountFrameKeysByHex.set(key.toString('hex'), key);
    const parsed = parseFrameDbAccountFrameRuntimeIndexKey(key);
    const primaryKey = keyFrameDbAccountFrame(parsed.entityId, parsed.counterpartyId, parsed.accountHeight);
    accountFrameKeysByHex.set(primaryKey.toString('hex'), primaryKey);
    if (accountFrameKeysByHex.size >= 512) {
      const keysToDelete = Array.from(accountFrameKeysByHex.values());
      removedBytes += await deleteKeys(db, keysToDelete, onPruneBatch);
      removedKeys += keysToDelete.length;
      accountFrameKeysByHex.clear();
    }
  }
  const accountFrameKeysToDelete = Array.from(accountFrameKeysByHex.values());
  removedBytes += await deleteKeys(db, accountFrameKeysToDelete, onPruneBatch);
  removedKeys += accountFrameKeysToDelete.length;

  const entityFrameKeysByHex = new Map<string, Buffer>();
  for await (const key of iterateKeys(db, {
    gte: keyFrameDbEntityFrameByRuntimePrefix(),
    lt: Buffer.concat([Buffer.from([FRAME_DB_ENTITY_FRAME_BY_RUNTIME]), encodeHeight(cutoff + 1)]),
  })) {
    entityFrameKeysByHex.set(key.toString('hex'), key);
    const parsed = parseFrameDbEntityFrameRuntimeIndexKey(key);
    const primaryKey = keyFrameDbEntityFrame(parsed.entityId, parsed.entityHeight);
    entityFrameKeysByHex.set(primaryKey.toString('hex'), primaryKey);
    if (entityFrameKeysByHex.size >= 512) {
      const keysToDelete = Array.from(entityFrameKeysByHex.values());
      removedBytes += await deleteKeys(db, keysToDelete, onPruneBatch);
      removedKeys += keysToDelete.length;
      entityFrameKeysByHex.clear();
    }
  }
  const entityFrameKeysToDelete = Array.from(entityFrameKeysByHex.values());
  removedBytes += await deleteKeys(db, entityFrameKeysToDelete, onPruneBatch);
  removedKeys += entityFrameKeysToDelete.length;

  return { removedBytes, removedKeys };
};

export const writeFrameDbPutsWithRetention = async (options: {
  db: RuntimeFrameDbLike;
  height: number;
  puts: FrameDbPut[];
  config: Required<StorageRuntimeConfig>;
}): Promise<{
  writtenBytes: number;
  prunedBytes: number;
  retainedBytes: number;
  prunedKeys: number;
  latestPrunedRuntimeHeight: number;
}> => {
  if (options.puts.length === 0) {
    const head = await readFrameDbHead(options.db, options.config);
    return {
      writtenBytes: 0,
      prunedBytes: 0,
      retainedBytes: head.retainedBytes,
      prunedKeys: 0,
      latestPrunedRuntimeHeight: head.latestPrunedRuntimeHeight,
    };
  }

  const height = Math.max(1, Math.floor(Number(options.height)));
  const plan = await prepareFrameDbCommit(options);
  const batch = options.db.batch();
  putFrameDbCommit(batch, plan);
  await writeBatch(batch);

  const retention = await pruneFrameDbRetention({
    db: options.db,
    height,
    head: plan.nextHead,
    config: options.config,
  });
  return {
    writtenBytes: plan.writtenBytes,
    ...retention,
  };
};

export const pruneFrameDbRetention = async (options: {
  db: RuntimeFrameDbLike;
  height: number;
  head: StorageFrameDbHead;
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
  if (nextHead.retainedBytes <= options.config.frameDbMaxBytes || height <= options.config.frameDbRetainFrames) {
    return {
      prunedBytes: 0,
      retainedBytes: nextHead.retainedBytes,
      prunedKeys: 0,
      latestPrunedRuntimeHeight: nextHead.latestPrunedRuntimeHeight,
    };
  }

  const cutoff = height - options.config.frameDbRetainFrames;
  const pruned = await pruneFrameDbBeforeRuntimeHeight(
    options.db,
    cutoff,
    options.onPersistenceBoundary,
  );
  const finalHead: StorageFrameDbHead = {
    ...nextHead,
    latestPrunedRuntimeHeight: Math.max(nextHead.latestPrunedRuntimeHeight, cutoff),
    retainedBytes: Math.max(0, nextHead.retainedBytes - pruned.removedBytes),
  };
  await writeFrameDbHead(options.db, finalHead, options.onPersistenceBoundary);
  return {
    prunedBytes: pruned.removedBytes,
    retainedBytes: finalHead.retainedBytes,
    prunedKeys: pruned.removedKeys,
    latestPrunedRuntimeHeight: finalHead.latestPrunedRuntimeHeight,
  };
};

export const readFrameDbRuntimeActivity = async (
  db: RuntimeFrameDbLike,
  height: number,
): Promise<StoredRuntimeActivityRecord | null> => {
  const targetHeight = Number.isFinite(height) ? Math.max(1, Math.floor(height)) : 0;
  if (targetHeight <= 0) return null;
  const raw = await readRawOrNull(db, keyFrameDbRuntimeActivity(targetHeight));
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

export const readFrameDbAccountFrames = async (
  db: RuntimeFrameDbLike,
  entityId: string,
  counterpartyId: string,
  options: ReadFrameDbAccountFramesOptions = {},
): Promise<StoredAccountFrameRecord[]> => {
  const limit = options.limit ?? Number.POSITIVE_INFINITY;
  if (limit !== Number.POSITIVE_INFINITY && (!Number.isSafeInteger(limit) || limit <= 0)) {
    throw new Error(`FRAME_DB_ACCOUNT_FRAME_LIMIT_INVALID:${String(limit)}`);
  }
  const maxAccountHeight = options.maxAccountHeight ?? Number.MAX_SAFE_INTEGER;
  const maxRuntimeHeight = options.maxRuntimeHeight ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(maxAccountHeight) || maxAccountHeight < 0) {
    throw new Error(`FRAME_DB_ACCOUNT_FRAME_MAX_ACCOUNT_HEIGHT_INVALID:${String(maxAccountHeight)}`);
  }
  if (!Number.isSafeInteger(maxRuntimeHeight) || maxRuntimeHeight < 0) {
    throw new Error(`FRAME_DB_ACCOUNT_FRAME_MAX_RUNTIME_HEIGHT_INVALID:${String(maxRuntimeHeight)}`);
  }
  if (maxAccountHeight === 0 || maxRuntimeHeight === 0) return [];

  const prefix = keyFrameDbAccountFramePrefix(entityId, counterpartyId);
  const range = maxAccountHeight < Number.MAX_SAFE_INTEGER
    ? { gte: prefix, lt: keyFrameDbAccountFrame(entityId, counterpartyId, maxAccountHeight + 1), reverse: true }
    : { prefix, reverse: true };
  const records: StoredAccountFrameRecord[] = [];
  for await (const key of iterateKeys(db, range)) {
    const parsed = parseFrameDbAccountFrameKey(key);
    const accountHeight = parsed.accountHeight;
    if (accountHeight > maxAccountHeight) continue;
    const record = decodeValidatedBuffer(await db.get(key), decoded =>
      validateStoredAccountFrameValue(decoded, accountHeight));
    if (record.runtimeHeight > maxRuntimeHeight) continue;
    const frameHeight = record.frame.height;
    if (frameHeight !== accountHeight) {
      throw new Error(`FRAME_DB_ACCOUNT_FRAME_HEIGHT_MISMATCH: key=${accountHeight} frame=${frameHeight}`);
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

export const readFrameDbEntityFrames = async (
  db: RuntimeFrameDbLike,
  entityId: string,
  options: { limit?: number; maxEntityHeight?: number; maxRuntimeHeight?: number } = {},
): Promise<StoredEntityFrameRecord[]> => {
  const limit = options.limit ?? Number.POSITIVE_INFINITY;
  if (limit !== Number.POSITIVE_INFINITY && (!Number.isSafeInteger(limit) || limit <= 0)) {
    throw new Error(`FRAME_DB_ENTITY_FRAME_LIMIT_INVALID:${String(limit)}`);
  }
  const maxEntityHeight = options.maxEntityHeight ?? Number.MAX_SAFE_INTEGER;
  const maxRuntimeHeight = options.maxRuntimeHeight ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(maxEntityHeight) || maxEntityHeight < 0) {
    throw new Error(`FRAME_DB_ENTITY_FRAME_MAX_ENTITY_HEIGHT_INVALID:${String(maxEntityHeight)}`);
  }
  if (!Number.isSafeInteger(maxRuntimeHeight) || maxRuntimeHeight < 0) {
    throw new Error(`FRAME_DB_ENTITY_FRAME_MAX_RUNTIME_HEIGHT_INVALID:${String(maxRuntimeHeight)}`);
  }
  if (maxEntityHeight === 0 || maxRuntimeHeight === 0) return [];
  const prefix = keyFrameDbEntityFramePrefix(entityId);
  const range = maxEntityHeight < Number.MAX_SAFE_INTEGER
    ? { gte: prefix, lt: keyFrameDbEntityFrame(entityId, maxEntityHeight + 1), reverse: true }
    : { prefix, reverse: true };
  const records: StoredEntityFrameRecord[] = [];
  for await (const key of iterateKeys(db, range)) {
    const entityHeight = Number(key.readBigUInt64BE(33));
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
