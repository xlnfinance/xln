import { decodeBuffer, notFound, writeBatch } from './codec';
import { prefixUpperBound } from './keys';
import type { NamespaceBytes, RuntimeDbLike } from './types';

const STORAGE_BATCH_CHUNK_SIZE = 256;

export const storageKeyToBuffer = (rawKey: Buffer | Uint8Array | string): Buffer => {
  if (Buffer.isBuffer(rawKey)) return rawKey;
  if (rawKey instanceof Uint8Array) return Buffer.from(rawKey);
  return Buffer.from(String(rawKey));
};

export type KeyRangeOptions = {
  prefix?: Buffer;
  gte?: Buffer;
  lt?: Buffer;
  reverse?: boolean;
};

const keyIteratorOptions = (range: KeyRangeOptions): { gte?: Buffer; lt?: Buffer; reverse?: boolean } => {
  const reverse = range.reverse ? { reverse: true } : {};
  if (range.prefix) {
    const upperBound = prefixUpperBound(range.prefix);
    return upperBound ? { gte: range.prefix, lt: upperBound, ...reverse } : { gte: range.prefix, ...reverse };
  }
  return {
    ...(range.gte ? { gte: range.gte } : {}),
    ...(range.lt ? { lt: range.lt } : {}),
    ...reverse,
  };
};

export const readJsonOrNull = async <T>(db: RuntimeDbLike, key: Buffer): Promise<T | null> => {
  try {
    return decodeBuffer<T>(await db.get(key));
  } catch (error) {
    if (notFound(error)) return null;
    throw error;
  }
};

export const readRawOrNull = async (db: RuntimeDbLike, key: Buffer): Promise<Buffer | null> => {
  try {
    return await db.get(key);
  } catch (error) {
    if (notFound(error)) return null;
    throw error;
  }
};

export async function* iterateKeys(db: RuntimeDbLike, range: KeyRangeOptions): AsyncGenerator<Buffer> {
  if (typeof db.keys !== 'function') return;
  for await (const rawKey of db.keys(keyIteratorOptions(range))) {
    yield storageKeyToBuffer(rawKey);
  }
}

export const listKeys = async (db: RuntimeDbLike, prefix: Buffer): Promise<Buffer[]> => {
  const out: Buffer[] = [];
  for await (const key of iterateKeys(db, { prefix })) out.push(key);
  return out;
};

export const listKeysRange = async (db: RuntimeDbLike, gte: Buffer, lt: Buffer): Promise<Buffer[]> => {
  const out: Buffer[] = [];
  for await (const key of iterateKeys(db, { gte, lt })) out.push(key);
  return out;
};

export const countKeys = async (db: RuntimeDbLike, range: KeyRangeOptions): Promise<number> => {
  let count = 0;
  for await (const _key of iterateKeys(db, range)) count += 1;
  return count;
};

export const measurePrefixBytes = async (db: RuntimeDbLike, prefix: Buffer): Promise<NamespaceBytes> => {
  let bytes = 0;
  let maxValueBytes = 0;
  let count = 0;
  for await (const key of iterateKeys(db, { prefix })) {
    const value = await db.get(key);
    bytes += key.byteLength + value.byteLength;
    if (value.byteLength > maxValueBytes) maxValueBytes = value.byteLength;
    count += 1;
  }
  return { count, bytes, maxValueBytes };
};

export const copyKeys = async (
  sourceDb: RuntimeDbLike,
  targetDb: RuntimeDbLike,
  keys: Buffer[],
): Promise<{ bytes: number; count: number }> => {
  let bytes = 0;
  let count = 0;
  for (let offset = 0; offset < keys.length; offset += STORAGE_BATCH_CHUNK_SIZE) {
    const batch = targetDb.batch();
    for (const key of keys.slice(offset, offset + STORAGE_BATCH_CHUNK_SIZE)) {
      const value = await sourceDb.get(key);
      batch.put(key, value);
      bytes += key.byteLength + value.byteLength;
      count += 1;
    }
    await writeBatch(batch);
  }
  return { bytes, count };
};

export const copyKeyRange = async (
  sourceDb: RuntimeDbLike,
  targetDb: RuntimeDbLike,
  range: KeyRangeOptions,
  mapKey: (key: Buffer) => Buffer | null = (key) => key,
): Promise<{ bytes: number; count: number }> => {
  let bytes = 0;
  let count = 0;
  let batch = targetDb.batch();
  let batchCount = 0;

  const flush = async (): Promise<void> => {
    if (batchCount <= 0) return;
    await writeBatch(batch);
    batch = targetDb.batch();
    batchCount = 0;
  };

  for await (const key of iterateKeys(sourceDb, range)) {
    const targetKey = mapKey(key);
    if (!targetKey) continue;
    const value = await sourceDb.get(key);
    batch.put(targetKey, value);
    bytes += targetKey.byteLength + value.byteLength;
    count += 1;
    batchCount += 1;
    if (batchCount >= STORAGE_BATCH_CHUNK_SIZE) await flush();
  }
  await flush();
  return { bytes, count };
};

export const deleteKeys = async (db: RuntimeDbLike, keys: Buffer[]): Promise<number> => {
  let removedBytes = 0;
  for (let offset = 0; offset < keys.length; offset += STORAGE_BATCH_CHUNK_SIZE) {
    const batch = db.batch();
    for (const key of keys.slice(offset, offset + STORAGE_BATCH_CHUNK_SIZE)) {
      const value = await readRawOrNull(db, key);
      if (value) removedBytes += key.byteLength + value.byteLength;
      if (typeof batch.del === 'function') batch.del(key);
    }
    await writeBatch(batch);
  }
  return removedBytes;
};

export const deleteKeyRange = async (
  db: RuntimeDbLike,
  range: KeyRangeOptions,
  shouldDelete: (key: Buffer) => boolean | Promise<boolean> = () => true,
): Promise<{ removedBytes: number; removedKeys: number }> => {
  let removedBytes = 0;
  let removedKeys = 0;
  let batch = db.batch();
  let batchCount = 0;

  const flush = async (): Promise<void> => {
    if (batchCount <= 0) return;
    await writeBatch(batch);
    batch = db.batch();
    batchCount = 0;
  };

  for await (const key of iterateKeys(db, range)) {
    if (!(await shouldDelete(key))) continue;
    const value = await readRawOrNull(db, key);
    if (value) removedBytes += key.byteLength + value.byteLength;
    if (typeof batch.del === 'function') batch.del(key);
    removedKeys += 1;
    batchCount += 1;
    if (batchCount >= STORAGE_BATCH_CHUNK_SIZE) await flush();
  }
  await flush();
  return { removedBytes, removedKeys };
};
