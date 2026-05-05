import type { FrameLogEntry, RuntimeFrameDbRecord } from '../types';
import { decodeBuffer, encodeBuffer, writeBatch } from './codec';
import { deleteKeyRange, deleteKeys, iterateKeys, readJsonOrNull } from './level';
import {
  FRAME_DB_ACCOUNT_FRAME_BY_RUNTIME,
  FRAME_DB_RUNTIME_ACTIVITY,
  KEY_FRAME_DB_HEAD,
  STORAGE_SCHEMA_VERSION,
  encodeHeight,
  keyFrameDbAccountFrame,
  keyFrameDbAccountFrameByRuntime,
  keyFrameDbAccountFrameByRuntimePrefix,
  keyFrameDbAccountFramePrefix,
  keyFrameDbRuntimeActivity,
  normalizeEntityId,
  parseFrameDbAccountFrameKey,
  parseFrameDbAccountFrameRuntimeIndexKey,
} from './keys';
import type { FrameDbPut, RuntimeFrameDbLike, StorageFrameDbHead, StorageRuntimeConfig } from './types';

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

export type StoredRuntimeActivityValue = {
  timestamp: number;
  logs: FrameLogEntry[];
  touchedEntities: string[];
  touchedAccounts: Array<{ entityId: string; counterpartyId: string }>;
  touchedBookEntities: string[];
};

export type StoredRuntimeActivityRecord = StoredRuntimeActivityValue & {
  kind: 'runtimeActivity';
  height: number;
};

export const buildFrameDbPuts = (options: {
  height: number;
  timestamp: number;
  logs: FrameLogEntry[];
  touchedEntities: string[];
  touchedAccounts: Array<{ entityId: string; counterpartyId: string }>;
  touchedBookEntities: string[];
  frameDbRecords?: RuntimeFrameDbRecord[];
}): FrameDbPut[] => {
  const puts: FrameDbPut[] = [];
  const runtimeActivity: StoredRuntimeActivityValue = {
    timestamp: options.timestamp,
    logs: options.logs,
    touchedEntities: options.touchedEntities,
    touchedAccounts: options.touchedAccounts,
    touchedBookEntities: options.touchedBookEntities,
  };
  puts.push({ key: keyFrameDbRuntimeActivity(options.height), value: encodeBuffer(runtimeActivity) });

  for (const record of options.frameDbRecords ?? []) {
    const entityId = normalizeEntityId(record.entityId);
    const counterpartyId = normalizeEntityId(record.counterpartyId);
    const accountHeight = Number(record.accountHeight || record.frame?.height || 0);
    if (!entityId || !counterpartyId || !Number.isFinite(accountHeight) || accountHeight <= 0) continue;
    const recordHeight = Math.max(1, Math.floor(Number(record.runtimeHeight ?? options.height)));
    const recordTimestamp = Math.max(0, Math.floor(Number(record.timestamp ?? options.timestamp)));
    const stored: StoredAccountFrameValue = {
      source: record.source,
      frame: structuredClone(record.frame),
      runtimeHeight: recordHeight,
      timestamp: recordTimestamp,
    };
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

const readFrameDbHead = async (
  db: RuntimeFrameDbLike,
  config: Required<StorageRuntimeConfig>,
): Promise<StorageFrameDbHead> => {
  const raw = await readJsonOrNull<StorageFrameDbHead>(db, KEY_FRAME_DB_HEAD);
  return {
    schemaVersion: STORAGE_SCHEMA_VERSION,
    latestHeight: Math.max(0, Math.floor(Number(raw?.latestHeight ?? 0))),
    latestPrunedRuntimeHeight: Math.max(0, Math.floor(Number(raw?.latestPrunedRuntimeHeight ?? 0))),
    retainedBytes: Math.max(0, Math.floor(Number(raw?.retainedBytes ?? 0))),
    maxBytes: config.frameDbMaxBytes,
    retainFrames: config.frameDbRetainFrames,
  };
};

const writeFrameDbHead = async (db: RuntimeFrameDbLike, head: StorageFrameDbHead): Promise<void> => {
  const batch = db.batch();
  batch.put(KEY_FRAME_DB_HEAD, encodeBuffer(head));
  await writeBatch(batch);
};

const pruneFrameDbBeforeRuntimeHeight = async (
  db: RuntimeFrameDbLike,
  heightInclusive: number,
): Promise<{ removedBytes: number; removedKeys: number }> => {
  const cutoff = Math.max(0, Math.floor(Number(heightInclusive)));
  if (cutoff <= 0) return { removedBytes: 0, removedKeys: 0 };

  let removedBytes = 0;
  let removedKeys = 0;
  const runtimeActivityPruned = await deleteKeyRange(db, {
    gte: Buffer.from([FRAME_DB_RUNTIME_ACTIVITY]),
    lt: Buffer.concat([Buffer.from([FRAME_DB_RUNTIME_ACTIVITY]), encodeHeight(cutoff + 1)]),
  });
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
      removedBytes += await deleteKeys(db, keysToDelete);
      removedKeys += keysToDelete.length;
      accountFrameKeysByHex.clear();
    }
  }
  const accountFrameKeysToDelete = Array.from(accountFrameKeysByHex.values());
  removedBytes += await deleteKeys(db, accountFrameKeysToDelete);
  removedKeys += accountFrameKeysToDelete.length;

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

  const batch = options.db.batch();
  for (const item of options.puts) batch.put(item.key, item.value);
  batch.put(KEY_FRAME_DB_HEAD, encodeBuffer(nextHead));
  await writeBatch(batch);

  if (nextHead.retainedBytes <= options.config.frameDbMaxBytes || height <= options.config.frameDbRetainFrames) {
    return {
      writtenBytes,
      prunedBytes: 0,
      retainedBytes: nextHead.retainedBytes,
      prunedKeys: 0,
      latestPrunedRuntimeHeight: nextHead.latestPrunedRuntimeHeight,
    };
  }

  const cutoff = height - options.config.frameDbRetainFrames;
  const pruned = await pruneFrameDbBeforeRuntimeHeight(options.db, cutoff);
  const finalHead: StorageFrameDbHead = {
    ...nextHead,
    latestPrunedRuntimeHeight: Math.max(nextHead.latestPrunedRuntimeHeight, cutoff),
    retainedBytes: Math.max(0, nextHead.retainedBytes - pruned.removedBytes),
  };
  await writeFrameDbHead(options.db, finalHead);
  return {
    writtenBytes,
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
  const value = await readJsonOrNull<StoredRuntimeActivityValue>(db, keyFrameDbRuntimeActivity(targetHeight));
  if (!value) return null;
  return {
    kind: 'runtimeActivity',
    height: targetHeight,
    timestamp: Math.max(0, Math.floor(Number(value.timestamp ?? 0))),
    logs: Array.isArray(value.logs) ? value.logs : [],
    touchedEntities: Array.isArray(value.touchedEntities) ? value.touchedEntities : [],
    touchedAccounts: Array.isArray(value.touchedAccounts) ? value.touchedAccounts : [],
    touchedBookEntities: Array.isArray(value.touchedBookEntities) ? value.touchedBookEntities : [],
  };
};

export const readFrameDbAccountFrames = async (
  db: RuntimeFrameDbLike,
  entityId: string,
  counterpartyId: string,
): Promise<StoredAccountFrameRecord[]> => {
  const prefix = keyFrameDbAccountFramePrefix(entityId, counterpartyId);
  const records: StoredAccountFrameRecord[] = [];
  for await (const key of iterateKeys(db, { prefix })) {
    const parsed = parseFrameDbAccountFrameKey(key);
    const record = decodeBuffer<StoredAccountFrameValue>(await db.get(key));
    const accountHeight = Math.max(1, Math.floor(Number(parsed.accountHeight)));
    const frameHeight = Math.max(0, Math.floor(Number(record.frame?.height ?? 0)));
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
      runtimeHeight: Math.max(0, Math.floor(Number(record.runtimeHeight ?? 0))),
      timestamp: Math.max(0, Math.floor(Number(record.timestamp ?? 0))),
    });
  }
  return records.sort((left, right) => left.accountHeight - right.accountHeight);
};
