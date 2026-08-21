import type { FrameLogEntry } from '../../types/logging';
import type { RuntimeHistoryRecord } from '../../runtime/types';
import type { AccountTx } from '../../types/account';
import { decodeValidatedBuffer, encodeBuffer, writeBatch } from '../codec/codec';
import { iterateKeys, readRawOrNull } from '../database/level';
import {
  BOUNDED_STORAGE_DELETE_BATCH_SIZE,
  boundedStorageRowsBytes,
  deleteBoundedStorageValues,
  prepareBoundedStorageValueRows,
  readBoundedValidatedValue,
} from '../codec/bounded-value';
import {
  HISTORY_VIEW_RUNTIME_ACTIVITY,
  KEY_HISTORY_VIEW_HEAD,
  STORAGE_SCHEMA_VERSION,
  encodeHeight,
  decodeHeight,
  keyHistoryViewAccountFrame,
  keyHistoryViewAccountFramePrefix,
  keyHistoryViewAccountSwapEvent,
  keyHistoryViewAccountSwapEventPrefix,
  keyHistoryViewAccountSwapRecency,
  keyHistoryViewAccountSwapRecencyPrefix,
  keyHistoryViewEntityFrame,
  keyHistoryViewEntityFramePrefix,
  keyHistoryViewRuntimeActivity,
  normalizeEntityId,
  parseHistoryViewAccountFrameKey,
  parseHistoryViewAccountSwapRecencyKey,
  parseHistoryViewEntityFrameKey,
} from '../keys';
import {
  validateHistoryViewHeadValue,
  validateStoredAccountFrameValue,
  validateStoredAccountSwapEventValue,
  validateStoredEntityFrameValue,
  validateStoredRuntimeActivityValue,
} from './history-view-schema';
import type {
  HistoryViewPut,
  RuntimeDbLike,
  StorageHistoryViewHead,
  StoragePersistenceBoundaryHook,
  StorageRuntimeConfig,
  RuntimeFrame,
} from '../types';

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

/** A raw certified order-lifecycle transaction. Its two index keys are disposable. */
export type StoredAccountSwapEventValue = {
  runtimeHeight: number;
  timestamp: number;
  accountHeight: number;
  tx: Extract<AccountTx, {
    type: 'swap_offer' | 'swap_cancel_request' | 'swap_resolve' | 'cross_swap_fill_ack';
  }>;
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

export const buildCertifiedFramePuts = (options: {
  height: number;
  timestamp: number;
  historyRecords?: RuntimeHistoryRecord[];
}): HistoryViewPut[] => {
  const puts: HistoryViewPut[] = [];
  const recencyByKey = new Map<string, HistoryViewPut>();
  for (const record of options.historyRecords ?? []) {
    if (record.kind === 'entityFrame') {
      const entityId = normalizeEntityId(record.entityId);
      const entityHeight = record.entityHeight;
      if (!entityId) throw new Error('CERTIFIED_ENTITY_FRAME_ENTITY_ID_INVALID');
      if (!Number.isSafeInteger(entityHeight) || entityHeight <= 0) {
        throw new Error(`CERTIFIED_ENTITY_FRAME_HEIGHT_INVALID:${String(entityHeight)}`);
      }
      const stored: StoredEntityFrameValue = {
        link: record.link,
        runtimeHeight: record.runtimeHeight ?? options.height,
        timestamp: record.timestamp ?? options.timestamp,
      };
      validateStoredEntityFrameValue(stored, entityHeight);
      puts.push({ key: keyHistoryViewEntityFrame(entityId, entityHeight), value: encodeBuffer(stored) });
      continue;
    }
    const entityId = normalizeEntityId(record.entityId);
    const counterpartyId = normalizeEntityId(record.counterpartyId);
    const accountHeight = record.accountHeight;
    if (!entityId || !counterpartyId) throw new Error('CERTIFIED_ACCOUNT_FRAME_ENTITY_ID_INVALID');
    if (!Number.isSafeInteger(accountHeight) || accountHeight <= 0) {
      throw new Error(`CERTIFIED_ACCOUNT_FRAME_HEIGHT_INVALID:${String(accountHeight)}`);
    }
    const stored: StoredAccountFrameValue = {
      source: record.source,
      frame: record.frame,
      runtimeHeight: record.runtimeHeight ?? options.height,
      timestamp: record.timestamp ?? options.timestamp,
    };
    validateStoredAccountFrameValue(stored, accountHeight);
    puts.push({
      key: keyHistoryViewAccountFrame(entityId, counterpartyId, Math.floor(accountHeight)),
      value: encodeBuffer(stored),
    });
    for (const tx of record.frame.accountTxs) {
      if (
        tx.type !== 'swap_offer'
        && tx.type !== 'swap_cancel_request'
        && tx.type !== 'swap_resolve'
        && tx.type !== 'cross_swap_fill_ack'
      ) continue;
      const event: StoredAccountSwapEventValue = {
        runtimeHeight: stored.runtimeHeight,
        timestamp: stored.timestamp,
        accountHeight,
        tx,
      };
      const encoded = encodeBuffer(event);
      puts.push({
        key: keyHistoryViewAccountSwapEvent(
          entityId,
          counterpartyId,
          tx.data.offerId,
          accountHeight,
          tx.type,
        ),
        value: encoded,
      });
      const recencyKey = keyHistoryViewAccountSwapRecency(
        entityId,
        counterpartyId,
        accountHeight,
        tx.data.offerId,
      );
      recencyByKey.set(recencyKey.toString('hex'), { key: recencyKey, value: encoded });
    }
  }
  puts.push(...recencyByKey.values());
  return puts;
};

export const buildHistoryViewPuts = (options: {
  height: number;
  timestamp: number;
  logs: FrameLogEntry[];
  touchedEntities: string[];
  touchedAccounts: Array<{ entityId: string; counterpartyId: string }>;
  touchedBookEntities: string[];
}): HistoryViewPut[] => {
  const puts: HistoryViewPut[] = [];
  const runtimeActivity: StoredRuntimeActivityValue = {
    timestamp: options.timestamp,
    logs: options.logs,
    touchedEntities: options.touchedEntities,
    touchedAccounts: options.touchedAccounts,
    touchedBookEntities: options.touchedBookEntities,
  };
  validateStoredRuntimeActivityValue(runtimeActivity, options.height);
  puts.push({ key: keyHistoryViewRuntimeActivity(options.height), value: encodeBuffer(runtimeActivity) });

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
  const puts = options.puts.flatMap(item => prepareBoundedStorageValueRows(item.key, item.value));
  const writtenBytes = boundedStorageRowsBytes(puts);
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
    puts,
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
  /** Lowest retained WAL height; older activity rows have no authoritative input. */
  firstWalHeight: number | (() => Promise<number>);
  latestWalHeight: number;
  /** Puts already built for `latestWalHeight` by the frame that just committed. */
  latestWalPuts?: HistoryViewPut[];
  readWalFrame: (height: number) => Promise<RuntimeFrame | null>;
  readWalActivity: (height: number) => Promise<StoredRuntimeActivityValue | null>;
  config: Required<StorageRuntimeConfig>;
}): Promise<{ materializedThroughRuntimeHeight: number; writtenBytes: number }> => {
  const latestWalHeight = Math.max(0, Math.floor(Number(options.latestWalHeight)));
  let head = await readHistoryViewHead(options.viewDb, options.config);
  if (head.latestHeight > latestWalHeight) {
    throw new Error(
      `HISTORY_VIEW_AHEAD_OF_WAL:view=${head.latestHeight}:wal=${latestWalHeight}`,
    );
  }
  // Steady state: the view trails the WAL by exactly the frame being committed
  // and that frame's puts are still in memory. Re-reading and re-decoding the
  // frame we just encoded would only rebuild the same rows.
  if (options.latestWalPuts && head.latestHeight === latestWalHeight - 1) {
    const plan = await prepareHistoryViewCommit({
      db: options.viewDb,
      height: latestWalHeight,
      puts: options.latestWalPuts,
      config: options.config,
    });
    const batch = options.viewDb.batch();
    putHistoryViewCommit(batch, plan);
    await writeBatch(batch, { sync: false });
    return { materializedThroughRuntimeHeight: latestWalHeight, writtenBytes: plan.writtenBytes };
  }
  const firstWalHeight = Math.max(1, Math.floor(Number(
    typeof options.firstWalHeight === 'function' ? await options.firstWalHeight() : options.firstWalHeight,
  )));
  if (latestWalHeight > 0 && firstWalHeight > latestWalHeight) {
    throw new Error(
      `HISTORY_VIEW_WAL_RANGE_INVALID:first=${firstWalHeight}:latest=${latestWalHeight}`,
    );
  }
  const floorPrune = await pruneHistoryViewRetention({
    db: options.viewDb,
    height: latestWalHeight,
    head,
    config: options.config,
    firstWalHeight,
  });
  if (floorPrune.latestPrunedRuntimeHeight > head.latestPrunedRuntimeHeight) {
    head = {
      ...head,
      latestPrunedRuntimeHeight: floorPrune.latestPrunedRuntimeHeight,
      retainedBytes: floorPrune.retainedBytes,
    };
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
    await writeBatch(floorBatch, { sync: false });
  }
  let writtenBytes = 0;
  for (let height = head.latestHeight + 1; height <= latestWalHeight; height += 1) {
    const frame = await options.readWalFrame(height);
    if (!frame) throw new Error(`HISTORY_VIEW_WAL_FRAME_MISSING:height=${height}`);
    const activity = await options.readWalActivity(height);
    if (!activity) throw new Error(`HISTORY_VIEW_WAL_ACTIVITY_MISSING:height=${height}`);
    const puts = buildHistoryViewPuts({
      height: frame.height,
      timestamp: activity.timestamp,
      logs: activity.logs,
      touchedEntities: activity.touchedEntities,
      touchedAccounts: activity.touchedAccounts,
      touchedBookEntities: activity.touchedBookEntities,
    });
    const plan = await prepareHistoryViewCommit({
      db: options.viewDb,
      height,
      puts,
      config: options.config,
    });
    const batch = options.viewDb.batch();
    putHistoryViewCommit(batch, plan);
    await writeBatch(batch, { sync: false });
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
  let ownerKeys: Buffer[] = [];
  const flush = async (): Promise<void> => {
    if (ownerKeys.length === 0) return;
    const pruned = await deleteBoundedStorageValues(db, ownerKeys, onPruneBatch);
    removedBytes += pruned.removedBytes;
    removedKeys += pruned.removedKeys;
    ownerKeys = [];
  };
  for await (const key of iterateKeys(db, {
    gte: Buffer.from([HISTORY_VIEW_RUNTIME_ACTIVITY]),
    lt: Buffer.concat([Buffer.from([HISTORY_VIEW_RUNTIME_ACTIVITY]), encodeHeight(cutoff + 1)]),
  })) {
    ownerKeys.push(key);
    if (ownerKeys.length >= BOUNDED_STORAGE_DELETE_BATCH_SIZE) await flush();
  }
  await flush();

  return { removedBytes, removedKeys };
};

export const pruneHistoryViewRetention = async (options: {
  db: RuntimeDbLike;
  height: number;
  head: StorageHistoryViewHead;
  config: Required<StorageRuntimeConfig>;
  firstWalHeight?: number;
  onPersistenceBoundary?: StoragePersistenceBoundaryHook;
}): Promise<{
  prunedBytes: number;
  retainedBytes: number;
  prunedKeys: number;
  latestPrunedRuntimeHeight: number;
}> => {
  const height = Math.max(1, Math.floor(Number(options.height)));
  const nextHead = options.head;
  const retainFrames = options.config.historyViewRetainFrames;
  const countCutoff = retainFrames === Number.MAX_SAFE_INTEGER
    ? 0
    : Math.max(0, height - retainFrames);
  const walCutoff = options.firstWalHeight === undefined
    ? 0
    : Math.max(0, Math.floor(Number(options.firstWalHeight)) - 1);
  const countLimitExceeded = Math.max(countCutoff, walCutoff) > nextHead.latestPrunedRuntimeHeight;
  const byteLimitExceeded = nextHead.retainedBytes > options.config.historyViewMaxBytes;
  if (!countLimitExceeded && !byteLimitExceeded) {
    return {
      prunedBytes: 0,
      retainedBytes: nextHead.retainedBytes,
      prunedKeys: 0,
      latestPrunedRuntimeHeight: nextHead.latestPrunedRuntimeHeight,
    };
  }

  // Count and byte limits are independent upper bounds. A count of one means
  // "latest finalized Runtime frame only"; two means latest plus one previous.
  // When the byte budget is tighter, keep the latest frame and discard the
  // rebuildable prefix in one bounded range operation. The authoritative WAL
  // is untouched, so this local view can always be recreated.
  const byteCutoff = byteLimitExceeded ? height - 1 : 0;
  const cutoff = Math.max(countCutoff, byteCutoff, walCutoff);
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
  const value = await readBoundedValidatedValue(
    db,
    keyHistoryViewRuntimeActivity(targetHeight),
    decoded => validateStoredRuntimeActivityValue(decoded, targetHeight),
  );
  if (!value) return null;
  return {
    kind: 'runtimeActivity',
    height: targetHeight,
    timestamp: value.timestamp,
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
    const record = await readBoundedValidatedValue(
      db,
      key,
      decoded => validateStoredAccountFrameValue(decoded, accountHeight),
    );
    if (!record) throw new Error(`HISTORY_VIEW_ACCOUNT_FRAME_MISSING:${key.toString('hex')}`);
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

export const readHistoryViewAccountSwapEvents = async (
  db: RuntimeDbLike,
  entityId: string,
  counterpartyId: string,
  offerId: string,
  maxRuntimeHeight = Number.MAX_SAFE_INTEGER,
): Promise<StoredAccountSwapEventValue[]> => {
  const prefix = keyHistoryViewAccountSwapEventPrefix(entityId, counterpartyId, offerId);
  const events: StoredAccountSwapEventValue[] = [];
  for await (const key of iterateKeys(db, { prefix })) {
    const accountHeight = decodeHeight(key, key.byteLength - 8);
    const event = await readBoundedValidatedValue(
      db,
      key,
      decoded => validateStoredAccountSwapEventValue(decoded, accountHeight),
    );
    if (!event) throw new Error(`HISTORY_VIEW_ACCOUNT_SWAP_EVENT_MISSING:${key.toString('hex')}`);
    if (event.runtimeHeight <= maxRuntimeHeight) events.push(event);
  }
  return events.sort((left, right) => left.accountHeight - right.accountHeight);
};

export const readHistoryViewAccountSwapRecency = async (
  db: RuntimeDbLike,
  entityId: string,
  counterpartyId: string,
  options: Readonly<{ maxRuntimeHeight?: number }> = {},
): Promise<Array<StoredAccountSwapEventValue & { offerId: string }>> => {
  const maxRuntimeHeight = options.maxRuntimeHeight ?? Number.MAX_SAFE_INTEGER;
  const prefix = keyHistoryViewAccountSwapRecencyPrefix(entityId, counterpartyId);
  const events: Array<StoredAccountSwapEventValue & { offerId: string }> = [];
  for await (const key of iterateKeys(db, { prefix, reverse: true })) {
    const { accountHeight, offerId } = parseHistoryViewAccountSwapRecencyKey(key);
    const event = await readBoundedValidatedValue(
      db,
      key,
      decoded => validateStoredAccountSwapEventValue(decoded, accountHeight),
    );
    if (!event) throw new Error(`HISTORY_VIEW_ACCOUNT_SWAP_RECENCY_MISSING:${key.toString('hex')}`);
    if (event.runtimeHeight <= maxRuntimeHeight) events.push({ ...event, offerId });
  }
  return events;
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
    const value = await readBoundedValidatedValue(
      db,
      key,
      decoded => validateStoredEntityFrameValue(decoded, entityHeight),
    );
    if (!value) throw new Error(`HISTORY_VIEW_ENTITY_FRAME_MISSING:${key.toString('hex')}`);
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
import { Buffer } from '../../support/platform-crypto';
