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
import { serializeTaggedJson } from '../serialization-utils';
import type { StoredPushRegistration } from './types';

const DEFAULT_REGISTRATION_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days
const DEFAULT_WAKE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days (> dispute window)

export type PushStoreStats = {
  registrationCount: number;
  watchTargetCount: number;
};

export type PushWatchTarget = {
  chainId: number;
  depositoryAddress: string;
  rpcUrl: string;
};

export type PushStore = ReturnType<typeof createPushStore>;

const normTarget = (chainId: number, depository: string): string =>
  `${Math.floor(chainId)}:${String(depository).toLowerCase()}`;

export const createPushStore = (options?: {
  dbPath?: string;
  registrationTtlMs?: number;
  wakeTtlMs?: number;
  now?: () => number;
}) => {
  const dbPath = options?.dbPath || join(process.cwd(), 'data', 'push');
  const registrationTtlMs = Math.max(60_000, Math.floor(Number(options?.registrationTtlMs ?? DEFAULT_REGISTRATION_TTL_MS)));
  const wakeTtlMs = Math.max(60_000, Math.floor(Number(options?.wakeTtlMs ?? DEFAULT_WAKE_TTL_MS)));
  const now = options?.now || (() => Date.now());
  const db = new Level<string, string>(dbPath, { valueEncoding: 'utf8' });
  let opened = false;

  const ensureOpen = async (): Promise<void> => {
    if (opened) return;
    await mkdir(dirname(dbPath), { recursive: true });
    await db.open();
    opened = true;
  };

  const regKey = (reg: { chainId: number; depositoryAddress: string; entityId: string; tokenHash: string }): string =>
    `reg:${normTarget(reg.chainId, reg.depositoryAddress)}:${reg.entityId.toLowerCase()}:${reg.tokenHash.toLowerCase()}`;
  const cursorKey = (chainId: number, depository: string): string => `cursor:${normTarget(chainId, depository)}`;
  const wakeStoreKey = (key: string): string => `wake:${key}`;

  const get = async (key: string): Promise<string | null> => {
    try {
      return await db.get(key);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/LEVEL_NOT_FOUND|NotFound/i.test(message)) return null;
      throw error;
    }
  };

  const registerToken = async (registration: StoredPushRegistration): Promise<StoredPushRegistration> => {
    await ensureOpen();
    const key = regKey(registration);
    const existingRaw = await get(key);
    if (existingRaw) {
      const existing = JSON.parse(existingRaw) as StoredPushRegistration;
      if (Number(existing.signedAt || 0) > Number(registration.signedAt || 0)) {
        throw new Error('PUSH_REGISTRATION_STALE');
      }
    }
    const stored: StoredPushRegistration = { ...registration, updatedAt: now() };
    await db.put(key, serializeTaggedJson(stored));
    return stored;
  };

  const removeToken = async (runtimeId: string, tokenHash: string): Promise<number> => {
    await ensureOpen();
    const normalizedRuntimeId = String(runtimeId || '').toLowerCase();
    const normalized = String(tokenHash).toLowerCase();
    const keys: string[] = [];
    for await (const [key, raw] of db.iterator({ gte: 'reg:', lte: 'reg:\xff' })) {
      const reg = JSON.parse(String(raw)) as StoredPushRegistration;
      if (
        String(reg.runtimeId || '').toLowerCase() === normalizedRuntimeId &&
        String(reg.tokenHash || '').toLowerCase() === normalized
      ) {
        keys.push(key);
      }
    }
    if (keys.length > 0) await db.batch(keys.map((key) => ({ type: 'del' as const, key })));
    return keys.length;
  };

  const listRegistrationsForTarget = async (chainId: number, depository: string): Promise<StoredPushRegistration[]> => {
    await ensureOpen();
    const prefix = `reg:${normTarget(chainId, depository)}:`;
    const cutoff = now() - registrationTtlMs;
    const out: StoredPushRegistration[] = [];
    for await (const [, raw] of db.iterator({ gte: prefix, lte: `${prefix}\xff` })) {
      const reg = JSON.parse(String(raw)) as StoredPushRegistration;
      if (Number(reg.updatedAt || 0) >= cutoff) out.push(reg);
    }
    return out;
  };

  const listWatchTargets = async (): Promise<PushWatchTarget[]> => {
    await ensureOpen();
    const cutoff = now() - registrationTtlMs;
    const targets = new Map<string, PushWatchTarget & { updatedAt: number }>();
    for await (const [, raw] of db.iterator({ gte: 'reg:', lte: 'reg:\xff' })) {
      const reg = JSON.parse(String(raw)) as StoredPushRegistration;
      if (Number(reg.updatedAt || 0) < cutoff) continue;
      const key = normTarget(reg.chainId, reg.depositoryAddress);
      const existing = targets.get(key);
      if (!existing || Number(reg.updatedAt || 0) > existing.updatedAt) {
        targets.set(key, {
          chainId: reg.chainId,
          depositoryAddress: reg.depositoryAddress.toLowerCase(),
          rpcUrl: reg.rpcUrl,
          updatedAt: Number(reg.updatedAt || 0),
        });
      }
    }
    return [...targets.values()].map(({ chainId, depositoryAddress, rpcUrl }) => ({ chainId, depositoryAddress, rpcUrl }));
  };

  const getCursor = async (chainId: number, depository: string): Promise<number | null> => {
    await ensureOpen();
    const raw = await get(cursorKey(chainId, depository));
    if (raw === null) return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : null;
  };

  const setCursor = async (chainId: number, depository: string, blockNumber: number): Promise<void> => {
    await ensureOpen();
    await db.put(cursorKey(chainId, depository), String(Math.max(0, Math.floor(blockNumber))));
  };

  const wasRecentlyWoken = async (key: string): Promise<boolean> => {
    await ensureOpen();
    const raw = await get(wakeStoreKey(key));
    if (raw === null) return false;
    const at = Number(raw);
    if (!Number.isFinite(at)) return false;
    return now() - at < wakeTtlMs;
  };

  const markWoken = async (key: string, at: number): Promise<void> => {
    await ensureOpen();
    await db.put(wakeStoreKey(key), String(Math.max(0, Math.floor(at))));
  };

  const getStats = async (): Promise<PushStoreStats> => {
    await ensureOpen();
    let registrationCount = 0;
    const targets = new Set<string>();
    for await (const [, raw] of db.iterator({ gte: 'reg:', lte: 'reg:\xff' })) {
      registrationCount += 1;
      const reg = JSON.parse(String(raw)) as StoredPushRegistration;
      targets.add(normTarget(reg.chainId, reg.depositoryAddress));
    }
    return { registrationCount, watchTargetCount: targets.size };
  };

  const pruneExpired = async (): Promise<{ deleted: number }> => {
    await ensureOpen();
    const regCutoff = now() - registrationTtlMs;
    const wakeCutoff = now() - wakeTtlMs;
    const keysToDelete: string[] = [];
    for await (const [key, raw] of db.iterator()) {
      if (key.startsWith('reg:')) {
        const reg = JSON.parse(String(raw)) as StoredPushRegistration;
        if (Number(reg.updatedAt || 0) < regCutoff) keysToDelete.push(key);
      } else if (key.startsWith('wake:')) {
        const at = Number(raw);
        if (Number.isFinite(at) && at < wakeCutoff) keysToDelete.push(key);
      }
    }
    if (keysToDelete.length > 0) await db.batch(keysToDelete.map((key) => ({ type: 'del' as const, key })));
    return { deleted: keysToDelete.length };
  };

  const close = async (): Promise<void> => {
    if (!opened) return;
    opened = false;
    await db.close();
  };

  return {
    dbPath,
    registerToken,
    removeToken,
    listRegistrationsForTarget,
    listWatchTargets,
    getCursor,
    setCursor,
    wasRecentlyWoken,
    markWoken,
    getStats,
    pruneExpired,
    close,
  };
};
