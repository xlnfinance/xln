import { Packr } from 'msgpackr';
import { deserializeTaggedJson, serializeTaggedJson } from '../serialization-utils';

type StorageCodecName = 'json' | 'msgpack';

const STORAGE_CODEC_MAGIC: Record<StorageCodecName, number> = {
  msgpack: 0x01,
  json: 0x02,
};

const STORAGE_CODEC_BY_MAGIC = new Map<number, StorageCodecName>(
  Object.entries(STORAGE_CODEC_MAGIC).map(([codec, magic]) => [magic, codec as StorageCodecName]),
);

const msgpackCodec = new Packr({
  mapsAsObjects: false,
  structuredClone: true,
});

export const notFound = (error: unknown): boolean => {
  if (!error || typeof error !== 'object') return false;
  const code = String((error as { code?: unknown }).code ?? '');
  const name = String((error as { name?: unknown }).name ?? '');
  return code === 'LEVEL_NOT_FOUND' || name === 'NotFoundError';
};

const storageCodecName = (): StorageCodecName => {
  const raw = String(
    typeof process !== 'undefined'
      ? process.env['XLN_STORAGE_CODEC'] ?? ''
      : '',
  ).trim().toLowerCase();
  return raw === 'json' ? 'json' : 'msgpack';
};

const encodeWithCodec = (codec: StorageCodecName, value: unknown): Buffer => {
  if (codec === 'json') return Buffer.from(serializeTaggedJson(value));
  return Buffer.from(msgpackCodec.pack(value));
};

const decodeWithCodec = <T>(codec: StorageCodecName, buffer: Buffer): T => {
  if (codec === 'json') return deserializeTaggedJson<T>(buffer.toString());
  return msgpackCodec.unpack(buffer) as T;
};

export const encodeBuffer = (value: unknown): Buffer => {
  const codec = storageCodecName();
  return Buffer.concat([Buffer.from([STORAGE_CODEC_MAGIC[codec]]), encodeWithCodec(codec, value)]);
};

export const decodeBuffer = <T>(buffer: Buffer): T => {
  const magic = buffer[0];
  const codec = magic === undefined ? undefined : STORAGE_CODEC_BY_MAGIC.get(magic);
  if (!codec) {
    throw new Error(`STORAGE_CODEC_MAGIC_MISSING: firstByte=${magic ?? 'none'}`);
  }
  return decodeWithCodec<T>(codec, buffer.subarray(1));
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
