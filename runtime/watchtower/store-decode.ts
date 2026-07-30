import { deserializeTaggedJson } from '../protocol/serialization';
import { normalizeTowerModeV1 } from '../recovery/types';
import type {
  EncryptedRuntimeRecoveryBundleV1,
  TowerLastResortPayloadV1,
  TowerReceiptV1,
} from '../recovery/types';
import type {
  StoredLookupDoc,
  StoredTowerActionReceipt,
  StoredTowerMetaStats,
} from './store-types';
import {
  requireBoundaryRecord,
  requireExactBoundaryKeys,
} from '../protocol/boundary-validation';

export type WatchtowerStoredSchema = 'lookup' | 'action-receipt' | 'meta-stats';

/**
 * LevelDB corruption must identify both the physical key and the schema that
 * rejected it. The original decoder error remains the cause so operators get
 * precise forensic evidence without letting storage code invent defaults.
 */
export const decodeWatchtowerStoredValue = <T>(
  schema: WatchtowerStoredSchema,
  key: string,
  raw: string,
  decode: (value: string) => T,
): T => {
  try {
    return decode(raw);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`TOWER_STORED_RECORD_INVALID:schema=${schema}:key=${key}:${detail}`, { cause: error });
  }
};

const record = (value: unknown, code: string): Record<string, unknown> => {
  return requireBoundaryRecord(value, code);
};

const text = (value: unknown, code: string): string => {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(code);
  return value;
};

const safeInt = (value: unknown, code: string): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error(code);
  return value;
};

const optionalSafeInt = (value: unknown, code: string): void => {
  if (value !== undefined && value !== null) safeInt(value, code);
};

const decodeBundle = (
  value: unknown,
  lookupKey: string,
  runtimeId: string,
): EncryptedRuntimeRecoveryBundleV1 => {
  const bundle = record(value, 'TOWER_STORED_BUNDLE_INVALID');
  requireExactBoundaryKeys(
    bundle,
    ['version', 'runtimeId', 'lookupKey', 'height', 'createdAt', 'bundleHash', 'iv', 'ciphertext'],
    ['kind', 'baseRuntimeHeight', 'baseCheckpointHash', 'compression'],
    'TOWER_STORED_BUNDLE_FIELDS_INVALID',
  );
  if (bundle['version'] !== 1) throw new Error('TOWER_STORED_BUNDLE_VERSION_INVALID');
  if (bundle['kind'] !== undefined && bundle['kind'] !== 'snapshot' && bundle['kind'] !== 'journal_tail') {
    throw new Error('TOWER_STORED_BUNDLE_KIND_INVALID');
  }
  if (text(bundle['lookupKey'], 'TOWER_STORED_BUNDLE_LOOKUP_INVALID') !== lookupKey) {
    throw new Error('TOWER_STORED_BUNDLE_LOOKUP_MISMATCH');
  }
  if (text(bundle['runtimeId'], 'TOWER_STORED_BUNDLE_RUNTIME_INVALID').toLowerCase() !== runtimeId) {
    throw new Error('TOWER_STORED_BUNDLE_RUNTIME_MISMATCH');
  }
  safeInt(bundle['height'], 'TOWER_STORED_BUNDLE_HEIGHT_INVALID');
  safeInt(bundle['createdAt'], 'TOWER_STORED_BUNDLE_CREATED_AT_INVALID');
  optionalSafeInt(bundle['baseRuntimeHeight'], 'TOWER_STORED_BUNDLE_BASE_HEIGHT_INVALID');
  text(bundle['bundleHash'], 'TOWER_STORED_BUNDLE_HASH_INVALID');
  text(bundle['iv'], 'TOWER_STORED_BUNDLE_IV_INVALID');
  text(bundle['ciphertext'], 'TOWER_STORED_BUNDLE_CIPHERTEXT_INVALID');
  if (bundle['compression'] !== undefined && bundle['compression'] !== 'gzip') {
    throw new Error('TOWER_STORED_BUNDLE_COMPRESSION_INVALID');
  }
  return bundle as EncryptedRuntimeRecoveryBundleV1;
};

const decodeReceipt = (value: unknown, lookupKey: string, runtimeId: string): TowerReceiptV1 => {
  const receipt = record(value, 'TOWER_STORED_RECEIPT_INVALID');
  requireExactBoundaryKeys(
    receipt,
    [
      'type',
      'version',
      'towerId',
      'lookupKey',
      'runtimeId',
      'height',
      'bundleHash',
      'receivedAt',
      'sequence',
      'retainedSlots',
    ],
    [
      'towerMode',
      'slot',
      'storedAt',
      'expiresAt',
      'storedBytes',
      'maxStoredBytes',
      'quotaOk',
      'appointmentSequence',
      'towerSignature',
    ],
    'TOWER_STORED_RECEIPT_FIELDS_INVALID',
  );
  if (receipt['type'] !== 'tower_receipt' || receipt['version'] !== 1) {
    throw new Error('TOWER_STORED_RECEIPT_VERSION_INVALID');
  }
  if (text(receipt['lookupKey'], 'TOWER_STORED_RECEIPT_LOOKUP_INVALID') !== lookupKey) {
    throw new Error('TOWER_STORED_RECEIPT_LOOKUP_MISMATCH');
  }
  if (text(receipt['runtimeId'], 'TOWER_STORED_RECEIPT_RUNTIME_INVALID').toLowerCase() !== runtimeId) {
    throw new Error('TOWER_STORED_RECEIPT_RUNTIME_MISMATCH');
  }
  text(receipt['towerId'], 'TOWER_STORED_RECEIPT_TOWER_INVALID');
  text(receipt['bundleHash'], 'TOWER_STORED_RECEIPT_HASH_INVALID');
  for (const field of ['height', 'receivedAt', 'sequence', 'retainedSlots'] as const) {
    safeInt(receipt[field], `TOWER_STORED_RECEIPT_${field.toUpperCase()}_INVALID`);
  }
  for (const field of [
    'slot', 'storedAt', 'expiresAt', 'storedBytes', 'maxStoredBytes', 'appointmentSequence',
  ] as const) {
    optionalSafeInt(receipt[field], `TOWER_STORED_RECEIPT_${field.toUpperCase()}_INVALID`);
  }
  if (receipt['towerMode'] !== undefined) normalizeTowerModeV1(receipt['towerMode']);
  if (receipt['quotaOk'] !== undefined && typeof receipt['quotaOk'] !== 'boolean') {
    throw new Error('TOWER_STORED_RECEIPT_QUOTA_INVALID');
  }
  if (receipt['towerSignature'] !== undefined) {
    text(receipt['towerSignature'], 'TOWER_STORED_RECEIPT_SIGNATURE_INVALID');
  }
  return receipt as TowerReceiptV1;
};

export const decodeStoredLookupDoc = (raw: string, expectedLookupKey?: string): StoredLookupDoc => {
  const doc = record(deserializeTaggedJson(raw), 'TOWER_STORED_LOOKUP_INVALID');
  requireExactBoundaryKeys(
    doc,
    ['lookupKey', 'runtimeId', 'updatedAt', 'receipts', 'bundles'],
    [],
    'TOWER_STORED_LOOKUP_FIELDS_INVALID',
  );
  const lookupKey = text(doc['lookupKey'], 'TOWER_STORED_LOOKUP_KEY_INVALID').toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(lookupKey)) throw new Error('TOWER_STORED_LOOKUP_KEY_INVALID');
  if (expectedLookupKey && lookupKey !== expectedLookupKey) throw new Error('TOWER_STORED_LOOKUP_KEY_MISMATCH');
  const runtimeId = text(doc['runtimeId'], 'TOWER_STORED_RUNTIME_INVALID').toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(runtimeId)) throw new Error('TOWER_STORED_RUNTIME_INVALID');
  const updatedAt = safeInt(doc['updatedAt'], 'TOWER_STORED_UPDATED_AT_INVALID');
  if (!Array.isArray(doc['receipts'])) throw new Error('TOWER_STORED_RECEIPTS_INVALID');
  if (!Array.isArray(doc['bundles'])) throw new Error('TOWER_STORED_BUNDLES_INVALID');
  const receipts = doc['receipts'].map((entry) => decodeReceipt(entry, lookupKey, runtimeId));
  const bundles = doc['bundles'].map((value) => {
    const entry = record(value, 'TOWER_STORED_BUNDLE_ENTRY_INVALID');
    requireExactBoundaryKeys(
      entry,
      ['slot', 'towerMode', 'bundle', 'lastResortPayloadDigest'],
      ['lastResortPayload'],
      'TOWER_STORED_BUNDLE_ENTRY_FIELDS_INVALID',
    );
    const slot = safeInt(entry['slot'], 'TOWER_STORED_BUNDLE_SLOT_INVALID');
    const towerMode = normalizeTowerModeV1(entry['towerMode']);
    const bundle = decodeBundle(entry['bundle'], lookupKey, runtimeId);
    const lastResortPayloadDigest = text(
      entry['lastResortPayloadDigest'],
      'TOWER_STORED_LAST_RESORT_DIGEST_INVALID',
    );
    if (entry['lastResortPayload'] !== undefined) {
      record(entry['lastResortPayload'], 'TOWER_STORED_LAST_RESORT_PAYLOAD_INVALID');
    }
    return {
      slot,
      towerMode,
      bundle,
      lastResortPayloadDigest,
      ...(entry['lastResortPayload'] === undefined
        ? {}
        : { lastResortPayload: entry['lastResortPayload'] as TowerLastResortPayloadV1 }),
    };
  });
  return { lookupKey, runtimeId, updatedAt, receipts, bundles };
};

export const decodeStoredMetaStats = (raw: string): StoredTowerMetaStats => {
  const stats = record(deserializeTaggedJson(raw), 'TOWER_STORED_META_INVALID');
  requireExactBoundaryKeys(
    stats,
    ['actionReceiptCount'],
    [],
    'TOWER_STORED_META_FIELDS_INVALID',
  );
  return { actionReceiptCount: safeInt(stats['actionReceiptCount'], 'TOWER_STORED_META_COUNT_INVALID') };
};

export const decodeStoredActionReceipt = (raw: string): StoredTowerActionReceipt => {
  const receipt = record(deserializeTaggedJson(raw), 'TOWER_STORED_ACTION_INVALID');
  requireExactBoundaryKeys(
    receipt,
    [
      'id',
      'lookupKey',
      'runtimeId',
      'towerMode',
      'actionKind',
      'triggerHint',
      'appointmentSequence',
      'status',
      'createdAt',
    ],
    ['txHash', 'blockNumber', 'error'],
    'TOWER_STORED_ACTION_FIELDS_INVALID',
  );
  const towerMode = normalizeTowerModeV1(receipt['towerMode']);
  const status = receipt['status'];
  if (status !== 'submitted' && status !== 'skipped' && status !== 'error') {
    throw new Error('TOWER_STORED_ACTION_STATUS_INVALID');
  }
  if (receipt['actionKind'] !== 'counter_dispute_only') {
    throw new Error('TOWER_STORED_ACTION_KIND_INVALID');
  }
  for (const field of ['id', 'lookupKey', 'runtimeId', 'triggerHint'] as const) {
    text(receipt[field], `TOWER_STORED_ACTION_${field.toUpperCase()}_INVALID`);
  }
  safeInt(receipt['appointmentSequence'], 'TOWER_STORED_ACTION_SEQUENCE_INVALID');
  safeInt(receipt['createdAt'], 'TOWER_STORED_ACTION_CREATED_AT_INVALID');
  optionalSafeInt(receipt['blockNumber'], 'TOWER_STORED_ACTION_BLOCK_INVALID');
  const txHash = receipt['txHash'];
  const error = receipt['error'];
  if (txHash !== undefined) text(txHash, 'TOWER_STORED_ACTION_TX_HASH_INVALID');
  if (error !== undefined && typeof error !== 'string') {
    throw new Error('TOWER_STORED_ACTION_ERROR_INVALID');
  }
  return {
    id: String(receipt['id']),
    lookupKey: String(receipt['lookupKey']),
    runtimeId: String(receipt['runtimeId']),
    towerMode,
    actionKind: 'counter_dispute_only',
    triggerHint: String(receipt['triggerHint']),
    appointmentSequence: Number(receipt['appointmentSequence']),
    status,
    createdAt: Number(receipt['createdAt']),
    ...(txHash === undefined ? {} : { txHash: String(txHash) }),
    ...(receipt['blockNumber'] === undefined
      ? {}
      : { blockNumber: Number(receipt['blockNumber']) }),
    ...(error === undefined ? {} : { error }),
  };
};
