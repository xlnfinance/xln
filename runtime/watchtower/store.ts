import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Level } from 'level';
import { Wallet, ethers } from 'ethers';
import { serializeTaggedJson } from '../serialization-utils';
import type {
  EncryptedRuntimeRecoveryBundleV1,
  TowerActivePayloadV1,
  TowerAppointmentV1,
  TowerModeV1,
  TowerReceiptV1,
} from '../recovery/types';
import { computeTowerActivePayloadDigest } from '../recovery/crypto';

type StoredLookupDoc = {
  lookupKey: string;
  runtimeId: string;
  updatedAt: number;
  receipts: TowerReceiptV1[];
  bundles: Array<{
    slot: number;
    towerMode: TowerModeV1;
    bundle: EncryptedRuntimeRecoveryBundleV1;
    activePayloadDigest: string;
    activePayload?: TowerActivePayloadV1;
  }>;
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

export type ActiveTowerAppointment = {
  lookupKey: string;
  runtimeId: string;
  towerMode: TowerModeV1;
  slot: number;
  bundle: EncryptedRuntimeRecoveryBundleV1;
  activePayload: TowerActivePayloadV1;
};

export type WatchtowerStoreStats = {
  lookupCount: number;
  activeAppointmentCount: number;
  actionReceiptCount: number;
};

const DEFAULT_MAX_BUNDLES = 3;
const DEFAULT_MAX_STORED_BYTES = 10 * 1024;
const DEFAULT_RECEIPT_TTL_MS = 365 * 24 * 60 * 60 * 1000;

const normalizeLookupKey = (lookupKey: string): string => {
  const normalized = String(lookupKey || '').trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(normalized)) {
    throw new Error(`TOWER_LOOKUP_KEY_INVALID: ${lookupKey}`);
  }
  return normalized;
};

const towerModeOf = (appointment: TowerAppointmentV1): TowerModeV1 =>
  appointment.towerMode === 'active_watchtower' || appointment.towerMode === 'delayed_last_resort'
    ? appointment.towerMode
    : 'blind_backup';

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
  const signer = new Wallet(
    String(
      options?.towerPrivateKey
      || process.env['XLN_WATCHTOWER_PRIVATE_KEY']
      || ethers.keccak256(ethers.toUtf8Bytes(`xln:watchtower:${towerId}`)),
    ),
  );

  const db = new Level<string, string>(dbPath, { valueEncoding: 'utf8' });
  let opened = false;

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
  };

  const signReceipt = async (receipt: TowerReceiptV1): Promise<TowerReceiptV1> => ({
    ...receipt,
    towerSignature: await signer.signMessage(buildReceiptMessage(receipt)),
  });

  const upsertAppointment = async (appointment: TowerAppointmentV1): Promise<TowerReceiptV1> => {
    const lookupKey = normalizeLookupKey(appointment.lookupKey);
    const towerMode = towerModeOf(appointment);
    const slot = slotOf(appointment);
    const existing = normalizeStoredDoc(lookupKey, await readLookup(lookupKey));
    const runtimeId = String(appointment.bundle.runtimeId || '').trim().toLowerCase();
    const sequence = Math.max(0, ...existing.receipts.map((receipt) => receipt.sequence || 0)) + 1;
    const activePayloadDigest = computeTowerActivePayloadDigest(appointment.activePayload);

    const nextBundles = [
      {
        slot,
        towerMode,
        bundle: appointment.bundle,
        activePayloadDigest,
        ...(appointment.activePayload ? { activePayload: structuredClone(appointment.activePayload) } : {}),
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
      appointmentSequence: Number.isFinite(Number(appointment.activePayload?.appointmentSequence))
        ? Math.max(0, Math.floor(Number(appointment.activePayload?.appointmentSequence || 0)))
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
  };

  const listLatestActiveAppointments = async (): Promise<ActiveTowerAppointment[]> => {
    await ensureOpen();
    const appointments: ActiveTowerAppointment[] = [];
    for await (const [, raw] of db.iterator({ gte: 'lookup:', lte: 'lookup:\xff' })) {
      const parsed = JSON.parse(String(raw)) as StoredLookupDoc;
      const doc = normalizeStoredDoc(parsed.lookupKey, parsed);
      const activeEntry = doc.bundles
        .filter((entry) =>
          (entry.towerMode === 'active_watchtower' || entry.towerMode === 'delayed_last_resort')
          && !!entry.activePayload,
        )
        .sort((left, right) => {
          if (right.bundle.height !== left.bundle.height) return right.bundle.height - left.bundle.height;
          if (right.bundle.createdAt !== left.bundle.createdAt) return right.bundle.createdAt - left.bundle.createdAt;
          return right.slot - left.slot;
        })[0];
      if (!activeEntry?.activePayload) continue;
      appointments.push({
        lookupKey: doc.lookupKey,
        runtimeId: doc.runtimeId,
        towerMode: activeEntry.towerMode,
        slot: activeEntry.slot,
        bundle: activeEntry.bundle,
        activePayload: structuredClone(activeEntry.activePayload),
      });
    }
    return appointments;
  };

  const appendActionReceipt = async (receipt: StoredTowerActionReceipt): Promise<void> => {
    await ensureOpen();
    await db.put(actionReceiptKey(receipt.lookupKey), serializeTaggedJson(receipt));
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
    let lookupCount = 0;
    let activeAppointmentCount = 0;
    let actionReceiptCount = 0;
    for await (const [key, raw] of db.iterator()) {
      if (key.startsWith('lookup:')) {
        lookupCount += 1;
        const parsed = JSON.parse(String(raw)) as StoredLookupDoc;
        const doc = normalizeStoredDoc(parsed.lookupKey, parsed);
        if (doc.bundles.some((entry) =>
          (entry.towerMode === 'active_watchtower' || entry.towerMode === 'delayed_last_resort')
          && !!entry.activePayload,
        )) {
          activeAppointmentCount += 1;
        }
        continue;
      }
      if (key.startsWith('action:')) {
        actionReceiptCount += 1;
      }
    }
    return {
      lookupCount,
      activeAppointmentCount,
      actionReceiptCount,
    };
  };

  return {
    towerId,
    dbPath,
    maxBundlesPerLookupKey,
    maxStoredBytesPerLookupKey,
    signerAddress: signer.address.toLowerCase(),
    upsertAppointment,
    getLatest,
    getLatestReceipt,
    listLatestActiveAppointments,
    appendActionReceipt,
    listActionReceipts,
    appendComplaint,
    getStats,
    close,
  };
};
