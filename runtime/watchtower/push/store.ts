/**
 * LevelDB-backed push registry + dispute-watch cursor + wake dedup store.
 *
 * Server-only. Holds opaque device tokens keyed by (chain, depository, entity,
 * tokenHash), the per-target last-scanned block cursor, and short-lived wake
 * dedup markers. No keys, no spend authority.
 */

import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Level } from 'level';
import { serializeTaggedJson } from '../../protocol/serialization';
import { decodeStoredPushRegistration } from './registration';
import type { StoredPushRegistration } from './types';

const DEFAULT_REGISTRATION_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const DEFAULT_WAKE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type PushStoreStats = {
  registrationCount: number;
  watchTargetCount: number;
};

export type PushWatchTarget = {
  chainId: number;
  depositoryAddress: string;
  rpcUrl: string;
};

type PushStoreOptions = {
  dbPath?: string;
  registrationTtlMs?: number;
  wakeTtlMs?: number;
  now?: () => number;
};

type PushStoreContext = {
  dbPath: string;
  db: Level<string, string>;
  registrationTtlMs: number;
  wakeTtlMs: number;
  now: () => number;
  opened: boolean;
  openPromise: Promise<void> | null;
};

export type PushStore = ReturnType<typeof createPushStore>;

const normTarget = (chainId: number, depository: string): string =>
  `${Math.floor(chainId)}:${String(depository).toLowerCase()}`;

const registrationKey = (registration: {
  chainId: number;
  depositoryAddress: string;
  entityId: string;
  tokenHash: string;
}): string =>
  `reg:${normTarget(registration.chainId, registration.depositoryAddress)}:${registration.entityId.toLowerCase()}:${registration.tokenHash.toLowerCase()}`;

const cursorKey = (chainId: number, depository: string): string =>
  `cursor:${normTarget(chainId, depository)}`;

const wakeKey = (key: string): string => `wake:${key}`;

const openStore = async (context: PushStoreContext): Promise<void> => {
  await mkdir(dirname(context.dbPath), { recursive: true });
  await context.db.open();
  context.opened = true;
};

const ensureOpen = async (context: PushStoreContext): Promise<void> => {
  if (context.opened) return;
  const pending = context.openPromise ?? (context.openPromise = openStore(context));
  try {
    await pending;
  } catch (error) {
    if (context.openPromise === pending) context.openPromise = null;
    throw error;
  }
};

const getStoredValue = async (
  context: PushStoreContext,
  key: string,
): Promise<string | null> => {
  try {
    return await context.db.get(key);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/LEVEL_NOT_FOUND|NotFound/i.test(message)) return null;
    throw error;
  }
};

const registerToken = async (
  context: PushStoreContext,
  registration: StoredPushRegistration,
): Promise<StoredPushRegistration> => {
  await ensureOpen(context);
  const key = registrationKey(registration);
  const existingRaw = await getStoredValue(context, key);
  if (existingRaw) {
    const existing = decodeStoredPushRegistration(existingRaw, key);
    if (Number(existing.signedAt || 0) > Number(registration.signedAt || 0)) {
      throw new Error('PUSH_REGISTRATION_STALE');
    }
  }
  const stored: StoredPushRegistration = { ...registration, updatedAt: context.now() };
  await context.db.put(key, serializeTaggedJson(stored));
  return stored;
};

const removeToken = async (
  context: PushStoreContext,
  runtimeId: string,
  tokenHash: string,
): Promise<number> => {
  await ensureOpen(context);
  const normalizedRuntimeId = String(runtimeId || '').toLowerCase();
  const normalizedTokenHash = String(tokenHash).toLowerCase();
  const keys: string[] = [];
  for await (const [key, raw] of context.db.iterator({ gte: 'reg:', lte: 'reg:\xff' })) {
    const registration = decodeStoredPushRegistration(String(raw), key);
    if (
      registration.runtimeId.toLowerCase() === normalizedRuntimeId
      && registration.tokenHash.toLowerCase() === normalizedTokenHash
    ) {
      keys.push(key);
    }
  }
  if (keys.length > 0) {
    await context.db.batch(keys.map(key => ({ type: 'del' as const, key })));
  }
  return keys.length;
};

const listRegistrationsForTarget = async (
  context: PushStoreContext,
  chainId: number,
  depository: string,
): Promise<StoredPushRegistration[]> => {
  await ensureOpen(context);
  const prefix = `reg:${normTarget(chainId, depository)}:`;
  const cutoff = context.now() - context.registrationTtlMs;
  const registrations: StoredPushRegistration[] = [];
  for await (const [key, raw] of context.db.iterator({ gte: prefix, lte: `${prefix}\xff` })) {
    const registration = decodeStoredPushRegistration(String(raw), key);
    if (Number(registration.updatedAt || 0) >= cutoff) registrations.push(registration);
  }
  return registrations;
};

const listWatchTargets = async (
  context: PushStoreContext,
): Promise<PushWatchTarget[]> => {
  await ensureOpen(context);
  const cutoff = context.now() - context.registrationTtlMs;
  const targets = new Map<string, PushWatchTarget & { updatedAt: number }>();
  for await (const [storageKey, raw] of context.db.iterator({ gte: 'reg:', lte: 'reg:\xff' })) {
    const registration = decodeStoredPushRegistration(String(raw), storageKey);
    if (Number(registration.updatedAt || 0) < cutoff) continue;
    const key = normTarget(registration.chainId, registration.depositoryAddress);
    const existing = targets.get(key);
    if (!existing || Number(registration.updatedAt || 0) > existing.updatedAt) {
      targets.set(key, {
        chainId: registration.chainId,
        depositoryAddress: registration.depositoryAddress.toLowerCase(),
        rpcUrl: registration.rpcUrl,
        updatedAt: Number(registration.updatedAt || 0),
      });
    }
  }
  return [...targets.values()].map(
    ({ chainId, depositoryAddress, rpcUrl }) => ({ chainId, depositoryAddress, rpcUrl }),
  );
};

const getCursor = async (
  context: PushStoreContext,
  chainId: number,
  depository: string,
): Promise<number | null> => {
  await ensureOpen(context);
  const raw = await getStoredValue(context, cursorKey(chainId, depository));
  if (raw === null) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : null;
};

const setCursor = async (
  context: PushStoreContext,
  chainId: number,
  depository: string,
  blockNumber: number,
): Promise<void> => {
  await ensureOpen(context);
  await context.db.put(cursorKey(chainId, depository), String(Math.max(0, Math.floor(blockNumber))));
};

const wasRecentlyWoken = async (
  context: PushStoreContext,
  key: string,
): Promise<boolean> => {
  await ensureOpen(context);
  const raw = await getStoredValue(context, wakeKey(key));
  if (raw === null) return false;
  const timestamp = Number(raw);
  return Number.isFinite(timestamp) && context.now() - timestamp < context.wakeTtlMs;
};

const markWoken = async (
  context: PushStoreContext,
  key: string,
  timestamp: number,
): Promise<void> => {
  await ensureOpen(context);
  await context.db.put(wakeKey(key), String(Math.max(0, Math.floor(timestamp))));
};

const getStats = async (context: PushStoreContext): Promise<PushStoreStats> => {
  await ensureOpen(context);
  let registrationCount = 0;
  const targets = new Set<string>();
  for await (const [key, raw] of context.db.iterator({ gte: 'reg:', lte: 'reg:\xff' })) {
    registrationCount += 1;
    const registration = decodeStoredPushRegistration(String(raw), key);
    targets.add(normTarget(registration.chainId, registration.depositoryAddress));
  }
  return { registrationCount, watchTargetCount: targets.size };
};

const pruneExpired = async (
  context: PushStoreContext,
): Promise<{ deleted: number }> => {
  await ensureOpen(context);
  const registrationCutoff = context.now() - context.registrationTtlMs;
  const wakeCutoff = context.now() - context.wakeTtlMs;
  const keys: string[] = [];
  for await (const [key, raw] of context.db.iterator()) {
    if (key.startsWith('reg:')) {
      const registration = decodeStoredPushRegistration(String(raw), key);
      if (Number(registration.updatedAt || 0) < registrationCutoff) keys.push(key);
    } else if (key.startsWith('wake:')) {
      const timestamp = Number(raw);
      if (Number.isFinite(timestamp) && timestamp < wakeCutoff) keys.push(key);
    }
  }
  if (keys.length > 0) {
    await context.db.batch(keys.map(key => ({ type: 'del' as const, key })));
  }
  return { deleted: keys.length };
};

const closeStore = async (context: PushStoreContext): Promise<void> => {
  if (context.openPromise) await context.openPromise;
  if (!context.opened) return;
  context.opened = false;
  context.openPromise = null;
  await context.db.close();
};

export const createPushStore = (options: PushStoreOptions = {}) => {
  const dbPath = options.dbPath || join(process.cwd(), 'data', 'push');
  const context: PushStoreContext = {
    dbPath,
    db: new Level<string, string>(dbPath, { valueEncoding: 'utf8' }),
    registrationTtlMs: Math.max(
      60_000,
      Math.floor(Number(options.registrationTtlMs ?? DEFAULT_REGISTRATION_TTL_MS)),
    ),
    wakeTtlMs: Math.max(60_000, Math.floor(Number(options.wakeTtlMs ?? DEFAULT_WAKE_TTL_MS))),
    now: options.now || Date.now,
    opened: false,
    openPromise: null,
  };
  return {
    dbPath,
    registerToken: (registration: StoredPushRegistration) => registerToken(context, registration),
    removeToken: (runtimeId: string, tokenHash: string) => removeToken(context, runtimeId, tokenHash),
    listRegistrationsForTarget: (chainId: number, depository: string) =>
      listRegistrationsForTarget(context, chainId, depository),
    listWatchTargets: () => listWatchTargets(context),
    getCursor: (chainId: number, depository: string) => getCursor(context, chainId, depository),
    setCursor: (chainId: number, depository: string, blockNumber: number) =>
      setCursor(context, chainId, depository, blockNumber),
    wasRecentlyWoken: (key: string) => wasRecentlyWoken(context, key),
    markWoken: (key: string, timestamp: number) => markWoken(context, key, timestamp),
    getStats: () => getStats(context),
    pruneExpired: () => pruneExpired(context),
    close: () => closeStore(context),
  };
};
