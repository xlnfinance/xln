import { computeIntegrityChecksum, integrityChecksumFromHex } from '../infra/integrity-checksum';
import { KEY_CHUNK_VALUE } from './keys';

const MAX_PHYSICAL_VALUE_BYTES = 10 * 1024;
const CHUNK_PAYLOAD_BYTES = 4 * 1024;
const CHUNK_KEY_PREFIX = KEY_CHUNK_VALUE;
const MANIFEST_MAGIC = Buffer.from('xln-chunks\0', 'ascii');
const MANIFEST_BYTES = MANIFEST_MAGIC.byteLength + 4 + 4 + 16;

type RawBatch = {
  put(key: Buffer, value: Buffer): unknown;
  del?(key: Buffer): unknown;
  write(options?: { sync?: boolean }): Promise<void>;
};

type RawDb = {
  get(key: Buffer): Promise<Buffer>;
  put?(key: Buffer, value: Buffer, options?: { sync?: boolean }): Promise<void>;
  batch(): RawBatch;
  keys?(options?: { gte?: Buffer; lt?: Buffer; reverse?: boolean }): AsyncIterable<Buffer | Uint8Array | string>;
};

type ChunkManifest = {
  totalBytes: number;
  chunkCount: number;
  checksum: string;
};

const u32 = (value: number): Buffer => {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new Error(`STORAGE_CHUNK_U32_INVALID:${String(value)}`);
  }
  const output = Buffer.allocUnsafe(4);
  output.writeUInt32BE(value);
  return output;
};

const assertPhysicalValueSize = (value: Buffer, scope: string): void => {
  if (value.byteLength > MAX_PHYSICAL_VALUE_BYTES) {
    throw new Error(`STORAGE_VALUE_TOO_LARGE:${scope}:bytes=${value.byteLength}:max=${MAX_PHYSICAL_VALUE_BYTES}`);
  }
};

const encodeManifest = (value: Buffer, checksum: string, chunkCount: number): Buffer => {
  const manifest = Buffer.concat([
    MANIFEST_MAGIC,
    u32(value.byteLength),
    u32(chunkCount),
    Buffer.from(integrityChecksumFromHex(checksum)),
  ]);
  if (manifest.byteLength !== MANIFEST_BYTES) throw new Error('STORAGE_CHUNK_MANIFEST_SIZE_INVALID');
  return manifest;
};

const decodeManifest = (value: Buffer): ChunkManifest | null => {
  if (value.byteLength < MANIFEST_MAGIC.byteLength ||
      !value.subarray(0, MANIFEST_MAGIC.byteLength).equals(MANIFEST_MAGIC)) return null;
  if (value.byteLength !== MANIFEST_BYTES) {
    throw new Error(`STORAGE_CHUNK_MANIFEST_LENGTH_INVALID:${value.byteLength}`);
  }
  const totalBytes = value.readUInt32BE(MANIFEST_MAGIC.byteLength);
  const chunkCount = value.readUInt32BE(MANIFEST_MAGIC.byteLength + 4);
  if (totalBytes <= MAX_PHYSICAL_VALUE_BYTES || chunkCount < 2 ||
      chunkCount !== Math.ceil(totalBytes / CHUNK_PAYLOAD_BYTES)) {
    throw new Error(`STORAGE_CHUNK_MANIFEST_FIELDS_INVALID:bytes=${totalBytes}:chunks=${chunkCount}`);
  }
  const checksumOffset = MANIFEST_MAGIC.byteLength + 8;
  return {
    totalBytes,
    chunkCount,
    checksum: `0x${value.subarray(checksumOffset, checksumOffset + 16).toString('hex')}`,
  };
};

const chunkKey = (checksum: string, index: number): Buffer => Buffer.concat([
  Buffer.from([CHUNK_KEY_PREFIX]),
  Buffer.from(integrityChecksumFromHex(checksum)),
  u32(index),
]);

/**
 * Chunk addresses use the first 128 bits of SHA-256 only for local physical
 * deduplication and corruption detection. They are not a financial or
 * consensus commitment: logical values are decoded and checked again by the
 * authoritative 256-bit storage/frame/state hashes before recovery.
 */

const isChunkKey = (raw: Buffer | Uint8Array | string): boolean => {
  const key = Buffer.isBuffer(raw) ? raw : raw instanceof Uint8Array ? Buffer.from(raw) : Buffer.from(String(raw));
  return key[0] === CHUNK_KEY_PREFIX;
};

const appendPhysicalPut = (batch: RawBatch, key: Buffer, value: Buffer): void => {
  if (value.byteLength <= MAX_PHYSICAL_VALUE_BYTES) {
    assertPhysicalValueSize(value, 'direct');
    batch.put(key, value);
    return;
  }
  const checksum = computeIntegrityChecksum(value);
  const chunkCount = Math.ceil(value.byteLength / CHUNK_PAYLOAD_BYTES);
  for (let index = 0; index < chunkCount; index += 1) {
    const chunk = value.subarray(index * CHUNK_PAYLOAD_BYTES, (index + 1) * CHUNK_PAYLOAD_BYTES);
    assertPhysicalValueSize(chunk, 'chunk');
    batch.put(chunkKey(checksum, index), chunk);
  }
  const manifest = encodeManifest(value, checksum, chunkCount);
  assertPhysicalValueSize(manifest, 'manifest');
  batch.put(key, manifest);
};

const readLogicalValue = async (db: RawDb, key: Buffer): Promise<Buffer> => {
  const stored = await db.get(key);
  const manifest = decodeManifest(stored);
  if (!manifest) return stored;
  const chunks = await Promise.all(Array.from(
    { length: manifest.chunkCount },
    (_, index) => db.get(chunkKey(manifest.checksum, index)),
  ));
  for (const [index, chunk] of chunks.entries()) {
    const expected = index === chunks.length - 1
      ? manifest.totalBytes - index * CHUNK_PAYLOAD_BYTES
      : CHUNK_PAYLOAD_BYTES;
    if (chunk.byteLength !== expected) {
      throw new Error(`STORAGE_CHUNK_LENGTH_MISMATCH:index=${index}:actual=${chunk.byteLength}:expected=${expected}`);
    }
  }
  const value = Buffer.concat(chunks, manifest.totalBytes);
  const actualChecksum = computeIntegrityChecksum(value);
  if (actualChecksum !== manifest.checksum) {
    throw new Error(`STORAGE_CHUNK_CHECKSUM_MISMATCH:actual=${actualChecksum}:expected=${manifest.checksum}`);
  }
  return value;
};

const logicalKeys = (
  db: RawDb,
  options?: { gte?: Buffer; lt?: Buffer; reverse?: boolean },
): AsyncIterable<Buffer | Uint8Array | string> => ({
  async *[Symbol.asyncIterator]() {
    if (!db.keys) return;
    for await (const key of db.keys(options)) {
      if (!isChunkKey(key)) yield key;
    }
  },
});

const chunkedBatch = (db: RawDb): RawBatch => {
  const raw = db.batch();
  const wrapper: RawBatch = {
    put(key, value) {
      appendPhysicalPut(raw, key, value);
      return wrapper;
    },
    del(key) {
      raw.del?.(key);
      return wrapper;
    },
    write: (options) => raw.write(options),
  };
  return wrapper;
};

/**
 * Logical LevelDB values remain unchanged to callers. Physical values are
 * atomically split into content-addressed 4 KiB chunks plus a small manifest.
 * Epoch rotation copies only logical keys, naturally collecting orphan chunks.
 */
export const withChunkedValues = <T extends RawDb>(db: T): T => new Proxy(db, {
  get(target, property, receiver) {
    if (property === 'get') return (key: Buffer) => readLogicalValue(target, key);
    if (property === 'put') {
      return async (key: Buffer, value: Buffer, options?: { sync?: boolean }): Promise<void> => {
        const batch = chunkedBatch(target);
        batch.put(key, value);
        await batch.write(options);
      };
    }
    if (property === 'batch') return () => chunkedBatch(target);
    if (property === 'keys') return (options?: { gte?: Buffer; lt?: Buffer; reverse?: boolean }) => logicalKeys(target, options);
    const value = Reflect.get(target, property, receiver);
    return typeof value === 'function' ? value.bind(target) : value;
  },
});

export const STORAGE_MAX_PHYSICAL_VALUE_BYTES = MAX_PHYSICAL_VALUE_BYTES;
export const STORAGE_CHUNK_PAYLOAD_BYTES = CHUNK_PAYLOAD_BYTES;
