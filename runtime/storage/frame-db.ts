import type { FrameLogEntry, RuntimeFrameDbRecord } from '../types';
import { decodeBuffer, encodeBuffer, writeBatch } from './codec';
import { deleteKeyRange, deleteKeys, iterateKeys, readJsonOrNull, readRawOrNull } from './level';
import {
  FRAME_DB_ACCOUNT_FRAME_BY_RUNTIME,
  FRAME_DB_ENTITY_ACTIVITY,
  FRAME_DB_RUNTIME_ACTIVITY,
  FRAME_DB_ORDERBOOK_COMMIT,
  KEY_FRAME_DB_HEAD,
  STORAGE_SCHEMA_VERSION,
  decodeHeight,
  encodeHeight,
  keyFrameDbAccountFrame,
  keyFrameDbAccountFrameByRuntime,
  keyFrameDbAccountFrameByRuntimePrefix,
  keyFrameDbAccountFramePrefix,
  keyFrameDbEntityActivity,
  keyFrameDbOrderbookCommit,
  keyFrameDbOrderbookCommitPrefix,
  keyFrameDbRuntimeActivity,
  normalizeEntityId,
  parseFrameDbAccountFrameRuntimeIndexKey,
} from './keys';
import type { FrameDbPut, RuntimeFrameDbLike, StorageFrameDbHead, StorageRuntimeConfig } from './types';

export type StoredAccountFrameRecord = Extract<RuntimeFrameDbRecord, { kind: 'accountFrame' }> & {
  runtimeHeight: number;
  timestamp: number;
};

export type StoredOrderbookCommitRecord = Extract<RuntimeFrameDbRecord, { kind: 'bookUpdate' }> & {
  runtimeHeight: number;
  timestamp: number;
};

export type StoredRuntimeActivityRecord = {
  kind: 'runtimeActivity';
  height: number;
  timestamp: number;
  logs: FrameLogEntry[];
  touchedEntities: string[];
  touchedAccounts: Array<{ entityId: string; counterpartyId: string }>;
  touchedBookEntities: string[];
  touchedBooks?: Array<{ entityId: string; pairId: string }>;
};

type StoredEntityActivityRecord = {
  kind: 'entityActivity';
  height: number;
  timestamp: number;
  entityId: string;
  touchedAccounts: Array<{ entityId: string; counterpartyId: string }>;
  accountFrameCount: number;
  logCount: number;
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
  const runtimeActivity: StoredRuntimeActivityRecord = {
    kind: 'runtimeActivity',
    height: options.height,
    timestamp: options.timestamp,
    logs: options.logs,
    touchedEntities: options.touchedEntities,
    touchedAccounts: options.touchedAccounts,
    touchedBookEntities: options.touchedBookEntities,
  };
  puts.push({ key: keyFrameDbRuntimeActivity(options.height), value: encodeBuffer(runtimeActivity) });

  const logCountsByEntity = new Map<string, number>();
  for (const log of options.logs) {
    const entityId = normalizeEntityId(String(log.entityId || log.data?.['entityId'] || ''));
    if (!entityId) continue;
    logCountsByEntity.set(entityId, (logCountsByEntity.get(entityId) ?? 0) + 1);
  }

  const frameCountsByEntity = new Map<string, number>();
  const orderbookCountsByEntity = new Map<string, number>();
  const touchedBooksByKey = new Map<string, { entityId: string; pairId: string }>();
  for (const record of options.frameDbRecords ?? []) {
    if (record.kind === 'accountFrame') {
      const entityId = normalizeEntityId(record.entityId);
      const counterpartyId = normalizeEntityId(record.counterpartyId);
      const accountHeight = Number(record.accountHeight || record.frame?.height || 0);
      if (!entityId || !counterpartyId || !Number.isFinite(accountHeight) || accountHeight <= 0) continue;
      const recordHeight = Math.max(1, Math.floor(Number(record.runtimeHeight ?? options.height)));
      const recordTimestamp = Math.max(0, Math.floor(Number(record.timestamp ?? options.timestamp)));
      const stored: StoredAccountFrameRecord = {
        ...record,
        entityId,
        counterpartyId,
        accountHeight: Math.floor(accountHeight),
        runtimeHeight: recordHeight,
        timestamp: recordTimestamp,
      };
      puts.push({
        key: keyFrameDbAccountFrame(entityId, counterpartyId, stored.accountHeight),
        value: encodeBuffer(stored),
      });
      puts.push({
        key: keyFrameDbAccountFrameByRuntime(recordHeight, entityId, counterpartyId, stored.accountHeight),
        value: Buffer.alloc(0),
      });
      frameCountsByEntity.set(entityId, (frameCountsByEntity.get(entityId) ?? 0) + 1);
      continue;
    }

    if (record.kind === 'bookUpdate') {
      const entityId = normalizeEntityId(record.entityId);
      const pairId = String(record.pairId || '').trim();
      if (!entityId || !pairId) continue;
      const recordHeight = Math.max(1, Math.floor(Number(record.runtimeHeight ?? options.height)));
      const recordTimestamp = Math.max(0, Math.floor(Number(record.timestamp ?? options.timestamp)));
      const stored: StoredOrderbookCommitRecord = {
        kind: 'bookUpdate',
        entityId,
        pairId,
        book: record.book ? structuredClone(record.book) : null,
        runtimeHeight: recordHeight,
        timestamp: recordTimestamp,
      };
      puts.push({
        key: keyFrameDbOrderbookCommit(recordHeight, entityId, pairId),
        value: encodeBuffer(stored),
      });
      orderbookCountsByEntity.set(entityId, (orderbookCountsByEntity.get(entityId) ?? 0) + 1);
      touchedBooksByKey.set(`${entityId}:${pairId}`, { entityId, pairId });
    }
  }

  if (touchedBooksByKey.size > 0) {
    runtimeActivity.touchedBooks = Array.from(touchedBooksByKey.values())
      .sort((left, right) => left.entityId.localeCompare(right.entityId) || left.pairId.localeCompare(right.pairId));
  }

  for (const entityId of options.touchedEntities) {
    const normalized = normalizeEntityId(entityId);
    if (!normalized) continue;
    const entityActivity: StoredEntityActivityRecord = {
      kind: 'entityActivity',
      height: options.height,
      timestamp: options.timestamp,
      entityId: normalized,
      touchedAccounts: options.touchedAccounts.filter((account) => normalizeEntityId(account.entityId) === normalized),
      accountFrameCount: frameCountsByEntity.get(normalized) ?? 0,
      logCount: (logCountsByEntity.get(normalized) ?? 0) + (orderbookCountsByEntity.get(normalized) ?? 0),
    };
    puts.push({ key: keyFrameDbEntityActivity(normalized, options.height), value: encodeBuffer(entityActivity) });
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

  const entityActivityPruned = await deleteKeyRange(
    db,
    { prefix: Buffer.from([FRAME_DB_ENTITY_ACTIVITY]) },
    (key) => decodeHeight(key, 33) <= cutoff,
  );
  removedBytes += entityActivityPruned.removedBytes;
  removedKeys += entityActivityPruned.removedKeys;

  const orderbookCommitPruned = await deleteKeyRange(db, {
    gte: keyFrameDbOrderbookCommitPrefix(),
    lt: Buffer.concat([Buffer.from([FRAME_DB_ORDERBOOK_COMMIT]), encodeHeight(cutoff + 1)]),
  });
  removedBytes += orderbookCommitPruned.removedBytes;
  removedKeys += orderbookCommitPruned.removedKeys;

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

  // Legacy frame DBs written before the runtime-height index have no secondary
  // key to range-prune. Stream the primary keyspace so upgraded DBs eventually
  // age out those rows without materializing all account-frame keys in memory.
  for await (const key of iterateKeys(db, { prefix: keyFrameDbAccountFramePrefix() })) {
    const raw = await readRawOrNull(db, key);
    if (!raw) continue;
    const record = decodeBuffer<StoredAccountFrameRecord>(raw);
    if (Math.max(0, Math.floor(Number(record.runtimeHeight ?? 0))) <= cutoff) {
      accountFrameKeysByHex.set(key.toString('hex'), key);
    }
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
  return readJsonOrNull<StoredRuntimeActivityRecord>(db, keyFrameDbRuntimeActivity(targetHeight));
};

export const readFrameDbAccountFrames = async (
  db: RuntimeFrameDbLike,
  entityId: string,
  counterpartyId: string,
): Promise<StoredAccountFrameRecord[]> => {
  const prefix = keyFrameDbAccountFramePrefix(entityId, counterpartyId);
  const records: StoredAccountFrameRecord[] = [];
  for await (const key of iterateKeys(db, { prefix })) {
    const accountHeight = decodeHeight(key, 65);
    const record = decodeBuffer<StoredAccountFrameRecord>(await db.get(key));
    records.push({ ...record, accountHeight });
  }
  return records.sort((left, right) => left.accountHeight - right.accountHeight);
};
