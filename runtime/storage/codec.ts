import {
  decodeBinaryPayload,
  decodeValidatedBinaryPayload,
  encodeBinaryPayload,
} from './binary-codec';

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
  return Buffer.from(encodeBinaryPayload(value, 'msgpack', options));
};

const requireStorageMsgpack = (buffer: Buffer): void => {
  if (buffer[0] !== 0x01) {
    throw new Error(`STORAGE_CODEC_MSGPACK_REQUIRED:magic=${buffer[0] ?? 'none'}`);
  }
};

export const decodeBuffer = <T>(buffer: Buffer): T => {
  requireStorageMsgpack(buffer);
  return decodeBinaryPayload<T>(buffer);
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
  await batch.write(sync ? { sync: true } : undefined);
};
