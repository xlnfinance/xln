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
const DEFAULT_RECEIPT_TTL_MS = 365 * 24 * 60 * 60 * 1000;
export const STATS_CACHE_TTL_MS = 5_000;
export const META_STATS_KEY = 'meta:stats:v1';

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
    receiptTtlMs,
    now: options.now || (() => Date.now()),
    signer: new Wallet(towerPrivateKey),
    db: new Level<string, string>(dbPath, { valueEncoding: 'utf8' }),
    opened: false,
    cachedStats: null,
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
  await context.db.put(lookupKeyFor(doc.lookupKey), serializeTaggedJson(doc));
  invalidateWatchtowerStats(context);
};
