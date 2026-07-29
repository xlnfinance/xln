import type {
  EncryptedRuntimeRecoveryBundleV1,
  TowerAppointmentV1,
  TowerLastResortPayloadV1,
  TowerModeV1,
  TowerReceiptV1,
} from '../recovery/types';
import { normalizeTowerModeV1 } from '../recovery/types';
import { computeTowerLastResortPayloadDigest } from '../recovery/crypto';
import { deserializeTaggedJson } from '../protocol/serialization';
import {
  computeStoredLookupBytes,
  emptyStoredDoc,
  ensureWatchtowerStoreOpen,
  normalizeLookupKey,
  readLookup,
  writeLookup,
} from './store-db';
import type { LastResortTowerAppointment, StoredLookupDoc, WatchtowerStoreContext } from './store-types';
import { decodeStoredLookupDoc, decodeWatchtowerStoredValue } from './store-decode';

const towerModeOf = (appointment: TowerAppointmentV1): TowerModeV1 => normalizeTowerModeV1(appointment.towerMode);

const slotOf = (appointment: TowerAppointmentV1): number => Math.max(0, Math.floor(Number(appointment.slot ?? 0)));

const assertEncryptedLastResortPayload = (payload: TowerLastResortPayloadV1 | null | undefined): void => {
  const raw = String(payload?.encryptedRemedy || '').trim();
  if (!raw) throw new Error('TOWER_LAST_RESORT_PAYLOAD_REMEDY_MISSING');
  let parsed: Record<string, unknown>;
  try {
    parsed = deserializeTaggedJson<Record<string, unknown>>(raw);
  } catch {
    throw new Error('TOWER_LAST_RESORT_PAYLOAD_REMEDY_NOT_ENCRYPTED');
  }
  if (
    parsed['type'] !== 'tower_encrypted_payload' ||
    parsed['version'] !== 1 ||
    parsed['alg'] !== 'watch-seed-aes-256-gcm' ||
    typeof parsed['iv'] !== 'string' ||
    typeof parsed['ciphertext'] !== 'string'
  ) {
    throw new Error('TOWER_LAST_RESORT_PAYLOAD_REMEDY_NOT_ENCRYPTED');
  }
};

const buildReceiptMessage = (receipt: TowerReceiptV1): string =>
  `xln:watchtower:receipt:v1|${receipt.towerId}|${receipt.lookupKey}|${receipt.runtimeId}|${receipt.height}|${receipt.bundleHash}|${Math.max(0, Math.floor(Number(receipt.sequence || 0)))}|${Math.max(0, Math.floor(Number(receipt.slot || 0)))}|${String(receipt.towerMode || 'blind_backup')}|${Math.max(0, Math.floor(Number(receipt.storedBytes || 0)))}|${Math.max(0, Math.floor(Number(receipt.maxStoredBytes || 0)))}|${Math.max(0, Math.floor(Number(receipt.expiresAt || 0)))}`;

const sortStoredBundles = (bundles: StoredLookupDoc['bundles']): StoredLookupDoc['bundles'] =>
  bundles.sort((left, right) => {
    if (right.bundle.height !== left.bundle.height) return right.bundle.height - left.bundle.height;
    if (right.bundle.createdAt !== left.bundle.createdAt) return right.bundle.createdAt - left.bundle.createdAt;
    return right.slot - left.slot;
  });

const retainAppointmentBundles = (
  bundles: StoredLookupDoc['bundles'],
  towerMode: TowerModeV1,
  limit: number,
): StoredLookupDoc['bundles'] => {
  const pinned: StoredLookupDoc['bundles'] = [];
  const pin = (entry: StoredLookupDoc['bundles'][number] | undefined): void => {
    if (entry && !pinned.includes(entry)) pinned.push(entry);
  };
  if (towerMode === 'blind_backup') {
    pin(bundles.find(entry => entry.towerMode === 'blind_backup' && entry.bundle.kind !== 'journal_tail'));
    pin(bundles.find(entry => entry.towerMode === 'blind_backup' && entry.bundle.kind === 'journal_tail'));
  }
  return [...pinned, ...bundles.filter(entry => !pinned.includes(entry))].slice(0, limit);
};

const validateAppointmentMode = (appointment: TowerAppointmentV1, towerMode: TowerModeV1): void => {
  if (towerMode === 'blind_backup' && appointment.lastResortPayload) {
    throw new Error('TOWER_BACKUP_LAST_RESORT_PAYLOAD_FORBIDDEN');
  }
  if (towerMode === 'delayed_last_resort' && !appointment.lastResortPayload) {
    throw new Error('TOWER_LAST_RESORT_PAYLOAD_MISSING');
  }
  if (towerMode === 'delayed_last_resort') {
    assertEncryptedLastResortPayload(appointment.lastResortPayload);
  }
};

export const upsertAppointment = async (
  context: WatchtowerStoreContext,
  appointment: TowerAppointmentV1,
): Promise<TowerReceiptV1> => {
  const lookupKey = normalizeLookupKey(appointment.lookupKey);
  const towerMode = towerModeOf(appointment);
  const slot = slotOf(appointment);
  validateAppointmentMode(appointment, towerMode);
  const existing = await readLookup(context, lookupKey) ?? emptyStoredDoc(lookupKey);
  const runtimeId = String(appointment.bundle.runtimeId || '')
    .trim()
    .toLowerCase();
  const sequence = Math.max(0, ...existing.receipts.map(receipt => receipt.sequence || 0)) + 1;
  const lastResortPayloadDigest = computeTowerLastResortPayloadDigest(appointment.lastResortPayload);
  const candidate = {
    slot,
    towerMode,
    bundle: appointment.bundle,
    lastResortPayloadDigest,
    ...(appointment.lastResortPayload ? { lastResortPayload: structuredClone(appointment.lastResortPayload) } : {}),
  };
  const sortedBundles = sortStoredBundles([
    candidate,
    ...existing.bundles.filter(
      entry =>
        !(
          entry.slot === slot &&
          entry.towerMode === towerMode &&
          entry.bundle.bundleHash === appointment.bundle.bundleHash
        ),
    ),
  ]);
  const nextBundles = retainAppointmentBundles(sortedBundles, towerMode, context.maxBundlesPerLookupKey);
  const nextDoc: StoredLookupDoc = {
    lookupKey,
    runtimeId,
    updatedAt: context.now(),
    receipts: existing.receipts,
    bundles: nextBundles,
  };
  const storedBytes = computeStoredLookupBytes(nextDoc);
  if (storedBytes > context.maxStoredBytesPerLookupKey) {
    throw new Error(`TOWER_QUOTA_EXCEEDED: bytes=${storedBytes} max=${context.maxStoredBytesPerLookupKey}`);
  }
  const unsignedReceipt: TowerReceiptV1 = {
    type: 'tower_receipt',
    version: 1,
    towerId: context.towerId,
    lookupKey,
    runtimeId,
    height: Math.max(0, Math.floor(Number(appointment.bundle.height || 0))),
    bundleHash: appointment.bundle.bundleHash,
    towerMode,
    slot,
    storedAt: nextDoc.updatedAt,
    receivedAt: nextDoc.updatedAt,
    expiresAt: nextDoc.updatedAt + context.receiptTtlMs,
    sequence,
    retainedSlots: nextBundles.length,
    storedBytes,
    maxStoredBytes: context.maxStoredBytesPerLookupKey,
    quotaOk: true,
    appointmentSequence: Number.isFinite(Number(appointment.lastResortPayload?.appointmentSequence))
      ? Math.max(0, Math.floor(Number(appointment.lastResortPayload?.appointmentSequence || 0)))
      : null,
  };
  const receipt = {
    ...unsignedReceipt,
    towerSignature: await context.signer.signMessage(buildReceiptMessage(unsignedReceipt)),
  };
  nextDoc.receipts = [receipt, ...existing.receipts].slice(0, context.maxBundlesPerLookupKey);
  await writeLookup(context, nextDoc);
  return receipt;
};

export const getLatest = async (
  context: WatchtowerStoreContext,
  lookupKey: string,
): Promise<{
  receipt: TowerReceiptV1;
  bundle: EncryptedRuntimeRecoveryBundleV1;
  bundles: EncryptedRuntimeRecoveryBundleV1[];
} | null> => {
  const existing = await readLookup(context, lookupKey);
  if (!existing || existing.receipts.length === 0 || existing.bundles.length === 0) return null;
  const sorted = sortStoredBundles([...existing.bundles]);
  const snapshots = sorted.filter(entry => entry.towerMode === 'blind_backup' && entry.bundle.kind !== 'journal_tail');
  const journalTails = sorted.filter(
    entry => entry.towerMode === 'blind_backup' && entry.bundle.kind === 'journal_tail',
  );
  const candidates = snapshots
    .map(snapshot => {
      const tail = journalTails.find(
        entry =>
          entry.bundle.baseRuntimeHeight === snapshot.bundle.height && entry.bundle.height >= snapshot.bundle.height,
      );
      return { snapshot, tail, height: tail?.bundle.height ?? snapshot.bundle.height };
    })
    .sort((left, right) =>
      right.height !== left.height
        ? right.height - left.height
        : right.snapshot.bundle.height - left.snapshot.bundle.height,
    );
  const best = candidates[0];
  const bundles = best
    ? best.tail
      ? [best.snapshot.bundle, best.tail.bundle]
      : [best.snapshot.bundle]
    : [existing.bundles[0]!.bundle];
  return {
    receipt: existing.receipts[0]!,
    bundle: bundles[bundles.length - 1]!,
    bundles,
  };
};

export const getLatestReceipt = async (
  context: WatchtowerStoreContext,
  lookupKey: string,
): Promise<TowerReceiptV1 | null> => {
  const existing = await readLookup(context, lookupKey);
  return existing?.receipts[0] || null;
};

const compareLastResortBundles = (
  left: StoredLookupDoc['bundles'][number],
  right: StoredLookupDoc['bundles'][number],
): number => {
  const leftSequence = Math.max(0, Math.floor(Number(left.lastResortPayload?.appointmentSequence || 0)));
  const rightSequence = Math.max(0, Math.floor(Number(right.lastResortPayload?.appointmentSequence || 0)));
  if (rightSequence !== leftSequence) return rightSequence - leftSequence;
  const leftNonce = Math.max(0, Math.floor(Number(left.lastResortPayload?.proofNonce || 0)));
  const rightNonce = Math.max(0, Math.floor(Number(right.lastResortPayload?.proofNonce || 0)));
  if (rightNonce !== leftNonce) return rightNonce - leftNonce;
  if (right.bundle.height !== left.bundle.height) return right.bundle.height - left.bundle.height;
  if (right.bundle.createdAt !== left.bundle.createdAt) return right.bundle.createdAt - left.bundle.createdAt;
  return right.slot - left.slot;
};

export const listLatestLastResortAppointments = async (
  context: WatchtowerStoreContext,
): Promise<LastResortTowerAppointment[]> => {
  await ensureWatchtowerStoreOpen(context);
  const appointments: LastResortTowerAppointment[] = [];
  for await (const [key, raw] of context.db.iterator({ gte: 'lookup:', lte: 'lookup:\xff' })) {
    const doc = decodeWatchtowerStoredValue('lookup', String(key), String(raw), decodeStoredLookupDoc);
    const entry = doc.bundles
      .filter(candidate => candidate.towerMode === 'delayed_last_resort' && !!candidate.lastResortPayload)
      .sort(compareLastResortBundles)[0];
    if (!entry?.lastResortPayload) continue;
    appointments.push({
      lookupKey: doc.lookupKey,
      runtimeId: doc.runtimeId,
      towerMode: entry.towerMode,
      slot: entry.slot,
      bundle: entry.bundle,
      lastResortPayload: structuredClone(entry.lastResortPayload),
    });
  }
  return appointments;
};
