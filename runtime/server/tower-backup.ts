import { appendFile, mkdir, readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { deserializeTaggedJson, serializeTaggedJson } from '../serialization-utils';
import type {
  EncryptedRuntimeRecoveryBundleV1,
  TowerAppointmentV1,
  TowerReceiptV1,
} from '../recovery/types';

type TowerStoredLookup = {
  lookupKey: string;
  receipts: TowerReceiptV1[];
  bundles: EncryptedRuntimeRecoveryBundleV1[];
  updatedAt: number;
};

export type TowerBackupStore = ReturnType<typeof createTowerBackupStore>;

const sanitizeLookupKey = (lookupKey: string): string => {
  const normalized = String(lookupKey || '').trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(normalized)) {
    throw new Error(`TOWER_LOOKUP_KEY_INVALID: ${lookupKey}`);
  }
  return normalized;
};

const defaultTowerDir = (): string => join(process.cwd(), 'data', 'tower-backups');
const defaultComplaintLog = (): string => join(process.cwd(), '.logs', 'recovery-complaints.jsonl');

export const createTowerBackupStore = (options?: {
  towerId?: string;
  dir?: string;
  complaintLogPath?: string;
  maxBundlesPerLookupKey?: number;
  now?: () => number;
}) => {
  const towerId = String(options?.towerId || 'xln-tower').trim() || 'xln-tower';
  const dir = options?.dir || defaultTowerDir();
  const complaintLogPath = options?.complaintLogPath || defaultComplaintLog();
  const maxBundlesPerLookupKey = Math.max(1, Math.min(10, Math.floor(Number(options?.maxBundlesPerLookupKey ?? 3))));
  const now = options?.now || (() => Date.now());

  const ensureDir = async (): Promise<void> => {
    await mkdir(dir, { recursive: true });
    await mkdir(join(complaintLogPath, '..'), { recursive: true }).catch(() => {});
  };

  const filePath = (lookupKey: string): string => join(dir, `${sanitizeLookupKey(lookupKey).slice(2)}.json`);

  const readLookup = async (lookupKey: string): Promise<TowerStoredLookup | null> => {
    try {
      const raw = await readFile(filePath(lookupKey), 'utf8');
      return deserializeTaggedJson<TowerStoredLookup>(raw);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/ENOENT|not found/i.test(message)) return null;
      throw error;
    }
  };

  const writeLookup = async (lookup: TowerStoredLookup): Promise<void> => {
    await ensureDir();
    await writeFile(filePath(lookup.lookupKey), serializeTaggedJson(lookup), 'utf8');
  };

  const upsertAppointment = async (appointment: TowerAppointmentV1): Promise<TowerReceiptV1> => {
    const lookupKey = sanitizeLookupKey(appointment.lookupKey);
    const existing = await readLookup(lookupKey);
    const sequence = Math.max(0, ...(existing?.receipts.map((receipt) => receipt.sequence) || [0])) + 1;
    const nextBundles = [
      appointment.bundle,
      ...(existing?.bundles || []).filter((bundle) => bundle.bundleHash !== appointment.bundle.bundleHash),
    ]
      .sort((left, right) => {
        if (right.height !== left.height) return right.height - left.height;
        return right.createdAt - left.createdAt;
      })
      .slice(0, maxBundlesPerLookupKey);

    const receipt: TowerReceiptV1 = {
      type: 'tower_receipt',
      version: 1,
      towerId,
      lookupKey,
      runtimeId: String(appointment.bundle.runtimeId || '').trim().toLowerCase(),
      height: Math.max(0, Math.floor(Number(appointment.bundle.height || 0))),
      bundleHash: appointment.bundle.bundleHash,
      receivedAt: now(),
      sequence,
      retainedSlots: nextBundles.length,
    };

    await writeLookup({
      lookupKey,
      receipts: [receipt, ...(existing?.receipts || [])].slice(0, maxBundlesPerLookupKey),
      bundles: nextBundles,
      updatedAt: receipt.receivedAt,
    });
    return receipt;
  };

  const getLatest = async (lookupKey: string): Promise<{ receipt: TowerReceiptV1; bundle: EncryptedRuntimeRecoveryBundleV1 } | null> => {
    const existing = await readLookup(lookupKey);
    if (!existing || existing.receipts.length === 0 || existing.bundles.length === 0) return null;
    return {
      receipt: existing.receipts[0]!,
      bundle: existing.bundles[0]!,
    };
  };

  const getLatestReceipt = async (lookupKey: string): Promise<TowerReceiptV1 | null> => {
    const existing = await readLookup(lookupKey);
    return existing?.receipts[0] || null;
  };

  const appendComplaint = async (payload: Record<string, unknown>): Promise<void> => {
    await mkdir(join(complaintLogPath, '..'), { recursive: true });
    await appendFile(complaintLogPath, `${serializeTaggedJson({ ts: now(), ...payload })}\n`, 'utf8');
  };

  return {
    towerId,
    upsertAppointment,
    getLatest,
    getLatestReceipt,
    appendComplaint,
  };
};
