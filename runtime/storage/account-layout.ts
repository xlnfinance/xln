import { computeIntegrityDigest } from '../infra/integrity-checksum';
import { compareStableText } from '../protocol/serialization';
import { LIMITS } from '../constants';
import { decodeBuffer, encodeBuffer } from './codec';
import { keyLiveAccountField } from './keys';
import { readRawOrNull } from './level';
import type { RuntimeDbLike, StorageAccountDoc } from './types';
import {
  STORAGE_ACCOUNT_FIELD_BY_TAG,
  STORAGE_ACCOUNT_FIELD_TAG,
  type StorageAccountField,
} from './account-field-tags';

export { STORAGE_ACCOUNT_FIELD_TAG } from './account-field-tags';

export const MAX_INLINE_STORAGE_VALUE_BYTES = LIMITS.MAX_STORAGE_VALUE_BYTES;

const ACCOUNT_FIELDS_MAGIC = Buffer.from([0x58, 0x4c, 0x4e, 0x41, 0x46, 0x01]);

type AccountFieldEntry = {
  field: StorageAccountField;
  tag: number;
  hash: string;
  value: Buffer;
};

export type AccountStorageLayout = {
  representation: 'inline' | 'fields';
  logicalValue: Buffer;
  logicalHash: string;
  rootValue: Buffer;
  puts: Array<{ key: Buffer; value: Buffer }>;
  dels: Buffer[];
};

type AccountFieldsManifest = {
  logicalBytes: number;
  logicalHash: string;
  fields: Array<{ field: StorageAccountField; tag: number; hash: string }>;
};

const FIELD_BY_TAG = STORAGE_ACCOUNT_FIELD_BY_TAG;

const u16 = (value: number): Buffer => {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff) {
    throw new Error(`STORAGE_ACCOUNT_FIELDS_U16_INVALID:${String(value)}`);
  }
  const output = Buffer.allocUnsafe(2);
  output.writeUInt16BE(value);
  return output;
};

const u32 = (value: number): Buffer => {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new Error(`STORAGE_ACCOUNT_FIELDS_U32_INVALID:${String(value)}`);
  }
  const output = Buffer.allocUnsafe(4);
  output.writeUInt32BE(value);
  return output;
};

const encodeManifest = (
  logicalValue: Buffer,
  logicalHash: string,
  fields: readonly AccountFieldEntry[],
): Buffer => {
  const encoded = Buffer.concat([
    ACCOUNT_FIELDS_MAGIC,
    u32(logicalValue.byteLength),
    Buffer.from(logicalHash.slice(2), 'hex'),
    u16(fields.length),
    ...fields.map((entry) => Buffer.concat([
      Buffer.from([entry.tag]),
      Buffer.from(entry.hash.slice(2), 'hex'),
    ])),
  ]);
  if (encoded.byteLength >= MAX_INLINE_STORAGE_VALUE_BYTES) {
    throw new Error(`STORAGE_ACCOUNT_FIELDS_MANIFEST_TOO_LARGE:${encoded.byteLength}`);
  }
  return encoded;
};

export const decodeAccountFieldsManifest = (value: Buffer): AccountFieldsManifest | null => {
  if (value.byteLength < ACCOUNT_FIELDS_MAGIC.byteLength ||
      !value.subarray(0, ACCOUNT_FIELDS_MAGIC.byteLength).equals(ACCOUNT_FIELDS_MAGIC)) return null;
  const fixedOffset = ACCOUNT_FIELDS_MAGIC.byteLength;
  if (value.byteLength < fixedOffset + 4 + 32 + 2) {
    throw new Error(`STORAGE_ACCOUNT_FIELDS_MANIFEST_TRUNCATED:${value.byteLength}`);
  }
  const logicalBytes = value.readUInt32BE(fixedOffset);
  const logicalHash = `0x${value.subarray(fixedOffset + 4, fixedOffset + 36).toString('hex')}`;
  const fieldCount = value.readUInt16BE(fixedOffset + 36);
  const expectedBytes = fixedOffset + 38 + fieldCount * 33;
  if (fieldCount < 1 || value.byteLength !== expectedBytes) {
    throw new Error(
      `STORAGE_ACCOUNT_FIELDS_MANIFEST_INVALID:bytes=${value.byteLength}:fields=${fieldCount}:expected=${expectedBytes}`,
    );
  }
  const fields: AccountFieldsManifest['fields'] = [];
  const seen = new Set<number>();
  let offset = fixedOffset + 38;
  for (let index = 0; index < fieldCount; index += 1) {
    const tag = value[offset]!;
    const field = FIELD_BY_TAG.get(tag);
    if (!field || seen.has(tag)) throw new Error(`STORAGE_ACCOUNT_FIELD_TAG_UNKNOWN_OR_DUPLICATE:${tag}`);
    seen.add(tag);
    fields.push({ field, tag, hash: `0x${value.subarray(offset + 1, offset + 33).toString('hex')}` });
    offset += 33;
  }
  return { logicalBytes, logicalHash, fields };
};

const encodeFields = (doc: StorageAccountDoc): AccountFieldEntry[] => {
  for (const field of Object.getOwnPropertyNames(doc)) {
    if (!(field in STORAGE_ACCOUNT_FIELD_TAG)) throw new Error(`STORAGE_ACCOUNT_FIELD_UNKNOWN:${field}`);
  }
  return (Object.entries(STORAGE_ACCOUNT_FIELD_TAG) as Array<[StorageAccountField, number]>)
    .filter(([field]) => Object.prototype.hasOwnProperty.call(doc, field))
    .map(([field, tag]) => {
      const value = encodeBuffer(doc[field]);
      return { field, tag, value, hash: computeIntegrityDigest(value) };
    })
    .sort((left, right) => left.tag - right.tag);
};

const accountFieldKey = (
  entityId: string,
  counterpartyId: string,
  tag: number,
): Buffer => keyLiveAccountField(entityId, counterpartyId, tag);

export const prepareAccountStorageLayout = async (
  db: RuntimeDbLike,
  entityId: string,
  counterpartyId: string,
  rootKey: Buffer,
  doc: StorageAccountDoc,
): Promise<AccountStorageLayout> => {
  const logicalValue = encodeBuffer(doc);
  const logicalHash = computeIntegrityDigest(logicalValue);
  const previousRoot = await readRawOrNull(db, rootKey);
  const previousManifest = previousRoot ? decodeAccountFieldsManifest(previousRoot) : null;
  const manifestCollision = logicalValue.subarray(0, ACCOUNT_FIELDS_MAGIC.byteLength).equals(ACCOUNT_FIELDS_MAGIC);
  if (logicalValue.byteLength < MAX_INLINE_STORAGE_VALUE_BYTES && !manifestCollision) {
    return {
      representation: 'inline',
      logicalValue,
      logicalHash,
      rootValue: logicalValue,
      puts: [{ key: rootKey, value: logicalValue }],
      dels: previousManifest?.fields.map((entry) => accountFieldKey(entityId, counterpartyId, entry.tag)) ?? [],
    };
  }

  const fields = encodeFields(doc);
  const previousHashes = new Map(previousManifest?.fields.map((entry) => [entry.tag, entry.hash]) ?? []);
  const nextTags = new Set(fields.map((entry) => entry.tag));
  const rootValue = encodeManifest(logicalValue, logicalHash, fields);
  const changedFields = fields.filter((entry) => previousHashes.get(entry.tag) !== entry.hash);
  return {
    representation: 'fields',
    logicalValue,
    logicalHash,
    rootValue,
    puts: [
      { key: rootKey, value: rootValue },
      ...changedFields.map((entry) => ({
        key: accountFieldKey(entityId, counterpartyId, entry.tag),
        value: entry.value,
      })),
    ],
    dels: (previousManifest?.fields ?? [])
      .filter((entry) => !nextTags.has(entry.tag))
      .map((entry) => accountFieldKey(entityId, counterpartyId, entry.tag)),
  };
};

export const prepareAccountStorageDelete = async (
  db: RuntimeDbLike,
  entityId: string,
  counterpartyId: string,
  rootKey: Buffer,
): Promise<Buffer[]> => {
  const root = await readRawOrNull(db, rootKey);
  const manifest = root ? decodeAccountFieldsManifest(root) : null;
  return [
    rootKey,
    ...(manifest?.fields.map((entry) => accountFieldKey(entityId, counterpartyId, entry.tag)) ?? []),
  ];
};

export const readAccountStorageLayout = async (
  db: RuntimeDbLike,
  entityId: string,
  counterpartyId: string,
  rootKey: Buffer,
): Promise<{ doc: StorageAccountDoc; logicalValue: Buffer; representation: 'inline' | 'fields' } | null> => {
  const root = await readRawOrNull(db, rootKey);
  if (!root) return null;
  const manifest = decodeAccountFieldsManifest(root);
  if (!manifest) {
    return { doc: decodeBuffer<StorageAccountDoc>(root), logicalValue: root, representation: 'inline' };
  }
  const doc: Partial<Record<StorageAccountField, unknown>> = {};
  for (const entry of manifest.fields) {
    const value = await db.get(accountFieldKey(entityId, counterpartyId, entry.tag));
    const actualHash = computeIntegrityDigest(value);
    if (actualHash !== entry.hash) {
      throw new Error(
        `STORAGE_ACCOUNT_FIELD_HASH_MISMATCH:field=${entry.field}:actual=${actualHash}:expected=${entry.hash}`,
      );
    }
    doc[entry.field] = decodeBuffer<unknown>(value);
  }
  const logicalValue = encodeBuffer(doc);
  if (logicalValue.byteLength !== manifest.logicalBytes) {
    throw new Error(
      `STORAGE_ACCOUNT_LOGICAL_LENGTH_MISMATCH:actual=${logicalValue.byteLength}:expected=${manifest.logicalBytes}`,
    );
  }
  const logicalHash = computeIntegrityDigest(logicalValue);
  if (logicalHash !== manifest.logicalHash) {
    throw new Error(`STORAGE_ACCOUNT_LOGICAL_HASH_MISMATCH:actual=${logicalHash}:expected=${manifest.logicalHash}`);
  }
  return { doc: doc as StorageAccountDoc, logicalValue, representation: 'fields' };
};

export const inspectAccountStorageFields = (doc: StorageAccountDoc): Array<{
  field: StorageAccountField;
  tag: number;
  bytes: number;
  hash: string;
}> => encodeFields(doc).map(({ field, tag, value, hash }) => ({ field, tag, bytes: value.byteLength, hash }))
  .sort((left, right) => compareStableText(left.field, right.field));
