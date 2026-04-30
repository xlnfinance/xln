import { Packr } from 'msgpackr';
import { deserializeTaggedJson, serializeTaggedJson } from '../serialization-utils';

export type XlnBinaryCodecName = 'json' | 'msgpack';

const XLN_BINARY_CODEC_MAGIC: Record<XlnBinaryCodecName, number> = {
  msgpack: 0x01,
  json: 0x02,
};

const XLN_BINARY_CODEC_BY_MAGIC = new Map<number, XlnBinaryCodecName>(
  Object.entries(XLN_BINARY_CODEC_MAGIC).map(([codec, magic]) => [magic, codec as XlnBinaryCodecName]),
);

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const msgpackCodec = new Packr({
  mapsAsObjects: false,
  structuredClone: true,
});

const asBytes = (value: Uint8Array | ArrayBuffer): Uint8Array =>
  value instanceof Uint8Array ? value : new Uint8Array(value);

export const encodeBinaryPayload = (
  value: unknown,
  codec: XlnBinaryCodecName = 'msgpack',
): Uint8Array => {
  const body = codec === 'json'
    ? textEncoder.encode(serializeTaggedJson(value))
    : asBytes(msgpackCodec.pack(value));
  const encoded = new Uint8Array(1 + body.byteLength);
  encoded[0] = XLN_BINARY_CODEC_MAGIC[codec];
  encoded.set(body, 1);
  return encoded;
};

export const decodeBinaryPayload = <T>(
  bytes: Uint8Array,
): T => {
  const magic = bytes[0];
  const codec = magic === undefined ? undefined : XLN_BINARY_CODEC_BY_MAGIC.get(magic);
  if (!codec) {
    throw new Error(`XLN_BINARY_CODEC_MAGIC_MISSING: firstByte=${magic ?? 'none'}`);
  }
  const body = bytes.subarray(1);
  if (codec === 'json') return deserializeTaggedJson<T>(textDecoder.decode(body));
  return msgpackCodec.unpack(body) as T;
};

