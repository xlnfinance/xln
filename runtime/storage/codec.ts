import { decodeBinaryPayload, encodeBinaryPayload, type XlnBinaryCodecName } from './binary-codec';

export const notFound = (error: unknown): boolean => {
  if (!error || typeof error !== 'object') return false;
  const code = String((error as { code?: unknown }).code ?? '');
  const name = String((error as { name?: unknown }).name ?? '');
  return code === 'LEVEL_NOT_FOUND' || name === 'NotFoundError';
};

const storageCodecName = (): XlnBinaryCodecName => {
  const raw = String(
    typeof process !== 'undefined'
      ? process.env['XLN_STORAGE_CODEC'] ?? ''
      : '',
  ).trim().toLowerCase();
  return raw === 'json' ? 'json' : 'msgpack';
};

export const encodeBuffer = (value: unknown): Buffer => {
  return Buffer.from(encodeBinaryPayload(value, storageCodecName()));
};

export const decodeBuffer = <T>(buffer: Buffer): T => {
  return decodeBinaryPayload<T>(buffer);
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
