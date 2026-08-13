import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Level } from 'level';
import { Wallet, ethers } from 'ethers';
import { serializeTaggedJson } from '../../protocol/serialization';
import type {
  StoredLookupDoc,
  StoredTowerMetaStats,
  WatchtowerStoreContext,
  WatchtowerStoreOptions,
} from './types';
import {
  decodeStoredLookupDoc,
  decodeStoredMetaStats,
  decodeWatchtowerStoredValue,
} from './decode';

const DEFAULT_MAX_BUNDLES = 3;
const DEFAULT_MAX_STORED_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_LOOKUP_KEYS = 10_000;
const DEFAULT_MAX_TOTAL_STORED_BYTES = 1024 * 1024 * 1024;
const DEFAULT_RECEIPT_TTL_MS = 365 * 24 * 60 * 60 * 1000;
export const STATS_CACHE_TTL_MS = 5_000;
export const META_STATS_KEY = 'meta:stats:v1';

export class WatchtowerGlobalQuotaError extends Error {
  readonly code = 'TOWER_GLOBAL_QUOTA_EXCEEDED';

  constructor(detail: string) {
    super(`TOWER_GLOBAL_QUOTA_EXCEEDED:${detail}`);
    this.name = 'WatchtowerGlobalQuotaError';
  }
}

export const normalizeLookupKey = (lookupKey: string): string => {
  const normalized = String(lookupKey || '')
    .trim()
    .toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(normalized)) {
    throw new Error(`TOWER_LOOKUP_KEY_INVALID: ${lookupKey}`);
  }
  return normalized;
};

export const emptyStoredDoc = (lookupKey: string): StoredLookupDoc => ({
  lookupKey,
  runtimeId: '',
  updatedAt: 0,
  receipts: [],
  bundles: [],
});

export const computeStoredLookupBytes = (doc: StoredLookupDoc): number =>
  Buffer.byteLength(serializeTaggedJson(doc), 'utf8');

export const createWatchtowerStoreContext = (options: WatchtowerStoreOptions = {}): WatchtowerStoreContext => {
  const towerId = String(options.towerId || 'xln-watchtower').trim() || 'xln-watchtower';
  const dbPath = options.dbPath || join(process.cwd(), 'data', 'watchtower');
  const maxBundlesPerLookupKey = Math.max(
    2,
    Math.min(8, Math.floor(Number(options.maxBundlesPerLookupKey ?? DEFAULT_MAX_BUNDLES))),
  );
  const maxStoredBytesPerLookupKey = Math.max(
    1024,
    Math.floor(Number(options.maxStoredBytesPerLookupKey ?? DEFAULT_MAX_STORED_BYTES)),
  );
  const maxLookupKeys = Math.max(1, Math.floor(Number(options.maxLookupKeys ?? DEFAULT_MAX_LOOKUP_KEYS)));
  const maxTotalStoredBytes = Math.max(
    maxStoredBytesPerLookupKey,
    Math.floor(Number(options.maxTotalStoredBytes ?? DEFAULT_MAX_TOTAL_STORED_BYTES)),
  );
  const receiptTtlMs = Math.max(60_000, Math.floor(Number(options.receiptTtlMs ?? DEFAULT_RECEIPT_TTL_MS)));
  const towerPrivateKey = String(
    options.towerPrivateKey ||
      process.env['XLN_WATCHTOWER_PRIVATE_KEY'] ||
      ethers.keccak256(ethers.toUtf8Bytes(`xln:watchtower:${towerId}`)),
  );
  return {
    towerId,
    dbPath,
    maxBundlesPerLookupKey,
    maxStoredBytesPerLookupKey,
    maxLookupKeys,
    maxTotalStoredBytes,
    receiptTtlMs,
    now: options.now || (() => Date.now()),
    signer: new Wallet(towerPrivateKey),
    db: new Level<string, string>(dbPath, { valueEncoding: 'utf8' }),
    opened: false,
    cachedStats: null,
    lookupUsage: null,
    appointmentWriteQueue: Promise.resolve(),
  };
};

export const ensureWatchtowerStoreOpen = async (context: WatchtowerStoreContext): Promise<void> => {
  if (context.opened) return;
  await mkdir(dirname(context.dbPath), { recursive: true });
  await context.db.open();
  context.opened = true;
};

export const closeWatchtowerStore = async (context: WatchtowerStoreContext): Promise<void> => {
  if (!context.opened) return;
  context.opened = false;
  await context.db.close();
};

export const invalidateWatchtowerStats = (context: WatchtowerStoreContext): void => {
  context.cachedStats = null;
};

export const lookupKeyFor = (lookupKey: string): string => `lookup:${normalizeLookupKey(lookupKey)}`;

export const runSerializedAppointmentWrite = async <T>(
  context: WatchtowerStoreContext,
  operation: () => Promise<T>,
): Promise<T> => {
  const predecessor = context.appointmentWriteQueue;
  let release = (): void => undefined;
  context.appointmentWriteQueue = new Promise<void>(resolve => { release = resolve; });
  await predecessor;
  try {
    return await operation();
  } finally {
    release();
  }
};

const readLookupUsage = async (
  context: WatchtowerStoreContext,
): Promise<NonNullable<WatchtowerStoreContext['lookupUsage']>> => {
  if (context.lookupUsage) return context.lookupUsage;
  await ensureWatchtowerStoreOpen(context);
  const bytesByKey = new Map<string, number>();
  let totalStoredBytes = 0;
  for await (const [key, raw] of context.db.iterator({ gte: 'lookup:', lte: 'lookup:\xff' })) {
    const bytes = Buffer.byteLength(String(raw), 'utf8');
    bytesByKey.set(String(key), bytes);
    totalStoredBytes += bytes;
  }
  context.lookupUsage = { bytesByKey, totalStoredBytes };
  return context.lookupUsage;
};

const emptyMetaStats = (): StoredTowerMetaStats => ({ actionReceiptCount: 0 });

const isMissingLevelKey = (error: unknown): boolean =>
  /LEVEL_NOT_FOUND|NotFound/i.test(error instanceof Error ? error.message : String(error));

export const readMetaStats = async (context: WatchtowerStoreContext): Promise<StoredTowerMetaStats> => {
  await ensureWatchtowerStoreOpen(context);
  try {
    const raw = await context.db.get(META_STATS_KEY);
    return decodeWatchtowerStoredValue('meta-stats', META_STATS_KEY, raw, decodeStoredMetaStats);
  } catch (error) {
    if (isMissingLevelKey(error)) return emptyMetaStats();
    throw error;
  }
};

export const readLookup = async (
  context: WatchtowerStoreContext,
  lookupKey: string,
): Promise<StoredLookupDoc | null> => {
  await ensureWatchtowerStoreOpen(context);
  try {
    const storageKey = lookupKeyFor(lookupKey);
    const raw = await context.db.get(storageKey);
    return decodeWatchtowerStoredValue(
      'lookup',
      storageKey,
      raw,
      value => decodeStoredLookupDoc(value, normalizeLookupKey(lookupKey)),
    );
  } catch (error) {
    if (isMissingLevelKey(error)) return null;
    throw error;
  }
};

export const writeLookup = async (context: WatchtowerStoreContext, doc: StoredLookupDoc): Promise<void> => {
  await ensureWatchtowerStoreOpen(context);
  const storageKey = lookupKeyFor(doc.lookupKey);
  const serialized = serializeTaggedJson(doc);
  const storedBytes = Buffer.byteLength(serialized, 'utf8');
  const usage = await readLookupUsage(context);
  const previousBytes = usage.bytesByKey.get(storageKey) ?? 0;
  const nextLookupCount = usage.bytesByKey.size + (previousBytes === 0 ? 1 : 0);
  const nextTotalStoredBytes = usage.totalStoredBytes - previousBytes + storedBytes;
  if (nextLookupCount > context.maxLookupKeys) {
    throw new WatchtowerGlobalQuotaError(`lookupKeys=${nextLookupCount}:max=${context.maxLookupKeys}`);
  }
  if (nextTotalStoredBytes > context.maxTotalStoredBytes && storedBytes > previousBytes) {
    throw new WatchtowerGlobalQuotaError(
      `storedBytes=${nextTotalStoredBytes}:max=${context.maxTotalStoredBytes}`,
    );
  }
  await context.db.put(storageKey, serialized);
  usage.bytesByKey.set(storageKey, storedBytes);
  usage.totalStoredBytes = nextTotalStoredBytes;
  invalidateWatchtowerStats(context);
};
