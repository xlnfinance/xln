import { decodeBuffer, notFound, writeBatch } from './codec';
import { prefixUpperBound } from './keys';
import type { NamespaceBytes, RuntimeDbLike } from './types';

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

export const listKeys = async (db: RuntimeDbLike, prefix: Buffer): Promise<Buffer[]> => {
  if (typeof db.keys !== 'function') return [];
  const out: Buffer[] = [];
  const upperBound = prefixUpperBound(prefix);
  for await (const rawKey of db.keys(upperBound ? { gte: prefix, lt: upperBound } : { gte: prefix })) {
    if (Buffer.isBuffer(rawKey)) out.push(rawKey);
    else if (rawKey instanceof Uint8Array) out.push(Buffer.from(rawKey));
    else out.push(Buffer.from(String(rawKey)));
  }
  return out;
};

export const listKeysRange = async (db: RuntimeDbLike, gte: Buffer, lt: Buffer): Promise<Buffer[]> => {
  if (typeof db.keys !== 'function') return [];
  const out: Buffer[] = [];
  for await (const rawKey of db.keys({ gte, lt })) {
    if (Buffer.isBuffer(rawKey)) out.push(rawKey);
    else if (rawKey instanceof Uint8Array) out.push(Buffer.from(rawKey));
    else out.push(Buffer.from(String(rawKey)));
  }
  return out;
};

export const measurePrefixBytes = async (db: RuntimeDbLike, prefix: Buffer): Promise<NamespaceBytes> => {
  const keys = await listKeys(db, prefix);
  let bytes = 0;
  let maxValueBytes = 0;
  for (const key of keys) {
    const value = await db.get(key);
    bytes += key.byteLength + value.byteLength;
    if (value.byteLength > maxValueBytes) maxValueBytes = value.byteLength;
  }
  return { count: keys.length, bytes, maxValueBytes };
};

export const copyKeys = async (
  sourceDb: RuntimeDbLike,
  targetDb: RuntimeDbLike,
  keys: Buffer[],
): Promise<{ bytes: number; count: number }> => {
  let bytes = 0;
  let count = 0;
  for (let offset = 0; offset < keys.length; offset += 256) {
    const batch = targetDb.batch();
    for (const key of keys.slice(offset, offset + 256)) {
      const value = await sourceDb.get(key);
      batch.put(key, value);
      bytes += key.byteLength + value.byteLength;
      count += 1;
    }
    await writeBatch(batch);
  }
  return { bytes, count };
};

export const deleteKeys = async (db: RuntimeDbLike, keys: Buffer[]): Promise<number> => {
  let removedBytes = 0;
  for (let offset = 0; offset < keys.length; offset += 256) {
    const batch = db.batch();
    for (const key of keys.slice(offset, offset + 256)) {
      const value = await readRawOrNull(db, key);
      if (value) removedBytes += key.byteLength + value.byteLength;
      if (typeof batch.del === 'function') batch.del(key);
    }
    await writeBatch(batch);
  }
  return removedBytes;
};
