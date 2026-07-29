import { randomUUID } from 'node:crypto';
import { serializeTaggedJson } from '../protocol/serialization';
import {
  ensureWatchtowerStoreOpen,
  invalidateWatchtowerStats,
  META_STATS_KEY,
  normalizeLookupKey,
  readMetaStats,
  STATS_CACHE_TTL_MS,
} from './store-db';
import { decodeStoredActionReceipt, decodeStoredLookupDoc } from './store-decode';
import type {
  StoredTowerActionReceipt,
  StoredTowerMetaStats,
  WatchtowerStoreContext,
  WatchtowerStoreStats,
} from './store-types';

const complaintKey = (context: WatchtowerStoreContext): string => `complaint:${context.now()}:${randomUUID()}`;

const actionReceiptPrefix = (lookupKey: string): string => `action:${normalizeLookupKey(lookupKey)}:`;

const actionReceiptKey = (context: WatchtowerStoreContext, lookupKey: string): string =>
  `${actionReceiptPrefix(lookupKey)}${context.now()}:${randomUUID()}`;

export const appendComplaint = async (
  context: WatchtowerStoreContext,
  payload: Record<string, unknown>,
): Promise<void> => {
  await ensureWatchtowerStoreOpen(context);
  await context.db.put(complaintKey(context), serializeTaggedJson({ ts: context.now(), ...payload }));
  invalidateWatchtowerStats(context);
};

export const appendActionReceipt = async (
  context: WatchtowerStoreContext,
  receipt: StoredTowerActionReceipt,
): Promise<void> => {
  await ensureWatchtowerStoreOpen(context);
  const metaStats = await readMetaStats(context);
  await context.db.batch([
    {
      type: 'put',
      key: actionReceiptKey(context, receipt.lookupKey),
      value: serializeTaggedJson(receipt),
    },
    {
      type: 'put',
      key: META_STATS_KEY,
      value: serializeTaggedJson({
        actionReceiptCount: metaStats.actionReceiptCount + 1,
      } satisfies StoredTowerMetaStats),
    },
  ]);
  invalidateWatchtowerStats(context);
};

export const listActionReceipts = async (
  context: WatchtowerStoreContext,
  lookupKey: string,
): Promise<StoredTowerActionReceipt[]> => {
  await ensureWatchtowerStoreOpen(context);
  const prefix = actionReceiptPrefix(lookupKey);
  const receipts: StoredTowerActionReceipt[] = [];
  for await (const [, raw] of context.db.iterator({
    gte: prefix,
    lte: `${prefix}\xff`,
    reverse: true,
  })) {
    receipts.push(decodeStoredActionReceipt(String(raw)));
  }
  return receipts;
};

export const getStats = async (context: WatchtowerStoreContext): Promise<WatchtowerStoreStats> => {
  await ensureWatchtowerStoreOpen(context);
  const currentTime = context.now();
  if (context.cachedStats && currentTime - context.cachedStats.cachedAt < STATS_CACHE_TTL_MS) {
    return context.cachedStats.value;
  }
  let lookupCount = 0;
  let lastResortAppointmentCount = 0;
  for await (const [, raw] of context.db.iterator({ gte: 'lookup:', lte: 'lookup:\xff' })) {
    lookupCount += 1;
    const doc = decodeStoredLookupDoc(String(raw));
    if (doc.bundles.some(entry => entry.towerMode === 'delayed_last_resort' && !!entry.lastResortPayload)) {
      lastResortAppointmentCount += 1;
    }
  }
  const metaStats = await readMetaStats(context);
  const value = {
    lookupCount,
    lastResortAppointmentCount,
    actionReceiptCount: metaStats.actionReceiptCount,
  };
  context.cachedStats = { cachedAt: currentTime, value };
  return value;
};

const collectExpiredKeys = async (context: WatchtowerStoreContext, cutoff: number): Promise<string[]> => {
  const keys: string[] = [];
  for await (const [key] of context.db.iterator()) {
    const parts = String(key).split(':');
    const timestamp = key.startsWith('action:')
      ? Number(parts[2] || 0)
      : key.startsWith('complaint:')
        ? Number(parts[1] || 0)
        : 0;
    if (Number.isFinite(timestamp) && timestamp > 0 && timestamp < cutoff) {
      keys.push(key);
    }
  }
  return keys;
};

export const pruneExpired = async (context: WatchtowerStoreContext): Promise<{ deleted: number }> => {
  await ensureWatchtowerStoreOpen(context);
  const keysToDelete = await collectExpiredKeys(context, context.now() - context.receiptTtlMs);
  if (keysToDelete.length === 0) return { deleted: 0 };
  const metaStats = await readMetaStats(context);
  const deletedActionReceipts = keysToDelete.filter(key => key.startsWith('action:')).length;
  await context.db.batch([
    ...keysToDelete.map(key => ({ type: 'del' as const, key })),
    {
      type: 'put' as const,
      key: META_STATS_KEY,
      value: serializeTaggedJson({
        actionReceiptCount: Math.max(0, metaStats.actionReceiptCount - deletedActionReceipts),
      } satisfies StoredTowerMetaStats),
    },
  ]);
  invalidateWatchtowerStats(context);
  return { deleted: keysToDelete.length };
};
