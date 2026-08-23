import {
  decodeBinaryPayload,
  decodeValidatedBinaryPayload,
  encodeBinaryPayload,
  encodeBinaryPayloadWithCanonical,
  packPreorderedBinaryPayload,
} from '../../protocol/serialization/binary-codec';
import { countOp, countOpWithSite } from '../../support/performance/op-counters';

export const notFound = (error: unknown): boolean => {
  if (!error || typeof error !== 'object') return false;
  const code = String((error as { code?: unknown }).code ?? '');
  const name = String((error as { name?: unknown }).name ?? '');
  return code === 'LEVEL_NOT_FOUND' || name === 'NotFoundError';
};

export const encodeBuffer = (
  value: unknown,
  options: { omitSymbolKeys?: boolean } = {},
): Buffer => {
  const buffer = Buffer.from(encodeBinaryPayload(value, 'msgpack', options));
  countOpWithSite('storage.encode', buffer.byteLength, 1);
  return buffer;
};

/**
 * Row bytes that are only ever decoded back into objects (content-addressed
 * payload rows, the frame record, activity rows) skip the canonical walk:
 * the same code path emits the same key order, and every hash over these
 * rows is taken over the stored bytes themselves. Commitments that must
 * match across processes (frame hash, replica meta, heads) stay canonical.
 */
export const encodeBufferAsIs = (value: unknown): Buffer => {
  const buffer = Buffer.from(packPreorderedBinaryPayload(value));
  countOpWithSite('storage.encode', buffer.byteLength, 1);
  return buffer;
};

export const encodeBufferPrepared = (
  value: unknown,
  options: { omitSymbolKeys?: boolean } = {},
): { buffer: Buffer; canonical: unknown } => {
  const encoded = encodeBinaryPayloadWithCanonical(value, 'msgpack', options);
  const buffer = Buffer.from(encoded.bytes);
  countOpWithSite('storage.encodePrepared', buffer.byteLength, 1);
  return { buffer, canonical: encoded.canonical };
};

const requireStorageMsgpack = (buffer: Buffer): void => {
  if (buffer[0] !== 0x01) {
    throw new Error(`STORAGE_CODEC_MSGPACK_REQUIRED:magic=${buffer[0] ?? 'none'}`);
  }
};

export const decodeBuffer = (buffer: Buffer): unknown => {
  requireStorageMsgpack(buffer);
  return decodeBinaryPayload(buffer);
};

export const decodeValidatedBuffer = <T>(
  buffer: Buffer,
  validator: (value: unknown) => T,
): T => {
  requireStorageMsgpack(buffer);
  return decodeValidatedBinaryPayload(buffer, validator);
};

const storageSyncWritesEnabled = (): boolean => {
  const raw = String(typeof process !== 'undefined' ? process.env['XLN_STORAGE_SYNC_WRITES'] ?? '' : '').trim().toLowerCase();
  return raw !== '0' && raw !== 'false' && raw !== 'off';
};

export const writeBatch = async (
  batch: { write: (options?: { sync?: boolean }) => Promise<void> },
  options: { sync?: boolean } = {},
): Promise<void> => {
  const sync = options.sync ?? storageSyncWritesEnabled();
  const startedAt = performance.now();
  try {
    await batch.write(sync ? { sync: true } : undefined);
  } finally {
    countOp(
      `storage.batchWrite.${sync ? 'sync' : 'async'}`,
      0,
      Math.round((performance.now() - startedAt) * 1_000),
    );
  }
};
import { Buffer } from '../../support/platform-crypto';
