import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Level } from 'level';
import { Wallet, ethers } from 'ethers';
import { serializeTaggedJson } from '../serialization-utils';
import type {
  EncryptedRuntimeRecoveryBundleV1,
  TowerLastResortPayloadV1,
  TowerAppointmentV1,
  TowerModeV1,
  TowerReceiptV1,
} from '../recovery/types';
import { normalizeTowerModeV1 } from '../recovery/types';
import { computeTowerLastResortPayloadDigest, getTowerPayloadEncryptionPublicKey } from '../recovery/crypto';

type StoredLookupDoc = {
  lookupKey: string;
  runtimeId: string;
  updatedAt: number;
  receipts: TowerReceiptV1[];
  bundles: Array<{
    slot: number;
    towerMode: TowerModeV1;
    bundle: EncryptedRuntimeRecoveryBundleV1;
    lastResortPayloadDigest: string;
    lastResortPayload?: TowerLastResortPayloadV1;
  }>;
};

type StoredTowerMetaStats = {
  actionReceiptCount: number;
};

export type StoredTowerActionReceipt = {
  id: string;
  lookupKey: string;
  runtimeId: string;
  towerMode: TowerModeV1;
  actionKind: 'counter_dispute_only';
  triggerHint: string;
  appointmentSequence: number;
  txHash?: string;
  status: 'submitted' | 'skipped' | 'error';
  blockNumber?: number;
  error?: string;
  createdAt: number;
};

export type LastResortTowerAppointment = {
  lookupKey: string;
  runtimeId: string;
  towerMode: TowerModeV1;
  slot: number;
  bundle: EncryptedRuntimeRecoveryBundleV1;
  lastResortPayload: TowerLastResortPayloadV1;
};

export type WatchtowerStoreStats = {
  lookupCount: number;
  lastResortAppointmentCount: number;
  actionReceiptCount: number;
};

const DEFAULT_MAX_BUNDLES = 3;
const DEFAULT_MAX_STORED_BYTES = 4 * 1024 * 1024;
const DEFAULT_RECEIPT_TTL_MS = 365 * 24 * 60 * 60 * 1000;
const STATS_CACHE_TTL_MS = 5_000;
const META_STATS_KEY = 'meta:stats:v1';

const normalizeLookupKey = (lookupKey: string): string => {
  const normalized = String(lookupKey || '').trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(normalized)) {
    throw new Error(`TOWER_LOOKUP_KEY_INVALID: ${lookupKey}`);
  }
  return normalized;
};

const towerModeOf = (appointment: TowerAppointmentV1): TowerModeV1 =>
  normalizeTowerModeV1(appointment.towerMode);

const slotOf = (appointment: TowerAppointmentV1): number =>
  Math.max(0, Math.floor(Number(appointment.slot ?? 0)));

const normalizeStoredDoc = (lookupKey: string, doc: StoredLookupDoc | null | undefined): StoredLookupDoc => ({
  lookupKey,
  runtimeId: String(doc?.runtimeId || '').trim().toLowerCase(),
  updatedAt: Math.max(0, Math.floor(Number(doc?.updatedAt || 0))),
  receipts: Array.isArray(doc?.receipts) ? doc!.receipts : [],
  bundles: Array.isArray(doc?.bundles) ? doc!.bundles : [],
});

const computeStoredLookupBytes = (doc: StoredLookupDoc): number =>
  Buffer.byteLength(serializeTaggedJson(doc), 'utf8');

const defaultDbPath = (): string => join(process.cwd(), 'data', 'watchtower');

const buildReceiptMessage = (receipt: TowerReceiptV1): string =>
  `xln:watchtower:receipt:v1|${receipt.towerId}|${receipt.lookupKey}|${receipt.runtimeId}|${receipt.height}|${receipt.bundleHash}|${Math.max(0, Math.floor(Number(receipt.sequence || 0)))}|${Math.max(0, Math.floor(Number(receipt.slot || 0)))}|${String(receipt.towerMode || 'blind_backup')}|${Math.max(0, Math.floor(Number(receipt.storedBytes || 0)))}|${Math.max(0, Math.floor(Number(receipt.maxStoredBytes || 0)))}|${Math.max(0, Math.floor(Number(receipt.expiresAt || 0)))}`;

export type WatchtowerStore = ReturnType<typeof createWatchtowerStore>;

export const createWatchtowerStore = (options?: {
  towerId?: string;
  dbPath?: string;
  maxBundlesPerLookupKey?: number;
  maxStoredBytesPerLookupKey?: number;
  receiptTtlMs?: number;
  towerPrivateKey?: string;
  now?: () => number;
}) => {
  const towerId = String(options?.towerId || 'xln-watchtower').trim() || 'xln-watchtower';
  const dbPath = options?.dbPath || defaultDbPath();
  const maxBundlesPerLookupKey = Math.max(1, Math.min(8, Math.floor(Number(options?.maxBundlesPerLookupKey ?? DEFAULT_MAX_BUNDLES))));
  const maxStoredBytesPerLookupKey = Math.max(1024, Math.floor(Number(options?.maxStoredBytesPerLookupKey ?? DEFAULT_MAX_STORED_BYTES)));
  const receiptTtlMs = Math.max(60_000, Math.floor(Number(options?.receiptTtlMs ?? DEFAULT_RECEIPT_TTL_MS)));
  const now = options?.now || (() => Date.now());
  const towerPrivateKey = String(
    options?.towerPrivateKey
    || process.env['XLN_WATCHTOWER_PRIVATE_KEY']
    || ethers.keccak256(ethers.toUtf8Bytes(`xln:watchtower:${towerId}`)),
  );
  const signer = new Wallet(towerPrivateKey);
  const actionPublicKey = getTowerPayloadEncryptionPublicKey(towerPrivateKey);

  const db = new Level<string, string>(dbPath, { valueEncoding: 'utf8' });
  let opened = false;
  let cachedStats: { cachedAt: number; value: WatchtowerStoreStats } | null = null;

  const invalidateStats = (): void => {
    cachedStats = null;
  };

  const ensureOpen = async (): Promise<void> => {
    if (opened) return;
    await mkdir(dirname(dbPath), { recursive: true });
    await db.open();
    opened = true;
  };

  const lookupKeyFor = (lookupKey: string): string => `lookup:${normalizeLookupKey(lookupKey)}`;
  const complaintKey = (): string => `complaint:${now()}:${randomUUID()}`;
  const actionReceiptPrefix = (lookupKey: string): string => `action:${normalizeLookupKey(lookupKey)}:`;
  const actionReceiptKey = (lookupKey: string): string => `${actionReceiptPrefix(lookupKey)}${now()}:${randomUUID()}`;

  const normalizeMetaStats = (raw: StoredTowerMetaStats | null | undefined): StoredTowerMetaStats => ({
    actionReceiptCount: Math.max(0, Math.floor(Number(raw?.actionReceiptCount || 0))),
  });

  const readMetaStats = async (): Promise<StoredTowerMetaStats> => {
    await ensureOpen();
    try {
      return normalizeMetaStats(JSON.parse(await db.get(META_STATS_KEY)) as StoredTowerMetaStats);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/LEVEL_NOT_FOUND|NotFound/i.test(message)) return normalizeMetaStats(null);
      throw error;
    }
  };

  const readLookup = async (lookupKey: string): Promise<StoredLookupDoc | null> => {
    await ensureOpen();
    try {
      const raw = await db.get(lookupKeyFor(lookupKey));
      return normalizeStoredDoc(normalizeLookupKey(lookupKey), JSON.parse(raw) as StoredLookupDoc);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/LEVEL_NOT_FOUND|NotFound/i.test(message)) return null;
      throw error;
    }
  };

  const writeLookup = async (doc: StoredLookupDoc): Promise<void> => {
    await ensureOpen();
    await db.put(lookupKeyFor(doc.lookupKey), serializeTaggedJson(doc));
    invalidateStats();
  };

  const signReceipt = async (receipt: TowerReceiptV1): Promise<TowerReceiptV1> => ({
    ...receipt,
    towerSignature: await signer.signMessage(buildReceiptMessage(receipt)),
  });

  const upsertAppointment = async (appointment: TowerAppointmentV1): Promise<TowerReceiptV1> => {
    const lookupKey = normalizeLookupKey(appointment.lookupKey);
    const towerMode = towerModeOf(appointment);
    const slot = slotOf(appointment);
    if (towerMode === 'blind_backup' && appointment.lastResortPayload) {
      throw new Error('TOWER_BACKUP_LAST_RESORT_PAYLOAD_FORBIDDEN');
    }
    if (towerMode === 'delayed_last_resort' && !appointment.lastResortPayload) {
      throw new Error('TOWER_LAST_RESORT_PAYLOAD_MISSING');
    }
    const existing = normalizeStoredDoc(lookupKey, await readLookup(lookupKey));
    const runtimeId = String(appointment.bundle.runtimeId || '').trim().toLowerCase();
    const sequence = Math.max(0, ...existing.receipts.map((receipt) => receipt.sequence || 0)) + 1;
    const lastResortPayloadDigest = computeTowerLastResortPayloadDigest(appointment.lastResortPayload);

    const nextBundles = [
      {
        slot,
        towerMode,
        bundle: appointment.bundle,
        lastResortPayloadDigest,
        ...(appointment.lastResortPayload ? { lastResortPayload: structuredClone(appointment.lastResortPayload) } : {}),
      },
      ...existing.bundles.filter((entry) =>
        !(entry.slot === slot && entry.towerMode === towerMode && entry.bundle.bundleHash === appointment.bundle.bundleHash),
      ),
    ]
      .sort((left, right) => {
        if (right.bundle.height !== left.bundle.height) return right.bundle.height - left.bundle.height;
        if (right.bundle.createdAt !== left.bundle.createdAt) return right.bundle.createdAt - left.bundle.createdAt;
        return right.slot - left.slot;
      })
      .slice(0, maxBundlesPerLookupKey);

    const nextDoc: StoredLookupDoc = {
      lookupKey,
      runtimeId,
      updatedAt: now(),
      receipts: existing.receipts,
      bundles: nextBundles,
    };

    const storedBytes = computeStoredLookupBytes(nextDoc);
    if (storedBytes > maxStoredBytesPerLookupKey) {
      throw new Error(`TOWER_QUOTA_EXCEEDED: bytes=${storedBytes} max=${maxStoredBytesPerLookupKey}`);
    }

    const unsignedReceipt: TowerReceiptV1 = {
      type: 'tower_receipt',
      version: 1,
      towerId,
      lookupKey,
      runtimeId,
      height: Math.max(0, Math.floor(Number(appointment.bundle.height || 0))),
      bundleHash: appointment.bundle.bundleHash,
      towerMode,
      slot,
      storedAt: nextDoc.updatedAt,
      receivedAt: nextDoc.updatedAt,
      expiresAt: nextDoc.updatedAt + receiptTtlMs,
      sequence,
      retainedSlots: nextBundles.length,
      storedBytes,
      maxStoredBytes: maxStoredBytesPerLookupKey,
      quotaOk: true,
      appointmentSequence: Number.isFinite(Number(appointment.lastResortPayload?.appointmentSequence))
        ? Math.max(0, Math.floor(Number(appointment.lastResortPayload?.appointmentSequence || 0)))
        : null,
    };
    const receipt = await signReceipt(unsignedReceipt);
    nextDoc.receipts = [receipt, ...existing.receipts].slice(0, maxBundlesPerLookupKey);
    await writeLookup(nextDoc);
    return receipt;
  };

  const getLatest = async (lookupKey: string): Promise<{ receipt: TowerReceiptV1; bundle: EncryptedRuntimeRecoveryBundleV1 } | null> => {
    const existing = await readLookup(lookupKey);
    if (!existing || existing.receipts.length === 0 || existing.bundles.length === 0) return null;
    return {
      receipt: existing.receipts[0]!,
      bundle: existing.bundles[0]!.bundle,
    };
  };

  const getLatestReceipt = async (lookupKey: string): Promise<TowerReceiptV1 | null> => {
    const existing = await readLookup(lookupKey);
    return existing?.receipts[0] || null;
  };

  const appendComplaint = async (payload: Record<string, unknown>): Promise<void> => {
    await ensureOpen();
    await db.put(complaintKey(), serializeTaggedJson({ ts: now(), ...payload }));
    invalidateStats();
  };

  const listLatestLastResortAppointments = async (): Promise<LastResortTowerAppointment[]> => {
    await ensureOpen();
    const appointments: LastResortTowerAppointment[] = [];
    for await (const [, raw] of db.iterator({ gte: 'lookup:', lte: 'lookup:\xff' })) {
      const parsed = JSON.parse(String(raw)) as StoredLookupDoc;
      const doc = normalizeStoredDoc(parsed.lookupKey, parsed);
      const lastResortEntry = doc.bundles
        .filter((entry) =>
          entry.towerMode === 'delayed_last_resort'
          && !!entry.lastResortPayload,
        )
        .sort((left, right) => {
          const leftSequence = Math.max(0, Math.floor(Number(left.lastResortPayload?.appointmentSequence || 0)));
          const rightSequence = Math.max(0, Math.floor(Number(right.lastResortPayload?.appointmentSequence || 0)));
          if (rightSequence !== leftSequence) return rightSequence - leftSequence;
          const leftNonce = Math.max(0, Math.floor(Number(left.lastResortPayload?.proofNonce || 0)));
          const rightNonce = Math.max(0, Math.floor(Number(right.lastResortPayload?.proofNonce || 0)));
          if (rightNonce !== leftNonce) return rightNonce - leftNonce;
          if (right.bundle.height !== left.bundle.height) return right.bundle.height - left.bundle.height;
          if (right.bundle.createdAt !== left.bundle.createdAt) return right.bundle.createdAt - left.bundle.createdAt;
          return right.slot - left.slot;
        })[0];
      if (!lastResortEntry?.lastResortPayload) continue;
      appointments.push({
        lookupKey: doc.lookupKey,
        runtimeId: doc.runtimeId,
        towerMode: lastResortEntry.towerMode,
        slot: lastResortEntry.slot,
        bundle: lastResortEntry.bundle,
        lastResortPayload: structuredClone(lastResortEntry.lastResortPayload),
      });
    }
    return appointments;
  };

  const appendActionReceipt = async (receipt: StoredTowerActionReceipt): Promise<void> => {
    await ensureOpen();
    const metaStats = await readMetaStats();
    await db.batch([
      { type: 'put', key: actionReceiptKey(receipt.lookupKey), value: serializeTaggedJson(receipt) },
      {
        type: 'put',
        key: META_STATS_KEY,
        value: serializeTaggedJson({
          actionReceiptCount: metaStats.actionReceiptCount + 1,
        } satisfies StoredTowerMetaStats),
      },
    ]);
    invalidateStats();
  };

  const listActionReceipts = async (lookupKey: string): Promise<StoredTowerActionReceipt[]> => {
    await ensureOpen();
    const normalized = normalizeLookupKey(lookupKey);
    const prefix = actionReceiptPrefix(normalized);
    const receipts: StoredTowerActionReceipt[] = [];
    for await (const [, raw] of db.iterator({ gte: prefix, lte: `${prefix}\xff`, reverse: true })) {
      receipts.push(JSON.parse(String(raw)) as StoredTowerActionReceipt);
    }
    return receipts;
  };

  const close = async (): Promise<void> => {
    if (!opened) return;
    opened = false;
    await db.close();
  };

  const getStats = async (): Promise<WatchtowerStoreStats> => {
    await ensureOpen();
    const currentTime = now();
    if (cachedStats && currentTime - cachedStats.cachedAt < STATS_CACHE_TTL_MS) {
      return cachedStats.value;
    }
    let lookupCount = 0;
    let lastResortAppointmentCount = 0;
    for await (const [, raw] of db.iterator({ gte: 'lookup:', lte: 'lookup:\xff' })) {
      lookupCount += 1;
      const parsed = JSON.parse(String(raw)) as StoredLookupDoc;
      const doc = normalizeStoredDoc(parsed.lookupKey, parsed);
      if (doc.bundles.some((entry) => entry.towerMode === 'delayed_last_resort' && !!entry.lastResortPayload)) {
        lastResortAppointmentCount += 1;
      }
    }
    const metaStats = await readMetaStats();
    const value = {
      lookupCount,
      lastResortAppointmentCount,
      actionReceiptCount: metaStats.actionReceiptCount,
    };
    cachedStats = { cachedAt: currentTime, value };
    return value;
  };

  const pruneExpired = async (): Promise<{ deleted: number }> => {
    await ensureOpen();
    const cutoff = now() - receiptTtlMs;
    let deleted = 0;
    const keysToDelete: string[] = [];
    for await (const [key] of db.iterator()) {
      if (key.startsWith('action:')) {
        const timestamp = Number(String(key).split(':')[2] || 0);
        if (Number.isFinite(timestamp) && timestamp > 0 && timestamp < cutoff) {
          keysToDelete.push(key);
        }
        continue;
      }
      if (key.startsWith('complaint:')) {
        const timestamp = Number(String(key).split(':')[1] || 0);
        if (Number.isFinite(timestamp) && timestamp > 0 && timestamp < cutoff) {
          keysToDelete.push(key);
        }
      }
    }
    if (keysToDelete.length > 0) {
      const metaStats = await readMetaStats();
      await db.batch([
        ...keysToDelete.map((key) => ({ type: 'del' as const, key })),
        {
          type: 'put' as const,
          key: META_STATS_KEY,
          value: serializeTaggedJson({
            actionReceiptCount: Math.max(0, metaStats.actionReceiptCount - keysToDelete.filter((key) => key.startsWith('action:')).length),
          } satisfies StoredTowerMetaStats),
        },
      ]);
      deleted = keysToDelete.length;
    }
    if (deleted > 0) invalidateStats();
    return { deleted };
  };

  return {
    towerId,
    dbPath,
    maxBundlesPerLookupKey,
    maxStoredBytesPerLookupKey,
    signerAddress: signer.address.toLowerCase(),
    actionPublicKey,
    upsertAppointment,
    getLatest,
    getLatestReceipt,
    listLatestLastResortAppointments,
    appendActionReceipt,
    listActionReceipts,
    appendComplaint,
    getStats,
    pruneExpired,
    close,
  };
};
