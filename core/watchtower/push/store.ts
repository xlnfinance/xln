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
import { createStructuredLogger } from '../../support/logger';
import { createSerialLock, type SerialLock } from '../sweep-health';
import { decodeStoredPushRegistration } from './registration';
import type { StoredPushRegistration } from './types';

const DEFAULT_REGISTRATION_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const DEFAULT_WAKE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_REGISTRATIONS = 10_000;
const DEFAULT_MAX_REGISTRATIONS_PER_RUNTIME = 64;
const pushStoreLog = createStructuredLogger('watchtower.push_store');

export type PushStoreStats = {
  registrationCount: number;
  invalidRegistrationCount: number;
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
  maxRegistrations?: number;
  maxRegistrationsPerRuntime?: number;
  now?: () => number;
};

type RegistrationCounts = { total: number; byRuntime: Map<string, number> };

type PushStoreContext = {
  dbPath: string;
  db: Level<string, string>;
  registrationTtlMs: number;
  wakeTtlMs: number;
  maxRegistrations: number;
  maxRegistrationsPerRuntime: number;
  now: () => number;
  opened: boolean;
  openPromise: Promise<void> | null;
  /** Registry writes are read-check-write; one at a time keeps the counts exact. */
  writeLock: SerialLock;
  /** Built by one scan on the first new registration; dropped after deletes. */
  registrationCounts: RegistrationCounts | null;
};

/** Registrations are unauthenticated input: each one costs every later registry scan. */
export class PushRegistrationQuotaError extends Error {
  readonly code = 'PUSH_REGISTRATION_QUOTA_EXCEEDED';

  constructor(detail: string) {
    super(`PUSH_REGISTRATION_QUOTA_EXCEEDED:${detail}`);
    this.name = 'PushRegistrationQuotaError';
  }
}

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

/**
 * Registry-wide scans serve every registration, so one undecodable row is
 * reported and skipped there instead of failing the scan for everyone.
 */
const decodeScannedRegistration = (
  key: string,
  raw: string,
  scan: 'targets' | 'unregister' | 'prune' | null,
): StoredPushRegistration | null => {
  try {
    return decodeStoredPushRegistration(raw, key);
  } catch (error) {
    if (scan) {
      pushStoreLog.error('registration.undecodable', {
        scan,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return null;
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

const readRegistrationCounts = async (context: PushStoreContext): Promise<RegistrationCounts> => {
  if (context.registrationCounts) return context.registrationCounts;
  const counts: RegistrationCounts = { total: 0, byRuntime: new Map() };
  for await (const [key, raw] of context.db.iterator({ gte: 'reg:', lte: 'reg:\xff' })) {
    counts.total += 1;
    const registration = decodeScannedRegistration(key, String(raw), null);
    if (registration) counts.byRuntime.set(registration.runtimeId, (counts.byRuntime.get(registration.runtimeId) ?? 0) + 1);
  }
  context.registrationCounts = counts;
  return counts;
};

/** A refresh of the runtime's own row is free; a new row must fit both caps. */
const admitRegistration = async (
  context: PushStoreContext,
  runtimeId: string,
  replacedRuntimeId: string | null,
): Promise<void> => {
  if (replacedRuntimeId === runtimeId) return;
  const counts = await readRegistrationCounts(context);
  if (replacedRuntimeId === null && counts.total >= context.maxRegistrations) {
    throw new PushRegistrationQuotaError(`registrations=${counts.total}:max=${context.maxRegistrations}`);
  }
  const runtimeCount = counts.byRuntime.get(runtimeId) ?? 0;
  if (runtimeCount >= context.maxRegistrationsPerRuntime) {
    throw new PushRegistrationQuotaError(
      `runtime=${runtimeId}:registrations=${runtimeCount}:max=${context.maxRegistrationsPerRuntime}`,
    );
  }
  if (replacedRuntimeId === null) counts.total += 1;
  else counts.byRuntime.set(replacedRuntimeId, Math.max(0, (counts.byRuntime.get(replacedRuntimeId) ?? 0) - 1));
  counts.byRuntime.set(runtimeId, runtimeCount + 1);
};

const registerToken = async (
  context: PushStoreContext,
  registration: StoredPushRegistration,
): Promise<StoredPushRegistration> => {
  await ensureOpen(context);
  const key = registrationKey(registration);
  const existingRaw = await getStoredValue(context, key);
  const existing = existingRaw ? decodeStoredPushRegistration(existingRaw, key) : null;
  if (existing) {
    if (existing.signedAt > registration.signedAt) {
      throw new Error('PUSH_REGISTRATION_STALE');
    }
    if (existing.signedAt === registration.signedAt) {
      const sameSignedRegistration =
        existing.runtimeId === registration.runtimeId
        && existing.entityId === registration.entityId
        && existing.tokenHash === registration.tokenHash
        && existing.token === registration.token
        && existing.platform === registration.platform
        && existing.chainId === registration.chainId
        && existing.depositoryAddress === registration.depositoryAddress
        && existing.rpcUrl === registration.rpcUrl;
      if (!sameSignedRegistration) throw new Error('PUSH_REGISTRATION_REPLAY_MISMATCH');
    }
  }
  const stored: StoredPushRegistration = { ...registration, updatedAt: context.now() };
  await admitRegistration(context, registration.runtimeId, existing?.runtimeId ?? null);
  try {
    await context.db.put(key, serializeTaggedJson(stored));
  } catch (error) {
    context.registrationCounts = null;
    throw error;
  }
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
    const registration = decodeScannedRegistration(key, String(raw), 'unregister');
    if (
      registration
      && registration.runtimeId.toLowerCase() === normalizedRuntimeId
      && registration.tokenHash.toLowerCase() === normalizedTokenHash
    ) {
      keys.push(key);
    }
  }
  if (keys.length > 0) {
    await context.db.batch(keys.map(key => ({ type: 'del' as const, key })));
    context.registrationCounts = null;
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
    const registration = decodeScannedRegistration(storageKey, String(raw), 'targets');
    if (!registration || Number(registration.updatedAt || 0) < cutoff) continue;
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
  let invalidRegistrationCount = 0;
  const targets = new Set<string>();
  for await (const [key, raw] of context.db.iterator({ gte: 'reg:', lte: 'reg:\xff' })) {
    registrationCount += 1;
    const registration = decodeScannedRegistration(key, String(raw), null);
    if (!registration) invalidRegistrationCount += 1;
    else targets.add(normTarget(registration.chainId, registration.depositoryAddress));
  }
  return { registrationCount, invalidRegistrationCount, watchTargetCount: targets.size };
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
      const registration = decodeScannedRegistration(key, String(raw), 'prune');
      if (registration && Number(registration.updatedAt || 0) < registrationCutoff) keys.push(key);
    } else if (key.startsWith('wake:')) {
      const timestamp = Number(raw);
      if (Number.isFinite(timestamp) && timestamp < wakeCutoff) keys.push(key);
    }
  }
  if (keys.length > 0) {
    await context.db.batch(keys.map(key => ({ type: 'del' as const, key })));
    context.registrationCounts = null;
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
    maxRegistrations: Math.max(1, Math.floor(Number(options.maxRegistrations ?? DEFAULT_MAX_REGISTRATIONS))),
    maxRegistrationsPerRuntime: Math.max(
      1,
      Math.floor(Number(options.maxRegistrationsPerRuntime ?? DEFAULT_MAX_REGISTRATIONS_PER_RUNTIME)),
    ),
    now: options.now || Date.now,
    opened: false,
    openPromise: null,
    writeLock: createSerialLock(),
    registrationCounts: null,
  };
  return {
    dbPath,
    registerToken: (registration: StoredPushRegistration) =>
      context.writeLock(() => registerToken(context, registration)),
    removeToken: (runtimeId: string, tokenHash: string) =>
      context.writeLock(() => removeToken(context, runtimeId, tokenHash)),
    listRegistrationsForTarget: (chainId: number, depository: string) =>
      listRegistrationsForTarget(context, chainId, depository),
    listWatchTargets: () => listWatchTargets(context),
    getCursor: (chainId: number, depository: string) => getCursor(context, chainId, depository),
    setCursor: (chainId: number, depository: string, blockNumber: number) =>
      setCursor(context, chainId, depository, blockNumber),
    wasRecentlyWoken: (key: string) => wasRecentlyWoken(context, key),
    markWoken: (key: string, timestamp: number) => markWoken(context, key, timestamp),
    getStats: () => getStats(context),
    pruneExpired: () => context.writeLock(() => pruneExpired(context)),
    close: () => closeStore(context),
  };
};
