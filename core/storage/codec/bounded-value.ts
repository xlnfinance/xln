/** Bounded physical rows for large authoritative WAL and history values. */

import { computeIntegrityDigest } from '../../support/integrity-checksum';
import type { RuntimeDbLike } from '../types';
import { keyBoundedValueChunk } from '../keys';
import {
  decodeBuffer,
  decodeValidatedBuffer,
  encodeBuffer,
  notFound,
  writeBatch,
} from './codec';

export const MAX_PHYSICAL_STORAGE_VALUE_BYTES = 10_000;
export const BOUNDED_STORAGE_DELETE_BATCH_SIZE = 256;
const BOUNDED_VALUE_CHUNK_PAYLOAD_BYTES = 9_000;

type BoundedValueManifest = Readonly<{
  kind: 'boundedValue';
  version: 1;
  byteLength: number;
  chunkCount: number;
  digest: string;
}>;

type BoundedValueChunk = Readonly<{
  kind: 'boundedValueChunk';
  version: 1;
  index: number;
  bytes: Uint8Array;
}>;

export type BoundedStorageRow = Readonly<{ key: Buffer; value: Buffer }>;

const exactKeys = (value: Record<string, unknown>, expected: readonly string[], code: string): void => {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (actual.length !== canonical.length || actual.some((key, index) => key !== canonical[index])) {
    throw new Error(`${code}_FIELDS:${actual.join(',')}`);
  }
};

const record = (value: unknown, code: string): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || value instanceof Map) {
    throw new Error(code);
  }
  return value as Record<string, unknown>;
};

const validateManifest = (value: unknown): BoundedValueManifest => {
  const manifest = record(value, 'STORAGE_BOUNDED_MANIFEST_REQUIRED');
  exactKeys(
    manifest,
    ['kind', 'version', 'byteLength', 'chunkCount', 'digest'],
    'STORAGE_BOUNDED_MANIFEST',
  );
  if (manifest['kind'] !== 'boundedValue' || manifest['version'] !== 1) {
    throw new Error('STORAGE_BOUNDED_MANIFEST_VERSION_INVALID');
  }
  const byteLength = Number(manifest['byteLength']);
  const chunkCount = Number(manifest['chunkCount']);
  if (!Number.isSafeInteger(byteLength) || byteLength < MAX_PHYSICAL_STORAGE_VALUE_BYTES) {
    throw new Error(`STORAGE_BOUNDED_MANIFEST_BYTE_LENGTH_INVALID:${String(manifest['byteLength'])}`);
  }
  const expectedChunks = Math.ceil(byteLength / BOUNDED_VALUE_CHUNK_PAYLOAD_BYTES);
  if (!Number.isSafeInteger(chunkCount) || chunkCount !== expectedChunks) {
    throw new Error(`STORAGE_BOUNDED_MANIFEST_CHUNK_COUNT_INVALID:${chunkCount}:${expectedChunks}`);
  }
  const digest = String(manifest['digest'] || '').toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(digest)) {
    throw new Error(`STORAGE_BOUNDED_MANIFEST_DIGEST_INVALID:${digest}`);
  }
  return { kind: 'boundedValue', version: 1, byteLength, chunkCount, digest };
};

const maybeManifest = (value: unknown): BoundedValueManifest | null => {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || value instanceof Map) return null;
  if ((value as Record<string, unknown>)['kind'] !== 'boundedValue') return null;
  return validateManifest(value);
};

const validateChunk = (
  value: unknown,
  expectedIndex: number,
  expectedBytes: number,
): BoundedValueChunk => {
  const chunk = record(value, 'STORAGE_BOUNDED_CHUNK_REQUIRED');
  exactKeys(chunk, ['kind', 'version', 'index', 'bytes'], 'STORAGE_BOUNDED_CHUNK');
  if (chunk['kind'] !== 'boundedValueChunk' || chunk['version'] !== 1) {
    throw new Error(`STORAGE_BOUNDED_CHUNK_VERSION_INVALID:${expectedIndex}`);
  }
  if (chunk['index'] !== expectedIndex) {
    throw new Error(`STORAGE_BOUNDED_CHUNK_INDEX_MISMATCH:${String(chunk['index'])}:${expectedIndex}`);
  }
  if (!(chunk['bytes'] instanceof Uint8Array) || chunk['bytes'].byteLength !== expectedBytes) {
    throw new Error(
      `STORAGE_BOUNDED_CHUNK_BYTES_INVALID:${expectedIndex}:` +
      `${chunk['bytes'] instanceof Uint8Array ? chunk['bytes'].byteLength : 'type'}:${expectedBytes}`,
    );
  }
  return {
    kind: 'boundedValueChunk',
    version: 1,
    index: expectedIndex,
    bytes: chunk['bytes'],
  };
};

const assertPhysicalBudget = (value: Buffer, label: string): void => {
  if (value.byteLength >= MAX_PHYSICAL_STORAGE_VALUE_BYTES) {
    throw new Error(
      `STORAGE_PHYSICAL_VALUE_TOO_LARGE:${label}:${value.byteLength}:` +
      `${MAX_PHYSICAL_STORAGE_VALUE_BYTES}`,
    );
  }
};

/**
 * Values below 10 KB stay as their canonical MessagePack bytes. Larger values
 * become one small manifest plus static owner+index continuation rows. This is
 * one size-based layout, not a compatibility reader or a content-addressed DAG.
 */
export const prepareBoundedStorageValueRows = (
  ownerKey: Buffer,
  encodedValue: Buffer,
): BoundedStorageRow[] => {
  if (encodedValue.byteLength < MAX_PHYSICAL_STORAGE_VALUE_BYTES) {
    return [{ key: ownerKey, value: encodedValue }];
  }
  const chunkCount = Math.ceil(encodedValue.byteLength / BOUNDED_VALUE_CHUNK_PAYLOAD_BYTES);
  const manifest: BoundedValueManifest = {
    kind: 'boundedValue',
    version: 1,
    byteLength: encodedValue.byteLength,
    chunkCount,
    digest: computeIntegrityDigest(encodedValue).toLowerCase(),
  };
  const ownerValue = encodeBuffer(manifest);
  assertPhysicalBudget(ownerValue, 'manifest');
  const rows: BoundedStorageRow[] = [{ key: ownerKey, value: ownerValue }];
  for (let index = 0; index < chunkCount; index += 1) {
    const start = index * BOUNDED_VALUE_CHUNK_PAYLOAD_BYTES;
    const value = encodeBuffer({
      kind: 'boundedValueChunk',
      version: 1,
      index,
      bytes: encodedValue.subarray(start, start + BOUNDED_VALUE_CHUNK_PAYLOAD_BYTES),
    } satisfies BoundedValueChunk);
    assertPhysicalBudget(value, `chunk:${index}`);
    rows.push({ key: keyBoundedValueChunk(ownerKey, index), value });
  }
  return rows;
};

export const boundedStorageRowsBytes = (rows: readonly BoundedStorageRow[]): number =>
  rows.reduce((total, row) => total + row.key.byteLength + row.value.byteLength, 0);

const readRawOrNull = async (db: RuntimeDbLike, key: Buffer): Promise<Buffer | null> => {
  try {
    return await db.get(key);
  } catch (error) {
    if (notFound(error)) return null;
    throw error;
  }
};

const readManifestValue = async (
  db: RuntimeDbLike,
  ownerKey: Buffer,
  manifest: BoundedValueManifest,
): Promise<Buffer> => {
  const chunks = await Promise.all(Array.from({ length: manifest.chunkCount }, async (_, index) => {
    const chunkRaw = await readRawOrNull(db, keyBoundedValueChunk(ownerKey, index));
    if (!chunkRaw) throw new Error(`STORAGE_BOUNDED_CHUNK_MISSING:${ownerKey.toString('hex')}:${index}`);
    const remaining = manifest.byteLength - index * BOUNDED_VALUE_CHUNK_PAYLOAD_BYTES;
    const expectedBytes = Math.min(BOUNDED_VALUE_CHUNK_PAYLOAD_BYTES, remaining);
    return Buffer.from(decodeValidatedBuffer(
      chunkRaw,
      value => validateChunk(value, index, expectedBytes),
    ).bytes);
  }));
  const encoded = Buffer.concat(chunks, manifest.byteLength);
  const digest = computeIntegrityDigest(encoded).toLowerCase();
  if (digest !== manifest.digest) {
    throw new Error(
      `STORAGE_BOUNDED_DIGEST_MISMATCH:${ownerKey.toString('hex')}:` +
      `${manifest.digest}:${digest}`,
    );
  }
  return encoded;
};

const readEncodedValue = async (
  db: RuntimeDbLike,
  ownerKey: Buffer,
): Promise<Buffer | null> => {
  const raw = await readRawOrNull(db, ownerKey);
  if (!raw) return null;
  const manifest = maybeManifest(decodeBuffer(raw));
  return manifest ? readManifestValue(db, ownerKey, manifest) : raw;
};

export const readBoundedEncodedValue = (
  db: RuntimeDbLike,
  ownerKey: Buffer,
): Promise<Buffer | null> => readEncodedValue(db, ownerKey);

export const readBoundedValidatedValue = async <T>(
  db: RuntimeDbLike,
  ownerKey: Buffer,
  validator: (value: unknown) => T,
): Promise<T | null> => {
  const raw = await readRawOrNull(db, ownerKey);
  if (!raw) return null;
  const decoded = decodeBuffer(raw);
  const manifest = maybeManifest(decoded);
  if (!manifest) return validator(decoded);
  return decodeValidatedBuffer(await readManifestValue(db, ownerKey, manifest), validator);
};

type BoundedStorageDeletePlan = Readonly<{
  keys: readonly Buffer[];
  removedBytes: number;
}>;

const prepareBoundedStorageDelete = async (
  db: RuntimeDbLike,
  ownerKey: Buffer,
): Promise<BoundedStorageDeletePlan | null> => {
  const ownerValue = await readRawOrNull(db, ownerKey);
  if (!ownerValue) return null;
  const manifest = maybeManifest(decodeBuffer(ownerValue));
  const chunkKeys = manifest
    ? Array.from({ length: manifest.chunkCount }, (_, index) => keyBoundedValueChunk(ownerKey, index))
    : [];
  const chunkValues = await Promise.all(chunkKeys.map(key => readRawOrNull(db, key)));
  const missingIndex = chunkValues.findIndex(value => value === null);
  if (missingIndex >= 0) {
    throw new Error(`STORAGE_BOUNDED_CHUNK_MISSING_ON_DELETE:${ownerKey.toString('hex')}:${missingIndex}`);
  }
  let removedBytes = ownerKey.byteLength + ownerValue.byteLength;
  for (const [index, key] of chunkKeys.entries()) {
    const value = chunkValues[index];
    if (!value) throw new Error(`STORAGE_BOUNDED_CHUNK_MISSING_ON_DELETE:${ownerKey.toString('hex')}:${index}`);
    removedBytes += key.byteLength + value.byteLength;
  }
  return { keys: [...chunkKeys, ownerKey], removedBytes };
};

/**
 * Delete logical values in bounded LevelDB batches. Every owner's manifest and
 * continuations share one batch, while range pruning never regresses to one
 * fsync per owner.
 */
export const deleteBoundedStorageValues = async (
  db: RuntimeDbLike,
  ownerKeys: readonly Buffer[],
  onCommitted?: () => void | Promise<void>,
): Promise<{ removedBytes: number; removedKeys: number }> => {
  let removedBytes = 0;
  let removedKeys = 0;
  for (let offset = 0; offset < ownerKeys.length; offset += BOUNDED_STORAGE_DELETE_BATCH_SIZE) {
    const plans = await Promise.all(
      ownerKeys
        .slice(offset, offset + BOUNDED_STORAGE_DELETE_BATCH_SIZE)
        .map(ownerKey => prepareBoundedStorageDelete(db, ownerKey)),
    );
    const presentPlans = plans.filter((plan): plan is BoundedStorageDeletePlan => plan !== null);
    if (presentPlans.length === 0) continue;
    const batch = db.batch();
    for (const plan of presentPlans) {
      for (const key of plan.keys) batch.del(key);
      removedBytes += plan.removedBytes;
      removedKeys += plan.keys.length;
    }
    await writeBatch(batch);
    await onCommitted?.();
  }
  return { removedBytes, removedKeys };
};

/** Delete one logical value and every continuation in one LevelDB batch. */
export const deleteBoundedStorageValue = (
  db: RuntimeDbLike,
  ownerKey: Buffer,
  onCommitted?: () => void | Promise<void>,
): Promise<{ removedBytes: number; removedKeys: number }> => {
  return deleteBoundedStorageValues(db, [ownerKey], onCommitted);
};
